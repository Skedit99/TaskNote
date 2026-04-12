/**
 * storage-sqlite.js — SQLite ↔ JSON 어댑터 (Phase 3)
 *
 * 프론트엔드가 기대하는 JSON 구조와 100% 호환되는 입출력을 제공합니다.
 * - loadAllData()  → DB에서 읽어 기존 JSON 형태의 객체로 반환
 * - saveAllData()  → JSON 객체를 받아 DB 테이블에 분해 저장
 */
const { getDatabase, safeTransaction } = require('./database');

// ══════════════════════════════════════════════
//  LOAD: SQLite → JSON 객체
// ══════════════════════════════════════════════

function loadAllData() {
  const db = getDatabase();
  if (!db) return null;

  try {
    // 프로젝트 (tombstone 제외)
    const projects = db.prepare('SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY sort_order').all().map(row => ({
      id: row.id,
      name: row.name,
      deadline: row.deadline || null,
      subtasks: JSON.parse(row.subtasks || '[]'),
      archived: !!row.archived,
      colorId: row.color_id || undefined,
      updatedAt: row.updated_at,
      ...(row.deleted ? { deleted: true } : {}),
    }));

    // 완료 기록 (날짜 키 → 배열)
    const completedRows = db.prepare('SELECT * FROM completed_today ORDER BY rowid').all();
    const completedToday = {};
    for (const row of completedRows) {
      if (!completedToday[row.date_key]) completedToday[row.date_key] = [];
      completedToday[row.date_key].push({
        projectId: row.project_id,
        taskId: row.task_id,
        completedAt: row.completed_at || '',
        updatedAt: row.updated_at,
      });
    }

    // 반복 일정 (tombstone 제외)
    const recurring = db.prepare('SELECT * FROM recurring WHERE deleted_at IS NULL').all().map(row => {
      const entry = {
        id: row.id,
        name: row.name,
        type: row.type,
        dayValue: JSON.parse(row.day_value ?? 'null'),
        time: row.time || '',
        interval: row.interval_val || 1,
        startDate: row.start_date || '',
        active: !!row.active,
        updatedAt: row.updated_at,
      };
      if (row.end_time) entry.endTime = row.end_time;
      if (row.end_date) entry.endDate = row.end_date;
      if (row.monthly_mode) entry.monthlyMode = row.monthly_mode;
      if (row.nth_week != null) entry.nthWeek = row.nth_week;
      if (row.nth_day_of_week != null) entry.nthDayOfWeek = row.nth_day_of_week;
      if (row.color_id) entry.colorId = row.color_id;
      if (row.gcal_event_ids) {
        try { entry.gcalEventIds = JSON.parse(row.gcal_event_ids); } catch (_) {}
      }
      return entry;
    });

    // 반복 건너뛰기/추가 (날짜 키 → 배열)
    const overrideRows = db.prepare('SELECT * FROM recurring_overrides').all();
    const recurringSkips = {};
    const recurringAdds = {};
    for (const row of overrideRows) {
      const target = row.type === 'skip' ? recurringSkips : recurringAdds;
      if (!target[row.date_key]) target[row.date_key] = [];
      target[row.date_key].push(row.recurring_id);
    }

    // 예약된 태스크 (날짜 키 → 배열)
    const scheduledRows = db.prepare('SELECT * FROM scheduled ORDER BY rowid').all();
    const scheduled = {};
    for (const row of scheduledRows) {
      if (!scheduled[row.date_key]) scheduled[row.date_key] = [];
      scheduled[row.date_key].push({
        projectId: row.project_id,
        taskId: row.task_id,
        time: row.time || '',
        ...(row.end_time ? { endTime: row.end_time } : {}),
        updatedAt: row.updated_at,
      });
    }

    // 이벤트 (tombstone 제외)
    const events = db.prepare('SELECT * FROM events WHERE deleted_at IS NULL').all().map(row => {
      const ev = {
        id: row.id,
        name: row.name,
        description: row.description || '',
        date: row.date || '',
        time: row.time || '',
        endTime: row.end_time || '',
        updatedAt: row.updated_at,
      };
      if (row.gcal_source_id) ev.gcalSourceId = row.gcal_source_id;
      if (row.quick_task_id) ev.quickTaskId = row.quick_task_id;
      if (row.deleted) ev.deleted = true;
      return ev;
    });

    // 퀵 태스크 (tombstone 제외)
    const quickTasks = db.prepare('SELECT * FROM quick_tasks WHERE deleted_at IS NULL ORDER BY sort_order').all().map(row => ({
      id: row.id,
      name: row.name,
      time: row.time || '',
      endTime: row.end_time || '',
    }));

    // GCal 매핑 (sync.json 동기화용)
    let gcalMappings = {};
    try {
      const gcalRows = db.prepare('SELECT * FROM gcal_mappings').all();
      for (const row of gcalRows) {
        gcalMappings[row.local_id] = {
          gcalEventId: row.gcal_event_id,
          lastSynced: row.last_synced,
          type: row.type || 'event',
          date: row.date_key,
          summary: row.summary,
        };
      }
    } catch (_) {} // v4 이전 DB에서는 테이블이 없을 수 있음

    // GCal 오프라인 큐
    let gcalQueue = [];
    try {
      gcalQueue = db.prepare('SELECT * FROM gcal_queue ORDER BY rowid').all().map(row => ({
        action: row.action,
        localId: row.local_id,
        payload: JSON.parse(row.payload || '{}'),
        timestamp: row.timestamp,
      }));
    } catch (_) {}

    // lastUpdated
    const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'lastUpdated'").get();
    const lastUpdated = metaRow ? parseInt(metaRow.value, 10) : Date.now();

    return {
      projects,
      completedToday,
      recurring,
      recurringSkips,
      recurringAdds,
      scheduled,
      events,
      quickTasks,
      gcalMappings,
      gcalQueue,
      lastUpdated,
    };
  } catch (e) {
    console.error('[SQLite] loadAllData 실패:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════
//  SAVE: JSON 객체 → SQLite
// ══════════════════════════════════════════════

function saveAllData(data) {
  if (!data) return;
  const db = getDatabase();
  if (!db) return;

  safeTransaction(() => {
    // ══ PK 기반 테이블: UPSERT (차분 업데이트) ══

    // ── projects (PK: id) — updatedAt 비교로 변경된 행만 UPSERT ──
    const incomingProjectIds = new Set();
    const upsertProject = db.prepare(`
      INSERT INTO projects (id, name, deadline, color_id, archived, deleted, sort_order, subtasks, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, deadline=excluded.deadline, color_id=excluded.color_id,
        archived=excluded.archived, deleted=excluded.deleted, sort_order=excluded.sort_order,
        subtasks=excluded.subtasks, updated_at=excluded.updated_at
    `);
    (data.projects || []).forEach((p, i) => {
      incomingProjectIds.add(p.id);
      // 프로젝트는 항상 UPSERT (subtasks가 JSON 컬럼이라 updatedAt만으로 변경 감지 불가)
      upsertProject.run(
        p.id, p.name, p.deadline || null, p.colorId || null,
        p.archived ? 1 : 0, p.deleted ? 1 : 0, i,
        JSON.stringify(p.subtasks || []), p.updatedAt || null
      );
    });
    // 삭제된 프로젝트 → soft delete (tombstone)
    const existingProjectIds = db.prepare('SELECT id FROM projects WHERE deleted_at IS NULL').all().map(r => r.id);
    for (const id of existingProjectIds) {
      if (!incomingProjectIds.has(id)) {
        db.prepare('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(Date.now(), Date.now(), id);
      }
    }

    // ── recurring (PK: id) — updatedAt 비교로 변경된 행만 UPSERT ──
    const incomingRecurringIds = new Set();
    const currentRecurringTs = new Map();
    db.prepare('SELECT id, updated_at FROM recurring WHERE deleted_at IS NULL').all().forEach(r => currentRecurringTs.set(r.id, r.updated_at));
    const upsertRecurring = db.prepare(`
      INSERT INTO recurring (id, name, type, day_value, time, end_time, interval_val, start_date, end_date, active, monthly_mode, nth_week, nth_day_of_week, color_id, gcal_event_ids, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, type=excluded.type, day_value=excluded.day_value,
        time=excluded.time, end_time=excluded.end_time, interval_val=excluded.interval_val,
        start_date=excluded.start_date, end_date=excluded.end_date, active=excluded.active,
        monthly_mode=excluded.monthly_mode, nth_week=excluded.nth_week, nth_day_of_week=excluded.nth_day_of_week,
        color_id=excluded.color_id, gcal_event_ids=excluded.gcal_event_ids, updated_at=excluded.updated_at
    `);
    for (const r of data.recurring || []) {
      incomingRecurringIds.add(r.id);
      const current = currentRecurringTs.get(r.id);
      if (current && current === (r.updatedAt || 0)) continue; // 변경 없음 → 스킵
      upsertRecurring.run(
        r.id, r.name, r.type, JSON.stringify(r.dayValue ?? null),
        r.time || '', r.endTime || '', r.interval || 1,
        r.startDate || '', r.endDate || null, r.active !== false ? 1 : 0,
        r.monthlyMode || null, r.nthWeek ?? null, r.nthDayOfWeek ?? null,
        r.colorId || null, r.gcalEventIds ? JSON.stringify(r.gcalEventIds) : null,
        r.updatedAt || null
      );
    }
    const existingRecurringIds = db.prepare('SELECT id FROM recurring WHERE deleted_at IS NULL').all().map(r => r.id);
    for (const id of existingRecurringIds) {
      if (!incomingRecurringIds.has(id)) {
        db.prepare('UPDATE recurring SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(Date.now(), Date.now(), id);
      }
    }

    // ── events (PK: id) — updatedAt 비교로 변경된 행만 UPSERT ──
    const incomingEventIds = new Set();
    const currentEventTs = new Map();
    db.prepare('SELECT id, updated_at FROM events WHERE deleted_at IS NULL').all().forEach(r => currentEventTs.set(r.id, r.updated_at));
    const upsertEvent = db.prepare(`
      INSERT INTO events (id, name, description, date, time, end_time, gcal_source_id, quick_task_id, deleted, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, description=excluded.description, date=excluded.date,
        time=excluded.time, end_time=excluded.end_time, gcal_source_id=excluded.gcal_source_id,
        quick_task_id=excluded.quick_task_id, deleted=excluded.deleted, updated_at=excluded.updated_at
    `);
    for (const ev of data.events || []) {
      incomingEventIds.add(ev.id);
      const current = currentEventTs.get(ev.id);
      if (current && current === (ev.updatedAt || 0)) continue; // 변경 없음 → 스킵
      upsertEvent.run(
        ev.id, ev.name, ev.description || '', ev.date || '',
        ev.time || '', ev.endTime || '',
        ev.gcalSourceId || null, ev.quickTaskId || null,
        ev.deleted ? 1 : 0, ev.updatedAt || null
      );
    }
    const existingEventIds = db.prepare('SELECT id FROM events WHERE deleted_at IS NULL').all().map(r => r.id);
    for (const id of existingEventIds) {
      if (!incomingEventIds.has(id)) {
        db.prepare('UPDATE events SET deleted_at = ?, deleted = 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(Date.now(), Date.now(), id);
      }
    }

    // ── quickTasks (PK: id) ──
    const incomingQuickIds = new Set();
    const upsertQuick = db.prepare(`
      INSERT INTO quick_tasks (id, name, time, end_time, sort_order)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, time=excluded.time, end_time=excluded.end_time, sort_order=excluded.sort_order
    `);
    (data.quickTasks || []).forEach((q, i) => {
      incomingQuickIds.add(q.id);
      upsertQuick.run(q.id, q.name, q.time || '', q.endTime || '', i);
    });
    const existingQuickIds = db.prepare('SELECT id FROM quick_tasks WHERE deleted_at IS NULL').all().map(r => r.id);
    for (const id of existingQuickIds) {
      if (!incomingQuickIds.has(id)) {
        db.prepare('UPDATE quick_tasks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(Date.now(), id);
      }
    }

    // ══ UPSERT 기반 테이블 (v2: UNIQUE 인덱스 활용) ══

    // ── completedToday (UNIQUE: date_key + task_id) ──
    const incomingCompletedKeys = new Set();
    const upsertCompleted = db.prepare(`
      INSERT INTO completed_today (date_key, project_id, task_id, completed_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date_key, task_id) DO UPDATE SET
        project_id=excluded.project_id, completed_at=excluded.completed_at, updated_at=excluded.updated_at
    `);
    for (const [dateKey, items] of Object.entries(data.completedToday || {})) {
      if (!Array.isArray(items)) continue;
      for (const c of items) {
        incomingCompletedKeys.add(`${dateKey}|${c.taskId}`);
        upsertCompleted.run(dateKey, c.projectId, c.taskId, c.completedAt || '', c.updatedAt || null);
      }
    }
    const existingCompleted = db.prepare('SELECT date_key, task_id FROM completed_today').all();
    for (const row of existingCompleted) {
      if (!incomingCompletedKeys.has(`${row.date_key}|${row.task_id}`)) {
        db.prepare('DELETE FROM completed_today WHERE date_key = ? AND task_id = ?').run(row.date_key, row.task_id);
      }
    }

    // ── recurringOverrides (UNIQUE: date_key + recurring_id + type, LWW용 updated_at) ──
    const incomingOverrideKeys = new Set();
    const upsertOverride = db.prepare(`
      INSERT INTO recurring_overrides (date_key, recurring_id, type, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(date_key, recurring_id, type) DO UPDATE SET updated_at=excluded.updated_at
    `);
    const now = Date.now();
    for (const [dateKey, ids] of Object.entries(data.recurringSkips || {})) {
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        incomingOverrideKeys.add(`${dateKey}|${id}|skip`);
        upsertOverride.run(dateKey, id, 'skip', now);
      }
    }
    for (const [dateKey, ids] of Object.entries(data.recurringAdds || {})) {
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        incomingOverrideKeys.add(`${dateKey}|${id}|add`);
        upsertOverride.run(dateKey, id, 'add', now);
      }
    }
    const existingOverrides = db.prepare('SELECT date_key, recurring_id, type FROM recurring_overrides').all();
    for (const row of existingOverrides) {
      if (!incomingOverrideKeys.has(`${row.date_key}|${row.recurring_id}|${row.type}`)) {
        db.prepare('DELETE FROM recurring_overrides WHERE date_key = ? AND recurring_id = ? AND type = ?').run(row.date_key, row.recurring_id, row.type);
      }
    }

    // ── scheduled (UNIQUE: date_key + task_id) ──
    const incomingScheduledKeys = new Set();
    const upsertScheduled = db.prepare(`
      INSERT INTO scheduled (date_key, project_id, task_id, time, end_time, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date_key, task_id) DO UPDATE SET
        project_id=excluded.project_id, time=excluded.time, end_time=excluded.end_time, updated_at=excluded.updated_at
    `);
    for (const [dateKey, items] of Object.entries(data.scheduled || {})) {
      if (!Array.isArray(items)) continue;
      for (const s of items) {
        incomingScheduledKeys.add(`${dateKey}|${s.taskId}`);
        upsertScheduled.run(dateKey, s.projectId, s.taskId, s.time || '', s.endTime || '', s.updatedAt || null);
      }
    }
    const existingScheduled = db.prepare('SELECT date_key, task_id FROM scheduled').all();
    for (const row of existingScheduled) {
      if (!incomingScheduledKeys.has(`${row.date_key}|${row.task_id}`)) {
        db.prepare('DELETE FROM scheduled WHERE date_key = ? AND task_id = ?').run(row.date_key, row.task_id);
      }
    }

    // ── gcal_mappings (sync.json 동기화용, 있을 때만) ──
    if (data.gcalMappings && typeof data.gcalMappings === 'object') {
      try {
        const incomingMappingIds = new Set(Object.keys(data.gcalMappings));
        const upsertMapping = db.prepare(`
          INSERT INTO gcal_mappings (local_id, gcal_event_id, last_synced, type, date_key, summary)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(local_id) DO UPDATE SET
            gcal_event_id=excluded.gcal_event_id, last_synced=excluded.last_synced,
            type=excluded.type, date_key=excluded.date_key, summary=excluded.summary
        `);
        for (const [localId, entry] of Object.entries(data.gcalMappings)) {
          upsertMapping.run(localId, entry.gcalEventId || '', entry.lastSynced || null,
            entry.type || 'event', entry.date || null, entry.summary || null);
        }
        const existingMappingIds = db.prepare('SELECT local_id FROM gcal_mappings').all().map(r => r.local_id);
        for (const id of existingMappingIds) {
          if (!incomingMappingIds.has(id)) db.prepare('DELETE FROM gcal_mappings WHERE local_id = ?').run(id);
        }
      } catch (e) {
        // v4 이전 DB에서는 무시
        if (!e.message.includes('no such table')) console.warn('[SQLite] gcal_mappings 저장 실패:', e.message);
      }
    }

    // ── gcal_queue (sync.json 동기화용, 있을 때만) ──
    if (Array.isArray(data.gcalQueue)) {
      try {
        db.prepare('DELETE FROM gcal_queue').run();
        const insQueue = db.prepare('INSERT INTO gcal_queue (action, local_id, payload, timestamp) VALUES (?, ?, ?, ?)');
        for (const entry of data.gcalQueue) {
          insQueue.run(entry.action || '', entry.localId || '', JSON.stringify(entry.payload || {}), entry.timestamp || null);
        }
      } catch (e) {
        if (!e.message.includes('no such table')) console.warn('[SQLite] gcal_queue 저장 실패:', e.message);
      }
    }

    // ── meta: lastUpdated ──
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('lastUpdated', ?)").run(
      String(data.lastUpdated || Date.now())
    );
  });
}

// ══════════════════════════════════════════════
//  설정 (Settings)
// ══════════════════════════════════════════════

function loadSettings() {
  const db = getDatabase();
  if (!db) return null;
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'settings'").get();
    return row ? JSON.parse(row.value) : null;
  } catch (e) {
    console.error('[SQLite] loadSettings 실패:', e.message);
    return null;
  }
}

function saveSettings(settings) {
  const db = getDatabase();
  if (!db) return;
  try {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('settings', ?)").run(
      JSON.stringify(settings)
    );
  } catch (e) {
    console.error('[SQLite] saveSettings 실패:', e.message);
  }
}

// ══════════════════════════════════════════════
//  아카이브 (Phase 3: DB 내 처리)
// ══════════════════════════════════════════════

function archiveOldData(archiveDays = 90) {
  const db = getDatabase();
  if (!db) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - archiveDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  try {
    safeTransaction(() => {
      // completedToday — 오래된 날짜 키 삭제
      const delCompleted = db.prepare('DELETE FROM completed_today WHERE date_key < ?').run(cutoffStr);

      // scheduled — 오래된 날짜 키 삭제
      const delScheduled = db.prepare('DELETE FROM scheduled WHERE date_key < ?').run(cutoffStr);

      // recurring_overrides — 오래된 날짜 키 삭제
      const delOverrides = db.prepare('DELETE FROM recurring_overrides WHERE date_key < ?').run(cutoffStr);

      // tombstone 하드 삭제 (30일 이상 된 soft-deleted 항목)
      const cutoffTs = cutoff.getTime();
      const delEvents = db.prepare('DELETE FROM events WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoffTs);
      const delProjects = db.prepare('DELETE FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoffTs);
      const delRecurring = db.prepare('DELETE FROM recurring WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoffTs);
      const delQuickTasks = db.prepare('DELETE FROM quick_tasks WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoffTs);

      const total = delCompleted.changes + delScheduled.changes + delOverrides.changes
        + delEvents.changes + delProjects.changes + delRecurring.changes + delQuickTasks.changes;
      if (total > 0) {
        console.log(`[Archive/SQLite] ${total}개 오래된 레코드 삭제 완료 (기준: ${cutoffStr})`);
      } else {
        console.log('[Archive/SQLite] 아카이빙할 데이터 없음.');
      }
    });
  } catch (e) {
    console.error('[Archive/SQLite] 아카이빙 실패:', e.message);
  }
}

/**
 * meta 테이블에서 lastUpdated 값만 읽어오는 경량 함수.
 * 충돌 감지 시 전체 loadAllData() 대신 사용하여 I/O를 대폭 줄입니다.
 */
function getLastUpdated() {
  const db = getDatabase();
  if (!db) return 0;
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'lastUpdated'").get();
    return row ? parseInt(row.value, 10) : 0;
  } catch (e) {
    console.error('[SQLite] getLastUpdated 실패:', e.message);
    return 0;
  }
}

/**
 * 범용 meta 키-값 읽기
 */
function getMeta(key) {
  const db = getDatabase();
  if (!db) return null;
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch (e) {
    return null;
  }
}

/**
 * 범용 meta 키-값 쓰기
 */
function setMeta(key, value) {
  const db = getDatabase();
  if (!db) return;
  try {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
  } catch (e) {
    console.error(`[SQLite] setMeta(${key}) 실패:`, e.message);
  }
}

module.exports = {
  loadAllData,
  saveAllData,
  loadSettings,
  saveSettings,
  archiveOldData,
  getLastUpdated,
  getMeta,
  setMeta,
};
