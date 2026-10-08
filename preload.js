const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lampControl', {
  // System status
  getSystemStatus: () => ipcRenderer.invoke('get-system-status'),

  // Bulk service actions (Apache + MariaDB)
  serviceAction: (action) => ipcRenderer.invoke('service-action', action),

  // Individual service action
  serviceActionSingle: (service, action) => ipcRenderer.invoke('service-action-single', service, action),

  // Settings persistence
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Default scripts folder path
  getDefaultScriptsFolder: () => ipcRenderer.invoke('get-default-scripts-folder'),

  // PHP server
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  startPhpServer: (folder) => ipcRenderer.invoke('start-php-server', folder),
  stopPhpServer: () => ipcRenderer.invoke('stop-php-server'),

  // phpMyAdmin
  openPhpMyAdmin: () => ipcRenderer.invoke('open-phpmyadmin'),
  getPhpMyAdminTarget: () => ipcRenderer.invoke('get-phpmyadmin-target'),

  // Dependency stack (PHP / MariaDB / phpMyAdmin)
  getStackStatus: (options) => ipcRenderer.invoke('get-stack-status', options),
  installDependencies: (ids, options) => ipcRenderer.invoke('install-dependencies', ids, options),
  onStackProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('stack-progress', listener);
    return () => ipcRenderer.removeListener('stack-progress', listener);
  },

  // Network
  getNetworkDevices: () => ipcRenderer.invoke('get-network-devices'),

  // Resources
  getResourceUsage: () => ipcRenderer.invoke('get-resource-usage'),

  // Platform info
  getPlatformInfo: () => ipcRenderer.invoke('get-platform-info'),

  // Diagnostics
  openAppLog: () => ipcRenderer.invoke('open-app-log'),

  // Misc
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  getRecentProjects: () => ipcRenderer.invoke('get-recent-projects'),
  addRecentProject: (path) => ipcRenderer.invoke('add-recent-project', path)
});
