"use strict";

// Reglas de facturabilidad del proyecto y corrección manual sobre los
// registros de tiempo. Lo que se prueba acá es lo que la librería pura no
// puede probar: que el servicio siembre la matriz al crear el proyecto,
// que la corrección se persista y que no toque lo ya facturado.

const test = require("node:test");
const assert = require("node:assert/strict");
const cds = require("@sap/cds");

const RAIZ = require("node:path").join(__dirname, "..");
const { INSERT, SELECT } = cds.ql;

let srv;
let n = 0;
const id = (p) => `${p}-0000-0000-0000-${String(++n).padStart(12, "0")}`;

let cargoID;
const estadoID = "AC";

// El servicio exige calendario laboral en todo proyecto (CALENDARIO_REQUERIDO).
// Se usan los que ya vienen sembrados en db/data, no filas inventadas.
const CALENDARIO_CO = "2c3d8bf1-8b28-4a7b-83dd-64db8d640001"; // CO-GENERAL
const CALENDARIO_CL = "2c3d8bf1-8b28-4a7b-83dd-64db8d640002"; // CL-GENERAL

test.before(async () => {
  cds.root = RAIZ;
  const csn = await cds.load(["db", "srv/time-admin-service.cds"], { root: RAIZ });
  await cds.deploy(csn).to("sqlite::memory:");
  cds.model = cds.linked(cds.compile.for.nodejs(csn));
  srv = await cds.serve("TimeAdminService").from(cds.model);
  cds.context = new cds.EventContext({ user: new cds.User.Privileged() });
  cargoID = id("car");
  await INSERT.into("sabnez.rrhh.Cargos").entries({ ID: cargoID, nombre: "Consultor" });
});

test.beforeEach(() => {
  cds.context = new cds.EventContext({ user: new cds.User.Privileged() });
});

const USUARIO = () => new cds.User({ id: "david", roles: ["TimeAdmin", "TimeFinance"] });
const accion = (evento, datos) => srv.tx({ user: USUARIO() }, (tx) => tx.send(evento, datos));
const crear = (entidad, datos) =>
  srv.tx({ user: USUARIO() }, (tx) => tx.run(INSERT.into(entidad).entries(datos)));

async function seedCliente(extra) {
  const ID = id("cli");
  const prefix = [Math.floor(n / 676), Math.floor(n / 26), n]
    .map((value) => String.fromCharCode(65 + (value % 26)))
    .join("");
  await INSERT.into("sabnez.times.Clients").entries(Object.assign({
    ID, legalName: "Axity Chile SpA", tradeName: "Axity",
    projectCodePrefix: prefix,
    taxIdentification: "761-" + n, countryCode: "CL",
    defaultCurrency: "USD", timeZone: "America/Santiago", status: "ACTIVE",
  }, extra || {}));
  return ID;
}

async function seedEmpleado() {
  const ID = id("emp");
  await INSERT.into("sabnez.rrhh.Empleados").entries({
    ID, numeroDocumento: "100" + n, tipoDocumento: "CC",
    primerNombre: "Camila", primerApellido: "Rojas",
    correoCorporativo: `camila${n}@sabnez.com`, fechaIngreso: "2020-01-01",
    cargo_ID: cargoID, estado_codigo: estadoID,
  });
  return ID;
}

// Un registro de tiempo completo: hoja semanal, asignación y entrada.
async function seedRegistro(project_ID, { horas = 8, tipo = "OVERTIME", status = "DRAFT" } = {}) {
  const employee_ID = await seedEmpleado();
  const assignment_ID = id("asi");
  await INSERT.into("sabnez.times.ProjectAssignments").entries({
    ID: assignment_ID, project_ID, employee_ID,
    validFrom: "2026-01-01", role: "Consultor", status: "ACTIVE",
  });
  const timesheet_ID = id("hoj");
  await INSERT.into("sabnez.times.WeeklyTimesheets").entries({
    ID: timesheet_ID, assignment_ID, employee_ID,
    weekStart: "2026-08-24", weekEnd: "2026-08-30", status: "OPEN",
  });
  const ID = id("reg");
  await INSERT.into("sabnez.times.TimeEntries").entries({
    ID, timesheet_ID, assignment_ID, employee_ID,
    workDate: "2026-08-29", durationHours: horas, requestedType: tipo,
    status, commercialTreatment: "PENDING", billableHours: 0, payableHours: 0,
  });
  return ID;
}

const reglasDe = (project_ID) =>
  SELECT.from("sabnez.times.ProjectBillingRules").where({ project_ID });
const registro = (ID) => SELECT.one.from("sabnez.times.TimeEntries").where({ ID });

// --- siembra de la matriz ------------------------------------------------

test("crear un proyecto le siembra la matriz completa de su modalidad", async () => {
  const cliente = await seedCliente();
  const ID = id("pro");
  await crear("Proyectos", {
    ID, client_ID: cliente, code: "SEED" + n, name: "Proyecto por horas",
    validFrom: "2026-01-01", modality: "HOURLY", currency: "USD",
    timeZone: "America/Santiago", status: "ACTIVE", workCalendar_ID: CALENDARIO_CL,
  });
  const reglas = await reglasDe(ID);
  assert.equal(reglas.length, 7, "una regla por cada tipo de tiempo");
  const regular = reglas.find((r) => r.requestedType === "REGULAR");
  assert.equal(regular.treatment, "BILLABLE_REGULAR", "por horas: la ordinaria se cobra");
});

test("un proyecto interno nace con todo sin facturar", async () => {
  const cliente = await seedCliente();
  const ID = id("pro");
  await crear("Proyectos", {
    ID, client_ID: cliente, code: "INT" + n, name: "Interno",
    validFrom: "2026-01-01", modality: "INTERNAL", currency: "COP",
    timeZone: "America/Bogota", status: "ACTIVE", workCalendar_ID: CALENDARIO_CO,
  });
  const reglas = await reglasDe(ID);
  assert.ok(reglas.every((r) => r.treatment === "NON_BILLABLE"));
});

test("sembrar dos veces no pisa una regla ya corregida a mano", async () => {
  const cliente = await seedCliente();
  const ID = id("pro");
  await crear("Proyectos", {
    ID, client_ID: cliente, code: "RES" + n, name: "Tiempo completo",
    validFrom: "2026-01-01", modality: "FULL_TIME", currency: "COP",
    timeZone: "America/Bogota", status: "ACTIVE", workCalendar_ID: CALENDARIO_CO,
  });
  // El contrato de este cliente sí paga el dominical.
  await cds.ql
    .UPDATE("sabnez.times.ProjectBillingRules")
    .set({ treatment: "BILLABLE_OVERTIME", billableFactor: 1.75 })
    .where({ project_ID: ID, requestedType: "SUNDAY" });

  const res = await accion("sembrarReglasFacturacion", { proyectoID: ID });
  assert.equal(res.reglasCreadas, 0);

  const [domingo] = await reglasDe(ID).where({ requestedType: "SUNDAY" });
  assert.equal(domingo.treatment, "BILLABLE_OVERTIME", "la corrección sobrevive");
  assert.equal(Number(domingo.billableFactor), 1.75);
});

test("sembrar completa lo que falte en un proyecto viejo sin matriz", async () => {
  const cliente = await seedCliente();
  const ID = id("pro");
  // Insertado por debajo del servicio, como los que ya existían.
  await INSERT.into("sabnez.times.Projects").entries({
    ID, client_ID: cliente, code: "OLD" + n, name: "Proyecto viejo",
    validFrom: "2025-01-01", modality: "HOURLY", currency: "COP",
    timeZone: "America/Bogota", status: "ACTIVE",
  });
  assert.equal((await reglasDe(ID)).length, 0);
  const res = await accion("sembrarReglasFacturacion", { proyectoID: ID });
  assert.equal(res.reglasCreadas, 7);
});

// --- corrección manual ---------------------------------------------------

test("el sábado que el cliente no aprobó: deja de facturarse y se sigue pagando", async () => {
  const cliente = await seedCliente();
  const proyecto = id("pro");
  await crear("Proyectos", {
    ID: proyecto, client_ID: cliente, code: "SAB" + n, name: "Por horas",
    validFrom: "2026-01-01", modality: "HOURLY", currency: "COP",
    timeZone: "America/Bogota", status: "ACTIVE", workCalendar_ID: CALENDARIO_CO,
  });
  const reg = await seedRegistro(proyecto, { horas: 8, tipo: "OVERTIME" });

  const res = await accion("corregirFacturacion", {
    registroIDs: [reg],
    tratamiento: "NON_BILLABLE",
    motivo: "El cliente no aprobó el sábado 29 de agosto.",
  });

  assert.equal(res.registrosActualizados, 1);
  assert.equal(Number(res.horasFacturables), 0);
  assert.equal(Number(res.horasPagables), 8);
  assert.equal(Number(res.horasPorCompensar), 8);
  assert.match(res.mensaje, /compensar|reconocidas/i);

  const guardado = await registro(reg);
  assert.equal(guardado.commercialTreatment, "NON_BILLABLE");
  assert.equal(Number(guardado.billableHours), 0);
  assert.equal(Number(guardado.payableHours), 8, "al recurso hay que responderle");
  assert.equal(guardado.treatmentOverride, "NON_BILLABLE");
  assert.equal(guardado.overriddenByUserID, "david");
  assert.ok(guardado.overriddenAt, "queda registrado cuándo se corrigió");
});

test("una corrección sin motivo se rechaza", async () => {
  const cliente = await seedCliente();
  const proyecto = id("pro");
  await crear("Proyectos", {
    ID: proyecto, client_ID: cliente, code: "MOT" + n, name: "Por horas",
    validFrom: "2026-01-01", modality: "HOURLY", currency: "COP",
    timeZone: "America/Bogota", status: "ACTIVE", workCalendar_ID: CALENDARIO_CO,
  });
  const reg = await seedRegistro(proyecto);
  await assert.rejects(
    accion("corregirFacturacion", {
      registroIDs: [reg], tratamiento: "NON_BILLABLE", motivo: "  ",
    }),
    (error) => error.code === "MOTIVO_REQUERIDO",
  );
});

test("un registro ya facturado no se puede recalificar", async () => {
  const cliente = await seedCliente();
  const proyecto = id("pro");
  await crear("Proyectos", {
    ID: proyecto, client_ID: cliente, code: "FAC" + n, name: "Por horas",
    validFrom: "2026-01-01", modality: "HOURLY", currency: "COP",
    timeZone: "America/Bogota", status: "ACTIVE", workCalendar_ID: CALENDARIO_CO,
  });
  const reg = await seedRegistro(proyecto, { status: "INVOICED" });

  const res = await accion("corregirFacturacion", {
    registroIDs: [reg],
    tratamiento: "NON_BILLABLE",
    motivo: "Intento de corregir algo ya cobrado.",
  });
  assert.equal(res.registrosActualizados, 0);
  assert.equal(res.registrosOmitidos, 1);
  assert.match(res.mensaje, /facturados|anulados/i);

  const guardado = await registro(reg);
  assert.equal(guardado.treatmentOverride, null, "la factura y el sistema no pueden discrepar");
});

test("quitar la corrección devuelve el registro a la regla del proyecto", async () => {
  const cliente = await seedCliente();
  const proyecto = id("pro");
  await crear("Proyectos", {
    ID: proyecto, client_ID: cliente, code: "UND" + n, name: "Por horas",
    validFrom: "2026-01-01", modality: "HOURLY", currency: "COP",
    timeZone: "America/Bogota", status: "ACTIVE", workCalendar_ID: CALENDARIO_CO,
  });
  const reg = await seedRegistro(proyecto, { horas: 6, tipo: "OVERTIME" });

  await accion("corregirFacturacion", {
    registroIDs: [reg], tratamiento: "NON_BILLABLE",
    motivo: "El cliente lo rechazó y después lo aceptó.",
  });
  await accion("quitarCorreccionFacturacion", { registroIDs: [reg] });

  const guardado = await registro(reg);
  assert.equal(guardado.treatmentOverride, null);
  assert.equal(guardado.commercialTreatment, "BILLABLE_OVERTIME");
  assert.equal(Number(guardado.billableHours), 6);
});

test("corregir varios registros de una vez suma la deuda de todos", async () => {
  const cliente = await seedCliente();
  const proyecto = id("pro");
  await crear("Proyectos", {
    ID: proyecto, client_ID: cliente, code: "LOT" + n, name: "Por horas",
    validFrom: "2026-01-01", modality: "HOURLY", currency: "COP",
    timeZone: "America/Bogota", status: "ACTIVE", workCalendar_ID: CALENDARIO_CO,
  });
  const uno = await seedRegistro(proyecto, { horas: 8, tipo: "SUNDAY" });
  const dos = await seedRegistro(proyecto, { horas: 4, tipo: "SUNDAY" });

  const res = await accion("corregirFacturacion", {
    registroIDs: [uno, dos],
    tratamiento: "NON_BILLABLE",
    motivo: "El cliente no aprobó el fin de semana completo.",
  });
  assert.equal(res.registrosActualizados, 2);
  assert.equal(Number(res.horasPorCompensar), 12);
});

test("sin registros seleccionados no se hace nada y se dice por qué", async () => {
  await assert.rejects(
    accion("corregirFacturacion", {
      registroIDs: [], tratamiento: "NON_BILLABLE", motivo: "Da igual.",
    }),
    (error) => error.code === "SIN_REGISTROS",
  );
});

// --- plazo de pago -------------------------------------------------------

test("el cliente guarda su condición de pago", async () => {
  const ID = id("cli");
  await crear("Clientes", {
    ID, legalName: "Cliente a 45 días", tradeName: "C45",
    projectCodePrefix: "CXD",
    taxIdentification: "900-" + n, countryCode: "CO",
    defaultCurrency: "COP", timeZone: "America/Bogota",
    paymentTermDays: 45, status: "ACTIVE",
  });
  const guardado = await SELECT.one.from("sabnez.times.Clients").where({ ID });
  assert.equal(guardado.paymentTermDays, 45);
});

test("un plazo de pago imposible se rechaza antes de desplazar la caja", async () => {
  await assert.rejects(
    crear("Clientes", {
      ID: id("cli"), legalName: "Cliente raro", tradeName: "CR",
      projectCodePrefix: "CXR",
      taxIdentification: "901-" + n, countryCode: "CO",
      defaultCurrency: "COP", timeZone: "America/Bogota",
      paymentTermDays: 4000, status: "ACTIVE",
    }),
    (error) => error.code === "PLAZO_PAGO_INVALIDO",
  );
});
