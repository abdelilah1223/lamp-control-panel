/* ═══════════════════════════════════════════════════════════════════════════
   LAMP Control Panel — Renderer Logic
   ═══════════════════════════════════════════════════════════════════════════ */

const statusMap = {
  active: { label: 'Running', css: 'is-active' },
  running: { label: 'Running', css: 'is-active' },
  inactive: { label: 'Stopped', css: 'is-inactive' },
  stopped: { label: 'Stopped', css: 'is-inactive' },
  'not-installed': { label: 'Not installed', css: 'is-inactive' },
  unknown: { label: 'Unknown', css: 'is-unknown' }
};

const escapeHtml = (value) =>
  String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);

const formatBytes = (bytes = 0) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

// ─── Status refresh ──────────────────────────────────────────────────────────

const updateServerCard = (cardSelector, indicatorId, statusId, stateKey) => {
  const info = statusMap[stateKey] || statusMap.unknown;
  const card = document.querySelector(cardSelector);
  const indicator = document.getElementById(indicatorId);
  const statusEl = document.getElementById(statusId);

  if (statusEl) {
    statusEl.textContent = info.label;
  }

  if (indicator) {
    indicator.className = 'status-indicator ' + info.css;
  }

  if (card) {
    // Remove old state classes
    card.classList.remove('is-active', 'is-inactive');
    if (stateKey === 'active' || stateKey === 'running') {
      card.classList.add('is-active');
    } else if (stateKey === 'inactive' || stateKey === 'stopped' || stateKey === 'not-installed') {
      card.classList.add('is-inactive');
    }
  }
};

const refreshStatus = async () => {
  const status = await window.lampControl.getSystemStatus();

  updateServerCard('[data-server="httpd"]', 'apacheIndicator', 'apacheStatus', status.httpd);
  updateServerCard('[data-server="mariadb"]', 'mariadbIndicator', 'mariadbStatus', status.mariadb);

  const phpBox = document.getElementById('phpUrlBox');
  if (phpBox) {
    phpBox.textContent = status.phpUrl || 'http://localhost:8000';
  }

  // Update QR code with the network URL (for phones/other devices)
  try {
    updatePhpQr(status.networkUrl || status.phpUrl);
  } catch (err) {
    // ignore if QR block not present
  }
};

// Generate or update the QR image for a given URL (uses api.qrserver.com)
const updatePhpQr = (url) => {
  const img = document.getElementById('phpQrImg');
  if (!img || !url) return;
  const api = 'https://api.qrserver.com/v1/create-qr-code/';
  const size = '200x200';
  img.src = `${api}?size=${size}&data=${encodeURIComponent(url)}`;
  img.alt = `QR code for ${url}`;
};

// ─── Service actions ─────────────────────────────────────────────────────────

const handleBulkAction = async (action) => {
  const result = await window.lampControl.serviceAction(action);
  if (result && !result.ok) {
    alert(result.error || 'Action failed. Make sure the app can manage system services.');
  }

  await refreshStatus();
};

const handleSingleServiceAction = async (service, action) => {
  const result = await window.lampControl.serviceActionSingle(service, action);
  if (result && !result.ok) {
    alert(result.error || `Failed to ${action} ${service}.`);
  }

  // Flash animation on the card
  const card = document.querySelector(`[data-server="${service}"]`);
  if (card) {
    card.classList.remove('just-activated', 'just-deactivated');
    void card.offsetWidth; // force reflow
    card.classList.add(action === 'start' ? 'just-activated' : 'just-deactivated');
    setTimeout(() => card.classList.remove('just-activated', 'just-deactivated'), 800);
  }

  await refreshStatus();
};

// ─── PHP server ──────────────────────────────────────────────────────────────

const startPhpServer = async (folderArg) => {
  const folderInput = document.getElementById('phpFolder');
  const folder = (folderArg && folderArg.trim()) || (folderInput && folderInput.value.trim());
  if (!folder) {
    alert('Please select a folder for your PHP scripts first.');
    return;
  }

  // Ensure the input shows the folder we're starting
  if (folderInput) folderInput.value = folder;

  const result = await window.lampControl.startPhpServer(folder);

  if (!result.ok) {
    alert(result.error || 'Unable to start PHP server.');
    return;
  }

  if (result.started || result.alreadyRunning) {
    // phpUrlBox shows localhost URL (for the Open button on this machine)
    document.getElementById('phpUrlBox').textContent = result.url;
    // QR shows network URL (for phones/other devices)
    try { updatePhpQr(result.networkUrl || result.url); } catch (e) {}
  }

  await refreshStatus();
};

const stopPhpServer = async () => {
  const result = await window.lampControl.stopPhpServer();
  if (result && result.ok) {
    await refreshStatus();
  }
};

const chooseFolder = async () => {
  const folder = await window.lampControl.chooseFolder();
  if (folder) {
    document.getElementById('phpFolder').value = folder;
    await window.lampControl.addRecentProject(folder);
    await refreshRecentProjects();
    // Stop existing PHP server (if any) and start the newly chosen project
    try { await window.lampControl.stopPhpServer(); } catch (e) { /* ignore */ }
    await startPhpServer(folder);
  }
};

// ─── QR panel (replaces network scan) ───────────────────────────────────────

const updateNetworkQr = (url) => {
  const img = document.getElementById('networkQrImg');
  const urlEl = document.getElementById('networkQrUrl');
  if (!urlEl) return;
  const finalUrl = url || (document.getElementById('phpUrlBox') && document.getElementById('phpUrlBox').textContent) || 'http://127.0.0.1:8000';
  urlEl.textContent = finalUrl;
  if (!img) return;
  const api = 'https://api.qrserver.com/v1/create-qr-code/';
  const size = '600x600';
  img.src = `${api}?size=${size}&margin=1&data=${encodeURIComponent(finalUrl)}`;
  img.alt = `QR code for ${finalUrl}`;
};

const refreshNetworkQr = async () => {
  try {
    const status = await window.lampControl.getSystemStatus();
    // Use networkUrl for QR so other devices (phones) can scan it
    const url = status.networkUrl || status.phpUrl || 'http://127.0.0.1:8000';
    updateNetworkQr(url);
  } catch (err) {
    updateNetworkQr();
  }
};

const copyNetworkUrl = async () => {
  const urlEl = document.getElementById('networkQrUrl');
  if (!urlEl) return;
  const text = urlEl.textContent.trim();
  try {
    await navigator.clipboard.writeText(text);
    // small feedback
    const btn = document.getElementById('copyQrUrl');
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => btn.textContent = old, 1200);
  } catch (e) {
    alert('Unable to copy to clipboard.');
  }
};

const downloadNetworkQr = () => {
  const img = document.getElementById('networkQrImg');
  if (!img || !img.src) return;
  const a = document.createElement('a');
  a.href = img.src;
  a.download = 'lamp-qr.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
};

// ─── Recent projects ─────────────────────────────────────────────────────────

const refreshRecentProjects = async () => {
  const projects = await window.lampControl.getRecentProjects();
  const container = document.getElementById('recentProjects');

  if (!projects.length) {
    container.className = 'list-box empty';
    container.textContent = 'No recent projects yet.';
    return;
  }

  container.className = 'list-box';
  container.innerHTML = projects.map((project) => {
    const projectPath = project.path || project;
    const safePath = escapeHtml(projectPath);
    return `
    <div class="project-item">
      <strong title="${safePath}">${safePath}</strong>
      <button class="small-btn secondary" data-open-project="${safePath}">Open</button>
    </div>
  `;
  }).join('');

  container.querySelectorAll('[data-open-project]').forEach((button) => {
    button.addEventListener('click', async () => {
      const projectPath = button.getAttribute('data-open-project');
      document.getElementById('phpFolder').value = projectPath;

      // Save the path
      const settings = await window.lampControl.getSettings();
      settings.lastPhpPath = projectPath;
      await window.lampControl.saveSettings(settings);

      // Stop any running PHP server first so the new project can bind to the port
      try { await window.lampControl.stopPhpServer(); } catch (e) { /* ignore */ }

      // Start the selected project using our local helper so UI (URL + QR) updates correctly
      await startPhpServer(projectPath);
      await refreshStatus();
    });
  });
};

// ─── Resource usage ──────────────────────────────────────────────────────────

const refreshResources = async () => {
  const rows = await window.lampControl.getResourceUsage();
  const graphContainer = document.getElementById('resourceGraph');

  if (!rows || !rows.length) {
    graphContainer.innerHTML = '<div class="graph-loading">No PHP or LAMP processes currently detected.</div>';
    return;
  }

  // Aggregate metrics
  const grouped = {};
  rows.forEach(row => {
    // Normalize names (e.g. php-fpm to php, mysqld to mariadb)
    let name = row.command;
    if (name.includes('php')) name = 'PHP';
    else if (name.includes('httpd') || name.includes('apache')) name = 'Apache';
    else if (name.includes('mysql') || name.includes('mariadb')) name = 'MariaDB';
    
    if (!grouped[name]) grouped[name] = { cpu: 0, mem: 0, rss: 0 };
    grouped[name].cpu += row.cpu;
    grouped[name].mem += row.mem;
    grouped[name].rss += row.rss;
  });

  const maxCpu = Math.max(...Object.values(grouped).map(g => g.cpu), 10);
  const maxMem = Math.max(...Object.values(grouped).map(g => g.mem), 10);

  let html = '<div class="graph-flex-container">';
  Object.keys(grouped).forEach(name => {
    const stats = grouped[name];
    const cpuWidth = Math.min((stats.cpu / maxCpu) * 100, 100);
    const memWidth = Math.min((stats.mem / maxMem) * 100, 100);

    html += `
      <div class="graph-group">
        <h3 class="graph-label">${name} <span>(RSS: ${formatBytes(stats.rss)})</span></h3>
        <div class="graph-bar-row">
          <span class="bar-title">CPU</span>
          <div class="bar-track">
            <div class="bar-fill bar-cpu" style="width: ${cpuWidth}%"></div>
          </div>
          <span class="bar-value">${stats.cpu.toFixed(1)}%</span>
        </div>
        <div class="graph-bar-row">
          <span class="bar-title">Mem</span>
          <div class="bar-track">
            <div class="bar-fill bar-mem" style="width: ${memWidth}%"></div>
          </div>
          <span class="bar-value">${stats.mem.toFixed(1)}%</span>
        </div>
      </div>
    `;
  });
  html += '</div>';

  graphContainer.innerHTML = html;
};

// ─── Stack setup ─────────────────────────────────────────────────────────────

let stackStatus = null;
let stackInstalling = false;

const STACK_GLYPH = { ok: '✓', update: '↑', missing: '✕' };

const stackCardState = (component) => {
  if (!component.installed) return 'missing';
  if (component.outdated) return 'update';
  return 'ok';
};

const stackHint = (component) => {
  if (!component.installed) {
    return component.latest ? `Not installed. Latest release: ${component.latest}.` : 'Not installed.';
  }
  if (component.outdated) {
    return `Update available: ${component.available} (you have ${component.version}).`;
  }
  if (component.upstreamNewer && component.latest) {
    return `Up to date for this system. Newest release upstream: ${component.latest}.`;
  }
  return 'Up to date.';
};

const renderStack = (status) => {
  stackStatus = status;
  const grid = document.getElementById('stackGrid');
  const verdict = document.getElementById('stackVerdict');
  const button = document.getElementById('installStack');
  const label = document.getElementById('installStackLabel');
  if (!grid || !status || !Array.isArray(status.components)) return;

  grid.innerHTML = status.components.map((component) => {
    const state = stackCardState(component);
    const action =
      state === 'missing'
        ? `<button class="stack-card-action is-primary" data-install-component="${escapeHtml(component.id)}">Install</button>`
        : state === 'update'
        ? `<button class="stack-card-action" data-install-component="${escapeHtml(component.id)}">Update</button>`
        : '';
    return `
      <article class="stack-card is-${state}">
        <div class="stack-card-head">
          <span class="stack-card-name"><span class="stack-state-glyph">${STACK_GLYPH[state]}</span>${escapeHtml(component.name)}</span>
          ${component.version ? `<span class="stack-version">v${escapeHtml(component.version)}</span>` : ''}
        </div>
        <div class="stack-path" title="${escapeHtml(component.location || '')}">${escapeHtml(component.location || 'not found on this system')}</div>
        <div class="stack-hint is-${state}">${escapeHtml(stackHint(component))}</div>
        ${action}
      </article>`;
  }).join('');

  const missing = status.components.filter((component) => !component.installed);
  const outdated = status.components.filter((component) => component.installed && component.outdated);

  if (!missing.length) {
    verdict.textContent = outdated.length
      ? `All ${status.components.length} components are installed. ${outdated.length} update${outdated.length > 1 ? 's' : ''} available.`
      : `All ${status.components.length} components are installed and up to date.`;
  } else {
    verdict.textContent = `${missing.length} of ${status.components.length} components ${missing.length > 1 ? 'are' : 'is'} missing: ${missing
      .map((component) => component.name)
      .join(', ')}. Installing now downloads the latest release and registers it for your user.`;
  }

  if (button) button.disabled = stackInstalling || missing.length === 0;
  if (label) label.textContent = missing.length ? `Install ${missing.length} missing` : 'Nothing missing';
};

const refreshStack = async (options = {}) => {
  const verdict = document.getElementById('stackVerdict');
  try {
    const status = await window.lampControl.getStackStatus(options);
    renderStack(status);
  } catch (error) {
    if (verdict) verdict.textContent = 'Could not read the stack status. Re-check to try again.';
    throw error;
  }
};

const runStackInstall = async (ids, options = {}) => {
  if (stackInstalling) return;
  stackInstalling = true;

  const progress = document.getElementById('stackProgress');
  const logEl = document.getElementById('stackLog');
  const progressLabel = document.getElementById('stackProgressLabel');
  const button = document.getElementById('installStack');

  if (progress) progress.hidden = false;
  if (logEl) logEl.textContent = '';
  if (progressLabel) progressLabel.textContent = 'Preparing…';
  if (button) button.disabled = true;

  const appendLog = (line) => {
    if (!logEl || !line) return;
    logEl.textContent += `${line}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  };

  const unsubscribe = window.lampControl.onStackProgress((event) => {
    if (event.phase === 'consent' && progressLabel) progressLabel.textContent = 'Waiting for your approval…';
    else if (event.phase === 'elevate' && progressLabel) progressLabel.textContent = 'Waiting for the system permission prompt…';
    else if (event.phase === 'canceled' && progressLabel) progressLabel.textContent = 'Canceled';
    else if (event.message && progressLabel && event.phase !== 'download') progressLabel.textContent = event.message;
    appendLog(event.message);
  });

  try {
    const result = await window.lampControl.installDependencies(ids, options);
    (result.verified || []).forEach((entry) => {
      if (entry.ok) appendLog(`✓ ${entry.name}${entry.version ? ` v${entry.version}` : ''}${entry.upgraded ? ' updated' : ' ready'}`);
      else appendLog(`✗ ${entry.name}: ${entry.error || 'still missing'}`);
    });
    if (result.message) appendLog(result.message);
    if (result.logPath) appendLog(`Install log: ${result.logPath}`);
    if (progressLabel) progressLabel.textContent = result.ok ? 'Finished' : 'Finished with errors';
    if (!result.ok && result.failed && result.failed.length && !result.canceled) {
      alert(result.message || 'Some components could not be installed.');
    }
  } catch (error) {
    appendLog(`✗ ${error.message}`);
    if (progressLabel) progressLabel.textContent = 'Failed';
  } finally {
    unsubscribe();
    stackInstalling = false;
    await refreshStack();
    await refreshStatus();
  }
};

const loadSettings = async () => {
  const settings = await window.lampControl.getSettings();
  const defaultFolder = await window.lampControl.getDefaultScriptsFolder();

  const phpFolder = document.getElementById('phpFolder');
  if (phpFolder) {
    phpFolder.value = settings.lastPhpPath || defaultFolder || '';
  }
};

// ─── Bind UI ─────────────────────────────────────────────────────────────────

const bindUI = () => {
  // Start All / Stop All
  document.getElementById('startAll').addEventListener('click', () => handleBulkAction('start'));
  document.getElementById('stopAll').addEventListener('click', () => handleBulkAction('stop'));

  // Refresh
  document.getElementById('refreshAll').addEventListener('click', async () => {
    await refreshStatus();
    await refreshResources();
    await refreshRecentProjects();
  });

  // Individual service start/stop buttons
  document.querySelectorAll('[data-single-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const service = button.getAttribute('data-service');
      const action = button.getAttribute('data-single-action');
      await handleSingleServiceAction(service, action);
    });
  });

  // Shortcuts
  document.getElementById('openLocalhost').addEventListener('click', async () => {
    await window.lampControl.openUrl('http://localhost');
  });

  document.getElementById('runPhpMyAdmin').addEventListener('click', async () => {
    const result = await window.lampControl.openPhpMyAdmin();
    if (result && result.ok) return;

    if (result && result.needsInstall) {
      const panel = document.getElementById('stackPanel');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      alert('phpMyAdmin is not installed yet. Use Stack Setup above to install it.');
      return;
    }
    alert((result && result.error) || 'Unable to open phpMyAdmin.');
  });

  // Stack setup
  const openAppLog = document.getElementById('openAppLog');
  if (openAppLog) {
    openAppLog.addEventListener('click', async () => {
      const result = await window.lampControl.openAppLog();
      if (result && result.path) console.log(`App log: ${result.path}`);
    });
  }

  const checkStack = document.getElementById('checkStack');
  if (checkStack) {
    checkStack.addEventListener('click', async () => {
      const verdict = document.getElementById('stackVerdict');
      if (verdict) verdict.textContent = 'Re-checking versions…';
      try {
        renderStack(await window.lampControl.getStackStatus({ force: true }));
      } catch (error) {
        if (verdict) verdict.textContent = 'Could not read the stack status.';
      }
    });
  }
  const installStack = document.getElementById('installStack');
  if (installStack) {
    installStack.addEventListener('click', () => {
      const missing = stackStatus ? stackStatus.components.filter((component) => !component.installed).map((component) => component.id) : [];
      runStackInstall(missing);
    });
  }
  const stackGrid = document.getElementById('stackGrid');
  if (stackGrid) {
    stackGrid.addEventListener('click', (event) => {
      const target = event.target.closest('[data-install-component]');
      if (!target) return;
      const component = target.getAttribute('data-install-component');
      const isMissing = !stackStatus || !stackStatus.components.some((c) => c.id === component && c.installed);
      runStackInstall([component], { upgrade: !isMissing });
    });
  }

  // PHP server controls
  document.getElementById('startPhp').addEventListener('click', startPhpServer);
  document.getElementById('chooseFolder').addEventListener('click', chooseFolder);
  
  document.getElementById('openPhp').addEventListener('click', async () => {
    const urlEl = document.getElementById('phpUrlBox');
    const url = (urlEl && urlEl.textContent) ? urlEl.textContent.trim() : 'http://localhost/project';
    if (!url) {
      alert('No URL available. Please start the project first.');
      return;
    }
    await window.lampControl.openUrl(url);
  });

  // QR panel controls
  const refreshBtn = document.getElementById('refreshQr');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshNetworkQr);
  const copyBtn = document.getElementById('copyQrUrl');
  if (copyBtn) copyBtn.addEventListener('click', copyNetworkUrl);
  const downloadBtn = document.getElementById('downloadQr');
  if (downloadBtn) downloadBtn.addEventListener('click', downloadNetworkQr);
  const openQrBtn = document.getElementById('openQrUrl');
  if (openQrBtn) openQrBtn.addEventListener('click', async () => {
    const urlEl = document.getElementById('networkQrUrl');
    const url = urlEl && urlEl.textContent.trim();
    if (url) await window.lampControl.openUrl(url);
  });
};

// ─── Init ────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  bindUI();
  await loadSettings();

  try {
    const platformInfo = await window.lampControl.getPlatformInfo();
    const eyebrow = document.querySelector('.topbar .eyebrow');
    if (eyebrow && platformInfo) {
      const name = platformInfo.isWindows ? 'Windows' : platformInfo.isLinux ? 'Linux' : 'macOS';
      eyebrow.textContent = `Local server control · ${name}`;
    }
  } catch (error) {
    /* platform label is cosmetic */
  }

  // Run the refreshers concurrently: sequentially awaiting each one made the
  // app feel slow to become usable, and the stack check is the slowest of them.
  // Each is isolated so one failing subsystem cannot blank the whole page.
  const refreshers = [refreshStatus, refreshResources, refreshRecentProjects, refreshNetworkQr, refreshStack];
  await Promise.all(
    refreshers.map((refresh) =>
      Promise.resolve()
        .then(refresh)
        .catch((error) => console.error(`Refresh failed: ${error.message}`))
    )
  );
});
