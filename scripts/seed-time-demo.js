"use strict";

const cds = require("@sap/cds");

const IDS = {
  client: "71000000-0000-4000-8000-000000000001",
  project: "71000000-0000-4000-8000-000000000002",
  cycle: "71000000-0000-4000-8000-000000000003",
  assignment: "71000000-0000-4000-8000-000000000004",
};

async function main() {
  cds.model = await cds.load("*");
  await cds.connect.to("db");
  const employee = await SELECT.one.from("sabnez.rrhh.Empleados").where({
    correoCorporativo: "david.martinez@sabnez.com",
  });

  if (!employee) {
    throw new Error(
      "No existe el empleado david.martinez@sabnez.com en la base local. Actívalo primero desde la app de empleados.",
    );
  }

  await UPSERT.into("sabnez.times.Clients").entries({
    ID: IDS.client,
    legalName: "Sabnez Consulting SAS",
    tradeName: "Sabnez Consulting",
    taxIdentification: "DEMO-INTERNO",
    countryCode: "CO",
    defaultCurrency: "COP",
    timeZone: "America/Bogota",
    taxExempt: false,
    status: "ACTIVE",
  });
  await UPSERT.into("sabnez.times.Projects").entries({
    ID: IDS.project,
    client_ID: IDS.client,
    code: "INTERNO-DEMO",
    name: "Administración interna - Demo",
    description: "Proyecto local para probar el registro semanal de tiempos.",
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    modality: "INTERNAL",
    currency: "COP",
    timeZone: "America/Bogota",
    requiresDescription: true,
    requiresEvidence: false,
    requiresClientApproval: false,
    approvalScheme: "ADMIN_ONLY",
    dailyWarningHours: 16,
    status: "ACTIVE",
  });
  await UPSERT.into("sabnez.times.ReportingCycles").entries({
    ID: IDS.cycle,
    project_ID: IDS.project,
    name: "Mes calendario",
    cycleType: "MONTHLY",
    startDay: 1,
    submitBusinessDay: 1,
    correctionBusinessDays: 5,
    timeZone: "America/Bogota",
    active: true,
  });
  await UPSERT.into("sabnez.times.ProjectAssignments").entries({
    ID: IDS.assignment,
    project_ID: IDS.project,
    employee_ID: employee.ID,
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    role: "Administrador",
    commercialAllocation: 0,
    isPrimary: true,
    isBackup: false,
    status: "ACTIVE",
  });

  console.log("Datos demo de tiempos creados para david.martinez@sabnez.com");
  console.log(`Asignación: ${IDS.assignment}`);
}

main()
  .then(() => cds.shutdown())
  .catch(async (error) => {
    console.error(error.message);
    await cds.shutdown();
    process.exitCode = 1;
  });
