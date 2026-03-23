import { DAYS_KR } from "../constants";

export const generateId = () => crypto.randomUUID();

export const fmtDate = (d) => {
  if (!d) return "";
  const dt = new Date(d);
  return `${dt.getFullYear()}.${String(dt.getMonth() + 1).padStart(2, "0")}.${String(dt.getDate()).padStart(2, "0")} (${DAYS_KR[dt.getDay()]})`;
};

export const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const getDday = (dl) => {
  if (!dl) return null;
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  const tg = new Date(dl);
  tg.setHours(0, 0, 0, 0);
  const diff = Math.ceil((tg - t) / 86400000);
  return diff === 0 ? "D-Day" : diff > 0 ? `D-${diff}` : `D+${Math.abs(diff)}`;
};

export const countAll = (st) => {
  let t = 0;
  for (const s of st) t += s.children?.length ? countAll(s.children) : 1;
  return t;
};

export const countDone = (st) => {
  let d = 0;
  for (const s of st) d += s.children?.length ? countDone(s.children) : s.done ? 1 : 0;
  return d;
};

export const findTaskById = (st, id) => {
  for (const s of st) {
    if (s.id === id) return s;
    if (s.children) {
      const r = findTaskById(s.children, id);
      if (r) return r;
    }
  }
  return null;
};

export const findParentArray = (st, pid) => {
  if (!pid) return st;
  for (const s of st) {
    if (s.id === pid) {
      if (!s.children) s.children = [];
      return s.children;
    }
    if (s.children) {
      const r = findParentArray(s.children, pid);
      if (r) return r;
    }
  }
  return null;
};

export const removeTaskById = (st, id) => {
  for (let i = 0; i < st.length; i++) {
    if (st[i].id === id) {
      st.splice(i, 1);
      return true;
    }
    if (st[i].children && removeTaskById(st[i].children, id)) return true;
  }
  return false;
};

export const isDescendant = (draggedId, targetId, tree) => {
  const node = findTaskById(tree, draggedId);
  if (!node || !node.children) return false;
  const check = (children) => {
    for (const c of children) {
      if (c.id === targetId) return true;
      if (c.children && check(c.children)) return true;
    }
    return false;
  };
  return check(node.children);
};

export const weeksBetween = (d1, d2) => {
  const a = new Date(d1);
  a.setHours(0, 0, 0, 0);
  const b = new Date(d2);
  b.setHours(0, 0, 0, 0);
  return Math.floor((b - a) / 86400000 / 7);
};
