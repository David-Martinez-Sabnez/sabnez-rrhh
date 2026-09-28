"use strict";

// Desde cuándo un prestador puede cobrar por la plataforma.
//
// Los periodos anteriores a que la aplicación entrara en vigor ya se cobraron
// por fuera, así que no deben ofrecerse. El parámetro CUENTAS_COBRO_DESDE fija
// esa frontera para todos, y la fecha de corte del contrato la sustituye para
// quien deba arrancar antes —el caso de quien entró a finales del mes anterior
// y nunca alcanzó a cobrar esos días—.

const test = require("node:test");
const assert = require("node:assert/strict");
const cds = require("@sap/cds");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { INSERT, SELECT, UPDATE } = cds.ql;
let service;

const IDs = {
  employee: "cb000000-0000-4000-8000-000000000001",
  position: "cb000000-0000-4000-8000-000000000002",
  contract: "cb000000-0000-4000-8000-000000000003",
  bank: "cb000000-0000-4000-8000-000000000004",
  client: "cb000000-0000-4000-8000-000000000005",
  project: "cb000000-0000-4000-8000-000000000006",
  assignment: "cb000000-0000-4000-8000-000000000007",
  rate: "cb000000-0000-4000-8000-000000000008",
  sheet: "cb000000-0000-4000-8000-000000000009",
  entry: "cb000000-0000-4000-8000-000000000010",
};

test.before(async () => {  cds.root = ROOT;
  const csn = await cds.load([
    "db",
    "srv/collection-account-service.cds",
    "@cap-js/attachments/srv/malware-scanner/malwareScanner-mocked",
  ], { root: ROOT });
  await cds.deploy(csn).to("sqlite::memory:");
  cds.model = cds.linked(cds.compile.for.nodejs(csn));
  service = await cds.serve("CollectionAccountService").from(cds.model);
  cds.context = new cds.EventContext({ user: new cds.User.Privileged() });

  await INSERT.into("sabnez.rrhh.Cargos").entries({ ID: IDs.position, nombre: "Consultor independiente" });
  await INSERT.into("sabnez.rrhh.Empleados").entries({
    ID: IDs.employee, numeroDocumento: "123456789", tipoDocumento: "CC",
    primerNombre: "Ana", primerApellido: "Torres", nombreCompleto: "Ana Torres",
    correoCorporativo: "ana.torres@sabnez.com", fechaIngreso: "2026-07-17",
    cargo_ID: IDs.position, estado_codigo: "AC", generaCuentaCobro: true,
    lugarExpedicionDocumento: "Bogotá, D.C.", direccionTributaria: "Calle 1 # 2-3", ciudadTributaria: "Bogotá, D.C.",
  });
  await INSERT.into("sabnez.rrhh.Contratos").entries({
    ID: IDs.contract, empleado_ID: IDs.employee, tipoContrato_codigo: "PS", cargo_ID: IDs.position,
    fechaInicio: "2026-07-17", salario: 4000000, moneda: "COP", vigente: true,
    // Sin esta fecha regiría el parámetro global CUENTAS_COBRO_DESDE y el
    // escenario no llegaría a agosto. El corte propio del contrato lo sustituye.
    fechaCorteCuentaCobro: "2026-07-17",
  });
  await INSERT.into("sabnez.rrhh.CuentasBancarias").entries({
    ID: IDs.bank, empleado_ID: IDs.employee, banco: "Bancolombia", tipoCuenta: "AHORROS",
    numeroCuenta: "123456", titularNombre: "Ana Torres", titularTipoDocumento: "CC",
    titularNumeroDocumento: "123456789", moneda: "COP", principal: true, activa: true,
  });
  await INSERT.into("sabnez.times.Clients").entries({
    ID: IDs.client, legalName: "Cliente SAS", tradeName: "Cliente", taxIdentification: "900000001",
    countryCode: "CO", defaultCurrency: "COP", timeZone: "America/Bogota", status: "ACTIVE",
  });
  await INSERT.into("sabnez.times.Projects").entries({
    ID: IDs.project, client_ID: IDs.client, code: "CLI001", name: "Proyecto horario",
    validFrom: "2026-07-17", modality: "HOURLY", currency: "COP", timeZone: "America/Bogota",
    approvalScheme: "ADMIN_ONLY", status: "ACTIVE",
  });
  await INSERT.into("sabnez.times.ProjectAssignments").entries({
    ID: IDs.assignment, project_ID: IDs.project, employee_ID: IDs.employee,
    validFrom: "2026-07-17", role: "Consultora", status: "ACTIVE",
  });
  await INSERT.into("sabnez.times.AssignmentRates").entries({
    ID: IDs.rate, assignment_ID: IDs.assignment, validFrom: "2026-07-17",
    currency: "COP", internalHourlyCost: 50000,
  });
  await INSERT.into("sabnez.times.WeeklyTimesheets").entries({
    ID: IDs.sheet, assignment_ID: IDs.assignment, employee_ID: IDs.employee,
    weekStart: "2026-08-10", weekEnd: "2026-08-16", status: "INTERNALLY_APPROVED",
  });
  await INSERT.into("sabnez.times.TimeEntries").entries({
    ID: IDs.entry, timesheet_ID: IDs.sheet, assignment_ID: IDs.assignment, employee_ID: IDs.employee,
    workDate: "2026-08-10", durationHours: 8, payableHours: 8,
    requestedType: "REGULAR", status: "INTERNALLY_APPROVED",
  });

  // Horas del 28 de agosto: son las que le dan contenido al tramo 27-31,
  // que es el que abre la fecha de corte del contrato.
  await INSERT.into("sabnez.times.WeeklyTimesheets").entries({
    ID: "cb000000-0000-4000-8000-000000000011", assignment_ID: IDs.assignment,
    employee_ID: IDs.employee, weekStart: "2026-08-24", weekEnd: "2026-08-30",
    status: "INTERNALLY_APPROVED",
  });
  await INSERT.into("sabnez.times.TimeEntries").entries({
    ID: "cb000000-0000-4000-8000-000000000012",
    timesheet_ID: "cb000000-0000-4000-8000-000000000011",
    assignment_ID: IDs.assignment, employee_ID: IDs.employee,
    workDate: "2026-08-28", durationHours: 8, payableHours: 8,
    requestedType: "REGULAR", status: "INTERNALLY_APPROVED",
  });
});

const user = () => new cds.User({ id: "ana.torres@sabnez.com", roles: ["authenticated-user"] });
const send = (event, data = {}) => service.tx({ user: user() }, (tx) => tx.send(event, data));

const periodo = (lista, ini, fin) => lista.find((row) => row.periodStart === ini && row.periodEnd === fin);

async function fijarCorte({ parametro, contrato }) {
  await UPDATE("sabnez.config.Parametros").set({ valor: parametro }).where({ clave: "CUENTAS_COBRO_DESDE" });
  await UPDATE("sabnez.rrhh.Contratos").set({ fechaCorteCuentaCobro: contrato }).where({ ID: IDs.contract });
}

test("el parámetro global recorta los periodos anteriores a la entrada en vigor", async () => {
  await fijarCorte({ parametro: "2026-09-01", contrato: null });
  const periods = await send("getEligiblePeriods");

  assert.equal(periodo(periods, "2026-07-17", "2026-07-31"), undefined, "julio se cobró por fuera");
  assert.equal(periodo(periods, "2026-08-01", "2026-08-31"), undefined, "agosto también");
  assert.ok(periods.every((row) => row.periodEnd >= "2026-09-01"), "no queda nada anterior al corte");
});

test("la fecha del contrato sustituye al global y abre el arranque de quien entró antes", async () => {
  // El caso real: entró el 27 de agosto y esos días nunca se le pagaron.
  await fijarCorte({ parametro: "2026-09-01", contrato: "2026-08-27" });
  const periods = await send("getEligiblePeriods");

  const agosto = periodo(periods, "2026-08-27", "2026-08-31");
  assert.ok(agosto, "el primer ciclo se recorta contra la fecha de corte, no contra el mes entero");
  assert.equal(Number(agosto.approvedHours), 8, "sólo cuentan las horas dentro del tramo");
  assert.equal(periodo(periods, "2026-08-01", "2026-08-31"), undefined, "no aparece el mes completo");
  assert.equal(periodo(periods, "2026-07-17", "2026-07-31"), undefined, "julio sigue fuera");
});

test("el corte sólo puede retrasar el arranque, nunca adelantarlo", async () => {
  // Una fecha anterior al contrato no debe resucitar periodos previos al vínculo.
  await fijarCorte({ parametro: "2026-01-01", contrato: "2026-01-01" });
  const periods = await send("getEligiblePeriods");

  assert.ok(
    periods.every((row) => row.periodStart >= "2026-07-17"),
    "nada empieza antes de la fecha de inicio del contrato",
  );
});

test("sin parámetro ni fecha de corte se conserva el comportamiento anterior", async () => {
  await fijarCorte({ parametro: null, contrato: null });
  const periods = await send("getEligiblePeriods");

  assert.ok(periodo(periods, "2026-07-17", "2026-07-31"), "vuelve a aparecer el arranque del contrato");
  assert.ok(periodo(periods, "2026-08-01", "2026-08-31"), "y el mes completo de agosto");
});
