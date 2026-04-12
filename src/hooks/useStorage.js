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
  const initialLoadDoneRef = useRef(false); // 초기 로드 완료 플래그 (save-back 방지)

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
              await window.electronAPI.saveAppData(migrated);
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

    // 초기 로드 시 save-back 방지: 첫 로드 완료 직후의 data 변경은 저장하지 않음
    // (구 데이터에 새 timestamp를 부여하여 sync.json을 덮어쓰는 문제 방지)
    if (!initialLoadDoneRef.current) {
      initialLoadDoneRef.current = true;
      return;
    }

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
      const payload = { ...d, lastUpdated: ts };
      const t0 = performance.now();
      return window.electronAPI.saveAppData(payload).then((result) => {
        const t1 = performance.now();
        if (t1 - t0 > 100) console.log(`[perf] save IPC: ${Math.round(t1 - t0)}ms`);
        if (result?.merged) {
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
      return window.electronAPI.saveSettings(s);
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

      // 2. 날짜 키 기반 객체 병합 (scheduled, completedToday)
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
      merged.scheduled = mergeDateKeyed(local.scheduled, remote.scheduled);
      merged.completedToday = mergeDateKeyed(local.completedToday, remote.completedToday);
      merged.lastUpdated = Math.max(local.lastUpdated || 0, remote.lastUpdated || 0);
      return merged;
    };

    window.electronAPI.onExternalDataChanged((newData) => {
      if (!newData) return;
      const normalized = { ...defaultData, ...migrateToNormalizedData(newData) };

      if (dataDirtyRef.current) {
        // 미저장 변경이 있는 동안 외부 변경 수신 → 병합하여 양쪽 보존
        console.log('[Sync] 미저장 변경 중 외부 변경 수신 → 병합');
        setData((prev) => {
          const merged = mergeOnRenderer(prev, normalized);
          merged.lastUpdated = Date.now();
          lastSavedTimestampRef.current = merged.lastUpdated;
          return merged;
        });
        // externalUpdateRef를 설정하지 않음 → 병합 결과가 저장되어야 함
        dataDirtyRef.current = true; // 디바운스 타이머가 곧 flushData 발동
      } else {
        // 깨끗한 상태 → 기존대로 전체 교체
        externalUpdateRef.current = true;  // 저장 루프 방지
        setData((prev) => {
          if ((newData.lastUpdated || 0) >= (prev.lastUpdated || 0)) {
            lastSavedTimestampRef.current = newData.lastUpdated || 0;
            return normalized;
          }
          return prev;
        });
      }
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

      // ── 중복 import 이벤트 정리: 같은 gcalSourceId를 가진 이벤트가 여러 개면 하나만 유지 ──
      const gcalSourceGroups = new Map();
      for (const ev of d.events) {
        if (ev.deleted || !ev.gcalSourceId) continue;
        if (!gcalSourceGroups.has(ev.gcalSourceId)) gcalSourceGroups.set(ev.gcalSourceId, []);
        gcalSourceGroups.get(ev.gcalSourceId).push(ev);
      }
      const duplicateIds = [];
      for (const [, group] of gcalSourceGroups) {
        if (group.length <= 1) continue;
        // 가장 최근 것만 유지, 나머지 제거
        group.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        for (let i = 1; i < group.length; i++) duplicateIds.push(group[i].id);
      }
      if (duplicateIds.length > 0) {
        const dupSet = new Set(duplicateIds);
        d.events = d.events.filter((e) => !dupSet.has(e.id));
        for (const [dk, items] of Object.entries(d.completedToday || {})) {
          d.completedToday[dk] = items.filter((c) => !dupSet.has(c.taskId));
        }
        console.log(`[Startup] 중복 import 이벤트 ${duplicateIds.length}건 정리됨`);
      }

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

      // ── completedToday → 프로젝트 서브태스크 done 상태 동기화 ──
      // completedToday에 완료 기록이 있지만 서브태스크의 done=false인 경우 복구
      let reconciledCount = 0;
      for (const [dk, items] of Object.entries(d.completedToday || {})) {
        for (const c of items) {
          if (!c.projectId || c.projectId === "recurring" || c.projectId === "event") continue;
          const p = (d.projects || []).find((x) => x.id === c.projectId && !x.deleted);
          if (!p) continue;
          const st = findTaskById(p.subtasks || [], c.taskId);
          if (st && !st.done) {
            st.done = true;
            st.updatedAt = Date.now();
            p.updatedAt = Date.now();
            reconciledCount++;
          }
        }
      }
      if (reconciledCount > 0) {
        console.log(`[Startup] completedToday ↔ subtask.done 불일치 ${reconciledCount}건 복구`);
      }

      // todayTasks 필드가 남아있으면 제거 (마이그레이션)
      delete d.todayTasks;
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
