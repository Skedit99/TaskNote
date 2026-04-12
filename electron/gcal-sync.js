// ═══════════════════════════════
// Google Calendar 동기화 모듈
// ═══════════════════════════════
// 양방향 sync: 앱 ↔ Google Calendar
// 매핑 + 오프라인 큐: SQLite DB 기반 (v5+)

const { google } = require('googleapis');
const { getAuthenticatedClient } = require('./google-auth');
const { getDatabase } = require('./database');
const crypto = require('crypto');

// ── 동시 create 방지 (같은 localId에 대한 중복 GCal 이벤트 생성 방지) ──
const _createInFlight = new Map(); // localId → Promise

// ── 매핑 (항상 DB에서 직접 읽기 — 캐시 없음) ──

function loadMapping() {
  const db = getDatabase();
  if (!db) return {};
  try {
    const rows = db.prepare('SELECT * FROM gcal_mappings').all();
    const mapping = {};
    for (const row of rows) {
      mapping[row.local_id] = {
        gcalEventId: row.gcal_event_id,
        lastSynced: row.last_synced,
        type: row.type || 'event',
        date: row.date_key,
        summary: row.summary,
        syncHash: row.sync_hash || null,
      };
    }
    return mapping;
  } catch (e) {
    console.error('매핑 로드 실패:', e.message);
    return {};
  }
}

function saveMapping(mapping) {
  const db = getDatabase();
  if (!db) return;
  try {
    const upsert = db.prepare(`
      INSERT INTO gcal_mappings (local_id, gcal_event_id, last_synced, type, date_key, summary, sync_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(local_id) DO UPDATE SET
        gcal_event_id=excluded.gcal_event_id, last_synced=excluded.last_synced,
        type=excluded.type, date_key=excluded.date_key, summary=excluded.summary, sync_hash=excluded.sync_hash
    `);
    const incomingIds = new Set(Object.keys(mapping));

    db.transaction(() => {
      for (const [localId, entry] of Object.entries(mapping)) {
        upsert.run(localId, entry.gcalEventId, entry.lastSynced || null,
          entry.type || 'event', entry.date || null, entry.summary || null, entry.syncHash || null);
      }
      const existingIds = db.prepare('SELECT local_id FROM gcal_mappings').all().map(r => r.local_id);
      const toDelete = existingIds.filter(id => !incomingIds.has(id));
      if (toDelete.length > 0 && incomingIds.size === 0) {
        console.log(`[GCal] 매핑 전체 초기화: ${toDelete.length}건 삭제`);
      }
      for (const id of toDelete) {
        db.prepare('DELETE FROM gcal_mappings WHERE local_id = ?').run(id);
      }
    })();
  } catch (e) {
    console.error('매핑 저장 실패:', e.message);
  }
}

// 개별 매핑 엔트리만 빠르게 업데이트 (전체 saveMapping 없이)
function updateMappingEntry(localId, entry) {
  const db = getDatabase();
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO gcal_mappings (local_id, gcal_event_id, last_synced, type, date_key, summary, sync_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(local_id) DO UPDATE SET
        gcal_event_id=excluded.gcal_event_id, last_synced=excluded.last_synced,
        type=excluded.type, date_key=excluded.date_key, summary=excluded.summary, sync_hash=excluded.sync_hash
    `).run(localId, entry.gcalEventId, entry.lastSynced || null,
      entry.type || 'event', entry.date || null, entry.summary || null, entry.syncHash || null);
  } catch (e) {
    console.error('매핑 엔트리 업데이트 실패:', e.message);
  }
}

function deleteMappingEntry(localId) {
  const db = getDatabase();
  if (!db) return;
  try {
    db.prepare('DELETE FROM gcal_mappings WHERE local_id = ?').run(localId);
  } catch (e) {
    console.error('매핑 엔트리 삭제 실패:', e.message);
  }
}

// ── Sync Hash (변경 기반 Push용) ──
function computeSyncHash(summary, description, date, time, endTime) {
  const input = `${summary || ''}|${description || ''}|${date || ''}|${time || ''}|${endTime || ''}`;
  return crypto.createHash('md5').update(input).digest('hex').slice(0, 16);
}

// ── 오프라인 큐 (DB 기반) ──
function loadQueue() {
  const db = getDatabase();
  if (!db) return [];
  try {
    return db.prepare('SELECT * FROM gcal_queue ORDER BY rowid').all().map(row => ({
      action: row.action,
      localId: row.local_id,
      payload: JSON.parse(row.payload || '{}'),
      timestamp: row.timestamp,
    }));
  } catch (e) {
    console.error('큐 로드 실패:', e.message);
    return [];
  }
}

function saveQueue(queue) {
  const db = getDatabase();
  if (!db) return;
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM gcal_queue').run();
      const ins = db.prepare('INSERT INTO gcal_queue (action, local_id, payload, timestamp) VALUES (?, ?, ?, ?)');
      for (const entry of queue) {
        ins.run(entry.action, entry.localId, JSON.stringify(entry.payload || {}), entry.timestamp || null);
      }
    })();
  } catch (e) {
    console.error('큐 저장 실패:', e.message);
  }
}

function enqueue(entry) {
  const db = getDatabase();
  if (!db) return;
  try {
    db.prepare('INSERT INTO gcal_queue (action, local_id, payload, timestamp) VALUES (?, ?, ?, ?)')
      .run(entry.action, entry.localId, JSON.stringify(entry.payload || {}), new Date().toISOString());
  } catch (e) {
    console.error('큐 추가 실패:', e.message);
  }
}

// ── 네트워크 오류 판별 ──
function isNetworkError(err) {
  const msg = (err.message || '').toLowerCase();
  const code = err.code || '';
  return (
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT'
  );
}

function isRateLimited(err) {
  return err.code === 429 || err.status === 429 ||
    (err.message || '').includes('429') ||
    (err.message || '').toLowerCase().includes('rate limit');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, { maxRetries = 3, baseDelay = 1000 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      if (isRateLimited(err) || isNetworkError(err)) {
        const wait = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
        console.log(`[GCal] 재시도 ${attempt + 1}/${maxRetries} (${Math.round(wait)}ms 후)`);
        await delay(wait);
      } else {
        throw err;
      }
    }
  }
}

// ── Google Calendar 이벤트 리소스 빌드 ──
function buildEventResource(summary, description, date, time, endTime) {
  const resource = {
    summary: summary || '(제목 없음)',
    description: description || '',
  };

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';

  if (time) {
    const startDT = `${date}T${time}:00`;
    let endStr;
    if (endTime) {
      endStr = `${date}T${endTime}:00`;
    } else {
      const startDate = new Date(startDT);
      const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      endStr = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:00`;
    }

    resource.start = { dateTime: startDT, timeZone: tz };
    resource.end = { dateTime: endStr, timeZone: tz };
  } else {
    resource.start = { date };
    const d = new Date(date);
    d.setDate(d.getDate() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    const endDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    resource.end = { date: endDate };
  }

  resource.extendedProperties = { private: { tasknote: 'true' } };
  return resource;
}

// ── CREATE ──
async function createGcalEvent({ localId, summary, description, date, time, endTime, type }) {
  // 동일 localId에 대한 동시 create 방지 (레이스 컨디션으로 GCal 중복 생성 차단)
  if (_createInFlight.has(localId)) {
    try { return await _createInFlight.get(localId); } catch { return null; }
  }
  const promise = _createGcalEventInner({ localId, summary, description, date, time, endTime, type });
  _createInFlight.set(localId, promise);
  try { return await promise; } finally { _createInFlight.delete(localId); }
}

async function _createGcalEventInner({ localId, summary, description, date, time, endTime, type }) {
  const existingMapping = loadMapping();
  if (existingMapping[localId]?.gcalEventId) {
    const existing = existingMapping[localId];
    if (existing.date !== date || existing.summary !== summary) {
      existing.date = date;
      existing.summary = summary;
      existing.syncHash = computeSyncHash(summary, description, date, time, endTime);
      updateMappingEntry(localId, existing);
      const updateResult = await updateGcalEvent({ localId, summary, description, date, time });
      if (updateResult === null) {
        console.log(`[GCal] 업데이트 실패, 재생성 시도: ${localId}`);
      } else {
        return { gcalEventId: existing.gcalEventId };
      }
    } else {
      return { gcalEventId: existing.gcalEventId };
    }
  }

  const client = await getAuthenticatedClient();
  if (!client) return null;

  const calendar = google.calendar({ version: 'v3', auth: client });
  const resource = buildEventResource(summary, description, date, time, endTime);

  try {
    const res = await withRetry(() => calendar.events.insert({
      calendarId: 'primary',
      resource,
    }));

    const gcalEventId = res.data.id;
    const entry = {
      gcalEventId,
      lastSynced: new Date().toISOString(),
      type: type || 'event',
      date,
      summary,
      syncHash: computeSyncHash(summary, description, date, time, endTime),
    };
    updateMappingEntry(localId, entry);

    console.log(`[GCal] 생성 완료: ${summary} → ${gcalEventId}`);
    return { gcalEventId };
  } catch (err) {
    if (isNetworkError(err) || isRateLimited(err)) {
      console.warn('[GCal] 네트워크/Rate Limit 오류 → 큐에 저장:', summary);
      enqueue({ action: 'create', localId, payload: { summary, description, date, time, type } });
    } else {
      console.error('[GCal] 생성 실패:', err.message);
    }
    return null;
  }
}

// ── UPDATE ──
async function updateGcalEvent({ localId, summary, description, date, time }) {
  const mapping = loadMapping();
  const entry = mapping[localId];

  if (!entry?.gcalEventId) {
    console.log('[GCal] 매핑 없음, 업데이트 건너뜀:', localId);
    return null;
  }

  const client = await getAuthenticatedClient();
  if (!client) return null;

  const calendar = google.calendar({ version: 'v3', auth: client });

  const resource = {};
  resource.extendedProperties = { private: { tasknote: 'true' } };
  if (summary !== undefined) resource.summary = summary;
  if (description !== undefined) resource.description = description;
  if (date !== undefined) {
    const full = buildEventResource(summary || '', description || '', date, time);
    resource.start = full.start;
    resource.end = full.end;
  } else if (time !== undefined) {
    const useDate = entry.date || new Date().toISOString().slice(0, 10);
    const full = buildEventResource(summary || '', description || '', useDate, time);
    resource.start = full.start;
    resource.end = full.end;
  }

  try {
    await withRetry(() => calendar.events.patch({
      calendarId: 'primary',
      eventId: entry.gcalEventId,
      resource,
    }));

    entry.lastSynced = new Date().toISOString();
    if (date) entry.date = date;
    if (summary !== undefined) entry.summary = summary;
    entry.syncHash = computeSyncHash(summary || entry.summary, description, date || entry.date, time, null);
    updateMappingEntry(localId, entry);

    console.log(`[GCal] 수정 완료: ${localId} → ${entry.gcalEventId}`);
    return { gcalEventId: entry.gcalEventId };
  } catch (err) {
    if (err.code === 404 || err.status === 404) {
      console.warn('[GCal] 이벤트가 Google에서 삭제됨, 매핑 제거:', localId);
      deleteMappingEntry(localId);
    } else if (isNetworkError(err) || isRateLimited(err)) {
      console.warn('[GCal] 네트워크/Rate Limit 오류 → 큐에 저장:', localId);
      enqueue({ action: 'update', localId, payload: { summary, description, date, time } });
    } else {
      console.error('[GCal] 수정 실패:', err.message);
    }
    return null;
  }
}

// ── DELETE ──
async function deleteGcalEvent({ localId }) {
  const mapping = loadMapping();
  const entry = mapping[localId];

  if (!entry?.gcalEventId) {
    console.log('[GCal] 매핑 없음, 삭제 건너뜀:', localId);
    return { success: true };
  }

  const client = await getAuthenticatedClient();
  if (!client) {
    console.warn('[GCal] 인증 안 됨 → 큐에 저장:', localId);
    enqueue({ action: 'delete', localId, payload: {} });
    return null;
  }

  const calendar = google.calendar({ version: 'v3', auth: client });

  try {
    await withRetry(() => calendar.events.delete({
      calendarId: 'primary',
      eventId: entry.gcalEventId,
    }));

    deleteMappingEntry(localId);

    console.log(`[GCal] 삭제 완료: ${localId} → ${entry.gcalEventId}`);
    return { success: true };
  } catch (err) {
    if (err.code === 404 || err.status === 404) {
      deleteMappingEntry(localId);
      return { success: true };
    } else if (isNetworkError(err) || isRateLimited(err)) {
      console.warn('[GCal] 네트워크/Rate Limit 오류 → 큐에 저장:', localId);
      enqueue({ action: 'delete', localId, payload: {} });
    } else {
      console.error('[GCal] 삭제 실패:', err.message);
    }
    return null;
  }
}

// ── 다중 삭제 ──
async function deleteMultipleGcalEvents({ localIds }) {
  const results = [];
  for (const localId of localIds) {
    const r = await deleteGcalEvent({ localId });
    results.push(r);
  }
  return results;
}

// ── 오프라인 큐 처리 ──
async function processOfflineQueue() {
  const client = await getAuthenticatedClient();
  if (!client) return { processed: 0, remaining: 0 };

  let queue = loadQueue();
  if (queue.length === 0) return { processed: 0, remaining: 0 };

  console.log(`[GCal] 오프라인 큐 처리 시작: ${queue.length}건`);

  const optimized = [];
  const deleteIds = new Set(queue.filter(q => q.action === 'delete').map(q => q.localId));

  for (const entry of queue) {
    if (entry.action === 'create' && deleteIds.has(entry.localId)) {
      deleteIds.delete(entry.localId);
      continue;
    }
    if (entry.action === 'delete' && !deleteIds.has(entry.localId)) {
      continue;
    }
    optimized.push(entry);
  }

  const updateMap = new Map();
  const final = [];
  for (const entry of optimized) {
    if (entry.action === 'update') {
      updateMap.set(entry.localId, entry);
    } else {
      final.push(entry);
    }
  }
  for (const entry of updateMap.values()) final.push(entry);

  const remaining = [];
  let processed = 0;

  for (let idx = 0; idx < final.length; idx++) {
    const entry = final[idx];
    if (idx > 0) await delay(300);
    try {
      if (entry.action === 'create') {
        await createGcalEvent({ localId: entry.localId, ...entry.payload });
      } else if (entry.action === 'update') {
        await updateGcalEvent({ localId: entry.localId, ...entry.payload });
      } else if (entry.action === 'delete') {
        await deleteGcalEvent({ localId: entry.localId });
      }
      processed++;
    } catch (err) {
      if (isNetworkError(err) || isRateLimited(err)) {
        remaining.push(entry);
      } else {
        processed++;
        console.error('[GCal] 큐 항목 처리 실패:', err.message);
      }
    }
  }

  saveQueue(remaining);
  console.log(`[GCal] 큐 처리 완료: ${processed}건 처리, ${remaining.length}건 남음`);
  return { processed, remaining: remaining.length };
}

// ── FETCH: Google Calendar → 앱 (Pull - 새 이벤트 import) ──
async function fetchGcalEvents({ timeMin, timeMax }) {
  const client = await getAuthenticatedClient();
  if (!client) return { success: false, events: [], error: 'not_connected' };

  const calendar = google.calendar({ version: 'v3', auth: client });
  const mapping = loadMapping();

  const pushedGcalIds = new Set(Object.values(mapping).map((m) => m.gcalEventId));

  try {
    const res = await withRetry(() => calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 500,
    }));

    const gcalEvents = res.data.items || [];
    const importable = [];

    for (const ev of gcalEvents) {
      if (pushedGcalIds.has(ev.id)) continue;
      if (ev.extendedProperties?.private?.tasknote === 'true') continue;
      if (ev.status === 'cancelled') continue;

      let date = '';
      let time = '';
      if (ev.start?.date) {
        date = ev.start.date;
      } else if (ev.start?.dateTime) {
        const dt = new Date(ev.start.dateTime);
        const pad = (n) => String(n).padStart(2, '0');
        date = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
        time = `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
      }

      if (!date) continue;

      importable.push({
        gcalEventId: ev.id,
        summary: ev.summary || '(제목 없음)',
        description: ev.description || '',
        date,
        time,
      });
    }

    console.log(`[GCal] Fetch 완료: ${gcalEvents.length}건 중 ${importable.length}건 import 가능`);
    return { success: true, events: importable };
  } catch (err) {
    console.error('[GCal] Fetch 실패:', err.message);
    return { success: false, events: [], error: err.message };
  }
}

// ── PULL: 앱이 Push한 이벤트의 GCal 쪽 변경사항 감지 ──
async function pullChangesFromGcal({ timeMin, timeMax }) {
  const client = await getAuthenticatedClient();
  if (!client) return { success: false, changes: [], error: 'not_connected' };

  const calendar = google.calendar({ version: 'v3', auth: client });

  try {
    // tasknote=true 이벤트만 조회 (앱이 push한 이벤트 + imported 이벤트)
    const res = await withRetry(() => calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 500,
      privateExtendedProperty: 'tasknote=true',
    }));

    const gcalEvents = res.data.items || [];
    const mapping = loadMapping();

    // gcalEventId → localId 역방향 맵
    const gcalIdToLocal = new Map();
    for (const [localId, entry] of Object.entries(mapping)) {
      if (entry.gcalEventId) gcalIdToLocal.set(entry.gcalEventId, { localId, ...entry });
    }

    const changes = [];
    const pad = (n) => String(n).padStart(2, '0');

    for (const ev of gcalEvents) {
      if (ev.status === 'cancelled') continue;
      const local = gcalIdToLocal.get(ev.id);
      if (!local) continue;

      // GCal에서 현재 값 추출
      let gcalDate = '';
      let gcalTime = '';
      if (ev.start?.date) {
        gcalDate = ev.start.date;
      } else if (ev.start?.dateTime) {
        const dt = new Date(ev.start.dateTime);
        gcalDate = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
        gcalTime = `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
      }

      const gcalSummary = ev.summary || '';
      const gcalDescription = ev.description || '';

      // 로컬 매핑과 비교하여 변경사항 감지
      const change = {
        localId: local.localId,
        type: local.type,
        gcalEventId: ev.id,
      };

      let hasChange = false;

      // 제목 변경 감지
      if (local.summary !== undefined && gcalSummary !== local.summary) {
        change.summaryChanged = true;
        change.newSummary = gcalSummary;
        change.oldSummary = local.summary;

        // "(완료)" 태그 변경 감지
        const wasCompleted = (local.summary || '').startsWith('(완료)');
        const isNowCompleted = gcalSummary.startsWith('(완료)');
        if (wasCompleted && !isNowCompleted) {
          change.completionChanged = 'uncompleted';
          change.cleanName = gcalSummary;
        } else if (!wasCompleted && isNowCompleted) {
          change.completionChanged = 'completed';
          change.cleanName = gcalSummary.replace(/^\(완료\)\s*/, '');
        }

        hasChange = true;
      }

      // 날짜 변경 감지
      if (local.date && gcalDate && gcalDate !== local.date) {
        change.dateChanged = true;
        change.newDate = gcalDate;
        change.oldDate = local.date;
        hasChange = true;
      }

      // 시간 변경 감지 (시간 정보가 있는 경우만)
      if (gcalTime) {
        change.newTime = gcalTime;
        // 시간 비교는 syncHash로 간접 감지
      }

      if (hasChange) {
        changes.push(change);
      }
    }

    if (changes.length > 0) {
      console.log(`[GCal] Pull: ${changes.length}건 변경 감지`);
    }

    return { success: true, changes };
  } catch (err) {
    console.error('[GCal] Pull 실패:', err.message);
    return { success: false, changes: [], error: err.message };
  }
}

// ── 가져온 이벤트의 매핑 저장 + GCal에 TaskNote 식별자 추가 ──
async function saveImportMapping(localId, gcalEventId, date) {
  const entry = {
    gcalEventId,
    lastSynced: new Date().toISOString(),
    type: 'imported',
    date,
    syncHash: null,
  };
  updateMappingEntry(localId, entry);

  try {
    const client = await getAuthenticatedClient();
    if (!client) return;
    const calendar = google.calendar({ version: 'v3', auth: client });
    await calendar.events.patch({
      calendarId: 'primary',
      eventId: gcalEventId,
      resource: { extendedProperties: { private: { tasknote: 'true' } } },
    });
  } catch (e) {
    console.warn('[GCal] import 식별자 추가 실패:', e.message);
  }
}

// ── FETCH: 공휴일 캘린더 ──
async function fetchHolidays({ timeMin, timeMax }) {
  const client = await getAuthenticatedClient();
  if (!client) return { success: false, holidays: [], error: 'not_connected' };

  const calendar = google.calendar({ version: 'v3', auth: client });

  try {
    const res = await withRetry(() => calendar.events.list({
      calendarId: 'ko.south_korea#holiday@group.v.calendar.google.com',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
    }));

    const holidays = (res.data.items || [])
      .filter((ev) => ev.status !== 'cancelled' && ev.start?.date)
      .map((ev) => ({ name: ev.summary || '', date: ev.start.date }));

    console.log(`[GCal] 공휴일 ${holidays.length}건 로드`);
    return { success: true, holidays };
  } catch (err) {
    console.error('[GCal] 공휴일 fetch 실패:', err.message);
    return { success: false, holidays: [], error: err.message };
  }
}

// ── 매핑 정리: 유효한 localId 목록에 없는 매핑의 GCal 이벤트 삭제 ──
async function cleanupStaleMapping({ validLocalIds }) {
  const client = await getAuthenticatedClient();
  if (!client) return { deleted: 0 };

  const mapping = loadMapping();
  const validSet = new Set(validLocalIds);
  const calendar = google.calendar({ version: 'v3', auth: client });

  const PAST_DAYS_TO_KEEP = 7;
  const cutoffDate = new Date();
  cutoffDate.setHours(0, 0, 0, 0);
  cutoffDate.setDate(cutoffDate.getDate() - PAST_DAYS_TO_KEEP);
  const pad2 = (n) => String(n).padStart(2, '0');
  const cutoffStr = `${cutoffDate.getFullYear()}-${pad2(cutoffDate.getMonth() + 1)}-${pad2(cutoffDate.getDate())}`;

  const staleIds = Object.keys(mapping).filter((id) => {
    if (validSet.has(id)) return false;
    if (mapping[id].type === 'imported') return false;
    if (mapping[id].type === 'recurring' && id.startsWith('recurring:')) {
      const dateMatch = id.match(/:(\d{4}-\d{2}-\d{2})$/);
      if (dateMatch && dateMatch[1] >= cutoffStr) return false;
    }
    return true;
  });

  if (staleIds.length === 0) return { deleted: 0 };
  console.log(`[GCal] 잔여 매핑 정리 시작: ${staleIds.length}건`);

  let deleted = 0;
  for (const localId of staleIds) {
    const entry = mapping[localId];
    if (!entry?.gcalEventId) { deleteMappingEntry(localId); continue; }
    try {
      await calendar.events.delete({ calendarId: 'primary', eventId: entry.gcalEventId });
      deleteMappingEntry(localId);
      deleted++;
    } catch (err) {
      if (err.code === 404 || err.status === 404) {
        deleteMappingEntry(localId);
        deleted++;
      } else {
        console.warn(`[GCal] 잔여 삭제 실패: ${localId}`, err.message);
      }
    }
    await delay(300);
  }

  console.log(`[GCal] 잔여 매핑 정리 완료: ${deleted}건 삭제`);
  return { deleted };
}

// ── 중복 이벤트 감지 및 정리 ──
async function deduplicateGcalEvents({ timeMin, timeMax }) {
  const client = await getAuthenticatedClient();
  if (!client) return { success: false, error: 'not_connected', duplicates: 0 };

  const calendar = google.calendar({ version: 'v3', auth: client });

  try {
    const res = await withRetry(() => calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 500,
      privateExtendedProperty: 'tasknote=true',
    }));

    const events = res.data.items || [];
    if (events.length === 0) return { success: true, duplicates: 0, checked: 0 };

    const groups = new Map();
    for (const ev of events) {
      if (ev.status === 'cancelled') continue;
      const date = ev.start?.date || (ev.start?.dateTime ? ev.start.dateTime.slice(0, 10) : '');
      if (!date) continue;
      const cleanSummary = (ev.summary || '').replace(/^\(완료\)\s*/, '');
      const key = `${date}|${cleanSummary}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ev);
    }

    const mapping = loadMapping();
    let duplicateCount = 0;

    for (const [key, group] of groups) {
      if (group.length <= 1) continue;
      const mappedGcalIds = new Set(Object.values(mapping).map(m => m.gcalEventId));
      group.sort((a, b) => {
        const aMapped = mappedGcalIds.has(a.id) ? 1 : 0;
        const bMapped = mappedGcalIds.has(b.id) ? 1 : 0;
        if (aMapped !== bMapped) return bMapped - aMapped;
        return new Date(b.updated || 0) - new Date(a.updated || 0);
      });

      for (let i = 1; i < group.length; i++) {
        try {
          await calendar.events.delete({ calendarId: 'primary', eventId: group[i].id });
          duplicateCount++;
        } catch (err) {
          if (err.code !== 404 && err.status !== 404) {
            console.warn(`[GCal] 중복 삭제 실패: ${group[i].id}`, err.message);
          }
        }
        await delay(200);
      }
    }

    console.log(`[GCal] 중복 정리 완료: ${events.length}건 검사, ${duplicateCount}건 삭제`);
    return { success: true, duplicates: duplicateCount, checked: events.length };
  } catch (err) {
    console.error('[GCal] 중복 감지 실패:', err.message);
    return { success: false, error: err.message, duplicates: 0 };
  }
}

// ── 전체 리셋 ──
async function gcalFullReset() {
  const client = await getAuthenticatedClient();
  if (!client) return { success: false, error: 'not_connected' };

  const calendar = google.calendar({ version: 'v3', auth: client });
  let deleted = 0;
  let skipped = 0;

  const mapping = loadMapping();
  const entries = Object.entries(mapping);
  const toKeep = entries.filter(([, entry]) => entry.type === 'imported');
  const toDelete = entries.filter(([, entry]) => entry.type !== 'imported');
  const deletedGcalIds = new Set();

  console.log(`[GCal] 전체 리셋 시작: 매핑 ${toDelete.length}건 + GCal 검색`);

  for (const [localId, entry] of toDelete) {
    if (!entry?.gcalEventId) { skipped++; continue; }
    try {
      await calendar.events.delete({ calendarId: 'primary', eventId: entry.gcalEventId });
      deletedGcalIds.add(entry.gcalEventId);
      deleted++;
    } catch (err) {
      if (err.code === 404 || err.status === 404) {
        deletedGcalIds.add(entry.gcalEventId);
        deleted++;
      } else {
        console.warn(`[GCal] 매핑 삭제 실패 (${localId}):`, err.message);
        skipped++;
      }
    }
    await delay(200);
  }

  try {
    const now = new Date();
    const timeMin = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
    const timeMax = new Date(now.getFullYear(), now.getMonth() + 3, 0).toISOString();
    const res = await withRetry(() => calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      maxResults: 500,
      privateExtendedProperty: 'tasknote=true',
    }));
    const orphans = (res.data.items || []).filter((ev) => !deletedGcalIds.has(ev.id));
    console.log(`[GCal] 고아 이벤트 ${orphans.length}건 발견`);
    for (const ev of orphans) {
      try {
        await calendar.events.delete({ calendarId: 'primary', eventId: ev.id });
        deleted++;
      } catch (err) {
        if (err.code !== 404 && err.status !== 404) skipped++;
      }
      await delay(200);
    }
  } catch (err) {
    console.warn('[GCal] 고아 이벤트 검색 실패:', err.message);
  }

  saveMapping(Object.fromEntries(toKeep));
  saveQueue([]);

  console.log(`[GCal] 전체 리셋 완료: ${deleted}건 삭제, ${skipped}건 스킵`);
  return { success: true, deleted, skipped };
}

module.exports = {
  createGcalEvent,
  updateGcalEvent,
  deleteGcalEvent,
  deleteMultipleGcalEvents,
  processOfflineQueue,
  fetchGcalEvents,
  pullChangesFromGcal,
  fetchHolidays,
  saveImportMapping,
  loadMapping,
  cleanupStaleMapping,
  gcalFullReset,
  deduplicateGcalEvents,
  computeSyncHash,
};
