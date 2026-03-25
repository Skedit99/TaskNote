import { isElectron } from "../constants";
import { todayKey } from "../utils/helpers";

// ══════════════════════════════════════
// Google Calendar 동기화 헬퍼
// ── 디바운스 배치 큐 방식 ──
// 개별 작업을 즉시 전송하지 않고 큐에 모은 뒤
// 일정 시간(DEBOUNCE_MS) 후 최적화하여 일괄 전송
// ══════════════════════════════════════

const DEBOUNCE_MS = 1000;  // 마지막 변경 후 1초 대기
const MAX_WAIT_MS = 5000;  // 첫 큐 추가 후 최대 5초 대기

const gcal = {
  // ── 초기 동기화 ──
  _initialSyncDone: false,
  _initialSyncPromise: null,
  waitForInitialSync: async () => {
    if (gcal._initialSyncPromise) await gcal._initialSyncPromise;
  },

  // ── 디바운스 배치 큐 ──
  _queue: [],
  _flushTimer: null,
  _maxWaitTimer: null,
  _flushing: false,

  // 큐에 작업 추가 + 디바운스/최대대기 타이머 관리
  _enqueue(action, localId, payload) {
    if (!isElectron) return;
    gcal._queue.push({ action, localId, payload, ts: Date.now() });

    // 디바운스: 마지막 enqueue 후 1초 뒤에 flush
    clearTimeout(gcal._flushTimer);
    gcal._flushTimer = setTimeout(() => gcal._flush(), DEBOUNCE_MS);

    // 최대 대기: 첫 enqueue 후 5초면 강제 flush (무한 지연 방지)
    if (!gcal._maxWaitTimer) {
      gcal._maxWaitTimer = setTimeout(() => gcal._flush(), MAX_WAIT_MS);
    }
  },

  // 큐 최적화: 같은 localId에 대한 중복 제거 + 상쇄
  _optimize(queue) {
    const byId = new Map();
    for (const op of queue) {
      const existing = byId.get(op.localId);

      if (!existing) {
        byId.set(op.localId, op);
        continue;
      }

      // create → delete = 서로 상쇄 (생성 취소)
      if (existing.action === "create" && op.action === "delete") {
        byId.delete(op.localId);
        continue;
      }

      // create → update = create에 업데이트 필드 병합
      if (existing.action === "create" && op.action === "update") {
        existing.payload = { ...existing.payload, ...op.payload };
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

      // 기타: 나중 것이 우선
      byId.set(op.localId, op);
    }
    return Array.from(byId.values());
  },

  // 큐 비우기 + 일괄 전송
  async _flush() {
    if (gcal._queue.length === 0 || gcal._flushing) return;
    gcal._flushing = true;

    // 타이머 정리
    clearTimeout(gcal._flushTimer);
    clearTimeout(gcal._maxWaitTimer);
    gcal._flushTimer = null;
    gcal._maxWaitTimer = null;

    const ops = gcal._optimize(gcal._queue);
    gcal._queue = [];

    console.log(`[GCal 큐] 플러시: ${ops.length}건`);

    // 3건씩, 500ms 간격으로 전송 (Rate Limit 방지)
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

    // flush 중에 새 항목이 쌓였으면 다시 flush
    if (gcal._queue.length > 0) {
      gcal._flushTimer = setTimeout(() => gcal._flush(), DEBOUNCE_MS);
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

  // 앱 종료 전 강제 flush (대기 없이 즉시)
  forceFlush() {
    clearTimeout(gcal._flushTimer);
    return gcal._flush();
  },

  // 오프라인 큐 처리 (main process 큐)
  flushOfflineQueue() {
    if (!isElectron) return;
    window.electronAPI.gcalSyncFlushQueue().catch((e) => console.warn("[gcal] flush:", e));
  },

  // ══════════════════════════════════════
  // 기존 데이터 일괄 동기화 (앱 시작 시 1회)
  // ══════════════════════════════════════
  syncExisting(appData) {
    if (!isElectron) return;

    // ── 태스크 정보 조회 헬퍼 ──
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
    const pad = (n) => String(n).padStart(2, "0");

    const batch = [];

    // 완료된 항목 ID 수집
    const completedTaskIds = new Set();
    for (const items of Object.values(appData.completedToday || {})) {
      for (const c of items) completedTaskIds.add(c.taskId);
    }
    for (const t of (appData.todayTasks || [])) {
      if (t.completed) completedTaskIds.add(t.taskId);
    }

    // 독립 일정 (완료 시 "(완료)" 접두사)
    for (const ev of (appData.events || [])) {
      if (ev.deleted) continue;
      const isCompleted = completedTaskIds.has(ev.id);
      const summary = isCompleted ? `(완료) ${ev.name}` : ev.name;
      batch.push({ localId: ev.id, summary, description: ev.description || "", date: ev.date, time: ev.time || "", type: "event" });
    }

    // 예약된 업무 (완료 시 "(완료)" 접두사)
    const scheduledTaskIds = new Set();
    for (const [dateKey, items] of Object.entries(appData.scheduled || {})) {
      for (const s of items) {
        scheduledTaskIds.add(s.taskId);
        const isCompleted = completedTaskIds.has(s.taskId);
        const info = getTaskInfo(s.projectId, s.taskId);
        const summary = isCompleted ? `(완료) ${info.name}` : info.name;
        batch.push({ localId: s.taskId, summary, description: info.desc, date: dateKey, time: s.time || "", type: "scheduled" });
      }
    }

    // completedToday에만 있고 scheduled에 없는 완료 항목 (프로젝트 업무만)
    // recurring은 정기업무 전개 루프에서, event는 독립일정 루프에서 각각 처리됨
    for (const [dateKey, items] of Object.entries(appData.completedToday || {})) {
      for (const c of items) {
        if (scheduledTaskIds.has(c.taskId)) continue;
        if (c.projectId === "recurring" || c.projectId === "event") continue;
        const info = getTaskInfo(c.projectId, c.taskId);
        batch.push({ localId: c.taskId, summary: `(완료) ${info.name}`, description: info.desc, date: dateKey, time: c.time || "", type: "scheduled" });
      }
    }

    // 오늘 할 일 (scheduled에 없는 것만)
    const todayStr = todayKey();
    for (const t of (appData.todayTasks || [])) {
      if (scheduledTaskIds.has(t.taskId)) continue;
      if (completedTaskIds.has(t.taskId) && t.projectId !== "recurring" && t.projectId !== "event") continue;
      if (t.projectId === "recurring" || t.projectId === "event") continue;
      const info = getTaskInfo(t.projectId, t.taskId);
      const summary = t.completed ? `(완료) ${info.name}` : info.name;
      batch.push({ localId: t.taskId, summary, description: info.desc, date: todayStr, time: t.time || "", type: "scheduled" });
    }

    // 날짜별 정기업무 완료 여부 조회용 맵 (dateKey → Set of taskId)
    const completedByDate = new Map();
    for (const [dk, items] of Object.entries(appData.completedToday || {})) {
      const ids = new Set(items.filter((c) => c.projectId === "recurring").map((c) => c.taskId));
      if (ids.size > 0) completedByDate.set(dk, ids);
    }

    // 정기 업무 전개 (완료 시 "(완료)" 접두사, skip/add 반영)
    const skips = appData.recurringSkips || {};
    const adds = appData.recurringAdds || {};

    for (const r of (appData.recurring || [])) {
      if (!r.active) continue;
      const limit = r.endDate ? new Date(r.endDate + "T23:59:59") : maxDate;
      const startFrom = r.startDate ? new Date(r.startDate) : today;
      const cursor = new Date(Math.max(today.getTime(), startFrom.getTime()));

      // 이 정기업무가 정규 스케줄로 나타나는 날짜 수집
      const regularDates = new Set();

      if (r.type === "weekly") {
        while (cursor.getDay() !== r.dayValue && cursor <= limit) cursor.setDate(cursor.getDate() + 1);
        const interval = r.interval || 1;
        if (interval > 1 && r.startDate) {
          const refDate = new Date(r.startDate);
          refDate.setHours(0, 0, 0, 0);
          while (refDate.getDay() !== r.dayValue) refDate.setDate(refDate.getDate() + 1);
          const diffWeeks = Math.floor(Math.floor((cursor - refDate) / 86400000) / 7);
          const remainder = diffWeeks % interval;
          if (remainder !== 0) cursor.setDate(cursor.getDate() + (interval - remainder) * 7);
        }
        while (cursor <= limit) {
          const dateKey = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`;
          regularDates.add(dateKey);
          cursor.setDate(cursor.getDate() + (interval * 7));
        }
      } else if (r.type === "monthly") {
        cursor.setDate(1);
        while (cursor <= limit) {
          const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
          const targetDay = r.dayValue === -1 ? lastDay : r.dayValue;
          if (targetDay <= lastDay) {
            const d = new Date(cursor.getFullYear(), cursor.getMonth(), targetDay);
            if (d >= today && d <= limit) {
              const dateKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
              regularDates.add(dateKey);
            }
          }
          cursor.setMonth(cursor.getMonth() + 1);
        }
      }

      // skip된 날짜 제거
      for (const dateKey of regularDates) {
        if ((skips[dateKey] || []).includes(r.id)) regularDates.delete(dateKey);
      }

      // 수동 추가(adds)된 날짜 포함
      for (const [dateKey, addIds] of Object.entries(adds)) {
        if (addIds.includes(r.id) && !regularDates.has(dateKey)) {
          // 범위 내인지 체크
          const d = new Date(dateKey);
          if (d >= today && d <= maxDate) regularDates.add(dateKey);
        }
      }

      // batch에 추가
      for (const dateKey of regularDates) {
        const isDone = completedByDate.get(dateKey)?.has(r.id);
        const summary = isDone ? `(완료) ${r.name}` : r.name;
        batch.push({ localId: `recurring:${r.id}:${dateKey}`, summary, description: "", date: dateKey, time: r.time || "", type: "recurring" });
      }
    }

    // ── 배치 실행 (큐를 우회하여 직접 전송) ──
    const processBatch = async () => {
      console.log(`[GCal] 일괄 동기화 시작: ${batch.length}건`);
      let successCount = 0;
      let skipCount = 0;
      let failCount = 0;
      for (let i = 0; i < batch.length; i += 3) {
        const chunk = batch.slice(i, i + 3);
        await Promise.all(chunk.map(item =>
          window.electronAPI.gcalSyncCreate(item)
            .then((result) => {
              if (result?.gcalEventId) successCount++;
              else { skipCount++; }
            })
            .catch(() => { failCount++; })
        ));
        if (i + 3 < batch.length) await new Promise(r => setTimeout(r, 500));
      }
      console.log(`[GCal] 일괄 동기화 완료: 성공 ${successCount}건, 건너뜀 ${skipCount}건, 실패 ${failCount}건`);

      // 잔여 GCal 이벤트 정리: 유효한 localId에 없는 매핑 삭제
      const validLocalIds = batch.map((b) => b.localId);
      try {
        const result = await window.electronAPI.gcalCleanupStale({ validLocalIds });
        if (result?.deleted > 0) console.log(`[GCal] 잔여 이벤트 ${result.deleted}건 정리됨`);
      } catch (e) {
        console.warn("[GCal] 잔여 정리 실패:", e);
      }

      gcal._initialSyncDone = true;
    };
    gcal._initialSyncPromise = processBatch();
  },
};

export default gcal;
