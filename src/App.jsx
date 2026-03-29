import { useState, useRef, useEffect, useCallback } from "react";
import { DAYS_KR, isElectron } from "./constants";
import useTaskData from "./hooks/useTaskData";
import gcal from "./hooks/gcalHelper";

// 컴포넌트
import ResizeEdges from "./components/ResizeEdges";
import WinControls from "./components/WinControls";
import GlobalCSS from "./components/GlobalCSS";
import MiniToday from "./components/MiniToday";
import MiniCalendar from "./components/MiniCalendar";
import Calendar from "./components/Calendar";
import Sidebar from "./components/Sidebar";

// 모달
import SettingsModal from "./components/modals/SettingsModal";
import CalendarEventForm from "./components/modals/CalendarEventForm";
import { ProjectForm, SubtaskForm, EditTaskForm, RecurringForm, ConvertEventForm, QuickTaskForm } from "./components/modals/FormComponents";

// ── 약관 동의 화면 ──
function TermsAgreement({ onAgree }) {
  const [checked, setChecked] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "'Noto Sans KR',sans-serif", background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)" }}>
      <div style={{ background: "#fff", borderRadius: 20, padding: "40px 36px", width: 460, maxWidth: "90vw", boxShadow: "0 20px 60px rgba(0,0,0,0.2)", textAlign: "center" }}>
        <img src="./TaskNote-icon.png" alt="TaskNote" style={{ width: 64, height: 64, borderRadius: 14, marginBottom: 16 }} />
        <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1a1a1a", marginBottom: 6 }}>TaskNote에 오신 것을 환영합니다</h1>
        <p style={{ fontSize: 14, color: "#888", marginBottom: 28 }}>서비스 이용을 위해 약관에 동의해 주세요</p>

        <div style={{ textAlign: "left", marginBottom: 20 }}>
          <a href="https://skedit-tasknote.online/privacy-policy.html" target="_blank" rel="noopener noreferrer"
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", background: "#f8f9fa", borderRadius: 12, marginBottom: 8, textDecoration: "none", color: "#1a1a1a", fontSize: 14, fontWeight: 600, border: "1px solid #e5e5e5", cursor: "pointer" }}>
            📄 개인정보처리방침 (Privacy Policy)
            <span style={{ fontSize: 12, color: "#999" }}>보기 →</span>
          </a>
          <a href="https://skedit-tasknote.online/terms-of-service.html" target="_blank" rel="noopener noreferrer"
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", background: "#f8f9fa", borderRadius: 12, textDecoration: "none", color: "#1a1a1a", fontSize: 14, fontWeight: 600, border: "1px solid #e5e5e5", cursor: "pointer" }}>
            📋 서비스 이용약관 (Terms of Service)
            <span style={{ fontSize: 12, color: "#999" }}>보기 →</span>
          </a>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: checked ? "#f0f4ff" : "#f8f9fa", border: `1.5px solid ${checked ? "#667eea" : "#e5e5e5"}`, borderRadius: 12, cursor: "pointer", marginBottom: 20, transition: "all .2s" }}>
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)}
            style={{ width: 18, height: 18, accentColor: "#667eea", cursor: "pointer" }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: checked ? "#4a5dc7" : "#666" }}>
            개인정보처리방침 및 서비스 이용약관에 동의합니다
          </span>
        </label>

        <button onClick={onAgree} disabled={!checked}
          style={{ width: "100%", padding: "14px 0", border: "none", borderRadius: 12, fontSize: 16, fontWeight: 700, color: "#fff", cursor: checked ? "pointer" : "not-allowed", background: checked ? "linear-gradient(135deg, #667eea, #764ba2)" : "#ccc", transition: "all .2s", boxShadow: checked ? "0 4px 16px rgba(102,126,234,0.4)" : "none" }}>
          시작하기
        </button>
      </div>
    </div>
  );
}

export default function TaskManager() {
  const ctx = useTaskData();
  const {
    loaded, T, data, modal, setModal, themeKey, setThemeKey,
    isDark, toggleTheme,
    miniMode, isLocked, sideTab,
    activeProject, activeProjects,
    handleLock, handleMiniMode, handleMinimize, handleMaximize, handleClose,
    addProject, editProject, addSubtask, editSubtask, editSubtaskDesc, editSubtaskTime,
    addEvent, addEventAsSubtask, convertEventToSubtask, fetchGcalEvents,
    addRecurring, editRecurring, td, calendarRange, setCalendarRange,
    windowMode, handleWindowMode,
    agreedTerms, setAgreedTerms,
  } = ctx;

  // ── 동기화 버튼 쿨타임 (15초) ──
  const [syncCooldown, setSyncCooldown] = useState(false);
  const handleSyncClick = useCallback(async () => {
    if (syncCooldown) return;
    setSyncCooldown(true);
    // 1. 파일 동기화 (디스크에서 최신 데이터 읽어서 병합)
    if (isElectron && window.electronAPI.loadAppData) {
      try {
        const diskData = await window.electronAPI.loadAppData();
        if (diskData && diskData.lastUpdated) {
          ctx.setData((prev) => {
            if ((diskData.lastUpdated || 0) > (prev.lastUpdated || 0)) {
              return { ...prev, ...diskData };
            }
            return prev;
          });
        }
      } catch (e) { console.error('[Sync] 파일 동기화 실패:', e); }
    }
    // 2. GCal 동기화
    gcal.syncExisting(data);
    gcal.flushOfflineQueue();
    fetchGcalEvents();
    setTimeout(() => setSyncCooldown(false), 15000);
  }, [syncCooldown, fetchGcalEvents, data, ctx]);

  const [widgetOpen, setWidgetOpen] = useState(false);
  const widgetRef = useRef(null);
  useEffect(() => {
    if (!widgetOpen) return;
    const h = (e) => { if (widgetRef.current && !widgetRef.current.contains(e.target)) setWidgetOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [widgetOpen]);

  if (!loaded) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "'Noto Sans KR',sans-serif", color: "#aaa", fontSize: 18 }}>
        불러오는 중...
      </div>
    );
  }

  // ── 약관 동의 확인 ──
  if (!agreedTerms) {
    return <TermsAgreement onAgree={() => setAgreedTerms(true)} />;
  }

  // ── 위젯 모드 ──
  if (miniMode === "today") return <MiniToday ctx={ctx} />;
  if (miniMode === "calendar") return <MiniCalendar ctx={ctx} />;

  // ── 전체 모드 ──
  return (
    <div style={{ fontFamily: "'Noto Sans KR',sans-serif", background: T.bgGrad, height: "100vh", color: T.text, display: "flex", flexDirection: "column", borderRadius: 12, position: "relative", overflow: "hidden", border: `1px solid ${T.border}`, boxSizing: "border-box" }}>
      <ResizeEdges />
      <GlobalCSS T={T} />

      {/* 커스텀 타이틀바 + 헤더 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 0 0 10px", background: T.headerBg, backdropFilter: "blur(20px)", borderBottom: `1px solid ${T.border}`, flexShrink: 0, zIndex: 100, WebkitAppRegion: "drag" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "5px 0", WebkitAppRegion: "no-drag" }}>
          <img src="./TaskNote-icon.png" alt="TaskNote" style={{ width: 38, height: 38, borderRadius: 10, objectFit: "contain" }} />
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>TaskNote</h1>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 4, WebkitAppRegion: "no-drag" }}>
          <span style={{ fontSize: 14, color: T.textSec, fontWeight: 500, marginRight: 4 }}>{td.getFullYear()}년 {td.getMonth() + 1}월 {td.getDate()}일 ({DAYS_KR[td.getDay()]})</span>

          {/* Google Calendar 동기화 (15초 쿨타임) */}
          <button onClick={handleSyncClick} disabled={syncCooldown} title={syncCooldown ? "동기화 대기 중..." : "Google Calendar 동기화"} style={{ width: 34, height: 34, border: `1px solid ${T.border}`, background: T.cardBg, borderRadius: 8, cursor: syncCooldown ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: T.textSec, transition: "opacity .3s", marginRight: 4, opacity: syncCooldown ? 0.35 : 1, pointerEvents: syncCooldown ? "none" : "auto" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M23 4v6h-6" /><path d="M1 20v-6h6" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10" /><path d="M20.49 15a9 9 0 01-14.85 3.36L1 14" /></svg>
          </button>

          {/* 다크/라이트 모드 토글 */}
          <button onClick={toggleTheme} title={isDark ? "라이트 모드" : "다크 모드"} style={{ width: 34, height: 34, border: `1px solid ${T.border}`, background: T.cardBg, borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: T.textSec, transition: "transform .15s" }}>
            {isDark ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
            )}
          </button>

          {/* 설정 */}
          <button onClick={() => setModal({ type: "settings" })} title="설정" style={{ width: 34, height: 34, border: `1px solid ${T.border}`, background: T.cardBg, borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: T.textSec }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" /></svg>
          </button>
          <button onClick={handleLock} title={isLocked ? "잠금 해제" : "위치 잠금"} style={{ width: 34, height: 34, border: `1px solid ${T.border}`, background: isLocked ? T.surfaceBg : T.cardBg, borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: isLocked ? T.textSec : T.textMut }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2" />{isLocked ? <path d="M7 11V7a5 5 0 0110 0v4" /> : <path d="M7 11V7a5 5 0 019.9-1" />}</svg>
          </button>
          <div style={{ width: 1, height: 24, background: T.border, margin: "0 2px" }} />
          <div ref={widgetRef} style={{ position: "relative" }}>
            <button onClick={() => setWidgetOpen(!widgetOpen)} style={{ padding: "0 12px", height: 34, border: `1px solid ${widgetOpen ? T.primary : T.border}`, background: widgetOpen ? T.primaryLight : T.cardBg, borderRadius: 8, cursor: "pointer", color: widgetOpen ? T.primary : T.textSec, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
              위젯 모드
            </button>
            {widgetOpen && (
              <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, background: T.cardBg, border: `1px solid ${T.border}`, borderRadius: 10, padding: 6, boxShadow: `0 4px 16px ${T.text}18`, zIndex: 999, minWidth: 160, animation: "fadeIn .15s ease" }}>
                <p style={{ fontSize: 11, fontWeight: 700, color: T.textMut, padding: "4px 10px 6px", margin: 0 }}>위젯 모드</p>
                <button onClick={() => { handleMiniMode("today"); setWidgetOpen(false); }} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: "none", background: "transparent", borderRadius: 7, cursor: "pointer", color: T.text, fontSize: 13, fontWeight: 500, transition: "background .1s" }}
                  onMouseEnter={(e) => e.currentTarget.style.background = T.surfaceBg}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={T.accent} strokeWidth="2"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" /></svg>
                  오늘 할 일
                </button>
                <button onClick={() => { handleMiniMode("calendar"); setWidgetOpen(false); }} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: "none", background: "transparent", borderRadius: 7, cursor: "pointer", color: T.text, fontSize: 13, fontWeight: 500, transition: "background .1s" }}
                  onMouseEnter={(e) => e.currentTarget.style.background = T.surfaceBg}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={T.primary} strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                  캘린더
                </button>
              </div>
            )}
          </div>
          <div style={{ width: 1, height: 24, background: T.border, margin: "0 2px" }} />
          <WinControls T={T} handleMinimize={handleMinimize} handleMaximize={handleMaximize} handleClose={handleClose} />
        </div>
      </div>

      {/* MAIN */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <Calendar ctx={ctx} />
        <Sidebar ctx={ctx} />
      </div>

      {/* MODAL */}
      {modal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
          <div style={{ background: T.cardBg, borderRadius: 16, padding: 28, width: modal.type === "settings" ? 580 : 480, maxWidth: "90vw", boxShadow: "0 20px 60px rgba(0,0,0,0.15)", animation: "modalIn .2s ease", color: T.text }}>

            {modal.type === "alert" && (
              <div>
                <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>⚠️ 알림</h3>
                <p style={{ fontSize: 15, color: T.text, lineHeight: "24px", whiteSpace: "pre-wrap" }}>{modal.message}</p>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 24 }}>
                  <button style={{ padding: "10px 28px", border: "none", background: `linear-gradient(135deg,${T.primary},${T.accent})`, color: "white", borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 600 }} onClick={() => setModal(null)}>확인</button>
                </div>
              </div>
            )}

            {modal.type === "confirm" && (
              <div>
                <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>확인</h3>
                <p style={{ fontSize: 15, color: T.text, lineHeight: "24px", whiteSpace: "pre-wrap" }}>{modal.message}</p>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 24 }}>
                  <button style={{ padding: "10px 22px", border: `1px solid ${T.border}`, background: T.cardBg, borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 500, color: T.textSec }} onClick={() => setModal(null)}>취소</button>
                  <button style={{ padding: "10px 22px", border: "none", background: "#ef4444", color: "white", borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 600 }} onClick={modal.onConfirm}>삭제</button>
                </div>
              </div>
            )}

            {modal.type === "settings" && <SettingsModal onClose={() => setModal(null)} T={T} calendarRange={calendarRange} onRangeChange={setCalendarRange} windowMode={windowMode} onWindowModeChange={handleWindowMode} onDataReload={(newData) => { if (newData) ctx.setData(newData); }} />}

            {modal.type === "addCalendarEvent" && (
              <CalendarEventForm
                dateKey={modal.dateKey} dateLabel={modal.dateLabel} projects={activeProjects}
                quickTasks={data.quickTasks}
                existingEvents={(data.events || []).filter((e) => e.date === modal.dateKey)}
                onAddIndependent={(name, desc, time, endTime) => { addEvent(name, desc, modal.dateKey, time, endTime); setModal(null); }}
                onAddToProject={(projectId, name, desc, time, endTime) => { addEventAsSubtask(projectId, name, desc, modal.dateKey, time, endTime); setModal(null); }}
                onScheduleQuick={(qtId) => { ctx.scheduleQuickTask(qtId, modal.dateKey); setModal(null); }}
                onCancel={() => setModal(null)} T={T}
              />
            )}

            {(modal.type === "addProject" || modal.type === "editProject") && (
              <ProjectForm initial={modal.project} onSubmit={(n, d, c) => { modal.type === "addProject" ? addProject(n, d, c) : editProject(modal.project.id, n, d, c); setModal(null); }} onCancel={() => setModal(null)} T={T} />
            )}
            {modal.type === "addSubtask" && <SubtaskForm parentId={modal.parentId} onSubmit={(n, desc, time, endTime) => { addSubtask(activeProject, n, modal.parentId, desc, time, endTime); setModal(null); }} onCancel={() => setModal(null)} T={T} />}
            {modal.type === "editTask" && <EditTaskForm currentName={modal.currentName} currentDesc={modal.currentDesc} currentTime={modal.currentTime} currentEndTime={modal.currentEndTime} onSubmit={(name, desc, time, endTime) => { editSubtask(modal.projectId, modal.taskId, name); editSubtaskDesc(modal.projectId, modal.taskId, desc); editSubtaskTime(modal.projectId, modal.taskId, time, endTime); setModal(null); }} onCancel={() => setModal(null)} T={T} />}

            {modal.type === "addRecurring" && <RecurringForm type={modal.recurType} onSubmit={(n, dv, time, intv, sd, ed, monthlyOpts) => { addRecurring(n, modal.recurType, dv, time, intv, sd, ed, monthlyOpts); setModal(null); }} onCancel={() => setModal(null)} T={T} />}
            {modal.type === "editRecurring" && <RecurringForm type={modal.recurring.type} initial={modal.recurring} onSubmit={(n, dv, time, intv, sd, ed, monthlyOpts) => { editRecurring(modal.recurring.id, n, dv, time, intv, sd, ed, monthlyOpts); setModal(null); }} onCancel={() => setModal(null)} T={T} />}

            {modal.type === "addQuickTask" && <QuickTaskForm onSubmit={(n, desc, time, endTime) => { ctx.addQuickTask(n, desc, time, endTime); setModal(null); }} onCancel={() => setModal(null)} T={T} />}
            {modal.type === "editQuickTask" && <QuickTaskForm initial={modal.quickTask} onSubmit={(n, desc, time, endTime) => { ctx.editQuickTask(modal.quickTask.id, n, desc, time, endTime); setModal(null); }} onCancel={() => setModal(null)} T={T} />}

            {modal.type === "editQuickEventTime" && (() => {
              const [t, setT] = [modal._time ?? modal.currentTime, (v) => { modal._time = v; setModal({...modal}); }];
              const [et, setET] = [modal._endTime ?? modal.currentEndTime, (v) => { modal._endTime = v; setModal({...modal}); }];
              return (
                <div>
                  <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>⚡ 퀵 일정 시간 변경</h3>
                  <p style={{ fontSize: 15, color: T.textSec, marginBottom: 20 }}>{modal.eventName}</p>
                  <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 13, fontWeight: 600, color: T.textSec, marginBottom: 6, display: "block" }}>시작 시간</label>
                      <input type="time" defaultValue={modal.currentTime || modal.defaultTime} onChange={(e) => { modal._time = e.target.value; }} style={{ width: "100%", padding: "10px 12px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 15, fontFamily: "inherit", background: T.cardBg, color: T.text }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 13, fontWeight: 600, color: T.textSec, marginBottom: 6, display: "block" }}>종료 시간</label>
                      <input type="time" defaultValue={modal.currentEndTime || modal.defaultEndTime} onChange={(e) => { modal._endTime = e.target.value; }} style={{ width: "100%", padding: "10px 12px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 15, fontFamily: "inherit", background: T.cardBg, color: T.text }} />
                    </div>
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    <button style={{ padding: "10px 22px", border: `1px solid ${T.border}`, background: T.cardBg, borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 500, color: T.textSec }} onClick={() => setModal(null)}>취소</button>
                    <button style={{ padding: "10px 22px", border: "none", background: `linear-gradient(135deg,#f59e0b,#d97706)`, color: "white", borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 600 }} onClick={() => {
                      const timeEl = document.querySelector('input[type="time"]');
                      const endEl = document.querySelectorAll('input[type="time"]')[1];
                      ctx.updateEventTime(modal.eventId, timeEl?.value || "", endEl?.value || "");
                      setModal(null);
                    }}>저장</button>
                  </div>
                </div>
              );
            })()}

            {modal.type === "convertEvent" && (
              <ConvertEventForm
                eventName={modal.eventName}
                projects={activeProjects}
                onSubmit={(pid) => { convertEventToSubtask(modal.eventId, pid); setModal(null); }}
                onCancel={() => setModal(null)}
                T={T}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
