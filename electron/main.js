const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { loginWithGoogle, logoutGoogle, getGoogleAuthStatus } = require('./google-auth');
const { createGcalEvent, updateGcalEvent, deleteGcalEvent, deleteMultipleGcalEvents, processOfflineQueue, fetchGcalEvents, fetchHolidays, saveImportMapping, cleanupStaleMapping } = require('./gcal-sync');
const os = require('os');
const chokidar = require('chokidar');

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
  // settings.json에도 기록하여 재패키징 후 자동 복원
  try {
    const settings = readJsonFile(SETTINGS_FILE, {});
    settings.autoLaunch = enabled;
    writeJsonFile(SETTINGS_FILE, settings);
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
const SETTINGS_FILE = 'settings.json';
const CUSTOM_PATH_FILE = 'custom-data-path.json';
const ARCHIVE_FILE = 'archive.json';
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

function watchDataFile() {
  if (dataWatcher) dataWatcher.close();
  const filePath = getFilePath(DATA_FILE);
  dataWatcher = chokidar.watch(filePath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  dataWatcher.on('change', () => {
    if (selfWriteFlag) return;
    try {
      const newData = readJsonFile(DATA_FILE, null);
      if (newData && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('external-data-changed', newData);
      }
    } catch (e) {
      console.error('[Watcher] 데이터 동기화 실패:', e.message);
    }
  });
}

// ── 자동 아카이빙 (Auto-Archiving) ──
function archiveOldData() {
  try {
    const data = readJsonFile(DATA_FILE, null);
    if (!data) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - ARCHIVE_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10); // "YYYY-MM-DD"

    // 날짜 키 기반 객체에서 오래된 항목 분리
    const splitByDate = (obj) => {
      if (!obj || typeof obj !== 'object') return { keep: obj || {}, old: {} };
      const keep = {};
      const old = {};
      for (const dateKey of Object.keys(obj)) {
        if (dateKey < cutoffStr) old[dateKey] = obj[dateKey];
        else keep[dateKey] = obj[dateKey];
      }
      return { keep, old };
    };

    // events 배열에서 오래된 항목 분리 (삭제된 툼스톤만 아카이빙, 활성 이벤트는 유지)
    const splitEvents = (events) => {
      if (!Array.isArray(events)) return { keep: [], old: [] };
      const keep = [];
      const old = [];
      for (const ev of events) {
        // 삭제된 툼스톤이 90일 지났으면 아카이빙 (하드 삭제)
        if (ev.deleted && ev.date && ev.date < cutoffStr) { old.push(ev); continue; }
        // 활성 이벤트는 날짜와 무관하게 유지 (과거 일정도 참조 가능하도록)
        keep.push(ev);
      }
      return { keep, old };
    };

    const completedSplit = splitByDate(data.completedToday);
    const scheduledSplit = splitByDate(data.scheduled);
    const skipsSplit = splitByDate(data.recurringSkips);
    const addsSplit = splitByDate(data.recurringAdds);
    const eventsSplit = splitEvents(data.events);

    // 아카이빙할 데이터가 없으면 조기 종료
    const hasOld =
      Object.keys(completedSplit.old).length > 0 ||
      Object.keys(scheduledSplit.old).length > 0 ||
      Object.keys(skipsSplit.old).length > 0 ||
      Object.keys(addsSplit.old).length > 0 ||
      eventsSplit.old.length > 0;

    if (!hasOld) {
      console.log('[Archive] 아카이빙할 데이터 없음. 스킵.');
      return;
    }

    // 기존 archive.json 로드 후 병합
    const archive = readJsonFile(ARCHIVE_FILE, {
      completedToday: {},
      scheduled: {},
      recurringSkips: {},
      recurringAdds: {},
      events: [],
      archivedAt: null,
    });

    // 날짜 키 객체 병합 (기존 아카이브 + 새 아카이브)
    const mergeObj = (existing, incoming) => {
      const merged = { ...existing };
      for (const [key, val] of Object.entries(incoming)) {
        if (merged[key] && Array.isArray(merged[key])) {
          merged[key] = [...merged[key], ...val];
        } else {
          merged[key] = val;
        }
      }
      return merged;
    };

    archive.completedToday = mergeObj(archive.completedToday || {}, completedSplit.old);
    archive.scheduled = mergeObj(archive.scheduled || {}, scheduledSplit.old);
    archive.recurringSkips = mergeObj(archive.recurringSkips || {}, skipsSplit.old);
    archive.recurringAdds = mergeObj(archive.recurringAdds || {}, addsSplit.old);
    archive.events = [...(archive.events || []), ...eventsSplit.old];
    archive.archivedAt = new Date().toISOString();

    // 1) archive.json 먼저 저장 (데이터 유실 방지)
    writeJsonFile(ARCHIVE_FILE, archive);

    // 2) taskdata.json에서 아카이빙 완료된 데이터 제거
    data.completedToday = completedSplit.keep;
    data.scheduled = scheduledSplit.keep;
    data.recurringSkips = skipsSplit.keep;
    data.recurringAdds = addsSplit.keep;
    data.events = eventsSplit.keep;
    data.lastUpdated = Date.now();

    writeJsonFile(DATA_FILE, data);

    const totalArchived =
      Object.keys(completedSplit.old).length +
      Object.keys(scheduledSplit.old).length +
      Object.keys(skipsSplit.old).length +
      Object.keys(addsSplit.old).length +
      eventsSplit.old.length;
    console.log(`[Archive] ${totalArchived}개 날짜 키/항목을 archive.json으로 이동 완료.`);
  } catch (e) {
    console.error('[Archive] 아카이빙 실패:', e.message);
  }
}

// ── 데이터 병합 (Merge) 로직 ──
function mergeTaskData(local, disk) {
  if (!disk) return local;
  if (!local) return disk;

  const merged = { ...disk };

  // 1. 단순 배열 병합 (최신 updatedAt 기준)
  const mergeArrays = (localArr, diskArr) => {
    const map = new Map();
    (diskArr || []).forEach(item => map.set(item.id, item));
    (localArr || []).forEach(item => {
      const existing = map.get(item.id);
      if (!existing || (item.updatedAt || 0) > (existing.updatedAt || 0)) {
        map.set(item.id, item);
      }
    });
    return Array.from(map.values());
  };

  // 2. 재귀적 서브태스크 병합
  const mergeSubtasks = (localSub, diskSub) => {
    const map = new Map();
    (diskSub || []).forEach(item => map.set(item.id, item));
    (localSub || []).forEach(item => {
      const existing = map.get(item.id);
      if (!existing || (item.updatedAt || 0) > (existing.updatedAt || 0)) {
        const newItem = { ...item };
        // 삭제된 항목이면 자식 병합 생략
        if (newItem.deleted) {
          map.set(item.id, newItem);
          return;
        }
        if (existing && existing.children) {
          newItem.children = mergeSubtasks(item.children, existing.children);
        }
        map.set(item.id, newItem);
      } else if (existing && !existing.deleted) {
        existing.children = mergeSubtasks(item.children, existing.children);
      }
    });
    return Array.from(map.values());
  };

  // 프로젝트 병합 시 서브태스크도 병합
  merged.projects = mergeArrays(local.projects, disk.projects).map(p => {
    const localP = (local.projects || []).find(x => x.id === p.id);
    const diskP = (disk.projects || []).find(x => x.id === p.id);
    if (localP && diskP) {
      return {
        ...(localP.updatedAt > diskP.updatedAt ? localP : diskP),
        subtasks: mergeSubtasks(localP.subtasks, diskP.subtasks)
      };
    }
    return p;
  });

  merged.events = mergeArrays(local.events, disk.events);
  merged.recurring = mergeArrays(local.recurring, disk.recurring);

  // 3. 날짜 키 기반 객체 병합 (scheduled, completedToday, recurringSkips, recurringAdds)
  const mergeDateObjects = (localObj, diskObj) => {
    const res = { ...(diskObj || {}) };
    if (!localObj) return res;
    for (const [date, items] of Object.entries(localObj)) {
      if (!res[date]) {
        res[date] = items;
      } else if (Array.isArray(items)) {
        // 원시값 배열 (recurringSkips 등)은 합집합으로 병합
        if (items.length > 0 && typeof items[0] !== 'object') {
          const set = new Set([...(res[date] || []), ...items]);
          res[date] = Array.from(set);
        } else {
          // 객체 배열: taskId 기준으로 최신것 유지
          const map = new Map();
          (res[date] || []).forEach(item => {
            const key = item.taskId || item.id;
            if (key) map.set(key, item);
          });
          items.forEach(item => {
            const key = item.taskId || item.id;
            if (!key) return; // 키 없는 항목은 무시
            const existing = map.get(key);
            if (!existing || (item.updatedAt || 0) > (existing.updatedAt || 0)) {
              map.set(key, item);
            }
          });
          res[date] = Array.from(map.values());
        }
      }
    }
    return res;
  };

  merged.scheduled = mergeDateObjects(local.scheduled, disk.scheduled);
  merged.completedToday = mergeDateObjects(local.completedToday, disk.completedToday);
  merged.recurringSkips = mergeDateObjects(local.recurringSkips, disk.recurringSkips);
  merged.recurringAdds = mergeDateObjects(local.recurringAdds, disk.recurringAdds);

  // todayTasks 정밀 병합 (taskId 기준)
  const localToday = local.todayTasks || [];
  const diskToday = disk.todayTasks || [];
  const todayMap = new Map();
  diskToday.forEach(t => todayMap.set(t.taskId, t));
  localToday.forEach(t => {
    const existing = todayMap.get(t.taskId);
    if (!existing || (t.updatedAt || 0) > (existing.updatedAt || 0)) {
      todayMap.set(t.taskId, t);
    }
  });
  merged.todayTasks = Array.from(todayMap.values());
  
  merged.lastUpdated = Date.now();
  return merged;
}

ipcMain.handle('load-app-data', () => readJsonFile(DATA_FILE, null));
ipcMain.handle('save-app-data', (_e, data) => {
  try {
    const diskData = readJsonFile(DATA_FILE, null);
    const incomingData = typeof data === 'string' ? JSON.parse(data) : data;

    // B-3: 양방향 충돌 판정 (!==)
    // 단, 같은 렌더러의 연속 저장(자기 충돌)은 무시 — incoming이 더 최신이면 단순 덮어쓰기
    if (diskData && diskData.lastUpdated && incomingData.lastUpdated && diskData.lastUpdated !== incomingData.lastUpdated) {
      // incoming이 disk보다 최신이면 자기 자신의 연속 저장 → 충돌이 아니라 단순 업데이트
      if (incomingData.lastUpdated > diskData.lastUpdated) {
        writeJsonFile(DATA_FILE, data);
        return { success: true };
      }
      // disk가 더 최신 → 외부 변경이 있었으므로 병합 필요
      console.warn('[Data] Conflict detected! Merging data...');
      const mergedData = mergeTaskData(incomingData, diskData);
      writeJsonFile(DATA_FILE, mergedData);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('external-data-changed', mergedData);
      }
      return { success: true, merged: true, data: mergedData };
    }

    writeJsonFile(DATA_FILE, data);
    return { success: true };
  } catch (e) {
    console.error('[Data] save-app-data failed:', e.message);
    return { success: false, error: e.message };
  }
});
ipcMain.handle('load-settings', () => readJsonFile(SETTINGS_FILE, null));
ipcMain.handle('save-settings', (_e, settings) => {
  writeJsonFile(SETTINGS_FILE, settings);
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
    const oldPath = getFilePath(DATA_FILE);
    const oldSettingsPath = getFilePath(SETTINGS_FILE);

    // 새 경로 설정
    setCustomDataPath(newPath);

    // 새 경로에 파일이 없으면 기존 파일 복사
    const newDataPath = path.join(newPath, DATA_FILE);
    const newSettingsPath = path.join(newPath, SETTINGS_FILE);

    if (!fs.existsSync(path.dirname(newDataPath))) {
      fs.mkdirSync(path.dirname(newDataPath), { recursive: true });
    }

    if (!fs.existsSync(newDataPath) && fs.existsSync(oldPath)) {
      fs.copyFileSync(oldPath, newDataPath);
      console.log('[Data] 기존 데이터 복사 완료:', newDataPath);
    }
    if (!fs.existsSync(newSettingsPath) && fs.existsSync(oldSettingsPath)) {
      fs.copyFileSync(oldSettingsPath, newSettingsPath);
    }

    // 새 경로의 데이터 읽어서 반환 (즉시 적용용)
    let newData = null;
    if (fs.existsSync(newDataPath)) {
      newData = JSON.parse(fs.readFileSync(newDataPath, 'utf-8'));
    }

    watchDataFile(); // 새 경로 감시 시작
    return { success: true, path: newPath, data: newData };
  } catch (e) {
    console.error('[Data] 경로 변경 실패:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('reset-data-path', () => {
  setCustomDataPath(null);
  // 기본 경로의 데이터 읽어서 반환
  const defaultPath = path.join(app.getPath('userData'), DATA_FILE);
  let data = null;
  try {
    if (fs.existsSync(defaultPath)) data = JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));
  } catch (e) {}
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
  createWindow();
  createTray();
  setupAutoUpdater();
  archiveOldData(); // 앱 시작 시 오래된 데이터 아카이빙
  watchDataFile(); // 파일 감시 시작 (아카이빙 후)

  // 자동 시작 설정 복원 (재패키징 후 레지스트리 경로가 바뀌어도 settings.json 기준으로 복원)
  try {
    const settings = readJsonFile(SETTINGS_FILE, {});
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
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
