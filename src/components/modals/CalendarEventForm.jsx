import { useState } from "react";

export default function CalendarEventForm({ dateKey, dateLabel, projects, onAddIndependent, onAddToProject, onCancel, T }) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [time, setTime] = useState("");
  const [useTime, setUseTime] = useState(false);
  const [mode, setMode] = useState("independent");
  const [selectedProject, setSelectedProject] = useState(projects[0]?.id || "");

  const handleSubmit = () => {
    if (!name.trim()) return;
    const t = useTime ? time : "";
    if (mode === "independent") onAddIndependent(name.trim(), desc, t);
    else if (selectedProject) onAddToProject(selectedProject, name.trim(), desc, t);
  };

  return (
    <div>
      <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>일정 추가</h3>
      <p style={{ fontSize: 14, color: T.textMut, marginBottom: 16 }}>{dateLabel}</p>

      <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6 }}>일정 이름</label>
      <input style={{ width: "100%", padding: "12px 16px", border: `1.5px solid ${T.inputBorder}`, borderRadius: 10, fontSize: 16, outline: "none", background: T.surfaceBg, color: T.text, boxSizing: "border-box" }} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="예: 회의, 마감 등" onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }} />

      <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6, marginTop: 14 }}>설명 (선택)</label>
      <textarea style={{ width: "100%", padding: "12px 16px", border: `1.5px solid ${T.inputBorder}`, borderRadius: 10, fontSize: 16, outline: "none", background: T.surfaceBg, color: T.text, minHeight: 60, resize: "vertical", boxSizing: "border-box" }} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="메모" />

      {/* 시간 선택 */}
      <div style={{ marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 14, fontWeight: 600, color: T.textSec }}>
            <input type="checkbox" checked={useTime} onChange={(e) => setUseTime(e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer", accentColor: T.primary }} />
            시간 지정
          </label>
          {useTime && <span style={{ fontSize: 12, color: T.textMut }}>지정하지 않으면 종일 일정으로 등록됩니다</span>}
        </div>
        {useTime && (
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ padding: "10px 16px", border: `1.5px solid ${T.inputBorder}`, borderRadius: 10, fontSize: 16, outline: "none", background: T.surfaceBg, color: T.text, cursor: "pointer" }} />
        )}
      </div>

      <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 8, marginTop: 14 }}>일정 유형</label>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => setMode("independent")} style={{ flex: 1, padding: "12px", borderRadius: 10, border: `2px solid ${mode === "independent" ? T.primary : T.border}`, background: mode === "independent" ? T.primaryLight : T.cardBg, cursor: "pointer", textAlign: "center" }}>
          <span style={{ fontSize: 22, display: "block" }}>★</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: mode === "independent" ? T.primary : T.text }}>독립 일정</span>
        </button>
        <button onClick={() => setMode("project")} disabled={projects.length === 0} style={{ flex: 1, padding: "12px", borderRadius: 10, border: `2px solid ${mode === "project" ? T.primary : T.border}`, background: mode === "project" ? T.primaryLight : T.cardBg, cursor: projects.length ? "pointer" : "not-allowed", textAlign: "center", opacity: projects.length ? 1 : 0.4 }}>
          <span style={{ fontSize: 22, display: "block" }}>◈</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: mode === "project" ? T.primary : T.text }}>프로젝트 하위 업무</span>
        </button>
      </div>

      {mode === "project" && projects.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: T.textSec, marginBottom: 6 }}>프로젝트 선택</label>
          <select value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)} style={{ width: "100%", padding: "12px 16px", border: `1.5px solid ${T.inputBorder}`, borderRadius: 10, fontSize: 16, outline: "none", background: T.surfaceBg, color: T.text, cursor: "pointer" }}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <p style={{ fontSize: 13, color: T.textMut, marginTop: 6 }}>선택한 프로젝트의 하위 업무로 추가되고, {dateLabel}에 자동 예약됩니다.</p>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
        <button style={{ padding: "10px 22px", border: `1px solid ${T.border}`, background: T.cardBg, borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 500, color: T.textSec }} onClick={onCancel}>취소</button>
        <button style={{ padding: "10px 22px", border: "none", background: `linear-gradient(135deg,${T.primary},${T.accent})`, color: "white", borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 600, boxShadow: `0 2px 8px ${T.primary}44`, opacity: name.trim() ? 1 : 0.5 }} onClick={handleSubmit} disabled={!name.trim()}>추가</button>
      </div>
    </div>
  );
}
