"use strict";

// El ciclo completo de una factura contra el servicio real: armar el
// borrador desde las horas aprobadas, emitirla con el número de Siigo,
// cobrarla y ver el resultado en el tablero.

const test = require("node:test");
const assert = require("node:assert/strict");
const cds = require("@sap/cds");

const RAIZ = require("node:path").join(__dirname, "..");
const { INSERT, SELECT, UPDATE } = cds.ql;

let srv;
let n = 0;
const id = (p) => `${p}-0000-0000-0000-${String(++n).padStart(12, "0")}`;
let cargoID;

test.before(async () => {
  cds.root = RAIZ;
  const csn = await cds.load(["db", "srv/finance-service.cds"], { root: RAIZ });
  await cds.deploy(csn).to("sqlite::memory:");
  cds.model = cds.linked(cds.compile.for.nodejs(csn));
  srv = await cds.serve("FinanceService").from(cds.model);
  cds.context = new cds.EventContext({ user: new cds.User.Privileged() });
  cargoID = id("car");
  await INSERT.into("sabnez.rrhh.Cargos").entries({ ID: cargoID, nombre: "Consultor" });
  // TRM de agosto y septiembre para las facturas en dólares.
  await INSERT.into("sabnez.finance.ExchangeRates").entries([
    { ID: id("trm"), currency: "USD", validFrom: "2026-08-31", validTo: "2026-08-31", rate: 4020, source: "BANREP" },
    { ID: id("trm"), currency: "USD", validFrom: "2026-09-30", validTo: "2026-09-30", rate: 3890, source: "BANREP" },
  ]);
});

test.beforeEach(() => {
  cds.context = new cds.EventContext({ user: new cds.User.Privileged() });
});

const USUARIO = () => new cds.User({ id: "david", roles: ["TimeFinance"] });
const accion = (evento, datos) => srv.tx({ user: USUARIO() }, (tx) => tx.send(evento, datos));

const PERFIL_BOGOTA = (client_ID) => [
  { ID: id("ret"), client_ID, type: "RETEFUENTE", label: "Retefuente servicios", rate: 4, base: "SUBTOTAL", validFrom: "2026-01-01", active: true },
  { ID: id("ret"), client_ID, type: "RETEICA", label: "ReteICA Bogotá", rate: 0.966, base: "SUBTOTAL", validFrom: "2026-01-01", active: true },
  { ID: id("ret"), client_ID, type: "RETEIVA", label: "ReteIVA", rate: 15, base: "TAX", validFrom: "2026-01-01", active: true },
];

async function seedCliente({ pais = "CO", moneda = "COP", plazo = 30, retenciones = true, exentoIVA = false } = {}) {
  const ID = id("cli");
  await INSERT.into("sabnez.times.Clients").entries({
    ID, legalName: "Axity Colombia SAS", tradeName: "Axity",
    taxIdentification: "900" + n, countryCode: pais, defaultCurrency: moneda,
    timeZone: "America/Bogota", taxExempt: exentoIVA,
    paymentTermDays: plazo, status: "ACTIVE",
  });
  if (retenciones && pais === "CO")
    await INSERT.into("sabnez.finance.ClientWithholdings").entries(PERFIL_BOGOTA(ID));
  return ID;
}

async function seedProyectoConEquipo(client_ID, { modality = "HOURLY", tarifa = {} } = {}) {
  const project_ID = id("pro");
  await INSERT.into("sabnez.times.Projects").entries({
    ID: project_ID, client_ID, code: "AXC" + n, name: "Codelco CIG",
    validFrom: "2026-01-01", modality, currency: "COP",
    monthlyBillableTarget: modality === "FULL_TIME" ? 160 : null,
    timeZone: "America/Bogota", status: "ACTIVE",
  });
  const employee_ID = id("emp");
  await INSERT.into("sabnez.rrhh.Empleados").entries({
    ID: employee_ID, numeroDocumento: "100" + n, tipoDocumento: "CC",
    primerNombre: "Camila", primerApellido: "Rojas",
    correoCorporativo: `c${n}@sabnez.com`, fechaIngreso: "2020-01-01",
    cargo_ID: cargoID, estado_codigo: "AC",
  });
  const assignment_ID = id("asi");
  await INSERT.into("sabnez.times.ProjectAssignments").entries({
    ID: assignment_ID, project_ID, employee_ID,
    validFrom: "2026-01-01", role: "Consultor", status: "ACTIVE",
  });
  await INSERT.into("sabnez.times.AssignmentRates").entries(Object.assign({
    ID: id("tar"), assignment_ID, validFrom: "2026-01-01", currency: "COP",
    regularSaleHourlyRate: 190000, overtimeSaleHourlyRate: 280000,
    internalHourlyCost: 90000,
  }, tarifa));
  const timesheet_ID = id("hoj");
  await INSERT.into("sabnez.times.WeeklyTimesheets").entries({
    ID: timesheet_ID, assignment_ID, employee_ID,
    weekStart: "2026-08-24", weekEnd: "2026-08-30", status: "OPEN",
  });
  return { project_ID, employee_ID, assignment_ID, timesheet_ID };
}

async function seedHoras(ctx, { horas = 160, tipo = "BILLABLE_REGULAR", fecha = "2026-08-20", status = "INTERNALLY_APPROVED" } = {}) {
  const ID = id("reg");
  await INSERT.into("sabnez.times.TimeEntries").entries({
    ID, timesheet_ID: ctx.timesheet_ID, assignment_ID: ctx.assignment_ID,
    employee_ID: ctx.employee_ID, workDate: fecha, durationHours: horas,
    requestedType: "REGULAR", status, commercialTreatment: tipo,
    billableHours: horas, payableHours: horas,
  });
  return ID;
}

const factura = (ID) => SELECT.one.from("sabnez.finance.Invoices").where({ ID });

// --- borrador -------------------------------------------------------------

test("los conceptos se presentan separados por recurso antes de armar el borrador", async () => {
  const cliente = await seedCliente();
  const recursoA = await seedProyectoConEquipo(cliente);
  const recursoB = await seedProyectoConEquipo(cliente);
  const registroA = await seedHoras(recursoA, { horas: 80, fecha: "2026-08-10" });
  await seedHoras(recursoB, { horas: 40, fecha: "2026-08-20" });

  const conceptos = await accion("obtenerConceptosFacturables", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31", moneda: "COP",
  });

  assert.equal(conceptos.length, 2);
  assert.ok(conceptos.every((c) => c.recurso === "Camila Rojas"));
  assert.ok(conceptos.every((c) => c.seleccionable));

  const r = await accion("generarFacturaBorrador", {
    clienteID: cliente,
    periodoDesde: "2026-08-01",
    periodoHasta: "2026-08-31",
    moneda: "COP",
    registroIDs: [registroA],
  });
  assert.equal(r.registros, 1, "sólo reserva el concepto seleccionado");
  const libre = await SELECT.one.from("sabnez.times.TimeEntries").where({ assignment_ID: recursoB.assignment_ID });
  assert.equal(libre.invoice_ID, null, "el otro recurso queda disponible para otra factura");
});

test("el borrador sale con IVA y retenciones del cliente ya calculadas", async () => {
  const cliente = await seedCliente();
  const ctx = await seedProyectoConEquipo(cliente);
  await seedHoras(ctx, { horas: 160 });

  const r = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });

  assert.equal(r.exito, true);
  assert.equal(r.lineas, 1);
  assert.equal(r.registros, 1);
  assert.equal(Number(r.total), 36176000, "160 h x 190.000 más IVA");
  assert.equal(Number(r.netoEsperado), 33799936, "esto es lo que consignan");

  const guardada = await factura(r.facturaID);
  assert.equal(guardada.status, "DRAFT");
  assert.equal(Number(guardada.subtotal), 30400000);
  assert.equal(Number(guardada.taxAmount), 5776000);
  assert.equal(Number(guardada.withheldAmount), 2376064);
  assert.equal(guardada.paymentTermDays, 30);

  const ret = await SELECT.from("sabnez.finance.InvoiceWithholdings").where({ invoice_ID: r.facturaID });
  assert.equal(ret.length, 3);
});

test("un cliente marcado como exento de IVA no genera IVA en el borrador", async () => {
  const cliente = await seedCliente({ exentoIVA: true, retenciones: false });
  const ctx = await seedProyectoConEquipo(cliente);
  await seedHoras(ctx, { horas: 10 });

  const r = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });
  const guardada = await factura(r.facturaID);
  assert.equal(Number(guardada.subtotal), 1900000);
  assert.equal(Number(guardada.taxRate), 0);
  assert.equal(Number(guardada.taxAmount), 0);
  assert.equal(Number(guardada.total), 1900000);
});

test("generar el mismo periodo dos veces no duplica el ingreso", async () => {
  const cliente = await seedCliente();
  const ctx = await seedProyectoConEquipo(cliente);
  await seedHoras(ctx, { horas: 40 });

  await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });
  await assert.rejects(
    accion("generarFacturaBorrador", {
      clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
    }),
    (e) => e.code === "SIN_HORAS_FACTURABLES",
  );
});

test("una mensualidad partida entre dos meses suma una sola tarifa del ciclo", async () => {
  const cliente = await seedCliente({ retenciones: false });
  const ctx = await seedProyectoConEquipo(cliente, {
    modality: "FULL_TIME",
    tarifa: { monthlySaleRate: 5000000 },
  });
  const cycleID = id("cic");
  await INSERT.into("sabnez.times.ReportingCycles").entries({
    ID: cycleID,
    project_ID: ctx.project_ID,
    name: "Del 16 al 15",
    cycleType: "MONTHLY",
    startDay: 16,
    endDay: 15,
    active: true,
  });
  await UPDATE("sabnez.times.ProjectAssignments")
    .set({ reportingCycle_ID: cycleID })
    .where({ ID: ctx.assignment_ID });
  await seedHoras(ctx, { horas: 88, tipo: "INCLUDED_FULL_TIME", fecha: "2026-07-20" });
  await seedHoras(ctx, { horas: 72, tipo: "INCLUDED_FULL_TIME", fecha: "2026-08-10" });

  const conceptos = await accion("obtenerConceptosFacturables", {
    clienteID: cliente,
    periodoDesde: "2026-07-16",
    periodoHasta: "2026-08-15",
    moneda: "COP",
  });
  assert.equal(conceptos.length, 1, "los fragmentos pertenecen al mismo ciclo");
  assert.equal(Number(conceptos[0].valorEstimado), 5000000);

  const borrador = await accion("generarFacturaBorrador", {
    clienteID: cliente,
    periodoDesde: "2026-07-16",
    periodoHasta: "2026-08-15",
  });
  const guardada = await factura(borrador.facturaID);
  assert.equal(Number(guardada.subtotal), 5000000);
});

test("un ciclo mensual consultado parcialmente se cobra según las horas cargadas", async () => {
  const cliente = await seedCliente({ retenciones: false });
  const ctx = await seedProyectoConEquipo(cliente, {
    modality: "FULL_TIME", tarifa: { monthlySaleRate: 5000000 },
  });
  const cycleID = id("cic");
  await INSERT.into("sabnez.times.ReportingCycles").entries({
    ID: cycleID, project_ID: ctx.project_ID, name: "Mes calendario",
    cycleType: "MONTHLY", startDay: 1, endDay: 31, active: true,
  });
  await UPDATE("sabnez.times.ProjectAssignments")
    .set({ reportingCycle_ID: cycleID })
    .where({ ID: ctx.assignment_ID });
  await seedHoras(ctx, { horas: 48, tipo: "INCLUDED_FULL_TIME", fecha: "2026-08-10" });

  const conceptos = await accion("obtenerConceptosFacturables", {
    clienteID: cliente, periodoDesde: "2026-07-16", periodoHasta: "2026-08-15", moneda: "COP",
  });
  assert.equal(conceptos.length, 1);
  assert.equal(conceptos[0].periodoDesde, "2026-08-01");
  assert.equal(conceptos[0].periodoHasta, "2026-08-15");
  assert.equal(
    Number(conceptos[0].valorEstimado),
    3333333.33,
    "48 de 72 horas hábiles; el 7 de agosto es festivo en Colombia",
  );
});

test("una asignación full time parcial se prorratea aunque se consulte el mes completo", async () => {
  const cliente = await seedCliente({ retenciones: false });
  const ctx = await seedProyectoConEquipo(cliente, {
    modality: "FULL_TIME", tarifa: { monthlySaleRate: 14160000 },
  });
  await UPDATE("sabnez.times.Projects")
    .set({ monthlyBillableTarget: 168 })
    .where({ ID: ctx.project_ID });
  const cycleID = id("cic");
  await INSERT.into("sabnez.times.ReportingCycles").entries({
    ID: cycleID, project_ID: ctx.project_ID, name: "Mes calendario",
    cycleType: "MONTHLY", startDay: 1, endDay: 31, active: true,
  });
  await UPDATE("sabnez.times.ProjectAssignments")
    .set({
      validFrom: "2026-08-17", validTo: "2026-08-31",
      reportingCycle_ID: cycleID,
    })
    .where({ ID: ctx.assignment_ID });
  await seedHoras(ctx, {
    horas: 80, tipo: "INCLUDED_FULL_TIME", fecha: "2026-08-20",
  });

  const conceptos = await accion("obtenerConceptosFacturables", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31", moneda: "COP",
  });

  assert.equal(conceptos.length, 1);
  assert.equal(conceptos[0].periodoDesde, "2026-08-17");
  assert.equal(conceptos[0].periodoHasta, "2026-08-31");
  assert.equal(
    Number(conceptos[0].valorEstimado),
    6742857.14,
    "80 de las 168 horas objetivo del proyecto",
  );
});

test("las horas que todavía no pasaron aprobación interna no se facturan", async () => {
  const cliente = await seedCliente();
  const ctx = await seedProyectoConEquipo(cliente);
  await seedHoras(ctx, { horas: 40, status: "SUBMITTED" });
  await seedHoras(ctx, { horas: 8, status: "LEADER_APPROVED" });

  await assert.rejects(
    accion("generarFacturaBorrador", {
      clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
    }),
    (e) => e.code === "SIN_HORAS_FACTURABLES",
  );
});

test("las horas no facturables no entran a la factura pero las extra sí, a su tarifa", async () => {
  const cliente = await seedCliente();
  const ctx = await seedProyectoConEquipo(cliente);
  await seedHoras(ctx, { horas: 100, tipo: "BILLABLE_REGULAR" });
  await seedHoras(ctx, { horas: 10, tipo: "BILLABLE_OVERTIME", fecha: "2026-08-22" });
  // El sábado que el cliente no aprobó: se le paga al recurso, no se cobra.
  const ID = id("reg");
  await INSERT.into("sabnez.times.TimeEntries").entries({
    ID, timesheet_ID: ctx.timesheet_ID, assignment_ID: ctx.assignment_ID,
    employee_ID: ctx.employee_ID, workDate: "2026-08-29", durationHours: 8,
    requestedType: "OVERTIME", status: "INTERNALLY_APPROVED",
    commercialTreatment: "NON_BILLABLE", billableHours: 0, payableHours: 8,
  });

  const r = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });
  assert.equal(r.lineas, 2, "ordinarias y extra en líneas distintas");
  const guardada = await factura(r.facturaID);
  assert.equal(Number(guardada.subtotal), 100 * 190000 + 10 * 280000);

  const sinCobrar = await SELECT.one.from("sabnez.times.TimeEntries").where({ ID });
  assert.equal(sinCobrar.invoice_ID, null, "el sábado no se cuela en la factura");
});

test("un proyecto de tiempo completo incompleto factura la proporción de su objetivo", async () => {
  const cliente = await seedCliente();
  const ctx = await seedProyectoConEquipo(cliente, {
    modality: "FULL_TIME",
    tarifa: { monthlySaleRate: 14000000, internalMonthlyCost: 8000000, regularSaleHourlyRate: 0 },
  });
  for (const dia of ["2026-08-10", "2026-08-11", "2026-08-12"])
    await seedHoras(ctx, { horas: 8, tipo: "INCLUDED_FULL_TIME", fecha: dia });

  const r = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });
  const guardada = await factura(r.facturaID);
  assert.equal(Number(guardada.subtotal), 2100000, "24 de las 160 horas objetivo");
  assert.equal(r.lineas, 1);
});

test("sin tarifa de venta no se arma una factura en cero: se dice por qué", async () => {
  const cliente = await seedCliente();
  const project_ID = id("pro");
  await INSERT.into("sabnez.times.Projects").entries({
    ID: project_ID, client_ID: cliente, code: "NOT" + n, name: "Sin tarifa",
    validFrom: "2026-01-01", modality: "HOURLY", currency: "COP",
    timeZone: "America/Bogota", status: "ACTIVE",
  });
  const employee_ID = id("emp");
  await INSERT.into("sabnez.rrhh.Empleados").entries({
    ID: employee_ID, numeroDocumento: "100" + n, tipoDocumento: "CC",
    primerNombre: "Sin", primerApellido: "Tarifa",
    correoCorporativo: `st${n}@sabnez.com`, fechaIngreso: "2020-01-01",
    cargo_ID: cargoID, estado_codigo: "AC",
  });
  const assignment_ID = id("asi");
  await INSERT.into("sabnez.times.ProjectAssignments").entries({
    ID: assignment_ID, project_ID, employee_ID, validFrom: "2026-01-01", status: "ACTIVE",
  });
  const timesheet_ID = id("hoj");
  await INSERT.into("sabnez.times.WeeklyTimesheets").entries({
    ID: timesheet_ID, assignment_ID, employee_ID,
    weekStart: "2026-08-24", weekEnd: "2026-08-30", status: "OPEN",
  });
  await seedHoras({ project_ID, employee_ID, assignment_ID, timesheet_ID }, { horas: 20 });

  await assert.rejects(
    accion("generarFacturaBorrador", {
      clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
    }),
    (e) => e.code === "SIN_TARIFAS",
  );
});

// --- emisión ---------------------------------------------------------------

test("emitir congela el plazo y calcula cuándo se espera la plata", async () => {
  const cliente = await seedCliente({ plazo: 45 });
  const ctx = await seedProyectoConEquipo(cliente);
  const registroID = await seedHoras(ctx, { horas: 10 });
  const borrador = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });

  const r = await accion("emitirFactura", {
    facturaID: borrador.facturaID, numero: "FV-1042", fechaEmision: "2026-09-01",
  });
  assert.equal(r.exito, true);
  assert.match(r.mensaje, /2026-10-16/, "45 días desde el 1 de septiembre");

  const guardada = await factura(borrador.facturaID);
  assert.equal(guardada.status, "ISSUED");
  assert.equal(guardada.number, "FV-1042");
  assert.equal(String(guardada.expectedPaymentDate).slice(0, 10), "2026-10-16");

  const registro = await SELECT.one.from("sabnez.times.TimeEntries").where({ ID: registroID });
  assert.equal(registro.status, "INVOICED", "las horas quedan cerradas");
});

test("no se emite sin el número que asignó Siigo", async () => {
  const cliente = await seedCliente();
  const ctx = await seedProyectoConEquipo(cliente);
  await seedHoras(ctx, { horas: 10 });
  const borrador = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });
  await assert.rejects(
    accion("emitirFactura", { facturaID: borrador.facturaID, numero: "   " }),
    (e) => e.code === "NUMERO_REQUERIDO",
  );
});

test("dos facturas no pueden llevar el mismo número", async () => {
  const cliente = await seedCliente();
  const ctx = await seedProyectoConEquipo(cliente);
  await seedHoras(ctx, { horas: 10, fecha: "2026-08-05" });
  const uno = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-10",
  });
  await accion("emitirFactura", { facturaID: uno.facturaID, numero: "FV-9001", fechaEmision: "2026-09-01" });

  await seedHoras(ctx, { horas: 10, fecha: "2026-08-15" });
  const dos = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-11", periodoHasta: "2026-08-31",
  });
  await assert.rejects(
    accion("emitirFactura", { facturaID: dos.facturaID, numero: "FV-9001", fechaEmision: "2026-09-01" }),
    (e) => e.code === "NUMERO_DUPLICADO",
  );
});

// --- exportación y diferencia en cambio ---------------------------------------

test("una factura al exterior no lleva IVA ni retenciones, y se valora a la TRM", async () => {
  const cliente = await seedCliente({ pais: "CL", moneda: "USD", plazo: 30, retenciones: false });
  const ctx = await seedProyectoConEquipo(cliente, {
    tarifa: { currency: "USD", regularSaleHourlyRate: 45, internalHourlyCost: 20 },
  });
  await seedHoras(ctx, { horas: 400 });

  const borrador = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31", moneda: "USD",
  });
  await accion("emitirFactura", {
    facturaID: borrador.facturaID, numero: "FE-0311", fechaEmision: "2026-08-31",
  });

  const guardada = await factura(borrador.facturaID);
  assert.equal(guardada.currency, "USD");
  assert.equal(guardada.exportOfServices, true);
  assert.equal(Number(guardada.taxAmount), 0, "la exportación de servicios no está gravada");
  assert.equal(Number(guardada.withheldAmount), 0);
  assert.equal(Number(guardada.total), 18000, "400 h x 45 USD");
  assert.equal(Number(guardada.exchangeRate), 4020);
  assert.equal(Number(guardada.totalCOP), 72360000);
});

test("cobrar con la TRM más baja deja la pérdida registrada y visible", async () => {
  const cliente = await seedCliente({ pais: "CL", moneda: "USD", retenciones: false });
  const ctx = await seedProyectoConEquipo(cliente, {
    tarifa: { currency: "USD", regularSaleHourlyRate: 45, internalHourlyCost: 20 },
  });
  await seedHoras(ctx, { horas: 400 });
  const borrador = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31", moneda: "USD",
  });
  await accion("emitirFactura", {
    facturaID: borrador.facturaID, numero: "FE-0312", fechaEmision: "2026-08-31",
  });

  const r = await accion("registrarRecaudo", {
    facturaID: borrador.facturaID, fecha: "2026-09-30", monto: 18000,
  });
  assert.match(r.mensaje, /cayó|perdieron/i, "hay que decirle que perdió plata");

  const guardada = await factura(borrador.facturaID);
  assert.equal(guardada.status, "PAID");
  assert.equal(Number(guardada.paidAmountCOP), 70020000, "entraron 70 millones, no 72");
  assert.equal(Number(guardada.fxDifferenceCOP), -2340000);
});

// --- recaudos --------------------------------------------------------------------

test("un abono parcial deja la factura a medio pagar y avisa el saldo", async () => {
  const cliente = await seedCliente();
  const ctx = await seedProyectoConEquipo(cliente);
  await seedHoras(ctx, { horas: 100 });
  const borrador = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });
  await accion("emitirFactura", { facturaID: borrador.facturaID, numero: "FV-7001", fechaEmision: "2026-09-01" });

  const parcial = await accion("registrarRecaudo", {
    facturaID: borrador.facturaID, fecha: "2026-10-01", monto: 5000000,
  });
  assert.match(parcial.mensaje, /saldo/i);
  assert.equal((await factura(borrador.facturaID)).status, "PARTIALLY_PAID");

  const esperado = Number((await factura(borrador.facturaID)).netExpected);
  await accion("registrarRecaudo", {
    facturaID: borrador.facturaID, fecha: "2026-10-15", monto: esperado - 5000000,
  });
  assert.equal((await factura(borrador.facturaID)).status, "PAID");
});

test("no se le registra un recaudo a un borrador", async () => {
  const cliente = await seedCliente();
  const ctx = await seedProyectoConEquipo(cliente);
  await seedHoras(ctx, { horas: 10 });
  const borrador = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });
  await assert.rejects(
    accion("registrarRecaudo", { facturaID: borrador.facturaID, fecha: "2026-10-01", monto: 100 }),
    (e) => e.code === "FACTURA_NO_COBRABLE",
  );
});

// --- anulación -------------------------------------------------------------------

test("eliminar un borrador lo quita y libera sus horas", async () => {
  const cliente = await seedCliente();
  const ctx = await seedProyectoConEquipo(cliente);
  const registroID = await seedHoras(ctx, { horas: 12 });
  const borrador = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });

  await accion("eliminarFacturaBorrador", { facturaID: borrador.facturaID });
  assert.equal(await factura(borrador.facturaID), undefined);
  const registro = await SELECT.one.from("sabnez.times.TimeEntries").where({ ID: registroID });
  assert.equal(registro.invoice_ID, null);
  assert.equal(registro.status, "CLOSED");
});

test("una factura emitida no se puede eliminar", async () => {
  const cliente = await seedCliente();
  const ctx = await seedProyectoConEquipo(cliente);
  await seedHoras(ctx, { horas: 12 });
  const borrador = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });
  await accion("emitirFactura", {
    facturaID: borrador.facturaID, numero: "FV-7099", fechaEmision: "2026-09-01",
  });
  await assert.rejects(
    accion("eliminarFacturaBorrador", { facturaID: borrador.facturaID }),
    (e) => e.code === "SOLO_BORRADORES",
  );
});

test("anular libera las horas para poder volver a facturarlas", async () => {
  const cliente = await seedCliente();
  const ctx = await seedProyectoConEquipo(cliente);
  const registroID = await seedHoras(ctx, { horas: 30 });
  const borrador = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });
  await accion("emitirFactura", { facturaID: borrador.facturaID, numero: "FV-7100", fechaEmision: "2026-09-01" });

  await accion("anularFactura", { facturaID: borrador.facturaID, motivo: "El cliente pidió cambiar el detalle." });
  assert.equal((await factura(borrador.facturaID)).status, "VOID");

  const registro = await SELECT.one.from("sabnez.times.TimeEntries").where({ ID: registroID });
  assert.equal(registro.invoice_ID, null);
  assert.equal(registro.status, "CLOSED");

  // Y se puede volver a armar el borrador con las mismas horas.
  const nuevo = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });
  assert.equal(nuevo.registros, 1);
});

test("una factura que ya recibió plata no se anula", async () => {
  const cliente = await seedCliente();
  const ctx = await seedProyectoConEquipo(cliente);
  await seedHoras(ctx, { horas: 20 });
  const borrador = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });
  await accion("emitirFactura", { facturaID: borrador.facturaID, numero: "FV-7200", fechaEmision: "2026-09-01" });
  await accion("registrarRecaudo", { facturaID: borrador.facturaID, fecha: "2026-10-01", monto: 1000000 });

  await assert.rejects(
    accion("anularFactura", { facturaID: borrador.facturaID, motivo: "Me equivoqué." }),
    (e) => e.code === "FACTURA_CON_RECAUDOS",
  );
});

// --- TRM -------------------------------------------------------------------------

test("la TRM se puede registrar a mano y queda marcada como tal", async () => {
  const r = await accion("registrarTRMManual", { fecha: "2026-07-15", valor: 4100.5, moneda: "USD" });
  assert.equal(r.exito, true);
  const consulta = await accion("obtenerTRM", { fecha: "2026-07-15", moneda: "USD" });
  assert.equal(Number(consulta.valor), 4100.5);
  assert.equal(consulta.origen, "MANUAL", "hay que poder distinguirla de la oficial");
  assert.equal(consulta.exacta, true);
});

test("registrar la TRM del mismo día dos veces corrige, no duplica", async () => {
  await accion("registrarTRMManual", { fecha: "2026-07-20", valor: 4000, moneda: "USD" });
  await accion("registrarTRMManual", { fecha: "2026-07-20", valor: 4050, moneda: "USD" });
  const filas = await SELECT.from("sabnez.finance.ExchangeRates").where({ currency: "USD", validFrom: "2026-07-20" });
  assert.equal(filas.length, 1);
  assert.equal(Number(filas[0].rate), 4050);
});

test("una consulta de TRM sin dato exacto lo dice en vez de fingir", async () => {
  const r = await accion("obtenerTRM", { fecha: "2026-07-16", moneda: "USD" });
  assert.equal(r.exacta, false);
});

// --- tablero -----------------------------------------------------------------------

test("el tablero pone el trabajo en su mes y la plata en el mes en que entra", async () => {
  // Se mide el efecto de esta factura sobre el tablero, no el total: las
  // pruebas anteriores dejaron sus propias facturas en la misma base.
  const antes = await accion("obtenerTableroFinanciero", { desde: "2026-08-01", hasta: "2026-12-31" });
  const bucket = (t, mes, campo) =>
    Number((t.meses.find((m) => m.mes === mes) || {})[campo] || 0);

  const cliente = await seedCliente({ plazo: 30 });
  const ctx = await seedProyectoConEquipo(cliente);
  await seedHoras(ctx, { horas: 100, fecha: "2026-08-20" });
  const borrador = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });
  await accion("emitirFactura", { facturaID: borrador.facturaID, numero: "FV-8001", fechaEmision: "2026-09-01" });

  const guardada = await factura(borrador.facturaID);
  assert.equal(
    String(guardada.expectedPaymentDate).slice(0, 7),
    "2026-10",
    "trabajo de agosto, factura de septiembre, plata de octubre",
  );

  const despues = await accion("obtenerTableroFinanciero", { desde: "2026-08-01", hasta: "2026-12-31" });
  const esperado = Number(guardada.netExpected);

  assert.ok(
    bucket(despues, "2026-08", "devengadoCOP") - bucket(antes, "2026-08", "devengadoCOP") >= 19000000,
    "el trabajo se devenga en agosto, cuando se hizo",
  );
  assert.equal(
    Math.round(bucket(despues, "2026-09", "facturadoCOP") - bucket(antes, "2026-09", "facturadoCOP")),
    Math.round(Number(guardada.total)),
    "se factura en septiembre",
  );
  assert.equal(
    Math.round(bucket(despues, "2026-09", "cajaEsperadaCOP") - bucket(antes, "2026-09", "cajaEsperadaCOP")),
    0,
    "pero en septiembre no entra un peso de esta factura",
  );
  assert.equal(
    Math.round(bucket(despues, "2026-10", "cajaEsperadaCOP") - bucket(antes, "2026-10", "cajaEsperadaCOP")),
    Math.round(esperado),
    "la plata llega en octubre, dos meses después del trabajo",
  );
});

test("el tablero separa lo disponible del IVA que hay que girar", async () => {
  const t = await accion("obtenerTableroFinanciero", { desde: "2026-01-01", hasta: "2026-12-31" });
  assert.ok(Number(t.ivaPorDeclararCOP) > 0, "hay IVA acumulado de las facturas nacionales");
  assert.ok(Number(t.anticiposRentaCOP) > 0, "y anticipos de renta por retefuente y reteICA");
  assert.equal(
    Number(t.disponibleCOP),
    Math.round((Number(t.cajaRecibidaCOP) - Number(t.ivaPorDeclararCOP)) * 100) / 100,
    "lo disponible es lo cobrado menos el IVA de paso",
  );
});

test("el tablero avisa de los borradores sin emitir y de la cartera vencida", async () => {
  const cliente = await seedCliente();
  const ctx = await seedProyectoConEquipo(cliente);
  await seedHoras(ctx, { horas: 5, fecha: "2026-08-03" });
  await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });

  const t = await accion("obtenerTableroFinanciero", { desde: "2026-01-01", hasta: "2026-12-31" });
  const tipos = t.avisos.map((a) => a.tipo);
  assert.ok(tipos.includes("BORRADOR"), "un borrador sin número no está proyectando caja");
});

test("la cartera se reparte por antigüedad", async () => {
  const t = await accion("obtenerTableroFinanciero", { desde: "2026-01-01", hasta: "2026-12-31" });
  assert.equal(t.cartera.length, 5);
  assert.ok(t.cartera.every((x) => x.etiqueta));
});

// --- el plazo del contrato ------------------------------------------------

test("el plazo del contrato manda sobre el del cliente", async () => {
  const cliente = await seedCliente({ plazo: 30 });
  const contrato = id("con");
  await INSERT.into("sabnez.times.ClientContracts").entries({
    ID: contrato, client_ID: cliente, reference: "CT-" + n,
    validFrom: "2026-01-01", currency: "COP", paymentTermDays: 60, status: "ACTIVE",
  });
  const ctx = await seedProyectoConEquipo(cliente);
  await cds.ql.UPDATE("sabnez.times.Projects")
    .set({ contract_ID: contrato }).where({ ID: ctx.project_ID });
  await seedHoras(ctx, { horas: 10 });

  const borrador = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });
  const guardada = await factura(borrador.facturaID);
  assert.equal(guardada.paymentTermDays, 60, "el contrato negoció 60, no los 30 del cliente");
  assert.equal(guardada.contract_ID, contrato, "y queda atribuida a ese contrato");
});

test("si la factura mezcla proyectos con y sin contrato, manda el plazo del cliente", async () => {
  const cliente = await seedCliente({ plazo: 30 });
  const contrato = id("con");
  await INSERT.into("sabnez.times.ClientContracts").entries({
    ID: contrato, client_ID: cliente, reference: "CT-" + n,
    validFrom: "2026-01-01", currency: "COP", paymentTermDays: 90, status: "ACTIVE",
  });
  const conContrato = await seedProyectoConEquipo(cliente);
  await cds.ql.UPDATE("sabnez.times.Projects")
    .set({ contract_ID: contrato }).where({ ID: conContrato.project_ID });
  const sinContrato = await seedProyectoConEquipo(cliente);
  await seedHoras(conContrato, { horas: 10 });
  await seedHoras(sinContrato, { horas: 10 });

  const borrador = await accion("generarFacturaBorrador", {
    clienteID: cliente, periodoDesde: "2026-08-01", periodoHasta: "2026-08-31",
  });
  const guardada = await factura(borrador.facturaID);
  assert.equal(guardada.paymentTermDays, 30, "no se le aplica a todo el plazo de uno solo");
  assert.equal(guardada.contract_ID, null);
});

// --- compensatorios --------------------------------------------------------

test("el sábado que el cliente no aprobó le queda debiendo horas al recurso", async () => {
  const cliente = await seedCliente();
  const ctx = await seedProyectoConEquipo(cliente);
  const ID = id("reg");
  await INSERT.into("sabnez.times.TimeEntries").entries({
    ID, timesheet_ID: ctx.timesheet_ID, assignment_ID: ctx.assignment_ID,
    employee_ID: ctx.employee_ID, workDate: "2026-08-29", durationHours: 8,
    requestedType: "OVERTIME", status: "INTERNALLY_APPROVED",
    commercialTreatment: "NON_BILLABLE", billableHours: 0, payableHours: 8,
  });

  const r = await accion("recalcularCompensatorios", {
    desde: "2026-08-01", hasta: "2026-08-31",
  });
  assert.ok(r.movimientosNuevos >= 1);

  const saldos = await accion("obtenerSaldosCompensatorios", {});
  const mio = saldos.find((s) => s.empleadoID === ctx.employee_ID);
  assert.ok(mio, "la persona debe aparecer con saldo");
  assert.equal(Number(mio.saldo), 8);
  assert.ok(Number(mio.costoEstimadoCOP) > 0, "y con su costo estimado");
});

test("recalcular dos veces no le duplica el saldo a nadie", async () => {
  const antes = await accion("obtenerSaldosCompensatorios", {});
  const total = (lista) => lista.reduce((s, x) => s + Number(x.saldo), 0);
  await accion("recalcularCompensatorios", { desde: "2026-01-01", hasta: "2026-12-31" });
  const primera = total(await accion("obtenerSaldosCompensatorios", {}));
  await accion("recalcularCompensatorios", { desde: "2026-01-01", hasta: "2026-12-31" });
  const segunda = total(await accion("obtenerSaldosCompensatorios", {}));
  assert.equal(segunda, primera, "el libro es idempotente");
  assert.ok(primera >= total(antes));
});

test("tomar el tiempo con una ausencia compensatoria baja el saldo", async () => {
  const cliente = await seedCliente();
  const ctx = await seedProyectoConEquipo(cliente);
  await INSERT.into("sabnez.times.TimeEntries").entries({
    ID: id("reg"), timesheet_ID: ctx.timesheet_ID, assignment_ID: ctx.assignment_ID,
    employee_ID: ctx.employee_ID, workDate: "2026-08-22", durationHours: 8,
    requestedType: "SUNDAY", status: "INTERNALLY_APPROVED",
    commercialTreatment: "NON_BILLABLE", billableHours: 0, payableHours: 8,
  });
  await accion("recalcularCompensatorios", { desde: "2026-08-01", hasta: "2026-08-31" });

  const conSaldo = (await accion("obtenerSaldosCompensatorios", {}))
    .find((s) => s.empleadoID === ctx.employee_ID);
  assert.equal(Number(conSaldo.saldo), 8);

  await INSERT.into("sabnez.rrhh.Ausencias").entries({
    ID: id("aus"), empleado_ID: ctx.employee_ID, tipoAusencia_codigo: "CO",
    estadoa_codigo: "APROBADA", fechaInicio: "2026-09-10", fechaFin: "2026-09-10",
    horasSolicitadas: 8,
  });
  await accion("recalcularCompensatorios", { desde: "2026-08-01", hasta: "2026-09-30" });

  const saldado = (await accion("obtenerSaldosCompensatorios", {}))
    .find((s) => s.empleadoID === ctx.employee_ID);
  assert.equal(Number(saldado.saldo), 0, "la deuda quedó saldada");
  assert.equal(Number(saldado.tomadas), 8);
});

test("el tablero muestra la deuda con el equipo y la denuncia como aviso", async () => {
  const t = await accion("obtenerTableroFinanciero", { desde: "2026-01-01", hasta: "2026-12-31" });
  assert.ok(Number(t.compensatorioHoras) > 0, "hay horas por compensar acumuladas");
  assert.ok(Number(t.compensatorioCostoCOP) > 0, "con su costo");
  assert.ok(
    t.avisos.some((a) => a.tipo === "COMPENSATORIO"),
    "y se avisa, porque es costo que no se le cobró a ningún cliente",
  );
});
