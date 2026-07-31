"use strict";

const cds = require("@sap/cds");
const { SELECT } = cds.ql;

module.exports = cds.service.impl(function () {
  const { Clientes, Contratos, Proyectos, CiclosReporte, Asignaciones, Aprobadores, Tarifas } = this.entities;

  this.before(["CREATE", "UPDATE"], Clientes, (req) => {
    normalizeCode(req.data, "countryCode", 2);
    normalizeCode(req.data, "defaultCurrency", 3);
    requireText(req, "legalName", "La razón social es obligatoria.");
    requireText(req, "taxIdentification", "La identificación tributaria es obligatoria.");
  });

  this.before(["CREATE", "UPDATE"], Contratos, async (req) => {
    normalizeCode(req.data, "currency", 3);
    validateDateRange(req, "validFrom", "validTo");
    if (req.event === "CREATE") await requireExisting(req, Clientes, req.data.client_ID, "CLIENTE_NO_EXISTE", "El cliente seleccionado no existe.");
  });

  this.before(["CREATE", "UPDATE"], Proyectos, async (req) => {
    normalizeCode(req.data, "code", 40);
    normalizeCode(req.data, "currency", 3);
    validateDateRange(req, "validFrom", "validTo");
    validatePositive(req, "dailyWarningHours", true);
    if (req.event === "CREATE") {
      await requireExisting(req, Clientes, req.data.client_ID, "CLIENTE_NO_EXISTE", "El cliente seleccionado no existe.");
    }
    if (req.data.contract_ID && req.data.client_ID) {
      const contract = await SELECT.one.from(Contratos).columns("ID", "client_ID").where({ ID: req.data.contract_ID });
      if (!contract || contract.client_ID !== req.data.client_ID) {
        reject(req, 400, "CONTRATO_DE_OTRO_CLIENTE", "El contrato debe pertenecer al mismo cliente del proyecto.", "contract_ID");
      }
    }
  });

  this.before(["CREATE", "UPDATE"], CiclosReporte, (req) => {
    for (const field of ["startDay", "endDay"]) validateDayOfMonth(req, field);
    validatePositive(req, "submitBusinessDay", false);
    validatePositive(req, "correctionBusinessDays", false);
    if (req.data.cycleType === "MONTHLY" && req.data.startDay == null) req.data.startDay = 1;
  });

  this.before(["CREATE", "UPDATE"], Asignaciones, async (req) => {
    validateDateRange(req, "validFrom", "validTo");
    validatePositive(req, "commercialAllocation", false);
    if (req.event !== "CREATE") return;
    const [project, employee] = await Promise.all([
      SELECT.one.from(Proyectos).columns("ID", "validFrom", "validTo", "status").where({ ID: req.data.project_ID }),
      SELECT.one.from("sabnez.rrhh.Empleados").columns("ID", "fechaIngreso", "fechaRetiro").where({ ID: req.data.employee_ID }),
    ]);
    if (!project) reject(req, 400, "PROYECTO_NO_EXISTE", "El proyecto seleccionado no existe.", "project_ID");
    if (!employee) reject(req, 400, "EMPLEADO_NO_EXISTE", "El empleado seleccionado no existe.", "employee_ID");
    if (!within(req.data.validFrom, project.validFrom, project.validTo) || (req.data.validTo && !within(req.data.validTo, project.validFrom, project.validTo))) {
      reject(req, 400, "ASIGNACION_FUERA_DE_PROYECTO", "La asignación debe estar dentro de la vigencia del proyecto.");
    }
  });

  this.before(["CREATE", "UPDATE"], Aprobadores, (req) => {
    validateDateRange(req, "validFrom", "validTo");
    if (req.data.approverType) req.data.approverType = String(req.data.approverType).trim().toUpperCase();
  });

  this.before(["CREATE", "UPDATE"], Tarifas, (req) => {
    validateDateRange(req, "validFrom", "validTo");
    normalizeCode(req.data, "currency", 3);
    for (const field of ["monthlySaleRate", "regularSaleHourlyRate", "overtimeSaleHourlyRate", "internalMonthlyCost", "internalHourlyCost"]) {
      validatePositive(req, field, false);
    }
  });
});

async function requireExisting(req, entity, ID, code, message) {
  if (!ID || !(await SELECT.one.from(entity).columns("ID").where({ ID }))) reject(req, 400, code, message);
}

function requireText(req, field, message) {
  if (field in req.data && !(req.data[field] || "").trim()) reject(req, 400, "CAMPO_OBLIGATORIO", message, field);
}

function normalizeCode(data, field, maxLength) {
  if (!(field in data) || data[field] == null) return;
  data[field] = String(data[field]).trim().toUpperCase().slice(0, maxLength);
}

function validateDateRange(req, fromField, toField) {
  const from = req.data[fromField];
  const to = req.data[toField];
  if (from && to && from > to) reject(req, 400, "RANGO_FECHAS_INVALIDO", "La fecha final no puede ser anterior a la fecha inicial.", toField);
}

function validateDayOfMonth(req, field) {
  if (!(field in req.data) || req.data[field] == null) return;
  const value = Number(req.data[field]);
  if (!Number.isInteger(value) || value < 1 || value > 31) reject(req, 400, "DIA_MES_INVALIDO", "El día del mes debe estar entre 1 y 31.", field);
}

function validatePositive(req, field, strictlyPositive) {
  if (!(field in req.data) || req.data[field] == null) return;
  const value = Number(req.data[field]);
  if (!Number.isFinite(value) || (strictlyPositive ? value <= 0 : value < 0)) reject(req, 400, "VALOR_INVALIDO", `El campo ${field} contiene un valor inválido.`, field);
}

function within(value, from, to) {
  return (!from || value >= from) && (!to || value <= to);
}

function reject(req, status, code, message, target) {
  return req.reject({ status, code, message, target });
}
