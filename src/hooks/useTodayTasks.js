import { findTaskById, todayKey } from "../utils/helpers";
import { deriveTodayTasks } from "../utils/selectors";

// 타입별 업무 이름 조회 (프로젝트 업무, 독립일정, 정기일정)
function getTaskName(data, projectId, taskId) {
  if (projectId === "event") {
    const ev = (data.events || []).find((e) => e.id === taskId);
    return ev?.name || null;
  }
  if (projectId === "recurring") {
    const rec = (data.recurring || []).find((r) => r.id === taskId);
    return rec?.name || null;
  }
  const proj = data.projects.find((p) => p.id === projectId);
  const task = proj ? findTaskById(proj.subtasks || [], taskId) : null;
  return task?.name || null;
}

// projectId를 찾는 헬퍼 (completedToday, scheduled, events에서 검색)
function findProjectIdForTask(data, taskId) {
  const key = todayKey();
  // completedToday에서 검색
  const comp = (data.completedToday?.[key] || []).find((c) => c.taskId === taskId);
  if (comp) return comp.projectId;
  // scheduled에서 검색
  const sched = (data.scheduled?.[key] || []).find((s) => s.taskId === taskId);
  if (sched) return sched.projectId;
  // events에서 검색
  const ev = (data.events || []).find((e) => e.id === taskId);
  if (ev) return "event";
  // recurring에서 검색
  const rec = (data.recurring || []).find((r) => r.id === taskId);
  if (rec) return "recurring";
  // projects에서 검색
  for (const p of (data.projects || [])) {
    if (findTaskById(p.subtasks || [], taskId)) return p.id;
  }
  return null;
}

export function createTodayTaskActions({ data, updateData, gcal }) {

  const toggleTodayTask = (tid) => {
    const key = todayKey();
    const isCurrentlyCompleted = (data.completedToday?.[key] || []).some((c) => c.taskId === tid);
    const projectId = findProjectIdForTask(data, tid);

    updateData((d) => {
      const k = todayKey();
      if (!isCurrentlyCompleted) {
        // 완료 처리
        if (!d.completedToday[k]) d.completedToday[k] = [];
        if (!d.completedToday[k].some((c) => c.taskId === tid)) {
          d.completedToday[k].push({ projectId: projectId, taskId: tid, completedAt: new Date().toISOString(), updatedAt: Date.now() });
        }
        // 프로젝트 서브태스크 done 상태 + 부모 프로젝트 updatedAt 갱신 (저장 보장)
        if (projectId && projectId !== "recurring" && projectId !== "event") {
          const p = d.projects.find((x) => x.id === projectId);
          if (p) {
            const st = findTaskById(p.subtasks, tid);
            if (st) { st.done = true; st.updatedAt = Date.now(); }
            p.updatedAt = Date.now();
          }
        }
        // 완료 시 scheduled에서 제거, 과거 날짜는 completedToday로 이동
        if (d.scheduled) {
          for (const [dk, items] of Object.entries(d.scheduled)) {
            const found = items.find((s) => s.taskId === tid);
            if (found) {
              d.scheduled[dk] = items.filter((s) => s.taskId !== tid);
              if (d.scheduled[dk].length === 0) delete d.scheduled[dk];
              if (dk !== k) {
                if (!d.completedToday[dk]) d.completedToday[dk] = [];
                if (!d.completedToday[dk].some((c) => c.taskId === tid)) {
                  d.completedToday[dk].push({ projectId: found.projectId, taskId: tid, completedAt: new Date().toISOString(), updatedAt: Date.now() });
                }
              }
            }
          }
        }
      } else {
        // 완료 해제
        if (d.completedToday[k]) {
          d.completedToday[k] = d.completedToday[k].filter((c) => c.taskId !== tid);
          if (d.completedToday[k].length === 0) delete d.completedToday[k];
        }
        if (projectId && projectId !== "recurring" && projectId !== "event") {
          const p = d.projects.find((x) => x.id === projectId);
          if (p) {
            const st = findTaskById(p.subtasks, tid);
            if (st) { st.done = false; st.updatedAt = Date.now(); }
            p.updatedAt = Date.now();
          }
          // scheduled에 복원 (완료 시 제거되었으므로)
          if (!d.scheduled) d.scheduled = {};
          if (!d.scheduled[k]) d.scheduled[k] = [];
          if (!d.scheduled[k].some((s) => s.taskId === tid)) {
            d.scheduled[k].push({ projectId: projectId, taskId: tid, updatedAt: Date.now() });
          }
        }
      }
    });

    // GCal 이벤트 이름에 완료 상태 반영
    if (projectId) {
      const name = getTaskName(data, projectId, tid);
      if (name) {
        const localId = projectId === "recurring" ? `recurring:${tid}:${key}` : tid;
        gcal.update({ localId, summary: !isCurrentlyCompleted ? `(완료) ${name}` : name });
      }
    }
  };

  const updateCompletedAt = (tid, newTime) => {
    updateData((d) => {
      const key = todayKey();
      const c = d.completedToday[key]?.find((x) => x.taskId === tid);
      if (c) { c.completedAt = newTime; c.updatedAt = Date.now(); }
    });
  };

  // 날짜별 완료/미완료 처리
  const completeForDate = (dateKey, item) => {
    updateData((d) => {
      if (!d.completedToday[dateKey]) d.completedToday[dateKey] = [];
      if (d.completedToday[dateKey].some((c) => c.taskId === item.taskId)) return;
      const entry = { projectId: item.projectId, taskId: item.taskId, completedAt: new Date().toISOString(), updatedAt: Date.now() };
      d.completedToday[dateKey].push(entry);
      if (item.projectId && item.projectId !== "recurring" && item.projectId !== "event") {
        const p = d.projects.find((x) => x.id === item.projectId);
        if (p) {
          const st = findTaskById(p.subtasks, item.taskId);
          if (st) { st.done = true; st.updatedAt = Date.now(); }
          p.updatedAt = Date.now();
        }
      }
      // 완료 시 모든 날짜의 scheduled에서 제거
      if (d.scheduled) {
        for (const [dk, items] of Object.entries(d.scheduled)) {
          const found = items.find((s) => s.taskId === item.taskId);
          if (found) {
            d.scheduled[dk] = items.filter((s) => s.taskId !== item.taskId);
            if (d.scheduled[dk].length === 0) delete d.scheduled[dk];
            if (dk !== dateKey) {
              if (!d.completedToday[dk]) d.completedToday[dk] = [];
              if (!d.completedToday[dk].some((c) => c.taskId === item.taskId)) {
                d.completedToday[dk].push({ projectId: found.projectId, taskId: item.taskId, completedAt: new Date().toISOString(), updatedAt: Date.now() });
              }
            }
          }
        }
      }
    });
    // GCal 이벤트 이름에 "(완료)" 추가
    if (item.projectId) {
      const name = getTaskName(data, item.projectId, item.taskId);
      if (name) {
        const localId = item.projectId === "recurring" ? `recurring:${item.taskId}:${dateKey}` : item.taskId;
        gcal.update({ localId, summary: `(완료) ${name}` });
      }
    }
  };

  const uncompleteForDate = (dateKey, taskId) => {
    const compEntry = data.completedToday[dateKey]?.find((c) => c.taskId === taskId);

    updateData((d) => {
      const comp = d.completedToday[dateKey]?.find((c) => c.taskId === taskId);
      if (d.completedToday[dateKey]) {
        d.completedToday[dateKey] = d.completedToday[dateKey].filter((c) => c.taskId !== taskId);
        if (d.completedToday[dateKey].length === 0) delete d.completedToday[dateKey];
      }
      for (const p of d.projects) {
        const st = findTaskById(p.subtasks, taskId);
        if (st) { st.done = false; st.updatedAt = Date.now(); p.updatedAt = Date.now(); break; }
      }
      // 프로젝트 서브태스크면 scheduled에 복원
      if (comp && comp.projectId && comp.projectId !== "recurring" && comp.projectId !== "event") {
        if (!d.scheduled) d.scheduled = {};
        if (!d.scheduled[dateKey]) d.scheduled[dateKey] = [];
        if (!d.scheduled[dateKey].some((s) => s.taskId === taskId)) {
          d.scheduled[dateKey].push({ projectId: comp.projectId, taskId: comp.taskId, updatedAt: Date.now() });
        }
      }
    });

    // GCal 이벤트 이름에서 "(완료)" 제거
    if (compEntry && compEntry.projectId) {
      const name = getTaskName(data, compEntry.projectId, taskId);
      if (name) {
        const localId = compEntry.projectId === "recurring" ? `recurring:${taskId}:${dateKey}` : taskId;
        gcal.update({ localId, summary: name });
      }
    }
  };

  const isCompletedForDate = (dateKey, taskId) => {
    return (data.completedToday[dateKey] || []).some((c) => c.taskId === taskId);
  };

  // 예약 관리
  const addToScheduled = (pid, tid, dateKey) => {
    const proj = data.projects.find((p) => p.id === pid);
    const task = findTaskById(proj?.subtasks || [], tid);
    if (!task || task.done) return;
    updateData((d) => {
      if (!d.scheduled) d.scheduled = {};
      if (!d.scheduled[dateKey]) d.scheduled[dateKey] = [];
      if (d.scheduled[dateKey].some((s) => s.taskId === tid)) return;
      d.scheduled[dateKey].push({ projectId: pid, taskId: tid, updatedAt: Date.now() });
    });
    gcal.create({ localId: tid, summary: task.name, description: task.description || "", date: dateKey, time: task.time || "", type: "scheduled" });
  };

  const deleteScheduled = (dateKey, idxOrTaskId) => {
    let delTaskId = idxOrTaskId;
    if (typeof idxOrTaskId === "number") {
      const items = data.scheduled?.[dateKey];
      if (items?.[idxOrTaskId]) delTaskId = items[idxOrTaskId].taskId;
    }
    updateData((d) => {
      if (d.scheduled?.[dateKey]) {
        if (typeof idxOrTaskId === "number") d.scheduled[dateKey].splice(idxOrTaskId, 1);
        else d.scheduled[dateKey] = d.scheduled[dateKey].filter((s) => s.taskId !== idxOrTaskId);
        if (d.scheduled[dateKey].length === 0) delete d.scheduled[dateKey];
      }
    });
    if (delTaskId) gcal.del(delTaskId);
  };

  const getScheduledForDay = (day, year, month, calYear, calMonth) => {
    if (!day) return [];
    const y = year !== undefined ? year : calYear;
    const m = month !== undefined ? month : calMonth;
    const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return data.scheduled?.[key] || [];
  };

  // 파생 상태 계산
  const hydratedTasks = deriveTodayTasks(data);
  const pendingToday = hydratedTasks.filter((t) => !t.completed);
  const doneToday = hydratedTasks.filter((t) => t.completed).sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));

  // 시간 관리
  const getScheduledDateForTask = (taskId) => {
    if (!data.scheduled) return null;
    for (const [dateKey, items] of Object.entries(data.scheduled)) {
      const found = items.find((s) => s.taskId === taskId);
      if (found) {
        const [y, m, d] = dateKey.split("-");
        return { dateKey, label: `${parseInt(m)}/${parseInt(d)}`, time: found.time || "" };
      }
    }
    return null;
  };

  const getTaskTime = (taskId) => {
    // scheduled에서 시간 검색
    if (data.scheduled) {
      for (const items of Object.values(data.scheduled)) {
        const s = items.find((x) => x.taskId === taskId);
        if (s?.time) return s.time;
      }
    }
    // events에서 시간 검색
    const ev = (data.events || []).find((e) => e.id === taskId);
    if (ev?.time) return ev.time;
    // recurring에서 시간 검색
    const rec = (data.recurring || []).find((r) => r.id === taskId);
    if (rec?.time) return rec.time;
    return "";
  };

  const updateTaskTime = (taskId, time) => {
    updateData((d) => {
      if (d.scheduled) { for (const items of Object.values(d.scheduled)) { const s = items.find((x) => x.taskId === taskId); if (s) { s.time = time; s.updatedAt = Date.now(); } } }
      if (d.completedToday) { for (const items of Object.values(d.completedToday)) { const c = items.find((x) => x.taskId === taskId); if (c) { c.time = time; c.updatedAt = Date.now(); } } }
    });
    gcal.update({ localId: taskId, time });
  };

  return {
    toggleTodayTask, updateCompletedAt,
    completeForDate, uncompleteForDate, isCompletedForDate,
    addToScheduled, deleteScheduled, getScheduledForDay,
    pendingToday, doneToday,
    getScheduledDateForTask, getTaskTime, updateTaskTime,
  };
}
