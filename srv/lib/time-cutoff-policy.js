"use strict";

function addMonths(value, months) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

function monthStart(value) {
  return `${String(value).slice(0, 7)}-01`;
}

function cutoffInMonth(value, requestedDay) {
  const source = new Date(`${value}T00:00:00Z`);
  const year = source.getUTCFullYear();
  const month = source.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(Math.max(Number(requestedDay) || 31, 1), lastDay);
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

function nextMonthlyCutoff(value, requestedDay) {
  const current = cutoffInMonth(value, requestedDay);
  return value <= current ? current : cutoffInMonth(addMonths(value, 1), requestedDay);
}

function previousMonthlyCutoff(cutoff, requestedDay) {
  return cutoffInMonth(addMonths(monthStart(cutoff), -1), requestedDay);
}

function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
}

/**
 * Ciclos que el job debe revisar en una fecha determinada.
 *
 * - El ciclo que cierra entre hoy y dentro de tres días genera recordatorio.
 * - El último ciclo ya cerrado genera alerta urgente.
 * - Los incumplimientos abiertos se siguen revisando aunque pertenezcan a un
 *   ciclo anterior; así el cambio de mes no silencia una deuda sin corregir.
 */
function cutoffCyclesForDate({ referenceDate, cutoffDay, projectActive = true, openCutoffs = [] }) {
  const cycles = new Map();
  const add = (cutoff, phase) => {
    if (!cutoff) return;
    const current = cycles.get(cutoff);
    if (!current || phase === "OVERDUE") cycles.set(cutoff, { cutoff, phase });
  };

  if (projectActive) {
    const upcoming = nextMonthlyCutoff(referenceDate, cutoffDay);
    const daysUntil = daysBetween(referenceDate, upcoming);
    if (daysUntil >= 0 && daysUntil <= 3) add(upcoming, "UPCOMING");

    const currentMonthCutoff = cutoffInMonth(referenceDate, cutoffDay);
    const mostRecentClosed = referenceDate > currentMonthCutoff
      ? currentMonthCutoff
      : previousMonthlyCutoff(currentMonthCutoff, cutoffDay);
    if (mostRecentClosed < referenceDate) add(mostRecentClosed, "OVERDUE");
  }

  for (const cutoff of openCutoffs) {
    if (cutoff < referenceDate) add(cutoff, "OVERDUE");
  }

  return [...cycles.values()].sort((a, b) => a.cutoff.localeCompare(b.cutoff));
}

module.exports = {
  cutoffInMonth,
  nextMonthlyCutoff,
  previousMonthlyCutoff,
  daysBetween,
  cutoffCyclesForDate,
};
