import { findTaskById } from "./helpers";

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
 * Today 탭의 태스크들을 원본 데이터와 결합하여 반환합니다.
 */
export const getHydratedTodayTasks = (data) => {
  if (!data?.todayTasks) return [];
  return data.todayTasks.map((t) => hydrateTask(data, t));
};

/**
 * 특정 날짜의 예정된(Scheduled) 태스크들을 결합하여 반환합니다.
 */
export const getHydratedScheduled = (data, dateKey) => {
  if (!data?.scheduled?.[dateKey]) return [];
  return data.scheduled[dateKey].map((s) => hydrateTask(data, s));
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
  
  if (newData.todayTasks) {
    newData.todayTasks = newData.todayTasks.map(normalize);
  }

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