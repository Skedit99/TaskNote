/**
 * migrate-json-to-sqlite.js — JSON → SQLite 자동 마이그레이션
 *
 * 앱 시작 시 호출되어, taskdata.json이 존재하고 DB가 비어있으면
 * 데이터를 정규화하여 SQLite로 이관합니다.
 *
 * 안전장치:
 * 1. 임시 DB에 먼저 쓰기 (원본 JSON 보호)
 * 2. 트랜잭션으로 원자적 삽입
 * 3. 레코드 수 검증
 * 4. 성공 시에만 JSON을 .backup으로 이동
 * 5. 어느 시점에서 실패해도 원본 데이터 보존
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

/**
 * JSON 데이터를 정규화합니다 (selectors.js의 migrateToNormalizedData 동일 로직).
 * 프론트엔드 코드를 CJS로 직접 require할 수 없으므로 여기에 복제합니다.
 */
function normalizeData(data) {
  if (!data) return data;

  const normalize = (item) => {
    if (!item) return item;
    const newItem = { projectId: item.projectId, taskId: item.taskId };
    if (item.completedAt) newItem.completedAt = item.completedAt;
    if (item.time) newItem.time = item.time;
    if (item.completed !== undefined) newItem.completed = item.completed;
    if (item.updatedAt) newItem.updatedAt = item.updatedAt;
    if (item.addedDate) newItem.addedDate = item.addedDate;
    if (item.endTime) newItem.endTime = item.endTime;
    return newItem;
  };

  const newData = { ...data };

  if (newData.todayTasks) {
    newData.todayTasks = newData.todayTasks.map(normalize);
  }
  if (newData.scheduled) {
    const newScheduled = {};
    for (const key in newData.scheduled) {
      if (Array.isArray(newData.scheduled[key])) {
        newScheduled[key] = newData.scheduled[key].map(normalize);
      }
    }
    newData.scheduled = newScheduled;
  }
  if (newData.completedToday) {
    const newCompleted = {};
    for (const key in newData.completedToday) {
      if (Array.isArray(newData.completedToday[key])) {
        newCompleted[key] = newData.completedToday[key].map(normalize);
      }
    }
    newData.completedToday = newCompleted;
  }

  return newData;
}

/**
 * 유효성 검증 — 키 없는 항목, 잘못된 dateKey 등 검출
 */
function validateData(data) {
  const warnings = [];

  // todayTasks 검증
  if (data.todayTasks) {
    data.todayTasks = data.todayTasks.filter(t => {
      if (!t.projectId || !t.taskId) {
        warnings.push(`todayTask 키 누락: ${JSON.stringify(t)}`);
        return false;
      }
      return true;
    });
  }

  // scheduled 검증
  if (data.scheduled) {
    for (const key of Object.keys(data.scheduled)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
        warnings.push(`scheduled 잘못된 dateKey: ${key}`);
        delete data.scheduled[key];
      }
    }
  }

  // completedToday 검증
  if (data.completedToday) {
    for (const key of Object.keys(data.completedToday)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
        warnings.push(`completedToday 잘못된 dateKey: ${key}`);
        delete data.completedToday[key];
      }
    }
  }

  if (warnings.length > 0) {
    console.warn('[Migration] 데이터 검증 경고:', warnings);
  }

  return { data, warnings };
}

/**
 * 스키마를 임시 DB에 생성합니다.
 */
function createSchemaInDb(db) {
  // database.js의 SCHEMA_V1과 동일한 스키마
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, deadline TEXT, color_id TEXT,
      archived INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0,
      subtasks TEXT DEFAULT '[]', updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS today_tasks (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
      completed INTEGER DEFAULT 0, completed_at TEXT, added_date TEXT, time TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS completed_today (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT, date_key TEXT NOT NULL,
      project_id TEXT NOT NULL, task_id TEXT NOT NULL, completed_at TEXT, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS recurring (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, day_value TEXT,
      time TEXT DEFAULT '', end_time TEXT DEFAULT '', interval_val INTEGER DEFAULT 1,
      start_date TEXT, end_date TEXT, active INTEGER DEFAULT 1, monthly_mode TEXT,
      nth_week INTEGER, nth_day_of_week INTEGER, color_id TEXT, gcal_event_ids TEXT,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS recurring_overrides (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT, date_key TEXT NOT NULL,
      recurring_id TEXT NOT NULL, type TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ro_unique ON recurring_overrides(date_key, recurring_id, type);
    CREATE TABLE IF NOT EXISTS scheduled (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT, date_key TEXT NOT NULL,
      project_id TEXT NOT NULL, task_id TEXT NOT NULL, time TEXT DEFAULT '',
      end_time TEXT DEFAULT '', updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', date TEXT,
      time TEXT DEFAULT '', end_time TEXT DEFAULT '', gcal_source_id TEXT, quick_task_id TEXT,
      deleted INTEGER DEFAULT 0, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS quick_tasks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, time TEXT DEFAULT '', end_time TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
}

/**
 * 데이터를 DB에 삽입합니다.
 */
function insertDataIntoDb(db, data) {
  // projects
  const insProject = db.prepare(`INSERT INTO projects (id, name, deadline, color_id, archived, deleted, sort_order, subtasks, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  (data.projects || []).forEach((p, i) => {
    insProject.run(p.id, p.name, p.deadline || null, p.colorId || null,
      p.archived ? 1 : 0, p.deleted ? 1 : 0, i,
      JSON.stringify(p.subtasks || []), p.updatedAt || null);
  });

  // todayTasks
  const insToday = db.prepare(`INSERT INTO today_tasks (project_id, task_id, completed, completed_at, added_date, time, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  (data.todayTasks || []).forEach((t, i) => {
    insToday.run(t.projectId, t.taskId, t.completed ? 1 : 0,
      t.completedAt || null, t.addedDate || null, t.time || '', i, t.updatedAt || null);
  });

  // completedToday
  const insCompleted = db.prepare(`INSERT INTO completed_today (date_key, project_id, task_id, completed_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
  for (const [dateKey, items] of Object.entries(data.completedToday || {})) {
    if (!Array.isArray(items)) continue;
    for (const c of items) {
      insCompleted.run(dateKey, c.projectId, c.taskId, c.completedAt || '', c.updatedAt || null);
    }
  }

  // recurring
  const insRecurring = db.prepare(`INSERT INTO recurring (id, name, type, day_value, time, end_time, interval_val, start_date, end_date, active, monthly_mode, nth_week, nth_day_of_week, color_id, gcal_event_ids, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of data.recurring || []) {
    insRecurring.run(r.id, r.name, r.type, JSON.stringify(r.dayValue ?? null),
      r.time || '', r.endTime || '', r.interval || 1,
      r.startDate || '', r.endDate || null, r.active !== false ? 1 : 0,
      r.monthlyMode || null, r.nthWeek ?? null, r.nthDayOfWeek ?? null,
      r.colorId || null, r.gcalEventIds ? JSON.stringify(r.gcalEventIds) : null,
      r.updatedAt || null);
  }

  // recurring overrides (skips + adds)
  const insOverride = db.prepare(`INSERT OR IGNORE INTO recurring_overrides (date_key, recurring_id, type) VALUES (?, ?, ?)`);
  for (const [dateKey, ids] of Object.entries(data.recurringSkips || {})) {
    if (!Array.isArray(ids)) continue;
    for (const id of ids) insOverride.run(dateKey, id, 'skip');
  }
  for (const [dateKey, ids] of Object.entries(data.recurringAdds || {})) {
    if (!Array.isArray(ids)) continue;
    for (const id of ids) insOverride.run(dateKey, id, 'add');
  }

  // scheduled
  const insScheduled = db.prepare(`INSERT INTO scheduled (date_key, project_id, task_id, time, end_time, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const [dateKey, items] of Object.entries(data.scheduled || {})) {
    if (!Array.isArray(items)) continue;
    for (const s of items) {
      insScheduled.run(dateKey, s.projectId, s.taskId, s.time || '', s.endTime || '', s.updatedAt || null);
    }
  }

  // events
  const insEvent = db.prepare(`INSERT INTO events (id, name, description, date, time, end_time, gcal_source_id, quick_task_id, deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const ev of data.events || []) {
    insEvent.run(ev.id, ev.name, ev.description || '', ev.date || '',
      ev.time || '', ev.endTime || '', ev.gcalSourceId || null,
      ev.quickTaskId || null, ev.deleted ? 1 : 0, ev.updatedAt || null);
  }

  // quickTasks
  const insQuick = db.prepare(`INSERT INTO quick_tasks (id, name, time, end_time, sort_order) VALUES (?, ?, ?, ?, ?)`);
  (data.quickTasks || []).forEach((q, i) => {
    insQuick.run(q.id, q.name, q.time || '', q.endTime || '', i);
  });

  // meta
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('lastUpdated', ?)").run(String(data.lastUpdated || Date.now()));
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')").run();
}

/**
 * 마이그레이션 결과를 검증합니다.
 */
function verifyMigration(db, originalData) {
  const counts = {
    projects: db.prepare('SELECT COUNT(*) as c FROM projects').get().c,
    events: db.prepare('SELECT COUNT(*) as c FROM events').get().c,
    todayTasks: db.prepare('SELECT COUNT(*) as c FROM today_tasks').get().c,
    recurring: db.prepare('SELECT COUNT(*) as c FROM recurring').get().c,
  };

  const expected = {
    projects: (originalData.projects || []).length,
    events: (originalData.events || []).length,
    todayTasks: (originalData.todayTasks || []).length,
    recurring: (originalData.recurring || []).length,
  };

  const mismatches = [];
  for (const [key, count] of Object.entries(counts)) {
    if (count !== expected[key]) {
      mismatches.push(`${key}: expected ${expected[key]}, got ${count}`);
    }
  }

  if (mismatches.length > 0) {
    return { ok: false, reason: mismatches.join('; ') };
  }
  return { ok: true };
}

/**
 * 메인 마이그레이션 함수
 * @param {string} jsonPath - taskdata.json 전체 경로
 * @param {string} dbPath - taskdata.db 전체 경로
 * @returns {{ status: string, reason?: string, backupPath?: string }}
 */
function migrateJsonToSqlite(jsonPath, dbPath) {
  // ── 전제 조건 확인 ──
  if (!fs.existsSync(jsonPath)) {
    console.log('[Migration] JSON 파일 없음 — 스킵');
    return { status: 'skipped', reason: 'no_json' };
  }

  // DB가 이미 존재하고 데이터가 있으면 스킵
  if (fs.existsSync(dbPath)) {
    try {
      const checkDb = new Database(dbPath, { readonly: true, timeout: 3000 });
      const row = checkDb.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      checkDb.close();
      if (row) {
        console.log('[Migration] DB에 이미 데이터 존재 — 스킵');
        return { status: 'skipped', reason: 'db_has_data' };
      }
    } catch (_) {
      // DB가 손상되었거나 테이블이 없으면 계속 진행
    }
  }

  // ── Step 1: JSON 읽기 + 정규화 ──
  let rawData;
  try {
    rawData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  } catch (e) {
    console.error('[Migration] JSON 파싱 실패:', e.message);
    return { status: 'failed', reason: 'json_parse_error', error: e.message };
  }

  const normalizedData = normalizeData(rawData);
  const { data: cleanData, warnings } = validateData(normalizedData);

  // ── Step 2: 임시 DB에 먼저 쓰기 ──
  const tempDbPath = path.join(os.tmpdir(), `tasknote-migration-${Date.now()}.db`);

  let tempDb;
  try {
    tempDb = new Database(tempDbPath);
    tempDb.pragma('journal_mode = WAL');

    // Step 3: 스키마 생성 + 트랜잭션으로 전체 삽입
    createSchemaInDb(tempDb);
    tempDb.transaction(() => {
      insertDataIntoDb(tempDb, cleanData);
    })();

    // Step 4: 검증
    const verify = verifyMigration(tempDb, cleanData);
    if (!verify.ok) {
      throw new Error(`검증 실패: ${verify.reason}`);
    }

    // WAL 체크포인트 → 단일 파일로
    tempDb.pragma('wal_checkpoint(TRUNCATE)');
    tempDb.close();
    tempDb = null;

    // ── Step 5: 임시 DB → 실제 위치로 이동 ──
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    try {
      fs.renameSync(tempDbPath, dbPath);
    } catch (_) {
      fs.copyFileSync(tempDbPath, dbPath);
      fs.unlinkSync(tempDbPath);
    }
    // WAL/SHM 임시 파일 정리
    for (const ext of ['-wal', '-shm']) {
      const f = tempDbPath + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    // ── Step 6: 원본 JSON → .backup ──
    const backupPath = jsonPath + '.backup';
    fs.renameSync(jsonPath, backupPath);

    const projectCount = (cleanData.projects || []).length;
    const eventCount = (cleanData.events || []).length;
    const todayCount = (cleanData.todayTasks || []).length;
    console.log(`[Migration] 성공! projects=${projectCount}, events=${eventCount}, todayTasks=${todayCount}`);
    if (warnings.length > 0) console.log(`[Migration] 경고 ${warnings.length}건 발생 (데이터 정리됨)`);

    return { status: 'success', backupPath };

  } catch (e) {
    // ── 롤백: 임시 DB만 삭제, 원본 JSON 절대 보존 ──
    console.error('[Migration] 실패 — 원본 JSON 유지:', e.message);
    try { if (tempDb) tempDb.close(); } catch (_) {}
    for (const ext of ['', '-wal', '-shm']) {
      const f = tempDbPath + ext;
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
    return { status: 'failed', reason: e.message };
  }
}

/**
 * 설정(settings.json)도 SQLite meta 테이블로 마이그레이션합니다.
 * @param {string} settingsJsonPath - settings.json 전체 경로
 * @param {Database} db - 열려있는 DB 인스턴스
 */
function migrateSettingsToSqlite(settingsJsonPath, db) {
  if (!fs.existsSync(settingsJsonPath)) return { status: 'skipped' };
  if (!db) return { status: 'skipped' };

  try {
    // 이미 settings가 DB에 있으면 스킵
    const existing = db.prepare("SELECT value FROM meta WHERE key = 'settings'").get();
    if (existing) return { status: 'skipped', reason: 'already_exists' };

    const settings = JSON.parse(fs.readFileSync(settingsJsonPath, 'utf-8'));
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('settings', ?)").run(JSON.stringify(settings));

    const backupPath = settingsJsonPath + '.backup';
    fs.renameSync(settingsJsonPath, backupPath);

    console.log('[Migration] settings.json → SQLite 마이그레이션 완료');
    return { status: 'success', backupPath };
  } catch (e) {
    console.error('[Migration] settings 마이그레이션 실패:', e.message);
    return { status: 'failed', reason: e.message };
  }
}

module.exports = {
  migrateJsonToSqlite,
  migrateSettingsToSqlite,
};
