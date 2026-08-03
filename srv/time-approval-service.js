"use strict";

const cds = require("@sap/cds");
const { SELECT, UPDATE, INSERT } = cds.ql;
const { sendApprovalEmail } = require("./lib/approval-mailer");
const { streamToBuffer } = require("./lib/stream-utils");
const LOG = cds.log("time-approval-service");

module.exports = cds.service.impl(function () {
  const times = cds.entities("sabnez.times");
  const { WeeklyTimesheets, TimeEntries, TimeEntryDecisions, ProjectApprovers } = times;
  const Evidence = times["TimeEntries.evidence"];

  this.on("obtenerBandeja", async (req) => {
    const context = await reviewerContext(req, ProjectApprovers);
    const statuses = requestedStatuses(req.data?.estado, context.isAdmin);
    const sheets = await SELECT.from(WeeklyTimesheets).columns(
      "ID", "employee_ID", "employee.nombreCompleto as employeeName", "employee.correoCorporativo as employeeEmail",
      "assignment_ID", "assignment.project_ID as projectID", "assignment.project.name as projectName",
      "assignment.project.client.tradeName as clientTradeName", "assignment.project.client.legalName as clientLegalName",
      "assignment.project.approvalScheme as approvalScheme", "weekStart", "weekEnd", "status", "submittedAt",
    ).where({ status: { in: statuses } });
    const pendingFilter = !req.data?.estado || req.data.estado === "PENDING";
    const visible = sheets.filter((sheet) => (context.isAdmin || context.directReportIDs.has(sheet.employee_ID) || context.projectIDs.has(sheet.projectID)) && (!pendingFilter || isPendingForContext(sheet, context)));
    return Promise.all(visible.map((sheet) => summarizeSheet(sheet, { TimeEntries, Evidence, context })));
  });

  this.on("obtenerDetalle", async (req) => {
    const sheet = await loadSheet(req, req.data?.hojaID, { WeeklyTimesheets, ProjectApprovers });
    const context = await reviewerContext(req, ProjectApprovers);
    const resumen = await summarizeSheet(sheet, { TimeEntries, Evidence, context });
    const entries = await SELECT.from(TimeEntries).columns(
      "ID", "workDate", "durationHours", "requestedType", "description", "evidenceRequired", "dailyHoursWarning",
    ).where({ timesheet_ID: sheet.ID }).orderBy("workDate asc");
    const registros = await Promise.all(entries.map(async (entry) => {
      const files = Evidence ? await SELECT.from(Evidence).columns("ID", "filename", "status").where({ up__ID: entry.ID }) : [];
      const clean = files.filter((file) => file.status === "Clean");
      return {
        ID: entry.ID, fecha: entry.workDate, horas: entry.durationHours, tipo: entry.requestedType,
        descripcion: entry.description, requiereSoporte: Boolean(entry.evidenceRequired), cantidadSoportes: clean.length,
        alerta: Boolean(entry.dailyHoursWarning), soporteID: clean[0]?.ID || null, soporteNombre: clean[0]?.filename || null,
      };
    }));
    return { resumen, registros };
  });

  this.on("aprobarHoja", async (req) => {
    const sheet = await loadSheet(req, req.data?.hojaID, { WeeklyTimesheets, ProjectApprovers });
    const context = await reviewerContext(req, ProjectApprovers);
    if (!isPendingForContext(sheet, context)) reject(req, 409, "HOJA_NO_APROBABLE", "La hoja no corresponde a tu etapa de aprobación.");
    const nextStatus = context.isAdmin ? "INTERNALLY_APPROVED" : "LEADER_APPROVED";
    const now = new Date().toISOString();
    const timestamp = context.isAdmin ? { internallyApprovedAt: now } : { leaderApprovedAt: now };
    await cds.tx(req).run([
      UPDATE(WeeklyTimesheets).set({ status: nextStatus, ...timestamp, version: Number(sheet.version || 1) + 1 }).where({ ID: sheet.ID, status: sheet.status }),
      UPDATE(TimeEntries).set({ status: nextStatus }).where({ timesheet_ID: sheet.ID }),
    ]);
    await recordDecision(sheet.ID, "APPROVAL", nextStatus, req, req.data?.comentario, { TimeEntries, TimeEntryDecisions });
    if (nextStatus === "LEADER_APPROVED" && sheet.approvalScheme === "LEADER_THEN_ADMIN") await notifyAdministrators(sheet);
    else await notifyEmployee(sheet, nextStatus, req.data?.comentario);
    return { exito: true, mensaje: context.isAdmin ? "La hoja quedó aprobada internamente." : "La hoja quedó aprobada por el líder.", estado: nextStatus };
  });

  this.on("devolverHoja", async (req) => {
    const comment = String(req.data?.comentario || "").trim();
    if (comment.length < 5) reject(req, 400, "COMENTARIO_REQUERIDO", "Explica al empleado qué debe corregir antes de devolver la hoja.", "comentario");
    const sheet = await loadSheet(req, req.data?.hojaID, { WeeklyTimesheets, ProjectApprovers });
    if (!new Set(["SUBMITTED", "UNDER_REVIEW", "LEADER_APPROVED"]).has(sheet.status)) reject(req, 409, "HOJA_NO_DEVOLVIBLE", "La hoja ya no puede devolverse.");
    const now = new Date().toISOString();
    await cds.tx(req).run([
      UPDATE(WeeklyTimesheets).set({ status: "RETURNED", returnedAt: now, returnComment: comment, version: Number(sheet.version || 1) + 1 }).where({ ID: sheet.ID, status: sheet.status }),
      UPDATE(TimeEntries).set({ status: "RETURNED" }).where({ timesheet_ID: sheet.ID }),
    ]);
    await recordDecision(sheet.ID, "REVIEW", "RETURNED", req, comment, { TimeEntries, TimeEntryDecisions });
    await notifyEmployee(sheet, "RETURNED", comment);
    return { exito: true, mensaje: "La hoja fue devuelta al empleado para corrección.", estado: "RETURNED" };
  });

  this.on("descargarSoporte", async (req) => {
    const entry = await SELECT.one.from(TimeEntries).columns("ID", "timesheet_ID").where({ ID: req.data?.registroID });
    if (!entry) reject(req, 404, "REGISTRO_NO_ENCONTRADO", "El registro de tiempo no existe.");
    await loadSheet(req, entry.timesheet_ID, { WeeklyTimesheets, ProjectApprovers });
    const file = Evidence && await SELECT.one.from(Evidence).columns("filename", "mimeType", "content", "status").where({ ID: req.data?.soporteID, up__ID: entry.ID });
    if (!file) reject(req, 404, "SOPORTE_NO_ENCONTRADO", "El soporte no existe.");
    if (file.status !== "Clean") reject(req, 409, "SOPORTE_NO_VALIDADO", "El soporte todavía no está habilitado para descarga.");
    const buffer = await streamToBuffer(file.content);
    if (!buffer?.length) reject(req, 404, "CONTENIDO_NO_DISPONIBLE", "El soporte no tiene contenido almacenado.");
    return { nombre: file.filename, mimeType: file.mimeType || "application/octet-stream", contenidoBase64: buffer.toString("base64") };
  });

  this.on("generarReporteCSV", async (req) => {
    const sheet = await loadSheet(req, req.data?.hojaID, { WeeklyTimesheets, ProjectApprovers });
    const entries = await SELECT.from(TimeEntries).columns("workDate", "durationHours", "requestedType", "description").where({ timesheet_ID: sheet.ID }).orderBy("workDate asc");
    const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const lines = [["Empleado", sheet.employeeName], ["Cliente", sheet.clientTradeName || sheet.clientLegalName], ["Proyecto", sheet.projectName], ["Semana", `${sheet.weekStart} a ${sheet.weekEnd}`], [], ["Fecha", "Horas", "Tipo", "Descripción"]];
    entries.forEach((entry) => lines.push([entry.workDate, entry.durationHours, entry.requestedType, entry.description || ""]));
    const csv = `\uFEFF${lines.map((line) => line.map(escape).join(";")).join("\r\n")}`;
    return { nombre: `tiempos-${sheet.weekStart}-${safeFilename(sheet.projectName)}.csv`, mimeType: "text/csv;charset=utf-8", contenidoBase64: Buffer.from(csv).toString("base64") };
  });
});

async function summarizeSheet(sheet, { TimeEntries, Evidence, context }) {
  const entries = await SELECT.from(TimeEntries).columns("ID", "durationHours", "dailyHoursWarning", "evidenceRequired").where({ timesheet_ID: sheet.ID });
  let pendingEvidence = 0;
  for (const entry of entries) {
    if (!entry.evidenceRequired) continue;
    const file = Evidence && await SELECT.one.from(Evidence).columns("ID").where({ up__ID: entry.ID, status: "Clean" });
    if (!file) pendingEvidence += 1;
  }
  const adminStep = sheet.status === "LEADER_APPROVED" || sheet.approvalScheme === "ADMIN_ONLY";
  const pendingForReviewer = isPendingForContext(sheet, context);
  return {
    ID: sheet.ID, empleadoNombre: sheet.employeeName, empleadoCorreo: sheet.employeeEmail,
    clienteNombre: sheet.clientTradeName || sheet.clientLegalName, proyectoNombre: sheet.projectName,
    semanaInicio: sheet.weekStart, semanaFin: sheet.weekEnd, estado: sheet.status, enviadoEn: sheet.submittedAt,
    totalHoras: entries.reduce((sum, entry) => sum + Number(entry.durationHours || 0), 0), totalRegistros: entries.length,
    registrosConAlerta: entries.filter((entry) => entry.dailyHoursWarning).length, soportesPendientes: pendingEvidence,
    siguienteAccion: adminStep ? "Aprobación administrativa" : "Revisión del líder",
    puedeAprobar: pendingEvidence === 0 && pendingForReviewer,
    puedeDevolver: pendingForReviewer,
  };
}

async function loadSheet(req, ID, { WeeklyTimesheets, ProjectApprovers }) {
  if (!ID) reject(req, 400, "HOJA_REQUERIDA", "Debes indicar la hoja semanal.");
  const sheet = await SELECT.one.from(WeeklyTimesheets).columns(
    "ID", "employee_ID", "employee.nombreCompleto as employeeName", "employee.correoCorporativo as employeeEmail",
    "assignment_ID", "assignment.project_ID as projectID", "assignment.project.name as projectName",
    "assignment.project.client.tradeName as clientTradeName", "assignment.project.client.legalName as clientLegalName",
    "assignment.project.approvalScheme as approvalScheme", "weekStart", "weekEnd", "status", "submittedAt", "version",
  ).where({ ID });
  if (!sheet) reject(req, 404, "HOJA_NO_ENCONTRADA", "La hoja semanal no existe.");
  const context = await reviewerContext(req, ProjectApprovers);
  if (!context.isAdmin && !context.directReportIDs.has(sheet.employee_ID) && !context.projectIDs.has(sheet.projectID)) reject(req, 403, "HOJA_NO_AUTORIZADA", "No tienes autorización para revisar esta hoja.");
  return sheet;
}

async function reviewerContext(req, ProjectApprovers) {
  const isAdmin = req.user?.is?.("TimeAdmin") || req.user?.is?.("Admin");
  if (isAdmin) return { isAdmin: true, employeeID: null, directReportIDs: new Set(), projectIDs: new Set() };
  const email = normalizedEmail(req);
  const employees = await SELECT.from("sabnez.rrhh.Empleados").columns("ID", "correoCorporativo").where({ estado_codigo: "AC" });
  const employee = employees.find((row) => String(row.correoCorporativo || "").trim().toLowerCase() === email);
  if (!employee) return { isAdmin: false, employeeID: null, directReportIDs: new Set(), projectIDs: new Set() };
  const today = new Date().toISOString().slice(0, 10);
  const [rows, directReports] = await Promise.all([
    SELECT.from(ProjectApprovers).columns("project_ID", "validTo").where({ employee_ID: employee.ID, active: true, validFrom: { "<=": today } }),
    SELECT.from("sabnez.rrhh.Empleados").columns("ID").where({ jefeDirecto_ID: employee.ID, estado_codigo: "AC" }),
  ]);
  return {
    isAdmin: false,
    employeeID: employee.ID,
    directReportIDs: new Set(directReports.map((row) => row.ID)),
    projectIDs: new Set(rows.filter((row) => !row.validTo || row.validTo >= today).map((row) => row.project_ID)),
  };
}

async function recordDecision(sheetID, type, decision, req, comment, { TimeEntries, TimeEntryDecisions }) {
  const entries = await SELECT.from(TimeEntries).columns("ID", "durationHours").where({ timesheet_ID: sheetID });
  if (!entries.length) return;
  await INSERT.into(TimeEntryDecisions).entries(entries.map((entry) => ({
    ID: cds.utils.uuid(), entry_ID: entry.ID, decisionType: type, decision,
    actorUserID: req.user?.id || "unknown", comment: comment || null,
    recognizedHours: decision.includes("APPROVED") ? entry.durationHours : null, decidedAt: new Date().toISOString(),
  })));
}

async function notifyEmployee(sheet, status, comment) {
  if (!sheet.employeeEmail) return;
  try {
    await sendApprovalEmail({
      tipo: "TIME_DECIDED", destinatarioID: sheet.employeeEmail, recipientName: sheet.employeeName,
      titulo: `${sheet.weekStart} a ${sheet.weekEnd}`, estadoInstancia: status === "RETURNED" ? "Devuelta para corrección" : "Aprobada",
      resumen: status === "RETURNED" ? "Tu hoja semanal fue devuelta y requiere ajustes." : "Tu hoja semanal fue aprobada.",
      comentario: comment,
      facts: [{ etiqueta: "Proyecto", valor: sheet.projectName, orden: 1 }, { etiqueta: "Semana", valor: `${sheet.weekStart} a ${sheet.weekEnd}`, orden: 2 }],
    });
  } catch (error) {
    LOG.warn("No fue posible notificar la decisión de tiempos", { sheetID: sheet.ID, recipient: sheet.employeeEmail, error: error.message });
  }
}

async function notifyAdministrators(sheet) {
  const recipients = String(process.env.TIME_ADMIN_RECIPIENTS || "").split(",").map((email) => email.trim()).filter(Boolean);
  for (const email of recipients) {
    try {
      await sendApprovalEmail({
        tipo: "TIME_SUBMITTED", destinatarioID: email, recipientName: "Administración", solicitanteNombre: sheet.employeeName,
        hojaID: sheet.ID, titulo: `${sheet.weekStart} a ${sheet.weekEnd}`, resumen: `${sheet.clientTradeName || sheet.clientLegalName} · ${sheet.projectName}`,
        facts: [{ etiqueta: "Estado", valor: "Aprobada por líder", orden: 1 }, { etiqueta: "Empleado", valor: sheet.employeeName, orden: 2 }, { etiqueta: "Proyecto", valor: sheet.projectName, orden: 3 }],
      });
    } catch (error) {
      LOG.warn("No fue posible notificar la aprobación administrativa pendiente", { sheetID: sheet.ID, recipient: email, error: error.message });
    }
  }
}

function requestedStatuses(value, isAdmin) {
  const allowed = new Set(["SUBMITTED", "UNDER_REVIEW", "LEADER_APPROVED", "INTERNALLY_APPROVED", "RETURNED", "CLOSED"]);
  if (value && value !== "PENDING") return allowed.has(value) ? [value] : ["SUBMITTED"];
  return isAdmin ? ["SUBMITTED", "UNDER_REVIEW", "LEADER_APPROVED"] : ["SUBMITTED", "UNDER_REVIEW"];
}

function isPendingForContext(sheet, context) {
  if (context.isAdmin) {
    if (sheet.status === "LEADER_APPROVED") return sheet.approvalScheme === "LEADER_THEN_ADMIN";
    return new Set(["SUBMITTED", "UNDER_REVIEW"]).has(sheet.status) && new Set(["ADMIN_ONLY", "LEADER_OR_ADMIN"]).has(sheet.approvalScheme);
  }
  return (context.directReportIDs.has(sheet.employee_ID) || context.projectIDs.has(sheet.projectID)) && new Set(["SUBMITTED", "UNDER_REVIEW"]).has(sheet.status) && sheet.approvalScheme !== "ADMIN_ONLY";
}

function normalizedEmail(req) {
  return [req.user?.attr?.email, req.user?.attr?.mail, req.user?.id].find(Boolean)?.trim().toLowerCase() || "";
}

function safeFilename(value) { return String(value || "proyecto").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase(); }
function reject(req, status, code, message, target) { return req.reject({ status, code, message, target }); }
