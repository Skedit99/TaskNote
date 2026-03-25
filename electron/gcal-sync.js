// ═══════════════════════════════
// Google Calendar 동기화 모듈
// ═══════════════════════════════
// 단방향 push: 앱 → Google Calendar
// 매핑 파일 + 오프라인 큐 관리

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAuthenticatedClient } = require('./google-auth');

const MAPPING_FILE = 'gcal-mapping.json';
const QUEUE_FILE = 'gcal-queue.json';

// ── 매핑 캐시 ──
let cachedMapping = null;

// ── 매핑 파일 (localId → gcalEventId) ──
function getMappingPath(app) {
  return path.join(app.getPath('userData'), MAPPING_FILE);
}

function loadMapping(app) {
  if (cachedMapping) return cachedMapping;
  try {
    const p = getMappingPath(app);
    if (fs.existsSync(p)) {
      cachedMapping = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return cachedMapping;
    }
  } catch (e) {
    console.error('매핑 로드 실패:', e.message);
  }
  cachedMapping = {};
  return cachedMapping;
}

function saveMapping(app, mapping) {
  try {
    cachedMapping = mapping;
    fs.writeFileSync(getMappingPath(app), JSON.stringify(mapping, null, 2), 'utf-8');
  } catch (e) {
    console.error('매핑 저장 실패:', e.message);
  }
}

// ── 오프라인 큐 ──
function getQueuePath(app) {
  return path.join(app.getPath('userData'), QUEUE_FILE);
}

function loadQueue(app) {
  try {
    const p = getQueuePath(app);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error('큐 로드 실패:', e.message);
  }
  return [];
}

function saveQueue(app, queue) {
  try {
    fs.writeFileSync(getQueuePath(app), JSON.stringify(queue, null, 2), 'utf-8');
  } catch (e) {
    console.error('큐 저장 실패:', e.message);
  }
}

function enqueue(app, entry) {
  const queue = loadQueue(app);
  queue.push({ ...entry, timestamp: new Date().toISOString() });
  saveQueue(app, queue);
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

// ── Rate Limit (429) 판별 ──
function isRateLimited(err) {
  return err.code === 429 || err.status === 429 ||
    (err.message || '').includes('429') ||
    (err.message || '').toLowerCase().includes('rate limit');
}

// ── 딜레이 유틸 ──
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── 지수 백오프 재시도 래퍼 ──
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
        throw err; // 재시도 불가능한 오류는 즉시 throw
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
      const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // +1시간
      const pad = (n) => String(n).padStart(2, '0');
      endStr = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:00`;
    }

    resource.start = { dateTime: startDT, timeZone: tz };
    resource.end = { dateTime: endStr, timeZone: tz };
  } else {
    // 종일 이벤트
    resource.start = { date };
    // Google Calendar 종일 이벤트는 end가 다음날이어야 함
    const d = new Date(date);
    d.setDate(d.getDate() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    const endDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    resource.end = { date: endDate };
  }

  // TaskNote에서 생성한 이벤트 식별자 (import 시 필터링용)
  resource.extendedProperties = { private: { tasknote: 'true' } };

  return resource;
}

// ── CREATE ──
async function createGcalEvent(app, { localId, summary, description, date, time, endTime, type }) {
  // 이미 매핑이 있으면 중복 생성 방지 (변경 감지 시 update)
  const existingMapping = loadMapping(app);
  if (existingMapping[localId]?.gcalEventId) {
    const existing = existingMapping[localId];

    // 날짜나 제목 변경 → update 시도
    if (existing.date !== date || existing.summary !== summary) {
      console.log(`[GCal] 매핑 존재하지만 변경 감지, 업데이트: ${localId}`);
      existing.date = date;
      existing.summary = summary;
      saveMapping(app, existingMapping);

      const updateResult = await updateGcalEvent(app, { localId, summary, description, date, time });
      if (updateResult === null) {
        // update 실패 (404 등) → 매핑 이미 삭제됨 → 아래에서 새로 생성
        console.log(`[GCal] 업데이트 실패, 재생성 시도: ${localId}`);
      } else {
        return { gcalEventId: existing.gcalEventId };
      }
    } else {
      // 변경 없음 → 매핑 신뢰 (완료 상태가 삭제/재생성을 유발하지 않으므로 매핑 안정적)
      return { gcalEventId: existing.gcalEventId };
    }
  }

  // 매핑 없음 → 새로 생성
  const client = await getAuthenticatedClient();
  if (!client) return null; // 연결 안 됨 → 무시

  const calendar = google.calendar({ version: 'v3', auth: client });
  const resource = buildEventResource(summary, description, date, time, endTime);

  try {
    const res = await withRetry(() => calendar.events.insert({
      calendarId: 'primary',
      resource,
    }));

    const gcalEventId = res.data.id;
    const mapping = loadMapping(app);
    mapping[localId] = {
      gcalEventId,
      lastSynced: new Date().toISOString(),
      type: type || 'event',
      date,
      summary,
    };
    saveMapping(app, mapping);

    console.log(`[GCal] 생성 완료: ${summary} → ${gcalEventId}`);
    return { gcalEventId };
  } catch (err) {
    if (isNetworkError(err) || isRateLimited(err)) {
      console.warn('[GCal] 네트워크/Rate Limit 오류 → 큐에 저장:', summary);
      enqueue(app, { action: 'create', localId, payload: { summary, description, date, time, type } });
    } else {
      console.error('[GCal] 생성 실패:', err.message);
    }
    return null;
  }
}

// ── UPDATE ──
async function updateGcalEvent(app, { localId, summary, description, date, time }) {
  const mapping = loadMapping(app);
  const entry = mapping[localId];

  if (!entry?.gcalEventId) {
    // 매핑 없음 → 큐에 create로 저장 (오프라인 생성 후 수정된 경우)
    console.log('[GCal] 매핑 없음, 업데이트 건너뜀:', localId);
    return null;
  }

  const client = await getAuthenticatedClient();
  if (!client) return null;

  const calendar = google.calendar({ version: 'v3', auth: client });

  // patch용 리소스: undefined 필드는 전송 안 됨
  const resource = {};
  // 기존 이벤트에도 TaskNote 식별자 추가 (마이그레이션)
  resource.extendedProperties = { private: { tasknote: 'true' } };
  if (summary !== undefined) resource.summary = summary;
  if (description !== undefined) resource.description = description;
  if (date !== undefined) {
    const full = buildEventResource(summary || '', description || '', date, time);
    resource.start = full.start;
    resource.end = full.end;
  } else if (time !== undefined) {
    // 시간만 변경 — 기존 date 사용
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
    saveMapping(app, mapping);

    console.log(`[GCal] 수정 완료: ${localId} → ${entry.gcalEventId}`);
    return { gcalEventId: entry.gcalEventId };
  } catch (err) {
    if (err.code === 404 || err.status === 404) {
      // Google에서 이미 삭제됨 → 매핑 제거 (createGcalEvent에서 재생성 처리)
      console.warn('[GCal] 이벤트가 Google에서 삭제됨, 매핑 제거:', localId);
      delete mapping[localId];
      saveMapping(app, mapping);
    } else if (isNetworkError(err) || isRateLimited(err)) {
      console.warn('[GCal] 네트워크/Rate Limit 오류 → 큐에 저장:', localId);
      enqueue(app, { action: 'update', localId, payload: { summary, description, date, time } });
    } else {
      console.error('[GCal] 수정 실패:', err.message);
    }
    return null;
  }
}

// ── DELETE ──
async function deleteGcalEvent(app, { localId }) {
  const mapping = loadMapping(app);
  const entry = mapping[localId];

  if (!entry?.gcalEventId) {
    console.log('[GCal] 매핑 없음, 삭제 건너뜀:', localId);
    return { success: true }; // 매핑 없으면 GCal에도 없으므로 성공 취급
  }

  const client = await getAuthenticatedClient();
  if (!client) {
    // 인증 안 됨 → 매핑을 유지하고 큐에 저장 (나중에 재시도)
    console.warn('[GCal] 인증 안 됨 → 큐에 저장:', localId);
    enqueue(app, { action: 'delete', localId, payload: {} });
    return null;
  }

  const calendar = google.calendar({ version: 'v3', auth: client });

  try {
    await withRetry(() => calendar.events.delete({
      calendarId: 'primary',
      eventId: entry.gcalEventId,
    }));

    // GCal에서 성공적으로 삭제된 후에만 매핑 제거
    delete mapping[localId];
    saveMapping(app, mapping);

    console.log(`[GCal] 삭제 완료: ${localId} → ${entry.gcalEventId}`);
    return { success: true };
  } catch (err) {
    if (err.code === 404 || err.status === 404) {
      // GCal에서 이미 삭제됨 → 매핑 제거 (동기화 확정)
      delete mapping[localId];
      saveMapping(app, mapping);
      return { success: true };
    } else if (isNetworkError(err) || isRateLimited(err)) {
      // 매핑 유지한 채 큐에 저장 (fetchGcalEvents에서 재import 방지)
      console.warn('[GCal] 네트워크/Rate Limit 오류 → 큐에 저장:', localId);
      enqueue(app, { action: 'delete', localId, payload: {} });
    } else {
      console.error('[GCal] 삭제 실패:', err.message);
    }
    return null;
  }
}

// ── 다중 삭제 (프로젝트 삭제 시) ──
async function deleteMultipleGcalEvents(app, { localIds }) {
  const results = [];
  for (const localId of localIds) {
    const r = await deleteGcalEvent(app, { localId });
    results.push(r);
  }
  return results;
}

// ── 오프라인 큐 처리 ──
async function processOfflineQueue(app) {
  const client = await getAuthenticatedClient();
  if (!client) return { processed: 0, remaining: 0 };

  let queue = loadQueue(app);
  if (queue.length === 0) return { processed: 0, remaining: 0 };

  console.log(`[GCal] 오프라인 큐 처리 시작: ${queue.length}건`);

  // 큐 최적화: 같은 localId에 대해 create→delete 쌍이면 둘 다 제거
  const optimized = [];
  const deleteIds = new Set(queue.filter(q => q.action === 'delete').map(q => q.localId));

  for (const entry of queue) {
    if (entry.action === 'create' && deleteIds.has(entry.localId)) {
      deleteIds.delete(entry.localId); // 쌍 제거
      continue;
    }
    if (entry.action === 'delete' && !deleteIds.has(entry.localId)) {
      continue; // 위에서 create와 함께 제거됨
    }
    optimized.push(entry);
  }

  // 같은 localId의 중복 update는 마지막 것만 유지
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
    // 요청 간 300ms 딜레이 (첫 번째 제외) — Rate Limit 방지
    if (idx > 0) await delay(300);
    try {
      if (entry.action === 'create') {
        await createGcalEvent(app, { localId: entry.localId, ...entry.payload });
      } else if (entry.action === 'update') {
        await updateGcalEvent(app, { localId: entry.localId, ...entry.payload });
      } else if (entry.action === 'delete') {
        await deleteGcalEvent(app, { localId: entry.localId });
      }
      processed++;
    } catch (err) {
      if (isNetworkError(err) || isRateLimited(err)) {
        remaining.push(entry); // 네트워크/Rate Limit → 다시 큐에
      } else {
        processed++; // 다른 오류는 포기
        console.error('[GCal] 큐 항목 처리 실패:', err.message);
      }
    }
  }

  saveQueue(app, remaining);
  console.log(`[GCal] 큐 처리 완료: ${processed}건 처리, ${remaining.length}건 남음`);
  return { processed, remaining: remaining.length };
}

// ── FETCH: Google Calendar → 앱 (Pull) ──
async function fetchGcalEvents(app, { timeMin, timeMax }) {
  const client = await getAuthenticatedClient();
  if (!client) return { success: false, events: [], error: 'not_connected' };

  const calendar = google.calendar({ version: 'v3', auth: client });
  const mapping = loadMapping(app);

  // 이미 앱에서 push한 gcalEventId 목록 (중복 import 방지)
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
      // 앱에서 push한 이벤트는 건너뜀 (매핑 기반)
      if (pushedGcalIds.has(ev.id)) continue;
      // TaskNote가 생성한 이벤트는 건너뜀 (식별자 기반 — 매핑 유실 시에도 안전)
      if (ev.extendedProperties?.private?.tasknote === 'true') continue;
      // 취소된 이벤트 건너뜀
      if (ev.status === 'cancelled') continue;

      // 날짜 파싱
      let date = '';
      let time = '';
      if (ev.start?.date) {
        // 종일 이벤트
        date = ev.start.date;
      } else if (ev.start?.dateTime) {
        // 시간 지정 이벤트
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

// ── 가져온 이벤트의 매핑 저장 + GCal에 TaskNote 식별자 추가 ──
async function saveImportMapping(app, localId, gcalEventId, date) {
  const mapping = loadMapping(app);
  mapping[localId] = {
    gcalEventId,
    lastSynced: new Date().toISOString(),
    type: 'imported',
    date,
  };
  saveMapping(app, mapping);

  // GCal 이벤트에 TaskNote 식별자 추가 (이후 매핑 유실 시에도 재import 방지)
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
    // 실패해도 매핑은 이미 저장됨 — 식별자는 보조 수단
    console.warn('[GCal] import 식별자 추가 실패:', e.message);
  }
}

// ── FETCH: 공휴일 캘린더 ──
async function fetchHolidays(app, { timeMin, timeMax }) {
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

module.exports = {
  createGcalEvent,
  updateGcalEvent,
  deleteGcalEvent,
  deleteMultipleGcalEvents,
  processOfflineQueue,
  fetchGcalEvents,
  fetchHolidays,
  saveImportMapping,
  loadMapping,
};
