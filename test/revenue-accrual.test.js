"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  monthEnd,
  rateFor,
  monthlyFraction,
  accruedRevenue,
} = require("../srv/lib/revenue-accrual");

// Días hábiles simplificado: de lunes a viernes, sin festivos. Sirve para
// probar el prorrateo sin arrastrar el calendario colombiano.
function diasHabiles(desde, hasta) {
  let n = 0;
  const cursor = new Date(`${desde}T00:00:00Z`);
  const fin = new Date(`${hasta}T00:00:00Z`);
  while (cursor <= fin) {
    const d = cursor.getUTCDay();
    if (d !== 0 && d !== 6) n += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return n;
}

const enPesos = () => ({ rate: 1 });

const PROY_HORAS = { ID: "p-hrs", modality: "HOURLY", name: "Codelco CIG" };
const PROY_FULL = { ID: "p-full", modality: "FULL_TIME", name: "Axity Soporte" };
const PROY_INT = { ID: "p-int", modality: "INTERNAL", name: "Administración" };

const ASIG_HORAS = { ID: "a-hrs", project_ID: "p-hrs", validFrom: "2026-01-01" };
const ASIG_FULL = { ID: "a-full", project_ID: "p-full", validFrom: "2026-01-01" };
const ASIG_INT = { ID: "a-int", project_ID: "p-int", validFrom: "2026-01-01" };

const TARIFA_HORAS = {
  assignment_ID: "a-hrs", validFrom: "2026-01-01", currency: "COP",
  regularSaleHourlyRate: 190000, overtimeSaleHourlyRate: 280000,
  internalHourlyCost: 90000,
};
const TARIFA_FULL = {
  assignment_ID: "a-full", validFrom: "2026-01-01", currency: "COP",
  monthlySaleRate: 14000000, internalMonthlyCost: 8000000,
};

const registro = (extra) =>
  Object.assign(
    { workDate: "2026-08-10", assignment_ID: "a-hrs", project_ID: "p-hrs",
      commercialTreatment: "BILLABLE_REGULAR", billableHours: 8, payableHours: 8 },
    extra,
  );

const correr = (entries, extra) =>
  accruedRevenue(Object.assign({
    entries,
    assignments: [ASIG_HORAS, ASIG_FULL, ASIG_INT],
    rates: [TARIFA_HORAS, TARIFA_FULL],
    projects: [PROY_HORAS, PROY_FULL, PROY_INT],
    from: "2026-08-01", to: "2026-08-31",
    resolveExchangeRate: enPesos,
    businessDaysBetween: diasHabiles,
  }, extra || {}));

// --- utilidades -----------------------------------------------------------

test("el fin de mes se calcula bien también en febrero", () => {
  assert.equal(monthEnd("2026-02"), "2026-02-28");
  assert.equal(monthEnd("2026-08"), "2026-08-31");
  assert.equal(monthEnd("2026-12"), "2026-12-31");
});

test("entre dos tarifas vigentes manda la que empezó después", () => {
  const r = rateFor({
    assignmentID: "a", date: "2026-08-10",
    rates: [
      { assignment_ID: "a", validFrom: "2026-01-01", regularSaleHourlyRate: 100 },
      { assignment_ID: "a", validFrom: "2026-07-01", regularSaleHourlyRate: 190 },
    ],
  });
  assert.equal(r.regularSaleHourlyRate, 190);
});

test("quien entra a mitad de mes no devenga la mensualidad completa", () => {
  // Agosto 2026: 21 días hábiles. Desde el 17 quedan 11.
  const f = monthlyFraction({
    assignment: { validFrom: "2026-08-17" }, mes: "2026-08",
    businessDaysBetween: diasHabiles,
  });
  assert.ok(f > 0.5 && f < 0.55, `fracción inesperada: ${f}`);
});

// --- por horas -------------------------------------------------------------

test("un proyecto por horas devenga hora por hora a su tarifa", () => {
  const { meses } = correr([registro({ billableHours: 10, payableHours: 10 })]);
  assert.equal(meses[0].devengadoCOP, 1900000);
  assert.equal(meses[0].costoCOP, 900000);
  assert.equal(meses[0].margenCOP, 1000000);
});

test("las horas extra se devengan a la tarifa de extra, no a la ordinaria", () => {
  const { meses } = correr([
    registro({ commercialTreatment: "BILLABLE_OVERTIME", billableHours: 4, payableHours: 4 }),
  ]);
  assert.equal(meses[0].devengadoCOP, 1120000, "4 x 280.000");
});

test("si no hay tarifa de extra se cae a la ordinaria en vez de devengar cero", () => {
  const { meses } = correr(
    [registro({ commercialTreatment: "BILLABLE_OVERTIME", billableHours: 4, payableHours: 4 })],
    { rates: [{ assignment_ID: "a-hrs", validFrom: "2026-01-01", currency: "COP", regularSaleHourlyRate: 190000 }] },
  );
  assert.equal(meses[0].devengadoCOP, 760000);
});

// --- tiempo completo --------------------------------------------------------

test("un recurso de tiempo completo devenga la mensualidad, no la suma de sus horas", () => {
  // Veinte registros de 8 horas no son veinte mensualidades.
  const registros = [];
  for (let d = 3; d <= 22; d += 1)
    registros.push(registro({
      workDate: `2026-08-${String(d).padStart(2, "0")}`,
      assignment_ID: "a-full", project_ID: "p-full",
      commercialTreatment: "INCLUDED_FULL_TIME",
    }));
  const { meses } = correr(registros);
  assert.equal(meses[0].devengadoCOP, 14000000, "una sola mensualidad");
  assert.equal(meses[0].costoCOP, 8000000);
  assert.equal(meses[0].horasFacturables, 160);
});

test("la mensualidad se prorratea para quien entró a mitad de mes", () => {
  const { meses } = correr(
    [registro({ workDate: "2026-08-20", assignment_ID: "a-full", project_ID: "p-full", commercialTreatment: "INCLUDED_FULL_TIME" })],
    { assignments: [{ ID: "a-full", project_ID: "p-full", validFrom: "2026-08-17" }] },
  );
  assert.ok(
    meses[0].devengadoCOP > 7000000 && meses[0].devengadoCOP < 7900000,
    `esperaba algo más de media mensualidad, dio ${meses[0].devengadoCOP}`,
  );
});

// --- lo que no devenga --------------------------------------------------------

test("un proyecto interno no devenga nada aunque se le registren horas", () => {
  const { meses } = correr([
    registro({ assignment_ID: "a-int", project_ID: "p-int", commercialTreatment: "NON_BILLABLE", billableHours: 0, payableHours: 8 }),
  ]);
  assert.equal(meses.length, 0, "ni siquiera abre el mes");
});

test("el sábado que el cliente no aprobó cuesta aunque no devengue", () => {
  const { meses } = correr([
    registro({ commercialTreatment: "NON_BILLABLE", billableHours: 0, payableHours: 8 }),
  ]);
  assert.equal(meses[0].devengadoCOP, 0, "no entra un peso");
  assert.equal(meses[0].costoCOP, 720000, "pero salen 8 horas de costo");
  assert.equal(meses[0].margenCOP, -720000);
  assert.equal(meses[0].horasPorCompensar, 8);
});

test("una asignación con horas facturables y sin tarifa se denuncia, no se cuenta como cero", () => {
  const { meses, sinTarifa } = correr([registro()], { rates: [] });
  assert.equal(meses[0].devengadoCOP, 0);
  assert.equal(sinTarifa.length, 1, "el dashboard no puede mentir en silencio");
  assert.equal(sinTarifa[0].assignment_ID, "a-hrs");
  assert.equal(sinTarifa[0].horas, 8);
});

// --- moneda y meses -------------------------------------------------------------

test("una tarifa en dólares se devenga en pesos a la TRM del día trabajado", () => {
  const { meses } = correr([registro({ billableHours: 10, payableHours: 10 })], {
    rates: [{ assignment_ID: "a-hrs", validFrom: "2026-01-01", currency: "USD", regularSaleHourlyRate: 45, internalHourlyCost: 20 }],
    resolveExchangeRate: ({ currency }) => ({ rate: currency === "USD" ? 4000 : 1 }),
  });
  assert.equal(meses[0].devengadoCOP, 1800000, "10 h x 45 USD x 4.000");
  assert.equal(meses[0].costoCOP, 800000);
});

test("venta USD y costo COP se convierten de forma independiente", () => {
  const { meses } = correr([registro({ billableHours: 10, payableHours: 10 })], {
    rates: [{
      assignment_ID: "a-hrs", validFrom: "2026-01-01",
      saleCurrency: "USD", costCurrency: "COP",
      regularSaleHourlyRate: 25, internalHourlyCost: 40000,
    }],
    resolveExchangeRate: ({ currency }) => ({ rate: currency === "USD" ? 4000 : 1 }),
  });
  assert.equal(meses[0].devengadoCOP, 1000000, "10 h x 25 USD x 4.000");
  assert.equal(meses[0].costoCOP, 400000, "10 h x 40.000 COP");
  assert.equal(meses[0].margenCOP, 600000);
});

test("cada mes se cuenta aparte y los de fuera del rango no entran", () => {
  const { meses } = correr(
    [
      registro({ workDate: "2026-07-15" }),
      registro({ workDate: "2026-08-15" }),
      registro({ workDate: "2026-09-15" }),
    ],
    { from: "2026-08-01", to: "2026-09-30" },
  );
  assert.deepEqual(meses.map((m) => m.mes), ["2026-08", "2026-09"]);
});
