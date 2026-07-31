"use strict";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ESTADOS_CONSUMO_AUSENCIA = new Set([
  "SOLICITADA",
  "APROBADA",
  "FINALIZADA",
]);

const ESTADOS_RESERVA_AUSENCIA = new Set(["SOLICITADA", "APROBADA"]);
const ESTADOS_UTILIZACION_AUSENCIA = new Set(["FINALIZADA"]);

// Cumpleaños se consume desde la aprobación: no depende de que un proceso
// posterior cambie el registro a FINALIZADA.
const ESTADOS_RESERVA_CUMPLEANIOS = new Set(["SOLICITADA"]);
const ESTADOS_UTILIZACION_CUMPLEANIOS = new Set(["APROBADA", "FINALIZADA"]);

const colombianHolidaysCache = new Map();

function parseISODate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatISODate(value) {
  return value.toISOString().slice(0, 10);
}

function isValidISODate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = parseISODate(value);
  return !Number.isNaN(parsed.getTime()) && formatISODate(parsed) === value;
}

function addDays(value, days) {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function differenceInDays(start, end) {
  if (!isValidISODate(start) || !isValidISODate(end) || end <= start) {
    return 0;
  }

  return Math.floor((parseISODate(end) - parseISODate(start)) / MS_PER_DAY);
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return new Date(Date.UTC(year, month - 1, day));
}

function followingMonday(value) {
  const dayOfWeek = value.getUTCDay();
  return addDays(value, (8 - dayOfWeek) % 7);
}

function colombianHolidays(year) {
  if (colombianHolidaysCache.has(year)) {
    return colombianHolidaysCache.get(year);
  }

  const holidays = new Set();
  const addHoliday = (date) => holidays.add(formatISODate(date));
  const fixedDate = (month, day) => new Date(Date.UTC(year, month - 1, day));

  [
    [1, 1],
    [5, 1],
    [7, 20],
    [8, 7],
    [12, 8],
    [12, 25],
  ].forEach(([month, day]) => addHoliday(fixedDate(month, day)));

  const holidaysMovedToMonday = [
    [1, 6],
    [3, 19],
    [6, 29],
    [8, 15],
    [10, 12],
    [11, 1],
    [11, 11],
  ];

  // La Ley 2385 de 2024 agrega esta celebración desde 2026.
  if (year >= 2026) holidaysMovedToMonday.push([7, 9]);

  holidaysMovedToMonday.forEach(([month, day]) => {
    addHoliday(followingMonday(fixedDate(month, day)));
  });

  const easter = easterSunday(year);
  addHoliday(addDays(easter, -3));
  addHoliday(addDays(easter, -2));
  addHoliday(followingMonday(addDays(easter, 39)));
  addHoliday(followingMonday(addDays(easter, 60)));
  addHoliday(followingMonday(addDays(easter, 68)));

  colombianHolidaysCache.set(year, holidays);
  return holidays;
}

function isColombianHoliday(value) {
  return colombianHolidays(value.getUTCFullYear()).has(formatISODate(value));
}

function calcularDiasHabilesColombia(fechaInicio, fechaFin) {
  if (
    !isValidISODate(fechaInicio) ||
    !isValidISODate(fechaFin) ||
    fechaFin < fechaInicio
  ) {
    return 0;
  }

  const start = parseISODate(fechaInicio);
  const end = parseISODate(fechaFin);
  let businessDays = 0;

  for (let current = start; current <= end; current = addDays(current, 1)) {
    const dayOfWeek = current.getUTCDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    if (!isWeekend && !isColombianHoliday(current)) businessDays += 1;
  }

  return businessDays;
}

function tieneSegundos(value) {
  if (!value || typeof value !== "string") return false;
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  return match ? Number(match[3] || 0) !== 0 : false;
}

function minutosDesdeMedianoche(value) {
  if (!value || typeof value !== "string") return null;
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;

  return hours * 60 + minutes + seconds / 60;
}

function normalizarHora(value) {
  const minutes = minutosDesdeMedianoche(value);
  if (minutes === null || tieneSegundos(value)) return null;

  const totalMinutes = Math.trunc(minutes);
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const mins = String(totalMinutes % 60).padStart(2, "0");
  return `${hours}:${mins}:00`;
}

function calcularHorasSolicitadas(horaInicio, horaFin) {
  const inicio = minutosDesdeMedianoche(horaInicio);
  const fin = minutosDesdeMedianoche(horaFin);
  if (inicio === null || fin === null || fin <= inicio) return -1;
  return round2((fin - inicio) / 60);
}

function calcularDiasAnticipacion(
  fechaSolicitud,
  fechaInicio,
  tipoDias = "CALENDARIO",
) {
  if (
    !isValidISODate(fechaSolicitud) ||
    !isValidISODate(fechaInicio) ||
    fechaInicio <= fechaSolicitud
  ) {
    return 0;
  }

  if (tipoDias !== "HABILES") {
    return differenceInDays(fechaSolicitud, fechaInicio);
  }

  const end = parseISODate(fechaInicio);
  let count = 0;

  for (
    let current = addDays(parseISODate(fechaSolicitud), 1);
    current <= end;
    current = addDays(current, 1)
  ) {
    const dayOfWeek = current.getUTCDay();
    if (
      dayOfWeek !== 0 &&
      dayOfWeek !== 6 &&
      !isColombianHoliday(current)
    ) {
      count += 1;
    }
  }

  return count;
}

function obtenerInicioSemanaISO(fecha) {
  if (!isValidISODate(fecha)) return null;
  const value = parseISODate(fecha);
  const dayOfWeek = value.getUTCDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  return formatISODate(addDays(value, -daysFromMonday));
}

function obtenerFinSemanaISO(fecha) {
  const inicio = obtenerInicioSemanaISO(fecha);
  return inicio ? formatISODate(addDays(parseISODate(inicio), 6)) : null;
}

function fechasSeCruzan(inicio1, fin1, inicio2, fin2) {
  return inicio1 <= fin2 && fin1 >= inicio2;
}

function horasSeCruzan(inicio1, fin1, inicio2, fin2) {
  const start1 = minutosDesdeMedianoche(inicio1);
  const end1 = minutosDesdeMedianoche(fin1);
  const start2 = minutosDesdeMedianoche(inicio2);
  const end2 = minutosDesdeMedianoche(fin2);

  if ([start1, end1, start2, end2].some((value) => value === null)) {
    return true;
  }

  return start1 < end2 && end1 > start2;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function obtenerCumpleaniosEnAnio(fechaNacimiento, year) {
  if (!isValidISODate(fechaNacimiento) || !Number.isInteger(year)) return null;

  const month = Number(fechaNacimiento.slice(5, 7));
  let day = Number(fechaNacimiento.slice(8, 10));
  if (month === 2 && day === 29 && !isLeapYear(year)) day = 28;

  const result = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isValidISODate(result) ? result : null;
}

function obtenerVentanaCumpleanios(fechaNacimiento, year) {
  const fechaCumpleanios = obtenerCumpleaniosEnAnio(fechaNacimiento, year);
  if (!fechaCumpleanios) return null;

  return {
    anioOcurrencia: year,
    fechaCumpleanios,
    semanaInicio: obtenerInicioSemanaISO(fechaCumpleanios),
    semanaFin: obtenerFinSemanaISO(fechaCumpleanios),
  };
}

function obtenerOcurrenciaCumpleaniosParaFecha(fechaNacimiento, fechaElegida) {
  if (!isValidISODate(fechaNacimiento) || !isValidISODate(fechaElegida)) {
    return null;
  }

  const selectedYear = Number(fechaElegida.slice(0, 4));
  for (const candidateYear of [selectedYear - 1, selectedYear, selectedYear + 1]) {
    const window = obtenerVentanaCumpleanios(fechaNacimiento, candidateYear);
    if (
      window &&
      fechaElegida >= window.semanaInicio &&
      fechaElegida <= window.semanaFin
    ) {
      return window;
    }
  }

  return null;
}

function obtenerProximaVentanaCumpleanios(fechaNacimiento, fechaReferencia) {
  if (!isValidISODate(fechaNacimiento) || !isValidISODate(fechaReferencia)) {
    return null;
  }

  const referenceYear = Number(fechaReferencia.slice(0, 4));
  const previous = obtenerVentanaCumpleanios(
    fechaNacimiento,
    referenceYear - 1,
  );
  if (
    previous &&
    fechaReferencia >= previous.semanaInicio &&
    fechaReferencia <= previous.semanaFin
  ) {
    return previous;
  }

  const current = obtenerVentanaCumpleanios(fechaNacimiento, referenceYear);
  if (current && fechaReferencia <= current.semanaFin) return current;

  return obtenerVentanaCumpleanios(fechaNacimiento, referenceYear + 1);
}

function obtenerVentanaCumpleaniosAnioActual(
  fechaNacimiento,
  fechaReferencia,
) {
  if (!isValidISODate(fechaReferencia)) return null;
  return obtenerVentanaCumpleanios(
    fechaNacimiento,
    Number(fechaReferencia.slice(0, 4)),
  );
}

function todayInColombia(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

module.exports = {
  ESTADOS_CONSUMO_AUSENCIA,
  ESTADOS_RESERVA_AUSENCIA,
  ESTADOS_RESERVA_CUMPLEANIOS,
  ESTADOS_UTILIZACION_AUSENCIA,
  ESTADOS_UTILIZACION_CUMPLEANIOS,
  addDays,
  calcularDiasAnticipacion,
  calcularDiasHabilesColombia,
  calcularHorasSolicitadas,
  fechasSeCruzan,
  formatISODate,
  horasSeCruzan,
  isColombianHoliday,
  isValidISODate,
  normalizarHora,
  obtenerCumpleaniosEnAnio,
  obtenerFinSemanaISO,
  obtenerInicioSemanaISO,
  obtenerOcurrenciaCumpleaniosParaFecha,
  obtenerProximaVentanaCumpleanios,
  obtenerVentanaCumpleaniosAnioActual,
  obtenerVentanaCumpleanios,
  parseISODate,
  round2,
  tieneSegundos,
  todayInColombia,
};
