import { DAYS_KR } from "../constants";

export default function Calendar({ ctx }) {
  const {
    T, calYear, calMonth, selectedDay, setSelectedDay,
    calDays, prevMonth, nextMonth, isTodayDate,
    getCompForDay, getScheduledForDay, getRecurringForDay, getTodayTasksForDay,
    getEventsForDay, deleteEvent, convertEventToSubtask,
    activeProjects, setModal,
    getColorForProjectId, completeForDate, uncompleteForDate,
    removeFromToday, deleteScheduled, skipRecurringForDate, handleCalendarDoubleClick,
    calendarRange,
  } = ctx;

  const CheckBox = ({ done, onClick }) => (
    <div onClick={onClick} style={{ width: 24, height: 24, borderRadius: 8, border: done ? undefined : `2.5px solid ${T.textMut}`, background: done ? "linear-gradient(135deg,#10b981,#059669)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer", transition: "all .15s" }}>
      {done && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>}
    </div>
  );

  // 단일 날짜의 상세 내용 렌더링
  const renderDayDetail = (year, month, day, showHeader, hidePastComp = false) => {
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
    const dayEvents = getEventsForDay(day, year, month).filter((e) => !dayTodayIds.has(e.id) && !dayCompIds.has(e.id));

    // 날짜 범위 모드의 지난 날만 완료 항목 숨기기
    const visibleComp = (isPast && hidePastComp) ? [] : dayComp;

    const hasContent = dayEvents.length > 0 || dayToday.length > 0 || visibleComp.length > 0 || dayRecur.length > 0 || daySched.length > 0;
    if (!hasContent) return null;

    return (
      <div key={dateKey} style={{ marginBottom: calendarRange > 0 ? 20 : 0 }}>
        {showHeader && (
          <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 10, color: isToday ? T.primary : isPast ? T.textMut : T.text, borderBottom: `1px solid ${T.border}`, paddingBottom: 6 }}>
            {year}.{String(month + 1).padStart(2, "0")}.{String(day).padStart(2, "0")} ({DAYS_KR[dateObj.getDay()]})
            {isToday && <span style={{ fontSize: 12, fontWeight: 600, color: T.primary, background: T.primaryLight, padding: "2px 8px", borderRadius: 8, marginLeft: 8 }}>오늘</span>}
            {isPast && hidePastComp && <span style={{ fontSize: 12, fontWeight: 400, color: T.textMut, marginLeft: 8 }}>(미완료만 표시)</span>}
          </h3>
        )}

        {dayEvents.length > 0 && <div style={{ marginBottom: 14 }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: T.accent, marginBottom: 8 }}>★ 독립 일정 <span style={{ fontSize: 12, fontWeight: 400, color: T.textMut }}>(더블클릭하여 프로젝트에 편입)</span></p>
          {dayEvents.map((ev, i) => (
            <div key={i}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (activeProjects.length === 0) {
                  setModal({ type: "alert", message: "활성 프로젝트가 없습니다.\n프로젝트를 먼저 생성해주세요." });
                  return;
                }
                setModal({ type: "convertEvent", eventId: ev.id, eventName: ev.name, eventDate: ev.date });
              }}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, background: T.accent + "15", border: `1px solid ${T.accent}33`, borderLeft: `4px solid ${T.accent}`, marginBottom: 6, cursor: "pointer", transition: "background .15s" }}>
              <CheckBox done={false} onClick={(e) => { e.stopPropagation(); completeForDate(dateKey, { projectId: "event", taskId: ev.id }); }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 15, fontWeight: 600 }}>{ev.name}</p>
                {ev.description && <p style={{ fontSize: 13, color: T.textMut, marginTop: 2 }}>{ev.description}</p>}
                {ev.time && <p style={{ fontSize: 12, color: T.accent, fontWeight: 600, marginTop: 2 }}>{ev.time}</p>}
              </div>
              <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", fontSize: 15, color: T.textMut }} onClick={(e) => { e.stopPropagation(); deleteEvent(ev.id); }}>✕</button>
            </div>
          ))}
        </div>}

        {dayToday.length > 0 && <div style={{ marginBottom: 14 }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: T.warnText, marginBottom: 8 }}>● 오늘 할 일</p>
          {dayToday.map((t, i) => { const pc = getColorForProjectId(t.projectId); return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, background: pc.light + "66", border: `1px solid ${pc.color}33`, borderLeft: `4px solid ${pc.color}`, marginBottom: 6, cursor: "pointer" }} onClick={() => completeForDate(dateKey, { projectId: t.projectId, taskId: t.taskId })}>
              <CheckBox done={false} /><div style={{ flex: 1, minWidth: 0 }}><p style={{ fontSize: 15, fontWeight: 600 }}>{t.taskName}</p><p style={{ fontSize: 13, color: T.textMut }}>{t.projectName}</p></div>
              <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", fontSize: 15, color: T.textMut }} onClick={(e) => { e.stopPropagation(); removeFromToday(t.taskId); }}>✕</button>
            </div>); })}
        </div>}

        {daySched.length > 0 && <div style={{ marginBottom: 14 }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: T.accent, marginBottom: 8 }}>◇ 예약된 업무</p>
          {daySched.map((s, i) => { const pc = getColorForProjectId(s.projectId); return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, background: pc.light + "66", border: `1px solid ${pc.color}33`, borderLeft: `4px solid ${pc.color}`, marginBottom: 6, cursor: "pointer" }} onClick={() => completeForDate(dateKey, { projectId: s.projectId, taskId: s.taskId })}>
              <CheckBox done={false} /><div style={{ flex: 1, minWidth: 0 }}><p style={{ fontSize: 15, fontWeight: 600 }}>{s.taskName}</p><p style={{ fontSize: 13, color: T.textMut }}>{s.projectName}</p></div>
              <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", fontSize: 15, color: T.textMut }} onClick={(e) => { e.stopPropagation(); deleteScheduled(dateKey, s.taskId); }}>✕</button>
            </div>); })}
        </div>}

        {dayRecur.length > 0 && <div style={{ marginBottom: 14 }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: T.primary, marginBottom: 8 }}>↻ 정기 업무</p>
          {dayRecur.map((r, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, background: T.primaryLight + "66", border: `1px solid ${T.primaryLight}`, marginBottom: 6, cursor: "pointer" }} onClick={() => completeForDate(dateKey, { projectId: "recurring", taskId: r.id })}>
              <CheckBox done={false} /><div style={{ flex: 1 }}><p style={{ fontSize: 15, fontWeight: 600 }}>{r.name}</p><p style={{ fontSize: 13, color: T.textMut }}>{r.time || ""} {r.type === "weekly" ? (r.interval === 1 ? "매주" : r.interval === 2 ? "격주" : `${r.interval}주`) : `매월 ${r.dayValue}일`}</p></div>
              <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", fontSize: 15, color: T.textMut }} onClick={(e) => { e.stopPropagation(); skipRecurringForDate(dateKey, r.id); }}>✕</button>
            </div>
          ))}
        </div>}

        {visibleComp.length > 0 && <div style={{ marginBottom: 14 }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: T.doneText, marginBottom: 8 }}>✓ 완료한 일</p>
          {visibleComp.map((t, i) => { const pc = getColorForProjectId(t.projectId); return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, background: T.doneBg + "44", border: `1px solid ${T.doneBg}`, borderLeft: `4px solid ${pc.color}88`, marginBottom: 6, cursor: "pointer", opacity: 0.7 }} onClick={() => uncompleteForDate(dateKey, t.taskId)}>
              <CheckBox done={true} /><div style={{ flex: 1, minWidth: 0 }}><p style={{ fontSize: 15, fontWeight: 600, textDecoration: "line-through", color: T.textMut }}>{t.taskName}</p><p style={{ fontSize: 13, color: T.textMut }}>{t.projectName}</p></div>
              {t.completedAt && <span style={{ fontSize: 12, color: T.textMut, flexShrink: 0, marginLeft: 8 }}>{new Date(t.completedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>}
            </div>); })}
        </div>}
      </div>
    );
  };

  return (
    <div style={{ flex: 1, padding: 24, overflowY: "auto", background: T.calBg, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <button style={{ width: 40, height: 40, border: `1px solid ${T.border}`, background: T.cardBg, borderRadius: 10, cursor: "pointer", fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center", color: T.textSec }} onClick={prevMonth}>◀</button>
        <h2 style={{ fontSize: 20, fontWeight: 700 }}>{calYear}년 {calMonth + 1}월</h2>
        <button style={{ width: 40, height: 40, border: `1px solid ${T.border}`, background: T.cardBg, borderRadius: 10, cursor: "pointer", fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center", color: T.textSec }} onClick={nextMonth}>▶</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3 }}>
        {DAYS_KR.map((d, i) => <div key={d} style={{ textAlign: "center", fontSize: 14, fontWeight: 600, padding: "8px 0", color: i === 0 ? "#ef4444" : i === 6 ? "#3b82f6" : T.textSec }}>{d}</div>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3 }}>
        {calDays().map((day, i) => {
          const comp = getCompForDay(day);
          const recur = getRecurringForDay(day);
          const todayTasks = getTodayTasksForDay(day);
          const sched = getScheduledForDay(day);
          const events = getEventsForDay(day);
          const isSel = selectedDay === day && day !== null;
          const today = isTodayDate(day);
          const todayIds = new Set(todayTasks.map((t) => t.taskId));
          const compIds = new Set(comp.map((c) => c.taskId));
          const filteredSched = sched.filter((s) => !todayIds.has(s.taskId) && !compIds.has(s.taskId));
          const filteredEvents = events.filter((e) => !todayIds.has(e.id) && !compIds.has(e.id));
          const filteredRecur = recur.filter((r) => !compIds.has(r.id));
          const allItems = [
            ...filteredEvents.map((e) => ({ type: "event", name: e.name, pid: "event" })),
            ...todayTasks.map((t) => ({ type: "today", name: t.taskName, pid: t.projectId })),
            ...filteredSched.map((s) => ({ type: "sched", name: s.taskName, pid: s.projectId })),
            ...comp.map((c) => ({ type: "done", name: c.taskName, pid: c.projectId })),
            ...filteredRecur.map((r) => ({ type: "recur", name: r.name, pid: "recurring" })),
          ];
          return (
            <div key={i} onClick={() => day && setSelectedDay(day === selectedDay ? null : day)}
              onDoubleClick={() => handleCalendarDoubleClick(day)}
              style={{
                textAlign: "center", padding: "4px 4px 6px", borderRadius: 10, minHeight: 100,
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start",
                transition: "all .12s", overflow: "hidden",
                background: today && !isSel ? T.primaryLight : "transparent",
                color: i % 7 === 0 ? "#ef4444" : i % 7 === 6 ? "#3b82f6" : T.text,
                cursor: day ? "pointer" : "default", fontWeight: today ? 700 : 400,
                border: today && !isSel ? `2px solid ${T.primary}` : isSel ? `2px solid ${T.primary}` : "2px solid transparent",
              }}>
              {day && (<>
                <span style={{ fontSize: 14, lineHeight: "22px", width: 28, height: 28, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: isSel ? T.primary : "transparent", color: isSel ? "white" : undefined, fontWeight: isSel ? 700 : today ? 700 : 400, transition: "all .15s" }}>{day}</span>
                <div style={{ marginTop: 3, width: "100%", display: "flex", flexDirection: "column", gap: 2 }}>
                  {allItems.slice(0, 3).map((item, ci) => {
                    const pc = (item.pid && item.pid !== "recurring" && item.pid !== "event") ? getColorForProjectId(item.pid) : null;
                    const isDone = item.type === "done";
                    const isRecur = item.type === "recur";
                    let bg, clr;
                    const isEvent = item.type === "event";
                    if (pc) { bg = isDone ? pc.light + "99" : pc.light; clr = isDone ? pc.color + "99" : pc.color; }
                    else if (isRecur) { bg = T.primaryLight; clr = T.primary; }
                    else if (isEvent) { bg = T.accent + "22"; clr = T.accent; }
                    else { bg = isDone ? T.doneBg : T.warnBg; clr = isDone ? T.doneText : T.warnText; }
                    const prefix = isDone ? "✓ " : isRecur ? "↻ " : isEvent ? "★ " : item.type === "sched" ? "◇ " : "● ";
                    return <div key={ci} style={{ fontSize: 11, padding: "2px 4px", borderRadius: 4, background: bg, color: clr, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: "16px", fontWeight: 600 }}>{prefix}{item.name}</div>;
                  })}
                  {allItems.length > 3 && <span style={{ fontSize: 10, color: T.textMut }}>+{allItems.length - 3}</span>}
                </div>
              </>)}
            </div>
          );
        })}
      </div>

      {/* 선택된 날짜 상세 */}
      {selectedDay && (() => {
        const isSelToday = isTodayDate(selectedDay);
        if (calendarRange > 0 && isSelToday) {
          // 날짜 범위 모드
          const centerDate = new Date(calYear, calMonth, selectedDay);
          const groups = [];
          for (let i = -calendarRange; i <= calendarRange; i++) {
            const d = new Date(centerDate);
            d.setDate(d.getDate() + i);
            const result = renderDayDetail(d.getFullYear(), d.getMonth(), d.getDate(), true, true);
            if (result) groups.push(result);
          }
          if (groups.length === 0) {
            return <div style={{ marginTop: 20, animation: "fadeIn .2s ease" }}><p style={{ fontSize: 15, color: T.textMut }}>이 기간의 내역이 없습니다</p></div>;
          }
          return <div style={{ marginTop: 20, animation: "fadeIn .2s ease" }}>{groups}</div>;
        } else {
          // 단일 날짜 모드
          const selKey = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(selectedDay).padStart(2, "0")}`;
          const result = renderDayDetail(calYear, calMonth, selectedDay, false);
          if (result) {
            return (
              <div style={{ marginTop: 20, animation: "fadeIn .2s ease" }}>
                <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 14, color: T.text }}>
                  {calYear}.{String(calMonth + 1).padStart(2, "0")}.{String(selectedDay).padStart(2, "0")} ({DAYS_KR[new Date(calYear, calMonth, selectedDay).getDay()]})
                </h3>
                {result}
              </div>
            );
          }
          return (
            <div style={{ marginTop: 20, animation: "fadeIn .2s ease" }}>
              <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 14, color: T.text }}>
                {calYear}.{String(calMonth + 1).padStart(2, "0")}.{String(selectedDay).padStart(2, "0")} ({DAYS_KR[new Date(calYear, calMonth, selectedDay).getDay()]})
              </h3>
              <p style={{ fontSize: 15, color: T.textMut }}>이 날의 내역이 없습니다</p>
            </div>
          );
        }
      })()}
    </div>
  );
}
