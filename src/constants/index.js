export const STORAGE_KEY = "task-manager-data-v9";
export const THEME_KEY = "task-manager-theme";
export const MINI_SETTINGS_KEY = "task-manager-mini-settings";
export const CAL_RANGE_KEY = "task-manager-cal-range";
export const WINDOW_MODE_KEY = "task-manager-window-mode";
export const MAX_ACTIVE_PROJECTS = 7;
export const DAYS_KR = ["일", "월", "화", "수", "목", "금", "토"];

export const defaultData = {
  projects: [],
  todayTasks: [],
  completedToday: {},
  recurring: [],
  recurringSkips: {},
  recurringAdds: {},
  scheduled: {},
  events: [],
  quickTasks: [],
};

export const defaultMiniSettings = {
  today: { bgOpacity: 1, cardOpacity: 1 },
  calendar: { bgOpacity: 1, cardOpacity: 1 },
};

export const isElectron =
  typeof window !== "undefined" && window.electronAPI;
