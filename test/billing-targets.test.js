"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  employeeTarget,
  employeeTargets,
  splitProjectTarget,
} = require("../srv/lib/billing-targets");

const DIAS = 21; // agosto 2026
const CALENDARIO_COMPLETO = DIAS * 8; // 168

const completo = { ID: "full", modality: "FULL_TIME", monthlyBillableTarget: null };
const porHoras = { ID: "hrs", modality: "HOURLY", monthlyBillableTarget: 160 };
const porHoras2 = { ID: "hrs2", modality: "HOURLY", monthlyBillableTarget: 80 };

const asig = (ID, project_ID, employee_ID, commercialAllocation, status = "ACTIVE") =>
  ({ ID, project_ID, employee_ID, commercialAllocation, status });

test("sin umbrales, el objetivo es el de siempre: días hábiles x 8", () => {
  const r = employeeTarget({
    employeeID: "e1",
    assignments: [asig("a1", "full", "e1", 100)],
    projects: [completo],
    businessDays: DIAS,
  });
  assert.equal(r.horasObjetivo, CALENDARIO_COMPLETO);
  assert.equal(r.tieneUmbral, false);
});

test("el umbral del proyecto se reparte según la dedicación de cada uno", () => {
  const assignments = [
    asig("a1", "hrs", "e1", 75),
    asig("a2", "hrs", "e2", 25),
  ];
  const cuotas = splitProjectTarget(porHoras, assignments);
  assert.equal(cuotas.get("a1"), 120); // 160 * 0.75
  assert.equal(cuotas.get("a2"), 40);  // 160 * 0.25
});

test("si nadie tiene dedicación registrada, el umbral se parte por igual", () => {
  const assignments = [
    asig("a1", "hrs", "e1", 0),
    asig("a2", "hrs", "e2", null),
  ];
  const cuotas = splitProjectTarget(porHoras, assignments);
  assert.equal(cuotas.get("a1"), 80);
  assert.equal(cuotas.get("a2"), 80);
});

test("las asignaciones inactivas no consumen umbral", () => {
  const assignments = [
    asig("a1", "hrs", "e1", 50),
    asig("a2", "hrs", "e2", 50, "INACTIVE"),
  ];
  const cuotas = splitProjectTarget(porHoras, assignments);
  assert.equal(cuotas.get("a1"), 160, "quien queda asume todo el umbral");
  assert.equal(cuotas.has("a2"), false);
});

test("mezcla real: un proyecto completo al 50% y dos por horas", () => {
  const assignments = [
    asig("a1", "full", "e1", 50),
    asig("a2", "hrs", "e1", 100),
    asig("a3", "hrs2", "e1", 100),
  ];
  const r = employeeTarget({
    employeeID: "e1",
    assignments,
    projects: [completo, porHoras, porHoras2],
    businessDays: DIAS,
  });
  assert.equal(r.horasUmbral, 240, "160 + 80 de los proyectos por horas");
  assert.equal(r.horasCalendario, 84, "168 x 0,5 del proyecto completo");
  assert.equal(r.horasObjetivo, 324);
  assert.equal(r.tieneUmbral, true);
});

test("proyecto de calendario sin dedicación registrada cuenta como jornada completa", () => {
  const r = employeeTarget({
    employeeID: "e1",
    assignments: [asig("a1", "full", "e1", 0)],
    projects: [completo],
    businessDays: DIAS,
  });
  assert.equal(r.horasCalendario, CALENDARIO_COMPLETO,
    "no se penaliza a quien tiene la dedicación sin rellenar");
});

test("la dedicación de calendario nunca pasa del 100%", () => {
  const r = employeeTarget({
    employeeID: "e1",
    assignments: [asig("a1", "full", "e1", 80), asig("a2", "full2", "e1", 80)],
    projects: [completo, { ID: "full2", modality: "FULL_TIME" }],
    businessDays: DIAS,
  });
  assert.equal(r.horasCalendario, CALENDARIO_COMPLETO, "160% de dedicación se capa a una jornada");
});

test("un empleado sin asignaciones conserva el objetivo de calendario", () => {
  const r = employeeTarget({
    employeeID: "sin-nada",
    assignments: [],
    projects: [],
    businessDays: DIAS,
  });
  assert.equal(r.horasObjetivo, CALENDARIO_COMPLETO);
  assert.equal(r.tieneUmbral, false);
});

test("un umbral en cero se trata como si no existiera", () => {
  const r = employeeTarget({
    employeeID: "e1",
    assignments: [asig("a1", "cero", "e1", 100)],
    projects: [{ ID: "cero", modality: "HOURLY", monthlyBillableTarget: 0 }],
    businessDays: DIAS,
  });
  assert.equal(r.horasObjetivo, CALENDARIO_COMPLETO);
  assert.equal(r.tieneUmbral, false);
});

test("employeeTargets resuelve varios empleados a la vez", () => {
  const assignments = [
    asig("a1", "hrs", "e1", 75),
    asig("a2", "hrs", "e2", 25),
  ];
  const r = employeeTargets({
    employeeIDs: ["e1", "e2"],
    assignments,
    projects: [porHoras],
    businessDays: DIAS,
  });
  assert.equal(r.length, 2);
  assert.equal(r.find((x) => x.employeeID === "e1").horasObjetivo, 120);
  assert.equal(r.find((x) => x.employeeID === "e2").horasObjetivo, 40);
});

// ---------------------------------------------------------------
// Objetivo de la empresa: capacidad vendible, no cumplimiento
// ---------------------------------------------------------------

const {
  billableRegisteredHours,
  companyTarget,
  employeeBusinessDays,
  isBillableResource,
  worksInPeriod,
} = require("../srv/lib/billing-targets");

const cargoDev = { ID: "c-dev", facturablePorDefecto: true };
const cargoAdmin = { ID: "c-adm", facturablePorDefecto: false };

test("el cargo decide por defecto quién es recurso", () => {
  assert.equal(isBillableResource({ cargo_ID: "c-dev" }, cargoDev), true);
  assert.equal(isBillableResource({ cargo_ID: "c-adm" }, cargoAdmin), false);
});

test("la marca del empleado gana sobre el cargo: el caso de Camila", () => {
  // Coordinadora de Servicios: el cargo factura, ella no.
  const camila = { ID: "camila", cargo_ID: "c-dev", facturable: false };
  assert.equal(isBillableResource(camila, cargoDev), false);

  // Y al revés: un coordinador que sí entra en un contrato.
  const coordinadorVendido = { ID: "otro", cargo_ID: "c-adm", facturable: true };
  assert.equal(isBillableResource(coordinadorVendido, cargoAdmin), true);
});

// Calendario de juguete: días hábiles = días naturales, para que las
// cuentas del test se puedan seguir a mano.
const DESDE = "2026-08-01";
const HASTA = "2026-08-21";
const diasEntre = (a, b) =>
  Math.max(0, (Date.parse(b) - Date.parse(a)) / 86400000 + 1);
const PERIODO = diasEntre(DESDE, HASTA); // 21

test("el objetivo de empresa es un mes completo por recurso colocable", () => {
  const r = companyTarget({
    employees: [
      { ID: "e1", cargo_ID: "c-dev" },
      { ID: "e2", cargo_ID: "c-dev" },
      { ID: "camila", cargo_ID: "c-dev", facturable: false },
      { ID: "contador", cargo_ID: "c-adm" },
    ],
    cargos: [cargoDev, cargoAdmin],
    dateFrom: DESDE, dateTo: HASTA, businessDaysBetween: diasEntre,
  });
  assert.equal(r.recursos, 2, "Camila y el contador no son inventario vendible");
  assert.equal(r.horasObjetivo, 2 * PERIODO * 8);
});

test("un recurso en banca sigue contando en el objetivo: la banca debe verse", () => {
  const r = companyTarget({
    employees: [{ ID: "sin-proyecto", cargo_ID: "c-dev" }],
    cargos: [cargoDev],
    dateFrom: DESDE, dateTo: HASTA, businessDaysBetween: diasEntre,
  });
  assert.equal(r.horasObjetivo, PERIODO * 8,
    "quien no tiene asignación es capacidad sin vender, no deja de existir");
});

// ---------------------------------------------------------------
// Altas y bajas a mitad de periodo
// ---------------------------------------------------------------

test("quien entra a mitad de mes sólo aporta los días que le quedan", () => {
  const nuevo = { ID: "nuevo", cargo_ID: "c-dev", fechaIngreso: "2026-08-20" };
  const dias = employeeBusinessDays({
    employee: nuevo, dateFrom: DESDE, dateTo: HASTA, businessDaysBetween: diasEntre,
  });
  assert.equal(dias, 2, "del 20 al 21");

  const r = companyTarget({
    employees: [{ ID: "veterano", cargo_ID: "c-dev" }, nuevo],
    cargos: [cargoDev],
    dateFrom: DESDE, dateTo: HASTA, businessDaysBetween: diasEntre,
  });
  assert.equal(r.recursos, 2, "cuenta como recurso");
  assert.equal(r.horasObjetivo, (PERIODO + 2) * 8,
    "pero no como un mes entero: 21 días + 2 días");
});

test("quien se retira a mitad de mes aporta hasta su último día", () => {
  const saliente = { ID: "sale", cargo_ID: "c-dev", fechaRetiro: "2026-08-10" };
  const dias = employeeBusinessDays({
    employee: saliente, dateFrom: DESDE, dateTo: HASTA, businessDaysBetween: diasEntre,
  });
  assert.equal(dias, 10, "del 1 al 10");
});

test("quien entra después del periodo no cuenta como capacidad", () => {
  const futuro = { ID: "futuro", cargo_ID: "c-dev", fechaIngreso: "2026-09-15" };
  assert.equal(worksInPeriod(futuro, DESDE, HASTA), false);
  const r = companyTarget({
    employees: [futuro], cargos: [cargoDev],
    dateFrom: DESDE, dateTo: HASTA, businessDaysBetween: diasEntre,
  });
  assert.equal(r.recursos, 0);
  assert.equal(r.horasObjetivo, 0);
});

test("quien ya se había ido antes del periodo tampoco cuenta", () => {
  const antiguo = { ID: "antiguo", cargo_ID: "c-dev", fechaRetiro: "2026-07-15" };
  assert.equal(worksInPeriod(antiguo, DESDE, HASTA), false);
});

test("el objetivo personal de quien entra tarde son sus días, no el mes", () => {
  const r = employeeTarget({
    employeeID: "nuevo",
    assignments: [asig("a1", "full", "nuevo", 100)],
    projects: [completo],
    businessDays: 2,          // sus días efectivos
    periodBusinessDays: DIAS, // el mes entero
  });
  assert.equal(r.horasObjetivo, 16, "dos días, no el mes completo");
});

test("el umbral de un proyecto por horas se prorratea por presencia", () => {
  const r = employeeTarget({
    employeeID: "nuevo",
    assignments: [asig("a1", "hrs", "nuevo", 100)],
    projects: [porHoras], // 160 h/mes
    businessDays: DIAS / 2,
    periodBusinessDays: DIAS,
  });
  assert.equal(r.horasUmbral, 80, "media presencia, medio umbral");
});

test("las horas internas no cuentan como facturación", () => {
  const projects = [
    { ID: "cli", modality: "HOURLY" },
    { ID: "int", modality: "INTERNAL" },
  ];
  const entries = [
    { project_ID: "cli", registeredHours: 100 },
    { project_ID: "int", registeredHours: 52 },
  ];
  assert.equal(billableRegisteredHours({ entries, projects }), 100);
});

test("acepta durationHours cuando la fila viene de TimeEntries", () => {
  const projects = [{ ID: "cli", modality: "HOURLY" }];
  const entries = [{ project_ID: "cli", durationHours: 8 }];
  assert.equal(billableRegisteredHours({ entries, projects }), 8);
});

test("Camila registra su mes en interno: cuenta para su card, no para la empresa", () => {
  const interno = { ID: "int", modality: "INTERNAL", monthlyBillableTarget: null };
  const suCard = employeeTarget({
    employeeID: "camila",
    assignments: [asig("a-cam", "int", "camila", 100)],
    projects: [interno],
    businessDays: DIAS,
  });
  assert.equal(suCard.horasObjetivo, CALENDARIO_COMPLETO,
    "su objetivo personal es su mes completo");

  const empresa = billableRegisteredHours({
    entries: [{ project_ID: "int", registeredHours: CALENDARIO_COMPLETO }],
    projects: [interno],
  });
  assert.equal(empresa, 0, "pero no aporta ni una hora facturable");
});
