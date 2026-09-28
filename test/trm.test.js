"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseOfficialRows,
  fetchOfficialRates,
  resolveRate,
  missingRateDates,
  newRatesOnly,
} = require("../srv/lib/trm");

// Como responde de verdad la fuente de datos abiertos.
const CRUDO = [
  { valor: "3202.79", unidad: "COP", vigenciadesde: "2026-08-29T00:00:00.000", vigenciahasta: "2026-08-31T00:00:00.000" },
  { valor: "3144.28", unidad: "COP", vigenciadesde: "2026-08-28T00:00:00.000", vigenciahasta: "2026-08-28T00:00:00.000" },
];

test("las filas de la fuente se traducen a la forma de la tabla", () => {
  const filas = parseOfficialRows(CRUDO);
  assert.equal(filas.length, 2);
  assert.deepEqual(filas[0], {
    currency: "USD",
    validFrom: "2026-08-29",
    validTo: "2026-08-31",
    rate: 3202.79,
    source: "BANREP",
  });
});

test("una fila sin valor o sin fecha se descarta en vez de entrar como cero", () => {
  const filas = parseOfficialRows([
    { valor: "", vigenciadesde: "2026-08-29T00:00:00.000" },
    { valor: "3200", vigenciadesde: null },
    ...CRUDO,
  ]);
  assert.equal(filas.length, 2);
});

test("la misma fecha repetida no entra dos veces", () => {
  const filas = parseOfficialRows([...CRUDO, ...CRUDO]);
  assert.equal(filas.length, 2);
});

test("la TRM del viernes rige el sábado y el domingo", () => {
  const rates = parseOfficialRows(CRUDO);
  for (const dia of ["2026-08-29", "2026-08-30", "2026-08-31"]) {
    const r = resolveRate({ rates, date: dia });
    assert.equal(r.rate, 3202.79, `falló el ${dia}`);
    assert.equal(r.exact, true);
  }
});

test("un día sin cobertura toma la última anterior y lo dice", () => {
  const rates = parseOfficialRows(CRUDO);
  const r = resolveRate({ rates, date: "2026-09-05" });
  assert.equal(r.rate, 3202.79);
  assert.equal(r.exact, false, "hay que poder distinguir el dato oficial del aproximado");
});

test("una fecha anterior a todo lo que hay no devuelve una tasa inventada", () => {
  const r = resolveRate({ rates: parseOfficialRows(CRUDO), date: "2020-01-01" });
  assert.equal(r.rate, null);
});

test("el peso siempre vale un peso", () => {
  const r = resolveRate({ rates: [], currency: "COP", date: "2026-08-29" });
  assert.equal(r.rate, 1);
  assert.equal(r.exact, true);
});

test("avisa qué días hábiles se quedaron sin TRM, ignorando fines de semana", () => {
  const rates = parseOfficialRows(CRUDO);
  // 2026-08-28 viernes, 29 sábado, 30 domingo, 31 lunes, 1 martes...
  const faltantes = missingRateDates({ rates, from: "2026-08-28", to: "2026-09-03" });
  assert.deepEqual(faltantes, ["2026-09-01", "2026-09-02", "2026-09-03"]);
});

test("sincronizar dos veces el mismo día no duplica filas", () => {
  const traidas = parseOfficialRows(CRUDO);
  const nuevas = newRatesOnly({
    fetched: traidas,
    existing: [{ currency: "USD", validFrom: "2026-08-28" }],
  });
  assert.equal(nuevas.length, 1);
  assert.equal(nuevas[0].validFrom, "2026-08-29");
});

test("trae la TRM de la fuente oficial", async () => {
  let urlPedida = "";
  const filas = await fetchOfficialRates({
    since: "2026-08-01",
    limit: 10,
    fetchImpl: async (url) => {
      urlPedida = url;
      return { ok: true, status: 200, json: async () => CRUDO };
    },
  });
  assert.equal(filas.length, 2);
  assert.match(urlPedida, /datos\.gov\.co/);
  assert.match(urlPedida, /vigenciadesde\+%3E%3D|vigenciadesde\s*>=/);
  assert.match(urlPedida, /limit=10/);
});

test("si la fuente falla se levanta un error con el código, no se devuelve vacío", async () => {
  await assert.rejects(
    fetchOfficialRates({ fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /503/,
  );
});
