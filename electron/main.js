const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { loginWithGoogle, logoutGoogle, getGoogleAuthStatus } = require('./google-auth');
const { createGcalEvent, updateGcalEvent, deleteGcalEvent, deleteMultipleGcalEvents, processOfflineQueue, fetchGcalEvents, saveImportMapping } = require('./gcal-sync');

// Windows 작업표시줄 아이콘 표시를 위해 AppUserModelId 설정 (반드시 early에 호출)
app.setAppUserModelId('com.tasknote.app');

// ── 중복 실행 방지 (Single Instance Lock) ──
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  dialog.showErrorBox('TaskNote', '이미 앱이 실행중입니다.');
  process.exit(0);
}

let mainWindow;
let tray;
const isDev = !app.isPackaged;
let fullBounds = null;

// 개발 환경: project/build/  |  패키징 후: resources/build/
const resourceBase = app.isPackaged
  ? path.join(process.resourcesPath, 'build')
  : path.join(__dirname, '../build');
const iconPath = path.join(resourceBase, 'icon.ico');
const trayIconPath = path.join(resourceBase, 'tray-icon.png');

// 두 번째 인스턴스가 실행되면 기존 창을 포커스
app.on('second-instance', () => {
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createWindow() {
  const appIcon = nativeImage.createFromPath(iconPath);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 380,
    minHeight: 400,
    frame: false,
    transparent: true,
    icon: appIcon,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: '#00000000',
  });

  // Windows 작업표시줄 아이콘 강제 설정
  mainWindow.setIcon(appIcon);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (isDev) mainWindow.loadURL('http://localhost:5173');
  else mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));

  // ── 외부 링크 보안: 앱 내부 네비게이션 차단 → 기본 브라우저로 열기 ──
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev ? 'http://localhost' : 'file://';
    if (!url.startsWith(allowed)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
}

function createTray() {
  try {
    const trayIcon = nativeImage.createFromPath(trayIconPath);
    tray = new Tray(trayIcon);
    const contextMenu = Menu.buildFromTemplate([
      { label: 'TaskNote 열기', click: () => { mainWindow.show(); mainWindow.focus(); } },
      { type: 'separator' },
      { label: '종료', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setToolTip('TaskNote');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
  } catch (e) { console.log('트레이 아이콘 없이 실행합니다:', e.message); }
}

// 윈도우 컨트롤
ipcMain.handle('window-minimize', () => mainWindow?.minimize());
ipcMain.handle('window-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('window-close', () => {
  if (!mainWindow) return;
  app.isQuitting ? mainWindow.close() : mainWindow.hide();
});

// 미니 모드 (type: 'today' | 'calendar' | false)
let currentMiniMode = false;

ipcMain.handle('set-mini-mode', (_e, type) => {
  if (!mainWindow) return;
  if (type === 'today') {
    if (!currentMiniMode) fullBounds = mainWindow.getBounds();
    currentMiniMode = 'today';
    const b = mainWindow.getBounds();
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(340, 300);
    mainWindow.setMaximumSize(800, 2000);
    mainWindow.setBounds({ x: b.x + b.width - 380, y: b.y, width: 380, height: 560 }, true);
  } else if (type === 'calendar') {
    if (!currentMiniMode) fullBounds = mainWindow.getBounds();
    currentMiniMode = 'calendar';
    const b = mainWindow.getBounds();
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(320, 350);
    mainWindow.setMaximumSize(800, 2000);
    mainWindow.setBounds({ x: b.x + b.width - 440, y: b.y, width: 440, height: 520 }, true);
  } else {
    currentMiniMode = false;
    mainWindow.setFocusable(true);
    mainWindow.setMaximumSize(99999, 99999);
    if (fullBounds) { mainWindow.setMinimumSize(900, 600); mainWindow.setBounds(fullBounds, true); }
    else { mainWindow.setMinimumSize(900, 600); mainWindow.setSize(1400, 900, true); }
    mainWindow.show();
    mainWindow.focus();
  }
});

ipcMain.handle('set-opacity', (_e, v) => mainWindow?.setOpacity(Math.max(0, Math.min(1, v))));
ipcMain.handle('set-locked', (_e, locked) => { if (!mainWindow) return; mainWindow.setMovable(!locked); });
ipcMain.handle('set-always-on-top', (_e, on) => mainWindow?.setAlwaysOnTop(on, 'floating'));
ipcMain.handle('set-window-level', (_e, level) => {
  if (!mainWindow) return;
  if (level === 'widget') {
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setFocusable(false);
    mainWindow.blur();
  } else {
    mainWindow.setFocusable(true);
  }
});
ipcMain.handle('get-bounds', () => mainWindow?.getBounds());
ipcMain.handle('set-bounds', (_e, bounds) => { if (mainWindow) mainWindow.setBounds(bounds); });

// 자동 시작 설정
ipcMain.handle('get-auto-launch', () => {
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('set-auto-launch', (_e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: enabled });
});

// ═══════════════════════════════
// Google Calendar OAuth IPC 핸들러
// ═══════════════════════════════

ipcMain.handle('gcal-login', async () => {
  try {
    const result = await loginWithGoogle(null, mainWindow);
    return { success: true, profile: result.profile };
  } catch (e) {
    console.error('Google 로그인 실패:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('gcal-logout', async () => {
  try {
    await logoutGoogle();
    return { success: true };
  } catch (e) {
    console.error('Google 로그아웃 실패:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('gcal-status', async () => {
  try {
    return await getGoogleAuthStatus();
  } catch (e) {
    console.error('Google 상태 확인 실패:', e.message);
    return { connected: false };
  }
});

// ═══════════════════════════════
// Google Calendar 동기화 IPC 핸들러
// ═══════════════════════════════

ipcMain.handle('gcal-sync-create', async (_e, payload) => {
  try {
    return await createGcalEvent(app, payload);
  } catch (e) {
    console.error('gcal sync create 실패:', e.message);
    return null;
  }
});

ipcMain.handle('gcal-sync-update', async (_e, payload) => {
  try {
    return await updateGcalEvent(app, payload);
  } catch (e) {
    console.error('gcal sync update 실패:', e.message);
    return null;
  }
});

ipcMain.handle('gcal-sync-delete', async (_e, payload) => {
  try {
    return await deleteGcalEvent(app, payload);
  } catch (e) {
    console.error('gcal sync delete 실패:', e.message);
    return null;
  }
});

ipcMain.handle('gcal-sync-delete-multiple', async (_e, payload) => {
  try {
    return await deleteMultipleGcalEvents(app, payload);
  } catch (e) {
    console.error('gcal sync delete-multiple 실패:', e.message);
    return null;
  }
});

ipcMain.handle('gcal-sync-flush-queue', async () => {
  try {
    return await processOfflineQueue(app);
  } catch (e) {
    console.error('gcal sync flush-queue 실패:', e.message);
    return null;
  }
});

ipcMain.handle('gcal-fetch-events', async (_e, payload) => {
  try {
    return await fetchGcalEvents(app, payload);
  } catch (e) {
    console.error('gcal fetch-events 실패:', e.message);
    return { success: false, events: [], error: e.message };
  }
});

ipcMain.handle('gcal-save-import-mapping', async (_e, { localId, gcalEventId, date }) => {
  try {
    saveImportMapping(app, localId, gcalEventId, date);
    return { success: true };
  } catch (e) {
    console.error('gcal save-import-mapping 실패:', e.message);
    return { success: false };
  }
});

// ═══════════════════════════════
// 앱 데이터 파일 관리 IPC 핸들러
// ═══════════════════════════════
const fs = require('fs');

const DATA_FILE = 'taskdata.json';
const SETTINGS_FILE = 'settings.json';

function getFilePath(filename) {
  return path.join(app.getPath('userData'), filename);
}

function readJsonFile(filename, fallback) {
  try {
    const p = getFilePath(filename);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) { console.error(`[Data] ${filename} 읽기 실패:`, e.message); }
  return fallback;
}

function writeJsonFile(filename, data) {
  try {
    fs.writeFileSync(getFilePath(filename), JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) { console.error(`[Data] ${filename} 쓰기 실패:`, e.message); }
}

// 앱 데이터 (프로젝트, 할일, 일정 등)
ipcMain.handle('load-app-data', () => readJsonFile(DATA_FILE, null));
ipcMain.handle('save-app-data', (_e, data) => { writeJsonFile(DATA_FILE, data); return true; });

// UI 설정 (테마, 미니모드 설정, 캘린더 범위, 윈도우 모드)
ipcMain.handle('load-settings', () => readJsonFile(SETTINGS_FILE, null));
ipcMain.handle('save-settings', (_e, settings) => { writeJsonFile(SETTINGS_FILE, settings); return true; });

// ═══════════════════════════════
// 자동 업데이트 (Auto Updater)
// ═══════════════════════════════
autoUpdater.autoDownload = false;  // 수동 다운로드 (사용자 확인 후)
autoUpdater.autoInstallOnAppQuit = true;

function setupAutoUpdater() {
  // 업데이트 확인 결과를 렌더러에 전달
  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdater] 새 버전 발견:', info.version);
    if (mainWindow) mainWindow.webContents.send('update-available', info.version);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[AutoUpdater] 최신 버전입니다.');
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) mainWindow.webContents.send('update-download-progress', Math.round(progress.percent));
  });

  autoUpdater.on('update-downloaded', () => {
    console.log('[AutoUpdater] 다운로드 완료. 재시작 대기 중.');
    if (mainWindow) mainWindow.webContents.send('update-downloaded');
  });

  autoUpdater.on('error', (err) => {
    console.error('[AutoUpdater] 오류:', err.message);
  });
}

// 업데이트 확인 (렌더러에서 호출)
ipcMain.handle('check-for-update', async () => {
  if (isDev) return { updateAvailable: false };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { updateAvailable: !!result?.updateInfo };
  } catch (e) {
    console.error('[AutoUpdater] 확인 실패:', e.message);
    return { updateAvailable: false, error: e.message };
  }
});

// 업데이트 다운로드 시작
ipcMain.handle('download-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// 업데이트 설치 & 재시작
ipcMain.handle('install-update', () => {
  app.isQuitting = true;
  autoUpdater.quitAndInstall();
});

// 현재 앱 버전 가져오기
ipcMain.handle('get-app-version', () => app.getVersion());

app.whenReady().then(() => {
  createWindow();
  createTray();
  setupAutoUpdater();
  // 앱 시작 5초 후 업데이트 확인
  if (!isDev) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
