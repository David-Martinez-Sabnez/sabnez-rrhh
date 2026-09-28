"use strict";

const cds = require("@sap/cds");
const { SELECT } = cds.ql;
const DAY_FIELDS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function iso(value) { return value ? String(value).slice(0, 10) : null; }
function addDays(value, amount) {
  const date = new Date(`${iso(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

async function loadCalendars(calendarIDs) {
  const ids = [...new Set((calendarIDs || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const calendars = cds.entities("sabnez.calendars");
  const [rows, holidays] = await Promise.all([
    SELECT.from(calendars.WorkCalendars).where({ ID: { in: ids }, active: true }),
    SELECT.from(calendars.Holidays).where({ calendar_ID: { in: ids }, active: true }),
  ]);
  const byID = new Map(rows.map((row) => [row.ID, { ...row, holidays: new Map() }]));
  for (const holiday of holidays) {
    const calendar = byID.get(holiday.calendar_ID);
    if (!calendar) continue;
    const date = iso(holiday.date);
    if (!calendar.holidays.has(date)) calendar.holidays.set(date, []);
    calendar.holidays.get(date).push(holiday);
  }
  return byID;
}

function isWorkingDay(calendar, value) {
  const date = iso(value);
  if (!calendar || !date) return false;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return Boolean(calendar[DAY_FIELDS[day]]) && !calendar.holidays.has(date);
}

function businessDaysBetween(calendar, from, to) {
  let total = 0;
  for (let date = iso(from); date && date <= iso(to); date = addDays(date, 1)) {
    if (isWorkingDay(calendar, date)) total += 1;
  }
  return total;
}

function nonWorkingDays(calendars, from, to) {
  const result = new Map();
  for (const calendar of calendars || []) {
    for (let date = iso(from); date && date <= iso(to); date = addDays(date, 1)) {
      const day = new Date(`${date}T00:00:00Z`).getUTCDay();
      const holidays = calendar.holidays.get(date) || [];
      if (holidays.length) {
        const labels = holidays.map((h) => `${h.name} (${calendar.countryCode})`);
        const current = result.get(date);
        const merged = [...new Set([...(current?.labels || []), ...labels])];
        result.set(date, { fecha: date, tipo: "HOLIDAY", motivo: merged.join(" · "), labels: merged });
      } else if (!calendar[DAY_FIELDS[day]] && !result.has(date)) {
        result.set(date, { fecha: date, tipo: "WEEKEND", motivo: day === 6 ? "Sábado" : day === 0 ? "Domingo" : "Día no laborable" });
      }
    }
  }
  return [...result.values()].map(({ labels, ...row }) => row).sort((a, b) => a.fecha.localeCompare(b.fecha));
}

module.exports = { loadCalendars, isWorkingDay, businessDaysBetween, nonWorkingDays };
