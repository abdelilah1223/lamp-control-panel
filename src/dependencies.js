/* ═══════════════════════════════════════════════════════════════════════════
   dependencies.js — Verify & install the LAMP stack pieces
   ───────────────────────────────────────────────────────────────────────────
   Responsibilities
     1. Detect each component independently (PHP, MariaDB, phpMyAdmin) so a
        machine that is only missing one of them installs just that one.
     2. Resolve the *latest* version of a component from its official source.
     3. Install what is missing, using the same mechanism a user would get by
        installing it manually (distro package manager / winget, or the
        official archive extracted and registered on PATH).
     4. Ask the user for permission once, through a single generated script,
        whenever administrator rights are required.

   The module is UI-agnostic: main.js supplies a consent callback and a
   progress callback, and the standalone `scripts/check-deps.js` prints to the
   terminal instead.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const platform = require('./platform');

const {
  IS_WINDOWS,
  IS_LINUX,
  IS_MAC,
  HOME,
  run,
  runShellCommand,
  runPowerShell,
  findExecutable,
  fileExists,
  detectElevationTool,
  runElevatedScript,
  manualElevationHint
} = platform;

const USER_AGENT = 'LAMP-Control-Panel/1.1 (+https://github.com/lamp-control-panel)';

// ─── Configuration ───────────────────────────────────────────────────────────

/** Default matches Electron's app.getPath('appData') so every entry point agrees. */
function defaultDataDir() {
  if (IS_WINDOWS) return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'lamp-control-panel');
  if (IS_MAC) return path.join(HOME, 'Library', 'Application Support', 'lamp-control-panel');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'lamp-control-panel');
}

let DATA_DIR = defaultDataDir();
let logger = () => {};

function configure(options = {}) {
  if (options.dataDir) DATA_DIR = options.dataDir;
  if (typeof options.log === 'function') logger = options.log;
  return { dataDir: DATA_DIR };
}

function getDataDir() {
  return DATA_DIR;
}

function downloadsDir() {
  return path.join(DATA_DIR, 'downloads');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

const CATALOG = [
  {
    id: 'php',
    name: 'PHP',
    summary: 'PHP runtime and built-in web server',
    homepage: 'https://www.php.net/downloads'
  },
  {
    id: 'mariadb',
    name: 'MariaDB',
    summary: 'Database server and client',
    homepage: 'https://mariadb.org/download/'
  },
  {
    id: 'phpmyadmin',
    name: 'phpMyAdmin',
    summary: 'Browser-based database administration',
    homepage: 'https://www.phpmyadmin.net/downloads/'
  }
];

const CATALOG_IDS = CATALOG.map((entry) => entry.id);

function listCatalog() {
  return CATALOG.map((entry) => ({ ...entry }));
}

// ─── Small utility helpers ───────────────────────────────────────────────────

function compareVersions(a, b) {
  const pa = String(a || '0').split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** A clean dotted version such as 11.8.8 out of noisy tool output. */
function dottedVersion(text) {
  const match = String(text || '').match(/(\d+\.\d+\.\d+)/);
  if (match) return match[1];
  const short = String(text || '').match(/(\d+\.\d+)/);
  return short ? short[1] : null;
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    signal: options.signal
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${error.message}`);
  }
}

/**
 * Download a file with a streamed body. Returns { path, bytes, sha256 }.
 */
async function downloadFile(url, destPath, options = {}) {
  ensureDir(path.dirname(destPath));
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    signal: options.signal
  });
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}) for ${url}`);
  if (!response.body) throw new Error(`Empty response body for ${url}`);

  const total = Number(response.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  let received = 0;
  let lastReport = 0;

  const nodeStream = Readable.fromWeb(response.body);
  nodeStream.on('data', (chunk) => {
    hash.update(chunk);
    received += chunk.length;
    const now = Date.now();
    if (options.onProgress && now - lastReport > 250) {
      lastReport = now;
      options.onProgress({ url, received, total, percent: total ? Math.round((received / total) * 100) : null });
    }
  });

  const tmp = `${destPath}.part`;
  await pipeline(nodeStream, fs.createWriteStream(tmp));
  await fsp.rename(tmp, destPath);

  if (options.onProgress) options.onProgress({ url, received, total, percent: 100, done: true });
  return { path: destPath, bytes: received, sha256: hash.digest('hex') };
}

async function verifySha256(filePath, expected) {
  if (!expected) return { ok: true, skipped: true };
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), async function* (source) {
    for await (const chunk of source) hash.update(chunk);
  });
  const actual = hash.digest('hex');
  return { ok: actual.toLowerCase() === String(expected).toLowerCase(), actual, expected };
}

/** Extract an archive into destDir. Uses OS-native tools (no native npm deps). */
async function extractArchive(archivePath, destDir) {
  ensureDir(destDir);
  const lower = archivePath.toLowerCase();

  if (lower.endsWith('.zip')) {
    if (IS_WINDOWS) {
      const result = await runPowerShell(
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
        { timeout: 300000 }
      );
      if (!result.ok) throw new Error(result.stderr || 'Expand-Archive failed');
      return true;
    }
    let result = await run('unzip', ['-o', '-q', archivePath, '-d', destDir], { timeout: 300000 });
    if (!result.ok) {
      // busybox/minimal images may ship a different unzip; try 7z as a fallback.
      result = await run('7z', ['x', '-y', `-o${destDir}`, archivePath], { timeout: 300000 });
    }
    if (!result.ok) throw new Error(result.stderr || 'unzip failed');
    return true;
  }

  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    const result = await run('tar', ['-xzf', archivePath, '-C', destDir], { timeout: 300000 });
    if (!result.ok) throw new Error(result.stderr || 'tar failed');
    return true;
  }

  throw new Error(`Unsupported archive format: ${path.basename(archivePath)}`);
}

/** Find the single top-level directory produced by an archive, if any. */
function findSingleChildDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  return entries.length === 1 ? path.join(dir, entries[0].name) : null;
}

// ─── Detection ───────────────────────────────────────────────────────────────

function phpCandidateDirs() {
  const dirs = [];
  if (IS_WINDOWS) {
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'php'));
    if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, 'PHP'), path.join(process.env.ProgramFiles, 'php'));
    dirs.push('C:\\php', 'C:\\xampp\\php', 'C:\\wamp64\\bin\\php', 'C:\\laragon\\bin\\php');
  } else {
    dirs.push('/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/usr/sbin');
    dirs.push(path.join(HOME, '.local', 'bin'));
  }
  return dirs;
}

async function detectPhp() {
  const result = { id: 'php', name: 'PHP', installed: false, version: null, location: null, source: null };

  const onPath = await findExecutable('php');
  if (onPath) {
    const versionOut = await run(onPath, ['-r', 'echo PHP_VERSION;'], { timeout: 15000 });
    const version = versionOut.ok && versionOut.stdout.trim() ? versionOut.stdout.trim() : null;
    if (version) {
      return { ...result, installed: true, version, location: onPath, source: 'PATH' };
    }
  }

  for (const dir of phpCandidateDirs()) {
    const candidate = path.join(dir, platform.binaryName('php'));
    if (!fileExists(candidate)) continue;
    const versionOut = await run(candidate, ['-r', 'echo PHP_VERSION;'], { timeout: 15000 });
    if (versionOut.ok && versionOut.stdout.trim()) {
      return { ...result, installed: true, version: versionOut.stdout.trim(), location: candidate, source: 'filesystem' };
    }
  }

  return result;
}

function mariadbCandidateDirs() {
  if (IS_WINDOWS) {
    return [
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'MariaDB') : null,
      'C:\\Program Files\\MariaDB',
      'C:\\xampp\\mysql',
      'C:\\wamp64\\bin\\mariadb'
    ].filter(Boolean);
  }
  return ['/usr/bin', '/usr/sbin', '/usr/local/bin', '/opt/homebrew/bin', '/usr/local/mysql/bin'];
}

async function detectMariaDb() {
  const result = {
    id: 'mariadb',
    name: 'MariaDB',
    installed: false,
    version: null,
    location: null,
    source: null,
    serviceName: null,
    serviceState: 'unknown'
  };

  const serverNames = ['mariadbd', 'mysqld'];
  const clientNames = ['mariadb', 'mysql'];

  let serverPath = null;
  for (const name of serverNames) {
    const found = await findExecutable(name);
    if (found) {
      serverPath = found;
      break;
    }
  }

  if (!serverPath) {
    for (const dir of mariadbCandidateDirs()) {
      for (const name of serverNames.concat(clientNames)) {
        const candidate = path.join(dir, platform.binaryName(name));
        if (fileExists(candidate)) {
          serverPath = candidate;
          break;
        }
      }
      if (serverPath) break;
    }
  }

  let clientPath = null;
  for (const name of clientNames) {
    const found = await findExecutable(name);
    if (found) {
      clientPath = found;
      break;
    }
  }

  const serviceName = await platform.detectServiceName('mariadb');
  const serviceState = await platform.getServiceState('mariadb');

  if (serverPath || serviceName) {
    const probeTarget = serverPath || clientPath;
    let version = null;
    if (probeTarget) {
      const versionOut = await run(probeTarget, ['--version'], { timeout: 20000 });
      version = dottedVersion(`${versionOut.stdout} ${versionOut.stderr}`);
    }
    result.installed = true;
    result.version = version;
    result.location = serverPath || serviceName;
    result.source = serverPath ? 'filesystem' : 'service';
  }

  result.serviceName = serviceName;
  result.serviceState = serviceState;
  return result;
}

function phpMyAdminCandidateDirs() {
  const dirs = [];
  if (IS_WINDOWS) {
    dirs.push(
      'C:\\xampp\\phpMyAdmin',
      'C:\\wamp64\\apps\\phpmyadmin',
      'C:\\wamp\\apps\\phpmyadmin',
      'C:\\laragon\\etc\\apps\\phpMyAdmin',
      'C:\\Apache24\\htdocs\\phpMyAdmin',
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Apache Software Foundation', 'Apache2.4', 'htdocs', 'phpMyAdmin')
    );
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'lamp-control-panel', 'phpmyadmin'));
  } else {
    dirs.push(
      '/usr/share/phpMyAdmin',
      '/usr/share/phpmyadmin',
      '/var/www/html/phpMyAdmin',
      '/var/www/html/phpmyadmin',
      '/var/www/phpmyadmin',
      '/opt/lampp/phpmyadmin',
      '/usr/local/share/phpmyadmin',
      '/opt/homebrew/share/phpmyadmin',
      '/Library/WebServer/Documents/phpmyadmin'
    );
  }
  return dirs;
}

/** A directory is a phpMyAdmin install when it has index.php and a libraries folder. */
function looksLikePhpMyAdmin(dir) {
  try {
    return fileExists(path.join(dir, 'index.php')) && (fileExists(path.join(dir, 'libraries')) || fileExists(path.join(dir, 'libraries', 'classes', 'Version.php')));
  } catch {
    return false;
  }
}

function readPhpMyAdminVersion(dir) {
  const versionFile = path.join(dir, 'libraries', 'classes', 'Version.php');
  try {
    const raw = fs.readFileSync(versionFile, 'utf8');
    const match = raw.match(/const\s+VERSION\s*=\s*'([^']+)'/);
    if (match) return match[1].replace(/\s*\.\s*VERSION_SUFFIX/, '').trim();
  } catch {
    /* fall through */
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg && pkg.version) return pkg.version;
  } catch {
    /* fall through */
  }
  try {
    const readme = fs.readFileSync(path.join(dir, 'README'), 'utf8');
    const match = readme.match(/phpMyAdmin\s+(\d+\.\d+\.\d+)/i);
    if (match) return match[1];
  } catch {
    /* fall through */
  }
  return null;
}

/** Managed phpMyAdmin copy (downloaded by this app into the user data dir). */
function managedPhpMyAdminDir() {
  return path.join(DATA_DIR, 'phpmyadmin');
}

function readManagedPhpMyAdmin() {
  const root = managedPhpMyAdminDir();
  const pointer = path.join(root, 'current.json');
  try {
    const info = JSON.parse(fs.readFileSync(pointer, 'utf8'));
    if (info && info.path && looksLikePhpMyAdmin(info.path)) return info;
  } catch {
    /* fall through */
  }
  if (!fileExists(root)) return null;
  // Any version folder will do if the pointer is missing.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (looksLikePhpMyAdmin(full)) {
      return { version: readPhpMyAdminVersion(full), path: full, installedAt: null };
    }
  }
  return null;
}

async function detectPhpMyAdmin() {
  const result = {
    id: 'phpmyadmin',
    name: 'phpMyAdmin',
    installed: false,
    version: null,
    location: null,
    source: null,
    managed: false
  };

  const managed = readManagedPhpMyAdmin();
  if (managed) {
    return { ...result, installed: true, version: managed.version, location: managed.path, source: 'managed', managed: true };
  }

  for (const dir of phpMyAdminCandidateDirs()) {
    if (looksLikePhpMyAdmin(dir)) {
      return { ...result, installed: true, version: readPhpMyAdminVersion(dir), location: dir, source: 'system', managed: false };
    }
  }

  // Debian/Ubuntu keep the package at /usr/share/phpmyadmin and expose it through Apache.
  for (const dir of ['/etc/phpmyadmin', '/usr/share/phpmyadmin']) {
    if (fileExists(dir)) {
      return { ...result, installed: true, version: null, location: dir, source: 'system', managed: false };
    }
  }

  return result;
}

const DETECTORS = {
  php: detectPhp,
  mariadb: detectMariaDb,
  phpmyadmin: detectPhpMyAdmin
};

async function detectDependency(id) {
  const detector = DETECTORS[id];
  if (!detector) throw new Error(`Unknown dependency: ${id}`);
  try {
    return await detector();
  } catch (error) {
    logger(`Detection failed for ${id}: ${error.message}`);
    return { id, name: id, installed: false, version: null, location: null, error: error.message };
  }
}

/** Detect every component independently — never fails as a whole. */
async function detectAll() {
  const results = await Promise.all(CATALOG_IDS.map((id) => detectDependency(id)));
  const map = {};
  for (const entry of results) map[entry.id] = entry;
  return map;
}

// ─── Latest version resolution ───────────────────────────────────────────────

const latestCache = new Map();
const LATEST_TTL_MS = 10 * 60 * 1000;

/**
 * Latest released version for a component, resolved independently per item so
 * one unreachable source never blocks the others.
 *
 * Results are cached for LATEST_TTL_MS: the UI refreshes often and re-hitting
 * every upstream source each time is what made the panel feel sluggish.
 */
async function resolveLatest(id, options = {}) {
  const cached = latestCache.get(id);
  if (!options.force && cached && Date.now() - cached.at < (options.maxAge ?? LATEST_TTL_MS)) {
    return cached.value;
  }
  const resolver = { php: latestPhp, mariadb: latestMariaDb, phpmyadmin: latestPhpMyAdmin }[id];
  if (!resolver) throw new Error(`Unknown dependency: ${id}`);
  const value = await resolver();
  latestCache.set(id, { value, at: Date.now() });
  return value;
}

/** PHP — version straight from php.net, Windows archive name from windows.php.net. */
async function latestPhp() {
  let version = null;
  try {
    const releases = await fetchJson('https://www.php.net/releases/index.php?json&max=3');
    for (const key of Object.keys(releases || {})) {
      const entry = releases[key];
      const source = Array.isArray(entry.source) ? entry.source : [];
      for (const file of source) {
        const match = String(file.filename || '').match(/^php-(\d+\.\d+\.\d+)\.tar\.gz$/);
        if (match && (!version || compareVersions(match[1], version) > 0)) version = match[1];
      }
    }
  } catch (error) {
    logger(`php.net release lookup failed: ${error.message}`);
  }

  const info = { version, source: 'https://www.php.net/releases/', downloadUrl: null, archiveName: null };

  if (IS_WINDOWS) {
    try {
      const listing = await fetchText('https://windows.php.net/downloads/releases/latest/');
      const pattern = /php-(\d+\.\d+)-nts-Win32-vs(\d+)-x64-latest\.zip/g;
      let best = null;
      let match;
      while ((match = pattern.exec(listing)) !== null) {
        const major = match[1];
        if (!best || compareVersions(major, best.major) > 0) best = { major, file: match[0] };
      }
      if (best) {
        info.downloadUrl = `https://windows.php.net/downloads/releases/latest/${best.file}`;
        info.archiveName = best.file;
        if (!info.version) info.version = best.major;
        info.source = 'https://windows.php.net/downloads/releases/latest/';
      }
    } catch (error) {
      logger(`windows.php.net lookup failed: ${error.message}`);
    }
  }

  if (!info.version) throw new Error('Could not determine the latest PHP version');
  return info;
}

/**
 * MariaDB — pick the newest stable series from the official REST API, then the
 * newest patch in that series.
 */
async function latestMariaDb() {
  const index = await fetchJson('https://downloads.mariadb.org/rest-api/mariadb/');
  const stable = (index.major_releases || [])
    .filter((entry) => (entry.release_status || '').toLowerCase() === 'stable')
    .map((entry) => entry.release_id)
    .sort(compareVersions);
  const series = stable[stable.length - 1];
  if (!series) throw new Error('No stable MariaDB series reported by downloads.mariadb.org');

  const detail = await fetchJson(`https://downloads.mariadb.org/rest-api/mariadb/${encodeURIComponent(series)}/`);
  const releases = detail.releases || detail.release_data || {};
  const version = Object.keys(releases).sort(compareVersions).pop();

  const info = { version: version || series, series, source: 'https://downloads.mariadb.org/', downloadUrl: null, sha256: null };
  if (version && IS_WINDOWS) {
    const files = (releases[version] && releases[version].files) || [];
    const msi = files.find((file) => /winx64\.msi$/i.test(file.file_name || ''));
    if (msi) {
      info.downloadUrl = msi.file_download_url || `https://downloads.mariadb.org/rest-api/mariadb/${version}/${msi.file_name}`;
      info.sha256 = (msi.checksum && msi.checksum.sha256sum) || null;
    }
  }
  return info;
}

/** phpMyAdmin — GitHub releases, with the official download page as fallback. */
async function latestPhpMyAdmin() {
  try {
    const release = await fetchJson('https://api.github.com/repos/phpmyadmin/phpmyadmin/releases/latest');
    // Tags look like "RELEASE_5_2_3" or "5.2.3"; normalise both shapes.
    const tag = String(release.tag_name || release.name || '').replace(/_/g, '.');
    const match = tag.match(/(\d+\.\d+\.\d+)/);
    if (match) {
      const version = match[1];
      const archive = `phpMyAdmin-${version}-all-languages.zip`;
      return {
        version,
        source: 'https://api.github.com/repos/phpmyadmin/phpmyadmin/releases/latest',
        downloadUrl: `https://files.phpmyadmin.net/phpMyAdmin/${version}/${archive}`,
        archiveName: archive
      };
    }
  } catch (error) {
    logger(`GitHub release lookup failed: ${error.message}`);
  }

  const page = await fetchText('https://www.phpmyadmin.net/downloads/');
  const found = new Set();
  const pattern = /phpMyAdmin-(\d+\.\d+\.\d+)-all-languages\.zip/g;
  let match;
  while ((match = pattern.exec(page)) !== null) found.add(match[1]);
  const version = [...found].sort(compareVersions).pop();
  if (!version) throw new Error('Could not determine the latest phpMyAdmin version');
  return {
    version,
    source: 'https://www.phpmyadmin.net/downloads/',
    downloadUrl: `https://files.phpmyadmin.net/phpMyAdmin/${version}/phpMyAdmin-${version}-all-languages.zip`,
    archiveName: `phpMyAdmin-${version}-all-languages.zip`
  };
}

// ─── Package managers ────────────────────────────────────────────────────────

const LINUX_PACKAGE_MANAGERS = [
  {
    id: 'dnf',
    check: 'dnf',
    install: (pkgs) => ['dnf', 'install', '-y', ...pkgs],
    upgrade: (pkgs) => ['dnf', 'upgrade', '-y', ...pkgs],
    refresh: null
  },
  {
    id: 'yum',
    check: 'yum',
    install: (pkgs) => ['yum', 'install', '-y', ...pkgs],
    upgrade: (pkgs) => ['yum', 'update', '-y', ...pkgs],
    refresh: null
  },
  {
    id: 'apt',
    check: 'apt-get',
    install: (pkgs) => ['apt-get', 'install', '-y', ...pkgs],
    upgrade: (pkgs) => ['apt-get', 'install', '--only-upgrade', '-y', ...pkgs],
    refresh: ['apt-get', 'update'],
    env: { DEBIAN_FRONTEND: 'noninteractive' }
  },
  {
    id: 'zypper',
    check: 'zypper',
    install: (pkgs) => ['zypper', '--non-interactive', 'install', ...pkgs],
    upgrade: (pkgs) => ['zypper', '--non-interactive', 'update', ...pkgs],
    refresh: null
  },
  {
    id: 'pacman',
    check: 'pacman',
    install: (pkgs) => ['pacman', '-S', '--noconfirm', ...pkgs],
    upgrade: (pkgs) => ['pacman', '-S', '--noconfirm', ...pkgs],
    refresh: null
  },
  {
    id: 'apk',
    check: 'apk',
    install: (pkgs) => ['apk', 'add', '--no-cache', ...pkgs],
    upgrade: (pkgs) => ['apk', 'add', '--no-cache', ...pkgs],
    refresh: ['apk', 'update']
  }
];

const LINUX_PACKAGES = {
  dnf: { php: ['php', 'php-cli', 'php-mysqlnd', 'php-mbstring', 'php-xml'], mariadb: ['mariadb-server', 'mariadb'] },
  yum: { php: ['php', 'php-cli', 'php-mysqlnd', 'php-mbstring', 'php-xml'], mariadb: ['mariadb-server', 'mariadb'] },
  apt: { php: ['php-cli', 'php-mysql', 'php-mbstring', 'php-xml'], mariadb: ['mariadb-server', 'mariadb-client'] },
  zypper: { php: ['php', 'php-cli', 'php-mysql', 'php-mbstring'], mariadb: ['mariadb', 'mariadb-client'] },
  pacman: { php: ['php', 'php-gd'], mariadb: ['mariadb', 'mariadb-clients'] },
  apk: { php: ['php', 'php-mysqli', 'php-mbstring'], mariadb: ['mariadb', 'mariadb-client'] }
};

async function detectPackageManager() {
  if (!IS_LINUX) return null;
  for (const manager of LINUX_PACKAGE_MANAGERS) {
    if (await findExecutable(manager.check)) return manager;
  }
  return null;
}

async function detectWinget() {
  if (!IS_WINDOWS) return null;
  if (await findExecutable('winget')) return 'winget';
  const probe = await run('winget', ['--version'], { timeout: 15000 });
  return probe.ok ? 'winget' : null;
}

/** The package a user's distro would actually install for a component. */
const PACKAGE_PRIMARY = {
  dnf: { php: 'php', mariadb: 'mariadb-server' },
  yum: { php: 'php', mariadb: 'mariadb-server' },
  apt: { php: 'php-cli', mariadb: 'mariadb-server' },
  zypper: { php: 'php', mariadb: 'mariadb' },
  pacman: { php: 'php', mariadb: 'mariadb' },
  apk: { php: 'php', mariadb: 'mariadb' }
};

/**
 * Version the local package manager would install/upgrade to.
 * Returns null when it cannot be determined.
 */
const candidateCache = new Map();
const CANDIDATE_TTL_MS = 10 * 60 * 1000;

async function packageCandidate(id, options = {}) {
  if (!IS_LINUX) return null;
  const cached = candidateCache.get(id);
  if (!options.force && cached && Date.now() - cached.at < CANDIDATE_TTL_MS) {
    return cached.value;
  }
  const value = await queryPackageCandidate(id);
  candidateCache.set(id, { value, at: Date.now() });
  return value;
}

/** Ask the local package manager which version it would install. */
async function queryPackageCandidate(id) {
  const manager = await detectPackageManager();
  if (!manager) return null;
  const pkg = (PACKAGE_PRIMARY[manager.id] || {})[id];
  if (!pkg) return null;

  const collect = (text) => {
    const versions = new Set();
    const re = /(\d+\.\d+\.\d+)/g;
    let match;
    while ((match = re.exec(text)) !== null) versions.add(match[1]);
    return [...versions].sort(compareVersions).pop() || null;
  };

  switch (manager.id) {
    case 'dnf':
    case 'yum': {
      const result = await run(manager.id, ['-q', 'list', '--available', pkg], { timeout: 25000 });
      // "php.x86_64   8.5.11-1.fc44   updates"
      const line = result.stdout.split('\n').find((entry) => entry.includes(pkg + '.'));
      return line ? collect(line.replace(/\S+\.\S+\s+/, '')) : null;
    }
    case 'apt': {
      const result = await run('apt-cache', ['policy', pkg], { timeout: 20000 });
      const match = result.stdout.match(/Candidate:\s*(\S+)/);
      return match ? collect(match[1]) : null;
    }
    case 'zypper': {
      const result = await run('zypper', ['--no-refresh', 'info', pkg], { timeout: 30000 });
      const match = result.stdout.match(/Version\s*:\s*(\S+)/);
      return match ? collect(match[1]) : null;
    }
    case 'pacman': {
      const result = await run('pacman', ['-Si', pkg], { timeout: 20000 });
      const match = result.stdout.match(/Version\s*:\s*(\S+)/);
      return match ? collect(match[1]) : null;
    }
    case 'apk': {
      const result = await run('apk', ['policy', pkg], { timeout: 20000 });
      return collect(result.stdout);
    }
    default:
      return null;
  }
}

/**
 * Version that installing/updating right now would produce: the upstream
 * release on Windows/macOS, the distro package candidate on Linux.
 */
async function resolveAvailable(id, options = {}) {
  if (IS_LINUX && id !== 'phpmyadmin') {
    const candidate = await packageCandidate(id, options);
    if (candidate) return { version: candidate, source: 'package-manager' };
  }
  const latest = await resolveLatest(id, options);
  return { version: latest.version, source: latest.source };
}

// ─── Install planning ────────────────────────────────────────────────────────

const WINGET_IDS = { php: 'PHP.PHP', mariadb: 'MariaDB.Server' };

/**
 * Decide how each missing component gets installed on this machine.
 * Only the requested (missing) ids are planned — never the whole stack.
 */
async function planInstall(ids, options = {}) {
  const wanted = ids.filter((id) => CATALOG_IDS.includes(id));
  const upgrades = new Set(options.upgrades || []);
  const actionFor = (id) => (upgrades.has(id) ? 'upgrade' : 'install');
  const pkgManager = await detectPackageManager();
  const winget = await detectWinget();
  const elevation = await detectElevationTool();

  const items = [];
  for (const id of wanted) {
    const action = actionFor(id);

    if (id === 'phpmyadmin') {
      items.push({
        id,
        action,
        name: 'phpMyAdmin',
        strategy: 'archive',
        needsElevation: false,
        detail:
          action === 'upgrade'
            ? 'Download the newest official all-languages archive and replace the copy in the app data folder.'
            : 'Download the official all-languages archive into the app data folder and serve it locally.'
      });
      continue;
    }

    if (IS_WINDOWS) {
      if (winget) {
        items.push({
          id,
          action,
          name: id === 'php' ? 'PHP' : 'MariaDB',
          strategy: 'winget',
          needsElevation: true,
          detail:
            action === 'upgrade'
              ? `winget upgrade ${WINGET_IDS[id]} (installs the newest release like a manual update).`
              : `winget install ${WINGET_IDS[id]} (registers the package the same way a manual install does).`
        });
      } else {
        items.push({
          id,
          action,
          name: id === 'php' ? 'PHP' : 'MariaDB',
          strategy: id === 'php' ? 'portable' : 'msi',
          needsElevation: id !== 'php',
          detail:
            id === 'php'
              ? 'Download the latest official PHP zip, extract it under %LOCALAPPDATA%\\Programs\\php and add it to your user PATH.'
              : 'Download the latest official MariaDB MSI and install it (creates the MariaDB Windows service).'
        });
      }
      continue;
    }

    if (IS_MAC) {
      items.push({
        id,
        action,
        name: id === 'php' ? 'PHP' : 'MariaDB',
        strategy: 'brew',
        needsElevation: false,
        detail: `brew ${action === 'upgrade' ? 'upgrade' : 'install'} ${id === 'php' ? 'php' : 'mariadb'}`
      });
      continue;
    }

    items.push({
      id,
      action,
      name: id === 'php' ? 'PHP' : 'MariaDB',
      strategy: pkgManager ? 'package' : 'unavailable',
      needsElevation: true,
      detail: pkgManager
        ? `${pkgManager.id} ${action === 'upgrade' ? 'upgrade' : 'install'} ${(LINUX_PACKAGES[pkgManager.id][id] || []).join(' ')}`
        : 'No supported package manager found (looked for dnf, yum, apt, zypper, pacman, apk).'
    });
  }

  const needsElevation = items.some((item) => item.needsElevation);
  return {
    items,
    needsElevation,
    elevation,
    packageManager: pkgManager ? pkgManager.id : null,
    winget: Boolean(winget)
  };
}

// ─── Elevated install script ─────────────────────────────────────────────────

/**
 * Build one script that performs every privileged step. A single script means a
 * single consent dialog in the app and a single OS privilege prompt.
 */
async function buildElevatedScript(plan, runId) {
  const scriptDir = ensureDir(path.join(DATA_DIR, 'logs'));

  if (IS_WINDOWS) {
    const lines = ['$failed = @()'];
    for (const item of plan.items) {
      if (item.strategy === 'winget') {
        const id = WINGET_IDS[item.id];
        const verb = item.action === 'upgrade' ? 'upgrade' : 'install';
        lines.push(
          `Write-Host '>>> ${verb === 'upgrade' ? 'Updating' : 'Installing'} ${item.name} via winget (${id})'`,
          `winget ${verb} --id ${id} -e --silent --accept-source-agreements --accept-package-agreements --disable-interactivity`,
          `if ($LASTEXITCODE -ne 0) { $failed += '${item.id}' }`
        );
      } else if (item.strategy === 'msi') {
        const msi = item.downloadPath;
        if (!msi) {
          lines.push(`$failed += '${item.id}'  # missing installer path`);
          continue;
        }
        lines.push(
          `Write-Host '>>> Installing ${item.name} from MSI'`,
          `$p = Start-Process msiexec.exe -ArgumentList @('/i','${msi.replace(/'/g, "''")}','/qn','/norestart','SERVICENAME=MariaDB','PORT=3306') -Wait -PassThru`,
          `if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { $failed += '${item.id}' }`
        );
      }
    }
    lines.push("if ($failed.Count -gt 0) { Write-Host 'FAILED:' ($failed -join ',') } else { Write-Host 'ALL_OK' }");
    const script = platform.withElevation(lines, { scriptDir, name: `install-${runId}` });
    return { path: script.scriptPath, type: 'powershell', logPath: script.logPath, preview: script.preview };
  }

  const touchesMariadb = plan.items.some((item) => item.id === 'mariadb');
  const lines = [
    'failed=""',
    'echo "LAMP Control Panel — updating your PHP stack"'
  ];

  if (plan.packageManager) {
    const manager = LINUX_PACKAGE_MANAGERS.find((entry) => entry.id === plan.packageManager);
    if (manager && manager.refresh) {
      lines.push(`echo ">>> ${manager.refresh.join(' ')}"`, manager.refresh.join(' '));
    }
    if (manager) {
      for (const item of plan.items) {
        if (item.strategy !== 'package') continue;
        const pkgs = (LINUX_PACKAGES[manager.id] && LINUX_PACKAGES[manager.id][item.id]) || [];
        const build = item.action === 'upgrade' && manager.upgrade ? manager.upgrade : manager.install;
        const cmd = build(pkgs).join(' ');
        lines.push(
          `echo ">>> ${item.action === 'upgrade' ? 'Updating' : 'Installing'} ${item.name}: ${cmd}"`,
          cmd,
          `if [ $? -ne 0 ]; then failed="$failed ${item.id}"; fi`
        );
      }
      if (touchesMariadb) {
        lines.push(
          'echo ">>> Enabling the database service"',
          'systemctl enable --now mariadb >/dev/null 2>&1 || systemctl enable --now mysql >/dev/null 2>&1 || true'
        );
      }
    }
  }

  lines.push('if [ -n "$failed" ]; then echo "FAILED:$failed"; else echo "ALL_OK"; fi');

  const script = platform.withElevation(lines, { scriptDir, name: `install-${runId}` });
  return { path: script.scriptPath, type: 'bash', logPath: script.logPath, preview: script.preview };
}

// ─── Per-item installers (no privileges required) ────────────────────────────

/** Make a fresh php.ini in a portable PHP directory so extensions are enabled. */
function writePortablePhpIni(phpDir) {
  const target = path.join(phpDir, 'php.ini');
  if (fileExists(target)) return target;

  const source = ['php.ini-production', 'php.ini-development']
    .map((name) => path.join(phpDir, name))
    .find((candidate) => fileExists(candidate));

  let content = source ? fs.readFileSync(source, 'utf8') : '[PHP]\n';
  const extensionDir = path.join(phpDir, 'ext');
  content = content.replace(/^\s*;\s*extension_dir\s*=.*$/m, `extension_dir = "${extensionDir}"`);
  if (!/^\s*extension_dir\s*=/m.test(content)) content += `\nextension_dir = "${extensionDir}"\n`;

  for (const extension of ['mysqli', 'pdo_mysql', 'mbstring', 'curl', 'openssl', 'fileinfo', 'gd']) {
    const enabled = new RegExp(`^\\s*extension\\s*=\\s*${extension}\\s*$`, 'm');
    const commented = new RegExp(`^\\s*;\\s*extension\\s*=\\s*${extension}\\s*$`, 'm');
    if (enabled.test(content)) continue;
    if (commented.test(content)) content = content.replace(commented, `extension=${extension}`);
    else content += `\nextension=${extension}\n`;
  }

  fs.writeFileSync(target, content, 'utf8');
  return target;
}

/** Add a directory to the current user's PATH on Windows (mirrors a manual install). */
async function addToUserPathWindows(dir) {
  const script =
    `$current = [Environment]::GetEnvironmentVariable('Path','User'); ` +
    `if (-not $current) { $current = '' }; ` +
    `if (($current -split ';') -notcontains '${dir.replace(/'/g, "''")}') { ` +
    `[Environment]::SetEnvironmentVariable('Path', ($current.TrimEnd(';') + ';${dir.replace(/'/g, "''")}').TrimStart(';'), 'User') }`;
  const result = await runPowerShell(script, { timeout: 20000 });
  return result.ok;
}

/** Add a symlink to ~/.local/bin on Linux/macOS so `php` is on PATH. */
async function addToUserPathPosix(binaryPath) {
  const binDir = path.join(HOME, '.local', 'bin');
  ensureDir(binDir);
  const link = path.join(binDir, path.basename(binaryPath));
  try {
    if (fs.existsSync(link)) return true;
    await fsp.symlink(binaryPath, link);
    return true;
  } catch {
    return false;
  }
}

function generateBlowfishSecret() {
  return crypto.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
}

/** A minimal config.inc.php so a freshly extracted phpMyAdmin is usable. */
function writePhpMyAdminConfig(dir) {
  const target = path.join(dir, 'config.inc.php');
  const sample = path.join(dir, 'config.sample.inc.php');
  let content = '';
  if (fileExists(sample)) content = fs.readFileSync(sample, 'utf8');

  if (content && /blowfish_secret/.test(content)) {
    content = content.replace(
      /\$cfg\['blowfish_secret'\]\s*=\s*'[^']*'\s*;/,
      `$cfg['blowfish_secret'] = '${generateBlowfishSecret()}';`
    );
  } else {
    content =
      '<?php\n' +
      '/* Generated by LAMP Control Panel */\n' +
      `$cfg['blowfish_secret'] = '${generateBlowfishSecret()}';\n` +
      "$i = 0;\n" +
      "$i++;\n" +
      "$cfg['Servers'][$i]['auth_type'] = 'cookie';\n" +
      "$cfg['Servers'][$i]['host'] = '127.0.0.1';\n" +
      "$cfg['Servers'][$i]['compress'] = false;\n" +
      "$cfg['Servers'][$i]['AllowNoPassword'] = false;\n";
  }
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

/** Download + unpack phpMyAdmin into the managed folder. No privileges needed. */
async function installPhpMyAdmin(options = {}) {
  const latest = await resolveLatest('phpmyadmin', { force: true });
  if (!latest.downloadUrl) throw new Error('No phpMyAdmin download URL could be resolved');

  const archivePath = path.join(downloadsDir(), latest.archiveName);
  logger(`Downloading phpMyAdmin ${latest.version}`);
  await downloadFile(latest.downloadUrl, archivePath, { onProgress: options.onProgress });

  const targetDir = path.join(managedPhpMyAdminDir(), `phpMyAdmin-${latest.version}-all-languages`);
  await extractArchive(archivePath, managedPhpMyAdminDir());

  const actualDir = looksLikePhpMyAdmin(targetDir) ? targetDir : findSingleChildDir(managedPhpMyAdminDir()) || targetDir;
  if (!looksLikePhpMyAdmin(actualDir)) {
    throw new Error('The phpMyAdmin archive did not contain the expected files');
  }

  writePhpMyAdminConfig(actualDir);
  fs.writeFileSync(
    path.join(managedPhpMyAdminDir(), 'current.json'),
    JSON.stringify({ version: readPhpMyAdminVersion(actualDir) || latest.version, path: actualDir, installedAt: new Date().toISOString() }, null, 2)
  );

  try {
    await fsp.unlink(archivePath);
  } catch {
    /* keep the archive if it cannot be removed */
  }

  return { id: 'phpmyadmin', ok: true, version: latest.version, path: actualDir };
}

/** Download + unpack the portable PHP build (Windows), then register it. */
async function installPhpPortable(options = {}) {
  const latest = await resolveLatest('php', { force: true });
  if (!latest.downloadUrl) throw new Error('No Windows PHP archive could be resolved');

  const archivePath = path.join(downloadsDir(), latest.archiveName);
  logger(`Downloading PHP ${latest.version}`);
  await downloadFile(latest.downloadUrl, archivePath, { onProgress: options.onProgress });

  const installDir = path.join(process.env.LOCALAPPDATA || DATA_DIR, 'Programs', 'php');
  await fsp.rm(installDir, { recursive: true, force: true }).catch(() => {});
  ensureDir(installDir);
  await extractArchive(archivePath, installDir);

  writePortablePhpIni(installDir);
  await addToUserPathWindows(installDir);
  await fsp.unlink(archivePath).catch(() => {});

  return { id: 'php', ok: true, version: latest.version, path: installDir, note: 'Restart the app so the new PATH is picked up.' };
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function waitForLog(logPath, options = {}) {
  const timeout = options.timeout || 20000;
  const deadline = Date.now() + timeout;
  let content = '';
  while (Date.now() < deadline) {
    try {
      content = await fsp.readFile(logPath, 'utf8');
      if (/ALL_OK|FAILED:|Complete|error/i.test(content)) return content;
    } catch {
      /* not created yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  try {
    return await fsp.readFile(logPath, 'utf8');
  } catch {
    return content;
  }
}

/**
 * Install a set of components that were detected as missing.
 *
 * @param {string[]} ids                 component ids to install
 * @param {object}   options
 * @param {Function} options.onProgress  ({ phase, id, percent, message })
 * @param {Function} options.onConsent   async ({ preview, scriptPath, elevation, manualCommand }) => boolean
 * @param {Function} options.onLog       (line)
 */
async function install(ids, options = {}) {
  const requested = [...new Set(ids)].filter((id) => CATALOG_IDS.includes(id));
  const emit = (event) => {
    if (options.onProgress) options.onProgress(event);
    if (event.message) logger(event.message);
  };

  if (!requested.length) {
    return { ok: true, results: [], installed: [], skipped: [], message: 'Nothing to install.' };
  }

  ensureDir(DATA_DIR);
  const before = await detectAll();

  // A component is a target when it is missing, or when the caller explicitly
  // asked for an upgrade and a newer version is available. Without this, the
  // "Update" action was a silent no-op because the component is not missing.
  const upgradeIds = [];
  if (options.upgrade) {
    for (const id of requested) {
      const state = before[id];
      if (!state || !state.installed) continue;
      try {
        const resolved = await resolveAvailable(id, { force: true });
        state.available = resolved.version;
        state.outdated = Boolean(state.version && resolved.version && compareVersions(resolved.version, state.version) > 0);
        if (state.outdated) upgradeIds.push(id);
      } catch (error) {
        logger(`Could not check for a ${id} update: ${error.message}`);
      }
    }
  }

  const missing = requested.filter((id) => !before[id] || !before[id].installed);
  const targets = requested.filter((id) => missing.includes(id) || upgradeIds.includes(id));
  const skippedNow = requested.filter((id) => !targets.includes(id));

  if (!targets.length) {
    return {
      ok: true,
      results: requested.map((id) => ({ id, ok: true, skipped: true, version: before[id].version })),
      installed: [],
      skipped: skippedNow,
      failed: [],
      verified: requested.map((id) => ({ id, ok: true, wasMissing: false, version: before[id].version, error: null, canceled: false })),
      message: options.upgrade
        ? 'Everything requested is already on the latest available version.'
        : 'Everything requested is already installed.'
    };
  }

  emit({
    phase: 'plan',
    message: `${upgradeIds.length ? `Updating ${upgradeIds.join(', ')}` : ''}${upgradeIds.length && missing.length ? ' and ' : ''}${missing.length ? `installing ${missing.join(', ')}` : ''}`
  });
  const plan = await planInstall(targets, { upgrades: upgradeIds });

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const results = [];
  const installed = [];
  const failed = [];

  // 1. Unprivileged work first: downloads and user-scope extraction.
  for (const item of plan.items) {
    if (item.strategy === 'unavailable') {
      // No package manager / installer exists on this machine — say so instead
      // of pretending the component was handled.
      emit({ phase: 'error', id: item.id, message: `Cannot install ${item.name}: ${item.detail}` });
      results.push({ id: item.id, ok: false, error: item.detail });
      failed.push(item.id);
      continue;
    }

    if (item.strategy === 'brew') {
      // macOS only: no privileges required for the usual Homebrew setup.
      try {
        emit({ phase: 'install', id: item.id, message: `${item.action === 'upgrade' ? 'Updating' : 'Installing'} ${item.name} with Homebrew` });
        const result = await run('brew', item.action === 'upgrade' ? ['upgrade', item.id === 'php' ? 'php' : 'mariadb'] : ['install', item.id === 'php' ? 'php' : 'mariadb'], {
          timeout: 0,
          maxBuffer: 16 * 1024 * 1024
        });
        if (result.ok) {
          results.push({ id: item.id, ok: true });
          installed.push(item.id);
        } else {
          results.push({ id: item.id, ok: false, error: result.stderr || 'brew failed' });
          failed.push(item.id);
        }
      } catch (error) {
        results.push({ id: item.id, ok: false, error: error.message });
        failed.push(item.id);
      }
      continue;
    }

    if (item.strategy === 'archive') {
      try {
        emit({
          phase: 'install',
          id: item.id,
          message: `${item.action === 'upgrade' ? 'Updating' : 'Installing'} ${item.name} (no administrator rights needed)`
        });
        const result = await installPhpMyAdmin({
          onProgress: (progress) => emit({ phase: 'download', id: item.id, percent: progress.percent, message: `Downloading ${item.name} (${progress.percent ?? '?'}%)` })
        });
        results.push(result);
        installed.push(item.id);
      } catch (error) {
        results.push({ id: item.id, ok: false, error: error.message });
        failed.push(item.id);
      }
      continue;
    }

    if (item.strategy === 'portable') {
      try {
        emit({ phase: 'install', id: item.id, message: `Installing ${item.name} into your user profile` });
        const result = await installPhpPortable({
          onProgress: (progress) => emit({ phase: 'download', id: item.id, percent: progress.percent, message: `Downloading ${item.name} (${progress.percent ?? '?'}%)` })
        });
        results.push(result);
        installed.push(item.id);
      } catch (error) {
        results.push({ id: item.id, ok: false, error: error.message });
        failed.push(item.id);
      }
      continue;
    }

    if (item.strategy === 'msi') {
      // Prepare the installer ahead of the privileged run so only the install itself needs elevation.
      try {
        const latest = await resolveLatest('mariadb', { force: true });
        if (!latest.downloadUrl) throw new Error('No MariaDB MSI could be resolved');
        const msiPath = path.join(downloadsDir(), path.basename(new URL(latest.downloadUrl).pathname) || `mariadb-${latest.version}-winx64.msi`);
        emit({ phase: 'download', id: 'mariadb', message: `Downloading MariaDB ${latest.version}` });
        await downloadFile(latest.downloadUrl, msiPath, {
          onProgress: (progress) => emit({ phase: 'download', id: 'mariadb', percent: progress.percent, message: `Downloading MariaDB (${progress.percent ?? '?'}%)` })
        });
        if (latest.sha256) {
          const check = await verifySha256(msiPath, latest.sha256);
          if (!check.ok) throw new Error('MariaDB installer failed its SHA-256 check');
        }
        item.downloadPath = msiPath;
      } catch (error) {
        results.push({ id: item.id, ok: false, error: error.message });
        failed.push(item.id);
      }
    }
  }

  // 2. Privileged work, batched into one script → one consent, one OS prompt.
  const privileged = plan.items.filter(
    (item) => item.needsElevation && !failed.includes(item.id) && !['archive', 'portable', 'brew'].includes(item.strategy)
  );

  let installLogPath = null;

  if (privileged.length) {
    const script = await buildElevatedScript({ items: privileged, packageManager: plan.packageManager }, runId);
    installLogPath = script.logPath;
    emit({ phase: 'consent', message: 'Waiting for your approval to make system changes' });

    // Default to refusing: a caller that wants privileged work to run must
    // supply a consent callback that returns true.
    let approved = false;
    if (options.onConsent) {
      approved = await options.onConsent({
        items: privileged.map((item) => ({ id: item.id, name: item.name, detail: item.detail })),
        scriptPath: script.path,
        preview: script.preview,
        elevation: plan.elevation,
        manualCommand: manualElevationHint(script.path)
      });
    }

    if (!approved) {
      for (const item of privileged) {
        results.push({ id: item.id, ok: false, error: 'Canceled by user', canceled: true });
        failed.push(item.id);
      }
      emit({ phase: 'canceled', message: 'Installation canceled' });
    } else {
      emit({ phase: 'elevate', message: `Requesting administrator privileges (${plan.elevation.tool || 'manual'})` });
      const outcome = await runElevatedScript(script.path, { verbose: true });
      const log = await waitForLog(script.logPath, { timeout: 20000 });
      if (options.onLog) options.onLog(log);

      if (!outcome.ok) {
        emit({ phase: 'error', message: outcome.stderr || 'The privileged install did not complete' });
        for (const item of privileged) {
          results.push({ id: item.id, ok: false, error: outcome.canceled ? 'Canceled by user' : outcome.stderr || 'Elevated install failed', canceled: outcome.canceled });
          failed.push(item.id);
        }
      } else {
        const failedFromLog = /FAILED:([^\n]*)/.exec(log);
        const failedIds = failedFromLog ? failedFromLog[1].trim().split(/\s+/).filter(Boolean) : [];
        for (const item of privileged) {
          if (failedIds.includes(item.id)) {
            results.push({ id: item.id, ok: false, error: 'The package manager reported a failure — see the install log' });
            failed.push(item.id);
          } else {
            results.push({ id: item.id, ok: true, message: 'Installed with administrator privileges' });
            installed.push(item.id);
          }
        }
      }
    }
  }

  // 3. Verify what actually landed on the machine. Service names are re-read
  //    because a fresh install may have registered a new one.
  platform.resetServiceCache();
  const after = await detectAll();
  const verified = requested.map((id) => {
    const state = after[id] || { installed: false };
    const previous = results.find((entry) => entry.id === id) || {};
    const isUpgrade = upgradeIds.includes(id);

    // An upgrade is only successful if the version actually moved forward.
    let ok = Boolean(state.installed);
    let error = previous.error || null;
    if (ok && isUpgrade) {
      const target = before[id] && before[id].available;
      if (target && state.version && compareVersions(target, state.version) > 0) {
        ok = false;
        error = error || `Still on ${state.version}; the update to ${target} did not take effect.`;
      }
    }

    return {
      id,
      name: (CATALOG.find((entry) => entry.id === id) || {}).name || id,
      ok,
      upgraded: Boolean(ok && isUpgrade),
      wasMissing: missing.includes(id),
      version: state.version || null,
      latest: verifiedLatest(id),
      location: state.location || null,
      error,
      canceled: Boolean(previous.canceled)
    };
  });

  // Any component that did not verify must be reported as failed — including
  // an upgrade that ran but did not change the installed version.
  for (const entry of verified) {
    if (!entry.ok && !failed.includes(entry.id)) failed.push(entry.id);
  }

  // Version lookups are cached; drop them so the next status read reflects
  // what was just installed.
  clearVersionCaches();

  const done = [...new Set(installed)].filter((id) => !failed.includes(id));
  const message = failed.length
    ? `Some components could not be ${upgradeIds.some((id) => failed.includes(id)) ? 'updated' : 'installed'}: ${failed.join(', ')}`
    : `${done.length ? done.join(', ') : 'Everything requested'} is ready.`;

  return {
    ok: failed.length === 0,
    installed: done,
    skipped: skippedNow,
    failed,
    results,
    verified,
    logPath: installLogPath,
    message
  };
}

/** Forget cached upstream/package versions (used after an install or upgrade). */
function clearVersionCaches() {
  latestCache.clear();
  candidateCache.clear();
}

/** Latest version already resolved during this run, for reporting only. */
function verifiedLatest(id) {
  const cached = latestCache.get(id);
  return cached && cached.value ? cached.value.version : undefined;
}

// ─── Status summary used by the UI ───────────────────────────────────────────

/**
 * Full status for every component: installed?, version, latest known version,
 * and how it would be installed if missing. Runs detection and version lookups
 * in parallel per component so a single slow source cannot stall the panel.
 */
async function getStatus(options = {}) {
  const detected = await detectAll();
  const cacheOptions = options.force ? { force: true } : {};
  const components = await Promise.all(
    CATALOG.map(async (entry) => {
      const state = detected[entry.id] || { installed: false };
      let latest = null;
      let latestError = null;
      try {
        const info = await resolveLatest(entry.id, cacheOptions);
        latest = info.version;
      } catch (error) {
        latestError = error.message;
      }

      let available = latest;
      let availableSource = null;
      try {
        const resolved = await resolveAvailable(entry.id, cacheOptions);
        available = resolved.version || latest;
        availableSource = resolved.source;
      } catch {
        /* keep the upstream version */
      }

      const outdated = Boolean(state.installed && state.version && available && compareVersions(available, state.version) > 0);
      const upstreamNewer = Boolean(available && latest && compareVersions(latest, available) > 0);

      return {
        id: entry.id,
        name: entry.name,
        summary: entry.summary,
        homepage: entry.homepage,
        installed: Boolean(state.installed),
        version: state.version || null,
        latest,
        available,
        availableSource,
        outdated,
        upstreamNewer,
        latestError,
        location: state.location || null,
        source: state.source || null,
        serviceName: state.serviceName || null,
        serviceState: state.serviceState || null,
        managed: Boolean(state.managed)
      };
    })
  );

  const missing = components.filter((component) => !component.installed).map((component) => component.id);
  return {
    platform: platform.PLATFORM,
    components,
    missing,
    missingCount: missing.length,
    allOk: missing.length === 0,
    dataDir: DATA_DIR
  };
}

module.exports = {
  configure,
  getDataDir,
  managedPhpMyAdminDir,
  listCatalog,
  CATALOG_IDS,
  detectDependency,
  detectAll,
  resolveLatest,
  planInstall,
  install,
  getStatus,
  resolveAvailable,
  packageCandidate,
  clearVersionCaches,
  downloadFile,
  extractArchive,
  generateBlowfishSecret,
  writePhpMyAdminConfig,
  compareVersions,
  _internal: {
    detectPhp,
    detectMariaDb,
    detectPhpMyAdmin,
    looksLikePhpMyAdmin,
    readPhpMyAdminVersion,
    buildElevatedScript,
    detectPackageManager,
    installPhpMyAdmin
  }
};
