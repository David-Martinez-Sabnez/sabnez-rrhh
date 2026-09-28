"use strict";

const cds = require("@sap/cds");
const { SELECT, UPDATE, INSERT } = cds.ql;
const { queueTimeNotification } = require("./lib/time-notification-outbox");
const { streamToBuffer } = require("./lib/stream-utils");

module.exports = cds.service.impl(function () {
  const times = cds.entities("sabnez.times");
  const {
    WeeklyTimesheets,
    WeeklyTimeApprovalEvents,
    TimeEntries,
    TimeEntryDecisions,
    ProjectApprovers,
  } = times;
  const Evidence = times["TimeEntries.evidence"];

  this.on("obtenerPermisosReasignacion", (req) => ({
    puedeReasignar: Boolean(req.user?.is?.("TimeApprovalReassign")),
  }));

  this.on("obtenerIncidenciasReasignacion", async (req) => {
    requireReassignmentPermission(req);
    return loadReassignmentIssues({
      WeeklyTimesheets,
      TimeEntries,
      ProjectApprovers,
    });
  });

  this.on("reprocesarAprobacion", async (req) => {
    requireReassignmentPermission(req);
    const hojaID = req.data?.hojaID;
    if (!hojaID) {
      return req.reject(400, "Debes indicar la hoja de tiempos a reprocesar.");
    }

    const { group } = await loadReassignmentGroup(req, hojaID, { WeeklyTimesheets });
    const resolution = await resolveExpectedApprover(group, {
      TimeEntries,
      ProjectApprovers,
    });

    if (!resolution.approver) {
      return req.reject(
        409,
        resolution.reason ||
          "La aprobación todavía no tiene una ruta válida configurada.",
      );
    }

    const now = new Date().toISOString();
    await cds.tx(req).run(
      group.sheets.map((sheet) =>
        UPDATE(WeeklyTimesheets)
          .set({
            currentApprover_ID: resolution.approver.ID,
            version: Number(sheet.version || 1) + 1,
          })
          .where({ ID: sheet.ID }),
      ),
    );

    const context = await reviewerContext(req);
    await appendTimeApprovalEvent(WeeklyTimeApprovalEvents, {
      group,
      context,
      type: "TIME_APPROVER_REPROCESSED",
      targetEmployeeID: resolution.approver.ID,
      detail: [
        `Aprobador reprocesado automáticamente: ${resolution.approver.nombreCompleto}.`,
        req.data?.comentario ? `Motivo: ${req.data.comentario}` : null,
      ]
        .filter(Boolean)
        .join(" "),
      occurredAt: now,
    });

    await notifyReassignedApprover(
      cds.tx(req),
      group,
      resolution.approver,
      "REPROCESSED",
      now,
      { TimeEntries },
    );

    return {
      exito: true,
      mensaje: `La aprobación fue reasignada a ${resolution.approver.nombreCompleto}.`,
      aprobadorID: resolution.approver.ID,
      aprobadorNombre: resolution.approver.nombreCompleto,
    };
  });

  this.on("reasignarAprobacion", async (req) => {
    requireReassignmentPermission(req);
    const hojaID = req.data?.hojaID;
    const aprobadorID = req.data?.aprobadorID;
    const comentario = String(req.data?.comentario || "").trim();

    if (!hojaID || !aprobadorID) {
      return req.reject(400, "Debes indicar la hoja y el nuevo aprobador.");
    }
    if (!comentario) {
      return req.reject(400, "Debes indicar el motivo de la reasignación manual.");
    }

    const { group } = await loadReassignmentGroup(req, hojaID, { WeeklyTimesheets });
    if (aprobadorID === group.employee_ID) {
      return req.reject(400, "El empleado no puede ser aprobador de su propia hoja.");
    }

    const approver = await SELECT.one
      .from("sabnez.rrhh.Empleados")
      .columns("ID", "nombreCompleto", "correoCorporativo", "estado_codigo")
      .where({ ID: aprobadorID, estado_codigo: "AC" });
    if (!approver || !approver.correoCorporativo) {
      return req.reject(
        409,
        "El aprobador seleccionado no está activo o no tiene correo corporativo.",
      );
    }

    const now = new Date().toISOString();
    await cds.tx(req).run(
      group.sheets.map((sheet) =>
        UPDATE(WeeklyTimesheets)
          .set({
            currentApprover_ID: approver.ID,
            version: Number(sheet.version || 1) + 1,
          })
          .where({ ID: sheet.ID }),
      ),
    );

    const context = await reviewerContext(req);
    await appendTimeApprovalEvent(WeeklyTimeApprovalEvents, {
      group,
      context,
      type: "TIME_APPROVER_REASSIGNED",
      targetEmployeeID: approver.ID,
      detail: `Aprobador reasignado manualmente a ${approver.nombreCompleto}. Motivo: ${comentario}`,
      occurredAt: now,
    });

    await notifyReassignedApprover(
      cds.tx(req),
      group,
      approver,
      "MANUAL",
      now,
      { TimeEntries },
    );

    return {
      exito: true,
      mensaje: `La aprobación fue reasignada a ${approver.nombreCompleto}.`,
      aprobadorID: approver.ID,
      aprobadorNombre: approver.nombreCompleto,
    };
  });

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
      "currentApprover_ID",
    ).where({ status: { in: statuses } });
    const pendingFilter = !req.data?.estado || req.data.estado === "PENDING";
    const groups = [];
    for (const group of groupSheets(sheets)) {
      group.pendingForReviewer = await isAssignedReviewer(group, context, {
        TimeEntries,
        ProjectApprovers,
      });
      const visible =
        group.pendingForReviewer ||
        context.isAdmin;
      if (visible && (!pendingFilter || group.pendingForReviewer)) groups.push(group);
    }
    return Promise.all(groups.map((group) => summarizeGroup(group, { TimeEntries, Evidence, context })));
  });

  this.on("obtenerDetalle", async (req) => {
    const { group, context } = await loadSheetGroup(req, req.data?.hojaID, {
      WeeklyTimesheets,
      TimeEntries,
      ProjectApprovers,
    });
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
        diaNombre: weekdayName(entry.workDate),
        soportes: clean.map((file) => ({ ID: file.ID, nombre: file.filename })),
      };
    }));
    const projectMap = new Map();
    registros.forEach((entry) => {
      const key = `${entry.clienteNombre || ""}|${entry.proyectoNombre || ""}`;
      if (!projectMap.has(key)) {
        projectMap.set(key, {
          proyectoNombre: entry.proyectoNombre,
          clienteNombre: entry.clienteNombre,
          totalHoras: 0,
          totalRegistros: 0,
        });
      }
      const project = projectMap.get(key);
      project.totalHoras += Number(entry.horas || 0);
      project.totalRegistros += 1;
    });
    const eventRows = await SELECT.from(WeeklyTimeApprovalEvents)
      .where({ employee_ID: group.employee_ID, weekStart: group.weekStart })
      .orderBy("occurredAt desc");
    const employeeIDs = new Set();
    eventRows.forEach((event) => {
      if (event.actorEmployee_ID) employeeIDs.add(event.actorEmployee_ID);
      if (event.targetEmployee_ID) employeeIDs.add(event.targetEmployee_ID);
    });
    const names = await employeeNames(employeeIDs);
    const eventos = eventRows.map((event) => ({
      ID: event.ID,
      tipo: event.type,
      actorNombre: names.get(event.actorEmployee_ID) || event.actorUserID,
      destinatarioNombre: names.get(event.targetEmployee_ID) || null,
      detalle: event.detail,
      fecha: event.occurredAt,
    }));
    return {
      resumen,
      registros,
      proyectos: [...projectMap.values()],
      eventos,
    };
  });

  this.on("aprobarHoja", async (req) => {
    const { group, context } = await loadSheetGroup(req, req.data?.hojaID, { WeeklyTimesheets });
    if (!isPendingForContext(group, context)) {
      reject(req, 409, "SEMANA_NO_APROBABLE", "La semana no corresponde a tu etapa de aprobación.");
    }
    const now = new Date().toISOString();
    const sheetProjects = await SELECT.from(TimeEntries)
      .columns("timesheet_ID", "assignment.project.approvalScheme as approvalScheme")
      .where({ timesheet_ID: { in: group.sheetIDs } });
    const schemeBySheet = new Map(sheetProjects.map((row) => [row.timesheet_ID, row.approvalScheme || "LEADER_THEN_ADMIN"]));
    const forwarded = [];
    const completed = [];
    const operations = [];
    for (const sheet of group.sheets) {
      const needsAdmin = group.status !== "LEADER_APPROVED" && schemeBySheet.get(sheet.ID) === "LEADER_THEN_ADMIN";
      let nextApprover = null;
      if (needsAdmin) {
        const routes = await configuredRoutes({ ...group, sheets: [sheet], sheetIDs: [sheet.ID] },
          { TimeEntries, ProjectApprovers }, "ADMIN");
        nextApprover = routes[0]?.approver;
        if (!nextApprover)
          reject(req, 409, "APROBADOR_ADMINISTRATIVO_NO_CONFIGURADO", routes[0]?.reason || "Falta el aprobador administrativo del proyecto.");
      }
      const nextStatus = needsAdmin ? "LEADER_APPROVED" : "INTERNALLY_APPROVED";
      const timestamps = needsAdmin ? { leaderApprovedAt: now } : { internallyApprovedAt: now };
      operations.push(UPDATE(WeeklyTimesheets).set({
        status: nextStatus,
        currentApprover_ID: nextApprover?.ID || null,
        ...timestamps,
        version: Number(sheet.version || 1) + 1,
      }).where({ ID: sheet.ID, status: sheet.status }));
      operations.push(UPDATE(TimeEntries).set({ status: nextStatus }).where({ timesheet_ID: sheet.ID }));
      (needsAdmin ? forwarded : completed).push({ sheet, approver: nextApprover });
    }
    await cds.tx(req).run(operations);
    if (completed.length)
      await recordDecision(completed.map((item) => item.sheet.ID), "APPROVAL", "INTERNALLY_APPROVED", req, req.data?.comentario, { TimeEntries, TimeEntryDecisions });
    if (forwarded.length)
      await recordDecision(forwarded.map((item) => item.sheet.ID), "APPROVAL", "LEADER_APPROVED", req, req.data?.comentario, { TimeEntries, TimeEntryDecisions });
    await appendTimeApprovalEvent(WeeklyTimeApprovalEvents, {
      group,
      context,
      type: group.status === "LEADER_APPROVED" ? "TIME_ADMIN_APPROVED" : "TIME_PROJECT_APPROVED",
      detail: `${completed.length} hoja(s) completaron su aprobación y ${forwarded.length} pasaron a la siguiente etapa.`,
      occurredAt: now,
    });
    if (completed.length) {
      const completedSheets = completed.map((item) => item.sheet);
      const summary = await summarizeGroup({ ...group, status: "INTERNALLY_APPROVED", sheets: completedSheets, sheetIDs: completedSheets.map((sheet) => sheet.ID) }, { TimeEntries, Evidence, context });
      await notifyEmployee(
        cds.tx(req),
        summary,
        "INTERNALLY_APPROVED",
        req.data?.comentario,
        now,
      );
    }
    const byApprover = new Map();
    for (const item of forwarded) {
      if (!byApprover.has(item.approver.ID)) byApprover.set(item.approver.ID, { approver: item.approver, sheets: [] });
      byApprover.get(item.approver.ID).sheets.push(item.sheet);
    }
    for (const block of byApprover.values()) {
      const summary = await summarizeGroup({ ...group, status: "LEADER_APPROVED", sheets: block.sheets, sheetIDs: block.sheets.map((sheet) => sheet.ID), ID: block.sheets[0].ID }, { TimeEntries, Evidence, context });
      await notifyAdministrators(cds.tx(req), summary, now, [block.approver]);
    }
    return {
      exito: true,
      mensaje: forwarded.length
        ? `${forwarded.length} bloque(s) pasaron a aprobación administrativa.${completed.length ? ` ${completed.length} bloque(s) quedaron aprobados.` : ""}`
        : "El bloque quedó aprobado internamente.",
      estado: forwarded.length ? "LEADER_APPROVED" : "INTERNALLY_APPROVED",
    };
  });

  this.on("devolverHoja", async (req) => {
    const comment = String(req.data?.comentario || "").trim();
    if (comment.length < 5) {
      reject(req, 400, "COMENTARIO_REQUERIDO", "Explica al empleado qué debe corregir antes de devolver la semana.", "comentario");
    }
    const { group, context } = await loadSheetGroup(req, req.data?.hojaID, {
      WeeklyTimesheets,
      TimeEntries,
      ProjectApprovers,
    });
    if (!isPendingForContext(group, context)) {
      reject(req, 409, "SEMANA_NO_DEVOLVIBLE", "La semana ya no puede devolverse en esta etapa.");
    }
    const now = new Date().toISOString();
    const operations = group.sheets.map((sheet) => UPDATE(WeeklyTimesheets)
      .set({ status: "RETURNED", currentApprover_ID: null, returnedAt: now, returnComment: comment, version: Number(sheet.version || 1) + 1 })
      .where({ ID: sheet.ID, status: sheet.status }));
    operations.push(UPDATE(TimeEntries).set({ status: "RETURNED" }).where({ timesheet_ID: { in: group.sheetIDs } }));
    await cds.tx(req).run(operations);
    await recordDecision(group.sheetIDs, "REVIEW", "RETURNED", req, comment, { TimeEntries, TimeEntryDecisions });
    await appendTimeApprovalEvent(WeeklyTimeApprovalEvents, {
      group,
      context,
      type: "TIME_RETURNED",
      detail: comment,
      occurredAt: now,
      targetEmployeeID: group.employee_ID,
    });
    const summary = await summarizeGroup({ ...group, status: "RETURNED" }, { TimeEntries, Evidence, context });
    await notifyEmployee(cds.tx(req), summary, "RETURNED", comment, now);
    return { exito: true, mensaje: "La semana completa fue devuelta al empleado para corrección.", estado: "RETURNED" };
  });

  this.on("reenviarHoja", async (req) => {
    const comment = String(req.data?.comentario || "").trim();
    if (comment.length < 5) {
      reject(req, 400, "COMENTARIO_REQUERIDO", "Explica por qué reenvías la solicitud.", "comentario");
    }
    const { group, context } = await loadSheetGroup(req, req.data?.hojaID, {
      WeeklyTimesheets,
      TimeEntries,
      ProjectApprovers,
    });
    if (!isPendingForContext(group, context)) {
      reject(req, 403, "REENVIO_NO_AUTORIZADO", "Solo el responsable actual puede reenviar la solicitud.");
    }
    const delegate = await SELECT.one.from("sabnez.rrhh.Empleados")
      .columns("ID", "nombreCompleto", "correoCorporativo", "estado_codigo")
      .where({ ID: req.data?.delegadoID });
    if (
      !delegate ||
      delegate.estado_codigo !== "AC" ||
      !delegate.correoCorporativo ||
      delegate.ID === context.employeeID ||
      delegate.ID === group.employee_ID
    ) {
      reject(req, 400, "DELEGADO_INVALIDO", "Selecciona otro empleado activo con correo corporativo.");
    }
    const now = new Date().toISOString();
    await cds.tx(req).run(
      group.sheets.map((sheet) =>
        UPDATE(WeeklyTimesheets)
          .set({
            currentApprover_ID: delegate.ID,
            version: Number(sheet.version || 1) + 1,
          })
          .where({ ID: sheet.ID, status: sheet.status }),
      ),
    );
    await appendTimeApprovalEvent(WeeklyTimeApprovalEvents, {
      group,
      context,
      type: "TIME_FORWARDED",
      detail: comment,
      occurredAt: now,
      targetEmployeeID: delegate.ID,
    });
    const summary = await summarizeGroup(group, { TimeEntries, Evidence, context });
    await queueTimeNotification(cds.tx(req), {
      type: "TIME_SUBMITTED",
      recipientID: delegate.correoCorporativo,
      idempotencyKey: `time-forward:${group.ID}:${now}`,
      payload: {
        recipientName: delegate.nombreCompleto,
        solicitanteNombre: summary.empleadoNombre,
        hojaID: summary.ID,
        titulo: `${summary.semanaInicio} a ${summary.semanaFin}`,
        resumen: `${Number(summary.totalHoras || 0).toFixed(1)} horas · Solicitud reenviada`,
        facts: [
          { etiqueta: "Empleado", valor: summary.empleadoNombre, orden: 1 },
          { etiqueta: "Proyectos", valor: summary.proyectoNombre, orden: 2 },
          { etiqueta: "Motivo del reenvío", valor: comment, orden: 3 },
        ],
      },
    });
    return {
      exito: true,
      mensaje: `La solicitud fue reenviada a ${delegate.nombreCompleto}.`,
      estado: group.status,
    };
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


function requireReassignmentPermission(req) {
  if (!req.user?.is?.("TimeApprovalReassign")) {
    return req.reject(403, "No tienes autorización para reasignar aprobaciones de tiempos.");
  }
}

async function loadReassignmentGroup(req, ID, options = {}) {
  const times = cds.entities("sabnez.times");
  const WeeklyTimesheets = options.WeeklyTimesheets || times.WeeklyTimesheets;

  if (!ID) {
    return req.reject(400, "Debes indicar la hoja de tiempos.");
  }

  const seed = await SELECT.one
    .from(WeeklyTimesheets)
    .columns(
      "ID",
      "employee_ID",
      "employee.nombreCompleto as employeeName",
      "employee.correoCorporativo as employeeEmail",
      "weekStart",
      "weekEnd",
      "status",
      "submittedAt",
      "version",
      "currentApprover_ID",
    )
    .where({ ID });

  if (!seed) {
    return req.reject(404, "La hoja de tiempos indicada no existe.");
  }

  const sheets = await SELECT.from(WeeklyTimesheets)
    .columns(
      "ID",
      "employee_ID",
      "employee.nombreCompleto as employeeName",
      "employee.correoCorporativo as employeeEmail",
      "weekStart",
      "weekEnd",
      "status",
      "submittedAt",
      "version",
      "currentApprover_ID",
    )
    .where({ employee_ID: seed.employee_ID, weekStart: seed.weekStart });

  const group = groupSheets(sheets).find((item) => item.sheetIDs.includes(seed.ID));
  if (!group) {
    return req.reject(404, "No fue posible reconstruir la semana de tiempos.");
  }

  return { group };
}

async function resolveExpectedApprover(
  group,
  { TimeEntries, ProjectApprovers },
) {
  if (new Set(["SUBMITTED", "UNDER_REVIEW", "LEADER_APPROVED"]).has(group.status)) {
    const routes = await configuredRoutes(group, { TimeEntries, ProjectApprovers },
      group.status === "LEADER_APPROVED" ? "ADMIN" : null);
    const approverIDs = [...new Set(routes.map((route) => route.approver?.ID).filter(Boolean))];
    if (routes.length && approverIDs.length === 1 && routes.every((route) => route.approver)) {
      return {
        approver: routes[0].approver,
        stage: routes[0].role === "ADMIN" ? "Aprobación administrativa" : "Aprobación del líder",
        reason: "",
      };
    }
    return {
      approver: null,
      stage: group.status === "LEADER_APPROVED" ? "Aprobación administrativa" : "Aprobación del proyecto",
      reason: routes.find((route) => !route.approver)?.reason ||
        "Los proyectos del bloque ya no comparten el mismo aprobador configurado.",
    };
  }

  return {
    approver: null,
    stage: "Sin etapa pendiente",
    reason: `El estado ${group.status || "desconocido"} no requiere reasignación de aprobador.`,
  };
}

async function loadReassignmentIssues({
  WeeklyTimesheets,
  TimeEntries,
  ProjectApprovers,
}) {
  const pendingStatuses = ["SUBMITTED", "UNDER_REVIEW", "LEADER_APPROVED"];

  const sheets = await SELECT.from(WeeklyTimesheets)
    .columns(
      "ID",
      "employee_ID",
      "employee.nombreCompleto as employeeName",
      "employee.correoCorporativo as employeeEmail",
      "weekStart",
      "weekEnd",
      "status",
      "submittedAt",
      "version",
      "currentApprover_ID",
    )
    .where({ status: { in: pendingStatuses } });

  const groups = groupSheets(sheets);
  const approverIDs = new Set(
    groups.map((group) => group.currentApprover_ID).filter(Boolean),
  );
  const currentApprovers = approverIDs.size
    ? await SELECT.from("sabnez.rrhh.Empleados")
        .columns("ID", "nombreCompleto", "correoCorporativo", "estado_codigo")
        .where({ ID: { in: [...approverIDs] } })
    : [];
  const currentByID = new Map(currentApprovers.map((row) => [row.ID, row]));

  const issues = [];

  for (const group of groups) {
    const current = group.currentApprover_ID
      ? currentByID.get(group.currentApprover_ID)
      : null;
    const currentValid = Boolean(
      current && current.estado_codigo === "AC" && current.correoCorporativo,
    );

    // Siempre resolvemos la ruta que DEBERÍA tener hoy la aprobación.
    // Antes se descartaba cualquier hoja que tuviera un currentApprover válido,
    // aunque ese aprobador ya no correspondiera con la ruta vigente.
    const resolution = await resolveExpectedApprover(group, {
      TimeEntries,
      ProjectApprovers,
    });

    const expectedApproverID = resolution.approver?.ID || null;
    const routeMatchesExpected = Boolean(
      currentValid &&
        expectedApproverID &&
        group.currentApprover_ID === expectedApproverID,
    );

    // Un reenvío o una reasignación manual son excepciones intencionales a la
    // ruta calculada. Si el aprobador actual coincide con el último destinatario
    // explícito de una de esas acciones, no lo marcamos como incidencia.
    const latestOverrideEvent = await SELECT.one
      .from("sabnez.times.WeeklyTimeApprovalEvents")
      .columns("type", "targetEmployee_ID", "occurredAt")
      .where({
        employee_ID: group.employee_ID,
        weekStart: group.weekStart,
        type: { in: ["TIME_FORWARDED", "TIME_APPROVER_REASSIGNED"] },
      })
      .orderBy("occurredAt desc");

    const validExplicitOverride = Boolean(
      currentValid &&
        latestOverrideEvent?.targetEmployee_ID &&
        latestOverrideEvent.targetEmployee_ID === group.currentApprover_ID,
    );

    // La hoja solo está sana si el responsable actual coincide con la ruta
    // vigente o si existe una reasignación/reenvío manual válido que lo explique.
    if (routeMatchesExpected || validExplicitOverride) {
      continue;
    }

    const entries = await SELECT.from(TimeEntries)
      .columns(
        "durationHours",
        "assignment.project.name as projectName",
        "assignment.project.client.tradeName as clientTradeName",
        "assignment.project.client.legalName as clientLegalName",
      )
      .where({ timesheet_ID: { in: group.sheetIDs } });

    const projectNames = [
      ...new Set(entries.map((entry) => entry.projectName).filter(Boolean)),
    ];
    const clientNames = [
      ...new Set(
        entries
          .map((entry) => entry.clientTradeName || entry.clientLegalName)
          .filter(Boolean),
      ),
    ];

    let issueReason;
    if (!group.currentApprover_ID) {
      issueReason = resolution.approver
        ? "La solicitud está pendiente pero no tiene aprobador asignado."
        : resolution.reason;
    } else if (!current) {
      issueReason = "El aprobador actual ya no existe en el maestro de empleados.";
    } else if (current.estado_codigo !== "AC") {
      issueReason = "El aprobador actual ya no está activo.";
    } else if (!current.correoCorporativo) {
      issueReason = "El aprobador actual no tiene correo corporativo configurado.";
    } else if (expectedApproverID && group.currentApprover_ID !== expectedApproverID) {
      issueReason = `El aprobador actual (${current.nombreCompleto}) no coincide con la ruta vigente (${resolution.approver.nombreCompleto}).`;
    } else if (!expectedApproverID) {
      issueReason =
        resolution.reason ||
        "No fue posible determinar un aprobador válido con la configuración vigente.";
    } else {
      issueReason = "La ruta de aprobación requiere revisión.";
    }

    issues.push({
      ID: group.ID,
      empleadoID: group.employee_ID,
      empleadoNombre: group.employeeName,
      empleadoCorreo: group.employeeEmail,
      clienteNombre: clientNames.join(", "),
      proyectoNombre: projectNames.join(", "),
      semanaInicio: group.weekStart,
      semanaFin: group.weekEnd,
      estado: group.status,
      etapa: resolution.stage,
      aprobadorActualID: group.currentApprover_ID || null,
      aprobadorActualNombre: current?.nombreCompleto || null,
      aprobadorSugeridoID: resolution.approver?.ID || null,
      aprobadorSugeridoNombre: resolution.approver?.nombreCompleto || null,
      motivo: issueReason || resolution.reason || "Ruta de aprobación incompleta.",
      resolubleAutomaticamente: Boolean(resolution.approver),
      totalHoras: Number(
        entries
          .reduce((sum, entry) => sum + Number(entry.durationHours || 0), 0)
          .toFixed(2),
      ),
      totalRegistros: entries.length,
    });
  }

  return issues.sort(
    (a, b) =>
      String(b.semanaInicio || "").localeCompare(String(a.semanaInicio || "")) ||
      String(a.empleadoNombre || "").localeCompare(
        String(b.empleadoNombre || ""),
        "es",
      ),
  );
}

async function notifyReassignedApprover(
  tx,
  group,
  approver,
  mode,
  notificationKey,
  { TimeEntries },
) {
  if (!approver?.correoCorporativo) return;

  const entries = await SELECT.from(TimeEntries)
    .columns(
      "durationHours",
      "assignment.project.name as projectName",
    )
    .where({ timesheet_ID: { in: group.sheetIDs } });

  const projects = [
    ...new Set(entries.map((entry) => entry.projectName).filter(Boolean)),
  ];
  const totalHours = entries.reduce(
    (sum, entry) => sum + Number(entry.durationHours || 0),
    0,
  );

  await queueTimeNotification(tx, {
    type: "TIME_SUBMITTED",
    recipientID: approver.correoCorporativo,
    idempotencyKey: `time-reassign:${group.ID}:${mode}:${notificationKey}:${String(
      approver.correoCorporativo,
    ).toLowerCase()}`,
    payload: {
      recipientName: approver.nombreCompleto || "Aprobador",
      solicitanteNombre: group.employeeName,
      hojaID: group.ID,
      titulo: `${group.weekStart} a ${group.weekEnd}`,
      resumen: `${totalHours.toFixed(1)} horas · Solicitud reasignada`,
      facts: [
        { etiqueta: "Empleado", valor: group.employeeName, orden: 1 },
        {
          etiqueta: "Proyectos",
          valor: projects.join(", ") || "Sin proyecto",
          orden: 2,
        },
        {
          etiqueta: "Motivo",
          valor:
            mode === "MANUAL"
              ? "Reasignación manual de aprobación"
              : "Ruta de aprobación reprocesada",
          orden: 3,
        },
      ],
    },
  });
}

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
    siguienteAccion: group.status === "LEADER_APPROVED" ? "Aprobación administrativa" : "Aprobación configurada en el proyecto",
    puedeAprobar: pendingEvidence === 0 && pendingForReviewer,
    puedeDevolver: pendingForReviewer,
  };
}

async function loadSheetGroup(req, ID, options) {
  const times = cds.entities("sabnez.times");
  const WeeklyTimesheets = options?.WeeklyTimesheets || times.WeeklyTimesheets;
  const TimeEntries = options?.TimeEntries || times.TimeEntries;
  const ProjectApprovers = options?.ProjectApprovers || times.ProjectApprovers;
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
    "currentApprover_ID",
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
    "currentApprover_ID",
  ).where({ employee_ID: seed.employee_ID, weekStart: seed.weekStart });
  const group = groupSheets(sheets).find((item) => item.sheetIDs.includes(seed.ID));
  const context = await reviewerContext(req);
  group.pendingForReviewer = await isAssignedReviewer(group, context, {
    TimeEntries,
    ProjectApprovers,
  });
  if (
    !group.pendingForReviewer &&
    !context.isAdmin
  ) {
    reject(req, 403, "SEMANA_NO_AUTORIZADA", "No tienes autorización para revisar esta semana.");
  }
  return { group, context };
}

function groupSheets(sheets) {
  const groups = new Map();
  for (const sheet of sheets) {
    const key = `${sheet.employee_ID}|${sheet.weekStart}|${sheet.status}|${sheet.currentApprover_ID || "SIN_APROBADOR"}`;
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
        currentApprover_ID: sheet.currentApprover_ID,
        sheets: [],
        sheetIDs: [],
      });
    }
    const group = groups.get(key);
    group.sheets.push(sheet);
    group.sheetIDs.push(sheet.ID);
    if (sheet.currentApprover_ID) group.currentApprover_ID = sheet.currentApprover_ID;
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
  return {
    isAdmin,
    email,
    employeeID: employee?.ID || null,
    directReportIDs: new Set(),
  };
}

async function isAssignedReviewer(group, context, entities) {
  if (!context.employeeID || context.employeeID === group.employee_ID) return false;
  if (group.currentApprover_ID) {
    return group.currentApprover_ID === context.employeeID;
  }
  return false;
}

async function configuredAdministrativeApprovers(
  group,
  { TimeEntries, ProjectApprovers },
) {
  const routes = await configuredRoutes(group, { TimeEntries, ProjectApprovers }, "ADMIN");
  const ids = [...new Set(routes.map((route) => route.approver?.ID).filter(Boolean))];
  if (ids.length !== 1 || routes.some((route) => !route.approver)) return [];
  return [routes[0].approver];
}

async function configuredRoutes(group, { TimeEntries, ProjectApprovers }, forcedRole) {
  const entries = await SELECT.from(TimeEntries)
    .columns(
      "assignment.project_ID as projectID",
      "assignment.project.name as projectName",
      "assignment.project.approvalScheme as approvalScheme",
    )
    .where({ timesheet_ID: { in: group.sheetIDs } });
  const projects = [...new Map(entries.filter((row) => row.projectID)
    .map((row) => [row.projectID, row])).values()];
  const projectIDs = projects.map((row) => row.projectID);
  if (!projectIDs.length) return [];

  const rows = await SELECT.from(ProjectApprovers)
    .columns(
      "project_ID",
      "employee_ID",
      "employee.nombreCompleto as employeeName",
      "employee.correoCorporativo as employeeEmail",
      "employee.estado_codigo as employeeStatus",
      "validFrom",
      "validTo",
      "active",
      "approverType",
    )
    .where({ project_ID: { in: projectIDs }, active: true });
  const valid = rows.filter(
    (row) =>
      row.employeeStatus === "AC" &&
      row.employeeEmail &&
      (!row.validFrom || row.validFrom <= group.weekEnd) &&
      (!row.validTo || row.validTo >= group.weekStart) &&
      row.employee_ID !== group.employee_ID,
  );
  return projects.map((project) => {
    const roles = forcedRole ? [forcedRole] : initialRoles(project.approvalScheme);
    const row = roles.flatMap((role) => valid.filter((candidate) =>
      candidate.project_ID === project.projectID &&
      String(candidate.approverType || "").toUpperCase() === role,
    ))[0];
    return {
      projectID: project.projectID,
      projectName: project.projectName,
      scheme: project.approvalScheme || "LEADER_THEN_ADMIN",
      role: row ? String(row.approverType || "").toUpperCase() : roles[0],
      approver: row ? {
        ID: row.employee_ID,
        nombreCompleto: row.employeeName,
        correoCorporativo: row.employeeEmail,
      } : null,
      reason: row ? "" : `${project.projectName || "El proyecto"} no tiene un aprobador ${roles.join(" o ").toLowerCase()} activo y vigente.`,
    };
  });
}

function initialRoles(scheme) {
  if (scheme === "ADMIN_ONLY") return ["ADMIN"];
  if (scheme === "LEADER_OR_ADMIN") return ["LEADER", "ADMIN"];
  return ["LEADER"];
}

async function employeeNames(employeeIDs) {
  if (!employeeIDs.size) return new Map();
  const rows = await SELECT.from("sabnez.rrhh.Empleados")
    .columns("ID", "nombreCompleto")
    .where({ ID: { in: [...employeeIDs] } });
  return new Map(rows.map((row) => [row.ID, row.nombreCompleto]));
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

async function appendTimeApprovalEvent(entity, input) {
  await INSERT.into(entity).entries({
    ID: cds.utils.uuid(),
    employee_ID: input.group.employee_ID,
    weekStart: input.group.weekStart,
    type: input.type,
    actorUserID: input.context?.email || null,
    actorEmployee_ID: input.context?.employeeID || null,
    targetEmployee_ID: input.targetEmployeeID || null,
    detail: input.detail || null,
    occurredAt: input.occurredAt || new Date().toISOString(),
  });
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
      resumen: status === "RETURNED" ? "Tu bloque de tiempos fue devuelto y requiere ajustes." : "Tu bloque de tiempos fue aprobado.",
      comentario: comment,
      facts: [
        { etiqueta: "Proyectos", valor: summary.proyectoNombre, orden: 1 },
        { etiqueta: "Total", valor: `${Number(summary.totalHoras || 0).toFixed(1)} horas`, orden: 2 },
        { etiqueta: "Semana", valor: `${summary.semanaInicio} a ${summary.semanaFin}`, orden: 3 },
      ],
    },
  });
}

async function notifyAdministrators(
  tx,
  summary,
  notificationKey,
  administrativeApprovers,
) {
  const employeeEmail = String(summary.empleadoCorreo || "").trim().toLowerCase();
  const recipients = administrativeApprovers.filter(
    (approver) =>
      approver.correoCorporativo &&
      approver.correoCorporativo.toLowerCase() !== employeeEmail,
  );
  for (const approver of recipients) {
    const email = approver.correoCorporativo;
    await queueTimeNotification(tx, {
      type: "TIME_SUBMITTED",
      recipientID: email,
      idempotencyKey:
        `time-admin:${summary.ID}:${notificationKey}:${email.toLowerCase()}`,
      payload: {
        recipientName: approver.nombreCompleto || "Administración",
        solicitanteNombre: summary.empleadoNombre,
        hojaID: summary.ID,
        titulo: `${summary.semanaInicio} a ${summary.semanaFin}`,
        resumen: `${Number(summary.totalHoras || 0).toFixed(1)} horas · ${summary.proyectoNombre}`,
        facts: [
          { etiqueta: "Estado", valor: "Lista para aprobación administrativa", orden: 1 },
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
  return Boolean(
    group.pendingForReviewer && context.employeeID !== group.employee_ID,
  );
}

function statusRank(status) {
  return { RETURNED: 0, SUBMITTED: 1, UNDER_REVIEW: 2, LEADER_APPROVED: 3, INTERNALLY_APPROVED: 4, CLOSED: 5 }[status] ?? 99;
}

function weekdayName(value) {
  const names = [
    "domingo",
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábado",
  ];
  const date = new Date(`${value}T00:00:00Z`);
  return names[date.getUTCDay()] || "día";
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
