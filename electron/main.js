const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { loginWithGoogle, logoutGoogle, getGoogleAuthStatus } = require('./google-auth');
const { createGcalEvent, updateGcalEvent, deleteGcalEvent, deleteMultipleGcalEvents, processOfflineQueue, fetchGcalEvents, fetchHolidays, saveImportMapping, cleanupStaleMapping } = require('./gcal-sync');
const os = require('os');
const chokidar = require('chokidar');
const { DB_FILE, openDatabase, closeDatabase, getDatabase } = require('./database');
const sqliteStorage = require('./storage-sqlite');
const { migrateJsonToSqlite, migrateSettingsToSqlite } = require('./migrate-json-to-sqlite');

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
let dataWatcher = null;
let selfWriteFlag = false; // 자체 쓰기 시 watcher 무시용

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

// ── 종료 전 데이터 플러시 핸드셰이크 ──
let saveBeforeQuitDone = false;

app.on('before-quit', (e) => {
  if (saveBeforeQuitDone) return; // 플러시 완료 후 재진입 시 통과
  e.preventDefault();
  app.isQuitting = true;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('request-save-before-close');
    // 렌더러가 응답 못하면 3초 후 강제 종료
    setTimeout(() => {
      saveBeforeQuitDone = true;
      app.quit();
    }, 3000);
  } else {
    saveBeforeQuitDone = true;
    app.quit();
  }
});

ipcMain.on('save-complete', () => {
  saveBeforeQuitDone = true;
  app.quit();
});

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

// 자동 시작 설정 (settings.json에도 저장하여 재패키징 시 자동 복원)
ipcMain.handle('get-auto-launch', () => {
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('set-auto-launch', (_e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: enabled });
  // SQLite settings에도 기록하여 재패키징 후 자동 복원
  try {
    const settings = sqliteStorage.loadSettings() || {};
    settings.autoLaunch = enabled;
    sqliteStorage.saveSettings(settings);
  } catch (e) {}
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

ipcMain.handle('gcal-cleanup-stale', async (_e, payload) => {
  try {
    return await cleanupStaleMapping(app, payload);
  } catch (e) {
    console.error('gcal cleanup-stale 실패:', e.message);
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

ipcMain.handle('gcal-fetch-holidays', async (_e, payload) => {
  try {
    return await fetchHolidays(app, payload);
  } catch (e) {
    console.error('gcal fetch-holidays 실패:', e.message);
    return { success: false, holidays: [], error: e.message };
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
const SYNC_FILE = 'taskdata.sync.json'; // 클라우드 동기화용
const SETTINGS_FILE = 'settings.json';
const CUSTOM_PATH_FILE = 'custom-data-path.json';
const ARCHIVE_DAYS = 90;

function getCustomDataPath() {
  try {
    const p = path.join(app.getPath('userData'), CUSTOM_PATH_FILE);
    if (fs.existsSync(p)) {
      const config = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (config.dataPath && fs.existsSync(config.dataPath)) return config.dataPath;
    }
  } catch (e) {
    console.error('[Data] 커스텀 데이터 경로 로드 실패:', e.message);
  }
  return null;
}

function setCustomDataPath(dirPath) {
  const p = path.join(app.getPath('userData'), CUSTOM_PATH_FILE);
  if (dirPath) {
    fs.writeFileSync(p, JSON.stringify({ dataPath: dirPath }, null, 2), 'utf-8');
  } else {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function getFilePath(filename) {
  const customPath = getCustomDataPath();
  if (customPath) return path.join(customPath, filename);
  return path.join(app.getPath('userData'), filename);
}

function readJsonFile(filename, fallback) {
  try {
    const p = getFilePath(filename);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error(`[Data] ${filename} 읽기 실패:`, e.message);
  }
  return fallback;
}

function writeJsonFile(filename, data) {
  try {
    const filePath = getFilePath(filename);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let jsonContent;
    if (typeof data === 'string') {
      if (isDev) {
        try {
          jsonContent = JSON.stringify(JSON.parse(data), null, 2);
        } catch (e) {
          jsonContent = data;
        }
      } else {
        jsonContent = data;
      }
    } else {
      jsonContent = isDev ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    }

    // tmp 파일을 시스템 임시 디렉토리에 생성 (Google Drive 등 클라우드 동기화 충돌 방지)
    const tempPath = path.join(os.tmpdir(), `tasknote-${filename}.tmp`);
    selfWriteFlag = true;
    fs.writeFileSync(tempPath, jsonContent, 'utf-8');
    try {
      fs.renameSync(tempPath, filePath);
    } catch (_renameErr) {
      // 드라이브가 다를 경우 rename 불가 → copy + unlink
      fs.copyFileSync(tempPath, filePath);
      fs.unlinkSync(tempPath);
    }
    setTimeout(() => { selfWriteFlag = false; }, 1500);
  } catch (e) {
    // 쓰기 실패 시 selfWriteFlag 해제 (고착 방지)
    selfWriteFlag = false;
    console.error(`[Data] ${filename} 쓰기 실패:`, e.message);
    try {
      const tempPath = path.join(os.tmpdir(), `tasknote-${filename}.tmp`);
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {}
  }
}

/**
 * 클라우드 동기화용 JSON 파일 쓰기 (옵션 B 전략)
 * - 커스텀 경로가 설정된 경우에만 sync.json을 생성
 * - 실패 시 재시도 + pendingSyncData에 보관하여 다음 저장 때 재시도
 */
let pendingSyncData = null;

function writeSyncFile(data) {
  if (!getCustomDataPath()) return;

  const dataToWrite = data;
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      writeJsonFile(SYNC_FILE, dataToWrite);
      pendingSyncData = null; // 성공 시 대기 데이터 초기화
      return;
    } catch (e) {
      console.error(`[Sync] sync.json 쓰기 실패 (시도 ${attempt + 1}/${maxRetries + 1}):`, e.message);
      if (attempt < maxRetries) {
        // 짧은 대기 후 재시도
        const waitUntil = Date.now() + 200 * (attempt + 1);
        while (Date.now() < waitUntil) { /* spin wait */ }
      }
    }
  }

  // 모든 재시도 실패 → 다음 저장 때 재시도할 수 있도록 보관
  pendingSyncData = dataToWrite;
  console.error('[Sync] sync.json 쓰기 최종 실패. 다음 저장 시 재시도 예약됨.');
}

/**
 * 이전에 실패한 sync 쓰기가 있으면 재시도합니다.
 * save-app-data 핸들러 진입 시 호출됩니다.
 */
function flushPendingSync() {
  if (!pendingSyncData) return;
  console.log('[Sync] 이전 실패한 sync.json 쓰기 재시도...');
  try {
    writeJsonFile(SYNC_FILE, pendingSyncData);
    pendingSyncData = null;
    console.log('[Sync] 재시도 성공.');
  } catch (e) {
    console.error('[Sync] 재시도 실패:', e.message);
  }
}

function watchDataFile() {
  if (dataWatcher) dataWatcher.close();

  const customPath = getCustomDataPath();
  if (!customPath) {
    // 커스텀 경로 없으면 로컬 DB만 사용 — 파일감시 불필요
    console.log('[Watcher] 로컬 모드 — 파일 감시 생략');
    return;
  }

  // 클라우드 동기화 모드: sync.json 감시 (기존 JSON 파이프라인 재활용)
  const syncFilePath = path.join(customPath, SYNC_FILE);
  dataWatcher = chokidar.watch(syncFilePath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  dataWatcher.on('change', () => {
    if (selfWriteFlag) return;
    try {
      const newData = readJsonFile(SYNC_FILE, null);
      if (newData && mainWindow && !mainWindow.isDestroyed()) {
        // 외부 변경 → SQLite에도 반영 + renderer 통지
        sqliteStorage.saveAllData(newData);
        mainWindow.webContents.send('external-data-changed', newData);
        console.log('[Watcher] 외부 변경 감지 → SQLite + renderer 동기화 완료');
      }
    } catch (e) {
      console.error('[Watcher] 동기화 실패:', e.message);
    }
  });
  console.log('[Watcher] 클라우드 모드 — sync.json 감시 시작:', syncFilePath);
}

ipcMain.handle('load-app-data', () => {
  return sqliteStorage.loadAllData();
});
ipcMain.handle('get-last-updated', () => {
  return sqliteStorage.getLastUpdated();
});
ipcMain.handle('is-cloud-sync', () => {
  return !!getCustomDataPath();
});
ipcMain.handle('save-app-data', (_e, data) => {
  try {
    // 이전에 실패한 sync 쓰기가 있으면 먼저 재시도
    flushPendingSync();

    const incomingData = typeof data === 'string' ? JSON.parse(data) : data;

    // 충돌 판정: getLastUpdated()로 경량 체크 (전체 loadAllData 불필요)
    const diskLastUpdated = sqliteStorage.getLastUpdated();
    if (diskLastUpdated && incomingData.lastUpdated && diskLastUpdated !== incomingData.lastUpdated) {
      if (incomingData.lastUpdated > diskLastUpdated) {
        // 자기 자신의 연속 저장 → 단순 업데이트
        sqliteStorage.saveAllData(incomingData);
        writeSyncFile(incomingData);
        return { success: true };
      }
      // disk가 더 최신 → 외부 변경 (이때만 전체 로드)
      console.warn('[Data] Conflict: disk is newer. Using disk data.');
      const diskData = sqliteStorage.loadAllData();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('external-data-changed', diskData);
      }
      return { success: true, merged: true, data: diskData };
    }

    sqliteStorage.saveAllData(incomingData);
    writeSyncFile(incomingData);
    return { success: true };
  } catch (e) {
    console.error('[Data] save-app-data failed:', e.message);
    return { success: false, error: e.message };
  }
});
ipcMain.handle('load-settings', () => {
  return sqliteStorage.loadSettings();
});
ipcMain.handle('save-settings', (_e, settings) => {
  const settingsData = typeof settings === 'string' ? JSON.parse(settings) : settings;
  sqliteStorage.saveSettings(settingsData);
  return true;
});

ipcMain.handle('get-data-path', () => {
  const custom = getCustomDataPath();
  return { path: custom || app.getPath('userData'), isCustom: !!custom };
});

ipcMain.handle('select-data-folder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '데이터 저장 폴더 선택',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('set-data-path', (_e, newPath) => {
  try {
    // 현재 데이터 백업 (DB에서 읽기)
    const currentData = sqliteStorage.loadAllData();

    // 기존 DB 닫기
    closeDatabase();

    // 새 경로 설정
    setCustomDataPath(newPath);

    if (!fs.existsSync(newPath)) {
      fs.mkdirSync(newPath, { recursive: true });
    }

    // 새 경로에 DB 파일이 없으면 기존 DB 복사
    const oldDbPath = path.join(app.getPath('userData'), DB_FILE);
    const newDbPath = path.join(newPath, DB_FILE);
    if (!fs.existsSync(newDbPath) && fs.existsSync(oldDbPath)) {
      fs.copyFileSync(oldDbPath, newDbPath);
      console.log('[Data] 기존 DB 복사 완료:', newDbPath);
    }

    // 새 경로에서 DB 열기
    openDatabase(newDbPath);

    // 새 경로의 데이터 반환
    const newData = sqliteStorage.loadAllData();

    // 클라우드 동기화용 sync.json 초기화
    if (newData) writeSyncFile(newData);

    watchDataFile(); // 새 경로 감시 시작
    return { success: true, path: newPath, data: newData };
  } catch (e) {
    console.error('[Data] 경로 변경 실패:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('reset-data-path', () => {
  // DB 닫기
  closeDatabase();

  setCustomDataPath(null);

  // 기본 경로에서 DB 다시 열기
  const defaultDbPath = path.join(app.getPath('userData'), DB_FILE);
  openDatabase(defaultDbPath);

  const data = sqliteStorage.loadAllData();
  watchDataFile(); // 기본 경로 감시 재시작
  return { success: true, path: app.getPath('userData'), data };
});

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
    const currentVersion = app.getVersion();
    const latestVersion = result?.updateInfo?.version;
    const available = !!(latestVersion && latestVersion !== currentVersion);
    // GitHub Release notes 가져오기
    let releaseNotes = result?.updateInfo?.releaseNotes || "";
    if (!releaseNotes && available) {
      try {
        const https = require('https');
        const notes = await new Promise((resolve) => {
          const req = https.get(`https://api.github.com/repos/Skedit99/TaskNote/releases/tags/v${latestVersion}`, {
            headers: { 'User-Agent': 'TaskNote', 'Accept': 'application/vnd.github.v3+json' }
          }, (res) => {
            let body = '';
            res.on('data', (c) => body += c);
            res.on('end', () => { try { resolve(JSON.parse(body).body || ""); } catch { resolve(""); } });
          });
          req.on('error', () => resolve(""));
          req.setTimeout(5000, () => { req.destroy(); resolve(""); });
        });
        releaseNotes = notes;
      } catch { releaseNotes = ""; }
    }
    return { updateAvailable: available, latestVersion, releaseNotes };
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
  saveBeforeQuitDone = true;
  app.isQuitting = true;
  autoUpdater.quitAndInstall(true, true); // silent install, force quit
});

// 현재 앱 버전 가져오기
ipcMain.handle('get-app-version', () => app.getVersion());

app.whenReady().then(() => {
  // ── SQLite 초기화 ──
  const dbDir = getCustomDataPath() || app.getPath('userData');
  const dbPath = path.join(dbDir, DB_FILE);

  // JSON → SQLite 마이그레이션 (taskdata.json이 있고 DB가 비어있을 때만)
  const jsonPath = path.join(dbDir, DATA_FILE);
  const migrationResult = migrateJsonToSqlite(jsonPath, dbPath);
  if (migrationResult.status === 'success') {
    console.log('[Startup] JSON → SQLite 마이그레이션 완료. 백업:', migrationResult.backupPath);
  } else if (migrationResult.status === 'failed') {
    console.error('[Startup] 마이그레이션 실패 — JSON 폴백 모드로 계속합니다:', migrationResult.reason);
  }

  // DB 열기 (마이그레이션 후 또는 기존 DB)
  openDatabase(dbPath);

  // settings.json → SQLite 마이그레이션
  const settingsJsonPath = path.join(dbDir, SETTINGS_FILE);
  migrateSettingsToSqlite(settingsJsonPath, getDatabase());

  // ── 클라우드 동기화: sync.json이 DB보다 최신이면 DB에 반영 ──
  // (서브PC 업데이트 후 구 로컬 JSON만 마이그레이션되어 최신 데이터를 놓치는 문제 방지)
  const customPath = getCustomDataPath();
  if (customPath) {
    try {
      const syncFilePath = path.join(customPath, SYNC_FILE);
      if (fs.existsSync(syncFilePath)) {
        const syncData = JSON.parse(fs.readFileSync(syncFilePath, 'utf-8'));
        const dbLastUpdated = sqliteStorage.getLastUpdated();
        const syncLastUpdated = syncData?.lastUpdated || 0;
        if (syncLastUpdated > dbLastUpdated) {
          console.log(`[Startup] sync.json이 DB보다 최신 (sync: ${syncLastUpdated}, db: ${dbLastUpdated}) → DB에 반영`);
          sqliteStorage.saveAllData(syncData);
        } else {
          console.log(`[Startup] DB가 최신이거나 동일 (sync: ${syncLastUpdated}, db: ${dbLastUpdated}) → 스킵`);
        }
      }
    } catch (e) {
      console.error('[Startup] sync.json 확인 실패:', e.message);
    }
  }

  createWindow();
  createTray();
  setupAutoUpdater();

  // SQLite 기반 아카이빙
  sqliteStorage.archiveOldData(ARCHIVE_DAYS);

  watchDataFile(); // 파일 감시 시작 (아카이빙 후)

  // 자동 시작 설정 복원
  try {
    const settings = sqliteStorage.loadSettings() || {};
    if (settings.autoLaunch === true) {
      const current = app.getLoginItemSettings().openAtLogin;
      if (!current) {
        app.setLoginItemSettings({ openAtLogin: true });
        console.log('[Settings] 자동 시작 설정 복원 완료');
      }
    }
  } catch (e) {}

  // 앱 시작 5초 후 업데이트 확인
  if (!isDev) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
});
app.on('window-all-closed', () => {
  if (dataWatcher) dataWatcher.close(); // 감시 종료
  closeDatabase(); // DB 안전 종료
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
