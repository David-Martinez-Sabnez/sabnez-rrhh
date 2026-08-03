"use strict";

const cds = require("@sap/cds");
const { Readable } = require("node:stream");
const { streamToBuffer } = require("./lib/stream-utils");
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

module.exports = cds.service.impl(function () {
  const ContractDocuments = cds.entities("sabnez.times")["ClientContracts.documents"];
  const { Clientes, Contratos, Proyectos, CiclosReporte, Asignaciones, Aprobadores, Tarifas } = this.entities;

  this.on("obtenerDocumentosContrato", async () => {
    const rows = await SELECT.from(ContractDocuments).columns("ID", "up__ID", "filename", "mimeType", "status");
    return rows.map((row) => ({ ID: row.ID, contratoID: row.up__ID, filename: row.filename, mimeType: row.mimeType, status: row.status }));
  });

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

  this.before("DELETE", Clientes, async (req) => {
    const ID = req.data.ID;
    const [projects, contracts] = await Promise.all([
      SELECT.one.from(Proyectos).columns("ID").where({ client_ID: ID }),
      SELECT.one.from(Contratos).columns("ID").where({ client_ID: ID }),
    ]);
    if (projects || contracts) reject(req, 409, "CLIENTE_EN_USO", "No se puede eliminar el cliente porque tiene proyectos o contratos asociados.");
  });

  this.before("DELETE", Contratos, async (req) => {
    if (await SELECT.one.from(Proyectos).columns("ID").where({ contract_ID: req.data.ID })) {
      reject(req, 409, "CONTRATO_EN_USO", "No se puede eliminar el contrato porque está asociado a un proyecto.");
    }
  });

  this.before("DELETE", Proyectos, async (req) => {
    if (await SELECT.one.from(Asignaciones).columns("ID").where({ project_ID: req.data.ID })) {
      reject(req, 409, "PROYECTO_EN_USO", "No se puede eliminar el proyecto porque tiene empleados asignados.");
    }
  });

  this.before("DELETE", Asignaciones, async (req) => {
    if (await SELECT.one.from("sabnez.times.TimeEntries").columns("ID").where({ assignment_ID: req.data.ID })) {
      reject(req, 409, "ASIGNACION_EN_USO", "No se puede eliminar la asignación porque ya tiene registros de tiempo.");
    }
  });

  this.on("cargarDocumentoContrato", async (req) => {
    const { contratoID, nombreArchivo, mimeType, contenido } = req.data || {};
    if (!contratoID || !nombreArchivo || !contenido) reject(req, 400, "DOCUMENTO_INCOMPLETO", "Faltan los datos del documento.");
    if (!(await SELECT.one.from(Contratos).columns("ID").where({ ID: contratoID }))) reject(req, 404, "CONTRATO_NO_EXISTE", "El contrato no existe.");
    const buffer = await streamToBuffer(contenido);
    if (!buffer.length) reject(req, 400, "ARCHIVO_VACIO", "El documento está vacío.");
    if (buffer.length > 10 * 1024 * 1024) reject(req, 413, "ARCHIVO_DEMASIADO_GRANDE", "El documento no puede superar 10 MB.");
    const ID = cds.utils.uuid();
    await INSERT.into(ContractDocuments).entries({ ID, up__ID: contratoID, filename: String(nombreArchivo).slice(0,255), mimeType: String(mimeType || "application/octet-stream").slice(0,100), content: buffer, status: "Scanning" });
    let scanResult;
    try {
      const scanner = await cds.connect.to("malwareScanner");
      scanResult = await scanner.send("scan", { file: Readable.from([buffer]) });
    } catch (error) {
      await DELETE.from(ContractDocuments).where({ ID, up__ID: contratoID });
      reject(req, 502, "ESCANEO_DOCUMENTO_FALLIDO", "No fue posible validar el documento con el servicio de seguridad.");
    }
    if (scanResult?.isMalware) {
      await DELETE.from(ContractDocuments).where({ ID, up__ID: contratoID });
      reject(req, 422, "ARCHIVO_INFECTADO", "El documento fue rechazado por la validación de seguridad.");
    }
    await UPDATE(ContractDocuments).set({ status: "Clean", lastScan: new Date().toISOString(), hash: scanResult?.hash || null }).where({ ID, up__ID: contratoID });
    return { exito: true, mensaje: "Documento contractual cargado correctamente.", documentoID: ID };
  });

  this.on("descargarDocumentoContrato", async (req) => {
    const { contratoID, documentoID } = req.data || {};
    const row = await SELECT.one.from(ContractDocuments).columns("filename", "mimeType", "content", "status").where({ ID: documentoID, up__ID: contratoID });
    if (!row) reject(req, 404, "DOCUMENTO_NO_ENCONTRADO", "El documento no existe.");
    if (row.status !== "Clean") reject(req, 409, "DOCUMENTO_NO_VALIDADO", "El documento aún no está validado para descarga.");
    const buffer = await streamToBuffer(row.content);
    if (!buffer?.length) reject(req, 404, "CONTENIDO_NO_DISPONIBLE", "El documento no tiene contenido almacenado.");
    return { filename: row.filename, mimeType: row.mimeType || "application/octet-stream", contenidoBase64: buffer.toString("base64") };
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
