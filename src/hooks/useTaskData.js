import { useState, useEffect, useCallback, useRef } from "react";
import { isElectron } from "../constants";
import { THEMES } from "../constants/theme";
import { getProjectColor } from "../constants/theme";
import { generateId, todayKey, findTaskById } from "../utils/helpers";
import { getHydratedScheduled, getHydratedCompleted, hydrateTask } from "../utils/selectors";

import gcal from "./gcalHelper";
import { useStorage } from "./useStorage";
import { createProjectActions } from "./useProjects";
import { createTodayTaskActions } from "./useTodayTasks";
import { createRecurringActions } from "./useRecurring";
import { createElectronWindowActions } from "./useElectronWindow";

export default function useTaskData() {
  const {
    data, setData, loaded, updateData,
    themeKey, setThemeKey,
    miniSettings, setMiniSettings,
    calendarRange, setCalendarRange,
    windowMode, setWindowMode,
    agreedTerms, setAgreedTerms,
  } = useStorage();

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
  const currentMiniKey = miniMode || "today";
  const bgOpacity = miniSettings[currentMiniKey]?.bgOpacity ?? 1;
  const cardOpacity = miniSettings[currentMiniKey]?.cardOpacity ?? 1;

  const isDark = themeKey === "dark";
  const T = THEMES[themeKey] || THEMES.light;

  // Electron 윈도우 refs
  const miniBoundsRef = useRef({ today: null, calendar: null });

  // ── 프로젝트 & 서브태스크 ──
  const {
    activeProjects, archivedProjects,
    addProject, editProject, deleteProject, archiveProject, restoreProject, reorderProjects,
    addSubtask, editSubtask, editSubtaskDesc, deleteSubtask, reorderSubtasks,
  } = createProjectActions({ data, updateData, setModal, activeProject, setActiveProject, setExpanded, gcal });

  const getProjectById = (pid) => data.projects.find((p) => p.id === pid && !p.deleted);
  const getColorForProjectId = (pid) => getProjectColor(getProjectById(pid), isDark);

  // ── 오늘 할 일 & 예약 & 날짜별 완료 ──
  const {
    addToToday, toggleTodayTask, removeFromToday, updateCompletedAt,
    completeForDate, uncompleteForDate, isCompletedForDate,
    addToScheduled, deleteScheduled, moveScheduledToToday,
    getScheduledForDay: _getScheduledForDay,
    pendingToday, doneToday,
    getScheduledDateForTask, getTaskTime, updateTaskTime,
  } = createTodayTaskActions({ data, updateData, gcal });

  // calYear/calMonth 기본값을 주입하는 래퍼
  const getScheduledForDay = (day, year, month) => {
    const y = year !== undefined ? year : calYear;
    const m = month !== undefined ? month : calMonth;
    const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return getHydratedScheduled(data, key);
  };

  // ── 정기 업무 ──
  const {
    addRecurring, editRecurring, deleteRecurring, toggleRecurring,
    addRecurringToToday, addRecurringToDate, skipRecurringForDate,
    getRecurringForDay: _getRecurringForDay, cleanupExpiredRecurring,
  } = createRecurringActions({ data, updateData, gcal });

  const getRecurringForDay = (day, year, month) => _getRecurringForDay(day, year, month, calYear, calMonth);

  // 앱 시작 시 만료된 정기업무 자동 정리
  useEffect(() => { if (loaded) cleanupExpiredRecurring(); }, [loaded]);

  // ── Electron 윈도우 ──
  const {
    handleMiniMode, handleWindowMode, handleBgOpacity, handleCardOpacity,
    handleLock, handleMinimize, handleMaximize, handleClose,
    onMouseEnter, onMouseLeave,
  } = createElectronWindowActions({
    miniMode, setMiniMode, isLocked, setIsLocked, setIsHovered,
    miniSettings, setMiniSettings, currentMiniKey,
    windowMode, setWindowMode,
    setSideTab, setActiveProject,
    hoverTimer, miniBoundsRef,
  });

  // ── 독립 이벤트 ──
  const addEvent = (name, desc, dateKey, time) => {
    const evId = generateId();
    updateData((d) => {
      if (!d.events) d.events = [];
      d.events.push({ id: evId, name, description: desc || "", date: dateKey, time: time || "", updatedAt: Date.now() });
      if (dateKey === todayKey()) {
        d.todayTasks.push({ projectId: "event", taskId: evId, completed: false, time: time || "", updatedAt: Date.now() });
      }
    });
    gcal.create({ localId: evId, summary: name, description: desc || "", date: dateKey, time: time || "", type: "event" });
  };

  // ── 이벤트 삭제 (Tombstone / Soft Delete) ──
  const deleteEvent = (id) => {
    updateData((d) => {
      if (!d.events) return;
      const ev = d.events.find((e) => e.id === id);
      if (ev) {
        ev.deleted = true;
        ev.updatedAt = Date.now();
      }
      // todayTasks에서는 즉시 제거 (UI에 보이지 않도록)
      d.todayTasks = d.todayTasks.filter((t) => t.taskId !== id);
    });
    // GCal 삭제 시도 (성공하면 매핑 제거, 오프라인이면 큐에 저장)
    gcal.del(id);
  };

  // ── 이벤트 조회 (deleted 필터링) ──
  const getEventsForDay = (day, year, month) => {
    if (!day) return [];
    const y = year !== undefined ? year : calYear;
    const m = month !== undefined ? month : calMonth;
    const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return (data.events || []).filter((e) => e.date === key && !e.deleted);
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
      p.subtasks.push({ id: newId, name, done: false, children: [], description: desc || "", updatedAt: Date.now() });
      if (!d.scheduled) d.scheduled = {};
      if (!d.scheduled[dateKey]) d.scheduled[dateKey] = [];
      d.scheduled[dateKey].push({ projectId, taskId: newId, time: time || "", updatedAt: Date.now() });
      if (dateKey === todayKey()) {
        d.todayTasks.push({ projectId, taskId: newId, completed: false, time: time || "", updatedAt: Date.now() });
      }
    });
    gcal.create({ localId: newId, summary: name, description: desc || "", date: dateKey, time: time || "", type: "scheduled" });
  };

  // ── 독립 일정 → 프로젝트 하위 업무로 편입 ──
  const convertEventToSubtask = (eventId, projectId) => {
    const ev = (data.events || []).find((e) => e.id === eventId && !e.deleted);
    if (!ev) return;

    const newId = generateId();
    updateData((d) => {
      const p = d.projects.find((x) => x.id === projectId);
      if (!p) return;

      // 프로젝트에 서브태스크 추가
      p.subtasks.push({ id: newId, name: ev.name, done: false, children: [], description: ev.description || "", updatedAt: Date.now() });

      // scheduled에 추가
      if (!d.scheduled) d.scheduled = {};
      if (!d.scheduled[ev.date]) d.scheduled[ev.date] = [];
      d.scheduled[ev.date].push({ projectId, taskId: newId, time: ev.time || "", updatedAt: Date.now() });

      // 오늘이면 todayTasks 갱신
      if (ev.date === todayKey()) {
        const idx = d.todayTasks.findIndex((t) => t.taskId === eventId);
        if (idx >= 0) {
          d.todayTasks[idx] = { projectId, taskId: newId, completed: false, time: ev.time || "", updatedAt: Date.now() };
        } else {
          d.todayTasks.push({ projectId, taskId: newId, completed: false, time: ev.time || "", updatedAt: Date.now() });
        }
      }

      // 기존 이벤트는 Soft Delete (툼스톤)
      const origEv = d.events.find((e) => e.id === eventId);
      if (origEv) {
        origEv.deleted = true;
        origEv.updatedAt = Date.now();
      }
      d.todayTasks = d.todayTasks.filter((t) => t.taskId !== eventId);
    });

    // Google Calendar 매핑: 기존 이벤트 매핑 삭제 → 새 subtask로 매핑 생성
    gcal.del(eventId);
    gcal.create({ localId: newId, summary: ev.name, description: ev.description || "", date: ev.date, time: ev.time || "", type: "scheduled" });
  };

  // ── 캘린더 헬퍼 ──
  const getCompForDay = (day, year, month) => {
    if (!day) return [];
    const y = year !== undefined ? year : calYear;
    const m = month !== undefined ? month : calMonth;
    const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return getHydratedCompleted(data, key);
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

  const getTodayTasksForDay = (day, year, month) => {
    if (!day) return [];
    const y = year !== undefined ? year : calYear;
    const m = month !== undefined ? month : calMonth;
    const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (key !== todayKey()) return [];
    return data.todayTasks.filter((t) => !t.completed).map((t) => hydrateTask(data, t));
  };

  // ── 다크/라이트 토글 ──
  const toggleTheme = () => setThemeKey(isDark ? "light" : "dark");

  // ── Google Calendar에서 이벤트 가져오기 (Pull) ──
  const eventsRef = useRef(data.events);
  useEffect(() => { eventsRef.current = data.events; }, [data.events]);
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  const fetchGcalEvents = useCallback(async () => {
    if (!isElectron) return;
    try {
      // 초기 push 동기화가 완료될 때까지 대기 (매핑이 저장되어야 중복 import 방지 가능)
      await gcal.waitForInitialSync();

      const firstDay = new Date(calYear, calMonth, 1);
      const lastDay = new Date(calYear, calMonth + 1, 0);
      const timeMin = firstDay.toISOString();
      const timeMax = new Date(lastDay.getTime() + 86400000).toISOString();

      const result = await window.electronAPI.gcalFetchEvents({ timeMin, timeMax });
      if (!result?.success || !result.events?.length) return;

      const currentEvents = eventsRef.current || [];
      const existingIds = new Set(currentEvents.map((e) => e.gcalSourceId));

      // 로컬에서 Soft Delete된 이벤트의 gcalSourceId 목록 (좀비 이벤트 방지)
      const tombstonedGcalIds = new Set(
        currentEvents.filter((e) => e.deleted && e.gcalSourceId).map((e) => e.gcalSourceId)
      );

      const newEvents = result.events.filter((e) =>
        !existingIds.has(e.gcalEventId) && !tombstonedGcalIds.has(e.gcalEventId)
      );
      if (newEvents.length === 0) {
        // 툼스톤 클린업: GCal에서도 사라진 이벤트의 툼스톤을 제거
        cleanupTombstones(result.events);
        return;
      }

      updateData((d) => {
        if (!d.events) d.events = [];
        for (const ev of newEvents) {
          if (d.events.some((e) => e.gcalSourceId === ev.gcalEventId)) continue;
          // 툼스톤에 해당하면 스킵
          if (d.events.some((e) => e.deleted && e.gcalSourceId === ev.gcalEventId)) continue;

          const localId = generateId();
          d.events.push({
            id: localId,
            name: ev.summary,
            description: ev.description || "",
            date: ev.date,
            time: ev.time || "",
            gcalSourceId: ev.gcalEventId,
            updatedAt: Date.now(),
          });
          if (ev.date === todayKey()) {
            if (!d.todayTasks.some((t) => t.taskId === localId)) {
              d.todayTasks.push({ projectId: "event", taskId: localId, completed: false, time: ev.time || "", updatedAt: Date.now() });
            }
          }
          window.electronAPI.gcalSaveImportMapping({ localId, gcalEventId: ev.gcalEventId, date: ev.date }).catch(() => {});
        }
      });

      // 풀 완료 후 툼스톤 클린업
      cleanupTombstones(result.events);

      console.log(`[gcal] ${newEvents.length}건 Google Calendar에서 가져옴`);
    } catch (e) {
      console.warn("[gcal] fetch 실패:", e);
    }
  }, [calYear, calMonth, updateData]);

  // 툼스톤 클린업: GCal에서 삭제 확인된 이벤트의 툼스톤을 로컬에서 완전 제거
  const cleanupTombstones = useCallback((gcalEvents) => {
    const gcalEventIds = new Set((gcalEvents || []).map((e) => e.gcalEventId));
    updateData((d) => {
      if (!d.events) return;
      // 톰스톤이 없으면 변경하지 않음 (불필요한 리렌더링 방지)
      const hasTombstones = d.events.some((e) => e.deleted);
      if (!hasTombstones) return;
      // 실제로 제거할 톰스톤이 있는지 확인
      const toRemove = d.events.filter((e) => {
        if (!e.deleted) return false;
        if (e.gcalSourceId) return !gcalEventIds.has(e.gcalSourceId);
        if (e.updatedAt && Date.now() - e.updatedAt > 7 * 24 * 60 * 60 * 1000) return true;
        return false;
      });
      if (toRemove.length === 0) return; // 제거할 항목이 없으면 변경하지 않음
      const removeIds = new Set(toRemove.map((e) => e.id));
      d.events = d.events.filter((e) => !removeIds.has(e.id));
    });
  }, [updateData]);

  // 앱 로드 시 + 월 변경 시 Google Calendar에서 가져오기
  useEffect(() => {
    if (!loaded) return;
    fetchGcalEvents();
  }, [loaded, fetchGcalEvents]);

  // 3분 간격 자동 동기화 (Pull + Push 보정)
  useEffect(() => {
    if (!loaded) return;
    const INTERVAL = 3 * 60 * 1000;
    let timer = null;

    const syncCycle = () => {
      if (document.hidden) return;
      // Push 먼저 (매핑 완성) → Pull (중복 import 방지)
      gcal.syncExisting(dataRef.current);       // Push 보정: 누락 항목 재동기화
      gcal.flushOfflineQueue();                 // 오프라인 큐 재시도
      fetchGcalEvents();                        // Pull: waitForInitialSync()로 push 완료 후 실행
    };

    const startPolling = () => {
      if (timer) return;
      timer = setInterval(syncCycle, INTERVAL);
    };
    const stopPolling = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };
    const onVisibility = () => {
      if (document.hidden) stopPolling();
      else { syncCycle(); startPolling(); }
    };

    startPolling();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stopPolling(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [loaded, fetchGcalEvents]);

  // ── 파생 상태 ──
  const sideOpen = sideTab !== null;
  const selectedDateKey = selectedDay ? `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(selectedDay).padStart(2, "0")}` : null;
  const isSelectedToday = selectedDateKey === todayKey();
  const hasNonTodaySelection = selectedDay !== null && !isSelectedToday;
  const selectedDateLabel = selectedDay ? `${calMonth + 1}/${selectedDay}` : "";
  const depthColors = [T.primary, "#818cf8", "#a78bfa", "#c4b5fd"];

  return {
    // 데이터 & 상태
    data, setData, loaded, T, themeKey, setThemeKey, isDark, toggleTheme,
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
    skipRecurringForDate, addRecurringToDate,

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
