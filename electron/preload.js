const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── 기존 API ──
  setMiniMode: (type) => ipcRenderer.invoke('set-mini-mode', type),
  setOpacity: (value) => ipcRenderer.invoke('set-opacity', value),
  setLocked: (locked) => ipcRenderer.invoke('set-locked', locked),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('set-always-on-top', on),
  setWindowLevel: (level) => ipcRenderer.invoke('set-window-level', level),
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  getBounds: () => ipcRenderer.invoke('get-bounds'),
  setBounds: (bounds) => ipcRenderer.invoke('set-bounds', bounds),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (on) => ipcRenderer.invoke('set-auto-launch', on),

  // ── Google Calendar OAuth ──
  gcalLogin: () => ipcRenderer.invoke('gcal-login'),
  gcalLogout: () => ipcRenderer.invoke('gcal-logout'),
  gcalGetStatus: () => ipcRenderer.invoke('gcal-status'),

  // ── 앱 데이터 파일 관리 ──
  loadAppData: () => ipcRenderer.invoke('load-app-data'),
  saveAppData: (data) => ipcRenderer.invoke('save-app-data', data),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // ── 자동 업데이트 ──
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, ver) => cb(ver)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-download-progress', (_e, pct) => cb(pct)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', () => cb()),
  onUpdateInstalling: (cb) => ipcRenderer.on('update-installing', () => cb()),

  // ── 데이터 저장 경로 ──
  getDataPath: () => ipcRenderer.invoke('get-data-path'),
  selectDataFolder: () => ipcRenderer.invoke('select-data-folder'),
  setDataPath: (path) => ipcRenderer.invoke('set-data-path', path),
  resetDataPath: () => ipcRenderer.invoke('reset-data-path'),

  // ── 외부 변경 감지 (클라우드 동기화) ──
  onExternalDataChanged: (cb) => ipcRenderer.on('external-data-changed', (_e, data) => cb(data)),
  onDataConflict: (cb) => ipcRenderer.on('data-conflict', (_e, diskData) => cb(diskData)),

  // ── 종료 전 저장 핸드셰이크 ──
  onRequestSaveBeforeClose: (cb) => ipcRenderer.on('request-save-before-close', () => cb()),
  sendSaveComplete: () => ipcRenderer.send('save-complete'),

  // ── Google Calendar 동기화 ──
  gcalSyncCreate: (payload) => ipcRenderer.invoke('gcal-sync-create', payload),
  gcalSyncUpdate: (payload) => ipcRenderer.invoke('gcal-sync-update', payload),
  gcalSyncDelete: (payload) => ipcRenderer.invoke('gcal-sync-delete', payload),
  gcalSyncDeleteMultiple: (payload) => ipcRenderer.invoke('gcal-sync-delete-multiple', payload),
  gcalSyncFlushQueue: () => ipcRenderer.invoke('gcal-sync-flush-queue'),
  gcalCleanupStale: (payload) => ipcRenderer.invoke('gcal-cleanup-stale', payload),
  gcalFetchEvents: (payload) => ipcRenderer.invoke('gcal-fetch-events', payload),
  gcalFetchHolidays: (payload) => ipcRenderer.invoke('gcal-fetch-holidays', payload),
  gcalSaveImportMapping: (payload) => ipcRenderer.invoke('gcal-save-import-mapping', payload),
});
