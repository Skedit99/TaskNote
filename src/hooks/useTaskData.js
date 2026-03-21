import { useState, useEffect, useCallback, useRef } from "react";
import {
  STORAGE_KEY,
  THEME_KEY,
  MINI_SETTINGS_KEY,
  CAL_RANGE_KEY,
  WINDOW_MODE_KEY,
  MAX_ACTIVE_PROJECTS,
  defaultData,
  defaultMiniSettings,
  isElectron,
} from "../constants";
import { THEMES } from "../constants/theme";
import { getProjectColor } from "../constants/theme";
import {
  generateId,
  todayKey,
  findTaskById,
  findParentArray,
  removeTaskById,
  weeksBetween,
} from "../utils/helpers";

// ── Google Calendar 동기화 헬퍼 (fire-and-forget) ──
const gcal = {
  create: (payload) => {
    if (!isElectron) return;
    window.electronAPI.gcalSyncCreate(payload).catch((e) => console.warn("[gcal] create:", e));
  },
  update: (payload) => {
    if (!isElectron) return;
    window.electronAPI.gcalSyncUpdate(payload).catch((e) => console.warn("[gcal] update:", e));
  },
  del: (localId) => {
    if (!isElectron) return;
    window.electronAPI.gcalSyncDelete({ localId }).catch((e) => console.warn("[gcal] delete:", e));
  },
  delMultiple: (localIds) => {
    if (!isElectron) return;
    window.electronAPI.gcalSyncDeleteMultiple({ localIds }).catch((e) => console.warn("[gcal] delMultiple:", e));
  },
  flushQueue: () => {
    if (!isElectron) return;
    window.electronAPI.gcalSyncFlushQueue().catch((e) => console.warn("[gcal] flush:", e));
  },
  // 기존 데이터 일괄 동기화 (매핑 없는 항목만 push)
  syncExisting: (appData) => {
    if (!isElectron) return;
    // 독립 일정
    for (const ev of (appData.events || [])) {
      gcal.create({ localId: ev.id, summary: ev.name, description: ev.description || "", date: ev.date, time: ev.time || "", type: "event" });
    }
    // 예약된 업무
    for (const [dateKey, items] of Object.entries(appData.scheduled || {})) {
      for (const s of items) {
        gcal.create({ localId: s.taskId, summary: s.taskName, description: s.description || "", date: dateKey, time: s.time || "", type: "scheduled" });
      }
    }
  },
};

export default function useTaskData() {
  const [data, setData] = useState(defaultData);
  const [loaded, setLoaded] = useState(false);
  const [themeKey, setThemeKey] = useState("light");
  const [sideTab, setSideTab] = useState(null);
  const [activeProject, setActiveProject] = useState(null);
  const [modal, setModal] = useState(null);
  const [editingTask, setEditingTask] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [expandedDesc, setExpandedDesc] = useState({});
  const [expandedToday, setExpandedToday] = useState({});
  const [calYear, setCalYear] = useState(new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [selectedDay, setSelectedDay] = useState(null);

  // 위젯 모드 관련
  const [miniMode, setMiniMode] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [isHovered, setIsHovered] = useState(true);
  const [calPanelHeight, setCalPanelHeight] = useState(320);
  const hoverTimer = useRef(null);

  // 모드별 독립 설정 (투명도)
  const [miniSettings, setMiniSettings] = useState(defaultMiniSettings);
  const currentMiniKey = miniMode || "today";
  const bgOpacity = miniSettings[currentMiniKey]?.bgOpacity ?? 1;
  const cardOpacity = miniSettings[currentMiniKey]?.cardOpacity ?? 1;

  // 캘린더 날짜 범위 설정 (0=당일만, 1~7, 14, 30)
  const [calendarRange, setCalendarRange] = useState(0);
  const [windowMode, setWindowMode] = useState("normal");
  const [agreedTerms, setAgreedTerms] = useState(false);

  const T = THEMES[themeKey] || THEMES.light;

  // ── 저장 디바운스 타이머 ──
  const saveDataTimer = useRef(null);
  const saveSettingsTimer = useRef(null);

  // ── 초기 로드 (IPC 파일 시스템 우선, localStorage 폴백 + 마이그레이션) ──
  useEffect(() => {
    const loadAll = async () => {
      if (isElectron) {
        // 파일에서 앱 데이터 로드
        const fileData = await window.electronAPI.loadAppData();
        if (fileData) {
          setData({ ...defaultData, ...fileData });
        } else {
          // 파일 없음 → localStorage에서 마이그레이션
          try {
            const val = localStorage.getItem(STORAGE_KEY);
            if (val) {
              const migrated = { ...defaultData, ...JSON.parse(val) };
              setData(migrated);
              await window.electronAPI.saveAppData(migrated);
              localStorage.removeItem(STORAGE_KEY);
              console.log("[Data] localStorage → 파일 마이그레이션 완료");
            }
          } catch (e) {}
        }

        // 파일에서 설정 로드
        const fileSettings = await window.electronAPI.loadSettings();
        if (fileSettings) {
          if (fileSettings.themeKey && THEMES[fileSettings.themeKey]) setThemeKey(fileSettings.themeKey);
          if (fileSettings.miniSettings) setMiniSettings((prev) => ({ ...prev, ...fileSettings.miniSettings }));
          if (fileSettings.calendarRange !== undefined) setCalendarRange(Number(fileSettings.calendarRange));
          if (fileSettings.windowMode) setWindowMode(fileSettings.windowMode);
          if (fileSettings.agreedTerms) setAgreedTerms(true);
        } else {
          // 파일 없음 → localStorage에서 마이그레이션
          try {
            const t = localStorage.getItem(THEME_KEY);
            if (t && THEMES[t]) setThemeKey(t);
            else if (t === "dark") setThemeKey("dark");
            const ms = localStorage.getItem(MINI_SETTINGS_KEY);
            if (ms) setMiniSettings((prev) => ({ ...prev, ...JSON.parse(ms) }));
            const r = localStorage.getItem(CAL_RANGE_KEY);
            if (r !== null) setCalendarRange(Number(r));
            const wm = localStorage.getItem(WINDOW_MODE_KEY);
            if (wm) setWindowMode(wm);
            // 마이그레이션 저장
            await window.electronAPI.saveSettings({
              themeKey: t && THEMES[t] ? t : "light",
              miniSettings: ms ? JSON.parse(ms) : defaultMiniSettings,
              calendarRange: r !== null ? Number(r) : 0,
              windowMode: wm || "normal",
            });
            localStorage.removeItem(THEME_KEY);
            localStorage.removeItem(MINI_SETTINGS_KEY);
            localStorage.removeItem(CAL_RANGE_KEY);
            localStorage.removeItem(WINDOW_MODE_KEY);
            console.log("[Settings] localStorage → 파일 마이그레이션 완료");
          } catch (e) {}
        }
      } else {
        // 웹 모드: localStorage 사용 (기존 방식)
        try {
          const val = localStorage.getItem(STORAGE_KEY);
          if (val) setData({ ...defaultData, ...JSON.parse(val) });
        } catch (e) {}
        try {
          const t = localStorage.getItem(THEME_KEY);
          if (t && THEMES[t]) setThemeKey(t);
          else if (t === "dark") setThemeKey("dark");
        } catch (e) {}
        try {
          const ms = localStorage.getItem(MINI_SETTINGS_KEY);
          if (ms) setMiniSettings((prev) => ({ ...prev, ...JSON.parse(ms) }));
        } catch (e) {}
        try {
          const r = localStorage.getItem(CAL_RANGE_KEY);
          if (r !== null) setCalendarRange(Number(r));
        } catch (e) {}
        try {
          const wm = localStorage.getItem(WINDOW_MODE_KEY);
          if (wm) setWindowMode(wm);
        } catch (e) {}
      }
      setLoaded(true);
    };
    loadAll();
  }, []);

  // ── 앱 데이터 저장 (디바운스 300ms) ──
  useEffect(() => {
    if (!loaded) return;
    if (saveDataTimer.current) clearTimeout(saveDataTimer.current);
    saveDataTimer.current = setTimeout(() => {
      if (isElectron) {
        window.electronAPI.saveAppData(data).catch((e) => console.error("[Data] 저장 실패:", e));
      } else {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
      }
    }, 300);
    return () => clearTimeout(saveDataTimer.current);
  }, [data, loaded]);

  // ── 설정 저장 (디바운스 300ms) ──
  useEffect(() => {
    if (!loaded) return;
    if (saveSettingsTimer.current) clearTimeout(saveSettingsTimer.current);
    saveSettingsTimer.current = setTimeout(() => {
      const settings = { themeKey, miniSettings, calendarRange, windowMode, agreedTerms };
      if (isElectron) {
        window.electronAPI.saveSettings(settings).catch((e) => console.error("[Settings] 저장 실패:", e));
      } else {
        try {
          localStorage.setItem(THEME_KEY, themeKey);
          localStorage.setItem(MINI_SETTINGS_KEY, JSON.stringify(miniSettings));
          localStorage.setItem(CAL_RANGE_KEY, String(calendarRange));
          localStorage.setItem(WINDOW_MODE_KEY, windowMode);
        } catch (e) {}
      }
    }, 300);
    return () => clearTimeout(saveSettingsTimer.current);
  }, [themeKey, miniSettings, calendarRange, windowMode, agreedTerms, loaded]);

  const updateData = useCallback((fn) => {
    setData((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      fn(next);
      return next;
    });
  }, []);

  // 앱 시작 시 오프라인 큐 플러시 + 기존 데이터 동기화 + 포커스 시 재시도
  useEffect(() => {
    if (!loaded) return;
    gcal.flushQueue();
    gcal.syncExisting(data);
    const onFocus = () => gcal.flushQueue();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // 앱 시작 시 오늘 날짜 동기화
  useEffect(() => {
    if (!loaded) return;
    const key = todayKey();
    updateData((d) => {
      if (!d.events) d.events = [];
      if (!d.scheduled) d.scheduled = {};
      const todayEvents = d.events.filter((e) => e.date === key);
      for (const ev of todayEvents) {
        if (!d.todayTasks.some((t) => t.taskId === ev.id)) {
          d.todayTasks.push({ projectId: "event", taskId: ev.id, projectName: "독립 일정", taskName: ev.name, description: ev.description || "", completed: false });
        }
      }
      const todayScheduled = d.scheduled[key] || [];
      for (const s of todayScheduled) {
        if (!d.todayTasks.some((t) => t.taskId === s.taskId)) {
          d.todayTasks.push({ ...s, completed: false });
        }
      }
    });
  }, [loaded]);

  // ── 프로젝트 CRUD ──
  const activeProjects = data.projects.filter((p) => !p.archived);
  const archivedProjects = data.projects.filter((p) => p.archived);
  const getProjectById = (pid) => data.projects.find((p) => p.id === pid);
  const isDark = themeKey === "dark";
  const getColorForProjectId = (pid) => getProjectColor(getProjectById(pid), isDark);

  const addProject = (name, deadline, colorId) => {
    if (activeProjects.length >= MAX_ACTIVE_PROJECTS) {
      setModal({ type: "alert", message: "현재 진행중인 프로젝트가 너무 많습니다.\n프로젝트를 정리하고 다시 시도해주세요." });
      return;
    }
    updateData((d) => {
      d.projects.push({ id: generateId(), name, deadline: deadline || null, subtasks: [], archived: false, colorId: colorId || "blue" });
    });
  };
  const editProject = (id, name, deadline, colorId) =>
    updateData((d) => {
      const p = d.projects.find((x) => x.id === id);
      if (p) { p.name = name; p.deadline = deadline || null; if (colorId) p.colorId = colorId; }
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
      d.projects = d.projects.filter((x) => x.id !== id);
      d.todayTasks = d.todayTasks.filter((t) => t.projectId !== id);
      if (d.scheduled) {
        for (const key of Object.keys(d.scheduled)) {
          d.scheduled[key] = d.scheduled[key].filter((s) => s.projectId !== id);
          if (d.scheduled[key].length === 0) delete d.scheduled[key];
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
  const archiveProject = (id) => updateData((d) => { const p = d.projects.find((x) => x.id === id); if (p) p.archived = true; });
  const restoreProject = (id) => {
    if (activeProjects.length >= MAX_ACTIVE_PROJECTS) {
      setModal({ type: "alert", message: "현재 진행중인 프로젝트가 너무 많습니다.\n프로젝트를 정리하고 복구를 시도해주세요." });
      return;
    }
    updateData((d) => { const p = d.projects.find((x) => x.id === id); if (p) p.archived = false; });
  };

  // ── 서브태스크 CRUD ──
  const addSubtask = (pid, name, parentId, desc) => {
    const newId = generateId();
    updateData((d) => {
      const p = d.projects.find((x) => x.id === pid);
      if (!p) return;
      const arr = parentId ? findParentArray(p.subtasks, parentId) : p.subtasks;
      if (arr) arr.push({ id: newId, name, done: false, children: [], description: desc || "" });
    });
    if (parentId) setExpanded((p) => ({ ...p, [parentId]: true }));
  };
  const editSubtask = (pid, tid, name) => {
    updateData((d) => {
      const p = d.projects.find((x) => x.id === pid);
      if (!p) return;
      const t = findTaskById(p.subtasks, tid);
      if (t) t.name = name;
      const tt = d.todayTasks.find((x) => x.taskId === tid);
      if (tt) tt.taskName = name;
      if (d.scheduled) { for (const arr of Object.values(d.scheduled)) { const s = arr.find((x) => x.taskId === tid); if (s) s.taskName = name; } }
      if (d.completedToday) { for (const arr of Object.values(d.completedToday)) { const c = arr.find((x) => x.taskId === tid); if (c) c.taskName = name; } }
    });
    gcal.update({ localId: tid, summary: name });
  };
  const editSubtaskDesc = (pid, tid, desc) => {
    updateData((d) => {
      const p = d.projects.find((x) => x.id === pid);
      if (!p) return;
      const t = findTaskById(p.subtasks, tid);
      if (t) t.description = desc;
      const tt = d.todayTasks.find((x) => x.taskId === tid);
      if (tt) tt.description = desc;
    });
    gcal.update({ localId: tid, description: desc });
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
      if (!parentId) p.subtasks = arr;
      else {
        const parent = findTaskById(p.subtasks, parentId);
        if (parent) parent.children = arr;
      }
    });

  // ── 오늘 할 일 ──
  const addToToday = (pid, tid) => {
    if (data.todayTasks.some((t) => t.taskId === tid)) return;
    const proj = data.projects.find((p) => p.id === pid);
    const task = findTaskById(proj?.subtasks || [], tid);
    if (!task || task.done) return;
    updateData((d) => {
      d.todayTasks.push({ projectId: pid, taskId: tid, projectName: proj.name, taskName: task.name, description: task.description || "", completed: false });
    });
  };
  const toggleTodayTask = (tid) => {
    updateData((d) => {
      const t = d.todayTasks.find((x) => x.taskId === tid);
      if (!t) return;
      t.completed = !t.completed;
      const key = todayKey();
      if (t.completed) {
        t.completedAt = new Date().toISOString();
        if (!d.completedToday[key]) d.completedToday[key] = [];
        if (!d.completedToday[key].some((c) => c.taskId === tid))
          d.completedToday[key].push({ ...t, completedAt: t.completedAt });
        const p = d.projects.find((x) => x.id === t.projectId);
        if (p) { const st = findTaskById(p.subtasks, tid); if (st) st.done = true; }
      } else {
        delete t.completedAt;
        if (d.completedToday[key]) d.completedToday[key] = d.completedToday[key].filter((c) => c.taskId !== tid);
        const p = d.projects.find((x) => x.id === t.projectId);
        if (p) { const st = findTaskById(p.subtasks, tid); if (st) st.done = false; }
      }
    });
  };
  const updateCompletedAt = (tid, newTime) => {
    updateData((d) => {
      const t = d.todayTasks.find((x) => x.taskId === tid);
      if (t && t.completed) t.completedAt = newTime;
      const key = todayKey();
      const c = d.completedToday[key]?.find((x) => x.taskId === tid);
      if (c) c.completedAt = newTime;
    });
  };
  const removeFromToday = (tid) => updateData((d) => { d.todayTasks = d.todayTasks.filter((t) => t.taskId !== tid); });

  // ── 날짜별 완료/미완료 ──
  const completeForDate = (dateKey, item) => {
    updateData((d) => {
      if (!d.completedToday[dateKey]) d.completedToday[dateKey] = [];
      if (d.completedToday[dateKey].some((c) => c.taskId === item.taskId)) return;
      d.completedToday[dateKey].push({ ...item, completed: true, completedAt: new Date().toISOString() });
      if (item.projectId && item.projectId !== "recurring" && item.projectId !== "event") {
        const p = d.projects.find((x) => x.id === item.projectId);
        if (p) { const st = findTaskById(p.subtasks, item.taskId); if (st) st.done = true; }
      }
      const tt = d.todayTasks.find((x) => x.taskId === item.taskId);
      if (tt) tt.completed = true;
      if (d.scheduled?.[dateKey]) {
        d.scheduled[dateKey] = d.scheduled[dateKey].filter((s) => s.taskId !== item.taskId);
        if (d.scheduled[dateKey].length === 0) delete d.scheduled[dateKey];
      }
    });
  };
  const uncompleteForDate = (dateKey, taskId) => {
    updateData((d) => {
      const comp = d.completedToday[dateKey]?.find((c) => c.taskId === taskId);
      if (d.completedToday[dateKey]) {
        d.completedToday[dateKey] = d.completedToday[dateKey].filter((c) => c.taskId !== taskId);
        if (d.completedToday[dateKey].length === 0) delete d.completedToday[dateKey];
      }
      for (const p of d.projects) {
        const st = findTaskById(p.subtasks, taskId);
        if (st) { st.done = false; break; }
      }
      const tt = d.todayTasks.find((x) => x.taskId === taskId);
      if (tt) tt.completed = false;
      if (comp && comp.projectId && comp.projectId !== "recurring" && comp.projectId !== "event") {
        if (!d.scheduled) d.scheduled = {};
        if (!d.scheduled[dateKey]) d.scheduled[dateKey] = [];
        if (!d.scheduled[dateKey].some((s) => s.taskId === taskId)) {
          d.scheduled[dateKey].push({ projectId: comp.projectId, taskId: comp.taskId, projectName: comp.projectName, taskName: comp.taskName, description: comp.description || "" });
        }
      }
    });
  };
  const isCompletedForDate = (dateKey, taskId) => {
    return (data.completedToday[dateKey] || []).some((c) => c.taskId === taskId);
  };

  // ── 예약 ──
  const addToScheduled = (pid, tid, dateKey) => {
    const proj = data.projects.find((p) => p.id === pid);
    const task = findTaskById(proj?.subtasks || [], tid);
    if (!task || task.done) return;
    updateData((d) => {
      if (!d.scheduled) d.scheduled = {};
      if (!d.scheduled[dateKey]) d.scheduled[dateKey] = [];
      if (d.scheduled[dateKey].some((s) => s.taskId === tid)) return;
      d.scheduled[dateKey].push({ projectId: pid, taskId: tid, projectName: proj.name, taskName: task.name, description: task.description || "" });
    });
    gcal.create({ localId: tid, summary: task.name, description: task.description || "", date: dateKey, type: "scheduled" });
  };
  const deleteScheduled = (dateKey, idxOrTaskId) => {
    // 삭제 전에 taskId 확보 (index인 경우)
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
      d.todayTasks.push({ ...item, completed: false });
      if (d.scheduled?.[dateKey]) {
        d.scheduled[dateKey] = d.scheduled[dateKey].filter((s) => s.taskId !== item.taskId);
        if (d.scheduled[dateKey].length === 0) delete d.scheduled[dateKey];
      }
    });
  };
  const getScheduledForDay = (day, year, month) => {
    if (!day) return [];
    const y = year !== undefined ? year : calYear;
    const m = month !== undefined ? month : calMonth;
    const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return data.scheduled?.[key] || [];
  };

  // ── 독립 이벤트 ──
  const addEvent = (name, desc, dateKey, time) => {
    const evId = generateId();
    updateData((d) => {
      if (!d.events) d.events = [];
      d.events.push({ id: evId, name, description: desc || "", date: dateKey, time: time || "" });
      if (dateKey === todayKey()) {
        d.todayTasks.push({ projectId: "event", taskId: evId, projectName: "독립 일정", taskName: name, description: desc || "", completed: false, time: time || "" });
      }
    });
    gcal.create({ localId: evId, summary: name, description: desc || "", date: dateKey, time: time || "", type: "event" });
  };
  const deleteEvent = (id) => {
    updateData((d) => {
      if (d.events) d.events = d.events.filter((e) => e.id !== id);
      d.todayTasks = d.todayTasks.filter((t) => t.taskId !== id);
    });
    gcal.del(id);
  };
  const getEventsForDay = (day, year, month) => {
    if (!day) return [];
    const y = year !== undefined ? year : calYear;
    const m = month !== undefined ? month : calMonth;
    const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return (data.events || []).filter((e) => e.date === key);
  };

  const handleCalendarDoubleClick = (day) => {
    if (!day) return;
    const dateKey = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    setModal({ type: "addCalendarEvent", dateKey, dateLabel: `${calYear}.${String(calMonth + 1).padStart(2, "0")}.${String(day).padStart(2, "0")}` });
  };

  const addEventAsSubtask = (projectId, name, desc, dateKey, time) => {
    const newId = generateId();
    updateData((d) => {
      const p = d.projects.find((x) => x.id === projectId);
      if (!p) return;
      p.subtasks.push({ id: newId, name, done: false, children: [], description: desc || "" });
      if (!d.scheduled) d.scheduled = {};
      if (!d.scheduled[dateKey]) d.scheduled[dateKey] = [];
      d.scheduled[dateKey].push({ projectId, taskId: newId, projectName: p.name, taskName: name, description: desc || "", time: time || "" });
      if (dateKey === todayKey()) {
        d.todayTasks.push({ projectId, taskId: newId, projectName: p.name, taskName: name, description: desc || "", completed: false, time: time || "" });
      }
    });
    gcal.create({ localId: newId, summary: name, description: desc || "", date: dateKey, time: time || "", type: "scheduled" });
  };

  // ── 정기 업무 ──
  const addRecurring = (name, type, dayValue, time, interval, startDate) => {
    const recId = generateId();
    updateData((d) => {
      d.recurring.push({ id: recId, name, type, dayValue, time: time || "", interval: interval || 1, startDate: startDate || todayKey(), active: true });
    });
  };
  const editRecurring = (id, name, dayValue, time, interval, startDate) => {
    updateData((d) => {
      const r = d.recurring.find((x) => x.id === id);
      if (r) { r.name = name; r.dayValue = dayValue; r.time = time || ""; r.interval = interval || 1; r.startDate = startDate || r.startDate || todayKey(); }
    });
    // 오늘 날짜의 매핑이 있으면 업데이트
    const compositeId = `recurring:${id}:${todayKey()}`;
    gcal.update({ localId: compositeId, summary: name, time: time || "" });
  };
  const deleteRecurring = (id) => {
    updateData((d) => { d.recurring = d.recurring.filter((r) => r.id !== id); });
    // 오늘 날짜의 반복 이벤트 삭제
    const compositeId = `recurring:${id}:${todayKey()}`;
    gcal.del(compositeId);
  };
  const toggleRecurring = (id) => updateData((d) => { const r = d.recurring.find((x) => x.id === id); if (r) r.active = !r.active; });
  const addRecurringToToday = (rec) => {
    if (!rec.active) return;
    if (data.todayTasks.some((t) => t.taskId === rec.id)) return;
    updateData((d) => {
      d.todayTasks.push({ projectId: "recurring", taskId: rec.id, projectName: rec.type === "weekly" ? `주간${rec.time ? " · " + rec.time : ""}` : `월간${rec.time ? " · " + rec.time : ""}`, taskName: rec.name, description: "", completed: false });
    });
    // 반복 일정은 오늘 날짜로 개별 이벤트 생성 (복합키: recurring:id:date)
    const dateKey = todayKey();
    const compositeId = `recurring:${rec.id}:${dateKey}`;
    gcal.create({ localId: compositeId, summary: rec.name, description: "", date: dateKey, time: rec.time || "", type: "recurring" });
  };

  // ── 캘린더 헬퍼 ──
  const getCompForDay = (day, year, month) => {
    if (!day) return [];
    const y = year !== undefined ? year : calYear;
    const m = month !== undefined ? month : calMonth;
    const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return data.completedToday[key] || [];
  };
  const deleteCompleted = (day, idx) => {
    const key = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    updateData((d) => {
      if (d.completedToday[key]) {
        d.completedToday[key].splice(idx, 1);
        if (d.completedToday[key].length === 0) delete d.completedToday[key];
      }
    });
  };
  const calDays = () => {
    const f = new Date(calYear, calMonth, 1);
    const ld = new Date(calYear, calMonth + 1, 0).getDate();
    const sd = f.getDay();
    const c = [];
    for (let i = 0; i < sd; i++) c.push(null);
    for (let d = 1; d <= ld; d++) c.push(d);
    return c;
  };
  const prevMonth = () => {
    if (calMonth === 0) { setCalYear(calYear - 1); setCalMonth(11); }
    else setCalMonth(calMonth - 1);
    setSelectedDay(null);
  };
  const nextMonth = () => {
    if (calMonth === 11) { setCalYear(calYear + 1); setCalMonth(0); }
    else setCalMonth(calMonth + 1);
    setSelectedDay(null);
  };
  const td = new Date();
  const isTodayDate = (day) => day && calYear === td.getFullYear() && calMonth === td.getMonth() && day === td.getDate();

  const getRecurringForDay = (day, year, month) => {
    if (!day) return [];
    const y = year !== undefined ? year : calYear;
    const m = month !== undefined ? month : calMonth;
    const date = new Date(y, m, day);
    const dow = date.getDay(), dom = date.getDate();
    return data.recurring.filter((r) => {
      if (!r.active) return false;
      if (r.type === "monthly") return dom === r.dayValue;
      if (r.type === "weekly") {
        if (dow !== r.dayValue) return false;
        const interval = r.interval || 1;
        if (interval === 1) return true;
        const wDiff = weeksBetween(r.startDate || todayKey(), date);
        return wDiff >= 0 && wDiff % interval === 0;
      }
      return false;
    });
  };
  const getTodayTasksForDay = (day, year, month) => {
    if (!day) return [];
    const y = year !== undefined ? year : calYear;
    const m = month !== undefined ? month : calMonth;
    const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (key !== todayKey()) return [];
    return data.todayTasks.filter((t) => !t.completed);
  };

  // ── Electron 연동 ──
  const miniBoundsRef = useRef({ today: null, calendar: null });

  const handleMiniMode = async (type) => {
    if (miniMode && isElectron) {
      try {
        const b = await window.electronAPI.getBounds();
        miniBoundsRef.current[miniMode] = b;
      } catch (e) {}
    }
    setMiniMode(type);
    if (isElectron) {
      await window.electronAPI.setMiniMode(type);
      if (type) {
        if (windowMode === "alwaysOnTop") await window.electronAPI.setAlwaysOnTop(true);
        else if (windowMode === "widget") await window.electronAPI.setWindowLevel("widget");
        else await window.electronAPI.setAlwaysOnTop(false);
      } else {
        await window.electronAPI.setAlwaysOnTop(false);
        if (windowMode === "widget") await window.electronAPI.setWindowLevel("normal");
      }
      if (type && miniBoundsRef.current[type]) {
        try { await window.electronAPI.setBounds(miniBoundsRef.current[type]); } catch (e) {}
      }
    }
    if (type) { setSideTab(null); setActiveProject(null); }
    setIsHovered(true);
  };
  const handleWindowMode = async (mode) => {
    setWindowMode(mode);
    if (isElectron && miniMode) {
      if (mode === "alwaysOnTop") {
        await window.electronAPI.setWindowLevel("normal");
        await window.electronAPI.setAlwaysOnTop(true);
      } else if (mode === "widget") {
        await window.electronAPI.setAlwaysOnTop(false);
        await window.electronAPI.setWindowLevel("widget");
      } else {
        await window.electronAPI.setAlwaysOnTop(false);
        await window.electronAPI.setWindowLevel("normal");
      }
    }
  };
  const handleBgOpacity = (v) => {
    const val = parseFloat(v);
    setMiniSettings((prev) => ({ ...prev, [currentMiniKey]: { ...prev[currentMiniKey], bgOpacity: val } }));
  };
  const handleCardOpacity = (v) => {
    const val = parseFloat(v);
    setMiniSettings((prev) => ({ ...prev, [currentMiniKey]: { ...prev[currentMiniKey], cardOpacity: val } }));
  };
  const handleLock = async () => {
    const next = !isLocked;
    setIsLocked(next);
    if (isElectron) await window.electronAPI.setLocked(next);
    if (!next) setIsHovered(true);
  };
  const handleMinimize = () => { if (isElectron) window.electronAPI.minimize(); };
  const handleMaximize = () => { if (isElectron) window.electronAPI.maximize(); };
  const handleClose = () => { if (isElectron) window.electronAPI.close(); };

  const onMouseEnter = () => { clearTimeout(hoverTimer.current); setIsHovered(true); };
  const onMouseLeave = () => { if (isLocked && miniMode) { hoverTimer.current = setTimeout(() => setIsHovered(false), 600); } };

  // ── 파생 상태 ──
  const pendingToday = data.todayTasks.filter((t) => !t.completed);
  const doneToday = data.todayTasks.filter((t) => t.completed).sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));
  const sideOpen = sideTab !== null;
  const selectedDateKey = selectedDay ? `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(selectedDay).padStart(2, "0")}` : null;
  const isSelectedToday = selectedDateKey === todayKey();
  const hasNonTodaySelection = selectedDay !== null && !isSelectedToday;
  const selectedDateLabel = selectedDay ? `${calMonth + 1}/${selectedDay}` : "";
  const depthColors = [T.primary, "#818cf8", "#a78bfa", "#c4b5fd"];

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
      if (tt) tt.time = time;
      if (d.scheduled) { for (const items of Object.values(d.scheduled)) { const s = items.find((x) => x.taskId === taskId); if (s) s.time = time; } }
      if (d.completedToday) { for (const items of Object.values(d.completedToday)) { const c = items.find((x) => x.taskId === taskId); if (c) c.time = time; } }
    });
    gcal.update({ localId: taskId, time });
  };

  // ── Google Calendar에서 이벤트 가져오기 (Pull) ──
  const eventsRef = useRef(data.events);
  useEffect(() => { eventsRef.current = data.events; }, [data.events]);

  const fetchGcalEvents = useCallback(async () => {
    if (!isElectron) return;
    try {
      // 현재 보고 있는 달의 범위로 가져오기
      const firstDay = new Date(calYear, calMonth, 1);
      const lastDay = new Date(calYear, calMonth + 1, 0);
      const timeMin = firstDay.toISOString();
      const timeMax = new Date(lastDay.getTime() + 86400000).toISOString(); // 다음달 1일 00:00

      const result = await window.electronAPI.gcalFetchEvents({ timeMin, timeMax });
      if (!result?.success || !result.events?.length) return;

      // ref로 최신 events를 읽어 의존성 순환 방지
      const existingIds = new Set((eventsRef.current || []).map((e) => e.gcalSourceId));

      const newEvents = result.events.filter((e) => !existingIds.has(e.gcalEventId));
      if (newEvents.length === 0) return;

      updateData((d) => {
        if (!d.events) d.events = [];
        for (const ev of newEvents) {
          // updateData 콜백 내에서도 중복 체크 (동시 호출 방지)
          if (d.events.some((e) => e.gcalSourceId === ev.gcalEventId)) continue;

          const localId = generateId();
          d.events.push({
            id: localId,
            name: ev.summary,
            description: ev.description || "",
            date: ev.date,
            time: ev.time || "",
            gcalSourceId: ev.gcalEventId, // 원본 Google 이벤트 ID (중복 방지용)
          });
          // 오늘 날짜면 todayTasks에도 추가
          if (ev.date === todayKey()) {
            if (!d.todayTasks.some((t) => t.taskId === localId)) {
              d.todayTasks.push({ projectId: "event", taskId: localId, projectName: "독립 일정", taskName: ev.summary, description: ev.description || "", completed: false, time: ev.time || "" });
            }
          }
          // 매핑 저장 (비동기, fire-and-forget)
          window.electronAPI.gcalSaveImportMapping({ localId, gcalEventId: ev.gcalEventId, date: ev.date }).catch(() => {});
        }
      });

      console.log(`[gcal] ${newEvents.length}건 Google Calendar에서 가져옴`);
    } catch (e) {
      console.warn("[gcal] fetch 실패:", e);
    }
  }, [calYear, calMonth, updateData]);

  // 앱 로드 시 + 월 변경 시 Google Calendar에서 가져오기
  useEffect(() => {
    if (!loaded) return;
    fetchGcalEvents();
  }, [loaded, fetchGcalEvents]);

  // 3분 간격 자동 동기화 (창이 보일 때만)
  useEffect(() => {
    if (!loaded) return;
    const INTERVAL = 3 * 60 * 1000; // 3분
    let timer = null;

    const startPolling = () => {
      if (timer) return;
      timer = setInterval(() => {
        if (!document.hidden) fetchGcalEvents();
      }, INTERVAL);
    };
    const stopPolling = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };
    const onVisibility = () => {
      if (document.hidden) stopPolling();
      else { fetchGcalEvents(); startPolling(); }
    };

    startPolling();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stopPolling(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [loaded, fetchGcalEvents]);

  // ── 독립 일정 → 프로젝트 하위 업무로 편입 ──
  const convertEventToSubtask = (eventId, projectId) => {
    const ev = (data.events || []).find((e) => e.id === eventId);
    if (!ev) return;

    const newId = generateId();
    updateData((d) => {
      const p = d.projects.find((x) => x.id === projectId);
      if (!p) return;

      // 프로젝트에 서브태스크 추가
      p.subtasks.push({ id: newId, name: ev.name, done: false, children: [], description: ev.description || "" });

      // scheduled에 추가
      if (!d.scheduled) d.scheduled = {};
      if (!d.scheduled[ev.date]) d.scheduled[ev.date] = [];
      d.scheduled[ev.date].push({
        projectId, taskId: newId, projectName: p.name, taskName: ev.name,
        description: ev.description || "", time: ev.time || "",
      });

      // 오늘이면 todayTasks 갱신
      if (ev.date === todayKey()) {
        // 기존 event 항목 교체
        const idx = d.todayTasks.findIndex((t) => t.taskId === eventId);
        if (idx >= 0) {
          d.todayTasks[idx] = {
            projectId, taskId: newId, projectName: p.name, taskName: ev.name,
            description: ev.description || "", completed: false, time: ev.time || "",
          };
        } else {
          d.todayTasks.push({
            projectId, taskId: newId, projectName: p.name, taskName: ev.name,
            description: ev.description || "", completed: false, time: ev.time || "",
          });
        }
      }

      // 독립 일정에서 제거
      d.events = d.events.filter((e) => e.id !== eventId);
      // todayTasks에서 이전 event 항목 정리 (위에서 교체 안 된 경우)
      d.todayTasks = d.todayTasks.filter((t) => t.taskId !== eventId);
    });

    // Google Calendar 매핑: 기존 이벤트 매핑 삭제 → 새 subtask로 매핑 생성
    gcal.del(eventId);
    gcal.create({ localId: newId, summary: ev.name, description: ev.description || "", date: ev.date, time: ev.time || "", type: "scheduled" });
  };

  // ── 다크/라이트 토글 ──
  const toggleTheme = () => setThemeKey(isDark ? "light" : "dark");

  return {
    // 데이터 & 상태
    data, loaded, T, themeKey, setThemeKey, isDark, toggleTheme,
    sideTab, setSideTab, activeProject, setActiveProject,
    modal, setModal, editingTask, setEditingTask,
    expanded, setExpanded, expandedDesc, setExpandedDesc,
    expandedToday, setExpandedToday,
    calYear, setCalYear, calMonth, setCalMonth,
    selectedDay, setSelectedDay,
    miniMode, setMiniMode, isLocked, setIsLocked,
    showControls, setShowControls, isHovered, setIsHovered,
    calPanelHeight, setCalPanelHeight,
    bgOpacity, cardOpacity, calendarRange, setCalendarRange,

    // 프로젝트
    activeProjects, archivedProjects, getProjectById, getColorForProjectId,
    addProject, editProject, deleteProject, archiveProject, restoreProject, reorderProjects,

    // 서브태스크
    addSubtask, editSubtask, editSubtaskDesc, deleteSubtask, reorderSubtasks,

    // 오늘 할 일
    addToToday, toggleTodayTask, removeFromToday, updateCompletedAt,
    pendingToday, doneToday,

    // 날짜별 완료
    completeForDate, uncompleteForDate, isCompletedForDate,

    // 예약
    addToScheduled, deleteScheduled, moveScheduledToToday, getScheduledForDay,

    // 이벤트
    addEvent, deleteEvent, getEventsForDay,
    handleCalendarDoubleClick, addEventAsSubtask,
    convertEventToSubtask, fetchGcalEvents,

    // 정기 업무
    addRecurring, editRecurring, deleteRecurring, toggleRecurring, addRecurringToToday,

    // 캘린더
    getCompForDay, deleteCompleted, calDays, prevMonth, nextMonth,
    td, isTodayDate, getRecurringForDay, getTodayTasksForDay,

    // Electron
    handleMiniMode, handleBgOpacity, handleCardOpacity, windowMode, handleWindowMode,
    handleLock, handleMinimize, handleMaximize, handleClose,
    onMouseEnter, onMouseLeave,

    // 파생
    sideOpen, selectedDateKey, isSelectedToday,
    hasNonTodaySelection, selectedDateLabel, depthColors,
    getScheduledDateForTask, getTaskTime, updateTaskTime,

    // 약관 동의
    agreedTerms, setAgreedTerms,
  };
}
