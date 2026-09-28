"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  defaultRulesForModality,
  seedRulesForProject,
  classifyEntry,
  classifyEntries,
  esFacturable,
  TIPOS_TIEMPO,
} = require("../srv/lib/commercial-classification");

const proyecto = (ID, modality) => ({ ID, modality });
const registro = (durationHours, requestedType, extra) =>
  Object.assign({ durationHours, requestedType }, extra || {});

// --- la matriz por defecto ---------------------------------------------

test("cada modalidad nace con una regla por cada tipo de tiempo", () => {
  for (const m of ["FULL_TIME", "HOURLY", "MIXED", "INTERNAL"]) {
    const reglas = defaultRulesForModality(m);
    assert.equal(reglas.length, TIPOS_TIEMPO.length, `faltan reglas en ${m}`);
    const tipos = reglas.map((r) => r.requestedType).sort();
    assert.deepEqual(tipos, [...TIPOS_TIEMPO].sort(), `tipos incompletos en ${m}`);
  }
});

test("un proyecto interno no le factura nada a nadie", () => {
  for (const r of defaultRulesForModality("INTERNAL")) {
    assert.equal(r.treatment, "NON_BILLABLE", `${r.requestedType} no debería facturarse`);
    assert.equal(r.billableFactor, 0);
  }
});

test("una modalidad que no conocemos se trata como tiempo completo, no como facturable", () => {
  const raro = defaultRulesForModality("LO_QUE_SEA");
  const regular = raro.find((r) => r.requestedType === "REGULAR");
  const extra = raro.find((r) => r.requestedType === "OVERTIME");
  assert.equal(regular.treatment, "INCLUDED_FULL_TIME");
  assert.equal(extra.treatment, "NON_BILLABLE");
});

test("el seed viene con el proyecto pegado y listo para insertar", () => {
  const filas = seedRulesForProject(proyecto("p1", "HOURLY"));
  assert.equal(filas.length, TIPOS_TIEMPO.length);
  assert.ok(filas.every((f) => f.project_ID === "p1"));
  assert.ok(filas.every((f) => f.active === true));
});

// --- el cálculo de un registro -----------------------------------------

test("tiempo completo: la hora regular se entrega contra la mensualidad, así que cuenta", () => {
  const r = classifyEntry({
    entry: registro(8, "REGULAR"),
    project: proyecto("p1", "FULL_TIME"),
    rules: [],
  });
  assert.equal(r.commercialTreatment, "INCLUDED_FULL_TIME");
  assert.equal(r.billableHours, 8);
  assert.equal(r.payableHours, 8);
  assert.equal(r.compensationGap, 0);
});

test("un consultor de tiempo completo no puede aparecer con cero facturación", () => {
  // El error contrario sería tentador: como no se cobra por hora, poner
  // billableHours en cero. Eso rompería el dashboard de tiempos.
  assert.ok(esFacturable("INCLUDED_FULL_TIME"));
});

test("por horas: la hora regular se cobra y la extra se cobra como extra", () => {
  const p = proyecto("p2", "HOURLY");
  const regular = classifyEntry({ entry: registro(8, "REGULAR"), project: p, rules: [] });
  const extra = classifyEntry({ entry: registro(3, "OVERTIME"), project: p, rules: [] });
  assert.equal(regular.commercialTreatment, "BILLABLE_REGULAR");
  assert.equal(regular.billableHours, 8);
  assert.equal(extra.commercialTreatment, "BILLABLE_OVERTIME");
  assert.equal(extra.billableHours, 3);
});

test("mixto: lo contratado va incluido y el excedente sí se cobra", () => {
  const p = proyecto("p3", "MIXED");
  const regular = classifyEntry({ entry: registro(8, "REGULAR"), project: p, rules: [] });
  const domingo = classifyEntry({ entry: registro(6, "SUNDAY"), project: p, rules: [] });
  assert.equal(regular.commercialTreatment, "INCLUDED_FULL_TIME");
  assert.equal(domingo.commercialTreatment, "BILLABLE_OVERTIME");
  assert.equal(domingo.billableHours, 6);
});

test("un tipo de tiempo que no está en la matriz falla cerrado, no facturando", () => {
  const r = classifyEntry({
    entry: registro(8, "INVENTADO"),
    project: proyecto("p1", "HOURLY"),
    rules: [],
  });
  assert.equal(r.commercialTreatment, "NON_BILLABLE");
  assert.equal(r.billableHours, 0);
});

// --- el sábado que el cliente no aprobó ---------------------------------

test("el sábado que el cliente no aprobó: no se cobra pero el recurso lo conserva", () => {
  const r = classifyEntry({
    entry: registro(8, "OVERTIME", {
      treatmentOverride: "NON_BILLABLE",
      overrideReason: "El cliente no aprobó el sábado",
    }),
    project: proyecto("p2", "HOURLY"),
    rules: [],
  });
  assert.equal(r.commercialTreatment, "NON_BILLABLE");
  assert.equal(r.billableHours, 0, "no se le puede cobrar al cliente");
  assert.equal(r.payableHours, 8, "pero a Camila hay que responderle esas 8 horas");
  assert.equal(r.compensationGap, 8, "y eso es costo sin ingreso, tiene que verse");
  assert.equal(r.manualOverride, true);
});

test("la corrección manual le gana a la regla del proyecto en los dos sentidos", () => {
  const p = proyecto("p1", "FULL_TIME");
  const rescatado = classifyEntry({
    entry: registro(4, "SUNDAY", { treatmentOverride: "BILLABLE_OVERTIME" }),
    project: p,
    rules: [],
  });
  assert.equal(rescatado.commercialTreatment, "BILLABLE_OVERTIME");
  assert.equal(rescatado.billableHours, 4, "el cliente sí aprobó este domingo");
});

test("un override vacío o inválido no manda: manda el proyecto", () => {
  const p = proyecto("p2", "HOURLY");
  for (const override of [null, "", "  ", "CUALQUIER_COSA"]) {
    const r = classifyEntry({
      entry: registro(8, "REGULAR", { treatmentOverride: override }),
      project: p,
      rules: [],
    });
    assert.equal(r.commercialTreatment, "BILLABLE_REGULAR", `falló con ${JSON.stringify(override)}`);
    assert.equal(r.manualOverride, false);
  }
});

// --- reglas configuradas a mano en el proyecto --------------------------

test("la regla configurada en el proyecto le gana a la de su modalidad", () => {
  // Un proyecto de tiempo completo cuyo contrato sí reconoce el dominical.
  const r = classifyEntry({
    entry: registro(8, "SUNDAY"),
    project: proyecto("p1", "FULL_TIME"),
    rules: [
      { project_ID: "p1", requestedType: "SUNDAY", treatment: "BILLABLE_OVERTIME", billableFactor: 1, payableToEmployee: true, active: true },
    ],
  });
  assert.equal(r.commercialTreatment, "BILLABLE_OVERTIME");
  assert.equal(r.billableHours, 8);
});

test("una regla desactivada no cuenta, se vuelve al defecto de la modalidad", () => {
  const r = classifyEntry({
    entry: registro(8, "REGULAR"),
    project: proyecto("p2", "HOURLY"),
    rules: [
      { project_ID: "p2", requestedType: "REGULAR", treatment: "NON_BILLABLE", billableFactor: 0, active: false },
    ],
  });
  assert.equal(r.commercialTreatment, "BILLABLE_REGULAR");
});

test("el factor del contrato multiplica las horas cobradas, no las pagadas", () => {
  const r = classifyEntry({
    entry: registro(4, "SUNDAY"),
    project: proyecto("p2", "HOURLY"),
    rules: [
      { project_ID: "p2", requestedType: "SUNDAY", treatment: "BILLABLE_OVERTIME", billableFactor: 1.75, payableToEmployee: true, active: true },
    ],
  });
  assert.equal(r.billableHours, 7, "4 h dominicales se cobran como 7");
  assert.equal(r.payableHours, 4, "pero el recurso trabajó 4");
});

test("hay tiempo que no se le reconoce a nadie y también hay que poder decirlo", () => {
  const r = classifyEntry({
    entry: registro(8, "COMPENSATORY"),
    project: proyecto("p1", "FULL_TIME"),
    rules: [
      { project_ID: "p1", requestedType: "COMPENSATORY", treatment: "NON_BILLABLE", billableFactor: 0, payableToEmployee: false, active: true },
    ],
  });
  assert.equal(r.payableHours, 0);
  assert.equal(r.compensationGap, 0);
});

// --- lotes ---------------------------------------------------------------

test("un lote clasifica cada registro contra la matriz de su propio proyecto", () => {
  const r = classifyEntries({
    entries: [
      { ID: "e1", project_ID: "p1", durationHours: 8, requestedType: "REGULAR" },
      { ID: "e2", project_ID: "p2", durationHours: 8, requestedType: "REGULAR" },
      { ID: "e3", project_ID: "p3", durationHours: 8, requestedType: "REGULAR" },
    ],
    projects: [
      proyecto("p1", "FULL_TIME"),
      proyecto("p2", "HOURLY"),
      proyecto("p3", "INTERNAL"),
    ],
    rules: [],
  });
  assert.deepEqual(
    r.map((x) => [x.ID, x.commercialTreatment, x.billableHours]),
    [
      ["e1", "INCLUDED_FULL_TIME", 8],
      ["e2", "BILLABLE_REGULAR", 8],
      ["e3", "NON_BILLABLE", 0],
    ],
  );
});

test("un registro sin proyecto conocido no se cuela como facturable", () => {
  const [r] = classifyEntries({
    entries: [{ ID: "e1", project_ID: "fantasma", durationHours: 8, requestedType: "REGULAR" }],
    projects: [],
    rules: [],
  });
  assert.equal(r.billableHours, 8, "cae en el defecto de tiempo completo");
  assert.equal(r.commercialTreatment, "INCLUDED_FULL_TIME");
});

test("horas negativas o basura no producen facturación negativa", () => {
  for (const horas of [-8, null, undefined, "abc"]) {
    const r = classifyEntry({
      entry: registro(horas, "REGULAR"),
      project: proyecto("p2", "HOURLY"),
      rules: [],
    });
    assert.equal(r.billableHours, 0, `falló con ${horas}`);
    assert.equal(r.payableHours, 0, `falló con ${horas}`);
  }
});

// --- qué cuenta como deuda con el recurso -------------------------------

test("ocho horas regulares en un proyecto interno no se le deben a nadie", () => {
  // No se le cobran al cliente, pero la persona está en nómina. Contarlas
  // como compensación pendiente inflaría una deuda que no existe.
  const r = classifyEntry({
    entry: registro(8, "REGULAR"),
    project: proyecto("p3", "INTERNAL"),
    rules: [],
  });
  assert.equal(r.billableHours, 0);
  assert.equal(r.payableHours, 8);
  assert.equal(r.compensationGap, 0);
});

test("un domingo que el contrato no cubre sí se le debe al recurso", () => {
  const r = classifyEntry({
    entry: registro(6, "SUNDAY"),
    project: proyecto("p1", "FULL_TIME"),
    rules: [],
  });
  assert.equal(r.billableHours, 0);
  assert.equal(r.compensationGap, 6);
});

test("una hora regular que el cliente rechazó a mano sí es deuda", () => {
  const r = classifyEntry({
    entry: registro(8, "REGULAR", { treatmentOverride: "NON_BILLABLE" }),
    project: proyecto("p2", "HOURLY"),
    rules: [],
  });
  assert.equal(r.compensationGap, 8, "se trabajó esperando cobrarla");
});
