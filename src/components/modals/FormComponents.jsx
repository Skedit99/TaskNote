import { useState } from "react";
import { DAYS_KR } from "../../constants";
import { PROJECT_COLORS } from "../../constants/theme";
import { todayKey } from "../../utils/helpers";

export function ProjectForm({ initial, onSubmit, onCancel, T }) {
  const [n, sN] = useState(initial?.name || "");
  const [d, sD] = useState(initial?.deadline || "");
  const [colorId, setColorId] = useState(initial?.colorId || PROJECT_COLORS[0].id);
  const inp = { width: "100%", padding: "12px 16px", border: `1.5px solid ${T.inputBorder}`, borderRadius: 10, fontSize: 16, outline: "none", background: T.surfaceBg, color: T.text };
  return (
    <div>
      <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20 }}>{initial ? "프로젝트 편집" : "새 프로젝트"}</h3>
      <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6 }}>이름</label>
      <input style={inp} value={n} onChange={(e) => sN(e.target.value)} autoFocus placeholder="예: 공모전" />
      <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6, marginTop: 16 }}>프로젝트 색상</label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {PROJECT_COLORS.map((pc) => (
          <button key={pc.id} onClick={() => setColorId(pc.id)}
            style={{ width: 36, height: 36, borderRadius: 10, border: colorId === pc.id ? `3px solid ${pc.color}` : `2px solid ${T.border}`, background: pc.light, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s" }}>
            <div style={{ width: 18, height: 18, borderRadius: 6, background: pc.color }} />
          </button>
        ))}
      </div>
      <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6, marginTop: 16 }}>마감일</label>
      <input style={inp} type="date" value={d} onChange={(e) => sD(e.target.value)} />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 24 }}>
        <button style={{ padding: "10px 22px", border: `1px solid ${T.border}`, background: T.cardBg, borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 500, color: T.textSec }} onClick={onCancel}>취소</button>
        <button style={{ padding: "10px 22px", border: "none", background: `linear-gradient(135deg,${T.primary},${T.accent})`, color: "white", borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 600 }} onClick={() => n.trim() && onSubmit(n.trim(), d, colorId)} disabled={!n.trim()}>{initial ? "저장" : "추가"}</button>
      </div>
    </div>
  );
}

export function SubtaskForm({ parentId, onSubmit, onCancel, T }) {
  const [n, sN] = useState("");
  const [d, sD] = useState("");
  const [time, setTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const inp = { width: "100%", padding: "12px 16px", border: `1.5px solid ${T.inputBorder}`, borderRadius: 10, fontSize: 16, outline: "none", background: T.surfaceBg, color: T.text };
  return (
    <div>
      <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20 }}>{parentId ? "하위 단계 추가" : "세부 업무 추가"}</h3>
      <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6, marginTop: 16 }}>이름</label>
      <input style={inp} value={n} onChange={(e) => sN(e.target.value)} autoFocus placeholder="예: 서론 작성" onKeyDown={(e) => { if (e.key === "Enter" && n.trim()) onSubmit(n.trim(), d, time, endTime); }} />
      <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6, marginTop: 16 }}>시간 (선택)</label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="time" style={{ ...inp, width: "auto", flex: 1 }} value={time} onChange={(e) => setTime(e.target.value)} />
        <span style={{ color: T.textMut, fontSize: 16 }}>~</span>
        <input type="time" style={{ ...inp, width: "auto", flex: 1 }} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        {(time || endTime) && <button onClick={() => { setTime(""); setEndTime(""); }} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: T.textMut, padding: 4 }}>✕</button>}
      </div>
      <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6, marginTop: 16 }}>설명 (선택)</label>
      <textarea style={{ ...inp, minHeight: 80, resize: "vertical" }} value={d} onChange={(e) => sD(e.target.value)} placeholder="메모" />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 24 }}>
        <button style={{ padding: "10px 22px", border: `1px solid ${T.border}`, background: T.cardBg, borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 500, color: T.textSec }} onClick={onCancel}>취소</button>
        <button style={{ padding: "10px 22px", border: "none", background: `linear-gradient(135deg,${T.primary},${T.accent})`, color: "white", borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 600 }} onClick={() => n.trim() && onSubmit(n.trim(), d, time, endTime)} disabled={!n.trim()}>추가</button>
      </div>
    </div>
  );
}

export function EditTaskForm({ currentName, currentDesc, currentTime, currentEndTime, onSubmit, onCancel, T }) {
  const [n, sN] = useState(currentName);
  const [d, sD] = useState(currentDesc);
  const [time, setTime] = useState(currentTime || "");
  const [endTime, setEndTime] = useState(currentEndTime || "");
  const inp = { width: "100%", padding: "12px 16px", border: `1.5px solid ${T.inputBorder}`, borderRadius: 10, fontSize: 16, outline: "none", background: T.surfaceBg, color: T.text };
  return (
    <div>
      <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20 }}>업무 편집</h3>
      <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6, marginTop: 16 }}>업무 이름</label>
      <input style={inp} value={n} onChange={(e) => sN(e.target.value)} autoFocus />
      <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6, marginTop: 16 }}>시간 (선택)</label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="time" style={{ ...inp, width: "auto", flex: 1 }} value={time} onChange={(e) => setTime(e.target.value)} />
        <span style={{ color: T.textMut, fontSize: 16 }}>~</span>
        <input type="time" style={{ ...inp, width: "auto", flex: 1 }} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        {(time || endTime) && <button onClick={() => { setTime(""); setEndTime(""); }} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: T.textMut, padding: 4 }}>✕</button>}
      </div>
      <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6, marginTop: 16 }}>설명 (선택)</label>
      <textarea style={{ ...inp, minHeight: 100, resize: "vertical" }} value={d} onChange={(e) => sD(e.target.value)} placeholder="업무에 대한 메모나 설명" />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 24 }}>
        <button style={{ padding: "10px 22px", border: `1px solid ${T.border}`, background: T.cardBg, borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 500, color: T.textSec }} onClick={onCancel}>취소</button>
        <button style={{ padding: "10px 22px", border: "none", background: `linear-gradient(135deg,${T.primary},${T.accent})`, color: "white", borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 600 }} onClick={() => n.trim() && onSubmit(n.trim(), d, time, endTime)} disabled={!n.trim()}>저장</button>
      </div>
    </div>
  );
}

// 요일 강조 커스텀 달력 컴포넌트
function DayHighlightCalendar({ value, onChange, highlightDow, minDate, T }) {
  const [viewYear, setViewYear] = useState(() => value ? parseInt(value.split("-")[0]) : new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => value ? parseInt(value.split("-")[1]) - 1 : new Date().getMonth());
  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const lastDate = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= lastDate; d++) cells.push(d);
  const prevM = () => { if (viewMonth === 0) { setViewYear(viewYear - 1); setViewMonth(11); } else setViewMonth(viewMonth - 1); };
  const nextM = () => { if (viewMonth === 11) { setViewYear(viewYear + 1); setViewMonth(0); } else setViewMonth(viewMonth + 1); };
  const todayStr = todayKey();
  const fmt = (d) => `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  return (
    <div style={{ background: T.surfaceBg, border: `1.5px solid ${T.inputBorder}`, borderRadius: 10, padding: 10, width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <button onClick={prevM} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 14, color: T.textSec, padding: "4px 8px" }}>◀</button>
        <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{viewYear}년 {viewMonth + 1}월</span>
        <button onClick={nextM} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 14, color: T.textSec, padding: "4px 8px" }}>▶</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2, textAlign: "center" }}>
        {DAYS_KR.map((d, i) => <div key={d} style={{ fontSize: 11, fontWeight: 600, padding: "4px 0", color: i === 0 ? "#ef4444" : i === 6 ? "#3b82f6" : T.textMut }}>{d}</div>)}
        {cells.map((day, i) => {
          if (!day) return <div key={i} />;
          const dateStr = fmt(day);
          const dow = new Date(viewYear, viewMonth, day).getDay();
          const isMatch = highlightDow !== null && dow === highlightDow;
          const isSel = value === dateStr;
          const isToday = dateStr === todayStr;
          const isDisabled = minDate && dateStr < minDate;
          return (
            <div key={i} onClick={() => { if (!isDisabled) onChange(dateStr); }}
              style={{
                fontSize: 13, padding: "5px 0", borderRadius: 6,
                cursor: isDisabled ? "not-allowed" : "pointer",
                fontWeight: isMatch && !isDisabled ? 700 : 400,
                color: isDisabled ? T.textMut + "44" : isSel ? "white" : isMatch ? (i % 7 === 0 ? "#ef4444" : i % 7 === 6 ? "#3b82f6" : T.text) : T.textMut + "88",
                background: isSel ? T.primary : isToday && !isDisabled ? T.primaryLight : "transparent",
                opacity: isDisabled ? 0.5 : 1,
                transition: "all .1s",
              }}>
              {day}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function RecurringForm({ type, initial, onSubmit, onCancel, T }) {
  const [n, sN] = useState(initial?.name || "");
  const [dv, sDv] = useState(initial?.dayValue ?? (type === "weekly" ? 1 : 1));
  const parseTime = (t) => { if (!t) return { h: "", m: "" }; const [h, m] = t.split(":"); return { h: h || "", m: m || "" }; };
  const initT = parseTime(initial?.time || "");
  const [hour, sH] = useState(initT.h);
  const [minute, sM] = useState(initT.m);
  const [intv, sI] = useState(initial?.interval || 1);
  const [startDate, setSd] = useState(initial?.startDate || todayKey());
  const [endDate, setEd] = useState(initial?.endDate || "");
  const [openCal, setOpenCal] = useState(null); // "start" | "end" | null
  const timeStr = hour !== "" && minute !== "" ? `${hour}:${minute}` : "";
  const inp = { width: "100%", padding: "12px 16px", border: `1.5px solid ${T.inputBorder}`, borderRadius: 10, fontSize: 16, outline: "none", background: T.surfaceBg, color: T.text };
  const fmtDisplay = (d) => { if (!d) return ""; const [y, m, dd] = d.split("-"); return `${y}.${m}.${dd}`; };
  return (
    <div>
      <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20 }}>{initial ? "정기 업무 편집" : (type === "weekly" ? "주간 업무 추가" : "월간 업무 추가")}</h3>
      <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6, marginTop: 16 }}>이름</label>
      <input style={inp} value={n} onChange={(e) => sN(e.target.value)} autoFocus placeholder={type === "weekly" ? "예: 주간 보고" : "예: 월간 정산"} />
      <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6, marginTop: 16 }}>{type === "weekly" ? "요일" : "일자"}</label>
      {type === "weekly"
        ? <div style={{ display: "flex", gap: 6, marginTop: 6 }}>{DAYS_KR.map((d, i) => <button key={i} onClick={() => sDv(i)} style={{ padding: "8px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 16, fontWeight: 600, background: dv === i ? T.primary : T.surfaceBg, color: dv === i ? "white" : T.text }}>{d}</button>)}</div>
        : <select style={{ ...inp, cursor: "pointer" }} value={dv} onChange={(e) => sDv(Number(e.target.value))}>{Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}일</option>)}<option value={-1}>말일 (매월 마지막 날)</option></select>}
      {type === "weekly" && <>
        <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6, marginTop: 16 }}>갱신 주기</label>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>{[{ v: 1, l: "매주" }, { v: 2, l: "격주" }, { v: 3, l: "3주" }, { v: 4, l: "4주" }].map((o) => (<button key={o.v} onClick={() => sI(o.v)} style={{ padding: "8px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 16, fontWeight: 600, background: intv === o.v ? T.primary : T.surfaceBg, color: intv === o.v ? "white" : T.text }}>{o.l}</button>))}</div>
      </>}
      {type === "weekly" && <>
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          {/* 시작일 */}
          <div style={{ flex: 1 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: T.textSec, marginBottom: 4 }}>시작일</label>
            <div onClick={() => setOpenCal(openCal === "start" ? null : "start")}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", border: `1.5px solid ${openCal === "start" ? T.primary : T.inputBorder}`, borderRadius: 8, cursor: "pointer", background: T.surfaceBg, transition: "border-color .15s" }}>
              <span style={{ fontSize: 14, color: startDate ? T.text : T.textMut }}>{fmtDisplay(startDate) || "선택"}</span>
              <span style={{ fontSize: 14, color: T.textMut }}>📅</span>
            </div>
          </div>
          {/* 종료일 */}
          <div style={{ flex: 1 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: T.textSec, marginBottom: 4 }}>종료일 <span style={{ fontSize: 11, fontWeight: 400, color: T.textMut }}>(선택)</span></label>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <div onClick={() => setOpenCal(openCal === "end" ? null : "end")}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flex: 1, padding: "9px 12px", border: `1.5px solid ${openCal === "end" ? T.primary : T.inputBorder}`, borderRadius: 8, cursor: "pointer", background: T.surfaceBg, transition: "border-color .15s" }}>
                <span style={{ fontSize: 14, color: endDate ? T.text : T.textMut }}>{fmtDisplay(endDate) || "없음"}</span>
                <span style={{ fontSize: 14, color: T.textMut }}>📅</span>
              </div>
              {endDate && <button onClick={() => { setEd(""); setOpenCal(null); }} style={{ padding: "6px 8px", border: "none", background: "transparent", cursor: "pointer", fontSize: 15, color: T.textMut, flexShrink: 0 }} title="종료일 해제">✕</button>}
            </div>
          </div>
        </div>
        {/* 확장 달력 */}
        {openCal && (
          <div style={{ marginTop: 8 }}>
            <DayHighlightCalendar
              value={openCal === "start" ? startDate : endDate}
              onChange={(d) => {
                if (openCal === "start") {
                  setSd(d);
                  // 시작일이 종료일보다 뒤면 종료일 초기화
                  if (endDate && d > endDate) setEd("");
                } else {
                  setEd(d);
                }
                setOpenCal(null);
              }}
              highlightDow={dv}
              minDate={openCal === "end" ? startDate : undefined}
              T={T}
            />
          </div>
        )}
      </>}
      <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6, marginTop: 16 }}>시간 (선택)</label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
        <select style={{ ...inp, flex: 1, cursor: "pointer" }} value={hour} onChange={(e) => sH(e.target.value)}><option value="">시</option>{Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map((h) => <option key={h} value={h}>{h}시</option>)}</select>
        <span style={{ fontSize: 20, fontWeight: 700, color: T.textMut }}>:</span>
        <select style={{ ...inp, flex: 1, cursor: "pointer" }} value={minute} onChange={(e) => sM(e.target.value)}><option value="">분</option>{Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0")).map((m) => <option key={m} value={m}>{m}분</option>)}</select>
        {(hour !== "" || minute !== "") && <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", borderRadius: 7, fontSize: 13, color: T.textMut }} onClick={() => { sH(""); sM(""); }}>초기화</button>}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 24 }}>
        <button style={{ padding: "10px 22px", border: `1px solid ${T.border}`, background: T.cardBg, borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 500, color: T.textSec }} onClick={onCancel}>취소</button>
        <button style={{ padding: "10px 22px", border: "none", background: `linear-gradient(135deg,${T.primary},${T.accent})`, color: "white", borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 600 }} onClick={() => n.trim() && onSubmit(n.trim(), dv, timeStr, intv, startDate, endDate)} disabled={!n.trim()}>{initial ? "저장" : "추가"}</button>
      </div>
    </div>
  );
}

export function ConvertEventForm({ eventName, projects, onSubmit, onCancel, T }) {
  const [selPid, setSelPid] = useState(projects[0]?.id || "");

  return (
    <div>
      <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>프로젝트에 편입</h3>
      <p style={{ fontSize: 14, color: T.textMut, marginBottom: 16 }}>
        <strong>"{eventName}"</strong>을(를) 프로젝트의 하위 업무로 이동합니다.
      </p>
      <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6 }}>프로젝트 선택</label>
      <select value={selPid} onChange={(e) => setSelPid(e.target.value)} style={{ width: "100%", padding: "12px 16px", border: `1.5px solid ${T.inputBorder}`, borderRadius: 10, fontSize: 16, outline: "none", background: T.surfaceBg, color: T.text, cursor: "pointer" }}>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
        <button style={{ padding: "10px 22px", border: `1px solid ${T.border}`, background: T.cardBg, borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 500, color: T.textSec }} onClick={onCancel}>취소</button>
        <button style={{ padding: "10px 22px", border: "none", background: `linear-gradient(135deg,${T.primary},${T.accent})`, color: "white", borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 600, boxShadow: `0 2px 8px ${T.primary}44` }} onClick={() => selPid && onSubmit(selPid)}>편입</button>
      </div>
    </div>
  );
}
