import { findTaskById, todayKey } from "../utils/helpers";
import { getHydratedTodayTasks } from "../utils/selectors";

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

export function createTodayTaskActions({ data, updateData, gcal }) {
  // ?? ?ㅻ뒛 ??????
  // 자정이 지나면 이전 날짜의 미완료 업무를 자동 정리 (과거에 남기고, 오늘로 이월하지 않음)
  (() => {
    const key = todayKey();
    const stale = (data.todayTasks || []).filter((t) => !t.completed && t.addedDate && t.addedDate !== key);
    if (stale.length > 0) {
      updateData((d) => {
        d.todayTasks = d.todayTasks.filter((t) => t.completed || !t.addedDate || t.addedDate === key);
      });
    }
  })();

  const addToToday = (pid, tid) => {
    if (data.todayTasks.some((t) => t.taskId === tid)) return;
    const proj = data.projects.find((p) => p.id === pid);
    const task = findTaskById(proj?.subtasks || [], tid);
    if (!task || task.done) return;
    updateData((d) => {
      d.todayTasks.push({ projectId: pid, taskId: tid, completed: false, addedDate: todayKey(), updatedAt: Date.now() });
    });
    // GCal???ㅻ뒛 ?쇱젙?쇰줈 push
    gcal.create({ localId: tid, summary: task.name, description: task.description || "", date: todayKey(), time: task.time || "", type: "scheduled" });
  };

  const toggleTodayTask = (tid) => {
    // 완료 전에 projectId 캡처 (GCal 복원용)
    const todayEntry = data.todayTasks.find((x) => x.taskId === tid);
    const wasCompleted = todayEntry?.completed;

    updateData((d) => {
      const t = d.todayTasks.find((x) => x.taskId === tid);
      if (!t) return;
      t.completed = !t.completed;
      t.updatedAt = Date.now();
      const key = todayKey();
      if (t.completed) {
        t.completedAt = new Date().toISOString();
        if (!d.completedToday[key]) d.completedToday[key] = [];
        if (!d.completedToday[key].some((c) => c.taskId === tid))
          d.completedToday[key].push({ projectId: t.projectId, taskId: t.taskId, completedAt: t.completedAt, updatedAt: Date.now() });
        const p = d.projects.find((x) => x.id === t.projectId);
        if (p) { const st = findTaskById(p.subtasks, tid); if (st) { st.done = true; st.updatedAt = Date.now(); } }
        // 완료 시 scheduled에서 제거하되, 과거 날짜는 completedToday로 이동 (캘린더 히스토리 유지)
        if (d.scheduled) {
          for (const [dk, items] of Object.entries(d.scheduled)) {
            const found = items.find((s) => s.taskId === tid);
            if (found) {
              d.scheduled[dk] = items.filter((s) => s.taskId !== tid);
              if (d.scheduled[dk].length === 0) delete d.scheduled[dk];
              // 과거 날짜의 scheduled 항목은 해당 날짜의 completedToday로 이동
              if (dk !== key) {
                if (!d.completedToday[dk]) d.completedToday[dk] = [];
                if (!d.completedToday[dk].some((c) => c.taskId === tid)) {
                  d.completedToday[dk].push({ projectId: found.projectId, taskId: tid, completedAt: t.completedAt, updatedAt: Date.now() });
                }
              }
            }
          }
        }
      } else {
        delete t.completedAt;
        if (d.completedToday[key]) d.completedToday[key] = d.completedToday[key].filter((c) => c.taskId !== tid);
        const p = d.projects.find((x) => x.id === t.projectId);
        if (p) { const st = findTaskById(p.subtasks, tid); if (st) { st.done = false; st.updatedAt = Date.now(); } }
      }
    });

    // GCal 이벤트 이름에 완료 상태 반영 (삭제/생성 대신 이름만 업데이트)
    if (todayEntry) {
      const name = getTaskName(data, todayEntry.projectId, tid);
      if (name) {
        const localId = todayEntry.projectId === "recurring" ? `recurring:${tid}:${todayKey()}` : tid;
        gcal.update({ localId, summary: !wasCompleted ? `(완료) ${name}` : name });
      }
    }
  };

  const updateCompletedAt = (tid, newTime) => {
    updateData((d) => {
      const t = d.todayTasks.find((x) => x.taskId === tid);
      if (t && t.completed) { t.completedAt = newTime; t.updatedAt = Date.now(); }
      const key = todayKey();
      const c = d.completedToday[key]?.find((x) => x.taskId === tid);
      if (c) { c.completedAt = newTime; c.updatedAt = Date.now(); }
    });
  };

  const removeFromToday = (tid) => {
    updateData((d) => {
      d.todayTasks = d.todayTasks.filter((t) => t.taskId !== tid);
      // scheduled에서도 제거 (예약된 업무로 강등 방지)
      if (d.scheduled) {
        for (const [dk, items] of Object.entries(d.scheduled)) {
          const idx = items.findIndex((s) => s.taskId === tid);
          if (idx !== -1) {
            d.scheduled[dk].splice(idx, 1);
            if (d.scheduled[dk].length === 0) delete d.scheduled[dk];
          }
        }
      }
      // completedToday에서도 제거 (완료 해제 후 삭제 시 잔여 방지)
      if (d.completedToday) {
        for (const [dk, items] of Object.entries(d.completedToday)) {
          const idx = items.findIndex((c) => c.taskId === tid);
          if (idx !== -1) {
            d.completedToday[dk].splice(idx, 1);
            if (d.completedToday[dk].length === 0) delete d.completedToday[dk];
          }
        }
      }
    });
    gcal.del(tid);
  };

  // ?? ?좎쭨蹂??꾨즺/誘몄셿猷???
  const completeForDate = (dateKey, item) => {
    updateData((d) => {
      if (!d.completedToday[dateKey]) d.completedToday[dateKey] = [];
      if (d.completedToday[dateKey].some((c) => c.taskId === item.taskId)) return;
      const entry = { projectId: item.projectId, taskId: item.taskId, completedAt: new Date().toISOString(), updatedAt: Date.now() };
      d.completedToday[dateKey].push(entry);
      if (item.projectId && item.projectId !== "recurring" && item.projectId !== "event") {
        const p = d.projects.find((x) => x.id === item.projectId);
        if (p) { const st = findTaskById(p.subtasks, item.taskId); if (st) { st.done = true; st.updatedAt = Date.now(); } }
      }
      const tt = d.todayTasks.find((x) => x.taskId === item.taskId);
      if (tt) { tt.completed = true; tt.completedAt = new Date().toISOString(); tt.updatedAt = Date.now(); }
      else if (dateKey === todayKey()) {
        d.todayTasks.push({ projectId: item.projectId, taskId: item.taskId, completed: true, completedAt: new Date().toISOString(), addedDate: todayKey(), updatedAt: Date.now() });
      }
      // 완료 시 모든 날짜의 scheduled에서 제거 (task.done = true이므로)
      if (d.scheduled) {
        for (const [dk, items] of Object.entries(d.scheduled)) {
          const found = items.find((s) => s.taskId === item.taskId);
          if (found) {
            d.scheduled[dk] = items.filter((s) => s.taskId !== item.taskId);
            if (d.scheduled[dk].length === 0) delete d.scheduled[dk];
            // 다른 날짜의 scheduled 항목은 해당 날짜의 completedToday로 이동
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
    // 완료 해제 전에 정보 캡처 (GCal 재생성용)
    const compEntry = data.completedToday[dateKey]?.find((c) => c.taskId === taskId);

    updateData((d) => {
      const comp = d.completedToday[dateKey]?.find((c) => c.taskId === taskId);
      if (d.completedToday[dateKey]) {
        d.completedToday[dateKey] = d.completedToday[dateKey].filter((c) => c.taskId !== taskId);
        if (d.completedToday[dateKey].length === 0) delete d.completedToday[dateKey];
      }
      for (const p of d.projects) {
        const st = findTaskById(p.subtasks, taskId);
        if (st) { st.done = false; st.updatedAt = Date.now(); break; }
      }
      const tt = d.todayTasks.find((x) => x.taskId === taskId);
      if (tt) { tt.completed = false; delete tt.completedAt; tt.updatedAt = Date.now(); }
      else if (dateKey === todayKey() && comp) {
        d.todayTasks.push({ projectId: comp.projectId, taskId, completed: false, addedDate: todayKey(), updatedAt: Date.now() });
      }
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

  // ?? ?덉빟 ??
  const addToScheduled = (pid, tid, dateKey) => {
    const proj = data.projects.find((p) => p.id === pid);
    const task = findTaskById(proj?.subtasks || [], tid);
    if (!task || task.done) return;
    updateData((d) => {
      if (!d.scheduled) d.scheduled = {};
      if (!d.scheduled[dateKey]) d.scheduled[dateKey] = [];
      if (d.scheduled[dateKey].some((s) => s.taskId === tid)) return;
      d.scheduled[dateKey].push({ projectId: pid, taskId: tid, updatedAt: Date.now() });
      // 오늘 날짜면 todayTasks에도 추가
      if (dateKey === todayKey() && !d.todayTasks.some((t) => t.taskId === tid)) {
        d.todayTasks.push({ projectId: pid, taskId: tid, completed: false, addedDate: todayKey(), updatedAt: Date.now() });
      }
    });
    gcal.create({ localId: tid, summary: task.name, description: task.description || "", date: dateKey, time: task.time || "", type: "scheduled" });
  };

  const deleteScheduled = (dateKey, idxOrTaskId) => {
    // ??젣 ?꾩뿉 taskId ?뺣낫 (index??寃쎌슦)
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

  const moveScheduledToToday = (dateKey, item) => {
    if (data.todayTasks.some((t) => t.taskId === item.taskId)) return;
    updateData((d) => {
      d.todayTasks.push({ projectId: item.projectId, taskId: item.taskId, completed: false, addedDate: todayKey(), updatedAt: Date.now() });
      if (d.scheduled?.[dateKey]) {
        d.scheduled[dateKey] = d.scheduled[dateKey].filter((s) => s.taskId !== item.taskId);
        if (d.scheduled[dateKey].length === 0) delete d.scheduled[dateKey];
      }
    });
    // GCal 날짜를 오늘로 업데이트
    if (dateKey !== todayKey()) {
      gcal.update({ localId: item.taskId, date: todayKey() });
    }
  };

  const getScheduledForDay = (day, year, month, calYear, calMonth) => {
    if (!day) return [];
    const y = year !== undefined ? year : calYear;
    const m = month !== undefined ? month : calMonth;
    const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return data.scheduled?.[key] || [];
  };

  // ?? ?뚯깮 ?곹깭 ??
  const hydratedTasks = getHydratedTodayTasks(data);
  const pendingToday = hydratedTasks.filter((t) => !t.completed);
  const doneToday = hydratedTasks.filter((t) => t.completed).sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));

  // ?? ?쒓컙 愿????
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
    const tt = data.todayTasks.find((t) => t.taskId === taskId);
    if (tt?.time) return tt.time;
    if (data.scheduled) {
      for (const items of Object.values(data.scheduled)) {
        const s = items.find((x) => x.taskId === taskId);
        if (s?.time) return s.time;
      }
    }
    return "";
  };

  const updateTaskTime = (taskId, time) => {
    updateData((d) => {
      const tt = d.todayTasks.find((t) => t.taskId === taskId);
      if (tt) { tt.time = time; tt.updatedAt = Date.now(); }
      if (d.scheduled) { for (const items of Object.values(d.scheduled)) { const s = items.find((x) => x.taskId === taskId); if (s) { s.time = time; s.updatedAt = Date.now(); } } }
      if (d.completedToday) { for (const items of Object.values(d.completedToday)) { const c = items.find((x) => x.taskId === taskId); if (c) { c.time = time; c.updatedAt = Date.now(); } } }
    });
    gcal.update({ localId: taskId, time });
  };

  return {
    addToToday, toggleTodayTask, removeFromToday, updateCompletedAt,
    completeForDate, uncompleteForDate, isCompletedForDate,
    addToScheduled, deleteScheduled, moveScheduledToToday, getScheduledForDay,
    pendingToday, doneToday,
    getScheduledDateForTask, getTaskTime, updateTaskTime,
  };
}
