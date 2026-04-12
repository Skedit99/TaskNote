import React from "react";
import { countAll, countDone, findTaskById, isDescendant, todayKey } from "../utils/helpers";

export default function TaskItem({
  task, depth, projectId, siblings, data, T,
  expanded, setExpanded, expandedDesc, setExpandedDesc,
  editingTask, setEditingTask, depthColors,
  hasNonTodaySelection, selectedDateKey, selectedDateLabel,
  addToScheduled, getScheduledDateForTask, getTaskTime,
  editSubtask, deleteSubtask, reorderSubtasks, moveTaskUnder, moveTaskBeside, setModal,
  getColorForProjectId,
}) {
  // "none" | "nest" | "above" | "below"
  const [dropZone, setDropZone] = React.useState("none");
  const dragCounterRef = React.useRef(0);
  const isInToday = (data.scheduled?.[todayKey()]?.some((s) => s.taskId === task.id)) ||
    (data.events || []).some((e) => e.id === task.id && e.date === todayKey() && !e.deleted);
  const hasChildren = task.children?.length > 0;
  const isExp = expanded[task.id];
  const descExp = expandedDesc[task.id];
  const hasDesc = task.description?.trim().length > 0;
  const bc = depthColors[Math.min(depth, depthColors.length - 1)];
  const existingSched = getScheduledDateForTask(task.id);
  const isScheduled = !!existingSched;
  const pc = getColorForProjectId(projectId);

  const insertLineStyle = (pos) => ({
    position: "absolute", left: depth * 20, right: 0, [pos]: -3, zIndex: 10,
    display: "flex", alignItems: "center", gap: 6, height: 4, pointerEvents: "none",
  });

  return (
    <div key={task.id} style={{ position: "relative" }}>
      {dropZone === "above" && (
        <div style={insertLineStyle("top")}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: pc.color, flexShrink: 0 }} />
          <div style={{ flex: 1, height: 2.5, borderRadius: 2, background: pc.color }} />
        </div>
      )}
      <div
        draggable={editingTask !== task.id}
        onDragStart={(e) => { if (editingTask === task.id) { e.preventDefault(); return; } e.dataTransfer.setData("text/plain", JSON.stringify({ taskId: task.id })); e.stopPropagation(); }}
        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); dragCounterRef.current++; }}
        onDragOver={(e) => {
          e.preventDefault(); e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          const y = e.clientY - rect.top;
          const ratio = y / rect.height;
          if (ratio < 0.15) setDropZone("above");
          else if (ratio > 0.85) setDropZone("below");
          else setDropZone("nest");
        }}
        onDragLeave={(e) => {
          e.stopPropagation();
          dragCounterRef.current--;
          if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setDropZone("none"); }
        }}
        onDrop={(e) => {
          e.preventDefault(); e.stopPropagation();
          dragCounterRef.current = 0;
          const zone = dropZone;
          setDropZone("none");
          try {
            const d = JSON.parse(e.dataTransfer.getData("text/plain"));
            if (d.taskId === task.id) return;
            const proj = data.projects.find((x) => x.id === projectId);
            if (!proj) return;
            if (isDescendant(d.taskId, task.id, proj.subtasks)) return;

            if (zone === "nest") {
              // 중앙 영역: 하위 업무로 이동
              moveTaskUnder(projectId, d.taskId, task.id);
            } else {
              // 상/하 가장자리: 타겟의 형제로 이동 (같은 레벨이면 순서변경, 다른 레벨이면 꺼내기/넣기)
              const fi = siblings.findIndex((s) => s.id === d.taskId);
              const ti = siblings.findIndex((s) => s.id === task.id);
              if (fi !== -1 && ti !== -1) {
                // 같은 siblings 내 순서 변경
                const pid2 = depth === 0 ? null : (() => {
                  const fp = (arr, tid, par) => { for (const s of arr) { if (s.id === tid) return par; if (s.children) { const r = fp(s.children, tid, s.id); if (r) return r; } } return null; };
                  return fp(proj.subtasks, task.id, null);
                })();
                const na = [...siblings];
                const [m] = na.splice(fi, 1);
                // zone에 따라 삽입 위치 결정 + 제거로 인한 인덱스 보정
                let insertIdx = zone === "below" ? ti + 1 : ti;
                if (fi < insertIdx) insertIdx--;
                na.splice(insertIdx, 0, m);
                reorderSubtasks(projectId, pid2, na);
              } else {
                // 다른 레벨 → 타겟의 형제 위치로 이동
                moveTaskBeside(projectId, d.taskId, task.id, zone);
              }
            }
          } catch (err) {}
        }}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "7px 10px", borderRadius: 10,
          border: isInToday && !task.done ? `1.5px solid ${pc.color}88` : `1px solid ${T.border}`,
          background: isScheduled && !task.done ? pc.light + "88" : isInToday && !task.done ? pc.light + "88" : T.surfaceBg,
          marginBottom: 5, minHeight: 42, marginLeft: depth * 20,
          opacity: task.done && !hasChildren ? 0.4 : 1,
          ...(depth > 0 ? { borderLeft: `3px solid ${bc}33` } : {}),
          ...(dropZone === "nest" ? { outline: `2px dashed ${pc.color}`, outlineOffset: -2, background: pc.light + "cc" } : {}),
          cursor: "grab",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, marginRight: 2 }}>
          {hasChildren ? (
            <button style={{ width: 26, height: 26, border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, padding: 0 }}
              onClick={() => setExpanded((p) => ({ ...p, [task.id]: !p[task.id] }))}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.textMut} strokeWidth="2.5" strokeLinecap="round" style={{ transform: isExp ? "rotate(90deg)" : "rotate(0)", transition: "transform .15s" }}><polyline points="9 18 15 12 9 6" /></svg>
            </button>
          ) : (
            <div style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: pc.color }} />
            </div>
          )}
          {editingTask === task.id ? (
            <input autoFocus defaultValue={task.name}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onFocus={(e) => e.target.select()}
              style={{ fontSize: 15, fontWeight: 500, border: `1px solid ${T.primary}`, borderRadius: 6, padding: "3px 8px", outline: "none", flex: 1, minWidth: 0, width: 0, background: T.cardBg, color: T.text }}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== task.name) editSubtask(projectId, task.id, v); setEditingTask(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") { const v = e.target.value.trim(); if (v && v !== task.name) editSubtask(projectId, task.id, v); setEditingTask(null); } if (e.key === "Escape") setEditingTask(null); }} />
          ) : (
            <span
              onDoubleClick={(e) => { e.stopPropagation(); setEditingTask(task.id); }}
              style={{ fontSize: 15, fontWeight: 500, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: task.done && !hasChildren ? "line-through" : "none", cursor: "text" }}>{task.name}</span>
          )}
          {hasDesc && <span style={{ fontSize: 14, cursor: "pointer", opacity: 0.5 }} onClick={() => setExpandedDesc((p) => ({ ...p, [task.id]: !p[task.id] }))}>📋</span>}
          {hasChildren && <span style={{ fontSize: 13, color: T.textMut, background: T.primaryLight, padding: "1px 8px", borderRadius: 10, fontWeight: 600, flexShrink: 0 }}>{countDone(task.children)}/{countAll(task.children)}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          {!task.done && !hasChildren && !isInToday && (() => {
            if (isScheduled) {
              const schedTime = existingSched.time;
              const isPast = existingSched.dateKey < todayKey();
              const badgeColor = isPast ? "#ef4444" : T.accent;
              const badgeBg = isPast ? "#fef2f2" : T.primaryLight;
              return (
                <span style={{ padding: "3px 8px", background: badgeBg, color: badgeColor, borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                  onClick={(e) => { e.stopPropagation(); }}>
                  {existingSched.label}{schedTime ? ` ${schedTime}` : ""}
                </span>
              );
            }
            if (hasNonTodaySelection) return <button style={{ padding: "4px 10px", border: `1.5px solid ${T.accent}`, background: T.cardBg, color: T.accent, borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 600 }} onClick={() => addToScheduled(projectId, task.id, selectedDateKey)}>+{selectedDateLabel}</button>;
            return <button style={{ padding: "4px 10px", border: `1.5px solid ${T.primary}`, background: T.cardBg, color: T.primary, borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 600 }} onClick={() => addToScheduled(projectId, task.id, todayKey())}>+오늘</button>;
          })()}
          {isInToday && !task.done && (() => {
            const tTime = getTaskTime(task.id);
            return (
              <span style={{ padding: "3px 8px", background: pc.light, color: pc.color, borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
                오늘{tTime ? ` ${tTime}` : ""}
              </span>
            );
          })()}
          {task.done && !hasChildren && <span style={{ padding: "3px 8px", background: T.doneBg, color: T.doneText, borderRadius: 6, fontSize: 12, fontWeight: 600 }}>완료</span>}
          <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", borderRadius: 7, fontSize: 15, color: T.textMut, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setModal({ type: "editTask", projectId, taskId: task.id, currentName: task.name, currentDesc: task.description || "", currentTime: task.time || "", currentEndTime: task.endTime || "" })}>✎</button>
          <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", borderRadius: 7, fontSize: 20, color: T.textMut, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setModal({ type: "addSubtask", parentId: task.id })}>+</button>
          <button style={{ width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", borderRadius: 7, fontSize: 15, color: "#ef4444", display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => {
              if (!hasChildren) { deleteSubtask(projectId, task.id); }
              else { setModal({ type: "confirm", message: "하위 업무도 함께 삭제됩니다. 삭제하시겠습니까?", onConfirm: () => { deleteSubtask(projectId, task.id); setModal(null); } }); }
            }}>✕</button>
        </div>
      </div>
      {hasDesc && descExp && (
        <div style={{ fontSize: 14, color: T.textSec, background: T.surfaceBg, borderRadius: 8, padding: "8px 12px", marginBottom: 4, lineHeight: "20px", whiteSpace: "pre-wrap", border: `1px solid ${T.border}`, marginLeft: depth * 20 + 28 }}>{task.description}</div>
      )}
      {hasChildren && isExp && (
        <div style={{ marginTop: 2 }}>
          {task.children.map((c) => (
            <TaskItem
              key={c.id}
              task={c} depth={depth + 1} projectId={projectId} siblings={task.children}
              data={data} T={T}
              expanded={expanded} setExpanded={setExpanded}
              expandedDesc={expandedDesc} setExpandedDesc={setExpandedDesc}
              editingTask={editingTask} setEditingTask={setEditingTask}
              depthColors={depthColors}
              hasNonTodaySelection={hasNonTodaySelection}
              selectedDateKey={selectedDateKey} selectedDateLabel={selectedDateLabel}
              addToScheduled={addToScheduled}
              getScheduledDateForTask={getScheduledDateForTask} getTaskTime={getTaskTime}
              editSubtask={editSubtask} deleteSubtask={deleteSubtask}
              reorderSubtasks={reorderSubtasks} moveTaskUnder={moveTaskUnder} moveTaskBeside={moveTaskBeside} setModal={setModal}
              getColorForProjectId={getColorForProjectId}
            />
          ))}
        </div>
      )}
      {dropZone === "below" && (
        <div style={insertLineStyle("bottom")}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: pc.color, flexShrink: 0 }} />
          <div style={{ flex: 1, height: 2.5, borderRadius: 2, background: pc.color }} />
        </div>
      )}
    </div>
  );
}
