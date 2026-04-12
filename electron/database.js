/**
 * database.js — SQLite DB 매니저
 *
 * DB 열기/닫기, 스키마 생성, 마이그레이션을 담당합니다.
 * Phase 3 전략: 서브태스크는 JSON 컬럼으로 저장 (기존 병합 로직 호환)
 */
const Database = require('better-sqlite3');
const path = require('path');

const DB_FILE = 'taskdata.db';
const ARCHIVE_DB_FILE = 'archive.db';
const CURRENT_SCHEMA_VERSION = 5;

let db = null;

// ── 스키마 정의 ──
const SCHEMA_V1 = `
  -- 프로젝트 (서브태스크는 JSON 컬럼 — Phase 3 하이브리드)
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    deadline TEXT,
    color_id TEXT,
    archived INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    subtasks TEXT DEFAULT '[]',
    updated_at INTEGER
  );

  -- 오늘 할 일
  CREATE TABLE IF NOT EXISTS today_tasks (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    completed INTEGER DEFAULT 0,
    completed_at TEXT,
    added_date TEXT,
    time TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    updated_at INTEGER
  );

  -- 완료 기록 (날짜별)
  CREATE TABLE IF NOT EXISTS completed_today (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    date_key TEXT NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    completed_at TEXT,
    updated_at INTEGER
  );

  -- 반복 일정
  CREATE TABLE IF NOT EXISTS recurring (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    day_value TEXT,
    time TEXT DEFAULT '',
    end_time TEXT DEFAULT '',
    interval_val INTEGER DEFAULT 1,
    start_date TEXT,
    end_date TEXT,
    active INTEGER DEFAULT 1,
    monthly_mode TEXT,
    nth_week INTEGER,
    nth_day_of_week INTEGER,
    color_id TEXT,
    gcal_event_ids TEXT,
    updated_at INTEGER
  );

  -- 반복 건너뛰기/추가 (날짜별)
  CREATE TABLE IF NOT EXISTS recurring_overrides (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    date_key TEXT NOT NULL,
    recurring_id TEXT NOT NULL,
    type TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_recurring_overrides_unique
    ON recurring_overrides(date_key, recurring_id, type);

  -- 예약된 태스크 (날짜별)
  CREATE TABLE IF NOT EXISTS scheduled (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    date_key TEXT NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    time TEXT DEFAULT '',
    end_time TEXT DEFAULT '',
    updated_at INTEGER
  );

  -- 독립 캘린더 이벤트
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    date TEXT,
    time TEXT DEFAULT '',
    end_time TEXT DEFAULT '',
    gcal_source_id TEXT,
    quick_task_id TEXT,
    deleted INTEGER DEFAULT 0,
    updated_at INTEGER
  );

  -- 퀵 태스크 템플릿
  CREATE TABLE IF NOT EXISTS quick_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    time TEXT DEFAULT '',
    end_time TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0
  );

  -- 메타 정보
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- 인덱스
  CREATE INDEX IF NOT EXISTS idx_today_tasks_task_id ON today_tasks(task_id);
  CREATE INDEX IF NOT EXISTS idx_completed_today_date ON completed_today(date_key);
  CREATE INDEX IF NOT EXISTS idx_scheduled_date ON scheduled(date_key);
  CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
  CREATE INDEX IF NOT EXISTS idx_events_deleted ON events(deleted);
`;

/**
 * DB를 열고 스키마를 초기화합니다.
 * @param {string} dbPath - DB 파일의 전체 경로
 * @returns {Database} better-sqlite3 인스턴스
 */
function openDatabase(dbPath) {
  if (db) return db;

  db = new Database(dbPath, { timeout: 5000 });

  // WAL 모드 + 성능 최적화
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // 스키마 마이그레이션
  migrateSchema(db);

  return db;
}

/**
 * 스키마 버전을 확인하고 필요한 마이그레이션을 실행합니다.
 */
function migrateSchema(database) {
  const versionRow = (() => {
    try {
      return database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    } catch (_) {
      return null;
    }
  })();

  const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

  if (currentVersion < 1) {
    database.exec(SCHEMA_V1);
    database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(1));
    console.log('[DB] 스키마 v1 초기화 완료');
  }

  // v2: PK 없는 테이블에 UNIQUE 인덱스 추가 (UPSERT 지원)
  if (currentVersion < 2) {
    // 중복 데이터 정리 후 UNIQUE 인덱스 생성
    // today_tasks: task_id 기준 중복 제거 (가장 최신 것만 유지)
    database.exec(`
      DELETE FROM today_tasks WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM today_tasks GROUP BY task_id
      );
    `);
    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_today_tasks_uq ON today_tasks(task_id)');

    // completed_today: (date_key, task_id) 기준 중복 제거
    database.exec(`
      DELETE FROM completed_today WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM completed_today GROUP BY date_key, task_id
      );
    `);
    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_completed_today_uq ON completed_today(date_key, task_id)');

    // scheduled: (date_key, task_id) 기준 중복 제거
    database.exec(`
      DELETE FROM scheduled WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM scheduled GROUP BY date_key, task_id
      );
    `);
    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_uq ON scheduled(date_key, task_id)');

    database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(2));
    console.log('[DB] 스키마 v2 마이그레이션 완료 (UNIQUE 인덱스 추가)');
  }

  // v3: Tombstone 모델 (deleted_at) + recurring_overrides updated_at
  if (currentVersion < 3) {
    // PK 기반 테이블에 deleted_at 컬럼 추가 (soft delete 지원)
    const addDeletedAt = (table) => {
      try { database.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at INTEGER`); } catch (_) {}
    };
    addDeletedAt('projects');
    addDeletedAt('events');
    addDeletedAt('recurring');
    addDeletedAt('quick_tasks');

    // 기존 deleted=1 데이터에 deleted_at 역보정
    try {
      database.exec(`UPDATE projects SET deleted_at = updated_at WHERE deleted = 1 AND deleted_at IS NULL`);
      database.exec(`UPDATE events SET deleted_at = updated_at WHERE deleted = 1 AND deleted_at IS NULL`);
    } catch (_) {}

    // recurring_overrides에 updated_at 컬럼 추가 (LWW 병합용)
    try { database.exec(`ALTER TABLE recurring_overrides ADD COLUMN updated_at INTEGER`); } catch (_) {}

    database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(3));
    console.log('[DB] 스키마 v3 마이그레이션 완료 (tombstone + override updated_at)');
  }

  // v4: GCal 매핑 + 오프라인 큐를 SQLite로 편입
  if (currentVersion < 4) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS gcal_mappings (
        local_id TEXT PRIMARY KEY,
        gcal_event_id TEXT NOT NULL,
        last_synced TEXT,
        type TEXT DEFAULT 'event',
        date_key TEXT,
        summary TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_gcal_mappings_event ON gcal_mappings(gcal_event_id);

      CREATE TABLE IF NOT EXISTS gcal_queue (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        local_id TEXT NOT NULL,
        payload TEXT DEFAULT '{}',
        timestamp TEXT
      );
    `);

    database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(4));
    console.log('[DB] 스키마 v4 마이그레이션 완료 (gcal_mappings + gcal_queue 테이블)');
  }

  // v5: today_tasks 테이블 제거 (오늘 할일은 events/scheduled/recurring에서 파생 계산)
  if (currentVersion < 5) {
    // today_tasks의 미완료 항목을 scheduled로 이동
    try {
      const todayRows = database.prepare("SELECT * FROM today_tasks WHERE completed = 0").all();
      if (todayRows.length > 0) {
        const todayKey = (() => {
          const d = new Date();
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        })();
        const insertScheduled = database.prepare(
          `INSERT OR IGNORE INTO scheduled (date_key, project_id, task_id, time, updated_at) VALUES (?, ?, ?, ?, ?)`
        );
        database.transaction(() => {
          for (const row of todayRows) {
            if (row.project_id === 'event' || row.project_id === 'recurring') continue;
            const dateKey = row.added_date || todayKey;
            insertScheduled.run(dateKey, row.project_id, row.task_id, row.time || '', row.updated_at || Date.now());
          }
        })();
        console.log(`[DB] v5: today_tasks → scheduled ${todayRows.length}건 이동`);
      }
    } catch (e) {
      console.warn('[DB] v5 today_tasks 마이그레이션 경고:', e.message);
    }

    // today_tasks 테이블 제거
    try { database.exec('DROP TABLE IF EXISTS today_tasks'); } catch (_) {}

    // gcal_mappings에 sync_hash 컬럼 추가 (Phase 2 변경 기반 Push용)
    try { database.exec('ALTER TABLE gcal_mappings ADD COLUMN sync_hash TEXT'); } catch (_) {}

    database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(5));
    console.log('[DB] 스키마 v5 마이그레이션 완료 (today_tasks 제거, sync_hash 추가)');
  }
}

/**
 * 기존 gcal-mapping.json / gcal-queue.json을 SQLite로 1회 마이그레이션합니다.
 * DB에 이미 데이터가 있으면 스킵합니다.
 */
function migrateGcalFilesToDb(userDataPath) {
  const database = getDatabase();
  if (!database) return;

  const fs = require('fs');
  const path = require('path');

  // 매핑 파일 마이그레이션
  const mappingPath = path.join(userDataPath, 'gcal-mapping.json');
  try {
    const existingCount = database.prepare('SELECT COUNT(*) as cnt FROM gcal_mappings').get().cnt;
    if (existingCount === 0 && fs.existsSync(mappingPath)) {
      const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
      const upsert = database.prepare(`
        INSERT OR REPLACE INTO gcal_mappings (local_id, gcal_event_id, last_synced, type, date_key, summary)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      database.transaction(() => {
        for (const [localId, entry] of Object.entries(mapping)) {
          upsert.run(localId, entry.gcalEventId || '', entry.lastSynced || null,
            entry.type || 'event', entry.date || null, entry.summary || null);
        }
      })();
      // 원본 백업
      try { fs.renameSync(mappingPath, mappingPath + '.backup'); } catch (_) {}
      console.log(`[Migration] gcal-mapping.json → SQLite 완료 (${Object.keys(mapping).length}건)`);
    }
  } catch (e) {
    console.warn('[Migration] gcal-mapping.json 마이그레이션 실패:', e.message);
  }

  // 큐 파일 마이그레이션
  const queuePath = path.join(userDataPath, 'gcal-queue.json');
  try {
    const existingQueueCount = database.prepare('SELECT COUNT(*) as cnt FROM gcal_queue').get().cnt;
    if (existingQueueCount === 0 && fs.existsSync(queuePath)) {
      const queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
      if (Array.isArray(queue) && queue.length > 0) {
        const ins = database.prepare('INSERT INTO gcal_queue (action, local_id, payload, timestamp) VALUES (?, ?, ?, ?)');
        database.transaction(() => {
          for (const entry of queue) {
            ins.run(entry.action || '', entry.localId || '', JSON.stringify(entry.payload || {}), entry.timestamp || null);
          }
        })();
        console.log(`[Migration] gcal-queue.json → SQLite 완료 (${queue.length}건)`);
      }
      try { fs.renameSync(queuePath, queuePath + '.backup'); } catch (_) {}
    }
  } catch (e) {
    console.warn('[Migration] gcal-queue.json 마이그레이션 실패:', e.message);
  }
}

/**
 * 현재 DB 인스턴스를 반환합니다.
 */
function getDatabase() {
  return db;
}

/**
 * DB를 안전하게 닫습니다.
 */
function closeDatabase() {
  if (db) {
    try {
      // WAL 체크포인트 — 클라우드 동기화 시 단일 파일로 만듦
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (e) {
      console.error('[DB] 닫기 실패:', e.message);
    }
    db = null;
  }
}

/**
 * 트랜잭션 래퍼 — 잠금 시 재시도
 */
function safeTransaction(fn, maxRetries = 3) {
  const database = getDatabase();
  if (!database) throw new Error('[DB] 데이터베이스가 열려있지 않습니다');

  for (let i = 0; i < maxRetries; i++) {
    try {
      return database.transaction(fn)();
    } catch (e) {
      if ((e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_LOCKED') && i < maxRetries - 1) {
        console.warn(`[DB] 잠금 감지, ${i + 1}/${maxRetries} 재시도...`);
        const waitUntil = Date.now() + 500 * (i + 1);
        while (Date.now() < waitUntil) { /* spin wait */ }
        continue;
      }
      throw e;
    }
  }
}

module.exports = {
  DB_FILE,
  ARCHIVE_DB_FILE,
  openDatabase,
  getDatabase,
  closeDatabase,
  safeTransaction,
  migrateGcalFilesToDb,
};
