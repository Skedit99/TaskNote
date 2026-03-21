export default function WinControls({ mini, T, handleMinimize, handleMaximize, handleClose }) {
  return (
    <div style={{ display: "flex", WebkitAppRegion: "no-drag" }}>
      <button onClick={handleMinimize} style={{ width: mini ? 32 : 40, height: mini ? 28 : 32, border: "none", background: "transparent", color: T.textSec, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}
        onMouseEnter={(e) => (e.currentTarget.style.background = T.winCtrlHover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>─</button>
      {!mini && (
        <button onClick={handleMaximize} style={{ width: 40, height: 32, border: "none", background: "transparent", color: T.textSec, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}
          onMouseEnter={(e) => (e.currentTarget.style.background = T.winCtrlHover)}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>☐</button>
      )}
      <button onClick={handleClose} style={{ width: mini ? 32 : 40, height: mini ? 28 : 32, border: "none", background: "transparent", color: T.textSec, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, borderRadius: mini ? "0 10px 0 0" : "0" }}
        onMouseEnter={(e) => { e.currentTarget.style.background = T.winCloseHover; e.currentTarget.style.color = T.winCloseText; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.textSec; }}>✕</button>
    </div>
  );
}
