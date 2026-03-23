import { isElectron } from "../constants";

export function createElectronWindowActions({
  miniMode, setMiniMode, isLocked, setIsLocked, setIsHovered,
  miniSettings, setMiniSettings, currentMiniKey,
  windowMode, setWindowMode,
  setSideTab, setActiveProject,
  hoverTimer, miniBoundsRef,
}) {
  const handleMiniMode = async (type) => {
    if (miniMode && isElectron) {
      try {
        const b = await window.electronAPI.getBounds();
        miniBoundsRef.current[miniMode] = b;
      } catch (e) {}
    }
    setMiniMode(type);
    if (isElectron) {
      await window.electronAPI.setMiniMode(type);
      if (type) {
        if (windowMode === "alwaysOnTop") await window.electronAPI.setAlwaysOnTop(true);
        else if (windowMode === "widget") await window.electronAPI.setWindowLevel("widget");
        else await window.electronAPI.setAlwaysOnTop(false);
      } else {
        await window.electronAPI.setAlwaysOnTop(false);
        if (windowMode === "widget") await window.electronAPI.setWindowLevel("normal");
      }
      if (type && miniBoundsRef.current[type]) {
        try { await window.electronAPI.setBounds(miniBoundsRef.current[type]); } catch (e) {}
      }
    }
    if (type) { setSideTab(null); setActiveProject(null); }
    setIsHovered(true);
  };

  const handleWindowMode = async (mode) => {
    setWindowMode(mode);
    if (isElectron && miniMode) {
      if (mode === "alwaysOnTop") {
        await window.electronAPI.setWindowLevel("normal");
        await window.electronAPI.setAlwaysOnTop(true);
      } else if (mode === "widget") {
        await window.electronAPI.setAlwaysOnTop(false);
        await window.electronAPI.setWindowLevel("widget");
      } else {
        await window.electronAPI.setAlwaysOnTop(false);
        await window.electronAPI.setWindowLevel("normal");
      }
    }
  };

  const handleBgOpacity = (v) => {
    const val = parseFloat(v);
    setMiniSettings((prev) => ({ ...prev, [currentMiniKey]: { ...prev[currentMiniKey], bgOpacity: val } }));
  };

  const handleCardOpacity = (v) => {
    const val = parseFloat(v);
    setMiniSettings((prev) => ({ ...prev, [currentMiniKey]: { ...prev[currentMiniKey], cardOpacity: val } }));
  };

  const handleLock = async () => {
    const next = !isLocked;
    setIsLocked(next);
    if (isElectron) await window.electronAPI.setLocked(next);
    if (!next) setIsHovered(true);
  };

  const handleMinimize = () => { if (isElectron) window.electronAPI.minimize(); };
  const handleMaximize = () => { if (isElectron) window.electronAPI.maximize(); };
  const handleClose = () => { if (isElectron) window.electronAPI.close(); };

  const onMouseEnter = () => { clearTimeout(hoverTimer.current); setIsHovered(true); };
  const onMouseLeave = () => { if (isLocked && miniMode) { hoverTimer.current = setTimeout(() => setIsHovered(false), 600); } };

  return {
    handleMiniMode, handleWindowMode, handleBgOpacity, handleCardOpacity,
    handleLock, handleMinimize, handleMaximize, handleClose,
    onMouseEnter, onMouseLeave,
  };
}
