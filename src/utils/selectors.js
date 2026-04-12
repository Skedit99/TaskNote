import { findTaskById, todayKey, weeksBetween } from "./helpers";

// nth weekday helper: N번째 주 특정 요일의 날짜 (없으면 null)
function getNthWeekdayOfMonth(year, month, nthWeek, dayOfWeek) {
  const firstDay = new Date(year, month, 1);
  let firstOccurrence = firstDay.getDay() <= dayOfWeek
    ? 1 + (dayOfWeek - firstDay.getDay())
    : 1 + (7 - firstDay.getDay() + dayOfWeek);
  const targetDay = firstOccurrence + (nthWeek - 1) * 7;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return targetDay <= lastDay ? targetDay : null;
}

/**
 * 특정 날짜에 해당하는 recurring 항목들을 반환합니다.
 * useRecurring.js의 getRecurringForDay와 동일한 로직을 공유합니다.
 */
export const getRecurringItemsForDate = (data, dateKey) => {
  if (!dateKey || !data?.recurring) return [];
  const [yStr, mStr, dStr] = dateKey.split("-");
  const y = parseInt(yStr), m = parseInt(mStr) - 1, day = parseInt(dStr);
  const date = new Date(y, m, day);
  const dow = date.getDay(), dom = date.getDate();
  const skips = data.recurringSkips?.[dateKey] || [];
  const adds = data.recurringAdds?.[dateKey] || [];
  const scheduled = data.recurring.filter((r) => {
    if (!r.active) return false;
    if (skips.includes(r.id)) return false;
    if (r.startDate && dateKey < r.startDate) return false;
    if (r.endDate && dateKey > r.endDate) return false;
    if (r.type === "monthly") {
      if (r.monthlyMode === "nthWeekday") {
        const target = getNthWeekdayOfMonth(y, m, r.nthWeek, r.nthDayOfWeek);
        return target !== null && dom === target;
      }
      if (r.dayValue === -1) {
        const lastDay = new Date(y, m + 1, 0).getDate();
        return dom === lastDay;
      }
      return dom === r.dayValue;
    }
    if (r.type === "weekly") {
      if (dow !== r.dayValue) return false;
      const interval = r.interval || 1;
      if (interval === 1) return true;
      const wDiff = weeksBetween(r.startDate || todayKey(), date);
      return wDiff >= 0 && wDiff % interval === 0;
    }
    return false;
  });
  const scheduledIds = new Set(scheduled.map((r) => r.id));
  const added = data.recurring.filter((r) => r.active && adds.includes(r.id) && !scheduledIds.has(r.id));
  return [...scheduled, ...added];
};

/**
 * 정규화된 태스크 아이템에 원본 데이터를 결합(Hydrate)합니다.
 */
export const hydrateTask = (data, item) => {
  if (!item) return null;

  // 1. 일정 이벤트 (Event)
  if (item.projectId === "event") {
    const event = (data.events || []).find((e) => e.id === item.taskId);
    return {
      ...item,
      projectName: "일정 이벤트",
      taskName: event?.name || item.taskName || "삭제된 이벤트",
      description: event?.description || item.description || "",
    };
  }

  // 2. 반복 태스크 (Recurring)
  if (item.projectId === "recurring") {
    const rec = (data.recurring || []).find((r) => r.id === item.taskId);
    let projectName = "반복 일정";
    if (rec) {
      projectName = rec.type === "weekly" ? "주간 반복" : "월간 반복";
      if (rec.time) projectName += ` (${rec.time})`;
    }
    return {
      ...item,
      projectName,
      taskName: rec?.name || item.taskName || "삭제된 반복 태스크",
      description: item.description || "",
    };
  }

  // 3. 일반 프로젝트 서브태스크
  const project = (data.projects || []).find((p) => p.id === item.projectId && !p.deleted);
  const task = project ? findTaskById(project.subtasks, item.taskId) : null;

  return {
    ...item,
    projectName: project?.name || item.projectName || (project?.deleted ? "(삭제된 프로젝트)" : "알 수 없는 프로젝트"),
    taskName: task?.name || item.taskName || "알 수 없는 태스크",
    description: task?.description || item.description || "",
  };
};

/**
 * 오늘 할일 데이터를 events + scheduled + recurring + completedToday에서 파생 계산합니다.
 * today_tasks 테이블 없이 메인 캘린더 데이터로부터 직접 도출합니다.
 */
export const deriveTodayTasks = (data) => {
  if (!data) return [];
  const key = todayKey();
  const completedIds = new Set((data.completedToday?.[key] || []).map((c) => c.taskId));
  const completedMap = new Map((data.completedToday?.[key] || []).map((c) => [c.taskId, c]));
  const seen = new Set();
  const items = [];

  // 1. 독립 이벤트 (당일)
  for (const ev of (data.events || [])) {
    if (ev.date === key && !ev.deleted && !seen.has(ev.id)) {
      seen.add(ev.id);
      const comp = completedMap.get(ev.id);
      items.push({
        projectId: "event", taskId: ev.id, time: ev.time || "",
        completed: !!comp, completedAt: comp?.completedAt || "",
      });
    }
  }

  // 2. 예약된 업무 (당일)
  for (const s of (data.scheduled?.[key] || [])) {
    if (seen.has(s.taskId)) continue;
    // 프로젝트 서브태스크의 done 상태 확인
    if (s.projectId && s.projectId !== "recurring" && s.projectId !== "event") {
      const proj = (data.projects || []).find((p) => p.id === s.projectId && !p.deleted);
      if (proj) {
        const task = findTaskById(proj.subtasks || [], s.taskId);
        if (task?.done) continue;
      }
    }
    seen.add(s.taskId);
    const comp = completedMap.get(s.taskId);
    items.push({
      projectId: s.projectId, taskId: s.taskId, time: s.time || "",
      completed: !!comp, completedAt: comp?.completedAt || "",
    });
  }

  // 3. 정기 업무 (당일)
  const recurringItems = getRecurringItemsForDate(data, key);
  for (const r of recurringItems) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const comp = completedMap.get(r.id);
    items.push({
      projectId: "recurring", taskId: r.id, time: r.time || "",
      completed: !!comp, completedAt: comp?.completedAt || "",
    });
  }

  // 4. completedToday에만 있는 항목 (위 3개 소스에 없지만 당일 완료 처리된 항목)
  for (const c of (data.completedToday?.[key] || [])) {
    if (seen.has(c.taskId)) continue;
    seen.add(c.taskId);
    items.push({
      projectId: c.projectId, taskId: c.taskId, time: c.time || "",
      completed: true, completedAt: c.completedAt || "",
    });
  }

  return items.map((t) => hydrateTask(data, t));
};

/**
 * 특정 날짜의 예정된(Scheduled) 태스크들을 결합하여 반환합니다.
 * done === true인 태스크는 제외 (완료 처리 후 scheduled 잔류 방어)
 */
export const getHydratedScheduled = (data, dateKey) => {
  if (!data?.scheduled?.[dateKey]) return [];
  // 해당 날짜에 이미 완료된 taskId 수집 (중복 표시 방지)
  const completedIds = new Set(
    (data.completedToday?.[dateKey] || []).map((c) => c.taskId)
  );
  return data.scheduled[dateKey]
    .filter((s) => {
      // 이미 completedToday에 있으면 scheduled에서 제외
      if (completedIds.has(s.taskId)) return false;
      // 프로젝트 서브태스크의 done 상태 확인
      if (s.projectId && s.projectId !== "recurring" && s.projectId !== "event") {
        const project = (data.projects || []).find((p) => p.id === s.projectId && !p.deleted);
        if (project) {
          const task = findTaskById(project.subtasks || [], s.taskId);
          if (task?.done) return false;
        }
      }
      return true;
    })
    .map((s) => hydrateTask(data, s));
};

/**
 * 특정 날짜의 완료된(Completed) 태스크들을 결합하여 반환합니다.
 */
export const getHydratedCompleted = (data, dateKey) => {
  if (!data?.completedToday?.[dateKey]) return [];
  return data.completedToday[dateKey].map((c) => hydrateTask(data, c));
};

/**
 * 기존의 비정규화된 데이터를 정규화된 데이터로 마이그레이션합니다.
 */
export const migrateToNormalizedData = (data) => {
  if (!data) return data;

  const normalize = (item) => {
    if (!item) return item;
    const newItem = {
      projectId: item.projectId,
      taskId: item.taskId,
    };
    // 메타데이터만 유지
    if (item.completedAt) newItem.completedAt = item.completedAt;
    if (item.time) newItem.time = item.time;
    if (item.completed !== undefined) newItem.completed = item.completed;
    if (item.updatedAt) newItem.updatedAt = item.updatedAt;
    return newItem;
  };

  const newData = { ...data };

  // todayTasks가 남아있으면 제거 (마이그레이션 이후 불필요)
  delete newData.todayTasks;

  if (newData.scheduled) {
    const newScheduled = {};
    for (const key in newData.scheduled) {
      if (Array.isArray(newData.scheduled[key])) {
        newScheduled[key] = newData.scheduled[key].map(normalize);
      }
    }
    newData.scheduled = newScheduled;
  }

  if (newData.completedToday) {
    const newCompleted = {};
    for (const key in newData.completedToday) {
      if (Array.isArray(newData.completedToday[key])) {
        newCompleted[key] = newData.completedToday[key].map(normalize);
      }
    }
    newData.completedToday = newCompleted;
  }

  return newData;
};