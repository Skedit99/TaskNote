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
    // 프로젝트
    const projects = db.prepare('SELECT * FROM projects ORDER BY sort_order').all().map(row => ({
      id: row.id,
      name: row.name,
      deadline: row.deadline || null,
      subtasks: JSON.parse(row.subtasks || '[]'),
      archived: !!row.archived,
      colorId: row.color_id || undefined,
      updatedAt: row.updated_at,
      ...(row.deleted ? { deleted: true } : {}),
    }));

    // 오늘 할 일
    const todayTasks = db.prepare('SELECT * FROM today_tasks ORDER BY sort_order').all().map(row => ({
      projectId: row.project_id,
      taskId: row.task_id,
      completed: !!row.completed,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.added_date ? { addedDate: row.added_date } : {}),
      time: row.time || '',
      updatedAt: row.updated_at,
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

    // 반복 일정
    const recurring = db.prepare('SELECT * FROM recurring').all().map(row => {
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

    // 이벤트
    const events = db.prepare('SELECT * FROM events').all().map(row => {
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

    // 퀵 태스크
    const quickTasks = db.prepare('SELECT * FROM quick_tasks ORDER BY sort_order').all().map(row => ({
      id: row.id,
      name: row.name,
      time: row.time || '',
      endTime: row.end_time || '',
    }));

    // lastUpdated
    const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'lastUpdated'").get();
    const lastUpdated = metaRow ? parseInt(metaRow.value, 10) : Date.now();

    return {
      projects,
      todayTasks,
      completedToday,
      recurring,
      recurringSkips,
      recurringAdds,
      scheduled,
      events,
      quickTasks,
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

    // ── projects (PK: id) ──
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
      upsertProject.run(
        p.id, p.name, p.deadline || null, p.colorId || null,
        p.archived ? 1 : 0, p.deleted ? 1 : 0, i,
        JSON.stringify(p.subtasks || []), p.updatedAt || null
      );
    });
    // 삭제된 프로젝트 제거
    const existingProjectIds = db.prepare('SELECT id FROM projects').all().map(r => r.id);
    for (const id of existingProjectIds) {
      if (!incomingProjectIds.has(id)) db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    }

    // ── recurring (PK: id) ──
    const incomingRecurringIds = new Set();
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
      upsertRecurring.run(
        r.id, r.name, r.type, JSON.stringify(r.dayValue ?? null),
        r.time || '', r.endTime || '', r.interval || 1,
        r.startDate || '', r.endDate || null, r.active !== false ? 1 : 0,
        r.monthlyMode || null, r.nthWeek ?? null, r.nthDayOfWeek ?? null,
        r.colorId || null, r.gcalEventIds ? JSON.stringify(r.gcalEventIds) : null,
        r.updatedAt || null
      );
    }
    const existingRecurringIds = db.prepare('SELECT id FROM recurring').all().map(r => r.id);
    for (const id of existingRecurringIds) {
      if (!incomingRecurringIds.has(id)) db.prepare('DELETE FROM recurring WHERE id = ?').run(id);
    }

    // ── events (PK: id) ──
    const incomingEventIds = new Set();
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
      upsertEvent.run(
        ev.id, ev.name, ev.description || '', ev.date || '',
        ev.time || '', ev.endTime || '',
        ev.gcalSourceId || null, ev.quickTaskId || null,
        ev.deleted ? 1 : 0, ev.updatedAt || null
      );
    }
    const existingEventIds = db.prepare('SELECT id FROM events').all().map(r => r.id);
    for (const id of existingEventIds) {
      if (!incomingEventIds.has(id)) db.prepare('DELETE FROM events WHERE id = ?').run(id);
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
    const existingQuickIds = db.prepare('SELECT id FROM quick_tasks').all().map(r => r.id);
    for (const id of existingQuickIds) {
      if (!incomingQuickIds.has(id)) db.prepare('DELETE FROM quick_tasks WHERE id = ?').run(id);
    }

    // ══ UPSERT 기반 테이블 (v2: UNIQUE 인덱스 활용) ══

    // ── todayTasks (UNIQUE: task_id) ──
    const incomingTodayIds = new Set();
    const upsertToday = db.prepare(`
      INSERT INTO today_tasks (project_id, task_id, completed, completed_at, added_date, time, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        project_id=excluded.project_id, completed=excluded.completed, completed_at=excluded.completed_at,
        added_date=excluded.added_date, time=excluded.time, sort_order=excluded.sort_order, updated_at=excluded.updated_at
    `);
    (data.todayTasks || []).forEach((t, i) => {
      incomingTodayIds.add(t.taskId);
      upsertToday.run(
        t.projectId, t.taskId, t.completed ? 1 : 0,
        t.completedAt || null, t.addedDate || null,
        t.time || '', i, t.updatedAt || null
      );
    });
    const existingTodayIds = db.prepare('SELECT task_id FROM today_tasks').all().map(r => r.task_id);
    for (const id of existingTodayIds) {
      if (!incomingTodayIds.has(id)) db.prepare('DELETE FROM today_tasks WHERE task_id = ?').run(id);
    }

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

    // ── recurringOverrides (기존 UNIQUE: date_key + recurring_id + type) ──
    const incomingOverrideKeys = new Set();
    const insertOverride = db.prepare(`
      INSERT OR IGNORE INTO recurring_overrides (date_key, recurring_id, type) VALUES (?, ?, ?)
    `);
    for (const [dateKey, ids] of Object.entries(data.recurringSkips || {})) {
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        incomingOverrideKeys.add(`${dateKey}|${id}|skip`);
        insertOverride.run(dateKey, id, 'skip');
      }
    }
    for (const [dateKey, ids] of Object.entries(data.recurringAdds || {})) {
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        incomingOverrideKeys.add(`${dateKey}|${id}|add`);
        insertOverride.run(dateKey, id, 'add');
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

      // events — 삭제된(tombstone) 이벤트 중 오래된 것 하드 삭제
      const delEvents = db.prepare('DELETE FROM events WHERE deleted = 1 AND date < ?').run(cutoffStr);

      const total = delCompleted.changes + delScheduled.changes + delOverrides.changes + delEvents.changes;
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

module.exports = {
  loadAllData,
  saveAllData,
  loadSettings,
  saveSettings,
  archiveOldData,
  getLastUpdated,
};
