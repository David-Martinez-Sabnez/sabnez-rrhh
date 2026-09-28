"use strict";

// Acciones de baja de TimeAdminService: desactivarCliente, cerrarProyecto,
// finalizarAsignacion, y la corrección del duplicado al editar un aprobador.

const test = require("node:test");
const assert = require("node:assert/strict");
const cds = require("@sap/cds");

const RAIZ = require("node:path").join(__dirname, "..");
const { DELETE, INSERT, SELECT, UPDATE } = cds.ql;

let srv;
let db;
let n = 0;
const id = (p) => `${p}-0000-0000-0000-${String(++n).padStart(12, "0")}`;

let estadoID;
let cargoID;

// Estado y cargo son catálogo: se crean una vez, no por empleado.
//
// `cds.deploy` siembra los CSV de db/data sin preguntar, así que los
// catálogos reales ya están ahí. Insertarlos otra vez rompía el arranque
// con UNIQUE constraint y dejaba las siete pruebas sin correr.
async function seedCatalogos() {
  estadoID = "AC"; // Estados se identifica por código, no por UUID
  cargoID = id("car");
  const yaExiste = await SELECT.one
    .from("sabnez.rrhh.Estados")
    .where({ codigo: estadoID });
  if (!yaExiste)
    await INSERT.into("sabnez.rrhh.Estados").entries({
      codigo: estadoID, descripcion: "Activo",
    });
  await INSERT.into("sabnez.rrhh.Cargos").entries({
    ID: cargoID, nombre: "Consultor",
  });
}

async function seedEmpleado() {
  const ID = id("emp");
  await INSERT.into("sabnez.rrhh.Empleados").entries({
    ID,
    numeroDocumento: "100" + n,
    tipoDocumento: "CC",
    primerNombre: "Ada",
    primerApellido: "Lovelace",
    correoCorporativo: `ada${n}@sabnez.com`,
    fechaIngreso: "2020-01-01",
    cargo_ID: cargoID,
    estado_codigo: estadoID,
  });
  return ID;
}

async function seedCliente(status = "ACTIVE") {
  const ID = id("cli");
  await INSERT.into("sabnez.times.Clients").entries({
    ID, legalName: "Axity Chile SpA", tradeName: "Axity Chile",
    taxIdentification: "76138168-" + n, countryCode: "CL",
    defaultCurrency: "USD", timeZone: "America/Santiago", status,
  });
  return ID;
}

async function seedProyecto(client_ID, status = "ACTIVE", validFrom = "2026-01-01") {
  const ID = id("pro");
  await INSERT.into("sabnez.times.Projects").entries({
    ID, client_ID, code: "AXC" + n, name: "Codelco CIG " + n,
    validFrom, modality: "HOURLY", currency: "USD",
    timeZone: "America/Santiago", status,
  });
  return ID;
}

async function seedAsignacion(project_ID, employee_ID, validFrom = "2026-01-01") {
  const ID = id("asi");
  await INSERT.into("sabnez.times.ProjectAssignments").entries({
    ID, project_ID, employee_ID, validFrom, role: "Consultor", status: "ACTIVE",
  });
  return ID;
}

test.before(async () => {
  cds.root = RAIZ;
  const csn = await cds.load(["db", "srv/time-admin-service.cds"], { root: RAIZ });
  db = await cds.deploy(csn).to("sqlite::memory:");
  cds.model = cds.linked(cds.compile.for.nodejs(csn));
  srv = await cds.serve("TimeAdminService").from(cds.model);
  cds.context = new cds.EventContext({ user: new cds.User.Privileged() });
  await seedCatalogos();
});

// El servicio exige el rol TimeAdmin, también en llamadas internas.
const USUARIO = () => new cds.User({
  id: "tester",
  roles: ["TimeAdmin", "TimeFinance", "TimeAssignmentReactivate"],
});
const accion = (evento, datos) => srv.tx({ user: USUARIO() }, (tx) => tx.send(evento, datos));

// Los eventos CRUD se mandan como consulta, no como mensaje suelto: el
// manejador genérico de CAP necesita un req.query y si no lo hay responde
// 501 "The request has no query and cannot be served generically".
const crear = (entidad, datos) =>
  srv.tx({ user: USUARIO() }, (tx) => tx.run(INSERT.into(entidad).entries(datos)));
const actualizar = (entidad, ID, datos) =>
  srv.tx({ user: USUARIO() }, (tx) => tx.run(UPDATE(entidad, ID).with(datos)));

// Sin contexto activo las consultas quedan colgadas fuera de una petición.
test.beforeEach(() => {
  cds.context = new cds.EventContext({ user: new cds.User.Privileged() });
});

test("desactivarCliente se bloquea si quedan proyectos abiertos", async () => {
  const cliente = await seedCliente();
  await seedProyecto(cliente, "ACTIVE");
  await assert.rejects(
    () => accion("desactivarCliente", { clienteID: cliente }),
    (error) => /proyecto\(s\) siguen abiertos/.test(error.message),
  );
  const row = await SELECT.one.from("sabnez.times.Clients").where({ ID: cliente });
  assert.equal(row.status, "ACTIVE", "el cliente no debe cambiar de estado");
});

test("desactivarCliente desactiva el cliente y sus contratos en cascada", async () => {
  const cliente = await seedCliente();
  await seedProyecto(cliente, "CLOSED");
  const contrato = id("con");
  await INSERT.into("sabnez.times.ClientContracts").entries({
    ID: contrato, client_ID: cliente, reference: "MSA-" + n,
    validFrom: "2026-01-01", currency: "USD", status: "ACTIVE",
  });

  const res = await accion("desactivarCliente", { clienteID: cliente });

  assert.equal(res.exito, true);
  assert.equal(res.contratosDesactivados, 1);
  assert.equal((await SELECT.one.from("sabnez.times.Clients").where({ ID: cliente })).status, "INACTIVE");
  assert.equal((await SELECT.one.from("sabnez.times.ClientContracts").where({ ID: contrato })).status, "INACTIVE");
});

test("cerrarProyecto cierra asignaciones, aprobadores y tarifas conservando el histórico", async () => {
  const empleado = await seedEmpleado();
  const cliente = await seedCliente();
  const proyecto = await seedProyecto(cliente);
  const asignacion = await seedAsignacion(proyecto, empleado);
  const aprobador = id("apr");
  await INSERT.into("sabnez.times.ProjectApprovers").entries({
    ID: aprobador, project_ID: proyecto, employee_ID: empleado,
    approverType: "LEADER", validFrom: "2026-01-01", active: true,
  });
  const tarifa = id("tar");
  await INSERT.into("sabnez.times.AssignmentRates").entries({
    ID: tarifa, assignment_ID: asignacion, validFrom: "2026-01-01",
    currency: "USD", regularSaleHourlyRate: 35,
  });

  const res = await accion("cerrarProyecto", {
    proyectoID: proyecto, fechaCierre: "2026-06-30",
  });

  assert.equal(res.asignacionesCerradas, 1);
  assert.equal(res.aprobadoresCerrados, 1);

  const p = await SELECT.one.from("sabnez.times.Projects").where({ ID: proyecto });
  assert.equal(p.status, "CLOSED");
  assert.equal(p.validTo, "2026-06-30");

  const a = await SELECT.one.from("sabnez.times.ProjectAssignments").where({ ID: asignacion });
  assert.equal(a.status, "INACTIVE");
  assert.equal(a.validTo, "2026-06-30");

  const ap = await SELECT.one.from("sabnez.times.ProjectApprovers").where({ ID: aprobador });
  assert.equal(ap.active, false);

  const t = await SELECT.one.from("sabnez.times.AssignmentRates").where({ ID: tarifa });
  assert.ok(t, "la tarifa debe seguir existiendo para facturar lo trabajado");
  assert.equal(t.validTo, "2026-06-30", "la tarifa queda vigente hasta el cierre");
});

test("cerrarProyecto respeta una asignación que ya terminaba antes del cierre", async () => {
  const empleado = await seedEmpleado();
  const cliente = await seedCliente();
  const proyecto = await seedProyecto(cliente);
  const asignacion = await seedAsignacion(proyecto, empleado);
  await cds.ql.UPDATE("sabnez.times.ProjectAssignments")
    .set({ validTo: "2026-03-31" }).where({ ID: asignacion });

  await accion("cerrarProyecto", { proyectoID: proyecto, fechaCierre: "2026-06-30" });

  const a = await SELECT.one.from("sabnez.times.ProjectAssignments").where({ ID: asignacion });
  assert.equal(a.validTo, "2026-03-31", "no se debe alargar una asignación ya terminada");
});

test("cerrarProyecto se bloquea si hay hojas semanales sin aprobar", async () => {
  const empleado = await seedEmpleado();
  const cliente = await seedCliente();
  const proyecto = await seedProyecto(cliente);
  const asignacion = await seedAsignacion(proyecto, empleado);
  await INSERT.into("sabnez.times.WeeklyTimesheets").entries({
    ID: id("hoj"), assignment_ID: asignacion, employee_ID: empleado,
    weekStart: "2026-06-01", weekEnd: "2026-06-07", status: "SUBMITTED",
  });

  await assert.rejects(
    () => accion("cerrarProyecto", { proyectoID: proyecto, fechaCierre: "2026-06-30" }),
    (error) => /hoja\(s\) semanal\(es\) sin aprobar/.test(error.message),
  );
  assert.equal(
    (await SELECT.one.from("sabnez.times.Projects").where({ ID: proyecto })).status,
    "ACTIVE",
    "un cierre bloqueado no debe dejar el proyecto a medias",
  );
});

test("finalizarAsignacion se bloquea si hay tiempos posteriores a la fecha", async () => {
  const empleado = await seedEmpleado();
  const cliente = await seedCliente();
  const proyecto = await seedProyecto(cliente);
  const asignacion = await seedAsignacion(proyecto, empleado);
  const hoja = id("hoj");
  await INSERT.into("sabnez.times.WeeklyTimesheets").entries({
    ID: hoja, assignment_ID: asignacion, employee_ID: empleado,
    weekStart: "2026-07-06", weekEnd: "2026-07-12", status: "CLOSED",
  });
  await INSERT.into("sabnez.times.TimeEntries").entries({
    ID: id("reg"), timesheet_ID: hoja, assignment_ID: asignacion,
    employee_ID: empleado, workDate: "2026-07-08", durationHours: 8,
  });

  await assert.rejects(
    () => accion("finalizarAsignacion", { asignacionID: asignacion, fechaFin: "2026-06-30" }),
    (error) => /registro\(s\) de tiempo posteriores/.test(error.message),
  );
});

test("reactivarAsignacion crea una nueva vigencia y conserva el histórico", async () => {
  const empleado = await seedEmpleado();
  const cliente = await seedCliente();
  const proyecto = await seedProyecto(cliente);
  const asignacion = await seedAsignacion(proyecto, empleado);
  await UPDATE("sabnez.times.ProjectAssignments")
    .set({ status: "INACTIVE", validTo: "2026-06-30" })
    .where({ ID: asignacion });
  await INSERT.into("sabnez.times.AssignmentRates").entries({
    ID: id("tar"), assignment_ID: asignacion, validFrom: "2026-01-01",
    validTo: "2026-06-30", currency: "USD", saleCurrency: "USD",
    costCurrency: "COP", regularSaleHourlyRate: 25, internalHourlyCost: 40000,
  });

  const res = await accion("reactivarAsignacion", {
    asignacionID: asignacion, fechaApertura: "2026-07-01",
  });

  assert.equal(res.exito, true);
  const rows = await SELECT.from("sabnez.times.ProjectAssignments")
    .where({ project_ID: proyecto, employee_ID: empleado });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.ID === asignacion).validTo, "2026-06-30");
  const nueva = rows.find((row) => row.ID !== asignacion);
  assert.equal(nueva.status, "ACTIVE");
  assert.equal(nueva.validFrom, "2026-07-01");
  const tarifa = await SELECT.one.from("sabnez.times.AssignmentRates")
    .where({ assignment_ID: nueva.ID });
  assert.equal(Number(tarifa.regularSaleHourlyRate), 25);
  assert.equal(Number(tarifa.internalHourlyCost), 40000);
  assert.equal(tarifa.saleCurrency, "USD");
  assert.equal(tarifa.costCurrency, "COP");
});

test("reactivarAsignacion exige el rol especializado", async () => {
  const usuarioSinPermiso = new cds.User({ id: "admin", roles: ["TimeAdmin"] });
  await assert.rejects(
    () => srv.tx({ user: usuarioSinPermiso }, (tx) => tx.send("reactivarAsignacion", {
      asignacionID: id("asi"), fechaApertura: "2026-07-01",
    })),
    (error) => error.code === 403,
  );
});

test("editar un aprobador existente no se detecta a sí mismo como duplicado", async () => {
  const empleado = await seedEmpleado();
  const cliente = await seedCliente();
  const proyecto = await seedProyecto(cliente);
  const aprobador = id("apr");
  await INSERT.into("sabnez.times.ProjectApprovers").entries({
    ID: aprobador, project_ID: proyecto, employee_ID: empleado,
    approverType: "ADMIN", validFrom: "2026-01-01", active: true,
  });

  await srv.tx({ user: USUARIO() }, (tx) =>
    tx.run(
      cds.ql
        .UPDATE("TimeAdminService.Aprobadores")
        .set({
          project_ID: proyecto, employee_ID: empleado, approverType: "ADMIN",
          validFrom: "2026-02-01", validTo: null, active: true,
        })
        .where({ ID: aprobador }),
    ),
  );

  const row = await SELECT.one.from("sabnez.times.ProjectApprovers").where({ ID: aprobador });
  assert.equal(row.validFrom, "2026-02-01");
});

test("permite crear una tarifa histórica para una asignación cerrada", async () => {
  const empleado = await seedEmpleado();
  const cliente = await seedCliente();
  const proyecto = await seedProyecto(cliente);
  const asignacion = await seedAsignacion(proyecto, empleado, "2026-08-01");
  await cds.ql.UPDATE("sabnez.times.ProjectAssignments")
    .set({ status: "INACTIVE", validTo: "2026-08-15" })
    .where({ ID: asignacion });

  const tarifa = id("tar");
  await crear("TimeAdminService.Tarifas", {
    ID: tarifa,
    assignment_ID: asignacion,
    validFrom: "2026-08-01",
    currency: "COP",
    regularSaleHourlyRate: 84285,
  });

  const row = await SELECT.one.from("sabnez.times.AssignmentRates").where({ ID: tarifa });
  assert.equal(row.validFrom, "2026-08-01");
  assert.equal(row.validTo, "2026-08-15", "la tarifa histórica debe cerrarse con la asignación");
});

test("rechaza editar la tarifa de una asignación cerrada", async () => {
  const empleado = await seedEmpleado();
  const cliente = await seedCliente();
  const proyecto = await seedProyecto(cliente);
  const asignacion = await seedAsignacion(proyecto, empleado, "2026-08-01");
  const tarifa = id("tar");
  await INSERT.into("sabnez.times.AssignmentRates").entries({
    ID: tarifa, assignment_ID: asignacion, validFrom: "2026-08-01",
    validTo: "2026-08-15", currency: "COP", regularSaleHourlyRate: 80000,
  });
  await cds.ql.UPDATE("sabnez.times.ProjectAssignments")
    .set({ status: "INACTIVE", validTo: "2026-08-15" })
    .where({ ID: asignacion });

  await assert.rejects(
    () => actualizar("TimeAdminService.Tarifas", tarifa, { regularSaleHourlyRate: 84285 }),
    // Se afirma sobre el código, que es el contrato estable; el texto del
    // mensaje puede reescribirse sin que eso sea una regresión.
    (error) => error.code === "REGISTRO_CERRADO",
  );
});

test("completarClasificacionComercial crea reglas y reclasifica pendientes", async () => {
  const empleado = await seedEmpleado();
  const cliente = await seedCliente();
  const proyecto = await seedProyecto(cliente);
  const asignacion = await seedAsignacion(proyecto, empleado);
  const hoja = id("hoj");
  const registro = id("reg");

  // completarClasificacionComercial barre TODOS los registros pendientes de la
  // base, así que la prueba tiene que partir de un estado conocido: otras
  // pruebas dejan registros con el commercialTreatment 'PENDING' por defecto.
  await DELETE.from("sabnez.times.TimeEntries");
  await INSERT.into("sabnez.times.WeeklyTimesheets").entries({
    ID: hoja,
    assignment_ID: asignacion,
    employee_ID: empleado,
    weekStart: "2026-08-03",
    weekEnd: "2026-08-09",
    status: "INTERNALLY_APPROVED",
  });
  await INSERT.into("sabnez.times.TimeEntries").entries({
    ID: registro,
    timesheet_ID: hoja,
    assignment_ID: asignacion,
    employee_ID: empleado,
    workDate: "2026-08-03",
    durationHours: 8,
    requestedType: "REGULAR",
    status: "INTERNALLY_APPROVED",
    commercialTreatment: "PENDING",
    billableHours: 0,
    payableHours: 0,
  });

  const result = await accion("completarClasificacionComercial", {});
  const saved = await SELECT.one
    .from("sabnez.times.TimeEntries")
    .where({ ID: registro });
  const rules = await SELECT.from("sabnez.times.ProjectBillingRules").where({
    project_ID: proyecto,
  });

  assert.equal(result.exito, true);
  assert.equal(result.registrosReclasificados, 1);
  assert.equal(result.horasFacturables, 8);
  assert.equal(rules.length, 7);
  assert.equal(saved.commercialTreatment, "BILLABLE_REGULAR");
  assert.equal(Number(saved.billableHours), 8);
  assert.equal(Number(saved.payableHours), 8);
});

test("una nueva asignación hereda la última tarifa del empleado en el proyecto", async () => {
  const empleado = await seedEmpleado();
  const cliente = await seedCliente();
  const proyecto = await seedProyecto(cliente);
  const anterior = await seedAsignacion(proyecto, empleado, "2026-08-01");
  await INSERT.into("sabnez.times.AssignmentRates").entries({
    ID: id("tar"), assignment_ID: anterior, validFrom: "2026-08-01",
    validTo: "2026-08-15", currency: "COP", regularSaleHourlyRate: 84285,
    monthlySaleRate: 14160000,
  });
  await cds.ql.UPDATE("sabnez.times.ProjectAssignments")
    .set({ status: "INACTIVE", validTo: "2026-08-15" }).where({ ID: anterior });

  const nueva = id("asi");
  await srv.tx({ user: USUARIO() }, (tx) =>
    tx.run(INSERT.into("TimeAdminService.Asignaciones").entries({
      ID: nueva, project_ID: proyecto, employee_ID: empleado,
      validFrom: "2026-09-01", role: "Consultor", status: "ACTIVE",
    })),
  );

  const inherited = await SELECT.one.from("sabnez.times.AssignmentRates")
    .where({ assignment_ID: nueva });
  assert.ok(inherited);
  assert.equal(inherited.validFrom, "2026-09-01");
  assert.equal(Number(inherited.regularSaleHourlyRate), 84285);
  assert.equal(Number(inherited.monthlySaleRate), 14160000);
});
