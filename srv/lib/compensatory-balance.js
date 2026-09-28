"use strict";

/**
 * La bolsa de compensatorios.
 *
 * Cuando un recurso trabaja un sábado que el cliente no aprueba como
 * facturable, esas horas no se cobran pero se le siguen debiendo a la
 * persona. Hasta ahora esa deuda se veía como una brecha en el tablero y
 * ahí se quedaba: no había forma de saldarla ni de saber cuánto se le
 * debe a cada quien.
 *
 * El saldo no se guarda como un número: se calcula sumando movimientos.
 * Un campo "saldo" hay que mantenerlo al día y tarde o temprano queda
 * desalineado de lo que lo produjo; una suma de filas no puede.
 */

// Sólo se compensa lo que se trabajó por encima de la jornada. Ocho horas
// regulares en un proyecto interno no se cobran pero tampoco se deben: la
// persona está en nómina.
const TIPOS_COMPENSABLES = new Set([
  "OVERTIME",
  "NIGHT",
  "SUNDAY",
  "HOLIDAY",
  "COMPENSATORY",
]);

// Un registro sólo genera saldo cuando ya pasó la revisión. Antes de eso
// todavía puede cambiar de horas o de tipo.
const ESTADOS_FIRMES = new Set([
  "INTERNALLY_APPROVED",
  "CORRECTED",
  "CLOSED",
  "INVOICED",
]);

const CODIGO_AUSENCIA = "CO";

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  const n = num(value);
  const signo = n < 0 ? -1 : 1;
  return signo * Math.round(Math.abs(n) * 100 + Number.EPSILON * 100) / 100;
}

function iso(value) {
  return value ? String(value).slice(0, 10) : null;
}

/**
 * Cuántas horas de compensatorio genera un registro de tiempo.
 *
 * Es la diferencia entre lo que se le reconoce al recurso y lo que se le
 * cobra al cliente, y sólo cuando fue tiempo por encima de la jornada o
 * cuando alguien corrigió a mano la facturabilidad —ahí la hora se
 * trabajó esperando cobrarla y el cliente la rechazó después.
 */
function earnedFromEntry(entry) {
  const e = entry || {};
  if (!ESTADOS_FIRMES.has(e.status)) return 0;

  const manual = Boolean(e.treatmentOverride);
  const tipo = String(e.requestedType || "").toUpperCase();
  if (!manual && !TIPOS_COMPENSABLES.has(tipo)) return 0;

  return round2(Math.max(0, num(e.payableHours) - num(e.billableHours)));
}

/**
 * Los movimientos que hay que asentar por un lote de registros, sin
 * repetir los que ya están en el libro.
 *
 * Reprocesar un mes entero dos veces no puede duplicarle el saldo a
 * nadie, así que se compara contra lo ya asentado por ese mismo registro
 * y sólo se apunta la diferencia.
 */
function accrualsFor({ entries, ledger }) {
  const yaAsentado = new Map();
  for (const fila of Array.isArray(ledger) ? ledger : []) {
    if (fila.origin !== "EARNED" || !fila.timeEntry_ID) continue;
    yaAsentado.set(
      fila.timeEntry_ID,
      round2(num(yaAsentado.get(fila.timeEntry_ID)) + num(fila.hours)),
    );
  }

  const movimientos = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const ganadas = earnedFromEntry(entry);
    const asentadas = num(yaAsentado.get(entry.ID));
    const diferencia = round2(ganadas - asentadas);
    if (diferencia === 0) continue;
    movimientos.push({
      employee_ID: entry.employee_ID,
      entryDate: iso(entry.workDate),
      hours: diferencia,
      origin: diferencia > 0 ? "EARNED" : "ADJUST",
      timeEntry_ID: entry.ID,
      reason:
        diferencia > 0
          ? "Horas reconocidas al recurso que no se le cobran al cliente."
          : "Ajuste: el registro cambió después de haberse asentado.",
    });
  }
  return movimientos;
}

/**
 * Los movimientos por el tiempo que la gente ya tomó.
 *
 * Sólo cuentan las ausencias aprobadas del tipo compensatorio. Una
 * solicitud en borrador o rechazada no puede bajar el saldo.
 */
function consumptionsFor({ absences, ledger }) {
  const yaAsentado = new Set(
    (Array.isArray(ledger) ? ledger : [])
      .filter((f) => f.origin === "TAKEN" && f.absenceID)
      .map((f) => f.absenceID),
  );

  const movimientos = [];
  for (const ausencia of Array.isArray(absences) ? absences : []) {
    if (ausencia.tipoAusencia_codigo !== CODIGO_AUSENCIA) continue;
    if (!["APROBADA", "FINALIZADA"].includes(ausencia.estadoa_codigo)) continue;
    if (yaAsentado.has(ausencia.ID)) continue;
    const horas = round2(num(ausencia.horasSolicitadas));
    if (horas <= 0) continue;
    movimientos.push({
      employee_ID: ausencia.empleado_ID,
      entryDate: iso(ausencia.fechaInicio),
      hours: round2(-horas),
      origin: "TAKEN",
      absenceID: ausencia.ID,
      reason: "Tiempo compensatorio tomado.",
    });
  }
  return movimientos;
}

/**
 * El saldo de cada persona a partir de sus movimientos.
 *
 * Un saldo negativo no es un error: significa que alguien tomó más
 * compensatorio del que había ganado, y eso hay que poder verlo en vez
 * de esconderlo en un cero.
 */
function balances({ ledger, employees }) {
  const nombres = new Map(
    (Array.isArray(employees) ? employees : []).map((e) => [e.ID, e]),
  );
  const porEmpleado = new Map();

  for (const fila of Array.isArray(ledger) ? ledger : []) {
    if (!fila.employee_ID) continue;
    if (!porEmpleado.has(fila.employee_ID))
      porEmpleado.set(fila.employee_ID, {
        employee_ID: fila.employee_ID,
        nombre: (nombres.get(fila.employee_ID) || {}).nombreCompleto || "",
        ganadas: 0,
        tomadas: 0,
        saldo: 0,
        ultimoMovimiento: null,
      });
    const acc = porEmpleado.get(fila.employee_ID);
    const horas = num(fila.hours);
    if (horas >= 0) acc.ganadas = round2(acc.ganadas + horas);
    else acc.tomadas = round2(acc.tomadas - horas);
    acc.saldo = round2(acc.saldo + horas);
    const fecha = iso(fila.entryDate);
    if (fecha && (!acc.ultimoMovimiento || fecha > acc.ultimoMovimiento))
      acc.ultimoMovimiento = fecha;
  }

  return [...porEmpleado.values()]
    .filter((x) => x.ganadas !== 0 || x.tomadas !== 0)
    .sort((a, b) => b.saldo - a.saldo);
}

function totalOwed(saldos) {
  return round2(
    (Array.isArray(saldos) ? saldos : [])
      .filter((s) => s.saldo > 0)
      .reduce((suma, s) => suma + s.saldo, 0),
  );
}

module.exports = {
  CODIGO_AUSENCIA,
  TIPOS_COMPENSABLES,
  ESTADOS_FIRMES,
  round2,
  earnedFromEntry,
  accrualsFor,
  consumptionsFor,
  balances,
  totalOwed,
};
