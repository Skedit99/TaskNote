import { isElectron } from "../constants";

export default function ResizeEdges() {
  const EDGE = 6;
  const startResize = (dir) => (e) => {
    if (!isElectron) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.screenX, startY = e.screenY;
    let bounds = null;
    window.electronAPI.getBounds().then((b) => { bounds = b; });
    const onMove = (ev) => {
      if (!bounds) return;
      const dx = ev.screenX - startX, dy = ev.screenY - startY;
      const nb = { ...bounds };
      if (dir.includes("r")) nb.width = Math.max(340, bounds.width + dx);
      if (dir.includes("l")) { nb.x = bounds.x + dx; nb.width = Math.max(340, bounds.width - dx); }
      if (dir.includes("b")) nb.height = Math.max(300, bounds.height + dy);
      if (dir.includes("t")) { nb.y = bounds.y + dy; nb.height = Math.max(300, bounds.height - dy); }
      window.electronAPI.setBounds(nb);
    };
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const base = { position: "absolute", zIndex: 9999, WebkitAppRegion: "no-drag" };
  return (
    <>
      <div style={{ ...base, top: 0, left: EDGE, right: EDGE, height: EDGE, cursor: "n-resize" }} onMouseDown={startResize("t")} />
      <div style={{ ...base, bottom: 0, left: EDGE, right: EDGE, height: EDGE, cursor: "s-resize" }} onMouseDown={startResize("b")} />
      <div style={{ ...base, top: EDGE, bottom: EDGE, left: 0, width: EDGE, cursor: "w-resize" }} onMouseDown={startResize("l")} />
      <div style={{ ...base, top: EDGE, bottom: EDGE, right: 0, width: EDGE, cursor: "e-resize" }} onMouseDown={startResize("r")} />
      <div style={{ ...base, top: 0, left: 0, width: EDGE + 2, height: EDGE + 2, cursor: "nw-resize" }} onMouseDown={startResize("tl")} />
      <div style={{ ...base, top: 0, right: 0, width: EDGE + 2, height: EDGE + 2, cursor: "ne-resize" }} onMouseDown={startResize("tr")} />
      <div style={{ ...base, bottom: 0, left: 0, width: EDGE + 2, height: EDGE + 2, cursor: "sw-resize" }} onMouseDown={startResize("bl")} />
      <div style={{ ...base, bottom: 0, right: 0, width: EDGE + 2, height: EDGE + 2, cursor: "se-resize" }} onMouseDown={startResize("br")} />
      <div style={{ ...base, bottom: 2, right: 4, width: 14, height: 14, cursor: "se-resize", opacity: 0.25, pointerEvents: "none" }}>
        <svg width="14" height="14" viewBox="0 0 14 14"><path d="M12 2L2 12M12 6L6 12M12 10L10 12" stroke="#888" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </div>
    </>
  );
}
