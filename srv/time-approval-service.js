"use strict";

const cds = require("@sap/cds");
const { SELECT, UPDATE, INSERT } = cds.ql;
const { queueTimeNotification } = require("./lib/time-notification-outbox");
const { streamToBuffer } = require("./lib/stream-utils");

module.exports = cds.service.impl(function () {
  const times = cds.entities("sabnez.times");
  const { WeeklyTimesheets, TimeEntries, TimeEntryDecisions } = times;
  const Evidence = times["TimeEntries.evidence"];

  this.on("obtenerBandeja", async (req) => {
    const context = await reviewerContext(req);
    const statuses = requestedStatuses(req.data?.estado);
    const sheets = await SELECT.from(WeeklyTimesheets).columns(
      "ID",
      "employee_ID",
      "employee.nombreCompleto as employeeName",
      "employee.correoCorporativo as employeeEmail",
      "weekStart",
      "weekEnd",
      "status",
      "submittedAt",
      "version",
    ).where({ status: { in: statuses } });
    const pendingFilter = !req.data?.estado || req.data.estado === "PENDING";
    const groups = groupSheets(sheets).filter((group) => {
      const visible = context.isAdmin || context.directReportIDs.has(group.employee_ID);
      return visible && (!pendingFilter || isPendingForContext(group, context));
    });
    return Promise.all(groups.map((group) => summarizeGroup(group, { TimeEntries, Evidence, context })));
  });

  this.on("obtenerDetalle", async (req) => {
    const { group, context } = await loadSheetGroup(req, req.data?.hojaID, { WeeklyTimesheets });
    const resumen = await summarizeGroup(group, { TimeEntries, Evidence, context });
    const entries = await SELECT.from(TimeEntries).columns(
      "ID",
      "workDate",
      "durationHours",
      "requestedType",
      "description",
      "evidenceRequired",
      "dailyHoursWarning",
      "assignment.project.name as projectName",
      "assignment.project.client.tradeName as clientTradeName",
      "assignment.project.client.legalName as clientLegalName",
    ).where({ timesheet_ID: { in: group.sheetIDs } }).orderBy("workDate asc");
    const registros = await Promise.all(entries.map(async (entry) => {
      const files = Evidence
        ? await SELECT.from(Evidence).columns("ID", "filename", "status").where({ up__ID: entry.ID })
        : [];
      const clean = files.filter((file) => file.status === "Clean");
      return {
        ID: entry.ID,
        fecha: entry.workDate,
        horas: entry.durationHours,
        tipo: entry.requestedType,
        descripcion: entry.description,
        proyectoNombre: entry.projectName,
        clienteNombre: entry.clientTradeName || entry.clientLegalName,
        requiereSoporte: Boolean(entry.evidenceRequired),
        cantidadSoportes: clean.length,
        alerta: Boolean(entry.dailyHoursWarning),
        soporteID: clean[0]?.ID || null,
        soporteNombre: clean[0]?.filename || null,
      };
    }));
    return { resumen, registros };
  });

  this.on("aprobarHoja", async (req) => {
    const { group, context } = await loadSheetGroup(req, req.data?.hojaID, { WeeklyTimesheets });
    if (!isPendingForContext(group, context)) {
      reject(req, 409, "SEMANA_NO_APROBABLE", "La semana no corresponde a tu etapa de aprobación.");
    }
    const administrativeStep = group.status === "LEADER_APPROVED";
    const nextStatus = administrativeStep ? "INTERNALLY_APPROVED" : "LEADER_APPROVED";
    const now = new Date().toISOString();
    const timestamp = administrativeStep ? { internallyApprovedAt: now } : { leaderApprovedAt: now };
    const operations = group.sheets.map((sheet) => UPDATE(WeeklyTimesheets)
      .set({ status: nextStatus, ...timestamp, version: Number(sheet.version || 1) + 1 })
      .where({ ID: sheet.ID, status: sheet.status }));
    operations.push(UPDATE(TimeEntries).set({ status: nextStatus }).where({ timesheet_ID: { in: group.sheetIDs } }));
    await cds.tx(req).run(operations);
    await recordDecision(group.sheetIDs, "APPROVAL", nextStatus, req, req.data?.comentario, { TimeEntries, TimeEntryDecisions });
    const summary = await summarizeGroup({ ...group, status: nextStatus }, { TimeEntries, Evidence, context });
    if (administrativeStep) {
      await notifyEmployee(
        cds.tx(req),
        summary,
        nextStatus,
        req.data?.comentario,
        now,
      );
    } else {
      await notifyAdministrators(cds.tx(req), summary, now);
    }
    return {
      exito: true,
      mensaje: administrativeStep ? "La semana quedó aprobada internamente." : "La semana completa quedó aprobada por el jefe inmediato.",
      estado: nextStatus,
    };
  });

  this.on("devolverHoja", async (req) => {
    const comment = String(req.data?.comentario || "").trim();
    if (comment.length < 5) {
      reject(req, 400, "COMENTARIO_REQUERIDO", "Explica al empleado qué debe corregir antes de devolver la semana.", "comentario");
    }
    const { group, context } = await loadSheetGroup(req, req.data?.hojaID, { WeeklyTimesheets });
    if (!isPendingForContext(group, context)) {
      reject(req, 409, "SEMANA_NO_DEVOLVIBLE", "La semana ya no puede devolverse en esta etapa.");
    }
    const now = new Date().toISOString();
    const operations = group.sheets.map((sheet) => UPDATE(WeeklyTimesheets)
      .set({ status: "RETURNED", returnedAt: now, returnComment: comment, version: Number(sheet.version || 1) + 1 })
      .where({ ID: sheet.ID, status: sheet.status }));
    operations.push(UPDATE(TimeEntries).set({ status: "RETURNED" }).where({ timesheet_ID: { in: group.sheetIDs } }));
    await cds.tx(req).run(operations);
    await recordDecision(group.sheetIDs, "REVIEW", "RETURNED", req, comment, { TimeEntries, TimeEntryDecisions });
    const summary = await summarizeGroup({ ...group, status: "RETURNED" }, { TimeEntries, Evidence, context });
    await notifyEmployee(cds.tx(req), summary, "RETURNED", comment, now);
    return { exito: true, mensaje: "La semana completa fue devuelta al empleado para corrección.", estado: "RETURNED" };
  });

  this.on("descargarSoporte", async (req) => {
    const entry = await SELECT.one.from(TimeEntries).columns("ID", "timesheet_ID").where({ ID: req.data?.registroID });
    if (!entry) reject(req, 404, "REGISTRO_NO_ENCONTRADO", "El registro de tiempo no existe.");
    await loadSheetGroup(req, entry.timesheet_ID, { WeeklyTimesheets });
    const file = Evidence && await SELECT.one.from(Evidence)
      .columns("filename", "mimeType", "content", "status")
      .where({ ID: req.data?.soporteID, up__ID: entry.ID });
    if (!file) reject(req, 404, "SOPORTE_NO_ENCONTRADO", "El soporte no existe.");
    if (file.status !== "Clean") reject(req, 409, "SOPORTE_NO_VALIDADO", "El soporte todavía no está habilitado para descarga.");
    const buffer = await streamToBuffer(file.content);
    if (!buffer?.length) reject(req, 404, "CONTENIDO_NO_DISPONIBLE", "El soporte no tiene contenido almacenado.");
    return { nombre: file.filename, mimeType: file.mimeType || "application/octet-stream", contenidoBase64: buffer.toString("base64") };
  });

  this.on("generarReporteCSV", async (req) => {
    const { group } = await loadSheetGroup(req, req.data?.hojaID, { WeeklyTimesheets });
    const entries = await SELECT.from(TimeEntries).columns(
      "workDate",
      "durationHours",
      "requestedType",
      "description",
      "assignment.project.name as projectName",
      "assignment.project.client.tradeName as clientTradeName",
      "assignment.project.client.legalName as clientLegalName",
    ).where({ timesheet_ID: { in: group.sheetIDs } }).orderBy("workDate asc");
    const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const projects = [...new Set(entries.map((entry) => entry.projectName).filter(Boolean))];
    const clients = [...new Set(entries.map((entry) => entry.clientTradeName || entry.clientLegalName).filter(Boolean))];
    const lines = [
      ["Empleado", group.employeeName],
      ["Clientes", clients.join(", ")],
      ["Proyectos", projects.join(", ")],
      ["Semana", `${group.weekStart} a ${group.weekEnd}`],
      [],
      ["Fecha", "Cliente", "Proyecto", "Horas", "Tipo", "Descripción"],
    ];
    entries.forEach((entry) => lines.push([
      entry.workDate,
      entry.clientTradeName || entry.clientLegalName,
      entry.projectName,
      entry.durationHours,
      entry.requestedType,
      entry.description || "",
    ]));
    const csv = `\uFEFF${lines.map((line) => line.map(escape).join(";")).join("\r\n")}`;
    return {
      nombre: `tiempos-${group.weekStart}-${safeFilename(group.employeeName)}.csv`,
      mimeType: "text/csv;charset=utf-8",
      contenidoBase64: Buffer.from(csv).toString("base64"),
    };
  });
});

async function summarizeGroup(group, { TimeEntries, Evidence, context }) {
  const entries = await SELECT.from(TimeEntries).columns(
    "ID",
    "durationHours",
    "dailyHoursWarning",
    "evidenceRequired",
    "assignment.project.name as projectName",
    "assignment.project.client.tradeName as clientTradeName",
    "assignment.project.client.legalName as clientLegalName",
  ).where({ timesheet_ID: { in: group.sheetIDs } });
  let pendingEvidence = 0;
  for (const entry of entries) {
    if (!entry.evidenceRequired) continue;
    const file = Evidence && await SELECT.one.from(Evidence).columns("ID").where({ up__ID: entry.ID, status: "Clean" });
    if (!file) pendingEvidence += 1;
  }
  const projectNames = [...new Set(entries.map((entry) => entry.projectName).filter(Boolean))];
  const clientNames = [...new Set(entries.map((entry) => entry.clientTradeName || entry.clientLegalName).filter(Boolean))];
  const pendingForReviewer = isPendingForContext(group, context);
  return {
    ID: group.ID,
    empleadoNombre: group.employeeName,
    empleadoCorreo: group.employeeEmail,
    clienteNombre: clientNames.join(", "),
    proyectoNombre: projectNames.join(", "),
    semanaInicio: group.weekStart,
    semanaFin: group.weekEnd,
    estado: group.status,
    enviadoEn: group.submittedAt,
    totalHoras: entries.reduce((sum, entry) => sum + Number(entry.durationHours || 0), 0),
    totalRegistros: entries.length,
    registrosConAlerta: entries.filter((entry) => entry.dailyHoursWarning).length,
    soportesPendientes: pendingEvidence,
    siguienteAccion: group.status === "LEADER_APPROVED" ? "Aprobación administrativa" : "Jefe inmediato",
    puedeAprobar: pendingEvidence === 0 && pendingForReviewer,
    puedeDevolver: pendingForReviewer,
  };
}

async function loadSheetGroup(req, ID, { WeeklyTimesheets }) {
  if (!ID) reject(req, 400, "SEMANA_REQUERIDA", "Debes indicar la semana.");
  const seed = await SELECT.one.from(WeeklyTimesheets).columns(
    "ID",
    "employee_ID",
    "employee.nombreCompleto as employeeName",
    "employee.correoCorporativo as employeeEmail",
    "weekStart",
    "weekEnd",
    "status",
    "submittedAt",
    "version",
  ).where({ ID });
  if (!seed) reject(req, 404, "SEMANA_NO_ENCONTRADA", "La semana no existe.");
  const sheets = await SELECT.from(WeeklyTimesheets).columns(
    "ID",
    "employee_ID",
    "employee.nombreCompleto as employeeName",
    "employee.correoCorporativo as employeeEmail",
    "weekStart",
    "weekEnd",
    "status",
    "submittedAt",
    "version",
  ).where({ employee_ID: seed.employee_ID, weekStart: seed.weekStart });
  const group = groupSheets(sheets)[0];
  const context = await reviewerContext(req);
  if (!context.isAdmin && !context.directReportIDs.has(group.employee_ID)) {
    reject(req, 403, "SEMANA_NO_AUTORIZADA", "No tienes autorización para revisar esta semana.");
  }
  return { group, context };
}

function groupSheets(sheets) {
  const groups = new Map();
  for (const sheet of sheets) {
    const key = `${sheet.employee_ID}|${sheet.weekStart}`;
    if (!groups.has(key)) {
      groups.set(key, {
        ID: sheet.ID,
        employee_ID: sheet.employee_ID,
        employeeName: sheet.employeeName,
        employeeEmail: sheet.employeeEmail,
        weekStart: sheet.weekStart,
        weekEnd: sheet.weekEnd,
        status: sheet.status,
        submittedAt: sheet.submittedAt,
        sheets: [],
        sheetIDs: [],
      });
    }
    const group = groups.get(key);
    group.sheets.push(sheet);
    group.sheetIDs.push(sheet.ID);
    if (statusRank(sheet.status) < statusRank(group.status)) group.status = sheet.status;
    if (sheet.submittedAt && (!group.submittedAt || sheet.submittedAt < group.submittedAt)) group.submittedAt = sheet.submittedAt;
  }
  return [...groups.values()];
}

async function reviewerContext(req) {
  const isAdmin = Boolean(req.user?.is?.("TimeAdmin") || req.user?.is?.("Admin"));
  const email = normalizedEmail(req);
  const employees = await SELECT.from("sabnez.rrhh.Empleados")
    .columns("ID", "correoCorporativo")
    .where({ estado_codigo: "AC" });
  const employee = employees.find((row) => String(row.correoCorporativo || "").trim().toLowerCase() === email);
  const directReports = employee
    ? await SELECT.from("sabnez.rrhh.Empleados").columns("ID").where({ jefeDirecto_ID: employee.ID, estado_codigo: "AC" })
    : [];
  return {
    isAdmin,
    employeeID: employee?.ID || null,
    directReportIDs: new Set(directReports.map((row) => row.ID)),
  };
}

async function recordDecision(sheetIDs, type, decision, req, comment, { TimeEntries, TimeEntryDecisions }) {
  const entries = await SELECT.from(TimeEntries).columns("ID", "durationHours").where({ timesheet_ID: { in: sheetIDs } });
  if (!entries.length) return;
  await INSERT.into(TimeEntryDecisions).entries(entries.map((entry) => ({
    ID: cds.utils.uuid(),
    entry_ID: entry.ID,
    decisionType: type,
    decision,
    actorUserID: req.user?.id || "unknown",
    comment: comment || null,
    recognizedHours: decision.includes("APPROVED") ? entry.durationHours : null,
    decidedAt: new Date().toISOString(),
  })));
}

async function notifyEmployee(tx, summary, status, comment, notificationKey) {
  if (!summary.empleadoCorreo) return;
  await queueTimeNotification(tx, {
    type: "TIME_DECIDED",
    recipientID: summary.empleadoCorreo,
    idempotencyKey:
      `time-decision:${summary.ID}:${status}:${notificationKey}`,
    payload: {
      recipientName: summary.empleadoNombre,
      titulo: `${summary.semanaInicio} a ${summary.semanaFin}`,
      estadoInstancia: status === "RETURNED" ? "Devuelta para corrección" : "Aprobada",
      resumen: status === "RETURNED" ? "Tu semana fue devuelta y requiere ajustes." : "Tu semana completa fue aprobada.",
      comentario: comment,
      facts: [
        { etiqueta: "Proyectos", valor: summary.proyectoNombre, orden: 1 },
        { etiqueta: "Total", valor: `${Number(summary.totalHoras || 0).toFixed(1)} horas`, orden: 2 },
        { etiqueta: "Semana", valor: `${summary.semanaInicio} a ${summary.semanaFin}`, orden: 3 },
      ],
    },
  });
}

async function notifyAdministrators(tx, summary, notificationKey) {
  const employeeEmail = String(summary.empleadoCorreo || "").trim().toLowerCase();
  const recipients = String(process.env.TIME_ADMIN_RECIPIENTS || "")
    .split(",")
    .map((email) => email.trim())
    .filter((email) => email && email.toLowerCase() !== employeeEmail);
  for (const email of recipients) {
    await queueTimeNotification(tx, {
      type: "TIME_SUBMITTED",
      recipientID: email,
      idempotencyKey:
        `time-admin:${summary.ID}:${notificationKey}:${email.toLowerCase()}`,
      payload: {
        recipientName: "Administración",
        solicitanteNombre: summary.empleadoNombre,
        hojaID: summary.ID,
        titulo: `${summary.semanaInicio} a ${summary.semanaFin}`,
        resumen: `${Number(summary.totalHoras || 0).toFixed(1)} horas · ${summary.proyectoNombre}`,
        facts: [
          { etiqueta: "Estado", valor: "Aprobada por jefe inmediato", orden: 1 },
          { etiqueta: "Empleado", valor: summary.empleadoNombre, orden: 2 },
          { etiqueta: "Proyectos", valor: summary.proyectoNombre, orden: 3 },
        ],
      },
    });
  }
}

function requestedStatuses(value) {
  const allowed = new Set(["SUBMITTED", "UNDER_REVIEW", "LEADER_APPROVED", "INTERNALLY_APPROVED", "RETURNED", "CLOSED"]);
  if (value && value !== "PENDING") return allowed.has(value) ? [value] : ["SUBMITTED"];
  return ["SUBMITTED", "UNDER_REVIEW", "LEADER_APPROVED"];
}

function isPendingForContext(group, context) {
  if (new Set(["SUBMITTED", "UNDER_REVIEW"]).has(group.status)) {
    return context.employeeID !== group.employee_ID && context.directReportIDs.has(group.employee_ID);
  }
  return group.status === "LEADER_APPROVED" && context.isAdmin && context.employeeID !== group.employee_ID;
}

function statusRank(status) {
  return { RETURNED: 0, SUBMITTED: 1, UNDER_REVIEW: 2, LEADER_APPROVED: 3, INTERNALLY_APPROVED: 4, CLOSED: 5 }[status] ?? 99;
}

function normalizedEmail(req) {
  return [req.user?.attr?.email, req.user?.attr?.mail, req.user?.id].find(Boolean)?.trim().toLowerCase() || "";
}

function safeFilename(value) {
  return String(value || "empleado").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function reject(req, status, code, message, target) {
  return req.reject({ status, code, message, target });
}
