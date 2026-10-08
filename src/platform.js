/* ═══════════════════════════════════════════════════════════════════════════
   platform.js — Operating-system abstraction layer
   ───────────────────────────────────────────────────────────────────────────
   Everything in this app that used to assume Linux (systemctl, pkexec, lsof,
   `ps -eo`, `/proc`, `ping -W`) is centralised here so the rest of the code
   can stay platform-agnostic. Supports Windows and Linux (plus macOS where
   it is cheap to do so).

   Design rules:
     • Never interpolate untrusted values into a shell string. Commands are
       built as [file, args[]] pairs and executed without a shell whenever
       possible.
     • Every helper degrades gracefully: a missing tool returns a clear
       result instead of throwing.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const PLATFORM = process.platform;
const IS_WINDOWS = PLATFORM === 'win32';
const IS_LINUX = PLATFORM === 'linux';
const IS_MAC = PLATFORM === 'darwin';

const EXE = IS_WINDOWS ? '.exe' : '';

// ─── Command execution ───────────────────────────────────────────────────────

/**
 * Run an executable with an argument array (no shell → no injection).
 * Never rejects; resolves with the outcome.
 */
function run(file, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        windowsHide: true,
        maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
        // timeout 0 means "no timeout" (execFile would otherwise use its default),
        // so it must not fall through to the default value.
        timeout: options.timeout === 0 ? 0 : options.timeout || 60000,
        cwd: options.cwd,
        env: options.env
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            code: typeof error.code === 'number' ? error.code : -1,
            stdout: (stdout || '').toString(),
            stderr: (stderr || '').toString() || error.message || '',
            error: error.message
          });
          return;
        }
        resolve({ ok: true, code: 0, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
      }
    );
    if (child.stdin) child.stdin.end();
  });
}

/** Run a Windows PowerShell snippet and return its stdout (no shell quoting of user data). */
function runPowerShell(script, options = {}) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ];
  return run('powershell.exe', args, options);
}

/** Run an executable through the platform shell (only for fixed, internal commands). */
function runShellCommand(command, options = {}) {
  const file = IS_WINDOWS ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
  const args = IS_WINDOWS ? ['/d', '/s', '/c', command] : ['-c', command];
  return run(file, args, options);
}

// ─── Executable discovery ────────────────────────────────────────────────────

/**
 * Resolve an executable name to an absolute path.
 * Returns the absolute path or null.
 */
async function findExecutable(name) {
  const probe = IS_WINDOWS ? 'where' : 'which';
  const result = await run(probe, [name], { timeout: 8000 });
  if (result.ok && result.stdout.trim()) {
    const first = result.stdout.trim().split(/\r?\n/)[0].trim();
    if (first) return first;
  }

  // Manual fallback for the few tools we depend on.
  for (const candidate of executableFallbackDirs(name)) {
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

function executableFallbackDirs(name) {
  const base = name.replace(new RegExp(`${EXE.replace('.', '\\.')}$`), '');
  const dirs = [];
  if (IS_WINDOWS) {
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.ProgramData,
      process.env.LOCALAPPDATA,
      process.env.APPDATA,
      process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : null
    ].filter(Boolean);
    for (const root of roots) {
      dirs.push(path.join(root, `${base}.exe`));
    }
    dirs.push(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', `${base}.exe`));
  } else {
    for (const dir of ['/usr/bin', '/usr/local/bin', '/bin', '/usr/sbin', '/usr/local/sbin', '/opt/homebrew/bin']) {
      dirs.push(path.join(dir, base));
    }
  }
  return dirs;
}

async function commandExists(name) {
  return Boolean(await findExecutable(name));
}

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ─── Elevation ───────────────────────────────────────────────────────────────

/** Which privilege-escalation mechanism is usable on this machine. */
async function detectElevationTool() {
  if (IS_WINDOWS) {
    return { tool: 'runas', available: true, label: 'Windows UAC (Run as administrator)' };
  }
  if (IS_MAC) {
    const osascript = await findExecutable('osascript');
    return osascript
      ? { tool: 'osascript', available: true, label: 'macOS administrator prompt' }
      : { tool: null, available: false, label: 'osascript not found' };
  }
  // Linux / BSD — prefer polkit (graphical prompt), fall back to kdesudo/beesu, then none.
  for (const candidate of ['pkexec', 'beesu', 'kdesudo']) {
    const found = await findExecutable(candidate);
    if (found) {
      return { tool: candidate, available: true, label: `${candidate} privilege prompt` };
    }
  }
  return { tool: null, available: false, label: 'No graphical privilege prompt found (install polkit/pkexec)' };
}

/** True when the current process already has administrator privileges. */
function isElevated() {
  if (IS_WINDOWS) {
    try {
      return runPowerShellSync(
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
      ).toLowerCase().includes('true');
    } catch {
      return false;
    }
  }
  try {
    // geteuid is only defined on POSIX.
    return typeof process.geteuid === 'function' ? process.geteuid() === 0 : false;
  } catch {
    return false;
  }
}

function runPowerShellSync(script) {
  const { execFileSync } = require('child_process');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

/**
 * Run a script file with administrator privileges.
 * A single script file is used on purpose: the OS shows one consent dialog
 * for the whole batch instead of one per command.
 *
 * @returns {Promise<{ok:boolean, canceled:boolean, stderr:string, tool:string|null}>}
 */
async function runElevatedScript(scriptPath, options = {}) {
  const elevation = await detectElevationTool();
  const verbose = Boolean(options.verbose);

  if (!elevation.available) {
    return {
      ok: false,
      canceled: false,
      tool: null,
      stderr:
        `No graphical privilege prompt is available (${elevation.label}). ` +
        'Run the generated script manually with administrator rights.'
    };
  }

  if (IS_WINDOWS) {
    const ps = [
      '$p = Start-Process',
      `-FilePath 'powershell.exe'`,
      `-ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${psQuote(scriptPath)})`,
      '-Verb RunAs -Wait -PassThru;',
      'exit $p.ExitCode'
    ].join(' ');

    const result = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      ps
    ], { timeout: 0, maxBuffer: 16 * 1024 * 1024 });

    const canceled = /The operation was canceled by the user|The user canceled/i.test(`${result.stderr} ${result.stdout}`);
    return {
      ok: result.ok && result.code === 0,
      canceled,
      tool: 'runas',
      stdout: verbose ? result.stdout : '',
      stderr: canceled ? 'Elevation prompt was dismissed.' : result.stderr
    };
  }

  if (IS_MAC) {
    const result = await run('osascript', [
      '-e',
      `do shell script "/bin/bash ${scriptPath.replace(/"/g, '\\"')}" with administrator privileges`
    ], { timeout: 0, maxBuffer: 16 * 1024 * 1024 });
    const canceled = /User canceled|-128/.test(`${result.stderr} ${result.stdout}`);
    return { ok: result.ok, canceled, tool: 'osascript', stdout: verbose ? result.stdout : '', stderr: result.stderr };
  }

  // Linux / BSD: hand the script to a fixed, root-owned shell instead of
  // executing the user-writable script directly — polkit only inspects the
  // program it is asked to run, and /bin/bash is trusted.
  const result = await run(elevation.tool, ['/bin/bash', scriptPath], { timeout: 0, maxBuffer: 16 * 1024 * 1024 });
  const canceled = /dismissed|Not authorized|cancell?ed|126/i.test(`${result.stderr} ${result.stdout}`);
  return {
    ok: result.ok && result.code === 0,
    canceled,
    tool: elevation.tool,
    stdout: verbose ? result.stdout : '',
    stderr: canceled ? 'Elevation prompt was dismissed.' : result.stderr
  };
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Write a batch of privileged work into a single script file, so the user sees
 * one consent prompt and one OS privilege dialog.
 *
 * @param {string[]} lines   platform-native command lines (bash / PowerShell)
 * @param {object}   options { scriptDir, name }
 * @returns {{scriptPath:string, logPath:string, preview:string[]}}
 */
function withElevation(lines, options = {}) {
  const scriptDir = options.scriptDir || os.tmpdir();
  fs.mkdirSync(scriptDir, { recursive: true });
  const name = options.name || 'install';
  const logPath = path.join(scriptDir, `${name}.log`);

  if (IS_WINDOWS) {
    const body = [
      '$ErrorActionPreference = "Continue"',
      `Start-Transcript -Path '${logPath.replace(/'/g, "''")}' -Force | Out-Null`,
      ...lines,
      'Stop-Transcript | Out-Null'
    ];
    const scriptPath = path.join(scriptDir, `${name}.ps1`);
    fs.writeFileSync(scriptPath, `${body.join('\r\n')}\r\n`, 'utf8');
    return { scriptPath, logPath, preview: body };
  }

  const body = [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    `exec > >(tee -a "${logPath}") 2>&1`,
    ...lines,
    'echo "Done."'
  ];
  const scriptPath = path.join(scriptDir, `${name}.sh`);
  fs.writeFileSync(scriptPath, `${body.join('\n')}\n`, { encoding: 'utf8', mode: 0o755 });
  return { scriptPath, logPath, preview: body };
}

/** Run a fixed (non-user-supplied) command line with the privileges we already have. */
function runSystemCommand(line) {
  return runShellCommand(line, { timeout: 0, maxBuffer: 16 * 1024 * 1024 });
}

/**
 * Write `lines` to a script and run it with administrator privileges.
 * @returns {Promise<{ok:boolean, canceled:boolean, scriptPath:string, logPath:string, preview:string[], stderr:string, log:string}>}
 */
async function runElevated(lines, options = {}) {
  const script = withElevation(lines, options);
  const outcome = await runElevatedScript(script.scriptPath, { verbose: true });
  let log = '';
  try {
    log = fs.readFileSync(script.logPath, 'utf8');
  } catch {
    /* log may not exist when the dialog was dismissed */
  }
  return { ...outcome, ...script, log };
}

/** Copy-pasteable command a user can run themselves if no prompt is available. */
function manualElevationHint(scriptPath) {
  if (IS_WINDOWS) {
    return `Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy','Bypass','-File','${scriptPath}'`;
  }
  return `sudo /bin/bash "${scriptPath}"`;
}

// ─── Services ────────────────────────────────────────────────────────────────

/**
 * Candidate service names per logical component. The first one that exists
 * wins, which removes the old Fedora-only "httpd"/"mariadb" hard-coding.
 */
const SERVICE_CANDIDATES = {
  httpd: IS_WINDOWS ? ['Apache2.4', 'Apache2.2', 'httpd', 'Apache'] : ['httpd', 'apache2', 'apache'],
  mariadb: IS_WINDOWS ? ['MariaDB', 'MySQL', 'mysql', 'mariadb'] : ['mariadb', 'mysql', 'mysqld']
};

const serviceNameCache = new Map();

/** Returns the real service name for a component, or null when not installed as a service. */
async function detectServiceName(kind) {
  const candidates = SERVICE_CANDIDATES[kind];
  if (!candidates) return null;
  if (serviceNameCache.has(kind)) return serviceNameCache.get(kind);

  let found = null;
  if (IS_WINDOWS) {
    const script = `(Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @(${candidates
      .map((c) => `'${c}'`)
      .join(',')}) } | Select-Object -ExpandProperty Name) -join ','`;
    const result = await runPowerShell(script, { timeout: 20000 });
    if (result.ok) {
      const names = result.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(',')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      found = candidates.find((c) => names.some((n) => n.toLowerCase() === c.toLowerCase())) || names[0] || null;
    }
  } else {
    for (const candidate of candidates) {
      const unit = await run('systemctl', ['list-unit-files', `${candidate}.service`, '--no-legend'], { timeout: 15000 });
      if (unit.ok && unit.stdout.trim()) {
        found = candidate;
        break;
      }
    }
  }

  serviceNameCache.set(kind, found);
  return found;
}

/** Forget cached service names — call after installing something that registers a service. */
function resetServiceCache() {
  serviceNameCache.clear();
}

/**
 * Runtime state of a component's service.
 * @returns {Promise<'active'|'inactive'|'not-installed'|'unknown'>}
 */
async function getServiceState(kind) {
  const name = await detectServiceName(kind);
  if (!name) return 'not-installed';

  if (IS_WINDOWS) {
    const result = await runPowerShell(
      `$s = Get-Service -Name '${name}' -ErrorAction SilentlyContinue; if ($s) { $s.Status } else { 'NOT_FOUND' }`,
      { timeout: 20000 }
    );
    const value = (result.stdout || '').trim().toLowerCase();
    if (value === 'running') return 'active';
    if (value === 'stopped') return 'inactive';
    if (value === 'not_found') return 'not-installed';
    return 'unknown';
  }

  const result = await run('systemctl', ['is-active', name], { timeout: 15000 });
  const value = (result.stdout || '').trim().split('\n')[0].toLowerCase();
  if (value === 'active') return 'active';
  if (value === 'inactive' || value === 'failed' || value === 'deactivating') return 'inactive';
  if (result.stderr && /not-found|No such file|could not be found/i.test(result.stderr)) return 'not-installed';
  return 'unknown';
}

/**
 * Shell line that starts/stops/restarts a component's service.
 * Returns null when the component is not registered as a service.
 */
async function serviceControlLine(kind, action) {
  const allowedActions = ['start', 'stop', 'restart'];
  if (!allowedActions.includes(action)) return null;
  const name = await detectServiceName(kind);
  if (!name) return null;

  if (IS_WINDOWS) {
    const verb = { start: 'Start-Service', stop: 'Stop-Service', restart: 'Restart-Service' }[action];
    return `${verb} -Name '${name}'`;
  }
  return `systemctl ${action} ${name}`;
}

/** Human-readable service name for display. */
async function describeService(kind) {
  const name = await detectServiceName(kind);
  return name || (kind === 'httpd' ? 'Apache' : 'MariaDB');
}

// ─── Processes & ports ───────────────────────────────────────────────────────

/**
 * PIDs listening on a TCP port.
 * Linux/macOS: lsof then ss. Windows: netstat -ano.
 */
async function getListeningPids(port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort)) return [];

  if (IS_WINDOWS) {
    const result = await run('netstat.exe', ['-ano', '-p', 'TCP'], { timeout: 20000 });
    if (!result.ok) return [];
    const pids = new Set();
    for (const line of result.stdout.split(/\r?\n/)) {
      // Proto  Local Address          Foreign Address        State        PID
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const local = parts[1];
      const state = parts[3];
      if (state !== 'LISTENING') continue;
      const localPort = local.slice(local.lastIndexOf(':') + 1);
      if (Number(localPort) === numericPort) {
        const pid = Number(parts[4]);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
    }
    return [...pids];
  }

  const lsof = await run('lsof', ['-iTCP:' + numericPort, '-sTCP:LISTEN', '-P', '-n', '-t'], { timeout: 15000 });
  if (lsof.ok && lsof.stdout.trim()) {
    return [...new Set(lsof.stdout.trim().split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  }

  const ss = await runShellCommand(`ss -ltnp 2>/dev/null | grep ':${numericPort}' || true`, { timeout: 15000 });
  if (ss.stdout && ss.stdout.trim()) {
    const pids = new Set();
    const re = /pid=(\d+)/g;
    let match;
    while ((match = re.exec(ss.stdout)) !== null) pids.add(Number(match[1]));
    return [...pids];
  }
  return [];
}

/** Command-line string for a PID (used to avoid killing unrelated processes). */
async function getProcessCommandLine(pid) {
  if (IS_WINDOWS) {
    const result = await runPowerShell(
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}' -ErrorAction SilentlyContinue; ` +
        `if ($p) { $p.CommandLine } else { '' }`,
      { timeout: 15000 }
    );
    return result.ok ? result.stdout.trim() : '';
  }
  try {
    // NUL-separated argv is more reliable than `ps` output for truncated commands.
    const raw = fs.readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf8');
    return raw.replace(/\0/g, ' ').trim();
  } catch {
    const result = await run('ps', ['-p', String(Number(pid)), '-o', 'command='], { timeout: 10000 });
    return result.ok ? result.stdout.trim() : '';
  }
}

/** Terminate PIDs (best effort). */
async function killPids(pids) {
  const list = (pids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) return true;
  if (IS_WINDOWS) {
    const result = await runPowerShell(
      `$ids = @(${list.join(',')}); foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }; 'done'`,
      { timeout: 20000 }
    );
    return result.ok;
  }
  const result = await run('kill', ['-TERM', ...list.map(String)], { timeout: 15000 });
  return result.ok;
}

// ─── Resource usage ──────────────────────────────────────────────────────────

/**
 * Per-process CPU/memory for the given process names.
 * @returns {Promise<Array<{pid:number, command:string, cpu:number, mem:number, rss:number, fullCommand:string}>>}
 */
async function getProcessUsage(targetNames, limit = 12) {
  if (IS_WINDOWS) {
    const script = [
      "$procs = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue",
      "if (-not $procs) { '[]'; exit 0 }",
      '$total = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory',
      "$data = $procs | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | ForEach-Object {",
      '  [pscustomobject]@{',
      '    pid = [int]$_.IDProcess;',
      '    name = $_.Name;',
      '    cpu = [double]$_.PercentProcessorTime;',
      '    mem = if ($total -gt 0) { [math]::Round(([double]$_.WorkingSetPrivate / $total) * 100, 2) } else { 0 };',
      '    rss = [long]$_.WorkingSetPrivate;',
      '    cmd = (Get-Process -Id $_.IDProcess -ErrorAction SilentlyContinue).Path',
      '  }',
      '} | Sort-Object cpu -Descending | Select-Object -First 120;',
      '$data | ConvertTo-Json -Compress'
    ].join('; ');

    const result = await runPowerShell(script, { timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    if (!result.ok) return [];
    let rows;
    try {
      rows = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim() || '[]');
    } catch {
      return [];
    }
    if (!Array.isArray(rows)) rows = [rows];

    return rows
      .filter((row) => row && matchesTarget(String(row.name || ''), String(row.cmd || ''), targetNames))
      .slice(0, limit)
      .map((row) => ({
        pid: Number(row.pid) || 0,
        command: row.name || '',
        cpu: Number(row.cpu) || 0,
        mem: Number(row.mem) || 0,
        rss: Number(row.rss) || 0,
        fullCommand: row.cmd || row.name || ''
      }));
  }

  // POSIX: -o with an explicit column list works on both Linux and BSD/macOS.
  const result = await run('ps', ['-Ao', 'pid,comm,%cpu,%mem,rss,command'], { timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
  if (!result.ok || !result.stdout.trim()) return [];

  const rows = [];
  for (const line of result.stdout.trim().split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const pid = Number(parts[0]);
    const command = parts[1];
    const cpu = Number(parts[2]) || 0;
    const mem = Number(parts[3]) || 0;
    const rss = (Number(parts[4]) || 0) * 1024;
    const fullCommand = parts.slice(5).join(' ');
    if (!matchesTarget(command, fullCommand, targetNames)) continue;
    rows.push({ pid, command, cpu, mem, rss, fullCommand });
  }
  rows.sort((a, b) => b.cpu - a.cpu);
  return rows.slice(0, limit);
}

function matchesTarget(command, fullCommand, targetNames) {
  const haystack = `${command} ${fullCommand}`.toLowerCase();
  return (targetNames || []).some((name) => haystack.includes(name.toLowerCase()));
}

// ─── Network discovery ───────────────────────────────────────────────────────

/** Local IPv4 subnet (first three octets) derived from the default gateway. */
async function getLocalSubnet() {
  if (IS_WINDOWS) {
    const result = await runPowerShell(
      "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty NextHop)",
      { timeout: 20000 }
    );
    return subnetFromIp(result.stdout.trim());
  }

  if (IS_MAC) {
    const result = await run('route', ['-n', 'get', 'default'], { timeout: 15000 });
    const match = result.stdout.match(/gateway:\s*(\d+\.\d+\.\d+\.\d+)/);
    return subnetFromIp(match ? match[1] : '');
  }

  const result = await run('ip', ['route', 'show', 'default'], { timeout: 15000 });
  const match = result.stdout.match(/via\s+(\d+\.\d+\.\d+\.\d+)/);
  if (match) return subnetFromIp(match[1]);

  const fallback = await run('route', ['-n'], { timeout: 15000 });
  const fallbackMatch = fallback.stdout.match(/\d+\.\d+\.\d+\.\d+/) || null;
  return subnetFromIp(fallbackMatch ? fallbackMatch[0] : '');
}

function subnetFromIp(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return '192.168.1';
  return parts.slice(0, 3).join('.');
}

/** Single ICMP echo with a bounded timeout (≈1s on every platform). */
async function pingHost(ip) {
  const args = IS_WINDOWS ? ['-n', '1', '-w', '1000', ip] : IS_MAC ? ['-c', '1', '-W', '1000', ip] : ['-c', '1', '-W', '1', ip];
  const result = await run('ping', args, { timeout: 4000 });
  return result.ok;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const HOME = os.homedir();

function binaryName(base) {
  return `${base}${EXE}`;
}

module.exports = {
  PLATFORM,
  IS_WINDOWS,
  IS_LINUX,
  IS_MAC,
  HOME,
  EXE,
  binaryName,
  run,
  runShellCommand,
  runPowerShell,
  fileExists,
  findExecutable,
  commandExists,
  detectElevationTool,
  isElevated,
  runElevatedScript,
  manualElevationHint,
  withElevation,
  runElevated,
  runSystemCommand,
  detectServiceName,
  resetServiceCache,
  getServiceState,
  serviceControlLine,
  describeService,
  psQuote,
  getListeningPids,
  getProcessCommandLine,
  killPids,
  getProcessUsage,
  getLocalSubnet,
  pingHost
};
