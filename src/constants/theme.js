export const THEMES = {
  light: {
    name: "라이트", key: "light",
    primary: "#5b6cf7", accent: "#7c5cf7", primaryLight: "#eef0ff",
    bgGrad: "linear-gradient(145deg,#f5f6fa,#edeef5,#f7f5fa)", headerBg: "rgba(255,255,255,0.88)", panelBg: "rgba(255,255,255,0.94)",
    cardBg: "#ffffff", surfaceBg: "#f8f9fc", text: "#1a1a2e", textSec: "#5a6070", textMut: "#9ca3af",
    border: "#e8eaf0", inputBorder: "#dde0e7", calBg: "rgba(255,255,255,0.65)", progBg: "#edeef5",
    doneBg: "#d1fae5", doneText: "#059669", warnBg: "#fef3c7", warnText: "#d97706",
    winCtrlHover: "#e5e7eb", winCloseHover: "#e81123", winCloseText: "white",
  },
  dark: {
    name: "다크", key: "dark",
    primary: "#818cf8", accent: "#a78bfa", primaryLight: "#252550",
    bgGrad: "linear-gradient(145deg,#111118,#171725,#1a1a30)", headerBg: "rgba(18,18,30,0.94)", panelBg: "rgba(24,24,42,0.94)",
    cardBg: "#1c1c32", surfaceBg: "#22223a", text: "#e8eaf3", textSec: "#a0a4c0", textMut: "#6b7290",
    border: "#2a2a45", inputBorder: "#383855", calBg: "rgba(22,22,38,0.75)", progBg: "#2a2a45",
    doneBg: "#064e3b", doneText: "#6ee7b7", warnBg: "#78350f", warnText: "#fbbf24",
    winCtrlHover: "#3a3a55", winCloseHover: "#e81123", winCloseText: "white",
  },
};

export const PROJECT_COLORS = [
  { id: "blue", color: "#5b6cf7", light: "#eef0ff", dark: "#1e2254", name: "블루" },
  { id: "red", color: "#e74c3c", light: "#fde8e8", dark: "#3b1515", name: "레드" },
  { id: "green", color: "#10b981", light: "#d1fae5", dark: "#0c3326", name: "그린" },
  { id: "orange", color: "#f59e0b", light: "#fef3c7", dark: "#3b2a0a", name: "오렌지" },
  { id: "purple", color: "#8b5cf6", light: "#ede9fe", dark: "#2a1a4e", name: "퍼플" },
  { id: "pink", color: "#ec4899", light: "#fce7f3", dark: "#3b1530", name: "핑크" },
  { id: "brown", color: "#a16207", light: "#fef9c3", dark: "#33250a", name: "브라운" },
];

export const getProjectColor = (proj, isDark = false) => {
  if (!proj) return { color: "#9ca3af", light: isDark ? "#2a2a3a" : "#f3f4f6" };
  if (proj.archived) return { color: "#9ca3af", light: isDark ? "#2a2a3a" : "#f3f4f6" };
  const pc = PROJECT_COLORS.find((c) => c.id === proj.colorId);
  const found = pc || PROJECT_COLORS[0];
  return { color: found.color, light: isDark ? found.dark : found.light };
};
