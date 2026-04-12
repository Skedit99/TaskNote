/**
 * Google Calendar 동기화 헬퍼 (Renderer)
 *
 * 모든 GCal 작업은 단일 디바운스 큐를 통과합니다.
 * - create/update/del: 사용자 액션 → 큐 추가 → 디바운스 후 전송
 * - syncExisting: 앱 시작/10분 주기 → 큐에 일괄 추가 → 같은 큐로 전송
 * - 중복 방지: _optimize()가 같은 localId의 중복 작업을 병합/상쇄
 */
import { isElectron } from "../constants";
import { todayKey } from "../utils/helpers";

const DEBOUNCE_MS = 1000;
const MAX_WAIT_MS = 5000;

const gcal = {
  // ── 내부 상태 ──
  _queue: [],
  _flushTimer: null,
  _maxWaitTimer: null,
  _flushing: false,
  _flushPromise: null,
  _syncRunning: false,
  _initialSyncDone: false,
  _initialSyncPromise: null,

  // ── 큐 추가 ──
  _enqueue(action, localId, payload) {
    if (!isElectron) return;
    gcal._queue.push({ action, localId, payload, ts: Date.now() });

    clearTimeout(gcal._flushTimer);
    gcal._flushTimer = setTimeout(() => { gcal._flushPromise = gcal._flush(); }, DEBOUNCE_MS);

    if (!gcal._maxWaitTimer) {
      gcal._maxWaitTimer = setTimeout(() => { gcal._flushPromise = gcal._flush(); }, MAX_WAIT_MS);
    }
  },

  // ── 큐 최적화: 같은 localId에 대한 중복 제거 + 상쇄 ──
  _optimize(queue) {
    const byId = new Map();
    for (const op of queue) {
      const existing = byId.get(op.localId);
      if (!existing) {
        byId.set(op.localId, op);
        continue;
      }
      // create → delete = 양쪽 삭제 (상쇄)
      if (existing.action === "create" && op.action === "delete") {
        byId.delete(op.localId);
        continue;
      }
      // create → update = create에 필드 병합
      if (existing.action === "create" && op.action === "update") {
        existing.payload = { ...existing.payload, ...op.payload };
        existing.ts = op.ts;
        continue;
      }
      // update → update = 나중 것으로 병합
      if (existing.action === "update" && op.action === "update") {
        existing.payload = { ...existing.payload, ...op.payload };
        existing.ts = op.ts;
        continue;
      }
      // update → delete = delete만 남김
      if (existing.action === "update" && op.action === "delete") {
        byId.set(op.localId, op);
        continue;
      }
      // create → create = 나중 것으로 교체 (같은 localId 중복 생성 방지)
      if (existing.action === "create" && op.action === "create") {
        existing.payload = op.payload;
        existing.ts = op.ts;
        continue;
      }
      // 기타: 나중 것으로 교체
      byId.set(op.localId, op);
    }
    return Array.from(byId.values());
  },

  // ── 큐 비우기 + 일괄 전송 ──
  async _flush() {
    if (gcal._queue.length === 0) {
      if (gcal._flushing) return gcal._flushPromise;
      return;
    }
    if (gcal._flushing) return gcal._flushPromise;
    gcal._flushing = true;

    clearTimeout(gcal._flushTimer);
    clearTimeout(gcal._maxWaitTimer);
    gcal._flushTimer = null;
    gcal._maxWaitTimer = null;

    const ops = gcal._optimize(gcal._queue);
    gcal._queue = [];

    if (ops.length > 0) console.log(`[GCal 큐] 플러시: ${ops.length}건`);

    for (let i = 0; i < ops.length; i += 3) {
      const chunk = ops.slice(i, i + 3);
      await Promise.all(chunk.map(op => {
        if (op.action === "create") {
          return window.electronAPI.gcalSyncCreate(op.payload)
            .catch(e => console.warn(`[GCal 큐] create 실패: ${op.localId}`, e?.message));
        }
        if (op.action === "update") {
          return window.electronAPI.gcalSyncUpdate(op.payload)
            .catch(e => console.warn(`[GCal 큐] update 실패: ${op.localId}`, e?.message));
        }
        if (op.action === "delete") {
          return window.electronAPI.gcalSyncDelete({ localId: op.localId })
            .catch(e => console.warn(`[GCal 큐] delete 실패: ${op.localId}`, e?.message));
        }
        return Promise.resolve();
      }));
      if (i + 3 < ops.length) await new Promise(r => setTimeout(r, 500));
    }

    gcal._flushing = false;
    gcal._flushPromise = null;

    if (gcal._queue.length > 0) {
      gcal._flushTimer = setTimeout(() => { gcal._flushPromise = gcal._flush(); }, DEBOUNCE_MS);
    }
  },

  // ── 공개 API (큐 경유) ──
  create(payload) {
    gcal._enqueue("create", payload.localId, payload);
  },

  update(payload) {
    gcal._enqueue("update", payload.localId, payload);
  },

  del(localId) {
    gcal._enqueue("delete", localId, {});
  },

  delMultiple(localIds) {
    if (!isElectron) return;
    for (const id of localIds) gcal._enqueue("delete", id, {});
  },

  // 강제 flush — 진행 중인 flush 완료까지 대기
  async forceFlush() {
    clearTimeout(gcal._flushTimer);
    clearTimeout(gcal._maxWaitTimer);
    if (gcal._flushing && gcal._flushPromise) {
      await gcal._flushPromise;
    }
    if (gcal._queue.length > 0) {
      gcal._flushPromise = gcal._flush();
      await gcal._flushPromise;
    }
  },

  // 오프라인 큐 처리 (main process 큐)
  flushOfflineQueue() {
    if (!isElectron) return;
    window.electronAPI.gcalSyncFlushQueue().catch((e) => console.warn("[gcal] flush:", e));
  },

  // 초기 동기화 완료까지 대기 (fetchGcalEvents가 호출 전 사용)
  waitForInitialSync() {
    if (gcal._initialSyncDone) return Promise.resolve();
    if (gcal._initialSyncPromise) return gcal._initialSyncPromise;
    return Promise.resolve();
  },

  // ── GCal 전체 리셋 후 재동기화 ──
  async fullReset(appData) {
    if (!isElectron) return;
    console.log("[GCal] 전체 리셋 시작...");
    try {
      const result = await window.electronAPI.gcalFullReset();
      console.log("[GCal] 전체 리셋 결과:", result);
      if (result?.success) {
        gcal._syncRunning = false;
        gcal._initialSyncDone = false;
        gcal.syncExisting(appData);
      }
    } catch (e) {
      console.error("[GCal] 전체 리셋 실패:", e);
    }
  },

  // ══════════════════════════════════════
  // 기존 데이터 일괄 동기화 — 모든 작업을 단일 큐에 추가
  // (직접 IPC 호출 없음, 디바운스 큐의 _optimize가 중복 처리)
  // ══════════════════════════════════════
  async syncExisting(appData) {
    if (!isElectron) return;
    if (gcal._syncRunning) return;
    gcal._syncRunning = true;

    // 기존 큐를 먼저 플러시
    try { await gcal.forceFlush(); } catch (_) {}

    const getTaskInfo = (pid, tid) => {
      if (pid === "event") {
        const ev = (appData.events || []).find((e) => e.id === tid);
        return { name: ev?.name || "(제목 없음)", desc: ev?.description || "" };
      }
      if (pid === "recurring") {
        const rec = (appData.recurring || []).find((r) => r.id === tid);
        return { name: rec?.name || "(제목 없음)", desc: "" };
      }
      const proj = (appData.projects || []).find((p) => p.id === pid);
      if (proj) {
        const findInArr = (arr, id) => {
          for (const t of arr) {
            if (t.id === id) return t;
            if (t.children) { const found = findInArr(t.children, id); if (found) return found; }
          }
          return null;
        };
        const task = findInArr(proj.subtasks || [], tid);
        return { name: task?.name || "(제목 없음)", desc: task?.description || "" };
      }
      return { name: "(알 수 없음)", desc: "" };
    };

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const maxDate = new Date(today);
    maxDate.setMonth(maxDate.getMonth() + 1);
    const pastDate = new Date(today);
    pastDate.setDate(pastDate.getDate() - 7);
    const pad = (n) => String(n).padStart(2, "0");

    // 완료된 항목 ID 수집
    const completedTaskIds = new Set();
    for (const items of Object.values(appData.completedToday || {})) {
      for (const c of items) completedTaskIds.add(c.taskId);
    }

    // 독립 일정 (GCal import된 이벤트는 제외)
    for (const ev of (appData.events || [])) {
      if (ev.deleted || ev.gcalSourceId) continue;
      const isCompleted = completedTaskIds.has(ev.id);
      const summary = isCompleted ? `(완료) ${ev.name}` : ev.name;
      gcal._enqueue("create", ev.id, { localId: ev.id, summary, description: ev.description || "", date: ev.date, time: ev.time || "", endTime: ev.endTime || "", type: "event" });
    }

    // 예약된 업무
    const scheduledTaskIds = new Set();
    for (const [dateKey, items] of Object.entries(appData.scheduled || {})) {
      for (const s of items) {
        scheduledTaskIds.add(s.taskId);
        const isCompleted = completedTaskIds.has(s.taskId);
        const info = getTaskInfo(s.projectId, s.taskId);
        const summary = isCompleted ? `(완료) ${info.name}` : info.name;
        gcal._enqueue("create", s.taskId, { localId: s.taskId, summary, description: info.desc, date: dateKey, time: s.time || "", endTime: s.endTime || "", type: "scheduled" });
      }
    }

    // completedToday에만 있고 scheduled에 없는 완료 항목
    for (const [dateKey, items] of Object.entries(appData.completedToday || {})) {
      for (const c of items) {
        if (scheduledTaskIds.has(c.taskId)) continue;
        if (c.projectId === "recurring" || c.projectId === "event") continue;
        const info = getTaskInfo(c.projectId, c.taskId);
        gcal._enqueue("create", c.taskId, { localId: c.taskId, summary: `(완료) ${info.name}`, description: info.desc, date: dateKey, time: c.time || "", type: "scheduled" });
      }
    }

    // 정기 업무 전개
    const completedByDate = new Map();
    for (const [dk, items] of Object.entries(appData.completedToday || {})) {
      const ids = new Set(items.filter((c) => c.projectId === "recurring").map((c) => c.taskId));
      if (ids.size > 0) completedByDate.set(dk, ids);
    }

    const skips = appData.recurringSkips || {};
    const adds = appData.recurringAdds || {};

    for (const r of (appData.recurring || [])) {
      if (!r.active) continue;
      const limit = r.endDate ? new Date(r.endDate + "T23:59:59") : maxDate;
      const startFrom = r.startDate ? new Date(r.startDate) : pastDate;
      const cursor = new Date(Math.max(pastDate.getTime(), startFrom.getTime()));
      const regularDates = new Set();

      if (r.type === "weekly") {
        while (cursor.getDay() !== r.dayValue && cursor <= limit) cursor.setDate(cursor.getDate() + 1);
        const interval = r.interval || 1;
        if (interval > 1 && r.startDate) {
          const refDate = new Date(r.startDate); refDate.setHours(0, 0, 0, 0);
          while (refDate.getDay() !== r.dayValue) refDate.setDate(refDate.getDate() + 1);
          const diffWeeks = Math.floor(Math.floor((cursor - refDate) / 86400000) / 7);
          const remainder = diffWeeks % interval;
          if (remainder !== 0) cursor.setDate(cursor.getDate() + (interval - remainder) * 7);
        }
        while (cursor <= limit) {
          regularDates.add(`${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`);
          cursor.setDate(cursor.getDate() + (interval * 7));
        }
      } else if (r.type === "monthly") {
        cursor.setDate(1);
        while (cursor <= limit) {
          let targetDay;
          if (r.monthlyMode === "nthWeekday") {
            const firstDay = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
            let firstOcc = firstDay.getDay() <= r.nthDayOfWeek
              ? 1 + (r.nthDayOfWeek - firstDay.getDay())
              : 1 + (7 - firstDay.getDay() + r.nthDayOfWeek);
            const candidate = firstOcc + (r.nthWeek - 1) * 7;
            const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
            targetDay = candidate <= lastDay ? candidate : null;
          } else {
            const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
            targetDay = r.dayValue === -1 ? lastDay : (r.dayValue <= lastDay ? r.dayValue : null);
          }
          if (targetDay) {
            const d = new Date(cursor.getFullYear(), cursor.getMonth(), targetDay);
            if (d >= pastDate && d <= limit) {
              regularDates.add(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
            }
          }
          cursor.setMonth(cursor.getMonth() + 1);
        }
      }

      for (const dateKey of regularDates) {
        if ((skips[dateKey] || []).includes(r.id)) regularDates.delete(dateKey);
      }
      for (const [dateKey, addIds] of Object.entries(adds)) {
        if (addIds.includes(r.id) && !regularDates.has(dateKey)) {
          const d = new Date(dateKey);
          if (d >= pastDate && d <= maxDate) regularDates.add(dateKey);
        }
      }

      for (const dateKey of regularDates) {
        const isDone = completedByDate.get(dateKey)?.has(r.id);
        const summary = isDone ? `(완료) ${r.name}` : r.name;
        const compositeId = `recurring:${r.id}:${dateKey}`;
        gcal._enqueue("create", compositeId, { localId: compositeId, summary, description: "", date: dateKey, time: r.time || "", endTime: r.endTime || "", type: "recurring" });
      }
    }

    console.log(`[GCal] 일괄 동기화: ${gcal._queue.length}건 큐에 추가`);

    // 큐 flush 실행 (디바운스 없이 즉시)
    try {
      gcal._flushPromise = gcal._flush();
      await gcal._flushPromise;
    } catch (e) {
      console.warn("[GCal] 일괄 동기화 flush 실패:", e);
    }

    // 잔여 매핑 정리
    try {
      const validLocalIds = [];
      // 독립 이벤트
      for (const ev of (appData.events || [])) { if (!ev.deleted && !ev.gcalSourceId) validLocalIds.push(ev.id); }
      // 예약된 업무
      for (const items of Object.values(appData.scheduled || {})) { for (const s of items) validLocalIds.push(s.taskId); }
      // 완료된 업무
      for (const items of Object.values(appData.completedToday || {})) {
        for (const c of items) { if (c.projectId !== "recurring" && c.projectId !== "event") validLocalIds.push(c.taskId); }
      }
      // 정기 업무
      for (const r of (appData.recurring || [])) { if (r.active) validLocalIds.push(r.id); }
      // 프로젝트 서브태스크 (scheduled/completedToday에 없어도 매핑 보존)
      // → 레벨 변경 등으로 scheduled에서 제거되어도 매핑이 유지됨
      for (const p of (appData.projects || [])) {
        if (p.deleted) continue;
        const collectIds = (tasks) => { for (const t of tasks) { validLocalIds.push(t.id); if (t.children) collectIds(t.children); } };
        collectIds(p.subtasks || []);
      }

      const result = await window.electronAPI.gcalCleanupStale({ validLocalIds });
      if (result?.deleted > 0) console.log(`[GCal] 잔여 이벤트 ${result.deleted}건 정리됨`);
    } catch (e) {
      console.warn("[GCal] 잔여 정리 실패:", e);
    }

    gcal._initialSyncDone = true;
    gcal._syncRunning = false;
  },
};

export default gcal;
