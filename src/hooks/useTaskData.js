import { useState, useEffect, useCallback, useRef } from "react";
import { isElectron } from "../constants";
import { THEMES } from "../constants/theme";
import { getProjectColor } from "../constants/theme";
import { generateId, todayKey, findTaskById } from "../utils/helpers";
import { getHydratedScheduled, getHydratedCompleted } from "../utils/selectors";

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
  const [selectedDay, setSelectedDay] = useState(new Date().getDate());
  const [holidays, setHolidays] = useState({});

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
    addSubtask, editSubtask, editSubtaskDesc, editSubtaskTime, deleteSubtask, reorderSubtasks, moveTaskUnder, moveTaskBeside,
  } = createProjectActions({ data, updateData, setModal, activeProject, setActiveProject, setExpanded, gcal });

  const getProjectById = (pid) => data.projects.find((p) => p.id === pid && !p.deleted);
  const getColorForProjectId = (pid) => getProjectColor(getProjectById(pid), isDark);

  // ── 오늘 할 일 & 예약 & 날짜별 완료 ──
  const {
    toggleTodayTask, updateCompletedAt,
    completeForDate, uncompleteForDate, isCompletedForDate,
    addToScheduled, deleteScheduled,
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
    addRecurringToDate, skipRecurringForDate,
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
  const addEvent = (name, desc, dateKey, time, endTime) => {
    const evId = generateId();
    updateData((d) => {
      if (!d.events) d.events = [];
      d.events.push({ id: evId, name, description: desc || "", date: dateKey, time: time || "", endTime: endTime || "", updatedAt: Date.now() });
    });
    gcal.create({ localId: evId, summary: name, description: desc || "", date: dateKey, time: time || "", endTime: endTime || "", type: "event" });
  };

  // ── 이벤트 수정 ──
  const editEvent = (id, name, desc) => {
    const ev = (data.events || []).find((e) => e.id === id);
    const isCompleted = ev ? (data.completedToday?.[ev.date] || []).some((c) => c.taskId === id) : false;
    updateData((d) => {
      if (!d.events) return;
      const ev = d.events.find((e) => e.id === id);
      if (ev) { ev.name = name; ev.description = desc || ""; ev.updatedAt = Date.now(); }
    });
    const summary = isCompleted ? `(완료) ${name}` : name;
    gcal.update({ localId: id, summary, description: desc || "" });
  };

  // ── 이벤트 시간 변경 ──
  const updateEventTime = (id, time, endTime) => {
    const ev = (data.events || []).find((e) => e.id === id);
    const isCompleted = ev ? (data.completedToday?.[ev.date] || []).some((c) => c.taskId === id) : false;
    updateData((d) => {
      if (!d.events) return;
      const e = d.events.find((x) => x.id === id);
      if (e) { e.time = time || ""; e.endTime = endTime || ""; e.updatedAt = Date.now(); }
    });
    // GCal에 시간 변경 반영 (완료 상태 유지)
    if (ev) {
      const summary = isCompleted ? `(완료) ${ev.name}` : ev.name;
      gcal.update({ localId: id, summary, time: time || "", endTime: endTime || "", date: ev.date });
    }
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

  const addEventAsSubtask = (projectId, name, desc, dateKey, time, endTime) => {
    const newId = generateId();
    updateData((d) => {
      const p = d.projects.find((x) => x.id === projectId);
      if (!p) return;
      p.subtasks.push({ id: newId, name, done: false, children: [], description: desc || "", updatedAt: Date.now() });
      p.updatedAt = Date.now();
      if (!d.scheduled) d.scheduled = {};
      if (!d.scheduled[dateKey]) d.scheduled[dateKey] = [];
      d.scheduled[dateKey].push({ projectId, taskId: newId, time: time || "", endTime: endTime || "", updatedAt: Date.now() });
    });
    gcal.create({ localId: newId, summary: name, description: desc || "", date: dateKey, time: time || "", endTime: endTime || "", type: "scheduled" });
  };

  // ── 독립 일정 → 프로젝트 하위 업무로 편입 ──
  const convertEventToSubtask = (eventId, projectId) => {
    const ev = (data.events || []).find((e) => e.id === eventId && !e.deleted);
    if (!ev) return;

    // 기존 이벤트 ID를 서브태스크 ID로 재사용 → GCal 매핑이 자동 유지됨
    // (새 ID를 만들면 GCal에서 삭제+재생성이 필요하여 중복 발생)
    const subtaskId = eventId;

    updateData((d) => {
      const p = d.projects.find((x) => x.id === projectId);
      if (!p) return;

      // 프로젝트에 서브태스크 추가 (기존 이벤트 ID 재사용)
      p.subtasks.push({ id: subtaskId, name: ev.name, done: false, children: [], description: ev.description || "", updatedAt: Date.now() });
      p.updatedAt = Date.now();

      // scheduled에 추가
      if (!d.scheduled) d.scheduled = {};
      if (!d.scheduled[ev.date]) d.scheduled[ev.date] = [];
      d.scheduled[ev.date].push({ projectId, taskId: subtaskId, time: ev.time || "", updatedAt: Date.now() });

      // 기존 이벤트는 Soft Delete (툼스톤)
      const origEv = d.events.find((e) => e.id === eventId);
      if (origEv) {
        origEv.deleted = true;
        origEv.updatedAt = Date.now();
      }
    });

    // GCal 매핑 유지: 기존 매핑(eventId → gcalEventId)이 그대로 subtaskId에 적용됨
    // 삭제/재생성 없이 업데이트만 (이벤트 타입 변경 반영)
    gcal.update({ localId: subtaskId, summary: ev.name, description: ev.description || "", date: ev.date, time: ev.time || "" });
  };

  // ── 퀵 일정 ──
  const addQuickTask = (name, desc, time, endTime) => {
    const id = generateId();
    updateData((d) => {
      if (!d.quickTasks) d.quickTasks = [];
      d.quickTasks.push({ id, name, description: desc || "", time: time || "", endTime: endTime || "", updatedAt: Date.now() });
    });
  };

  const editQuickTask = (id, name, desc, time, endTime) => {
    updateData((d) => {
      const q = (d.quickTasks || []).find((x) => x.id === id);
      if (q) { q.name = name; q.description = desc || ""; q.time = time || ""; q.endTime = endTime || ""; q.updatedAt = Date.now(); }
    });
  };

  const deleteQuickTask = (id) => {
    updateData((d) => { d.quickTasks = (d.quickTasks || []).filter((x) => x.id !== id); });
  };

  const scheduleQuickTask = (quickTaskId, dateKey) => {
    const qt = (data.quickTasks || []).find((x) => x.id === quickTaskId);
    if (!qt) return false;
    // 같은 날짜에 같은 퀵 일정이 이미 있는지 체크
    const existing = (data.events || []).find((e) => e.quickTaskId === quickTaskId && e.date === dateKey && !e.deleted);
    if (existing) return false; // 중복
    const evId = generateId();
    updateData((d) => {
      if (!d.events) d.events = [];
      d.events.push({ id: evId, name: qt.name, description: qt.description || "", date: dateKey, time: qt.time || "", endTime: qt.endTime || "", quickTaskId, updatedAt: Date.now() });
      // 퀵 일정은 todayTasks에 추가하지 않음 - 캘린더에서 quickTaskId로 별도 표시
    });
    gcal.create({ localId: evId, summary: qt.name, description: qt.description || "", date: dateKey, time: qt.time || "", endTime: qt.endTime || "", type: "event" });
    return true;
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

      // import할 이벤트 목록 확정 (updateData 밖에서 필터링)
      const currentData = dataRef.current;
      const existingGcalIds = new Set((currentData.events || []).map((e) => e.gcalSourceId).filter(Boolean));
      const tombstonedIds = new Set((currentData.events || []).filter((e) => e.deleted && e.gcalSourceId).map((e) => e.gcalSourceId));

      // 같은 날짜+같은 이름의 로컬 독립일정 중복 방지 (매핑 유실 시 안전장치)
      const localEventKeys = new Set();
      for (const ev of (currentData.events || [])) {
        if (ev.deleted) continue;
        localEventKeys.add(`${ev.date}:${ev.name}`);
      }

      const toImport = [];
      for (const ev of newEvents) {
        // gcalSourceId 기반 중복 체크 (가장 확실한 기준)
        if (existingGcalIds.has(ev.gcalEventId)) continue;
        if (tombstonedIds.has(ev.gcalEventId)) continue;
        // 같은 날짜+같은 이름의 이벤트가 이미 있으면 스킵 (매핑 유실 방어)
        const cleanName = (ev.summary || "").replace(/^\(완료\)\s*/, "");
        if (localEventKeys.has(`${ev.date}:${cleanName}`)) continue;
        toImport.push(ev);
      }

      if (toImport.length === 0) {
        cleanupTombstones(result.events);
        return;
      }

      // import 실행: 로컬 이벤트 생성 + 매핑 저장을 순차적으로 처리
      const importedPairs = [];
      updateData((d) => {
        if (!d.events) d.events = [];
        for (const ev of toImport) {
          // updateData 내부에서 한번 더 중복 체크 (동시 호출 방어)
          if (d.events.some((e) => e.gcalSourceId === ev.gcalEventId)) continue;
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
          importedPairs.push({ localId, gcalEventId: ev.gcalEventId, date: ev.date });
        }
      });

      // 매핑 저장을 await하여 완료 보장 (다음 fetch 시 중복 import 방지)
      for (const pair of importedPairs) {
        try {
          await window.electronAPI.gcalSaveImportMapping(pair);
        } catch (e) {
          console.warn('[gcal] import 매핑 저장 실패:', e);
        }
      }

      // 풀 완료 후 툼스톤 클린업
      cleanupTombstones(result.events);

      console.log(`[gcal] ${importedPairs.length}건 Google Calendar에서 가져옴`);
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

  // ── GCal에서 변경사항 Pull (앱이 push한 이벤트의 수정 감지) ──
  const pullGcalChanges = useCallback(async () => {
    if (!isElectron) return;
    try {
      const firstDay = new Date(calYear, calMonth, 1);
      const lastDay = new Date(calYear, calMonth + 1, 0);
      const timeMin = firstDay.toISOString();
      const timeMax = new Date(lastDay.getTime() + 86400000).toISOString();

      const result = await window.electronAPI.gcalPullChanges({ timeMin, timeMax });
      if (!result?.success || !result.changes?.length) return;

      updateData((d) => {
        for (const change of result.changes) {
          // 제목 변경 반영
          if (change.summaryChanged) {
            const cleanName = (change.newSummary || '').replace(/^\(완료\)\s*/, '');
            // events에서 찾기
            const ev = (d.events || []).find((e) => e.id === change.localId);
            if (ev) { ev.name = cleanName; ev.updatedAt = Date.now(); }
            // projects subtask에서 찾기
            for (const p of (d.projects || [])) {
              const task = findTaskById(p.subtasks || [], change.localId);
              if (task) { task.name = cleanName; task.updatedAt = Date.now(); p.updatedAt = Date.now(); break; }
            }
          }

          // 날짜 변경 반영
          if (change.dateChanged) {
            // events의 날짜 변경
            const ev = (d.events || []).find((e) => e.id === change.localId);
            if (ev) { ev.date = change.newDate; ev.updatedAt = Date.now(); }
            // scheduled 이동
            if (change.oldDate && d.scheduled?.[change.oldDate]) {
              const idx = d.scheduled[change.oldDate].findIndex((s) => s.taskId === change.localId);
              if (idx !== -1) {
                const [item] = d.scheduled[change.oldDate].splice(idx, 1);
                if (d.scheduled[change.oldDate].length === 0) delete d.scheduled[change.oldDate];
                if (!d.scheduled[change.newDate]) d.scheduled[change.newDate] = [];
                d.scheduled[change.newDate].push({ ...item, updatedAt: Date.now() });
              }
            }
          }

          // 완료 상태 변경 반영
          if (change.completionChanged === 'uncompleted') {
            // GCal에서 (완료) 태그 제거됨 → 앱에서 미완료로 전환
            const dateKey = change.newDate || change.oldDate;
            if (dateKey && d.completedToday?.[dateKey]) {
              d.completedToday[dateKey] = d.completedToday[dateKey].filter((c) => c.taskId !== change.localId);
              if (d.completedToday[dateKey].length === 0) delete d.completedToday[dateKey];
            }
            // 프로젝트 서브태스크 done 해제
            for (const p of (d.projects || [])) {
              const task = findTaskById(p.subtasks || [], change.localId);
              if (task) { task.done = false; task.updatedAt = Date.now(); p.updatedAt = Date.now(); break; }
            }
          } else if (change.completionChanged === 'completed') {
            // GCal에서 (완료) 태그 추가됨 → 앱에서 완료로 전환
            const dateKey = change.newDate || change.oldDate;
            if (dateKey) {
              if (!d.completedToday[dateKey]) d.completedToday[dateKey] = [];
              if (!d.completedToday[dateKey].some((c) => c.taskId === change.localId)) {
                // projectId 결정
                let pid = 'event';
                if (change.type === 'recurring') pid = 'recurring';
                else if (change.type === 'scheduled') {
                  for (const p of (d.projects || [])) {
                    if (findTaskById(p.subtasks || [], change.localId)) { pid = p.id; break; }
                  }
                }
                d.completedToday[dateKey].push({ projectId: pid, taskId: change.localId, completedAt: new Date().toISOString(), updatedAt: Date.now() });
              }
            }
            // 프로젝트 서브태스크 done 설정
            for (const p of (d.projects || [])) {
              const task = findTaskById(p.subtasks || [], change.localId);
              if (task) { task.done = true; task.updatedAt = Date.now(); p.updatedAt = Date.now(); break; }
            }
          }
        }
      });

      console.log(`[gcal] ${result.changes.length}건 GCal 변경사항 반영`);
    } catch (e) {
      console.warn('[gcal] pull changes 실패:', e);
    }
  }, [calYear, calMonth, updateData]);

  // 공휴일 가져오기 (연 단위 캐싱)
  const holidayYearRef = useRef(null);
  const fetchHolidays = useCallback(async (year) => {
    if (!isElectron) return;
    if (holidayYearRef.current === year) return;
    try {
      const timeMin = new Date(year, 0, 1).toISOString();
      const timeMax = new Date(year, 11, 31, 23, 59, 59).toISOString();
      const result = await window.electronAPI.gcalFetchHolidays({ timeMin, timeMax });
      if (!result?.success) return;
      const map = {};
      for (const h of (result.holidays || [])) {
        map[h.date] = h.name;
      }
      setHolidays(map);
      holidayYearRef.current = year;
    } catch (e) {
      console.warn("[gcal] 공휴일 fetch 실패:", e);
    }
  }, []);

  const getHolidayForDay = (day, year, month) => {
    if (!day) return null;
    const y = year !== undefined ? year : calYear;
    const m = month !== undefined ? month : calMonth;
    const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return holidays[key] || null;
  };

  // 연도 변경 시 공휴일 갱신
  useEffect(() => {
    if (!loaded) return;
    fetchHolidays(calYear);
  }, [loaded, calYear, fetchHolidays]);

  // GCal 중복 이벤트 자동 정리
  const deduplicateGcal = useCallback(async () => {
    if (!isElectron) return;
    try {
      const now = new Date();
      const timeMin = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const timeMax = new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString();
      const result = await window.electronAPI.gcalDeduplicate({ timeMin, timeMax });
      if (result?.duplicates > 0) {
        console.log(`[gcal] 중복 ${result.duplicates}건 자동 정리됨`);
      }
    } catch (e) {
      console.warn("[gcal] 중복 정리 실패:", e);
    }
  }, []);

  // 앱 로드 시 + 월 변경 시 Google Calendar에서 가져오기 + 중복 정리
  useEffect(() => {
    if (!loaded) return;
    fetchGcalEvents();
    // 앱 시작 시 GCal 중복 이벤트 자동 정리 (5초 후 — 초기 sync 완료 대기)
    const dedupeTimer = setTimeout(deduplicateGcal, 5000);
    return () => clearTimeout(dedupeTimer);
  }, [loaded, fetchGcalEvents, deduplicateGcal]);

  // 10분 간격 자동 동기화 (Pull + Push 보정)
  useEffect(() => {
    if (!loaded) return;
    const INTERVAL = 10 * 60 * 1000;
    const MIN_SYNC_GAP = 5 * 60 * 1000; // 탭 복귀 시 최소 5분 경과해야 동기화
    let timer = null;
    let lastSyncTime = Date.now();

    const syncCycle = () => {
      if (document.hidden) return;
      lastSyncTime = Date.now();
      // Push 먼저 (매핑 완성) → Pull (중복 import 방지)
      gcal.syncExisting(dataRef.current);       // Push 보정: 누락 항목 재동기화
      gcal.flushOfflineQueue();                 // 오프라인 큐 재시도
      fetchGcalEvents();                        // Pull: 새 이벤트 import
      pullGcalChanges();                        // Pull: 기존 이벤트 변경사항 반영
    };

    const startPolling = () => {
      if (timer) return;
      timer = setInterval(syncCycle, INTERVAL);
    };
    const stopPolling = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };
    const onVisibility = () => {
      if (document.hidden) { stopPolling(); return; }
      // 탭 복귀 시 마지막 동기화로부터 5분 이상 지났을 때만 실행
      if (Date.now() - lastSyncTime >= MIN_SYNC_GAP) syncCycle();
      startPolling();
    };

    startPolling();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stopPolling(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [loaded, fetchGcalEvents, pullGcalChanges]);

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
    addSubtask, editSubtask, editSubtaskDesc, editSubtaskTime, deleteSubtask, reorderSubtasks, moveTaskUnder, moveTaskBeside,

    // 오늘 할 일
    toggleTodayTask, updateCompletedAt,
    pendingToday, doneToday,

    // 날짜별 완료
    completeForDate, uncompleteForDate, isCompletedForDate,

    // 예약
    addToScheduled, deleteScheduled, getScheduledForDay,

    // 이벤트
    addEvent, editEvent, deleteEvent, updateEventTime, getEventsForDay,
    handleCalendarDoubleClick, addEventAsSubtask,
    convertEventToSubtask, fetchGcalEvents,

    // 퀵 일정
    addQuickTask, editQuickTask, deleteQuickTask, scheduleQuickTask,

    // 정기 업무
    addRecurring, editRecurring, deleteRecurring, toggleRecurring,
    skipRecurringForDate, addRecurringToDate,

    // 캘린더
    getCompForDay, deleteCompleted, calDays, prevMonth, nextMonth,
    td, isTodayDate, getRecurringForDay,
    getHolidayForDay,

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
