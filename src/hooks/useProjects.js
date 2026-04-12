import { MAX_ACTIVE_PROJECTS } from "../constants";
import {
  generateId,
  findTaskById,
  findParentArray,
  removeTaskById,
  isDescendant,
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
    const proj = data.projects.find((x) => x.id === pid);
    const task = proj ? findTaskById(proj.subtasks || [], tid) : null;
    const isDone = task?.done;
    updateData((d) => {
      const p = d.projects.find((x) => x.id === pid);
      if (!p) return;
      const t = findTaskById(p.subtasks, tid);
      if (t) { t.time = time || ""; t.endTime = endTime || ""; t.updatedAt = Date.now(); }
    });
    // GCal에 시간 변경 반영 (완료 상태 유지)
    if (task) {
      const summary = isDone ? `(완료) ${task.name}` : task.name;
      gcal.update({ localId: tid, summary, time: time || "", endTime: endTime || "" });
    }
  };

  const deleteSubtask = (pid, tid) => {
    updateData((d) => {
      const p = d.projects.find((x) => x.id === pid);
      if (p) removeTaskById(p.subtasks, tid);
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

  // 태스크를 다른 태스크의 하위로 이동 (드래그 앤 드롭)
  const moveTaskUnder = (pid, draggedId, targetId) => {
    const proj = data.projects.find((x) => x.id === pid);
    if (!proj) return;
    // 순환 방지: 드래그한 태스크의 자손에 타겟이 있으면 불가
    if (isDescendant(draggedId, targetId, proj.subtasks)) return;

    // 이동되는 태스크는 하위 업무가 되므로 일정/오늘할일에서 제거
    updateData((d) => {
      const p = d.projects.find((x) => x.id === pid);
      if (!p) return;
      // 트리에서 태스크를 떼어냄 (children 포함 통째로)
      const dragged = findTaskById(p.subtasks, draggedId);
      if (!dragged) return;
      const clone = JSON.parse(JSON.stringify(dragged));
      removeTaskById(p.subtasks, draggedId);
      // 타겟의 children에 추가
      const target = findTaskById(p.subtasks, targetId);
      if (!target) return;
      if (!target.children) target.children = [];
      target.children.push(clone);
      target.updatedAt = Date.now();
      p.updatedAt = Date.now();
      // 이동된 태스크의 예약 일정 제거
      if (d.scheduled) {
        for (const key of Object.keys(d.scheduled)) {
          d.scheduled[key] = d.scheduled[key].filter((s) => s.taskId !== draggedId);
          if (d.scheduled[key].length === 0) delete d.scheduled[key];
        }
      }
      if (d.completedToday) {
        for (const key of Object.keys(d.completedToday)) {
          d.completedToday[key] = d.completedToday[key].filter((c) => c.taskId !== draggedId);
          if (d.completedToday[key].length === 0) delete d.completedToday[key];
        }
      }
    });
    // GCal 이벤트는 삭제하지 않음 — scheduled에서 제거되면 캘린더에서 안 보이고,
    // 매핑은 유지하여 나중에 다시 일정 등록 시 중복 생성 방지
    setExpanded((p) => ({ ...p, [targetId]: true }));
  };

  // 태스크를 타겟의 형제(위/아래)로 이동 (다른 레벨에서 꺼내기)
  const moveTaskBeside = (pid, draggedId, targetId, position) => {
    const proj = data.projects.find((x) => x.id === pid);
    if (!proj) return;
    if (isDescendant(draggedId, targetId, proj.subtasks)) return;

    updateData((d) => {
      const p = d.projects.find((x) => x.id === pid);
      if (!p) return;
      const dragged = findTaskById(p.subtasks, draggedId);
      if (!dragged) return;
      const clone = JSON.parse(JSON.stringify(dragged));
      removeTaskById(p.subtasks, draggedId);
      // 타겟이 속한 부모 배열 찾기
      const findParent = (arr, id, parent) => {
        for (const s of arr) {
          if (s.id === id) return { arr, parent };
          if (s.children) {
            const r = findParent(s.children, id, s);
            if (r) return r;
          }
        }
        return null;
      };
      const result = findParent(p.subtasks, targetId, null);
      if (!result) return;
      const targetArr = result.arr;
      const ti = targetArr.findIndex((s) => s.id === targetId);
      if (ti === -1) return;
      const insertAt = position === "below" ? ti + 1 : ti;
      targetArr.splice(insertAt, 0, clone);
      p.updatedAt = Date.now();
    });
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
    addSubtask, editSubtask, editSubtaskDesc, editSubtaskTime, deleteSubtask, reorderSubtasks, moveTaskUnder, moveTaskBeside,
  };
}
