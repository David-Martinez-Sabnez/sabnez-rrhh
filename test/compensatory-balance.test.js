"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  earnedFromEntry,
  accrualsFor,
  consumptionsFor,
  balances,
  totalOwed,
} = require("../srv/lib/compensatory-balance");

const registro = (extra) =>
  Object.assign(
    {
      ID: "e1",
      employee_ID: "emp1",
      workDate: "2026-08-29",
      status: "INTERNALLY_APPROVED",
      requestedType: "OVERTIME",
      billableHours: 0,
      payableHours: 8,
      treatmentOverride: null,
    },
    extra || {},
  );

// --- qué genera saldo -----------------------------------------------------

test("el sábado que el cliente no aprobó genera ocho horas de compensatorio", () => {
  assert.equal(earnedFromEntry(registro()), 8);
});

test("una hora facturada no le debe nada a nadie", () => {
  assert.equal(earnedFromEntry(registro({ billableHours: 8, payableHours: 8 })), 0);
});

test("una hora facturada a medias sólo debe la diferencia", () => {
  assert.equal(earnedFromEntry(registro({ billableHours: 5, payableHours: 8 })), 3);
});

test("la jornada ordinaria no genera compensatorio aunque no se cobre", () => {
  // Ocho horas regulares en un proyecto interno no se cobran, pero la
  // persona está en nómina: no se le deben.
  assert.equal(
    earnedFromEntry(registro({ requestedType: "REGULAR", billableHours: 0, payableHours: 8 })),
    0,
  );
});

test("una hora ordinaria que el cliente rechazó a mano sí se debe", () => {
  assert.equal(
    earnedFromEntry(
      registro({ requestedType: "REGULAR", treatmentOverride: "NON_BILLABLE", billableHours: 0, payableHours: 8 }),
    ),
    8,
    "se trabajó esperando cobrarla",
  );
});

test("un registro que todavía no pasó revisión no genera saldo", () => {
  for (const status of ["DRAFT", "SUBMITTED", "LEADER_APPROVED", "RETURNED", "VOIDED"])
    assert.equal(earnedFromEntry(registro({ status })), 0, `falló con ${status}`);
});

// --- no duplicar al reprocesar ---------------------------------------------

test("reprocesar el mismo mes dos veces no duplica el saldo", () => {
  const entries = [registro()];
  const primeros = accrualsFor({ entries, ledger: [] });
  assert.equal(primeros.length, 1);
  assert.equal(primeros[0].hours, 8);

  const ledger = [{ origin: "EARNED", timeEntry_ID: "e1", hours: 8 }];
  const segundos = accrualsFor({ entries, ledger });
  assert.equal(segundos.length, 0, "ya estaba asentado");
});

test("si el registro cambió después, se asienta sólo la diferencia", () => {
  const ledger = [{ origin: "EARNED", timeEntry_ID: "e1", hours: 8 }];
  // El cliente terminó aprobando 5 de las 8 horas.
  const movimientos = accrualsFor({
    entries: [registro({ billableHours: 5, payableHours: 8 })],
    ledger,
  });
  assert.equal(movimientos.length, 1);
  assert.equal(movimientos[0].hours, -5, "se devuelven las cinco que sí se cobraron");
  assert.equal(movimientos[0].origin, "ADJUST");
});

test("un registro que dejó de deber nada revierte lo asentado", () => {
  const movimientos = accrualsFor({
    entries: [registro({ billableHours: 8, payableHours: 8 })],
    ledger: [{ origin: "EARNED", timeEntry_ID: "e1", hours: 8 }],
  });
  assert.equal(movimientos[0].hours, -8);
});

// --- consumo ----------------------------------------------------------------

const ausencia = (extra) =>
  Object.assign(
    {
      ID: "a1",
      empleado_ID: "emp1",
      tipoAusencia_codigo: "CO",
      estadoa_codigo: "APROBADA",
      fechaInicio: "2026-09-10",
      horasSolicitadas: 8,
    },
    extra || {},
  );

test("una ausencia compensatoria aprobada baja el saldo", () => {
  const m = consumptionsFor({ absences: [ausencia()], ledger: [] });
  assert.equal(m.length, 1);
  assert.equal(m[0].hours, -8);
  assert.equal(m[0].origin, "TAKEN");
});

test("una solicitud sin aprobar todavía no consume nada", () => {
  for (const estado of ["BORRADOR", "SOLICITADA", "RECHAZADA", "CANCELADA"]) {
    const m = consumptionsFor({ absences: [ausencia({ estadoa_codigo: estado })], ledger: [] });
    assert.equal(m.length, 0, `falló con ${estado}`);
  }
});

test("las vacaciones no salen de la bolsa de compensatorios", () => {
  const m = consumptionsFor({ absences: [ausencia({ tipoAusencia_codigo: "VA" })], ledger: [] });
  assert.equal(m.length, 0);
});

test("una ausencia ya asentada no vuelve a descontarse", () => {
  const m = consumptionsFor({
    absences: [ausencia()],
    ledger: [{ origin: "TAKEN", absenceID: "a1", hours: -8 }],
  });
  assert.equal(m.length, 0);
});

// --- saldos ------------------------------------------------------------------

const EMPLEADOS = [
  { ID: "emp1", nombreCompleto: "Camila Rojas" },
  { ID: "emp2", nombreCompleto: "Andrés Gómez" },
];

test("el saldo es lo ganado menos lo tomado, con su detalle", () => {
  const s = balances({
    employees: EMPLEADOS,
    ledger: [
      { employee_ID: "emp1", hours: 8, origin: "EARNED", entryDate: "2026-08-29" },
      { employee_ID: "emp1", hours: 4, origin: "EARNED", entryDate: "2026-09-05" },
      { employee_ID: "emp1", hours: -8, origin: "TAKEN", entryDate: "2026-09-20" },
    ],
  });
  assert.equal(s.length, 1);
  assert.equal(s[0].nombre, "Camila Rojas");
  assert.equal(s[0].ganadas, 12);
  assert.equal(s[0].tomadas, 8);
  assert.equal(s[0].saldo, 4);
  assert.equal(s[0].ultimoMovimiento, "2026-09-20");
});

test("quien tomó más de lo que ganó queda en negativo, no en cero", () => {
  const s = balances({
    employees: EMPLEADOS,
    ledger: [
      { employee_ID: "emp2", hours: 4, origin: "EARNED", entryDate: "2026-08-01" },
      { employee_ID: "emp2", hours: -8, origin: "TAKEN", entryDate: "2026-08-15" },
    ],
  });
  assert.equal(s[0].saldo, -4, "esconderlo en cero sería perder la información");
});

test("los saldos salen de mayor a menor: primero a quien más se le debe", () => {
  const s = balances({
    employees: EMPLEADOS,
    ledger: [
      { employee_ID: "emp1", hours: 4, origin: "EARNED", entryDate: "2026-08-01" },
      { employee_ID: "emp2", hours: 16, origin: "EARNED", entryDate: "2026-08-01" },
    ],
  });
  assert.deepEqual(s.map((x) => x.employee_ID), ["emp2", "emp1"]);
});

test("la deuda total sólo suma saldos a favor del recurso", () => {
  const s = balances({
    employees: EMPLEADOS,
    ledger: [
      { employee_ID: "emp1", hours: 12, origin: "EARNED", entryDate: "2026-08-01" },
      { employee_ID: "emp2", hours: 4, origin: "EARNED", entryDate: "2026-08-01" },
      { employee_ID: "emp2", hours: -8, origin: "TAKEN", entryDate: "2026-08-15" },
    ],
  });
  assert.equal(totalOwed(s), 12, "un saldo negativo no le resta a lo que se debe a otros");
});

test("quien nunca movió la bolsa no aparece en la lista", () => {
  const s = balances({ employees: EMPLEADOS, ledger: [] });
  assert.equal(s.length, 0);
});
