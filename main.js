const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');

const platform = require('./src/platform');
const dependencies = require('./src/dependencies');

// Software rendering stays the default on purpose: it keeps the app alive on
// machines whose GPU/driver makes Electron's renderer crash (the renderer is
// already recovered defensively below). The dashboard is smooth regardless —
// the real cause of the old lag was the stylesheet, which has since dropped the
// CPU-expensive `backdrop-filter` blurs and the never-ending box-shadow pulses
// that were pinning the window at ~10 FPS. Set LAMP_ENABLE_GPU=1 to opt into
// hardware acceleration (lower CPU use on large / high-DPI screens).
if (!process.env.LAMP_ENABLE_GPU) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}
app.commandLine.appendSwitch('no-sandbox');

// A main-process error must not silently kill the app: record it and stay up.
process.on('uncaughtException', (error) => {
  logLine(`uncaughtException: ${error && error.stack ? error.stack : error}`);
});
process.on('unhandledRejection', (reason) => {
  logLine(`unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
});

const PHP_HOST = '0.0.0.0';
const PHP_PORT = 8000;
const PHPMYADMIN_HOST = '127.0.0.1';
const PHPMYADMIN_PORT = 8081;

const DEFAULT_SCRIPTS_FOLDER = path.join(os.homedir(), 'php-scripts');

let phpServer = null;
let phpMyAdminServer = null;
let mainWindow = null;
let phpBinaryCache = null;
let rendererGoneUnexpectedly = false;
let reopeningWindow = false;

// ─── Config helpers ──────────────────────────────────────────────────────────

function getConfigDir() {
  let base = null;
  try {
    base = app.getPath('appData');
  } catch {
    base = process.env.APPDATA || path.join(os.homedir(), '.config');
  }
  return path.join(base, 'lamp-control-panel');
}

/**
 * Append a line to the app log. Failures here must never take the app down,
 * so everything is best-effort.
 */
function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.appendFileSync(path.join(getConfigDir(), 'main.log'), line);
  } catch {
    /* ignore logging failures */
  }
  if (process.env.LAMP_DEBUG) process.stderr.write(line);
}

/**
 * Wrap ipcMain.handle so a throwing handler is logged and reported back as a
 * structured failure instead of rejecting in the renderer.
 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      const detail = error && error.stack ? error.stack : String(error);
      logLine(`IPC handler "${channel}" failed: ${detail}`);
      return { ok: false, error: (error && error.message) || String(error), channel };
    }
  });
}

function ensureConfigDir() {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getSettingsPath() {
  return path.join(getConfigDir(), 'settings.json');
}

function getRecentProjectsPath() {
  return path.join(getConfigDir(), 'recent-projects.json');
}

const DEFAULT_SETTINGS = () => ({ lastPhpPath: DEFAULT_SCRIPTS_FOLDER });

function readSettings() {
  try {
    ensureConfigDir();
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) return DEFAULT_SETTINGS();
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : DEFAULT_SETTINGS();
  } catch {
    return DEFAULT_SETTINGS();
  }
}

function writeSettings(settings) {
  ensureConfigDir();
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
}

function readRecentProjects() {
  try {
    ensureConfigDir();
    const filePath = getRecentProjectsPath();
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRecentProjects(projects) {
  ensureConfigDir();
  fs.writeFileSync(getRecentProjectsPath(), JSON.stringify(projects.slice(0, 8), null, 2));
}

function addRecentProject(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) return readRecentProjects();

  const normalized = path.resolve(projectPath);
  const list = readRecentProjects().filter((item) => {
    if (!item) return false;
    const itemPath = typeof item === 'string' ? item : item.path;
    return itemPath !== normalized;
  });
  list.unshift({ path: normalized, openedAt: new Date().toISOString() });
  writeRecentProjects(list);
  return list;
}

// ─── Default scripts folder ─────────────────────────────────────────────────

function ensureDefaultScriptsFolder() {
  if (!fs.existsSync(DEFAULT_SCRIPTS_FOLDER)) {
    fs.mkdirSync(DEFAULT_SCRIPTS_FOLDER, { recursive: true });
  }
}

// ─── System state ────────────────────────────────────────────────────────────

function getNetworkIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

async function getSystemState() {
  const [httpd, mariadb, phpBinary] = await Promise.all([
    platform.getServiceState('httpd'),
    platform.getServiceState('mariadb'),
    resolvePhpBinary()
  ]);

  const ip = getNetworkIp();
  const phpRunning = Boolean(phpServer && !phpServer.killed && phpServer.exitCode === null);

  return {
    platform: platform.PLATFORM,
    platformLabel: platform.IS_WINDOWS ? 'Windows' : platform.IS_MAC ? 'macOS' : 'Linux',
    httpd,
    mariadb,
    php: phpBinary ? (phpRunning ? 'running' : 'stopped') : 'not-installed',
    phpInstalled: Boolean(phpBinary),
    phpUrl: `http://localhost:${PHP_PORT}`,
    networkUrl: `http://${ip}:${PHP_PORT}`,
    networkIp: ip,
    httpdService: await platform.describeService('httpd'),
    mariadbService: await platform.describeService('mariadb')
  };
}

// ─── Service actions ─────────────────────────────────────────────────────────

/**
 * Start/stop/restart one or more components. Commands are built from a fixed
 * service-name allow-list, then either executed directly (already privileged)
 * or batched into one elevated script.
 */
async function serviceAction(kinds, action) {
  const lines = [];
  for (const kind of kinds) {
    const line = await platform.serviceControlLine(kind, action);
    if (line) lines.push(line);
  }

  if (!lines.length) {
    return {
      ok: false,
      error:
        'No matching system service was found. On Linux the service may be named apache2/httpd and mariadb/mysql; ' +
        'on Windows it must be registered (for example "Apache2.4" or "MariaDB").'
    };
  }

  if (platform.isElevated()) {
    const results = await Promise.all(lines.map((line) => platform.runSystemCommand(line)));
    const failed = results.filter((result) => !result.ok);
    return {
      ok: failed.length === 0,
      error: failed.length ? failed[0].stderr || 'The command failed' : undefined
    };
  }

  const outcome = await platform.runElevated(lines, {
    scriptDir: ensureConfigDir(),
    name: `service-${action}`
  });

  if (outcome.canceled) {
    return { ok: false, canceled: true, error: 'You dismissed the permission prompt.' };
  }
  if (!outcome.ok) {
    return {
      ok: false,
      error: outcome.stderr || 'The action needs administrator rights.',
      manualCommand: platform.manualElevationHint(outcome.scriptPath)
    };
  }
  return { ok: true };
}

// ─── PHP server ──────────────────────────────────────────────────────────────

/** Locate the PHP executable, preferring one the dependency checker found. */
async function resolvePhpBinary() {
  if (phpBinaryCache && fs.existsSync(phpBinaryCache)) return phpBinaryCache;

  const detection = await dependencies.detectDependency('php');
  if (detection.installed && detection.location && fs.existsSync(detection.location)) {
    phpBinaryCache = detection.location;
    return phpBinaryCache;
  }

  const onPath = await platform.findExecutable('php');
  phpBinaryCache = onPath || null;
  return phpBinaryCache;
}

function resolveFolder(folder) {
  if (!folder) return null;
  let value = String(folder).trim();
  if (!value) return null;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

/** Stop any PHP process that is already serving our port (not just our own). */
async function releasePhpPort() {
  try {
    const pids = await platform.getListeningPids(PHP_PORT);
    const phpPids = [];
    for (const pid of pids) {
      const command = await platform.getProcessCommandLine(pid);
      if (command && /php/i.test(command)) phpPids.push(pid);
    }
    if (phpPids.length) await platform.killPids(phpPids);
  } catch {
    /* best effort */
  }
}

async function startPhpServer(folderArg) {
  const folder = resolveFolder(folderArg);
  if (!folder || !fs.existsSync(folder)) {
    return { ok: false, error: 'That folder does not exist.' };
  }
  if (!fs.statSync(folder).isDirectory()) {
    return { ok: false, error: 'Please choose a folder, not a file.' };
  }

  const phpBinary = await resolvePhpBinary();
  if (!phpBinary) {
    return {
      ok: false,
      error: 'PHP is not installed. Open "Stack Setup" to install the missing components.',
      needsPhp: true
    };
  }

  if (phpServer && phpServer.exitCode === null) {
    return {
      ok: true,
      alreadyRunning: true,
      url: `http://localhost:${PHP_PORT}`,
      networkUrl: `http://${getNetworkIp()}:${PHP_PORT}`
    };
  }

  await releasePhpPort();

  try {
    phpServer = spawn(phpBinary, ['-S', `${PHP_HOST}:${PHP_PORT}`, '-t', folder], {
      cwd: folder,
      detached: false,
      stdio: 'ignore',
      windowsHide: true
    });

    phpServer.on('error', () => {
      phpServer = null;
    });
    phpServer.on('exit', () => {
      phpServer = null;
    });

    const settings = readSettings();
    settings.lastPhpPath = folder;
    writeSettings(settings);
    addRecentProject(folder);

    return {
      ok: true,
      started: true,
      url: `http://localhost:${PHP_PORT}`,
      networkUrl: `http://${getNetworkIp()}:${PHP_PORT}`,
      folder
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function stopPhpServer() {
  if (phpServer && phpServer.exitCode === null) {
    try {
      phpServer.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  phpServer = null;
  return { ok: true, stopped: true };
}

// ─── phpMyAdmin ──────────────────────────────────────────────────────────────

/**
 * Decide how to reach phpMyAdmin:
 *   1. a packaged/system install served by Apache while Apache is running,
 *   2. otherwise a copy this app downloaded, served by PHP's built-in server.
 */
async function getPhpMyAdminTarget() {
  const detection = await dependencies.detectDependency('phpmyadmin');

  if (detection.installed && detection.source === 'system') {
    const httpdState = await platform.getServiceState('httpd');
    if (httpdState === 'active') {
      return { mode: 'apache', url: `http://localhost/phpMyAdmin`, path: detection.location, version: detection.version };
    }
  }

  if (detection.installed && detection.location) {
    const url = await startPhpMyAdminServer(detection.location);
    if (url) {
      return { mode: 'php-server', url, path: detection.location, version: detection.version };
    }
  }

  return { mode: 'missing', url: null, path: detection.location || null, version: detection.version || null };
}

async function startPhpMyAdminServer(directory) {
  const phpBinary = await resolvePhpBinary();
  if (!phpBinary || !directory || !fs.existsSync(directory)) return null;

  if (phpMyAdminServer && phpMyAdminServer.exitCode === null) {
    return `http://${PHPMYADMIN_HOST}:${PHPMYADMIN_PORT}`;
  }

  try {
    phpMyAdminServer = spawn(phpBinary, ['-S', `${PHPMYADMIN_HOST}:${PHPMYADMIN_PORT}`, '-t', directory], {
      cwd: directory,
      detached: false,
      stdio: 'ignore',
      windowsHide: true
    });
    phpMyAdminServer.on('error', () => {
      phpMyAdminServer = null;
    });
    phpMyAdminServer.on('exit', () => {
      phpMyAdminServer = null;
    });

    // Give the built-in server a moment to bind the port.
    await new Promise((resolve) => setTimeout(resolve, 600));
    return `http://${PHPMYADMIN_HOST}:${PHPMYADMIN_PORT}`;
  } catch {
    return null;
  }
}

function stopPhpMyAdminServer() {
  if (phpMyAdminServer && phpMyAdminServer.exitCode === null) {
    try {
      phpMyAdminServer.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  phpMyAdminServer = null;
}

async function openPhpMyAdmin() {
  const target = await getPhpMyAdminTarget();
  if (!target.url) {
    return { ok: false, needsInstall: true, error: 'phpMyAdmin is not installed yet.' };
  }
  await shell.openExternal(target.url);
  return { ok: true, ...target };
}

// ─── Network scan ────────────────────────────────────────────────────────────

async function getNetworkDevices() {
  try {
    const subnet = await platform.getLocalSubnet();
    const checks = [];
    for (let i = 1; i <= 30; i += 1) {
      const ip = `${subnet}.${i}`;
      checks.push(
        platform.pingHost(ip).then((alive) => (alive ? { ip, name: ip } : null))
      );
    }
    const results = (await Promise.all(checks)).filter(Boolean);
    return results.slice(0, 20);
  } catch {
    return [];
  }
}

// ─── Resource usage ──────────────────────────────────────────────────────────

function getResourceUsage() {
  return platform.getProcessUsage(['php', 'httpd', 'apache2', 'apache', 'mariadbd', 'mysqld', 'mariadb']);
}

// ─── Dependency stack ────────────────────────────────────────────────────────

async function getStackStatus(options) {
  return dependencies.getStatus({ force: Boolean(options && options.force) });
}

/**
 * Ask the user whether the generated privileged script may run. One dialog per
 * install, and the UI shows exactly what will be executed.
 */
async function requestInstallConsent(request) {
  const lines = request.items.map((item) => `• ${item.name} — ${item.detail}`);
  const preview = (request.preview || [])
    .filter((line) => line && !line.startsWith('#!') && !line.startsWith('set ') && !line.includes('tee -a') && !line.startsWith('Start-Transcript') && !line.startsWith('Stop-Transcript') && !line.startsWith('$ErrorAction'))
    .slice(0, 14)
    .join('\n');

  const elevationLine = request.elevation && request.elevation.available
    ? `Your system will ask for permission once (${request.elevation.label}).`
    : `No graphical privilege prompt was found. Run this yourself:\n${request.manualCommand}`;

  const options = {
    type: 'warning',
    title: 'Administrator approval required',
    message: 'Installing components needs administrator rights',
    detail: `${lines.join('\n')}\n\n${elevationLine}\n\nScript:\n${request.scriptPath}\n\n${preview}`,
    buttons: request.elevation && request.elevation.available ? ['Allow', 'Cancel'] : ['Copy command', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  };

  // Parent the dialog to the window only while it still exists; passing a
  // destroyed window throws and would abort the whole install.
  const { response } =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);

  if (response === 0) {
    if (!request.elevation || !request.elevation.available) {
      const { clipboard } = require('electron');
      clipboard.writeText(request.manualCommand);
      return false;
    }
    return true;
  }
  return false;
}

async function installDependencies(ids, options = {}) {
  const upgrade = Boolean(options && options.upgrade);
  let targets = Array.isArray(ids) ? ids : [];

  if (!targets.length) {
    const status = await dependencies.getStatus();
    targets = status.components
      .filter((component) => !component.installed || (upgrade && component.outdated))
      .map((component) => component.id);
  }

  if (!targets.length) {
    return {
      ok: true,
      installed: [],
      skipped: [],
      failed: [],
      verified: [],
      message: 'Nothing to do — everything is already up to date.'
    };
  }

  return dependencies.install(targets, {
    upgrade,
    onProgress: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stack-progress', event);
      }
    },
    onConsent: (request) => requestInstallConsent(request)
  });
}

// ─── Window ──────────────────────────────────────────────────────────────────

function getMainWindow() {
  if (mainWindow) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 1000,
    minHeight: 720,
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    logLine('Main window closed');
    mainWindow = null;
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logLine(`Renderer process gone: ${JSON.stringify(details)}`);
    // A renderer that dies (rather than exiting cleanly) takes the window with
    // it, and "window-all-closed" then quits the app. Remember it so we can
    // reopen the window instead of the app appearing to close by itself.
    if (details && details.reason && details.reason !== 'clean-exit') {
      rendererGoneUnexpectedly = true;
    }
  });

  return mainWindow;
}

app.on('render-process-gone', (_event, _contents, details) => {
  logLine(`render-process-gone: ${JSON.stringify(details)}`);
});
app.on('child-process-gone', (_event, details) => {
  logLine(`child-process-gone: ${JSON.stringify(details)}`);
});

// ─── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  try {
    ensureDefaultScriptsFolder();
    dependencies.configure({ dataDir: ensureConfigDir(), log: (message) => logLine(`[deps] ${message}`) });
    getMainWindow();
  } catch (error) {
    logLine(`Startup failed: ${error && error.stack ? error.stack : error}`);
  }

  // System status
  handle('get-system-status', async () => getSystemState());

  // Bulk service actions (Apache + MariaDB)
  handle('service-action', async (_, action) => serviceAction(['httpd', 'mariadb'], action));

  // Individual service actions
  handle('service-action-single', async (_, service, action) => {
    if (!['httpd', 'mariadb'].includes(service)) {
      return { ok: false, error: `Unknown service: ${service}` };
    }
    return serviceAction([service], action);
  });

  // Settings
  handle('get-settings', async () => readSettings());
  handle('save-settings', async (_, settings) => {
    writeSettings(settings && typeof settings === 'object' ? settings : DEFAULT_SETTINGS());
    return true;
  });

  // Default scripts folder
  handle('get-default-scripts-folder', async () => DEFAULT_SCRIPTS_FOLDER);

  // PHP server
  handle('choose-folder', async () => chooseFolder());
  handle('start-php-server', async (_, folder) => startPhpServer(folder));
  handle('stop-php-server', async () => stopPhpServer());

  // phpMyAdmin
  handle('open-phpmyadmin', async () => openPhpMyAdmin());
  handle('get-phpmyadmin-target', async () => getPhpMyAdminTarget());

  // Dependency stack
  handle('get-stack-status', async (_, options) => getStackStatus(options));
  handle('install-dependencies', async (_, ids, options) => installDependencies(ids, options));

  // Network
  handle('get-network-devices', async () => getNetworkDevices());

  // Resources
  handle('get-resource-usage', async () => getResourceUsage());

  // Misc
  handle('open-url', async (_, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    shell.openExternal(url);
    return true;
  });
  handle('get-recent-projects', async () => readRecentProjects());
  handle('add-recent-project', async (_, projectPath) => addRecentProject(projectPath));
  handle('open-app-log', async () => {
    const logPath = path.join(getConfigDir(), 'main.log');
    try {
      if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '');
      shell.showItemInFolder(logPath);
      return { ok: true, path: logPath };
    } catch (error) {
      return { ok: false, error: error.message, path: logPath };
    }
  });
  handle('get-platform-info', async () => ({
    platform: platform.PLATFORM,
    isWindows: platform.IS_WINDOWS,
    isLinux: platform.IS_LINUX,
    dataDir: getConfigDir(),
    logPath: path.join(getConfigDir(), 'main.log')
  }));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) getMainWindow();
  });

  logLine(`App ready on ${platform.PLATFORM}`);
});

app.on('before-quit', () => {
  stopPhpServer();
  stopPhpMyAdminServer();
});

app.on('window-all-closed', () => {
  if (rendererGoneUnexpectedly && !reopeningWindow) {
    // The window disappeared because its renderer died — recover instead of
    // quitting, so the app does not close itself while the user is working.
    rendererGoneUnexpectedly = false;
    reopeningWindow = true;
    logLine('Window lost after a renderer failure — reopening');
    setTimeout(() => {
      reopeningWindow = false;
      if (BrowserWindow.getAllWindows().length === 0) getMainWindow();
    }, 400);
    return;
  }

  logLine('All windows closed — shutting down');
  stopPhpServer();
  stopPhpMyAdminServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ─── Folder chooser (used above) ─────────────────────────────────────────────

function chooseFolder() {
  return dialog
    .showOpenDialog({
      title: 'Choose a folder with your PHP scripts',
      defaultPath: DEFAULT_SCRIPTS_FOLDER,
      properties: ['openDirectory']
    })
    .then((result) => {
      if (result.canceled || !result.filePaths.length) return null;
      const folder = path.resolve(result.filePaths[0]);

      const settings = readSettings();
      settings.lastPhpPath = folder;
      writeSettings(settings);

      addRecentProject(folder);
      return folder;
    });
}
