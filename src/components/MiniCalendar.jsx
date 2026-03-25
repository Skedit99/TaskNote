import { DAYS_KR } from "../constants";
import ResizeEdges from "./ResizeEdges";
import WinControls from "./WinControls";
import GlobalCSS from "./GlobalCSS";

export default function MiniCalendar({ ctx }) {
  const {
    data, T, isHovered, bgOpacity, cardOpacity, showControls, isLocked,
    calYear, calMonth, calPanelHeight, setCalPanelHeight,
    selectedDay, setSelectedDay, calDays, prevMonth, nextMonth,
    isTodayDate, getCompForDay, getScheduledForDay, getRecurringForDay, getTodayTasksForDay,
    getEventsForDay, getHolidayForDay,
    getColorForProjectId, completeForDate, uncompleteForDate,
    handleLock, handleMiniMode, handleBgOpacity, handleCardOpacity,
    handleMinimize, handleClose, setShowControls, handleCalendarDoubleClick,
    onMouseEnter, onMouseLeave,
    pendingToday, doneToday, calendarRange,
  } = ctx;

  const hv = isHovered;
  const P = 10;
  const totalCells = calDays().length;
  const calRows = Math.ceil(totalCells / 7);
  const td = new Date();
  const todayDay = td.getDate();
  const todayMonth = td.getMonth();
  const todayYear = td.getFullYear();

  // 표시할 기준 날짜 (선택된 날 또는 오늘)
  const displayDay = selectedDay || todayDay;
  const isShowingToday = !selectedDay;

  // 진행률 계산 (오늘 완료한 것만 카운트)
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayDone = doneToday.filter((t) => t.completedAt && t.completedAt.slice(0, 10) === todayStr);
  const totalTasks = pendingToday.length + todayDone.length;
  const progressPct = totalTasks > 0 ? Math.round((todayDone.length / totalTasks) * 100) : 0;

  return (
    <div onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
      style={{ fontFamily: "'Noto Sans KR',sans-serif", height: "100vh", color: T.text, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      <ResizeEdges />
      <GlobalCSS T={T} />

      {/* 상단 설정바 */}
      <div style={{
        flexShrink: 0, position: "relative", zIndex: 3, WebkitAppRegion: "drag",
        background: hv ? T.headerBg : "transparent", backdropFilter: hv ? "blur(12px)" : "none",
        borderRadius: "12px 12px 0 0", borderBottom: hv ? `1px solid ${T.border}` : "1px solid transparent",
        transition: "background .3s, border-color .3s",
      }}>
        <div style={{ opacity: hv ? 1 : 0, pointerEvents: hv ? "auto" : "none", transition: "opacity .25s" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `6px ${P}px 4px` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <img src="./TaskNote-icon.png" alt="TaskNote" style={{ width: 28, height: 28, borderRadius: 7, objectFit: "contain" }} />
              <span style={{ fontSize: 15, fontWeight: 700 }}>캘린더</span>
            </div>
            <div style={{ display: "flex", gap: 1, alignItems: "center", WebkitAppRegion: "no-drag" }}>
              <button onClick={handleLock} style={{ width: 28, height: 28, border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: isLocked ? T.textSec : T.textMut, opacity: isLocked ? 1 : 0.5 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2" />{isLocked ? <path d="M7 11V7a5 5 0 0110 0v4" /> : <path d="M7 11V7a5 5 0 019.9-1" />}</svg>
              </button>
              <button onClick={() => setShowControls(!showControls)} style={{ width: 28, height: 28, border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: showControls ? T.primary : T.textMut }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="3" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg>
              </button>
              <button onClick={() => handleMiniMode("today")} title="오늘 할 일 위젯" style={{ width: 28, height: 28, border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: T.textMut }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" /></svg>
              </button>
              <button onClick={() => handleMiniMode(false)} title="메인 화면" style={{ width: 28, height: 28, border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: T.primary }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
              </button>
              <WinControls mini T={T} handleMinimize={handleMinimize} handleMaximize={() => {}} handleClose={handleClose} />
            </div>
          </div>
          {showControls && (
            <div style={{ padding: `2px ${P + 2}px 6px`, display: "flex", flexDirection: "column", gap: 4, WebkitAppRegion: "no-drag" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ fontSize: 11, color: T.textSec, width: 28 }}>배경</span><input type="range" min="0" max="1" step="0.05" value={bgOpacity} onChange={(e) => handleBgOpacity(e.target.value)} style={{ flex: 1, cursor: "pointer" }} /><span style={{ fontSize: 11, color: T.textSec, width: 30, textAlign: "right" }}>{Math.round(bgOpacity * 100)}%</span></div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ fontSize: 11, color: T.textSec, width: 44, flexShrink: 0 }}>완료 목록</span><input type="range" min="0.3" max="1" step="0.05" value={cardOpacity} onChange={(e) => handleCardOpacity(e.target.value)} style={{ flex: 1, cursor: "pointer" }} /><span style={{ fontSize: 11, color: T.textSec, width: 30, textAlign: "right" }}>{Math.round(cardOpacity * 100)}%</span></div>
            </div>
          )}
        </div>
      </div>

      {/* 콘텐츠 영역 */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative", borderRadius: hv ? "0 0 12px 12px" : 12, transition: "border-radius .3s" }}>
        {/* 배경 레이어 - bgOpacity만 적용 */}
        <div style={{ position: "absolute", inset: 0, background: T.bgGrad, opacity: bgOpacity, borderRadius: "inherit", pointerEvents: "none", zIndex: 0 }} />

        {/* 상단: 캘린더 */}
        <div style={{ height: calPanelHeight, minHeight: 120, display: "flex", flexDirection: "column", padding: `${P}px ${P}px 0`, position: "relative", zIndex: 1, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexShrink: 0 }}>
            <button style={{ width: 32, height: 32, border: `1px solid ${T.border}`, background: T.cardBg, borderRadius: 8, cursor: "pointer", fontSize: 14, color: T.textSec, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={prevMonth}>◀</button>
            <span style={{ fontSize: 16, fontWeight: 700 }}>{calYear}년 {calMonth + 1}월</span>
            <button style={{ width: 32, height: 32, border: `1px solid ${T.border}`, background: T.cardBg, borderRadius: 8, cursor: "pointer", fontSize: 14, color: T.textSec, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={nextMonth}>▶</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2, flexShrink: 0 }}>
            {DAYS_KR.map((d, i) => <div key={d} style={{ textAlign: "center", fontSize: 12, fontWeight: 600, padding: "4px 0", color: i === 0 ? "#ef4444" : i === 6 ? "#3b82f6" : T.textSec }}>{d}</div>)}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gridTemplateRows: `repeat(${calRows},1fr)`, gap: 2, flex: 1, minHeight: 0 }}>
            {calDays().map((day, i) => {
              const comp = getCompForDay(day);
              const recur = getRecurringForDay(day);
              const sched = getScheduledForDay(day);
              const todayT = getTodayTasksForDay(day);
              const isSel = selectedDay === day && day !== null;
              const today = isTodayDate(day);
              const holiday = getHolidayForDay(day);
              const _tIds = new Set(todayT.map((t) => t.taskId));
              const _cIds = new Set(comp.map((c) => c.taskId));
              const filtSched = sched.filter((s) => !_tIds.has(s.taskId) && !_cIds.has(s.taskId));
              const cnt = comp.length + recur.length + filtSched.length + todayT.length;
              return (
                <div key={i} onClick={() => day && setSelectedDay(day === selectedDay ? null : day)}
                  onDoubleClick={() => handleCalendarDoubleClick(day)}
                  style={{
                    textAlign: "center", padding: "3px 2px", borderRadius: 8, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start",
                    cursor: day ? "pointer" : "default",
                    background: day ? (today && !isSel ? T.primaryLight : T.cardBg) : "transparent",
                    color: (holiday || i % 7 === 0) ? "#ef4444" : i % 7 === 6 ? "#3b82f6" : T.text,
                    fontWeight: today ? 700 : 400,
                    border: holiday && day ? `2px solid #ef4444` : today && !isSel ? `2px solid ${T.primary}` : isSel ? `2px solid ${T.primary}` : "2px solid transparent",
                    opacity: day ? 1 : 0, overflow: "hidden",
                  }}>
                  {day && (<>
                    <span style={{ fontSize: 13, lineHeight: "20px", width: 22, height: 22, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", background: isSel ? T.primary : "transparent", color: isSel ? "white" : holiday ? "#ef4444" : undefined, fontWeight: isSel ? 700 : today ? 700 : 400 }}>{day}</span>
                    {cnt > 0 && <div style={{ display: "flex", gap: 2, marginTop: 1, justifyContent: "center", flexWrap: "wrap" }}>
                      {todayT.length > 0 && <div style={{ width: 5, height: 5, borderRadius: "50%", background: T.warnText }} />}
                      {filtSched.length > 0 && <div style={{ width: 5, height: 5, borderRadius: "50%", background: T.accent }} />}
                      {comp.length > 0 && <div style={{ width: 5, height: 5, borderRadius: "50%", background: T.doneText }} />}
                      {recur.length > 0 && <div style={{ width: 5, height: 5, borderRadius: "50%", background: T.primary }} />}
                    </div>}
                    {holiday && <div style={{ fontSize: 9, color: "#ef4444", fontWeight: 700, lineHeight: "12px", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{holiday}</div>}
                  </>)}
                </div>
              );
            })}
          </div>
        </div>

        {/* 드래그 구분선 */}
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            const startY = e.clientY;
            const startH = calPanelHeight;
            const onMove = (ev) => { setCalPanelHeight(Math.max(120, Math.min(window.innerHeight - 80, startH + ev.clientY - startY))); };
            const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
          style={{ height: 5, flexShrink: 0, cursor: "row-resize", display: "flex", alignItems: "center", justifyContent: "center", position: "relative", zIndex: 2, background: T.key === "dark" ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.7)", borderRadius: 99, margin: `${P}px ${P}px` }}>
          <div style={{ width: 40, height: 2, borderRadius: 99, background: T.primary }} />
        </div>

        {/* 하단: 할일 목록 */}
        <div style={{ flex: 1, overflowY: "auto", padding: P, position: "relative", zIndex: 1 }}>
          {(() => {
            // 날짜별로 태스크 렌더링
            const renderDateGroup = (year, month, day, isOnlyDate, hidePastComp = false) => {
              const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              const dateObj = new Date(year, month, day);
              const now = new Date(); now.setHours(0, 0, 0, 0);
              const isPast = dateObj < now;
              const isToday = dateObj.getTime() === now.getTime();

              const dayComp = getCompForDay(day, year, month);
              const dayCompIds = new Set(dayComp.map((c) => c.taskId));
              const dayToday = getTodayTasksForDay(day, year, month).filter((t) => !dayCompIds.has(t.taskId));
              const dayTodayIds = new Set(dayToday.map((t) => t.taskId));
              const daySched = getScheduledForDay(day, year, month).filter((s) => !dayCompIds.has(s.taskId) && !dayTodayIds.has(s.taskId));
              const dayRecur = getRecurringForDay(day, year, month).filter((r) => !dayCompIds.has(r.id));
              const dayEvents = getEventsForDay(day, year, month).filter((e) => !dayCompIds.has(e.id) && !dayTodayIds.has(e.id));

              const pending = [
                ...dayEvents.map((e) => ({ id: e.id, name: e.name, sub: "독립 일정", isEvent: true, item: { projectId: "event", taskId: e.id } })),
                ...dayToday.map((t) => ({ id: t.taskId, name: t.taskName, sub: t.projectName, item: { projectId: t.projectId, taskId: t.taskId } })),
                ...daySched.map((s) => ({ id: s.taskId, name: s.taskName, sub: s.projectName, item: { projectId: s.projectId, taskId: s.taskId } })),
                ...dayRecur.map((r) => ({ id: r.id, name: r.name, sub: r.type === "weekly" ? "주간" : "월간", item: { projectId: "recurring", taskId: r.id } })),
              ];

              // 날짜 범위 모드의 지난 날만 완료 항목 숨기기
              const visibleComp = (isPast && hidePastComp) ? [] : dayComp;

              if (pending.length === 0 && visibleComp.length === 0) return null;

              const dayLabel = `${month + 1}/${day} (${DAYS_KR[dateObj.getDay()]})`;

              return (
                <div key={dateKey} style={{ marginBottom: calendarRange > 0 ? 10 : 0 }}>
                  {/* 날짜 범위 모드일 때만 날짜 헤더 표시 */}
                  {calendarRange > 0 && (
                    <p style={{
                      fontSize: 13, fontWeight: 700, marginBottom: 4, color: isToday ? T.primary : isPast ? T.textMut : T.text,
                      borderBottom: `1px solid ${T.border}`, paddingBottom: 3,
                    }}>
                      {dayLabel} {isToday && <span style={{ fontSize: 11, fontWeight: 600, color: T.primary, background: T.primaryLight, padding: "1px 6px", borderRadius: 8, marginLeft: 4 }}>오늘</span>}
                    </p>
                  )}
                  {!calendarRange && !isOnlyDate && (
                    <p style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: T.text }}>{dayLabel}</p>
                  )}
                  {pending.map((p, ci) => {
                    const isEv = p.isEvent;
                    const pc = isEv ? { light: T.accent + "22", color: T.accent } : getColorForProjectId(p.item.projectId);
                    return (
                      <div key={ci} style={{ fontSize: 13, padding: "5px 8px", borderRadius: 6, background: pc.light, border: `1px solid ${isEv ? T.accent + "33" : pc.light}`, borderLeft: `3px solid ${pc.color}`, marginBottom: 3, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }} onClick={() => completeForDate(dateKey, p.item)}>
                        <div style={{ width: 16, height: 16, borderRadius: 5, border: "2px solid #9ca3af", flexShrink: 0 }} />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{isEv ? "★ " : ""}{p.name}</span>
                      </div>
                    );
                  })}
                  {visibleComp.map((c, ci) => {
                    const pc = getColorForProjectId(c.projectId);
                    return (
                      <div key={"d" + ci} style={{ fontSize: 13, padding: "5px 8px", borderRadius: 6, background: T.cardBg, border: `1px solid ${T.border}`, borderLeft: `3px solid ${pc.color}88`, marginBottom: 3, display: "flex", alignItems: "center", gap: 6, opacity: cardOpacity * 0.7, transition: "opacity .2s", cursor: "pointer" }} onClick={() => uncompleteForDate(dateKey, c.taskId)}>
                        <div style={{ width: 16, height: 16, borderRadius: 5, background: "linear-gradient(135deg,#10b981,#059669)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                        </div>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, textDecoration: "line-through", color: T.textMut }}>{c.taskName}</span>
                      </div>
                    );
                  })}
                </div>
              );
            };

            const isDispToday = isTodayDate(displayDay);
            if (calendarRange > 0 && isDispToday) {
              // 날짜 범위 모드 (오늘일 때만)
              const centerDate = new Date(calYear, calMonth, displayDay);
              const groups = [];
              for (let i = -calendarRange; i <= calendarRange; i++) {
                const d = new Date(centerDate);
                d.setDate(d.getDate() + i);
                const result = renderDateGroup(d.getFullYear(), d.getMonth(), d.getDate(), false, true);
                if (result) groups.push(result);
              }
              if (groups.length === 0) {
                return <div style={{ textAlign: "center", padding: "20px 10px", color: T.textMut }}><p style={{ fontSize: 13 }}>일정 없음</p></div>;
              }
              return <div style={{ animation: "fadeIn .2s ease" }}>{groups}</div>;
            } else {
              // 단일 날짜 모드 (선택된 날 또는 오늘)
              const result = renderDateGroup(calYear, calMonth, displayDay, calendarRange === 0);
              if (result) {
                return <div style={{ animation: "fadeIn .2s ease" }}>
                  {!selectedDay && <p style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: T.primary }}>오늘 할 일</p>}
                  {selectedDay && <p style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: T.text }}>{calMonth + 1}/{selectedDay} ({DAYS_KR[new Date(calYear, calMonth, selectedDay).getDay()]})</p>}
                  {result}
                </div>;
              }
              return (
                <div style={{ textAlign: "center", padding: "20px 10px", color: T.textMut }}>
                  <p style={{ fontSize: 13 }}>{selectedDay ? "일정 없음" : "오늘 할 일이 없습니다"}</p>
                </div>
              );
            }
          })()}
        </div>

        {/* 진행률 푸터 */}
        <div style={{ padding: `8px ${P + 2}px`, background: T.headerBg, borderTop: `1px solid ${T.border}`, flexShrink: 0, position: "relative", zIndex: 2, borderRadius: "0 0 12px 12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
            <span style={{ fontSize: 11, color: T.textSec }}>오늘 진행률</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: T.primary }}>{progressPct}%</span>
          </div>
          <div style={{ height: 4, background: T.progBg, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", background: `linear-gradient(90deg,${T.primary},${T.accent})`, borderRadius: 3, transition: "width .3s", width: `${progressPct}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}
