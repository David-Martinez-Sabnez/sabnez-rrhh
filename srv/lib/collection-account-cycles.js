"use strict";

/**
 * Los ciclos de pago de Sabnez son independientes del ciclo comercial del
 * cliente. Un prestador cobra por mes calendario (1-fin de mes) o por el
 * ciclo 16-15. La fecha de ingreso únicamente recorta el primer periodo; no
 * crea un nuevo ciclo anclado a ese día.
 */
function completedCollectionCycles(validFrom, validTo, today, startDay = 1) {
  if (!validFrom || validFrom > today) return [];
  const day = Number(startDay || 1);
  if (![1, 16].includes(day)) {
    throw new RangeError("El ciclo de cuenta de cobro debe iniciar el día 1 o el día 16.");
  }

  const limit = validTo && validTo < today ? validTo : today;
  const result = [];
  let cycle = cycleContaining(validFrom, day);

  for (let index = 0; index < 120 && cycle.start <= limit; index += 1) {
    const start = validFrom > cycle.start ? validFrom : cycle.start;
    const end = limit < cycle.end ? limit : cycle.end;

    // Un vínculo terminado produce un último periodo parcial. Para un vínculo
    // vigente sólo se exponen ciclos cuyo cierre ya ocurrió.
    const closedByTermination = Boolean(validTo && validTo <= cycle.end && validTo <= today);
    if (end >= start && (cycle.end <= today || closedByTermination)) {
      result.push({ start, end, cycleStart: cycle.start, cycleEnd: cycle.end });
    }

    cycle = cycleContaining(addDays(cycle.end, 1), day);
  }

  return result;
}

function collectionCycleContaining(date, startDay = 1) {
  const day = Number(startDay || 1);
  if (![1, 16].includes(day)) {
    throw new RangeError("El ciclo de cuenta de cobro debe iniciar el día 1 o el día 16.");
  }
  return cycleContaining(date, day);
}

function cycleContaining(date, startDay) {
  const [year, month, day] = String(date).split("-").map(Number);
  if (startDay === 1) {
    return {
      start: isoDate(year, month, 1),
      end: isoDate(year, month, daysInMonth(year, month)),
    };
  }

  if (day >= 16) {
    const next = shiftMonth(year, month, 1);
    return { start: isoDate(year, month, 16), end: isoDate(next.year, next.month, 15) };
  }
  const previous = shiftMonth(year, month, -1);
  return { start: isoDate(previous.year, previous.month, 16), end: isoDate(year, month, 15) };
}

function shiftMonth(year, month, offset) {
  const absolute = year * 12 + (month - 1) + offset;
  return { year: Math.floor(absolute / 12), month: (absolute % 12) + 1 };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isoDate(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

module.exports = { completedCollectionCycles, collectionCycleContaining };
