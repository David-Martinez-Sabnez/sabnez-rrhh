"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const cds = require("@sap/cds");
const path = require("node:path");
const { streamToBuffer } = require("../srv/lib/stream-utils");

const ROOT = path.join(__dirname, "..");
const { INSERT, SELECT, UPDATE } = cds.ql;
let service;

const IDs = {
  employee: "ca000000-0000-4000-8000-000000000001",
  position: "ca000000-0000-4000-8000-000000000002",
  contract: "ca000000-0000-4000-8000-000000000003",
  bank: "ca000000-0000-4000-8000-000000000004",
  client: "ca000000-0000-4000-8000-000000000005",
  project: "ca000000-0000-4000-8000-000000000006",
  assignment: "ca000000-0000-4000-8000-000000000007",
  rate: "ca000000-0000-4000-8000-000000000008",
  sheet: "ca000000-0000-4000-8000-000000000009",
  entry: "ca000000-0000-4000-8000-000000000010",
};

test.before(async () => {
  cds.root = ROOT;
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
});

const user = () => new cds.User({ id: "ana.torres@sabnez.com", roles: ["authenticated-user"] });
const send = (event, data = {}) => service.tx({ user: user() }, (tx) => tx.send(event, data));
const financeUser = () => new cds.User({ id: "ana.torres@sabnez.com", roles: ["authenticated-user", "CollectionAccountHR", "TimeFinance"] });
const sendFinance = (event, data = {}) => service.tx({ user: financeUser() }, (tx) => tx.send(event, data));

test("usa el ciclo corporativo y no lo ancla a la fecha inicial", async () => {
  const periods = await send("getEligiblePeriods");
  const period = periods.find((row) => row.periodStart === "2026-08-01" && row.periodEnd === "2026-08-31");
  assert.ok(period, "debe existir el periodo de agosto según el ciclo 1-fin de mes");
  assert.equal(period.eligible, true);
  assert.equal(Number(period.approvedHours), 8);
  assert.equal(Number(period.amount), 400000);
  assert.equal(period.securityRequirement, "AFFILIATION");
});

test("genera una cuenta bruta, evita reclamar dos veces y registra la firma", async () => {
  const periods = await send("getEligiblePeriods");
  const period = periods.find((row) => row.periodStart === "2026-08-01" && row.periodEnd === "2026-08-31");
  const created = await send("createAccounts", { selections: [{ periodKey: period.periodKey }], combine: true });
  assert.equal(created.success, true);
  assert.equal(Number(created.account.grossAmount), 400000);
  assert.equal(created.account.status, "PENDING_SIGNATURE");

  const after = await send("getEligiblePeriods");
  assert.equal(after.some((row) => row.periodKey === period.periodKey), false, "el mismo periodo no debe poder reclamarse dos veces");

  const signed = await send("signAccount", { accountID: created.account.ID, signerName: "Ana Torres", accepted: true });
  assert.equal(signed.account.status, "SIGNED");
  const stored = await SELECT.one.from("sabnez.collectionaccounts.CollectionAccounts").where({ ID: created.account.ID });
  assert.match(stored.generatedFileName, /\.pdf$/);
  assert.equal(stored.generatedMimeType, "application/pdf");
  assert.match(stored.generatedHash, /^[a-f0-9]{64}$/);
  assert.match(stored.signatureHash, /^[a-f0-9]{64}$/);

  const evidence = await send("uploadSocialSecurity", {
    accountID: created.account.ID,
    fileName: "afiliacion.pdf",
    mimeType: "application/pdf",
    content: Buffer.from("%PDF-1.4 soporte de afiliacion"),
  });
  assert.equal(evidence.account.hasSocialEvidence, true);

  const doc = await send("downloadAccount", { accountID: created.account.ID });
  assert.match(doc.fileName, /\.pdf$/);
  assert.equal(doc.mimeType, "application/pdf");
  const docBytes = Buffer.from(doc.contentBase64, "base64");
  assert.ok(docBytes.length > 0, "el PDF descargado no puede venir vacío");
  assert.equal(docBytes.slice(0, 5).toString("utf8"), "%PDF-", "el PDF descargado debe empezar por la cabecera %PDF-");

  const support = await send("downloadSocialSecurity", { accountID: created.account.ID });
  assert.equal(support.mimeType, "application/pdf");
  assert.equal(Buffer.from(support.contentBase64, "base64").toString("utf8"), "%PDF-1.4 soporte de afiliacion");

  const submitted = await send("submitAccount", { accountID: created.account.ID });
  assert.equal(submitted.account.status, "SUBMITTED");

  // El envío ya no aprueba desde esta app: abre una tarea en el Centro de
  // Aprobaciones para el pool de RR. HH.
  const instancia = await SELECT.one
    .from("sabnez.approvals.ApprovalInstances")
    .where({ businessObjectID: created.account.ID });
  assert.ok(instancia, "debe existir una instancia de aprobación para la cuenta");
  assert.equal(instancia.processCode, "COLLECTION_ACCOUNT");
  assert.equal(instancia.businessObjectType, "CollectionAccount");
  assert.equal(instancia.titulo, created.account.number);
});

test("Finanzas crea una cuenta asistida y carga el expediente firmado", async () => {
  const employees = await sendFinance("getAssistedEmployees");
  const option = employees.find((row) => row.ID === IDs.employee);
  assert.ok(option, "el empleado activo debe aparecer en el selector");
  assert.equal(option.documentNumber, "123456789");
  assert.equal(option.bankName, "Bancolombia");
  assert.equal(option.hasActiveBank, true);

  const created = await sendFinance("createAssistedAccount", {
    employeeID: IDs.employee,
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    concept: "Servicios generales por horas",
    grossAmount: 640000,
    currency: "COP",
    socialSecurityRequirement: "NONE",
  });
  assert.equal(created.success, true);
  assert.equal(created.account.origin, "ASSISTED_FINANCE");
  assert.equal(Buffer.from(created.contentBase64, "base64").slice(0, 5).toString(), "%PDF-");

  const storedDraft = await SELECT.one.from("sabnez.collectionaccounts.CollectionAccounts").where({ ID: created.account.ID });
  assert.equal(storedDraft.employee_ID, IDs.employee);
  assert.equal(storedDraft.contract_ID, null);
  assert.equal(storedDraft.status, "PENDING_SIGNATURE");
  assert.equal(storedDraft.employeeNameSnapshot, "Ana Torres");
  assert.equal(storedDraft.documentNumberSnapshot, "123456789");
  assert.equal(storedDraft.bankNameSnapshot, "Bancolombia");
  assert.equal(storedDraft.socialSecurityStatus, "NOT_REQUIRED");

  const uploaded = await sendFinance("uploadAssistedSignedPackage", {
    accountID: created.account.ID,
    signedFileName: "cuenta-firmada.pdf",
    signedMimeType: "application/pdf",
    signedContent: Buffer.from("%PDF-1.4 cuenta firmada a mano"),
    supportFileName: null,
    supportMimeType: null,
    supportContent: null,
  });
  assert.equal(uploaded.account.status, "SUBMITTED");
  assert.equal(uploaded.account.signatureMethod, "MANUSCRIPT");
  assert.equal(uploaded.account.hasSocialEvidence, true, "la exención explícita completa el requisito documental");

  const approval = await SELECT.one.from("sabnez.approvals.ApprovalInstances")
    .where({ businessObjectID: created.account.ID });
  assert.ok(approval, "la cuenta asistida debe entrar al circuito normal de aprobación");
  assert.equal(approval.solicitante_ID, IDs.employee, "Finanzas queda registrado como solicitante");
});

test("el total cobrado solo suma las cuentas aprobadas para pago", async () => {
  const antes = await send("getContext");
  assert.equal(Number(antes.approvedAmount), 0, "sin aprobaciones el acumulado arranca en cero");
  assert.equal(antes.approvedCount, 0);

  const cuentas = await SELECT.from("sabnez.collectionaccounts.CollectionAccounts");
  assert.ok(cuentas.length >= 1, "debe existir la cuenta del escenario anterior");
  const cuenta = cuentas[0];

  // La aprobación real ocurre en el Centro de Aprobaciones; aquí basta con
  // dejar la cuenta en el estado final para verificar el acumulado.
  await UPDATE("sabnez.collectionaccounts.CollectionAccounts")
    .set({ status: "HR_APPROVED" })
    .where({ ID: cuenta.ID });

  const despues = await send("getContext");
  assert.equal(Number(despues.approvedAmount), Number(cuenta.grossAmount));
  assert.equal(despues.approvedCount, 1);
  assert.equal(despues.currency, cuenta.currency);

  // Una cuenta devuelta no suma: solo cuenta lo autorizado para pago.
  await UPDATE("sabnez.collectionaccounts.CollectionAccounts")
    .set({ status: "HR_REJECTED" })
    .where({ ID: cuenta.ID });
  const devuelta = await send("getContext");
  assert.equal(Number(devuelta.approvedAmount), 0);
  assert.equal(devuelta.approvedCount, 0);

  await UPDATE("sabnez.collectionaccounts.CollectionAccounts")
    .set({ status: "SUBMITTED" })
    .where({ ID: cuenta.ID });
});

test("solo salen a contabilidad los expedientes aprobados y completos", async () => {
  const hr = () => new cds.User({ id: "camila.sabogal@sabnez.com", roles: ["authenticated-user", "CollectionAccountHR"] });
  const enviarHR = (event, data = {}) => service.tx({ user: hr() }, (tx) => tx.send(event, data));

  const cuenta = (await SELECT.from("sabnez.collectionaccounts.CollectionAccounts"))[0];
  assert.ok(cuenta, "debe existir la cuenta del escenario anterior");

  // Mientras no esté aprobada, no aparece como candidata.
  await UPDATE("sabnez.collectionaccounts.CollectionAccounts").set({ status: "SUBMITTED" }).where({ ID: cuenta.ID });
  assert.equal((await enviarHR("getAccountingCandidates", {})).length, 0);

  await assert.rejects(
    () => enviarHR("enviarCuentasAContabilidad", { accountIDs: [cuenta.ID] }),
    (error) => error.code === "CUENTA_NO_APROBADA",
    "una cuenta sin aprobar no se le manda a la contadora",
  );

  await assert.rejects(
    () => enviarHR("enviarCuentasAContabilidad", { accountIDs: [] }),
    (error) => error.code === "SELECCION_VACIA",
  );

  // Ya aprobada, aparece como candidata lista para enviar.
  await UPDATE("sabnez.collectionaccounts.CollectionAccounts")
    .set({ status: "HR_APPROVED", hrReviewedAt: new Date().toISOString() })
    .where({ ID: cuenta.ID });

  const candidatas = await enviarHR("getAccountingCandidates", {});
  assert.equal(candidatas.length, 1);
  assert.equal(candidatas[0].number, cuenta.numero);
  assert.equal(candidatas[0].readyToSend, true, "tiene PDF firmado y soporte validado");
  assert.equal(candidatas[0].hasDocument, true);
  assert.equal(candidatas[0].hasSocialEvidence, true);

  // CAP no incluye LargeBinary en SELECT *. El envío debe solicitarlos de
  // forma explícita para que el ZIP reciba el PDF y el soporte reales.
  const expediente = await SELECT.one
    .from("sabnez.collectionaccounts.CollectionAccounts")
    .columns("*", "generatedContent", "socialSecurityContent")
    .where({ ID: cuenta.ID });
  assert.ok((await streamToBuffer(expediente.generatedContent))?.length > 0);
  assert.ok((await streamToBuffer(expediente.socialSecurityContent))?.length > 0);

  // Sin soporte deja de estar lista, y el motivo se ve antes de enviar.
  await UPDATE("sabnez.collectionaccounts.CollectionAccounts")
    .set({ socialSecurityStatus: null })
    .where({ ID: cuenta.ID });
  const sinSoporte = await enviarHR("getAccountingCandidates", {});
  assert.equal(sinSoporte[0].readyToSend, false);
  assert.match(sinSoporte[0].blockingReason, /soporte de seguridad social/i);

  await UPDATE("sabnez.collectionaccounts.CollectionAccounts")
    .set({ socialSecurityStatus: "CLEAN", status: "SUBMITTED" })
    .where({ ID: cuenta.ID });
});

test("el correo de contabilidad se lee y se edita desde los parámetros", async () => {
  const admin = () => new cds.User({ id: "david.martinez@sabnez.com", roles: ["authenticated-user", "CollectionAccountHR", "Admin"] });
  const enviarAdmin = (event, data = {}) => service.tx({ user: admin() }, (tx) => tx.send(event, data));

  const parametros = await enviarAdmin("getParametros", {});
  const contabilidad = parametros.find((row) => row.clave === "CONTABILIDAD_EMAIL");
  assert.ok(contabilidad, "el parámetro del correo de contabilidad debe venir sembrado");
  assert.equal(contabilidad.valor, "contabilidad@sabnez.com");
  assert.equal(contabilidad.sistema, true, "es un parámetro que el código necesita que exista");

  await assert.rejects(
    () => enviarAdmin("guardarParametro", { clave: "CONTABILIDAD_EMAIL", valor: "esto-no-es-un-correo" }),
    (error) => error.code === "CORREO_INVALIDO",
  );

  const guardado = await enviarAdmin("guardarParametro", { clave: "CONTABILIDAD_EMAIL", valor: "conta@sabnez.com" });
  assert.equal(guardado.success, true);
  assert.equal(guardado.parametro.valor, "conta@sabnez.com");

  await enviarAdmin("guardarParametro", { clave: "CONTABILIDAD_EMAIL", valor: "contabilidad@sabnez.com" });
});

test("el histórico se filtra por año y por periodo", async () => {
  const todas = await send("getMyAccounts");
  assert.ok(todas.length >= 1, "debe existir al menos una cuenta del escenario anterior");
  const cuenta = todas[0];
  const año = Number(String(cuenta.periodEnd).slice(0, 4));

  const delAño = await send("getMyAccounts", { year: año });
  assert.equal(delAño.length, todas.length, "todas las cuentas del escenario son del mismo año");

  const deOtroAño = await send("getMyAccounts", { year: año - 5 });
  assert.equal(deOtroAño.length, 0, "un año sin cuentas devuelve la lista vacía");

  const opciones = await send("getAccountFilterOptions");
  assert.ok(opciones.years.some((row) => row.year === año), "el año debe aparecer entre las opciones");
  const periodo = opciones.periods.find(
    (row) => row.periodStart === cuenta.periodStart && row.periodEnd === cuenta.periodEnd,
  );
  assert.ok(periodo, "el periodo de la cuenta debe aparecer entre las opciones");

  const delPeriodo = await send("getMyAccounts", { periodKey: periodo.periodKey });
  assert.ok(delPeriodo.length >= 1);
  assert.ok(delPeriodo.every((row) => row.periodStart === cuenta.periodStart));

  const dePeriodoInexistente = await send("getMyAccounts", { periodKey: "1999-01-01|1999-01-31" });
  assert.equal(dePeriodoInexistente.length, 0);
});
