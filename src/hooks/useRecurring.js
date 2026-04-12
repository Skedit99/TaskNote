import { generateId, todayKey, weeksBetween } from "../utils/helpers";
import { getRecurringItemsForDate } from "../utils/selectors";

// nth weekday helper: N번째 주 특정 요일의 날짜 (없으면 null)
function getNthWeekdayOfMonth(year, month, nthWeek, dayOfWeek) {
  const firstDay = new Date(year, month, 1);
  let firstOccurrence = firstDay.getDay() <= dayOfWeek
    ? 1 + (dayOfWeek - firstDay.getDay())
    : 1 + (7 - firstDay.getDay() + dayOfWeek);
  const targetDay = firstOccurrence + (nthWeek - 1) * 7;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return targetDay <= lastDay ? targetDay : null;
}

function pushRecurringFutureDates(gcal, recId, name, type, dayValue, time, interval, startDate, endDate, monthlyOpts, completedToday) {
  const isCompletedForDate = (dateKey) => {
    if (!completedToday) return false;
    return (completedToday[dateKey] || []).some((c) => c.taskId === recId && c.projectId === "recurring");
  };
  const pad = (n) => String(n).padStart(2, "0");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const maxDate = new Date(today); maxDate.setMonth(maxDate.getMonth() + 6);
  const limit = endDate ? new Date(endDate + "T23:59:59") : maxDate;
  const startFrom = startDate ? new Date(startDate) : today;
  const cursor = new Date(Math.max(today.getTime(), startFrom.getTime()));

  if (type === "weekly") {
    while (cursor.getDay() !== dayValue && cursor <= limit) cursor.setDate(cursor.getDate() + 1);
    const intv = interval || 1;
    if (intv > 1 && startDate) {
      const ref = new Date(startDate); ref.setHours(0, 0, 0, 0);
      while (ref.getDay() !== dayValue) ref.setDate(ref.getDate() + 1);
      const diffWeeks = Math.floor((cursor - ref) / 86400000 / 7);
      const rem = diffWeeks % intv;
      if (rem !== 0) cursor.setDate(cursor.getDate() + (intv - rem) * 7);
    }
    while (cursor <= limit) {
      const dateKey = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`;
      const isDone = isCompletedForDate(dateKey);
      const summary = isDone ? `(완료) ${name}` : name;
      gcal.create({ localId: `recurring:${recId}:${dateKey}`, summary, description: "", date: dateKey, time: time || "", type: "recurring" });
      cursor.setDate(cursor.getDate() + (intv * 7));
    }
  } else if (type === "monthly") {
    const isNthWeekday = monthlyOpts?.monthlyMode === "nthWeekday";
    cursor.setDate(1);
    while (cursor <= limit) {
      let targetDay;
      if (isNthWeekday) {
        targetDay = getNthWeekdayOfMonth(cursor.getFullYear(), cursor.getMonth(), monthlyOpts.nthWeek, monthlyOpts.nthDayOfWeek);
      } else {
        const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
        targetDay = dayValue === -1 ? lastDay : (dayValue <= lastDay ? dayValue : null);
      }
      if (targetDay) {
        const d = new Date(cursor.getFullYear(), cursor.getMonth(), targetDay);
        if (d >= today && d <= limit) {
          const dateKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
          const isDone = isCompletedForDate(dateKey);
          const summary = isDone ? `(완료) ${name}` : name;
          gcal.create({ localId: `recurring:${recId}:${dateKey}`, summary, description: "", date: dateKey, time: time || "", type: "recurring" });
        }
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }
}

export function createRecurringActions({ data, updateData, gcal }) {
  const addRecurring = (name, type, dayValue, time, interval, startDate, endDate, monthlyOpts) => {
    const recId = generateId();
    updateData((d) => {
      const entry = { id: recId, name, type, dayValue, time: time || "", interval: interval || 1, startDate: startDate || todayKey(), active: true, updatedAt: Date.now() };
      if (endDate) entry.endDate = endDate;
      if (type === "monthly" && monthlyOpts?.monthlyMode === "nthWeekday") {
        entry.monthlyMode = "nthWeekday"; entry.nthWeek = monthlyOpts.nthWeek; entry.nthDayOfWeek = monthlyOpts.nthDayOfWeek;
      }
      d.recurring.push(entry);
    });
    pushRecurringFutureDates(gcal, recId, name, type, dayValue, time, interval, startDate || todayKey(), endDate, monthlyOpts, null);
  };

  const editRecurring = (id, name, dayValue, time, interval, startDate, endDate, monthlyOpts) => {
    const oldRec = data.recurring.find((x) => x.id === id);
    updateData((d) => {
      const r = d.recurring.find((x) => x.id === id);
      if (r) {
        r.name = name; r.dayValue = dayValue; r.time = time || ""; r.interval = interval || 1;
        r.startDate = startDate || r.startDate || todayKey(); r.updatedAt = Date.now();
        if (endDate) r.endDate = endDate; else delete r.endDate;
        if (r.type === "monthly" && monthlyOpts?.monthlyMode === "nthWeekday") {
          r.monthlyMode = "nthWeekday"; r.nthWeek = monthlyOpts.nthWeek; r.nthDayOfWeek = monthlyOpts.nthDayOfWeek;
        } else { delete r.monthlyMode; delete r.nthWeek; delete r.nthDayOfWeek; }
      }
    });
    if (oldRec) {
      const pad = (n) => String(n).padStart(2, "0");
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const oldMax = new Date(today); oldMax.setMonth(oldMax.getMonth() + 6);
      const oldLimit = oldRec.endDate ? new Date(oldRec.endDate + "T23:59:59") : oldMax;
      const delIds = [];
      const cursor = new Date(today);
      while (cursor <= oldLimit && cursor <= oldMax) {
        const dateKey = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`;
        delIds.push(`recurring:${id}:${dateKey}`);
        cursor.setDate(cursor.getDate() + 1);
      }
      if (delIds.length > 0) gcal.delMultiple(delIds);
    }
    pushRecurringFutureDates(gcal, id, name, oldRec?.type || "weekly", dayValue, time, interval, startDate || todayKey(), endDate, monthlyOpts, data.completedToday);
  };

  const deleteRecurring = (id) => {
    const oldRec = data.recurring.find((x) => x.id === id);
    updateData((d) => { d.recurring = d.recurring.filter((r) => r.id !== id); });
    const pad = (n) => String(n).padStart(2, "0");
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const maxDate = new Date(today); maxDate.setMonth(maxDate.getMonth() + 6);
    const limit = oldRec?.endDate ? new Date(oldRec.endDate + "T23:59:59") : maxDate;
    const delIds = [];
    const cursor = new Date(today);
    while (cursor <= limit && cursor <= maxDate) {
      const dateKey = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`;
      delIds.push(`recurring:${id}:${dateKey}`);
      cursor.setDate(cursor.getDate() + 1);
    }
    if (delIds.length > 0) gcal.delMultiple(delIds);
  };

  const toggleRecurring = (id) => updateData((d) => { const r = d.recurring.find((x) => x.id === id); if (r) { r.active = !r.active; r.updatedAt = Date.now(); } });

  const skipRecurringForDate = (dateKey, recurringId) => {
    updateData((d) => {
      if (!d.recurringSkips) d.recurringSkips = {};
      if (!d.recurringSkips[dateKey]) d.recurringSkips[dateKey] = [];
      if (!d.recurringSkips[dateKey].includes(recurringId)) d.recurringSkips[dateKey].push(recurringId);
      if (d.recurringAdds?.[dateKey]) {
        d.recurringAdds[dateKey] = d.recurringAdds[dateKey].filter((id) => id !== recurringId);
        if (d.recurringAdds[dateKey].length === 0) delete d.recurringAdds[dateKey];
      }
    });
    gcal.del(`recurring:${recurringId}:${dateKey}`);
  };

  const addRecurringToDate = (rec, dateKey) => {
    if (!rec.active) return;
    updateData((d) => {
      if (!d.recurringAdds) d.recurringAdds = {};
      if (!d.recurringAdds[dateKey]) d.recurringAdds[dateKey] = [];
      if (d.recurringAdds[dateKey].includes(rec.id)) return;
      d.recurringAdds[dateKey].push(rec.id);
      if (d.recurringSkips?.[dateKey]) {
        d.recurringSkips[dateKey] = d.recurringSkips[dateKey].filter((id) => id !== rec.id);
        if (d.recurringSkips[dateKey].length === 0) delete d.recurringSkips[dateKey];
      }
    });
    gcal.create({ localId: `recurring:${rec.id}:${dateKey}`, summary: rec.name, description: "", date: dateKey, time: rec.time || "", type: "recurring" });
  };

  const getRecurringForDay = (day, year, month, calYear, calMonth) => {
    if (!day) return [];
    const y = year !== undefined ? year : calYear;
    const m = month !== undefined ? month : calMonth;
    const dateKey = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return getRecurringItemsForDate(data, dateKey);
  };

  const cleanupExpiredRecurring = () => {
    const today = todayKey();
    const expired = data.recurring.filter((r) => r.endDate && r.endDate < today);
    if (expired.length === 0) return;
    updateData((d) => {
      d.recurring = d.recurring.filter((r) => !r.endDate || r.endDate >= today);
    });
    expired.forEach((r) => {
      const compositeId = `recurring:${r.id}:${today}`;
      gcal.del(compositeId);
    });
  };

  return {
    addRecurring, editRecurring, deleteRecurring, toggleRecurring,
    addRecurringToDate, skipRecurringForDate,
    getRecurringForDay, cleanupExpiredRecurring,
  };
}
