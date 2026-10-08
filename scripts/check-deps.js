#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   scripts/check-deps.js — verify (and optionally install) PHP, MariaDB
   and phpMyAdmin.

   Usage
     node scripts/check-deps.js                 # report only
     node scripts/check-deps.js --install       # install whatever is missing
     node scripts/check-deps.js --only php      # limit to one component
     node scripts/check-deps.js --json          # machine-readable output
     node scripts/check-deps.js --yes           # skip the confirmation prompt

   Exit codes
     0  everything requested is present (or was installed successfully)
     1  something is missing and --install was not requested
     2  an installation attempt failed
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const os = require('os');
const path = require('path');
const readline = require('readline');

const dependencies = require('../src/dependencies');
const platform = require('../src/platform');

// ─── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { install: false, json: false, yes: false, only: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--install' || arg === '--fix') options.install = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--only') {
      options.only = String(argv[i + 1] || '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      i += 1;
    } else if (arg.startsWith('--only=')) {
      options.only = arg
        .slice('--only='.length)
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    }
  }
  return options;
}

const HELP = `LAMP Control Panel — dependency checker

Usage:
  node scripts/check-deps.js [options]

Options:
  --install, --fix   Install any component that is missing
  --only <list>      Comma-separated components (php, mariadb, phpmyadmin)
  --json             Print the status as JSON
  --yes, -y          Do not ask for confirmation before installing
  --help, -h         Show this help

Exit codes:
  0  everything requested is present (or was installed)
  1  something is missing and --install was not given
  2  an installation attempt failed
`;

// ─── App data directory (mirrors Electron's app.getPath('appData')) ──────────

function appDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'lamp-control-panel');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'lamp-control-panel');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'lamp-control-panel');
}

// ─── Output helpers ──────────────────────────────────────────────────────────

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (text) => paint('32', text);
const red = (text) => paint('31', text);
const yellow = (text) => paint('33', text);
const dim = (text) => paint('2', text);
const bold = (text) => paint('1', text);

function statusIcon(component) {
  if (!component.installed) return red('✗');
  if (component.outdated) return yellow('↑');
  return green('✓');
}

function describe(component) {
  if (!component.installed) return red('missing');
  const parts = [component.version ? `v${component.version}` : 'installed'];
  if (component.outdated && component.available) parts.push(yellow(`update to v${component.available} available`));
  else if (component.upstreamNewer && component.latest) parts.push(dim(`latest upstream: v${component.latest}`));
  return parts.join(dim(' · '));
}

function printReport(status) {
  console.log('');
  console.log(bold('LAMP stack check') + dim(`  (${status.platform}, data: ${status.dataDir})`));
  console.log(dim('─'.repeat(64)));
  for (const component of status.components) {
    const name = component.name.padEnd(12);
    const location = component.location ? dim(component.location) : '';
    console.log(`${statusIcon(component)} ${bold(name)} ${describe(component)}  ${location}`);
  }
  console.log(dim('─'.repeat(64)));
  if (status.allOk) {
    console.log(green(`All ${status.components.length} components are installed.`));
  } else {
    console.log(yellow(`Missing: ${status.missing.join(', ')}`));
  }
  console.log('');
}

// ─── Consent prompt ──────────────────────────────────────────────────────────

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  dependencies.configure({
    dataDir: appDataDir(),
    log: (message) => {
      if (!options.json) console.log(dim(`  ${message}`));
    }
  });

  const status = await dependencies.getStatus();

  if (options.only) {
    const unknown = options.only.filter((id) => !dependencies.CATALOG_IDS.includes(id));
    if (unknown.length) {
      console.error(red(`Unknown component(s): ${unknown.join(', ')}`));
      return 2;
    }
    const wanted = new Set(options.only);
    status.components = status.components.filter((component) => wanted.has(component.id));
    status.missing = status.components.filter((component) => !component.installed).map((component) => component.id);
    status.allOk = status.missing.length === 0;
  }

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    printReport(status);
  }

  if (!options.install) {
    return status.allOk ? 0 : 1;
  }

  if (status.missing.length === 0) {
    if (!options.json) console.log(green('Nothing to install.'));
    return 0;
  }

  if (!options.json) {
    console.log(`Will install: ${bold(status.missing.join(', '))}`);
    const plan = await dependencies.planInstall(status.missing);
    for (const item of plan.items) {
      console.log(`  • ${bold(item.name)} — ${item.detail}`);
    }
    if (plan.needsElevation) {
      console.log(
        yellow(
          `  Administrator rights are required (${plan.elevation.tool || 'no graphical prompt found'}); ` +
            'you will be asked to approve one script that performs every step.'
        )
      );
    }
    console.log('');
  }

  if (!options.yes && process.stdin.isTTY) {
    const approved = await ask('Proceed? [y/N] ');
    if (!approved) {
      console.log('Canceled.');
      return 2;
    }
  }

  const result = await dependencies.install(status.missing, {
    onProgress: (event) => {
      if (options.json || !event.message) return;
      if (event.phase === 'Downloading' || event.phase === 'download') console.log(dim(`  ${event.message}`));
      else if (event.phase === 'consent') console.log(yellow(`  ${event.message}`));
      else console.log(dim(`  ${event.message}`));
    },
    onConsent: async (request) => {
      if (options.yes || !process.stdin.isTTY) return true;
      console.log('');
      console.log(bold('Administrator approval is required for:'));
      for (const item of request.items) console.log(`  • ${item.name} — ${item.detail}`);
      console.log(dim(`\nScript: ${request.scriptPath}`));
      console.log(dim(`Log:    ${request.scriptPath.replace(/\.[^.]+$/, '')}.log`));
      console.log(dim('\nIt will:'));
      for (const line of request.preview.slice(0, 20)) console.log(dim(`  ${line}`));
      if (!request.elevation.available) {
        console.log(yellow('\nNo graphical privilege prompt is available. Run this yourself:'));
        console.log(bold(`  ${request.manualCommand}`));
      }
      return ask('\nAllow these changes? [y/N] ');
    }
  });

  if (!options.json) {
    console.log('');
    for (const entry of result.verified) {
      const label = `${entry.name}`.padEnd(12);
      if (entry.ok) {
        console.log(`${green('✓')} ${bold(label)} ${entry.version ? `v${entry.version}` : 'installed'}`);
      } else {
        console.log(`${red('✗')} ${bold(label)} ${red(entry.error || 'still missing')}`);
      }
    }
    if (result.logPath) console.log(dim(`\nInstall log: ${result.logPath}`));
    console.log(result.ok ? green(`\n${result.message}`) : red(`\n${result.message}`));
    if (result.installed.includes('php') && !platform.IS_WINDOWS) {
      console.log(dim('PHP was installed through your package manager; open a new terminal for PATH changes.'));
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  return result.ok ? 0 : 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(red(`check-deps failed: ${error.message}`));
    process.exitCode = 2;
  });
