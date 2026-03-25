import { MAX_ACTIVE_PROJECTS } from "../constants";
import {
  generateId,
  findTaskById,
  findParentArray,
  removeTaskById,
} from "../utils/helpers";

export function createProjectActions({ data, updateData, setModal, activeProject, setActiveProject, setExpanded, gcal }) {
  const activeProjects = data.projects.filter((p) => !p.archived && !p.deleted);
  const archivedProjects = data.projects.filter((p) => p.archived && !p.deleted);

  const addProject = (name, deadline, colorId) => {
    if (activeProjects.length >= MAX_ACTIVE_PROJECTS) {
      setModal({ type: "alert", message: "현재 진행중인 프로젝트가 너무 많습니다.\n프로젝트를 정리하고 다시 시도해주세요." });
      return;
    }
    updateData((d) => {
      d.projects.push({ id: generateId(), name, deadline: deadline || null, subtasks: [], archived: false, colorId: colorId || "blue", updatedAt: Date.now() });
    });
  };

  const editProject = (id, name, deadline, colorId) =>
    updateData((d) => {
      const p = d.projects.find((x) => x.id === id);
      if (p) { p.name = name; p.deadline = deadline || null; if (colorId) p.colorId = colorId; p.updatedAt = Date.now(); }
    });

  const deleteProject = (id) => {
    // 삭제 전에 프로젝트 소속 전체 taskId 수집
    const proj = data.projects.find((x) => x.id === id);
    const collectIds = (tasks) => {
      const ids = [];
      for (const t of tasks) {
        ids.push(t.id);
        if (t.children?.length) ids.push(...collectIds(t.children));
      }
      return ids;
    };
    const taskIds = proj ? collectIds(proj.subtasks || []) : [];

    updateData((d) => {
      const p = d.projects.find((x) => x.id === id);
      if (p) {
        p.deleted = true;
        p.updatedAt = Date.now();
      }
      d.todayTasks = d.todayTasks.filter((t) => t.projectId !== id);
      if (d.scheduled) {
        for (const key of Object.keys(d.scheduled)) {
          d.scheduled[key] = d.scheduled[key].filter((s) => s.projectId !== id);
          if (d.scheduled[key].length === 0) delete d.scheduled[key];
        }
      }
      if (d.completedToday) {
        for (const key of Object.keys(d.completedToday)) {
          d.completedToday[key] = d.completedToday[key].filter((c) => c.projectId !== id);
          if (d.completedToday[key].length === 0) delete d.completedToday[key];
        }
      }
    });
    if (taskIds.length > 0) gcal.delMultiple(taskIds);
    if (activeProject === id) setActiveProject(null);
  };

  const reorderProjects = (newActiveOrder) =>
    updateData((d) => {
      const archived = d.projects.filter((p) => p.archived);
      d.projects = [...newActiveOrder, ...archived];
    });

  const archiveProject = (id) => updateData((d) => { const p = d.projects.find((x) => x.id === id); if (p) { p.archived = true; p.updatedAt = Date.now(); } });

  const restoreProject = (id) => {
    if (activeProjects.length >= MAX_ACTIVE_PROJECTS) {
      setModal({ type: "alert", message: "현재 진행중인 프로젝트가 너무 많습니다.\n프로젝트를 정리하고 복구를 시도해주세요." });
      return;
    }
    updateData((d) => { const p = d.projects.find((x) => x.id === id); if (p) { p.archived = false; p.updatedAt = Date.now(); } });
  };

  // ── 서브태스크 CRUD ──
  const addSubtask = (pid, name, parentId, desc, time, endTime) => {
    const newId = generateId();
    updateData((d) => {
      const p = d.projects.find((x) => x.id === pid);
      if (!p) return;
      const arr = parentId ? findParentArray(p.subtasks, parentId) : p.subtasks;
      if (arr) arr.push({ id: newId, name, done: false, children: [], description: desc || "", time: time || "", endTime: endTime || "", updatedAt: Date.now() });
    });
    if (parentId) setExpanded((p) => ({ ...p, [parentId]: true }));
  };

  const editSubtask = (pid, tid, name) => {
    // 완료 상태 확인 (GCal 제목에 "(완료)" 접두사 유지용)
    const proj = data.projects.find((x) => x.id === pid);
    const task = proj ? findTaskById(proj.subtasks || [], tid) : null;
    const isDone = task?.done;

    updateData((d) => {
      const p = d.projects.find((x) => x.id === pid);
      if (!p) return;
      const t = findTaskById(p.subtasks, tid);
      if (t) { t.name = name; t.updatedAt = Date.now(); }
    });
    gcal.update({ localId: tid, summary: isDone ? `(완료) ${name}` : name });
  };

  const editSubtaskDesc = (pid, tid, desc) => {
    updateData((d) => {
      const p = d.projects.find((x) => x.id === pid);
      if (!p) return;
      const t = findTaskById(p.subtasks, tid);
      if (t) { t.description = desc; t.updatedAt = Date.now(); }
    });
    gcal.update({ localId: tid, description: desc });
  };

  const editSubtaskTime = (pid, tid, time, endTime) => {
    updateData((d) => {
      const p = d.projects.find((x) => x.id === pid);
      if (!p) return;
      const t = findTaskById(p.subtasks, tid);
      if (t) { t.time = time || ""; t.endTime = endTime || ""; t.updatedAt = Date.now(); }
    });
  };

  const deleteSubtask = (pid, tid) => {
    updateData((d) => {
      const p = d.projects.find((x) => x.id === pid);
      if (p) removeTaskById(p.subtasks, tid);
      d.todayTasks = d.todayTasks.filter((t) => t.taskId !== tid);
      if (d.scheduled) {
        for (const key of Object.keys(d.scheduled)) {
          d.scheduled[key] = d.scheduled[key].filter((s) => s.taskId !== tid);
          if (d.scheduled[key].length === 0) delete d.scheduled[key];
        }
      }
      if (d.completedToday) {
        for (const key of Object.keys(d.completedToday)) {
          d.completedToday[key] = d.completedToday[key].filter((c) => c.taskId !== tid);
          if (d.completedToday[key].length === 0) delete d.completedToday[key];
        }
      }
    });
    gcal.del(tid);
  };

  const reorderSubtasks = (pid, parentId, arr) =>
    updateData((d) => {
      const p = d.projects.find((x) => x.id === pid);
      if (!p) return;
      p.updatedAt = Date.now();
      if (!parentId) p.subtasks = arr;
      else {
        const parent = findTaskById(p.subtasks, parentId);
        if (parent) { parent.children = arr; parent.updatedAt = Date.now(); }
      }
    });

  return {
    activeProjects, archivedProjects,
    addProject, editProject, deleteProject, archiveProject, restoreProject, reorderProjects,
    addSubtask, editSubtask, editSubtaskDesc, editSubtaskTime, deleteSubtask, reorderSubtasks,
  };
}
