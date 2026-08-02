"use strict";

const cds = require("@sap/cds");
const { Readable } = require("node:stream");
const {
  exceedsDailyWarning,
  validateTimeEntry,
} = require("./lib/time-entry-rules");
const { isColombianHoliday } = require("./lib/absence-rules");

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

module.exports = cds.service.impl(function () {
  const rrhh = cds.entities("sabnez.rrhh");
  const times = cds.entities("sabnez.times");
  const { Empleados } = rrhh;
  const {
    Projects,
    ProjectAssignments,
    WeeklyTimesheets,
    TimeEntries,
  } = times;
  const Evidence = times["TimeEntries.evidence"];

  this.on("obtenerMisAsignaciones", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const date = normalizeDate(req.data?.fecha) || todayISO();
    const assignments = await SELECT.from(ProjectAssignments)
      .columns(
        "ID",
        "validFrom",
        "validTo",
        "project_ID",
        "project.code as projectCode",
        "project.name as projectName",
        "project.modality as modality",
        "project.requiresDescription as requiresDescription",
        "project.requiresEvidence as requiresEvidence",
        "project.timeZone as timeZone",
        "project.client.tradeName as clientTradeName",
        "project.client.legalName as clientLegalName",
      )
      .where({ employee_ID: employee.ID, status: "ACTIVE" });

    return assignments
      .filter((assignment) => isDateWithin(date, assignment.validFrom, assignment.validTo))
      .map((assignment) => ({
        ID: assignment.ID,
        proyectoID: assignment.project_ID,
        proyectoCodigo: assignment.projectCode,
        proyectoNombre: assignment.projectName,
        clienteNombre: assignment.clientTradeName || assignment.clientLegalName,
        modalidad: assignment.modality,
        fechaInicio: assignment.validFrom,
        fechaFin: assignment.validTo,
        requiereDescripcion: Boolean(assignment.requiresDescription),
        requiereSoporte: Boolean(assignment.requiresEvidence),
        zonaHoraria: assignment.timeZone,
      }));
  });

  this.on("obtenerMisRegistros", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const weekStart = requireMonday(req, req.data?.semanaInicio);
    const weekEnd = addDays(weekStart, 6);
    const entries = await SELECT.from(TimeEntries)
      .columns(
        "ID",
        "timesheet_ID",
        "assignment_ID",
        "assignment.project.name as projectName",
        "workDate",
        "durationHours",
        "requestedType",
        "description",
        "evidenceRequired",
        "approximateStartTime",
        "approximateEndTime",
        "timeZone",
        "priorAuthorization",
        "exceptionalReason",
        "status",
        "dailyHoursWarning",
        "version",
      )
      .where({ employee_ID: employee.ID, workDate: { between: weekStart, and: weekEnd } });

    return Promise.all(entries.map((entry) => enrichEntry(entry, Evidence)));
  });

  this.on("obtenerMisRegistrosMes", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const monthStart = requireDate(req, req.data?.mesInicio, "mesInicio");
    if (!monthStart.endsWith("-01")) reject(req, 400, "MES_INVALIDO", "La fecha del mes debe corresponder al primer día.");
    const monthEnd = addDays(addMonths(monthStart, 1), -1);
    const entries = await SELECT.from(TimeEntries).columns(
      "ID", "timesheet_ID", "assignment_ID", "assignment.project.name as projectName", "workDate", "durationHours",
      "requestedType", "description", "evidenceRequired", "approximateStartTime", "approximateEndTime", "timeZone",
      "priorAuthorization", "exceptionalReason", "status", "dailyHoursWarning", "version",
    ).where({ employee_ID: employee.ID, workDate: { between: monthStart, and: monthEnd } });
    return Promise.all(entries.map((entry) => enrichEntry(entry, Evidence)));
  });

  this.on("obtenerDiasNoHabiles", (req) => {
    const from = requireDate(req, req.data?.desde, "desde");
    const to = requireDate(req, req.data?.hasta, "hasta");
    if (to < from) reject(req, 400, "RANGO_FECHAS_INVALIDO", "La fecha final no puede ser anterior a la inicial.");
    const days = [];
    for (let value = from; value <= to; value = addDays(value, 1)) {
      const date = new Date(`${value}T00:00:00Z`);
      const day = date.getUTCDay();
      if (isColombianHoliday(date)) days.push({ fecha: value, tipo: "HOLIDAY", motivo: "Festivo nacional" });
      else if (day === 0 || day === 6) days.push({ fecha: value, tipo: "WEEKEND", motivo: day === 6 ? "Sábado" : "Domingo" });
    }
    return days;
  });

  this.on("guardarBorrador", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const input = req.data || {};
    const assignmentID = requireUUID(req, input.asignacionID, "asignacionID");
    const workDate = requireDate(req, input.fecha, "fecha");
    const assignment = await SELECT.one.from(ProjectAssignments)
      .columns(
        "ID",
        "employee_ID",
        "validFrom",
        "validTo",
        "status",
        "project_ID",
        "project.status as projectStatus",
        "project.name as projectName",
        "project.requiresDescription as requiresDescription",
        "project.requiresEvidence as requiresEvidence",
        "project.dailyWarningHours as dailyWarningHours",
        "project.timeZone as projectTimeZone",
      )
      .where({ ID: assignmentID, employee_ID: employee.ID });

    if (!assignment || assignment.status !== "ACTIVE" || assignment.projectStatus !== "ACTIVE") {
      reject(req, 404, "ASIGNACION_NO_DISPONIBLE", "La asignación no existe o no está activa para el empleado autenticado.");
    }
    if (!isDateWithin(workDate, assignment.validFrom, assignment.validTo)) {
      reject(req, 400, "FECHA_FUERA_DE_ASIGNACION", "La fecha no pertenece a la vigencia de la asignación.", "fecha");
    }

    const canonical = {
      durationHours: Number(input.duracionHoras),
      requestedType: input.tipoSolicitado || "REGULAR",
      description: normalizeOptionalText(input.descripcion),
      approximateStartTime: input.horaInicioAproximada || null,
      approximateEndTime: input.horaFinAproximada || null,
      timeZone: input.zonaHoraria || assignment.projectTimeZone,
      priorAuthorization: Boolean(input.autorizacionPrevia),
      exceptionalReason: normalizeOptionalText(input.motivoExcepcional),
    };
    const validation = validateTimeEntry(canonical, assignment);
    if (validation.errors.length) {
      reject(req, 400, "REGISTRO_INVALIDO", validation.errors.join(" "));
    }

    const existingID = input.ID || null;
    let existing = null;
    if (existingID) {
      existing = await SELECT.one.from(TimeEntries).where({
        ID: existingID,
        employee_ID: employee.ID,
      });
      if (!existing) reject(req, 404, "REGISTRO_NO_ENCONTRADO", "El registro no existe o no pertenece al empleado autenticado.");
      if (!new Set(["DRAFT", "RETURNED"]).has(existing.status)) {
        reject(req, 409, "REGISTRO_NO_EDITABLE", "Solo se pueden editar registros en borrador o devueltos.");
      }
    }

    const weekStart = startOfISOWeek(workDate);
    const timesheet = await getOrCreateTimesheet({
      assignment,
      employeeID: employee.ID,
      weekStart,
      WeeklyTimesheets,
    });
    if (!new Set(["OPEN", "RETURNED"]).has(timesheet.status)) {
      reject(req, 409, "SEMANA_NO_EDITABLE", "La semana ya fue enviada o cerrada.");
    }

    const sameDay = await SELECT.from(TimeEntries)
      .columns("ID", "durationHours")
      .where({ employee_ID: employee.ID, workDate });
    const existingHours = sameDay
      .filter((entry) => entry.ID !== existingID && entry.ID !== null)
      .reduce((sum, entry) => sum + Number(entry.durationHours || 0), 0);
    const dailyWarning = exceedsDailyWarning(
      existingHours,
      canonical.durationHours,
      16,
    );
    if (dailyWarning && !canonical.description) {
      reject(req, 400, "DESCRIPCION_ALERTA_DIARIA", "Al superar el umbral diario debe explicar las actividades realizadas.", "descripcion");
    }

    const ID = existingID || cds.utils.uuid();
    const persistence = {
      timesheet_ID: timesheet.ID,
      billingPeriod_ID: null,
      assignment_ID: assignment.ID,
      employee_ID: employee.ID,
      workDate,
      ...canonical,
      evidenceRequired: validation.evidenceRequired,
      status: "DRAFT",
      dailyHoursWarning: dailyWarning,
      commercialTreatment: "PENDING",
      billableHours: 0,
      version: existing ? Number(existing.version || 1) + 1 : 1,
    };
    if (existing) await UPDATE(TimeEntries).set(persistence).where({ ID, employee_ID: employee.ID });
    else await INSERT.into(TimeEntries).entries({ ID, ...persistence });

    const saved = await SELECT.one.from(TimeEntries)
      .columns("*", "assignment.project.name as projectName")
      .where({ ID, employee_ID: employee.ID });
    return { exito: true, mensaje: "El borrador se guardó correctamente.", registro: await enrichEntry(saved, Evidence) };
  });

  this.on("enviarSemana", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const weekStart = requireMonday(req, req.data?.semanaInicio);
    const weekEnd = addDays(weekStart, 6);
    const sheets = await SELECT.from(WeeklyTimesheets)
      .where({ employee_ID: employee.ID, weekStart });
    if (!sheets.length) reject(req, 404, "SEMANA_SIN_REGISTROS", "No existen registros para enviar en esta semana.");
    if (sheets.some((sheet) => !new Set(["OPEN", "RETURNED"]).has(sheet.status))) {
      reject(req, 409, "SEMANA_YA_ENVIADA", "Una o más hojas de la semana ya fueron enviadas.");
    }

    const entries = await SELECT.from(TimeEntries).where({
      employee_ID: employee.ID,
      workDate: { between: weekStart, and: weekEnd },
      status: { in: ["DRAFT", "RETURNED"] },
    });
    if (!entries.length) reject(req, 404, "SEMANA_SIN_REGISTROS", "No existen borradores para enviar en esta semana.");

    for (const entry of entries) {
      if (!entry.evidenceRequired) continue;
      const evidence = Evidence ? await SELECT.from(Evidence).where({ up__ID: entry.ID }) : [];
      if (!evidence.length) reject(req, 400, "SOPORTE_REQUERIDO", `El registro del ${entry.workDate} requiere al menos un soporte.`);
      if (evidence.some((file) => file.status !== "Clean")) {
        reject(req, 409, "SOPORTE_NO_VALIDADO", "Todos los soportes deben superar la validación de seguridad antes del envío.");
      }
    }

    const now = new Date().toISOString();
    for (const sheet of sheets) {
      await UPDATE(WeeklyTimesheets).set({ status: "SUBMITTED", submittedAt: now, version: Number(sheet.version || 1) + 1 }).where({ ID: sheet.ID, status: sheet.status });
    }
    await UPDATE(TimeEntries).set({ status: "SUBMITTED" }).where({
      employee_ID: employee.ID,
      workDate: { between: weekStart, and: weekEnd },
      status: { in: ["DRAFT", "RETURNED"] },
    });
    return {
      exito: true,
      mensaje: "La semana se envió correctamente para revisión.",
      hojaSemanalID: sheets.length === 1 ? sheets[0].ID : null,
      semanaInicio: weekStart,
      semanaFin: weekEnd,
      estado: "SUBMITTED",
      totalRegistros: entries.length,
      totalHoras: entries.reduce((sum, entry) => sum + Number(entry.durationHours || 0), 0),
    };
  });

  this.on("cargarSoporte", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const { registroID, nombreArchivo, mimeType, contenido } = req.data || {};
    if (!Evidence || !registroID || !nombreArchivo || !contenido) {
      reject(req, 400, "SOPORTE_INCOMPLETO", "Faltan los datos necesarios para cargar el soporte.");
    }
    const entry = await SELECT.one.from(TimeEntries).where({ ID: registroID, employee_ID: employee.ID });
    if (!entry) reject(req, 404, "REGISTRO_NO_ENCONTRADO", "El registro no existe o no pertenece al empleado autenticado.");
    if (!new Set(["DRAFT", "RETURNED"]).has(entry.status)) {
      reject(req, 409, "SOPORTES_BLOQUEADOS", "Solo se pueden cargar soportes en registros editables.");
    }
    const buffer = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido, "base64");
    if (!buffer.length) reject(req, 400, "ARCHIVO_VACIO", "El archivo recibido está vacío.");
    if (buffer.length > 10 * 1024 * 1024) reject(req, 413, "ARCHIVO_DEMASIADO_GRANDE", "El soporte no puede superar 10 MB.");

    const supportID = cds.utils.uuid();
    const safeName = String(nombreArchivo).trim().slice(0, 255);
    const safeMime = String(mimeType || "application/octet-stream").trim().slice(0, 100);
    await INSERT.into(Evidence).entries({
      ID: supportID,
      up__ID: registroID,
      filename: safeName,
      mimeType: safeMime,
      content: buffer,
      status: "Scanning",
    });

    let scanResult;
    try {
      const scanner = await cds.connect.to("malwareScanner");
      scanResult = await scanner.send("scan", { file: Readable.from([buffer]) });
    } catch (error) {
      await DELETE.from(Evidence).where({ ID: supportID, up__ID: registroID });
      reject(req, 502, "ESCANEO_SOPORTE_FALLIDO", "No fue posible validar el archivo con el servicio de seguridad.");
    }
    const infected = Boolean(scanResult?.isMalware);
    await UPDATE(Evidence).set({
      status: infected ? "Infected" : "Clean",
      lastScan: new Date().toISOString(),
      hash: scanResult?.hash || null,
      note: infected ? "El servicio de seguridad detectó contenido malicioso." : null,
    }).where({ ID: supportID, up__ID: registroID });
    if (infected) {
      await DELETE.from(Evidence).where({ ID: supportID, up__ID: registroID });
      reject(req, 422, "ARCHIVO_INFECTADO", "El soporte fue rechazado por la validación de seguridad.");
    }
    return { exito: true, mensaje: "El soporte se cargó y validó correctamente.", soporteID: supportID };
  });

  this.on("eliminarRegistros", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const IDs = [...new Set((req.data?.registros || []).map((row) => row?.ID).filter(Boolean))];
    if (!IDs.length) reject(req, 400, "REGISTROS_NO_SELECCIONADOS", "Selecciona al menos un registro para eliminar.");
    const entries = await SELECT.from(TimeEntries).columns("ID", "status").where({ ID: { in: IDs }, employee_ID: employee.ID });
    if (entries.length !== IDs.length) reject(req, 404, "REGISTRO_NO_ENCONTRADO", "Uno o más registros no existen o no pertenecen al empleado autenticado.");
    const locked = entries.filter((entry) => !new Set(["DRAFT", "RETURNED"]).has(entry.status));
    if (locked.length) reject(req, 409, "REGISTRO_NO_EDITABLE", "Solo se pueden eliminar registros en borrador o devueltos.");
    return DELETE.from(TimeEntries).where({ ID: { in: IDs }, employee_ID: employee.ID });
  });
});

async function getOrCreateTimesheet({ assignment, employeeID, weekStart, WeeklyTimesheets }) {
  let sheet = await SELECT.one.from(WeeklyTimesheets).where({ assignment_ID: assignment.ID, weekStart });
  if (sheet) return sheet;
  sheet = {
    ID: cds.utils.uuid(),
    assignment_ID: assignment.ID,
    employee_ID: employeeID,
    weekStart,
    weekEnd: addDays(weekStart, 6),
    status: "OPEN",
    version: 1,
  };
  await INSERT.into(WeeklyTimesheets).entries(sheet);
  return sheet;
}

async function enrichEntry(entry, Evidence) {
  const count = Evidence ? (await SELECT.from(Evidence).columns("ID").where({ up__ID: entry.ID })).length : 0;
  return {
    ID: entry.ID,
    hojaSemanalID: entry.timesheet_ID,
    asignacionID: entry.assignment_ID,
    proyectoNombre: entry.projectName,
    fecha: entry.workDate,
    duracionHoras: entry.durationHours,
    tipoSolicitado: entry.requestedType,
    descripcion: entry.description,
    requiereSoporte: Boolean(entry.evidenceRequired),
    horaInicioAproximada: entry.approximateStartTime,
    horaFinAproximada: entry.approximateEndTime,
    zonaHoraria: entry.timeZone,
    autorizacionPrevia: Boolean(entry.priorAuthorization),
    motivoExcepcional: entry.exceptionalReason,
    estado: entry.status,
    alertaHorasDiarias: Boolean(entry.dailyHoursWarning),
    cantidadSoportes: count,
    puedeEditar: new Set(["DRAFT", "RETURNED"]).has(entry.status),
    version: entry.version,
  };
}

async function getAuthenticatedEmployee(req, Empleados) {
  const email = getAuthenticatedEmail(req);
  let employee = await SELECT.one.from(Empleados).columns("ID", "correoCorporativo", "nombreCompleto").where({ correoCorporativo: email });
  if (!employee) {
    const employees = await SELECT.from(Empleados).columns("ID", "correoCorporativo", "nombreCompleto");
    employee = employees.find((row) => normalizeEmail(row.correoCorporativo) === email);
  }
  if (!employee) reject(req, 403, "EMPLEADO_NO_ASOCIADO", `No existe un empleado asociado al correo corporativo ${email}.`);
  return employee;
}

function getAuthenticatedEmail(req) {
  const value = [req.user?.attr?.email, req.user?.attr?.mail, req.user?.attr?.emailAddress, req.user?.id]
    .find((candidate) => typeof candidate === "string" && candidate.includes("@"));
  if (!value) reject(req, 403, "CORREO_AUTENTICADO_NO_DISPONIBLE", "No fue posible obtener el correo del usuario autenticado.");
  return normalizeEmail(value);
}

function requireUUID(req, value, target) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    reject(req, 400, "UUID_INVALIDO", `El campo ${target} debe contener un UUID válido.`, target);
  }
  return value;
}

function requireDate(req, value, target) {
  const date = normalizeDate(value);
  if (!date) reject(req, 400, "FECHA_INVALIDA", `El campo ${target} debe usar el formato YYYY-MM-DD.`, target);
  return date;
}

function requireMonday(req, value) {
  const date = requireDate(req, value, "semanaInicio");
  if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 1) reject(req, 400, "SEMANA_DEBE_INICIAR_LUNES", "La semana debe comenzar un lunes.", "semanaInicio");
  return date;
}

function normalizeDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

function startOfISOWeek(value) {
  const date = new Date(`${value}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMonths(value, months) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

function isDateWithin(value, from, to) {
  return (!from || value >= from) && (!to || value <= to);
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase("es-CO") : "";
}

function normalizeOptionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function reject(req, status, code, message, target) {
  return req.reject({ status, code, message, target });
}
