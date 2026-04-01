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
const CURRENT_SCHEMA_VERSION = 2;

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
    database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(CURRENT_SCHEMA_VERSION));
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

  // 향후 v3 마이그레이션은 여기에 추가
  // if (currentVersion < 3) { ... }
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
};
