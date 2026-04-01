import { produce } from "immer";
import { migrateToNormalizedData } from "../utils/selectors";
import { useState, useEffect, useRef, useCallback } from "react";
import { defaultData, STORAGE_KEY, THEME_KEY, MINI_SETTINGS_KEY, CAL_RANGE_KEY, WINDOW_MODE_KEY, isElectron } from "../constants";
import { todayKey, findTaskById } from "../utils/helpers";
import { THEMES } from "../constants/theme";
import gcal from "./gcalHelper";

const defaultMiniSettings = {
  today: { bgOpacity: 1, cardOpacity: 1 },
  calendar: { bgOpacity: 1, cardOpacity: 1 }
};

export function useStorage() {
  const [data, setData] = useState(defaultData);
  const [loaded, setLoaded] = useState(false);
  const [themeKey, setThemeKey] = useState("light");
  const [miniSettings, setMiniSettings] = useState(defaultMiniSettings);
  const [calendarRange, setCalendarRange] = useState(0);
  const [windowMode, setWindowMode] = useState("normal");
  const [agreedTerms, setAgreedTerms] = useState(false);

  const saveDataTimer = useRef(null);
  const saveSettingsTimer = useRef(null);
  const latestDataRef = useRef(data);
  const latestSettingsRef = useRef(null);
  const dataDirtyRef = useRef(false);
  const settingsDirtyRef = useRef(false);
  const externalUpdateRef = useRef(false);  // 외부 데이터 수신 시 저장 방지 플래그
  const lastSavedTimestampRef = useRef(0);  // 마지막 저장 시 사용한 lastUpdated

  useEffect(() => {
    const loadAll = async () => {
      if (isElectron) {
        const fileData = await window.electronAPI.loadAppData();
        if (fileData) {
          setData({ ...defaultData, ...migrateToNormalizedData(fileData) });
        } else {
          try {
            const val = localStorage.getItem(STORAGE_KEY);
            if (val) {
              const migrated = { ...defaultData, ...JSON.parse(val) };
              setData(migrateToNormalizedData(migrated));
              await window.electronAPI.saveAppData(JSON.stringify(migrated));
              localStorage.removeItem(STORAGE_KEY);
            }
          } catch (e) {}
        }

        const fileSettings = await window.electronAPI.loadSettings();
        if (fileSettings) {
          if (fileSettings.themeKey && THEMES[fileSettings.themeKey]) setThemeKey(fileSettings.themeKey);
          if (fileSettings.miniSettings) setMiniSettings((prev) => ({ ...prev, ...fileSettings.miniSettings }));
          if (fileSettings.calendarRange !== undefined) setCalendarRange(Number(fileSettings.calendarRange));
          if (fileSettings.windowMode) setWindowMode(fileSettings.windowMode);
          if (fileSettings.agreedTerms) setAgreedTerms(true);
        }
      } else {
        try {
          const val = localStorage.getItem(STORAGE_KEY);
          if (val) setData({ ...defaultData, ...JSON.parse(val) });
        } catch (e) {}
      }
      setLoaded(true);
    };
    loadAll();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    latestDataRef.current = data;

    // 외부 데이터 수신(onExternalDataChanged)으로 인한 변경은 저장하지 않음 (무한 루프 방지)
    if (externalUpdateRef.current) {
      externalUpdateRef.current = false;
      return;
    }

    dataDirtyRef.current = true;
    if (saveDataTimer.current) clearTimeout(saveDataTimer.current);
    saveDataTimer.current = setTimeout(() => {
      flushData();
    }, 300);
    return () => clearTimeout(saveDataTimer.current);
  }, [data, loaded]);

  useEffect(() => {
    if (!loaded) return;
    latestSettingsRef.current = { themeKey, miniSettings, calendarRange, windowMode, agreedTerms };
    settingsDirtyRef.current = true;
    if (saveSettingsTimer.current) clearTimeout(saveSettingsTimer.current);
    saveSettingsTimer.current = setTimeout(() => {
      flushSettings();
    }, 300);
    return () => clearTimeout(saveSettingsTimer.current);
  }, [themeKey, miniSettings, calendarRange, windowMode, agreedTerms, loaded]);

  const flushData = useCallback(() => {
    if (!dataDirtyRef.current) return;
    dataDirtyRef.current = false;
    if (saveDataTimer.current) clearTimeout(saveDataTimer.current);
    const d = latestDataRef.current;
    if (isElectron) {
      const ts = Date.now();
      lastSavedTimestampRef.current = ts;
      return window.electronAPI.saveAppData(JSON.stringify({ ...d, lastUpdated: ts })).then((result) => {
        if (result?.merged) {
          // 병합 결과를 받으면 외부 업데이트 플래그 설정 (save-app-data가 이미 external-data-changed를 보냄)
          lastSavedTimestampRef.current = result.data?.lastUpdated || ts;
        }
      });
    } else {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); return Promise.resolve(); } catch (e) { return Promise.reject(e); }
    }
  }, []);

  const flushSettings = useCallback(() => {
    if (!settingsDirtyRef.current) return;
    settingsDirtyRef.current = false;
    if (saveSettingsTimer.current) clearTimeout(saveSettingsTimer.current);
    const s = latestSettingsRef.current;
    if (!s) return Promise.resolve();
    if (isElectron) {
      return window.electronAPI.saveSettings(JSON.stringify(s));
    } else {
      try {
        localStorage.setItem(THEME_KEY, s.themeKey);
        localStorage.setItem(MINI_SETTINGS_KEY, JSON.stringify(s.miniSettings));
        localStorage.setItem(CAL_RANGE_KEY, String(s.calendarRange));
        localStorage.setItem(WINDOW_MODE_KEY, s.windowMode);
        return Promise.resolve();
      } catch (e) { return Promise.reject(e); }
    }
  }, []);

  useEffect(() => {
    if (!isElectron) return;
    window.electronAPI.onRequestSaveBeforeClose(async () => {
      await Promise.all([flushData(), flushSettings()]);
      window.electronAPI.sendSaveComplete();
    });
  }, [flushData, flushSettings]);

  const updateData = useCallback((fn) => {
    setData((prev) => produce(prev, (draft) => {
      fn(draft);
    }));
  }, []);

  useEffect(() => {
    if (!isElectron) return;

    // ── 프론트엔드 경량 병합 유틸리티 ──
    const mergeOnRenderer = (local, remote) => {
      if (!remote) return local;
      const merged = { ...remote };

      // 1. 단순 엔티티 병합 (ID + updatedAt 기준)
      const mergeArrays = (lArr, rArr) => {
        const map = new Map();
        (rArr || []).forEach(item => map.set(item.id, item));
        (lArr || []).forEach(item => {
          const existing = map.get(item.id);
          if (!existing || (item.updatedAt || 0) > (existing.updatedAt || 0)) map.set(item.id, item);
        });
        return Array.from(map.values());
      };

      // 2. todayTasks 병합 (taskId 기준)
      const mergeToday = (lArr, rArr) => {
        const map = new Map();
        (rArr || []).forEach(item => map.set(item.taskId, item));
        (lArr || []).forEach(item => {
          const existing = map.get(item.taskId);
          if (!existing || (item.updatedAt || 0) > (existing.updatedAt || 0)) map.set(item.taskId, item);
        });
        return Array.from(map.values());
      };

      // 3. 날짜 키 기반 객체 병합 (scheduled, completedToday)
      const mergeDateKeyed = (lObj, rObj) => {
        const result = {};
        const allKeys = new Set([...Object.keys(lObj || {}), ...Object.keys(rObj || {})]);
        for (const key of allKeys) {
          const lItems = (lObj || {})[key] || [];
          const rItems = (rObj || {})[key] || [];
          // taskId 기준 병합, updatedAt이 큰 쪽 우선
          const map = new Map();
          rItems.forEach(item => map.set(item.taskId, item));
          lItems.forEach(item => {
            const existing = map.get(item.taskId);
            if (!existing || (item.updatedAt || 0) > (existing.updatedAt || 0)) map.set(item.taskId, item);
          });
          const merged = Array.from(map.values());
          if (merged.length > 0) result[key] = merged;
        }
        return result;
      };

      merged.projects = mergeArrays(local.projects, remote.projects);
      merged.events = mergeArrays(local.events, remote.events);
      merged.recurring = mergeArrays(local.recurring, remote.recurring);
      merged.todayTasks = mergeToday(local.todayTasks, remote.todayTasks);
      merged.scheduled = mergeDateKeyed(local.scheduled, remote.scheduled);
      merged.completedToday = mergeDateKeyed(local.completedToday, remote.completedToday);
      merged.lastUpdated = Math.max(local.lastUpdated || 0, remote.lastUpdated || 0);
      return merged;
    };

    window.electronAPI.onExternalDataChanged((newData) => {
      if (!newData) return;
      externalUpdateRef.current = true;  // 저장 루프 방지
      setData((prev) => {
        // 외부(다른 PC) 변경은 전체 교체 — merge하면 삭제된 항목이 부활함
        if ((newData.lastUpdated || 0) >= (prev.lastUpdated || 0)) {
          lastSavedTimestampRef.current = newData.lastUpdated || 0;
          return { ...defaultData, ...migrateToNormalizedData(newData) };
        }
        // 로컬이 더 최신이면 무시
        return prev;
      });
    });

    window.electronAPI.onDataConflict((diskData) => {
      if (!diskData) return;
      console.warn("[Sync] 데이터 충돌 감지 — 최신 데이터로 교체합니다.");
      externalUpdateRef.current = true;  // 저장 루프 방지
      setData((prev) => {
        // 충돌 시에도 전체 교체 (더 최신 데이터 기준)
        if ((diskData.lastUpdated || 0) >= (prev.lastUpdated || 0)) {
          lastSavedTimestampRef.current = diskData.lastUpdated || 0;
          return { ...defaultData, ...migrateToNormalizedData(diskData) };
        }
        return prev;
      });
    });

  }, []);

  useEffect(() => {
    if (!loaded) return;
    gcal.flushOfflineQueue();
    gcal.syncExisting(data);
    const onFocus = async () => {
      gcal.flushOfflineQueue();
      // 포커스 시 클라우드 동기화 모드일 때만 변경 체크 (로컬 모드는 스킵)
      if (isElectron && window.electronAPI.getLastUpdated) {
        try {
          // 클라우드 동기화 모드가 아니면 불필요한 로드 스킵
          const isCloud = await window.electronAPI.isCloudSync();
          if (!isCloud) return;

          // lastUpdated만 경량 체크 → 변경 시에만 전체 로드
          const diskTs = await window.electronAPI.getLastUpdated();
          if (!diskTs || diskTs <= (latestDataRef.current.lastUpdated || 0)) return;

          const diskData = await window.electronAPI.loadAppData();
          if (diskData && diskData.lastUpdated) {
            setData((prev) => {
              if (!prev.lastUpdated || diskData.lastUpdated > prev.lastUpdated) {
                externalUpdateRef.current = true;
                return { ...defaultData, ...migrateToNormalizedData(diskData) };
              }
              return prev;
            });
          }
        } catch (e) {}
      }
    };
    window.addEventListener("focus", onFocus);
    // 앱 종료 전 디바운스 큐 강제 flush
    const onBeforeUnload = () => gcal.forceFlush();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    const key = todayKey();
    updateData((d) => {
      if (!d.events) d.events = [];
      if (!d.scheduled) d.scheduled = {};

      // ── Ghost 이벤트 정리: GCal에서 잘못 import된 "(완료)" 이벤트 제거 ──
      // 앱에서 push한 업무가 매핑 유실로 독립일정으로 재import된 경우
      const allTaskNames = new Set();
      for (const p of (d.projects || [])) {
        const collect = (arr) => { for (const t of arr) { if (t.name) allTaskNames.add(t.name); if (t.children) collect(t.children); } };
        collect(p.subtasks || []);
      }
      const ghostIds = [];
      for (const ev of d.events) {
        if (ev.deleted) continue;
        if (!ev.gcalSourceId) continue; // import된 이벤트만 (gcalSourceId가 있음)
        const cleanName = (ev.name || "").replace(/^\(완료\)\s*/, "");
        if (allTaskNames.has(cleanName)) ghostIds.push(ev.id);
      }
      if (ghostIds.length > 0) {
        const ghostSet = new Set(ghostIds);
        d.events = d.events.filter((e) => !ghostSet.has(e.id));
        d.todayTasks = d.todayTasks.filter((t) => !ghostSet.has(t.taskId));
        console.log(`[Startup] Ghost 이벤트 ${ghostIds.length}건 정리됨`);
      }

      // ── 날짜 변경 정리: 어제 이전의 완료된 작업만 제거 ──
      d.todayTasks = d.todayTasks.filter((t) => !t.completed);

      // ── scheduled에서 이미 완료된(done) 태스크 정리 (잔류 방어) ──
      if (d.scheduled) {
        for (const [dk, items] of Object.entries(d.scheduled)) {
          const completedIds = new Set(
            (d.completedToday?.[dk] || []).map((c) => c.taskId)
          );
          const filtered = items.filter((s) => {
            // completedToday에 있으면 제거
            if (completedIds.has(s.taskId)) return false;
            // 프로젝트 서브태스크의 done 확인
            if (s.projectId && s.projectId !== "recurring" && s.projectId !== "event") {
              const proj = d.projects.find((p) => p.id === s.projectId);
              if (proj) {
                const task = findTaskById(proj.subtasks || [], s.taskId);
                if (task?.done) return false;
              }
            }
            return true;
          });
          if (filtered.length === 0) delete d.scheduled[dk];
          else d.scheduled[dk] = filtered;
        }
      }

      // ── 오늘의 이벤트를 todayTasks에 추가 ──
      const todayEvents = d.events.filter((e) => e.date === key && !e.deleted);
      for (const ev of todayEvents) {
        if (!d.todayTasks.some((t) => t.taskId === ev.id)) {
          d.todayTasks.push({ projectId: "event", taskId: ev.id, completed: false, addedDate: key, updatedAt: Date.now() });
        }
      }

      // ── 오늘의 예약 작업을 todayTasks에 추가 ──
      const todayScheduled = d.scheduled[key] || [];
      for (const s of todayScheduled) {
        if (!d.todayTasks.some((t) => t.taskId === s.taskId)) {
          d.todayTasks.push({ projectId: s.projectId, taskId: s.taskId, completed: false, addedDate: key, time: s.time || "", updatedAt: Date.now() });
        }
      }

      // ── 오늘 완료된 업무를 completedToday에서 복원 ──
      const todayCompleted = d.completedToday?.[key] || [];
      for (const c of todayCompleted) {
        if (!d.todayTasks.some((t) => t.taskId === c.taskId)) {
          d.todayTasks.push({ projectId: c.projectId, taskId: c.taskId, completed: true, completedAt: c.completedAt || "", addedDate: key, updatedAt: Date.now() });
        }
      }
    });
  }, [loaded]);

  return {
    data, setData, loaded, updateData,
    themeKey, setThemeKey,
    miniSettings, setMiniSettings,
    calendarRange, setCalendarRange,
    windowMode, setWindowMode,
    agreedTerms, setAgreedTerms,
  };
}
