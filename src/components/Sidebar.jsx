import { useState, useRef } from "react";
import { DAYS_KR, MAX_ACTIVE_PROJECTS } from "../constants";
import { findTaskById, countAll, countDone, getDday, fmtDate } from "../utils/helpers";
import { getProjectColor } from "../constants/theme";
import TaskItem from "./TaskItem";

export default function Sidebar({ ctx }) {
  const {
    data, T, sideTab, setSideTab, sideOpen,
    activeProject, setActiveProject, setModal,
    expanded, setExpanded, expandedDesc, setExpandedDesc,
    expandedToday, setExpandedToday,
    editingTask, setEditingTask, depthColors,
    activeProjects, archivedProjects,
    pendingToday, doneToday,
    toggleTodayTask, removeFromToday,
    addToToday, addToScheduled,
    getColorForProjectId, getScheduledDateForTask, getTaskTime,
    editSubtask, deleteSubtask, reorderSubtasks,
    addRecurringToToday, toggleRecurring, deleteRecurring,
    archiveProject, restoreProject, deleteProject, reorderProjects,
    hasNonTodaySelection, selectedDateKey, selectedDateLabel,
  } = ctx;

  // 프로젝트 드래그 정렬
  const [dragOverId, setDragOverId] = useState(null);
  const dragProjectRef = useRef(null);

  return (
    <div style={{ display: "flex", flexShrink: 0 }}>
      {/* 탭 버튼 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "16px 6px", background: T.panelBg + "44", borderLeft: `1px solid ${T.border}` }}>
        {[
          { key: "today", label: "오늘 할 일", icon: "◎", color: T.warnText },
          { key: "projects", label: "프로젝트", icon: "◈", color: T.primary },
          { key: "recurring", label: "정기 업무", icon: "↻", color: T.doneText },
        ].map((tab) => (
          <button key={tab.key} onClick={() => setSideTab(sideTab === tab.key ? null : tab.key)}
            style={{ width: 56, minHeight: 80, border: "none", background: sideTab === tab.key ? tab.color : T.surfaceBg, borderRadius: 10, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, transition: "all .15s", boxShadow: sideTab === tab.key ? `0 3px 12px ${tab.color}44` : "none" }}>
            <span style={{ fontSize: 20, color: sideTab === tab.key ? "white" : tab.color }}>{tab.icon}</span>
            <span style={{ fontSize: 11, fontWeight: 700, lineHeight: "13px", textAlign: "center", color: sideTab === tab.key ? "white" : T.text }}>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* 패널 */}
      {sideOpen && (
        <div style={{ width: 420, borderLeft: `1px solid ${T.border}`, background: T.panelBg, backdropFilter: "blur(16px)", display: "flex", flexDirection: "column", animation: "fadeIn .2s ease", overflow: "hidden" }}>

          {/* TODAY */}
          {sideTab === "today" && (() => {
            const todayStr = new Date().toISOString().slice(0, 10);
            const todayDone = doneToday.filter((t) => t.completedAt && t.completedAt.slice(0, 10) === todayStr);
            return (<>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px 12px", flexShrink: 0 }}>
              <h3 style={{ fontSize: 20, fontWeight: 700 }}>오늘 할 일</h3>
              <span style={{ fontSize: 15, fontWeight: 700, color: T.primary, background: T.primaryLight, padding: "3px 12px", borderRadius: 14 }}>{pendingToday.length}</span>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 20px" }}>
              {pendingToday.length === 0 && todayDone.length === 0 && <p style={{ fontSize: 15, color: T.textMut, textAlign: "center", padding: 30 }}>프로젝트나 정기 업무에서 추가하세요</p>}
              {data.todayTasks.map((t) => {
                if (t.completed) return null;
                let liveDesc = t.description || "";
                if (t.projectId !== "recurring" && t.projectId !== "event") {
                  const proj = data.projects.find((p) => p.id === t.projectId);
                  if (proj) { const st = findTaskById(proj.subtasks, t.taskId); if (st?.description) liveDesc = st.description; }
                }
                const hasDesc = liveDesc.trim().length > 0;
                const isDescExp = expandedToday[t.taskId];
                const tTime = t.time || getTaskTime(t.taskId);
                const _pc = getColorForProjectId(t.projectId);
                return (
                  <div key={t.taskId} style={{ marginBottom: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 14px", background: T.cardBg, border: `1px solid ${T.border}`, borderRadius: hasDesc ? "12px 12px 0 0" : "12px", position: "relative", overflow: "hidden" }}>
                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, borderRadius: "3px 0 0 3px", background: `linear-gradient(to bottom, transparent, ${_pc.color} 20%, ${_pc.color} 80%, transparent)` }} />
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, cursor: "pointer", minWidth: 0 }} onClick={() => toggleTodayTask(t.taskId)}>
                        <div style={{ width: 24, height: 24, borderRadius: 8, border: `2.5px solid ${T.border}`, flexShrink: 0 }} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <p style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.taskName}</p>
                          <p style={{ fontSize: 13, color: T.textMut }}>{t.projectName}</p>
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                        {tTime && <span style={{ fontSize: 13, color: T.accent, fontWeight: 600, whiteSpace: "nowrap" }}>{tTime}</span>}
                        <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", borderRadius: 7, fontSize: 15, color: T.textMut + "88" }} onClick={() => removeFromToday(t.taskId)}>✕</button>
                      </div>
                    </div>
                    {hasDesc && (
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 14px", background: T.surfaceBg, borderRadius: "0 0 12px 12px", border: `1px solid ${T.border}`, borderTop: "none" }}>
                        {isDescExp
                          ? <p style={{ fontSize: 14, color: T.textSec, lineHeight: "20px", margin: 0, whiteSpace: "pre-wrap", flex: 1, minWidth: 0 }}>{liveDesc}</p>
                          : <p style={{ fontSize: 14, color: T.textSec, lineHeight: "20px", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{liveDesc}</p>}
                        <button style={{ fontSize: 13, color: T.primary, background: "none", border: "none", cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" }} onClick={() => setExpandedToday((p) => ({ ...p, [t.taskId]: !p[t.taskId] }))}>{isDescExp ? "간략히" : "더보기"}</button>
                      </div>
                    )}
                  </div>
                );
              })}
              {todayDone.length > 0 && (
                <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 10, paddingTop: 10 }}>
                  <p style={{ fontSize: 14, fontWeight: 600, color: T.textMut, marginBottom: 8 }}>완료 ({todayDone.length})</p>
                  {todayDone.map((t) => (
                    <div key={t.taskId} style={{ marginBottom: 4, opacity: 0.55, cursor: "pointer" }} onClick={() => toggleTodayTask(t.taskId)}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 14px", background: T.cardBg, border: `1px solid ${T.border}`, borderRadius: "12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                          <div style={{ width: 24, height: 24, borderRadius: 8, background: "linear-gradient(135deg,#10b981,#059669)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, animation: "checkPop .3s ease" }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                          </div>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <p style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "line-through", color: T.textMut }}>{t.taskName}</p>
                            <p style={{ fontSize: 13, color: T.textMut }}>{t.projectName}</p>
                          </div>
                        </div>
                        {t.completedAt && <span style={{ fontSize: 12, color: T.textMut, flexShrink: 0, marginLeft: 8 }}>{new Date(t.completedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>); })()}

          {/* PROJECTS */}
          {sideTab === "projects" && (<>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px 12px", flexShrink: 0 }}>
              <h3 style={{ fontSize: 20, fontWeight: 700 }}>프로젝트</h3>
              <span style={{ fontSize: 13, color: T.textMut, fontWeight: 600 }}>{activeProjects.length}/{MAX_ACTIVE_PROJECTS}</span>
              <button style={{ width: 34, height: 34, border: "none", background: `linear-gradient(135deg,${T.primary},${T.accent})`, color: "white", borderRadius: 10, cursor: "pointer", fontSize: 18, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 2px 8px ${T.primary}44`, opacity: activeProjects.length >= MAX_ACTIVE_PROJECTS ? 0.4 : 1 }}
                onClick={() => {
                  if (activeProjects.length >= MAX_ACTIVE_PROJECTS) { setModal({ type: "alert", message: "현재 진행중인 프로젝트가 너무 많습니다.\n프로젝트를 정리하고 다시 시도해주세요." }); return; }
                  setModal({ type: "addProject" });
                }}>+</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 20px" }}>
              {activeProjects.length === 0 && archivedProjects.length === 0 && <p style={{ fontSize: 15, color: T.textMut, textAlign: "center", padding: 30 }}>새 프로젝트를 추가하세요</p>}
              {activeProjects.map((p) => {
                const isActive = activeProject === p.id;
                const dday = getDday(p.deadline);
                const total = countAll(p.subtasks);
                const done = countDone(p.subtasks);
                const progress = total > 0 ? (done / total) * 100 : 0;
                const pc = getProjectColor(p, T.key === "dark");
                const isDragOver = dragOverId === p.id && dragProjectRef.current !== p.id;
                return (
                  <div key={p.id} style={{ marginBottom: 6 }}
                    draggable={!isActive}
                    onDragStart={(e) => {
                      dragProjectRef.current = p.id;
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/project-id", p.id);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dragProjectRef.current && dragProjectRef.current !== p.id) setDragOverId(p.id);
                    }}
                    onDragLeave={(e) => {
                      // 자식 요소로 이동할 때는 무시 (떨림 방지)
                      if (e.currentTarget.contains(e.relatedTarget)) return;
                      if (dragOverId === p.id) setDragOverId(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverId(null);
                      const fromId = dragProjectRef.current;
                      dragProjectRef.current = null;
                      if (!fromId || fromId === p.id) return;
                      const arr = [...activeProjects];
                      const fi = arr.findIndex((x) => x.id === fromId);
                      const ti = arr.findIndex((x) => x.id === p.id);
                      if (fi === -1 || ti === -1) return;
                      const [moved] = arr.splice(fi, 1);
                      arr.splice(ti, 0, moved);
                      reorderProjects(arr);
                    }}
                    onDragEnd={() => { dragProjectRef.current = null; setDragOverId(null); }}
                  >
                    <div style={{ height: isDragOver ? 3 : 0, borderRadius: 3, background: `linear-gradient(90deg,${T.primary},${T.accent})`, marginBottom: isDragOver ? 4 : 0, transition: "height .12s, margin .12s", overflow: "hidden" }} />
                    <div style={{ padding: "14px 16px", borderRadius: 12, border: `2px solid ${isActive ? pc.color : T.border}`, borderLeft: `4px solid ${pc.color}`, background: isActive ? pc.light + "44" : T.cardBg, cursor: isActive ? "pointer" : "grab", transition: "all .15s", boxShadow: isActive ? `0 2px 10px ${pc.color}18` : "" }} onClick={() => setActiveProject(isActive ? null : p.id)}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ width: 12, height: 12, borderRadius: 4, background: pc.color, flexShrink: 0 }} />
                          <span style={{ fontWeight: 700, fontSize: 16 }}>{p.name}</span>
                        </div>
                        <div style={{ display: "flex", gap: 3 }}>
                          <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", borderRadius: 7, fontSize: 15, color: T.doneText }} onClick={(e) => { e.stopPropagation(); archiveProject(p.id); }} title="프로젝트 완료">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                          </button>
                          <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", borderRadius: 7, fontSize: 15, color: T.textMut }} onClick={(e) => { e.stopPropagation(); setModal({ type: "editProject", project: p }); }}>✎</button>
                          <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", borderRadius: 7, fontSize: 15, color: "#ef4444" }} onClick={(e) => { e.stopPropagation(); setModal({ type: "confirm", message: `"${p.name}" 프로젝트를 삭제하시겠습니까?`, onConfirm: () => { deleteProject(p.id); setModal(null); } }); }}>✕</button>
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                        {dday && <span style={{ fontSize: 13, fontWeight: 700, padding: "2px 8px", borderRadius: 5, background: dday === "D-Day" ? "#fee2e2" : dday.startsWith("D+") ? "#fde8e8" : T.primaryLight, color: dday === "D-Day" ? "#dc2626" : dday.startsWith("D+") ? "#c0392b" : T.primary }}>{dday}</span>}
                        {p.deadline && <span style={{ fontSize: 13, color: T.textMut }}>{fmtDate(p.deadline)}</span>}
                        <span style={{ fontSize: 13, color: T.textMut, marginLeft: "auto" }}>{done}/{total}</span>
                      </div>
                      {total > 0 && <div style={{ height: 4, background: T.progBg, borderRadius: 3, marginTop: 8, overflow: "hidden" }}><div style={{ height: "100%", background: pc.color, borderRadius: 3, transition: "width .3s", width: `${progress}%` }} /></div>}
                    </div>
                    {isActive && (
                      <div style={{ marginLeft: 12, paddingLeft: 12, borderLeft: `3px solid ${pc.light}`, paddingTop: 10, paddingBottom: 6, animation: "fadeIn .2s ease" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                          <span style={{ fontSize: 14, fontWeight: 700, color: pc.color }}>세부 업무</span>
                          <button style={{ width: 34, height: 34, border: "none", background: `linear-gradient(135deg,${T.primary},${T.accent})`, color: "white", borderRadius: 10, cursor: "pointer", fontSize: 18, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setModal({ type: "addSubtask", parentId: null })}>+</button>
                        </div>
                        {p.subtasks.length === 0 && <p style={{ fontSize: 14, color: T.textMut, textAlign: "center", padding: 12 }}>업무를 추가하세요</p>}
                        {p.subtasks.map((t) => (
                          <TaskItem
                            key={t.id}
                            task={t} depth={0} projectId={p.id} siblings={p.subtasks}
                            data={data} T={T}
                            expanded={expanded} setExpanded={setExpanded}
                            expandedDesc={expandedDesc} setExpandedDesc={setExpandedDesc}
                            editingTask={editingTask} setEditingTask={setEditingTask}
                            depthColors={depthColors}
                            hasNonTodaySelection={hasNonTodaySelection}
                            selectedDateKey={selectedDateKey} selectedDateLabel={selectedDateLabel}
                            addToToday={addToToday} addToScheduled={addToScheduled}
                            getScheduledDateForTask={getScheduledDateForTask} getTaskTime={getTaskTime}
                            editSubtask={editSubtask} deleteSubtask={deleteSubtask}
                            reorderSubtasks={reorderSubtasks} setModal={setModal}
                            getColorForProjectId={getColorForProjectId}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* 보관함 */}
              {archivedProjects.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, cursor: "pointer" }} onClick={() => setExpanded((p) => ({ ...p, __archive: !p.__archive }))}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.textMut} strokeWidth="2.5" strokeLinecap="round" style={{ transform: expanded.__archive ? "rotate(90deg)" : "rotate(0)", transition: "transform .15s" }}><polyline points="9 18 15 12 9 6" /></svg>
                    <span style={{ fontSize: 14, fontWeight: 700, color: T.textMut }}>보관함 ({archivedProjects.length})</span>
                  </div>
                  {expanded.__archive && archivedProjects.map((p) => {
                    const total = countAll(p.subtasks); const done = countDone(p.subtasks);
                    return (
                      <div key={p.id} style={{ padding: "12px 14px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surfaceBg, marginBottom: 6, opacity: 0.7 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontSize: 15, fontWeight: 600, textDecoration: "line-through", color: T.textMut, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</p>
                            <p style={{ fontSize: 12, color: T.textMut, marginTop: 2 }}>{done}/{total} 완료{p.deadline ? ` · ${fmtDate(p.deadline)}` : ""}</p>
                          </div>
                          <div style={{ display: "flex", gap: 3 }}>
                            <button style={{ padding: "4px 10px", border: `1.5px solid ${T.primary}`, background: T.cardBg, color: T.primary, borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 600 }} onClick={() => restoreProject(p.id)}>복구</button>
                            <button style={{ width: 28, height: 28, border: "none", background: "transparent", cursor: "pointer", borderRadius: 7, fontSize: 14, color: "#ef4444" }} onClick={() => setModal({ type: "confirm", message: `"${p.name}" 프로젝트를 완전히 삭제하시겠습니까?`, onConfirm: () => { deleteProject(p.id); setModal(null); } })}>✕</button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>)}

          {/* RECURRING */}
          {sideTab === "recurring" && (<>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px 12px", flexShrink: 0 }}>
              <h3 style={{ fontSize: 20, fontWeight: 700 }}>정기 업무</h3>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 20px" }}>
              {["weekly", "monthly"].map((type) => {
                const label = type === "weekly" ? "주간 업무" : "월간 업무";
                const active = data.recurring.filter((r) => r.type === type && r.active);
                const inactive = data.recurring.filter((r) => r.type === type && !r.active);
                return (
                  <div key={type} style={{ marginBottom: 20 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <span style={{ fontSize: 16, fontWeight: 700, color: type === "weekly" ? T.primary : T.accent }}>{label}</span>
                      <button style={{ width: 34, height: 34, border: "none", background: `linear-gradient(135deg,${T.primary},${T.accent})`, color: "white", borderRadius: 10, cursor: "pointer", fontSize: 18, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setModal({ type: "addRecurring", recurType: type })}>+</button>
                    </div>
                    {active.map((r) => (
                      <div key={r.id} style={{ display: "flex", alignItems: "center", padding: "12px 14px", borderRadius: 12, background: T.cardBg, border: `1px solid ${T.border}`, marginBottom: 6 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</p>
                          <p style={{ fontSize: 12, color: T.textMut }}>{type === "weekly" ? `${DAYS_KR[r.dayValue]}요일 · ${r.interval === 1 ? "매주" : r.interval === 2 ? "격주" : `${r.interval}주마다`}` : `매월 ${r.dayValue}일`}{r.time ? ` · ${r.time}` : ""}</p>
                        </div>
                        <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
                          <button style={{ padding: "4px 10px", border: `1.5px solid ${T.primary}`, background: T.cardBg, color: T.primary, borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 600 }} onClick={() => addRecurringToToday(r)}>+오늘</button>
                          <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", borderRadius: 7, fontSize: 15, color: T.textMut }} onClick={() => setModal({ type: "editRecurring", recurring: r })}>✎</button>
                          <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", borderRadius: 7, fontSize: 15, color: T.textMut }} onClick={() => toggleRecurring(r.id)}>⏸</button>
                          <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", borderRadius: 7, fontSize: 15, color: "#ef4444" }} onClick={() => deleteRecurring(r.id)}>✕</button>
                        </div>
                      </div>
                    ))}
                    {inactive.length > 0 && (<>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "10px 0 6px" }}>
                        <span style={{ fontSize: 13, color: T.textMut, fontWeight: 600 }}>비활성</span>
                        <div style={{ flex: 1, height: 1, background: T.border }} />
                      </div>
                      {inactive.map((r) => (
                        <div key={r.id} style={{ display: "flex", alignItems: "center", padding: "12px 14px", borderRadius: 12, background: T.cardBg, border: `1px solid ${T.border}`, marginBottom: 6, opacity: 0.45 }}>
                          <div style={{ flex: 1, minWidth: 0 }}><p style={{ fontSize: 15, fontWeight: 600, color: T.textMut }}>{r.name}</p></div>
                          <div style={{ display: "flex", gap: 3 }}>
                            <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", borderRadius: 7, fontSize: 15, color: T.textMut }} onClick={() => setModal({ type: "editRecurring", recurring: r })}>✎</button>
                            <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", borderRadius: 7, fontSize: 15, color: "#10b981" }} onClick={() => toggleRecurring(r.id)}>▶</button>
                            <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", borderRadius: 7, fontSize: 15, color: "#ef4444" }} onClick={() => deleteRecurring(r.id)}>✕</button>
                          </div>
                        </div>
                      ))}
                    </>)}
                  </div>
                );
              })}
            </div>
          </>)}
        </div>
      )}
    </div>
  );
}
