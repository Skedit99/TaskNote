const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { loginWithGoogle, logoutGoogle, getGoogleAuthStatus } = require('./google-auth');
const { createGcalEvent, updateGcalEvent, deleteGcalEvent, deleteMultipleGcalEvents, processOfflineQueue, fetchGcalEvents, pullChangesFromGcal, fetchHolidays, saveImportMapping, cleanupStaleMapping, gcalFullReset, deduplicateGcalEvents } = require('./gcal-sync');
const os = require('os');
const crypto = require('crypto');
const chokidar = require('chokidar');
const { DB_FILE, openDatabase, closeDatabase, getDatabase, migrateGcalFilesToDb } = require('./database');
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
let selfWriteFlag = false; // 자체 쓰기 시 watcher 보조 안전장치
let lastSyncWriteTimestamp = 0; // 이 PC가 마지막으로 sync.json에 쓴/읽은 lastUpdated 값
let deviceId = null; // 이 PC의 고유 식별자 (sync.json 자기 쓰기 판별용)

/**
 * 디바이스 ID를 meta 테이블에서 로드하거나, 없으면 새로 생성합니다.
 * DB가 열린 후 호출해야 합니다.
 */
function getOrCreateDeviceId() {
  const existing = sqliteStorage.getMeta('device_id');
  if (existing) return existing;
  const id = crypto.randomUUID();
  sqliteStorage.setMeta('device_id', id);
  console.log('[Device] 새 디바이스 ID 생성:', id);
  return id;
}

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
  // lastSyncWriteTimestamp 영속화 (종료 전 1회)
  try { sqliteStorage.setMeta('last_sync_seen_ts', String(lastSyncWriteTimestamp)); } catch (_) {}
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
    return await createGcalEvent(payload);
  } catch (e) {
    console.error('gcal sync create 실패:', e.message);
    return null;
  }
});

ipcMain.handle('gcal-sync-update', async (_e, payload) => {
  try {
    return await updateGcalEvent(payload);
  } catch (e) {
    console.error('gcal sync update 실패:', e.message);
    return null;
  }
});

ipcMain.handle('gcal-sync-delete', async (_e, payload) => {
  try {
    return await deleteGcalEvent(payload);
  } catch (e) {
    console.error('gcal sync delete 실패:', e.message);
    return null;
  }
});

ipcMain.handle('gcal-sync-delete-multiple', async (_e, payload) => {
  try {
    return await deleteMultipleGcalEvents(payload);
  } catch (e) {
    console.error('gcal sync delete-multiple 실패:', e.message);
    return null;
  }
});

ipcMain.handle('gcal-cleanup-stale', async (_e, payload) => {
  try {
    return await cleanupStaleMapping(payload);
  } catch (e) {
    console.error('gcal cleanup-stale 실패:', e.message);
    return null;
  }
});

ipcMain.handle('gcal-sync-flush-queue', async () => {
  try {
    return await processOfflineQueue();
  } catch (e) {
    console.error('gcal sync flush-queue 실패:', e.message);
    return null;
  }
});

ipcMain.handle('gcal-fetch-events', async (_e, payload) => {
  try {
    return await fetchGcalEvents(payload);
  } catch (e) {
    console.error('gcal fetch-events 실패:', e.message);
    return { success: false, events: [], error: e.message };
  }
});

ipcMain.handle('gcal-fetch-holidays', async (_e, payload) => {
  try {
    return await fetchHolidays(payload);
  } catch (e) {
    console.error('gcal fetch-holidays 실패:', e.message);
    return { success: false, holidays: [], error: e.message };
  }
});

ipcMain.handle('gcal-save-import-mapping', async (_e, { localId, gcalEventId, date }) => {
  try {
    saveImportMapping(localId, gcalEventId, date);
    return { success: true };
  } catch (e) {
    console.error('gcal save-import-mapping 실패:', e.message);
    return { success: false };
  }
});

ipcMain.handle('gcal-full-reset', async () => {
  try {
    return await gcalFullReset();
  } catch (e) {
    console.error('gcal full-reset 실패:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('gcal-deduplicate', async (_e, payload) => {
  try {
    return await deduplicateGcalEvents(payload);
  } catch (e) {
    console.error('gcal deduplicate 실패:', e.message);
    return { success: false, error: e.message, duplicates: 0 };
  }
});

ipcMain.handle('gcal-pull-changes', async (_e, payload) => {
  try {
    return await pullChangesFromGcal(payload);
  } catch (e) {
    console.error('gcal pull changes 실패:', e.message);
    return { success: false, changes: [], error: e.message };
  }
});

// ═══════════════════════════════
// 앱 데이터 파일 관리 IPC 핸들러
// ═══════════════════════════════
const fs = require('fs');

const DATA_FILE = 'taskdata.json';
const SYNC_FILE = 'taskdata.sync.json'; // 클라우드 동기화용
const SETTINGS_FILE = 'settings.json';

// ── Dirty Tracking: 변경 없으면 sync.json 쓰기 생략 ──
let lastSyncHash = '';
function computeDataHash(data) {
  const crypto = require('crypto');
  // lastUpdated, _writerDeviceId 제외하고 데이터 내용만 해시
  const { lastUpdated, _writerDeviceId, ...content } = data || {};
  return crypto.createHash('md5').update(JSON.stringify(content)).digest('hex');
}
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

  // sync.json에 writerDeviceId 메타 필드 추가 (자기 쓰기 판별용)
  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  const dataToWrite = { ...parsed, _writerDeviceId: deviceId };
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      writeJsonFile(SYNC_FILE, dataToWrite);
      pendingSyncData = null;
      const ts = typeof dataToWrite === 'string' ? (JSON.parse(dataToWrite).lastUpdated || 0) : (dataToWrite.lastUpdated || 0);
      lastSyncWriteTimestamp = ts;
      lastSyncHash = computeDataHash(dataToWrite);
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
 * 서버 사이드 데이터 병합 (useStorage.js mergeOnRenderer와 동일 로직)
 * updatedAt 기준으로 각 항목의 최신 버전을 선택
 */
function mergeData(local, remote) {
  if (!remote) return local;
  if (!local) return remote;
  const merged = { ...remote };

  const mergeArrays = (lArr, rArr) => {
    const map = new Map();
    (rArr || []).forEach(item => map.set(item.id, item));
    (lArr || []).forEach(item => {
      const existing = map.get(item.id);
      if (!existing || (item.updatedAt || 0) > (existing.updatedAt || 0)) map.set(item.id, item);
    });
    return Array.from(map.values());
  };

  const mergeDateKeyed = (lObj, rObj) => {
    const result = {};
    const allKeys = new Set([...Object.keys(lObj || {}), ...Object.keys(rObj || {})]);
    for (const key of allKeys) {
      const lItems = (lObj || {})[key] || [];
      const rItems = (rObj || {})[key] || [];
      const map = new Map();
      rItems.forEach(item => map.set(item.taskId, item));
      lItems.forEach(item => {
        const existing = map.get(item.taskId);
        if (!existing || (item.updatedAt || 0) > (existing.updatedAt || 0)) map.set(item.taskId, item);
      });
      const items = Array.from(map.values());
      if (items.length > 0) result[key] = items;
    }
    return result;
  };

  merged.projects = mergeArrays(local.projects, remote.projects);
  merged.events = mergeArrays(local.events, remote.events);
  merged.recurring = mergeArrays(local.recurring, remote.recurring);
  merged.scheduled = mergeDateKeyed(local.scheduled, remote.scheduled);
  merged.completedToday = mergeDateKeyed(local.completedToday, remote.completedToday);
  merged.lastUpdated = Math.max(local.lastUpdated || 0, remote.lastUpdated || 0);

  // recurringSkips/Adds: 날짜별 id 배열 합집합 (중복 제거, remote 우선)
  const mergeOverrides = (lObj, rObj) => {
    const result = {};
    const allKeys = new Set([...Object.keys(lObj || {}), ...Object.keys(rObj || {})]);
    for (const key of allKeys) {
      const lIds = (lObj || {})[key] || [];
      const rIds = (rObj || {})[key] || [];
      const merged = [...new Set([...rIds, ...lIds])];
      if (merged.length > 0) result[key] = merged;
    }
    return result;
  };
  if (local.recurringSkips || remote.recurringSkips) {
    merged.recurringSkips = mergeOverrides(local.recurringSkips, remote.recurringSkips);
  }
  if (local.recurringAdds || remote.recurringAdds) {
    merged.recurringAdds = mergeOverrides(local.recurringAdds, remote.recurringAdds);
  }
  if (local.quickTasks || remote.quickTasks) {
    merged.quickTasks = mergeArrays(local.quickTasks, remote.quickTasks);
  }

  // GCal 매핑: lastSynced 기준 LWW
  if (local.gcalMappings || remote.gcalMappings) {
    const lMap = local.gcalMappings || {};
    const rMap = remote.gcalMappings || {};
    const allKeys = new Set([...Object.keys(lMap), ...Object.keys(rMap)]);
    const mergedMappings = {};
    for (const key of allKeys) {
      const l = lMap[key];
      const r = rMap[key];
      if (!l) { mergedMappings[key] = r; continue; }
      if (!r) { mergedMappings[key] = l; continue; }
      mergedMappings[key] = (l.lastSynced || '') >= (r.lastSynced || '') ? l : r;
    }
    merged.gcalMappings = mergedMappings;
  }

  // GCal 오프라인 큐: 양쪽 합집합 (중복 action+localId 제거)
  if (local.gcalQueue || remote.gcalQueue) {
    const seen = new Set();
    const mergedQueue = [];
    for (const entry of [...(remote.gcalQueue || []), ...(local.gcalQueue || [])]) {
      const key = `${entry.action}:${entry.localId}`;
      if (!seen.has(key)) { seen.add(key); mergedQueue.push(entry); }
    }
    merged.gcalQueue = mergedQueue;
  }

  return merged;
}

/**
 * sync.json 쓰기 전 외부 변경 확인 + 필요 시 병합
 */
function writeSyncFileWithCheck(incomingData) {
  if (!getCustomDataPath()) return;

  // 데이터 내용이 이전과 동일하면 sync.json 쓰기 생략
  const parsed = typeof incomingData === 'string' ? JSON.parse(incomingData) : incomingData;
  const currentHash = computeDataHash(parsed);
  if (currentHash === lastSyncHash) return;

  try {
    const syncData = readJsonFile(SYNC_FILE, null);
    const syncTimestamp = syncData?.lastUpdated || 0;

    if (syncTimestamp > lastSyncWriteTimestamp && syncData) {
      // 다른 PC가 sync.json을 업데이트함 → 병합 후 저장
      console.log(`[Sync] 외부 변경 감지 (sync: ${syncTimestamp}, lastWrite: ${lastSyncWriteTimestamp}) → 병합`);
      const merged = mergeData(parsed, syncData);
      merged.lastUpdated = Math.max(Date.now(), lastSyncWriteTimestamp + 1); // 단조 증가 보장

      // 병합 결과를 SQLite + sync.json에 저장
      sqliteStorage.saveAllData(merged);
      writeSyncFile(merged);

      // renderer에 병합 결과 통지
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('external-data-changed', merged);
      }
      return;
    }
  } catch (e) {
    console.warn('[Sync] sync.json 사전 확인 실패, 직접 쓰기 진행:', e.message);
  }

  // 외부 변경 없음 → 기존대로 저장
  writeSyncFile(incomingData);
}

/**
 * 이전에 실패한 sync 쓰기가 있으면 재시도합니다.
 * save-app-data 핸들러 진입 시 호출됩니다.
 */
function flushPendingSync() {
  if (!pendingSyncData) return;
  console.log('[Sync] 이전 실패한 sync.json 쓰기 재시도...');
  try {
    const ts = typeof pendingSyncData === 'string' ? (JSON.parse(pendingSyncData).lastUpdated || 0) : (pendingSyncData.lastUpdated || 0);
    writeJsonFile(SYNC_FILE, pendingSyncData);
    lastSyncWriteTimestamp = ts;
    pendingSyncData = null;
    console.log('[Sync] 재시도 성공.');
  } catch (e) {
    console.error('[Sync] 재시도 실패:', e.message);
  }
}

// ── 충돌 파일 패턴 (Google Drive, OneDrive, Dropbox 등) ──
const CONFLICT_PATTERN = /^taskdata\.sync.*\.json$/;
function isConflictFile(filePath) {
  const basename = path.basename(filePath);
  return CONFLICT_PATTERN.test(basename) && basename !== SYNC_FILE;
}

/**
 * 클라우드 드라이브가 생성한 충돌 파일을 병합 후 삭제합니다.
 * Google Drive: "taskdata.sync (1).json"
 * OneDrive: "taskdata.sync-PCNAME.json"
 * Dropbox: "taskdata.sync (conflicted copy).json"
 */
function processConflictFile(filePath) {
  try {
    const conflictData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const currentData = sqliteStorage.loadAllData();
    if (!conflictData || !currentData) return;

    console.log(`[Conflict] 충돌 파일 병합 시작: ${path.basename(filePath)}`);
    const merged = mergeData(currentData, conflictData);
    merged.lastUpdated = Date.now();

    // 병합 결과를 SQLite + sync.json에 저장
    sqliteStorage.saveAllData(merged);
    writeSyncFile(merged);

    // 충돌 파일 삭제
    try { fs.unlinkSync(filePath); } catch (_) {}
    console.log(`[Conflict] 충돌 파일 병합 완료 + 삭제: ${path.basename(filePath)}`);

    // renderer에 통지
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('external-data-changed', merged);
    }
  } catch (e) {
    console.error(`[Conflict] 충돌 파일 처리 실패 (${path.basename(filePath)}):`, e.message);
  }
}

/**
 * 지정 디렉토리에서 충돌 파일을 스캔하여 일괄 처리합니다.
 * 앱 시작 시 1회 호출.
 */
function scanAndProcessConflictFiles(dirPath) {
  try {
    const files = fs.readdirSync(dirPath);
    const conflictFiles = files.filter(f => isConflictFile(f));
    if (conflictFiles.length === 0) return;
    console.log(`[Conflict] 시작 시 충돌 파일 ${conflictFiles.length}건 발견`);
    for (const cf of conflictFiles) {
      processConflictFile(path.join(dirPath, cf));
    }
  } catch (e) {
    console.warn('[Conflict] 충돌 파일 스캔 실패:', e.message);
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

  // 클라우드 동기화 모드: 디렉토리 감시 (sync.json + 충돌 파일)
  dataWatcher = chokidar.watch(customPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    depth: 0, // 최상위 디렉토리만
  });

  const handleSyncFileChange = () => {
    if (selfWriteFlag) return; // 보조 안전장치
    try {
      const newData = readJsonFile(SYNC_FILE, null);
      if (!newData || !mainWindow || mainWindow.isDestroyed()) return;

      // 1차 판별: writerDeviceId로 자기가 쓴 파일인지 확인
      if (newData._writerDeviceId === deviceId) return;

      // Clock Skew 경고: 외부 데이터의 lastUpdated가 현재 시각보다 1분 이상 미래이면 경고
      const syncTs = newData.lastUpdated || 0;
      const skew = syncTs - Date.now();
      if (skew > 60000) {
        console.warn(`[Sync] Clock Skew 감지: 외부 데이터가 ${Math.round(skew / 1000)}초 미래`);
        mainWindow.webContents.send('clock-skew-warning', { skewMs: skew });
      }

      // 외부 변경 → 타임스탬프 갱신 + SQLite에도 반영 + GCal 캐시 무효화 + renderer 통지
      lastSyncWriteTimestamp = newData.lastUpdated || 0;
      sqliteStorage.saveAllData(newData);
      // 매핑은 항상 DB에서 직접 읽으므로 캐시 무효화 불필요
      mainWindow.webContents.send('external-data-changed', newData);
      console.log(`[Watcher] 외부 변경 감지 (device: ${(newData._writerDeviceId || 'unknown').slice(0, 8)}) → 동기화 완료`);
    } catch (e) {
      console.error('[Watcher] 동기화 실패:', e.message);
    }
  };

  dataWatcher.on('change', (filePath) => {
    const basename = path.basename(filePath);
    if (basename === SYNC_FILE) {
      handleSyncFileChange();
    } else if (isConflictFile(filePath)) {
      processConflictFile(filePath);
    }
  });

  dataWatcher.on('add', (filePath) => {
    if (isConflictFile(filePath)) {
      processConflictFile(filePath);
    }
  });

  console.log('[Watcher] 클라우드 모드 — 디렉토리 감시 시작:', customPath);
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
    const t0 = Date.now();
    // 이전에 실패한 sync 쓰기가 있으면 먼저 재시도
    flushPendingSync();

    const incomingData = typeof data === 'string' ? JSON.parse(data) : data;
    const t1 = Date.now();

    // 충돌 판정: getLastUpdated()로 경량 체크 (전체 loadAllData 불필요)
    const diskLastUpdated = sqliteStorage.getLastUpdated();
    if (diskLastUpdated && incomingData.lastUpdated && diskLastUpdated !== incomingData.lastUpdated) {
      if (incomingData.lastUpdated > diskLastUpdated) {
        // 자기 자신의 연속 저장 → 단순 업데이트
        const t2 = Date.now();
        sqliteStorage.saveAllData(incomingData);
        const t3 = Date.now();
        writeSyncFileWithCheck(incomingData);
        const t4 = Date.now();
        if (t4 - t0 > 100) console.log(`[perf] save-app-data: parse=${t1-t0}ms sqlite=${t3-t2}ms sync=${t4-t3}ms total=${t4-t0}ms`);
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

    const tA = Date.now();
    sqliteStorage.saveAllData(incomingData);
    const tB = Date.now();
    writeSyncFileWithCheck(incomingData);
    const tC = Date.now();
    if (tC - t0 > 100) console.log(`[perf] save-app-data: parse=${t1-t0}ms sqlite=${tB-tA}ms sync=${tC-tB}ms total=${tC-t0}ms`);
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
    // DB는 항상 userData에 고정 — customPath는 sync.json 위치만 결정
    setCustomDataPath(newPath);

    if (!fs.existsSync(newPath)) {
      fs.mkdirSync(newPath, { recursive: true });
    }

    // 현재 DB 데이터를 sync.json으로 초기화
    const currentData = sqliteStorage.loadAllData();
    if (currentData) writeSyncFile(currentData);

    watchDataFile(); // 새 경로 감시 시작
    return { success: true, path: newPath, data: currentData };
  } catch (e) {
    console.error('[Data] 경로 변경 실패:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('reset-data-path', () => {
  // DB는 항상 userData에 있으므로 close/open 불필요
  setCustomDataPath(null);

  const data = sqliteStorage.loadAllData();
  watchDataFile(); // 감시 중단 (로컬 모드로 전환)
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
    // 마크다운 → 간단 HTML 변환 (GitHub API 폴백에서 받은 경우)
    if (releaseNotes && !releaseNotes.includes('<')) {
      releaseNotes = releaseNotes
        .replace(/^### (.+)$/gm, '<strong>$1</strong>')
        .replace(/^## (.+)$/gm, '<strong>$1</strong>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
        .replace(/\n{2,}/g, '<br/>');
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
  // ── SQLite 초기화 (DB는 항상 userData에 고정 — 클라우드 폴더 WAL 손상 방지) ──
  const userDataDir = app.getPath('userData');
  const dbPath = path.join(userDataDir, DB_FILE);

  // 기존 사용자 마이그레이션: customPath에 DB가 있는 경우 userData로 이동
  const customPath_migration = getCustomDataPath();
  if (customPath_migration) {
    const oldDbPath = path.join(customPath_migration, DB_FILE);
    if (fs.existsSync(oldDbPath) && !fs.existsSync(dbPath)) {
      try {
        fs.copyFileSync(oldDbPath, dbPath);
        // WAL/SHM 파일은 복사하지 않음 (WAL checkpoint 후 불필요)
        const walPath = oldDbPath + '-wal';
        const shmPath = oldDbPath + '-shm';
        if (fs.existsSync(walPath)) try { fs.unlinkSync(walPath); } catch (_) {}
        if (fs.existsSync(shmPath)) try { fs.unlinkSync(shmPath); } catch (_) {}
        // 원본은 안전장치로 보존
        try { fs.renameSync(oldDbPath, oldDbPath + '.migrated'); } catch (_) {}
        console.log('[Startup] 클라우드 폴더의 DB를 userData로 마이그레이션 완료');
      } catch (e) {
        console.error('[Startup] DB 마이그레이션 실패:', e.message);
      }
    } else if (fs.existsSync(oldDbPath) && fs.existsSync(dbPath)) {
      // 양쪽 모두 존재 → userData의 DB가 이미 있으므로, 클라우드의 것은 정리만
      // (더 최신인 쪽을 sync.json 비교에서 처리)
      const walPath = oldDbPath + '-wal';
      const shmPath = oldDbPath + '-shm';
      if (fs.existsSync(walPath)) try { fs.unlinkSync(walPath); } catch (_) {}
      if (fs.existsSync(shmPath)) try { fs.unlinkSync(shmPath); } catch (_) {}
      try { fs.renameSync(oldDbPath, oldDbPath + '.migrated'); } catch (_) {}
      console.log('[Startup] 클라우드 폴더의 DB를 .migrated로 이름 변경 (userData DB 사용)');
    }
  }

  // JSON → SQLite 마이그레이션 (taskdata.json이 있고 DB가 비어있을 때만)
  const jsonPath = path.join(userDataDir, DATA_FILE);
  const migrationResult = migrateJsonToSqlite(jsonPath, dbPath);
  if (migrationResult.status === 'success') {
    console.log('[Startup] JSON → SQLite 마이그레이션 완료. 백업:', migrationResult.backupPath);
  } else if (migrationResult.status === 'failed') {
    console.error('[Startup] 마이그레이션 실패 — JSON 폴백 모드로 계속합니다:', migrationResult.reason);
  }

  // DB 열기 (항상 userData 경로)
  openDatabase(dbPath);

  // settings.json → SQLite 마이그레이션
  const settingsJsonPath = path.join(userDataDir, SETTINGS_FILE);
  migrateSettingsToSqlite(settingsJsonPath, getDatabase());

  // ── GCal 매핑 JSON → SQLite 마이그레이션 (1회) ──
  migrateGcalFilesToDb(userDataDir);

  // ── 디바이스 ID 초기화 ──
  deviceId = getOrCreateDeviceId();
  console.log('[Startup] 디바이스 ID:', deviceId.slice(0, 8) + '...');

  // ── lastSyncWriteTimestamp 복원 (영속화) ──
  lastSyncWriteTimestamp = parseInt(sqliteStorage.getMeta('last_sync_seen_ts') || '0', 10);

  // ── 클라우드 동기화: sync.json과 DB 비교 → 최신 데이터 반영 ──
  const customPath = getCustomDataPath();
  if (customPath) {
    try {
      const syncFilePath = path.join(customPath, SYNC_FILE);
      if (fs.existsSync(syncFilePath)) {
        const syncData = JSON.parse(fs.readFileSync(syncFilePath, 'utf-8'));
        const dbLastUpdated = sqliteStorage.getLastUpdated();
        const syncLastUpdated = syncData?.lastUpdated || 0;
        lastSyncWriteTimestamp = syncLastUpdated;

        // 스키마 마이그레이션 직후에는 sync.json을 무조건 우선
        // (구버전이 lastUpdated만 최신으로 올리고 데이터는 불완전한 경우 방지)
        const justMigrated = (() => {
          try {
            const row = getDatabase()?.prepare("SELECT value FROM meta WHERE key = 'schema_just_migrated'").get();
            if (row?.value === '1') {
              getDatabase().prepare("DELETE FROM meta WHERE key = 'schema_just_migrated'").run();
              return true;
            }
          } catch (_) {}
          return false;
        })();

        if (justMigrated && syncLastUpdated > 0) {
          console.log(`[Startup] 스키마 마이그레이션 직후 → sync.json 강제 로드 + 매핑 초기화`);
          sqliteStorage.saveAllData(syncData);
          // GCal 매핑 초기화 → 다음 fetchGcalEvents에서 전체 재연동 모드 활성화
          try { getDatabase()?.exec('DELETE FROM gcal_mappings'); } catch (_) {}
          try { getDatabase()?.exec('DELETE FROM gcal_queue'); } catch (_) {}
        } else if (syncLastUpdated > dbLastUpdated) {
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

  setupAutoUpdater();

  // ── 시작 시 업데이트 확인 (데이터 동기화 전) ──
  // 구버전이 데이터를 잘못 동기화하는 문제를 방지하기 위해
  // 렌더러 로드와 데이터 동기화보다 업데이트를 먼저 확인합니다.
  const proceedWithStartup = () => {
    createWindow();
    createTray();

    sqliteStorage.archiveOldData(ARCHIVE_DAYS);

    if (customPath) scanAndProcessConflictFiles(customPath);

    watchDataFile();

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
  };

  if (isDev) {
    proceedWithStartup();
  } else {
    // 프로덕션: 업데이트 확인 후 진행
    autoUpdater.checkForUpdates().then((result) => {
      const currentVersion = app.getVersion();
      const latestVersion = result?.updateInfo?.version;
      const available = latestVersion && latestVersion !== currentVersion &&
        latestVersion.localeCompare(currentVersion, undefined, { numeric: true }) > 0;

      if (available) {
        // 업데이트 발견 → 사용자에게 먼저 확인
        const choice = dialog.showMessageBoxSync({
          type: 'info',
          title: 'TaskNote 업데이트',
          message: `새 버전 v${latestVersion}이 있습니다.\n업데이트 후 실행하시겠습니까?`,
          detail: '데이터 동기화 전에 최신 버전으로 업데이트하면\n데이터 충돌을 방지할 수 있습니다.',
          buttons: ['업데이트 후 실행', '나중에'],
          defaultId: 0,
          cancelId: 1,
        });

        if (choice === 0) {
          // 업데이트 다운로드 → 설치 → 재시작
          console.log('[AutoUpdater] 시작 전 업데이트 시작:', latestVersion);
          autoUpdater.downloadUpdate().then(() => {
            autoUpdater.quitAndInstall(true, true);
          }).catch((e) => {
            console.error('[AutoUpdater] 다운로드 실패:', e.message);
            proceedWithStartup(); // 실패 시 정상 시작
          });
        } else {
          proceedWithStartup(); // 나중에 → 정상 시작
        }
      } else {
        proceedWithStartup(); // 업데이트 없음 → 정상 시작
      }
    }).catch(() => {
      proceedWithStartup(); // 확인 실패 → 정상 시작
    });
  }
});
app.on('window-all-closed', () => {
  if (dataWatcher) dataWatcher.close(); // 감시 종료
  closeDatabase(); // DB 안전 종료
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
