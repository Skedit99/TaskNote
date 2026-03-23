import { useState, useRef, useEffect, useCallback } from "react";
import { findTaskById } from "../utils/helpers";
import ResizeEdges from "./ResizeEdges";
import WinControls from "./WinControls";
import GlobalCSS from "./GlobalCSS";

/* 투명도에 따른 적응형 색상: 배경이 투명해질수록 라이트→흰색, 다크→검정 */
function adaptiveColor(baseColor, bgOpacity, isDark) {
  // bgOpacity 1 → 원래 색상, bgOpacity 0 → 흰색(라이트) or 검정(다크)
  const target = isDark ? [0, 0, 0] : [255, 255, 255];
  // baseColor를 hex→rgb 파싱
  const hex = baseColor.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16) || 0;
  const g = parseInt(hex.substring(2, 4), 16) || 0;
  const b = parseInt(hex.substring(4, 6), 16) || 0;
  // 보간: opacity가 낮을수록 target에 가까워짐
  const t = 1 - bgOpacity; // 0(불투명) ~ 1(완전투명)
  const mix = (a, b) => Math.round(a + (b - a) * t * 0.85);
  return `rgb(${mix(r, target[0])},${mix(g, target[1])},${mix(b, target[2])})`;
}

/* 설명 패널: 한줄 넘칠 때만 펼치기/접기 표시 */
function DescPanel({ desc, expanded, onToggle, T }) {
  const ref = useRef(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    // collapsed 상태에서 scrollWidth > clientWidth 이면 넘침
    setOverflows(ref.current.scrollWidth > ref.current.clientWidth + 1);
  }, [desc]);

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "6px 10px", background: T.surfaceBg, borderRadius: "0 0 10px 10px", border: `1px solid ${T.border}`, borderTop: "none" }}>
      <p ref={ref} style={{ fontSize: 13, color: T.textSec, lineHeight: "18px", margin: 0, ...(!expanded ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : { whiteSpace: "pre-wrap" }), flex: 1, minWidth: 0 }}>{desc}</p>
      {overflows && (
        <button style={{ fontSize: 12, color: T.primary, background: "none", border: "none", cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }} onClick={(e) => { e.stopPropagation(); onToggle(); }}>{expanded ? "접기" : "펼치기"}</button>
      )}
    </div>
  );
}

/* 완료 시간 표시 (더블클릭 → 수정) */
function CompletedTime({ completedAt, onUpdate, T }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const inputRef = useRef(null);

  const timeStr = completedAt ? new Date(completedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }) : "";

  const startEdit = (e) => {
    e.stopPropagation();
    const d = completedAt ? new Date(completedAt) : new Date();
    setVal(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
    setEditing(true);
  };

  useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const [h, m] = val.split(":").map(Number);
    if (isNaN(h) || isNaN(m)) return;
    const d = completedAt ? new Date(completedAt) : new Date();
    d.setHours(h, m, 0, 0);
    onUpdate(d.toISOString());
  };

  if (editing) {
    return (
      <input ref={inputRef} type="time" value={val} onChange={(e) => setVal(e.target.value)}
        onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        onClick={(e) => e.stopPropagation()}
        style={{ fontSize: 12, width: 60, padding: "1px 2px", border: `1px solid ${T.primary}`, borderRadius: 4, background: T.cardBg, color: T.text, outline: "none", textAlign: "center" }} />
    );
  }

  return (
    <span onDoubleClick={startEdit} style={{ fontSize: 12, color: T.textMut, fontWeight: 500, whiteSpace: "nowrap", cursor: "pointer", flexShrink: 0 }} title="더블클릭하여 시간 수정">{timeStr}</span>
  );
}

export default function MiniToday({ ctx }) {
  const {
    data, T, isDark, isHovered, bgOpacity, cardOpacity, showControls, isLocked,
    pendingToday, doneToday, expandedToday, setExpandedToday,
    toggleTodayTask, removeFromToday, updateCompletedAt, getTaskTime, getColorForProjectId,
    handleLock, handleMiniMode, handleBgOpacity, handleCardOpacity,
    handleMinimize, handleClose, setShowControls,
    onMouseEnter, onMouseLeave,
  } = ctx;

  const hv = isHovered;
  const P = 10;

  // 적응형 색상 (배경 투명도에 따라 텍스트 색상 조절)
  const aText = adaptiveColor(T.text, bgOpacity, isDark);
  const aTextMut = adaptiveColor(T.textMut, bgOpacity, isDark);
  const aTextSec = adaptiveColor(T.textSec, bgOpacity, isDark);
  const aBorder = adaptiveColor(T.border, bgOpacity, isDark);
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayDone = doneToday;
  const todayTotal = pendingToday.length + todayDone.length;

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
              <span style={{ fontSize: 15, fontWeight: 700, whiteSpace: "nowrap" }}>To-Do List</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: T.primary, background: T.primaryLight, padding: "1px 10px", borderRadius: 12 }}>{pendingToday.length}</span>
            </div>
            <div style={{ display: "flex", gap: 1, alignItems: "center", WebkitAppRegion: "no-drag" }}>
              <button onClick={handleLock} title={isLocked ? "잠금 해제" : "위치 잠금"} style={{ width: 28, height: 28, border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: isLocked ? T.textSec : T.textMut, opacity: isLocked ? 1 : 0.5 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2" />{isLocked ? <path d="M7 11V7a5 5 0 0110 0v4" /> : <path d="M7 11V7a5 5 0 019.9-1" />}</svg>
              </button>
              <button onClick={() => setShowControls(!showControls)} style={{ width: 28, height: 28, border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: showControls ? T.primary : T.textMut }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="3" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg>
              </button>
              <button onClick={() => handleMiniMode("calendar")} title="캘린더 위젯" style={{ width: 28, height: 28, border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: T.textMut }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
              </button>
              <button onClick={() => handleMiniMode(false)} title="메인 화면" style={{ width: 28, height: 28, border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: T.primary }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
              </button>
              <WinControls mini T={T} handleMinimize={handleMinimize} handleMaximize={() => {}} handleClose={handleClose} />
            </div>
          </div>
          {showControls && (
            <div style={{ padding: `2px ${P + 2}px 6px`, display: "flex", flexDirection: "column", gap: 4, WebkitAppRegion: "no-drag" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, color: T.textSec, width: 28, flexShrink: 0 }}>배경</span>
                <input type="range" min="0" max="1" step="0.05" value={bgOpacity} onChange={(e) => handleBgOpacity(e.target.value)} style={{ flex: 1, cursor: "pointer" }} />
                <span style={{ fontSize: 11, color: T.textSec, width: 30, textAlign: "right" }}>{Math.round(bgOpacity * 100)}%</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, color: T.textSec, width: 44, flexShrink: 0 }}>완료 목록</span>
                <input type="range" min="0.3" max="1" step="0.05" value={cardOpacity} onChange={(e) => handleCardOpacity(e.target.value)} style={{ flex: 1, cursor: "pointer" }} />
                <span style={{ fontSize: 11, color: T.textSec, width: 30, textAlign: "right" }}>{Math.round(cardOpacity * 100)}%</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 콘텐츠 영역 */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative", borderRadius: hv ? "0 0 12px 12px" : 12, transition: "border-radius .3s" }}>
        <div style={{ position: "absolute", inset: 0, background: T.bgGrad, opacity: bgOpacity, borderRadius: "inherit", pointerEvents: "none", zIndex: 0 }} />

        <div style={{ flex: 1, overflowY: "auto", padding: P, position: "relative", zIndex: 1 }}>
          {pendingToday.length === 0 && todayDone.length === 0 && (
            <div style={{ textAlign: "center", padding: "36px 16px", color: T.textMut }}>
              <p style={{ fontSize: 28, marginBottom: 6 }}>✨</p>
              <p style={{ fontSize: 14, fontWeight: 500 }}>할 일이 없습니다</p>
            </div>
          )}
          {pendingToday.map((t) => {
            const hasDesc = t.description && t.description.trim().length > 0;
            const isDescExp = expandedToday[t.taskId];
            const tTime = t.time || getTaskTime(t.taskId);
            const _pc = getColorForProjectId(t.projectId);
            return (
              <div key={t.taskId} style={{ marginBottom: 4, transition: "opacity .2s" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 10px", background: bgOpacity < 0.3 ? "transparent" : T.cardBg, borderRadius: hasDesc ? "10px 10px 0 0" : "10px", border: `1px solid ${aBorder}`, position: "relative", overflow: "hidden", transition: "background .3s, border-color .3s" }}>
                  <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, borderRadius: "3px 0 0 3px", background: `linear-gradient(to bottom, transparent, ${_pc.color} 20%, ${_pc.color} 80%, transparent)` }} />
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, cursor: "pointer", minWidth: 0 }} onClick={() => { setExpandedToday((p) => { const n = { ...p }; delete n[t.taskId]; return n; }); toggleTodayTask(t.taskId); }}>
                    <div style={{ width: 22, height: 22, borderRadius: 7, border: `2.5px solid ${aBorder}`, flexShrink: 0, transition: "border-color .3s" }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <p style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", margin: 0, color: aText, transition: "color .3s" }}>{t.taskName}</p>
                      <p style={{ fontSize: 12, color: aTextMut, margin: 0, transition: "color .3s" }}>{t.projectName}</p>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                    {tTime && <span style={{ fontSize: 12, color: T.accent, fontWeight: 600, whiteSpace: "nowrap" }}>{tTime}</span>}
                    <button style={{ width: 26, height: 26, border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, fontSize: 14, color: T.textMut + "88", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => removeFromToday(t.taskId)}>✕</button>
                  </div>
                </div>
                {hasDesc && (
                  <DescPanel desc={t.description} expanded={!!isDescExp} onToggle={() => setExpandedToday((p) => ({ ...p, [t.taskId]: !p[t.taskId] }))} T={T} />
                )}
              </div>
            );
          })}
          {todayDone.length > 0 && (() => {
            const aText = adaptiveColor(T.text, bgOpacity, isDark);
            const aTextMut = adaptiveColor(T.textMut, bgOpacity, isDark);
            const aBorder = adaptiveColor(T.border, bgOpacity, isDark);
            const aCardBg = bgOpacity < 0.3 ? "transparent" : T.cardBg;
            return (
            <div style={{ borderTop: `1px solid ${aBorder}`, marginTop: 6, paddingTop: 6 }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: aTextMut, marginBottom: 4, paddingLeft: 4 }}>완료 ({todayDone.length})</p>
              {todayDone.map((t) => (
                <div key={t.taskId} style={{ marginBottom: 4, opacity: cardOpacity, transition: "opacity .2s, color .3s", cursor: "pointer" }} onClick={() => toggleTodayTask(t.taskId)}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 10px", background: aCardBg, borderRadius: "10px", border: `1px solid ${aBorder}`, transition: "background .3s, border-color .3s" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                      <div style={{ width: 22, height: 22, borderRadius: 7, background: "linear-gradient(135deg,#10b981,#059669)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <p style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", margin: 0, textDecoration: "line-through", color: aTextMut, transition: "color .3s" }}>{t.taskName}</p>
                        <p style={{ fontSize: 12, color: aTextMut, margin: 0, transition: "color .3s" }}>{t.projectName}</p>
                      </div>
                    </div>
                    <CompletedTime completedAt={t.completedAt} onUpdate={(newTime) => updateCompletedAt(t.taskId, newTime)} T={{ ...T, textSec: aTextMut }} />
                  </div>
                </div>
              ))}
            </div>
            );
          })()}
        </div>

        {/* 진행률 푸터 */}
        <div style={{ padding: `8px ${P + 2}px`, background: T.headerBg, borderTop: `1px solid ${T.border}`, flexShrink: 0, position: "relative", zIndex: 2, borderRadius: "0 0 12px 12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
            <span style={{ fontSize: 11, color: T.textSec }}>오늘 진행률</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: T.primary }}>{todayTotal > 0 ? Math.round((todayDone.length / todayTotal) * 100) : 0}%</span>
          </div>
          <div style={{ height: 4, background: T.progBg, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", background: `linear-gradient(90deg,${T.primary},${T.accent})`, borderRadius: 3, transition: "width .3s", width: `${todayTotal > 0 ? (todayDone.length / todayTotal) * 100 : 0}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}
