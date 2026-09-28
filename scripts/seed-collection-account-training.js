"use strict";

const cds = require("@sap/cds");

const runToken = Date.now().toString(36).toUpperCase();
const IDS = {
  client: "72000000-0000-4000-8000-000000000001",
  monthlyProject: cds.utils.uuid(),
  hourlyProject: cds.utils.uuid(),
  monthlyAssignment: cds.utils.uuid(),
  hourlyAssignment: cds.utils.uuid(),
  monthlyRate: cds.utils.uuid(),
  hourlyRate: cds.utils.uuid(),
};

const trainingID = () => cds.utils.uuid();

async function main() {
  cds.model = await cds.load("*");
  await cds.connect.to("db");

  const employee = await SELECT.one.from("sabnez.rrhh.Empleados").where({
    correoCorporativo: "david.martinez@sabnez.com",
  });
  if (!employee) throw new Error("No existe david.martinez@sabnez.com en la base local.");

  const contract = await SELECT.one.from("sabnez.rrhh.Contratos").where({
    empleado_ID: employee.ID,
    tipoContrato_codigo: "PS",
    fechaInicio: { "<=": "2026-08-01" },
  });
  if (!contract) throw new Error("David necesita un contrato de prestación de servicios vigente desde el 1 de agosto de 2026.");

  const bank = await SELECT.one.from("sabnez.rrhh.CuentasBancarias").where({
    empleado_ID: employee.ID,
    principal: true,
    activa: true,
  });
  if (!bank) throw new Error("David necesita una cuenta bancaria principal activa.");

  await UPSERT.into("sabnez.times.Clients").entries({
    ID: IDS.client,
    legalName: "Cliente Capacitación SAS",
    tradeName: "Cliente Capacitación",
    projectCodePrefix: "CAP",
    taxIdentification: "DEMO-CAPACITACION-CC",
    countryCode: "CO",
    defaultCurrency: "COP",
    timeZone: "America/Bogota",
    paymentTermDays: 30,
    taxExempt: false,
    status: "ACTIVE",
  });

  await UPSERT.into("sabnez.times.Projects").entries([
    {
      ID: IDS.monthlyProject,
      client_ID: IDS.client,
      code: `CAP-M-${runToken}`,
      name: `Capacitación - Servicio mensual ${runToken}`,
      description: "Datos de demostración para generar cuentas de cobro.",
      validFrom: "2026-08-01",
      validTo: "2026-08-31",
      modality: "FULL_TIME",
      currency: "COP",
      timeZone: "America/Bogota",
      requiresDescription: true,
      requiresEvidence: false,
      requiresClientApproval: false,
      approvalScheme: "ADMIN_ONLY",
      dailyWarningHours: 16,
      status: "CLOSED",
    },
    {
      ID: IDS.hourlyProject,
      client_ID: IDS.client,
      code: `CAP-H-${runToken}`,
      name: `Capacitación - Servicio por horas ${runToken}`,
      description: "Datos de demostración para generar cuentas de cobro.",
      validFrom: "2026-08-01",
      validTo: "2026-08-31",
      modality: "HOURLY",
      currency: "COP",
      timeZone: "America/Bogota",
      requiresDescription: true,
      requiresEvidence: false,
      requiresClientApproval: false,
      approvalScheme: "ADMIN_ONLY",
      dailyWarningHours: 16,
      monthlyBillableTarget: 40,
      status: "CLOSED",
    },
  ]);

  await UPSERT.into("sabnez.times.ProjectAssignments").entries([
    {
      ID: IDS.monthlyAssignment,
      project_ID: IDS.monthlyProject,
      employee_ID: employee.ID,
      validFrom: "2026-08-01",
      validTo: "2026-08-31",
      role: "Consultor mensual - Capacitación",
      commercialAllocation: 100,
      isPrimary: true,
      isBackup: false,
      status: "CLOSED",
    },
    {
      ID: IDS.hourlyAssignment,
      project_ID: IDS.hourlyProject,
      employee_ID: employee.ID,
      validFrom: "2026-08-01",
      validTo: "2026-08-31",
      role: "Consultor por horas - Capacitación",
      commercialAllocation: 100,
      isPrimary: false,
      isBackup: false,
      status: "CLOSED",
    },
  ]);

  await UPSERT.into("sabnez.times.AssignmentRates").entries([
    {
      ID: IDS.monthlyRate,
      assignment_ID: IDS.monthlyAssignment,
      validFrom: "2026-08-01",
      validTo: "2026-08-31",
      currency: "COP",
      internalMonthlyCost: 2600000,
      confidential: true,
    },
    {
      ID: IDS.hourlyRate,
      assignment_ID: IDS.hourlyAssignment,
      validFrom: "2026-08-01",
      validTo: "2026-08-31",
      currency: "COP",
      internalHourlyCost: 85000,
      confidential: true,
    },
  ]);

  const weeks = [
    ["2026-08-03", "2026-08-09"],
    ["2026-08-10", "2026-08-16"],
    ["2026-08-17", "2026-08-23"],
    ["2026-08-24", "2026-08-30"],
  ];
  const monthlySheets = weeks.map(([weekStart, weekEnd], index) => ({
    ID: trainingID(),
    assignment_ID: IDS.monthlyAssignment,
    employee_ID: employee.ID,
    weekStart,
    weekEnd,
    status: "INTERNALLY_APPROVED",
    submittedAt: `${weekEnd}T18:00:00Z`,
    internallyApprovedAt: `${weekEnd}T20:00:00Z`,
    version: 1,
  }));
  const hourlySheet = {
    ID: trainingID(),
    assignment_ID: IDS.hourlyAssignment,
    employee_ID: employee.ID,
    weekStart: "2026-08-10",
    weekEnd: "2026-08-16",
    status: "INTERNALLY_APPROVED",
    submittedAt: "2026-08-16T18:00:00Z",
    internallyApprovedAt: "2026-08-16T20:00:00Z",
    version: 1,
  };
  await UPSERT.into("sabnez.times.WeeklyTimesheets").entries([...monthlySheets, hourlySheet]);

  const monthlyDates = [
    "03", "04", "05", "06", "07", "10", "11", "12", "13", "14",
    "17", "18", "19", "20", "21", "24", "25", "26", "27", "28",
  ].map((day) => `2026-08-${day}`);
  const monthlyEntries = monthlyDates.map((workDate, index) => ({
    ID: trainingID(),
    timesheet_ID: monthlySheets[Math.floor(index / 5)].ID,
    assignment_ID: IDS.monthlyAssignment,
    employee_ID: employee.ID,
    workDate,
    durationHours: 8,
    requestedType: "REGULAR",
    description: "Servicio mensual aprobado para capacitación.",
    evidenceRequired: false,
    timeZone: "America/Bogota",
    status: "INTERNALLY_APPROVED",
    commercialTreatment: "INCLUDED_FULL_TIME",
    billableHours: 8,
    payableHours: 8,
    version: 1,
  }));
  const hourlyEntries = ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13"].map((workDate, index) => ({
    ID: trainingID(),
    timesheet_ID: hourlySheet.ID,
    assignment_ID: IDS.hourlyAssignment,
    employee_ID: employee.ID,
    workDate,
    durationHours: 8,
    requestedType: "REGULAR",
    description: "Servicio por horas aprobado para capacitación.",
    evidenceRequired: false,
    timeZone: "America/Bogota",
    status: "INTERNALLY_APPROVED",
    commercialTreatment: "BILLABLE_REGULAR",
    billableHours: 8,
    payableHours: 8,
    internalCostSnapshot: 85000,
    version: 1,
  }));
  await INSERT.into("sabnez.times.TimeEntries").entries([...monthlyEntries, ...hourlyEntries]);

  console.log("Datos de capacitación creados para David Martínez.");
  console.log(`Lote: ${runToken}. Cada ejecución crea un lote diferente.`);
  console.log("Periodo: 1 al 31 de agosto de 2026.");
  console.log("Concepto mensual: $2.600.000 COP.");
  console.log("Concepto por horas: 32 h x $85.000 = $2.720.000 COP.");
  console.log("Puede generar dos cuentas separadas o una combinada por $5.320.000 COP.");
}

main()
  .then(() => cds.shutdown())
  .catch(async (error) => {
    console.error(error.message);
    await cds.shutdown();
    process.exitCode = 1;
  });
