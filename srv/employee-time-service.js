"use strict";

const cds = require("@sap/cds");
const { Readable } = require("node:stream");
const { streamToBuffer } = require("./lib/stream-utils");
const {
  exceedsDailyWarning,
  validateTimeEntry,
} = require("./lib/time-entry-rules");
const { loadCalendars, isWorkingDay } = require("./lib/work-calendar");
const {
  employeeBusinessDays,
  employeeTarget,
} = require("./lib/billing-targets");
const { classifyEntry } = require("./lib/commercial-classification");
const { queueTimeNotification } = require("./lib/time-notification-outbox");
const {
  nextMonthlyCutoff,
  previousMonthlyCutoff,
  daysBetween,
  cutoffCyclesForDate,
} = require("./lib/time-cutoff-policy");

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

module.exports = cds.service.impl(function () {
  const rrhh = cds.entities("sabnez.rrhh");
  const times = cds.entities("sabnez.times");
  const { Empleados } = rrhh;
  const {
    Projects,
    ProjectAssignments,
    ProjectApprovers,
    WeeklyTimesheets,
    WeeklyTimeApprovalEvents,
    TimeBulkCopyOperations,
    TimeBulkCopyItems,
    TimeEntries,
    ProjectBillingRules,
    TimeEntryCutoffBreaches,
  } = times;

  // Las reglas de facturabilidad del proyecto. Se cargan una vez por
  // operación y no una vez por registro: copiar una semana entera son
  // cinco o seis inserts y no vale la pena consultar lo mismo seis veces.
  async function loadBillingRules(projectID) {
    if (!projectID) return [];
    return (
      (await SELECT.from(ProjectBillingRules).where({
        project_ID: projectID,
        active: true,
      })) || []
    );
  }

  // Traduce una asignación a lo que el clasificador espera del proyecto.
  function projectOf(assignment) {
    return {
      ID: assignment.project_ID,
      modality: assignment.projectModality,
    };
  }

  // El clasificador devuelve más de lo que se guarda (la brecha de
  // compensación, si hubo corrección manual, qué regla aplicó). Eso sirve
  // para explicar, no para persistir: si se mete tal cual en un INSERT la
  // query se cae por columnas que no existen.
  function classificationFields({ entry, assignment, rules }) {
    const r = classifyEntry({
      entry,
      project: projectOf(assignment),
      rules,
    });
    return {
      commercialTreatment: r.commercialTreatment,
      billableHours: r.billableHours,
      payableHours: r.payableHours,
    };
  }
  const Evidence = times["TimeEntries.evidence"];

  this.on("obtenerMiContexto", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    return { empleadoID: employee.ID };
  });

  this.on("obtenerMiResumenMes", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const today = todayISOInTimeZone("America/Bogota");
    const monthStartValue = monthStart(today);
    const monthEndValue = addDays(addMonths(monthStartValue, 1), -1);

    const entries = await SELECT.from(TimeEntries)
      .columns("durationHours")
      .where({
        employee_ID: employee.ID,
        workDate: { between: monthStartValue, and: monthEndValue },
      });

    const registeredHours = entries.reduce(
      (sum, entry) => sum + Number(entry.durationHours || 0),
      0,
    );

    // El objetivo ya no es un día hábil por ocho para todo el mundo:
    // los proyectos por horas aportan su umbral facturable repartido
    // por dedicación, y el resto sigue aportando calendario.
    const assignments = await SELECT.from("sabnez.times.ProjectAssignments")
      .columns("ID", "project_ID", "employee_ID", "commercialAllocation", "status", "validFrom", "validTo")
      .where({
        employee_ID: employee.ID,
        validFrom: { "<=": monthEndValue },
      });
    const projectIDs = [...new Set(assignments.map((a) => a.project_ID))];
    const projects = projectIDs.length
      ? await SELECT.from("sabnez.times.Projects")
          .columns("ID", "modality", "monthlyBillableTarget", "workCalendar_ID")
          .where({ ID: { in: projectIDs } })
      : [];
    const calendars = await loadCalendars(projects.map((p) => p.workCalendar_ID));
    const calendarDays = employeeCalendarCounter({ assignments, projects, calendars });
    const businessDays = calendarDays(monthStartValue, monthEndValue);

    // El reparto de cada umbral necesita a todo el equipo del proyecto,
    // no sólo las asignaciones de esta persona.
    const equipo = projectIDs.length
      ? await SELECT.from("sabnez.times.ProjectAssignments")
          .columns("ID", "project_ID", "employee_ID", "commercialAllocation", "status")
          .where({ project_ID: { in: projectIDs } })
      : [];

    // Quien entró o salió a mitad de mes no puede registrar el mes
    // entero: su objetivo son los días hábiles que realmente tuvo.
    const diasPropios = employeeBusinessDays({
      employee,
      dateFrom: monthStartValue,
      dateTo: monthEndValue,
      businessDaysBetween: calendarDays,
    });

    const objetivo = employeeTarget({
      employeeID: employee.ID,
      assignments: equipo,
      projects,
      businessDays: diasPropios,
      periodBusinessDays: businessDays,
    });
    const targetHours = objetivo.horasObjetivo;
    const percentage = targetHours > 0
      ? Math.round((registeredHours / targetHours) * 10000) / 100
      : 0;

    return {
      mesInicio: monthStartValue,
      mesFin: monthEndValue,
      mesEtiqueta: formatMonthLabel(monthStartValue),
      horasRegistradas: Math.round(registeredHours * 100) / 100,
      horasObjetivo: targetHours,
      porcentaje: percentage,
      diasHabiles: businessDays,
      totalRegistros: entries.length,
      horasUmbral: objetivo.horasUmbral,
      horasCalendario: objetivo.horasCalendario,
      tieneUmbral: objetivo.tieneUmbral,
    };
  });

  this.on("obtenerEstadoEnvioSemana", async (req) => {
    await getAuthenticatedEmployee(req, Empleados);
    return {
      permitido: true,
      mensaje: "",
    };
  });

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
        "project.dailyWarningHours as dailyWarningHours",
        "project.timeEntryCutoffDay as timeEntryCutoffDay",
        "commercialAllocation",
        "project.client.tradeName as clientTradeName",
        "project.client.legalName as clientLegalName",
        "role",
      )
      .where({ employee_ID: employee.ID, status: "ACTIVE" });

    return assignments
      .filter((assignment) =>
        isDateWithin(date, assignment.validFrom, assignment.validTo),
      )
      .map((assignment) => ({
        ID: assignment.ID,
        proyectoID: assignment.project_ID,
        proyectoCodigo: assignment.projectCode,
        proyectoNombre: assignment.projectName,
        clienteNombre: assignment.clientTradeName || assignment.clientLegalName,
        rol: assignment.role || "",
        modalidad: assignment.modality,
        fechaInicio: assignment.validFrom,
        fechaFin: assignment.validTo,
        requiereDescripcion: Boolean(assignment.requiresDescription),
        requiereSoporte: Boolean(assignment.requiresEvidence),
        zonaHoraria: assignment.timeZone,
        umbralAlertaDiaria: assignment.dailyWarningHours || 16,
        carga: assignment.commercialAllocation || 0,
      }));
  });

  this.on("obtenerMisProyectosActuales", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const date = todayISO();
    const assignments = await SELECT.from(ProjectAssignments)
      .columns(
        "ID",
        "validFrom",
        "validTo",
        "role",
        "project_ID",
        "project.code as projectCode",
        "project.name as projectName",
        "project.modality as modality",
        "project.requiresDescription as requiresDescription",
        "project.requiresEvidence as requiresEvidence",
        "project.timeZone as timeZone",
        "project.dailyWarningHours as dailyWarningHours",
        "project.timeEntryCutoffDay as timeEntryCutoffDay",
        "commercialAllocation",
        "project.client.tradeName as clientTradeName",
        "project.client.legalName as clientLegalName",
      )
      .where({ employee_ID: employee.ID, status: "ACTIVE" });

    return assignments
      .filter((assignment) =>
        assignment.modality !== "INTERNAL" &&
        isDateWithin(date, assignment.validFrom, assignment.validTo),
      )
      .map((assignment) => {
        const fechaCorte = nextMonthlyCutoff(date, assignment.timeEntryCutoffDay || 31);
        const diasParaCorte = daysBetween(date, fechaCorte);
        return {
        ID: assignment.ID,
        proyectoID: assignment.project_ID,
        proyectoCodigo: assignment.projectCode,
        proyectoNombre: assignment.projectName,
        clienteNombre: assignment.clientTradeName || assignment.clientLegalName,
        rol: assignment.role || "",
        modalidad: assignment.modality,
        fechaInicio: assignment.validFrom,
        fechaFin: assignment.validTo,
        requiereDescripcion: Boolean(assignment.requiresDescription),
        requiereSoporte: Boolean(assignment.requiresEvidence),
        zonaHoraria: assignment.timeZone,
        umbralAlertaDiaria: assignment.dailyWarningHours || 16,
        carga: assignment.commercialAllocation || 0,
        fechaCorte,
        diasParaCorte,
        estadoCorte: diasParaCorte <= 3 ? "Error" : diasParaCorte <= 7 ? "Warning" : "Information",
      };
      })
      .sort((a, b) => Number(b.carga || 0) - Number(a.carga || 0)
        || Number(a.diasParaCorte || 0) - Number(b.diasParaCorte || 0)
        || String(a.proyectoNombre || "").localeCompare(String(b.proyectoNombre || ""), "es"));
  });

  this.on("enviarRecordatoriosCorte", async (req) => {
    const referenceDate = normalizeDate(req.data?.fecha) || todayISOInTimeZone("America/Bogota");
    const tx = cds.tx(req);
    const [projects, breachRows] = await Promise.all([
      tx.run(
        SELECT.from(Projects)
          .columns("ID", "name", "status", "timeEntryCutoffDay", "workCalendar_ID")
          .where({ modality: { "!=": "INTERNAL" } }),
      ),
      tx.run(SELECT.from(TimeEntryCutoffBreaches)),
    ]);
    const breachByKey = new Map(
      breachRows.map((row) => [`${row.assignment_ID}:${row.cutoffDate}`, row]),
    );
    const openCutoffsByProject = new Map();
    const openBreaches = new Set();
    for (const row of breachRows) {
      if (row.status !== "OPEN") continue;
      openBreaches.add(row.ID);
      const cutoffs = openCutoffsByProject.get(row.project_ID) || new Set();
      cutoffs.add(row.cutoffDate);
      openCutoffsByProject.set(row.project_ID, cutoffs);
    }

    const projectCycles = [];
    for (const project of projects) {
      const cycles = cutoffCyclesForDate({
        referenceDate,
        cutoffDay: project.timeEntryCutoffDay || 31,
        projectActive: project.status === "ACTIVE",
        openCutoffs: [...(openCutoffsByProject.get(project.ID) || [])],
      });
      for (const cycle of cycles) projectCycles.push({ project, ...cycle });
    }

    const calendars = await loadCalendars(
      [...new Set(projectCycles.map(({ project }) => project.workCalendar_ID).filter(Boolean))],
    );
    const upcomingByEmployee = new Map();
    const overdueByEmployee = new Map();
    const evaluatedProjects = new Set();
    const now = new Date().toISOString();

    for (const { project, cutoff, phase } of projectCycles) {
      evaluatedProjects.add(project.ID);
      const cycleStart = addDays(previousMonthlyCutoff(cutoff, project.timeEntryCutoffDay || 31), 1);
      const assignments = await tx.run(
        SELECT.from(ProjectAssignments)
          .columns(
            "ID", "status", "employee_ID", "commercialAllocation", "validFrom", "validTo",
            "employee.nombreCompleto as employeeName",
            "employee.correoCorporativo as employeeEmail",
            "employee.estado_codigo as employeeStatus",
          )
          .where({ project_ID: project.ID }),
      );
      const calendar = calendars.get(project.workCalendar_ID);

      for (const assignment of assignments) {
        if (phase === "UPCOMING" && assignment.status !== "ACTIVE") continue;
        const from = assignment.validFrom > cycleStart ? assignment.validFrom : cycleStart;
        // Antes del corte sólo se exigen las horas ya trabajadas. Una vez
        // vencido se compara el ciclo completo contra el cierre definitivo.
        const upperBound = phase === "OVERDUE" ? cutoff : referenceDate;
        const to = assignment.validTo && assignment.validTo < upperBound ? assignment.validTo : upperBound;
        if (from > to) continue;

        let businessDays = 0;
        for (let day = from; day <= to; day = addDays(day, 1)) {
          if (isWorkingDay(calendar, day)) businessDays += 1;
        }
        const expected = businessDays * Number(calendar?.hoursPerDay || 8)
          * (Number(assignment.commercialAllocation ?? 100) / 100);
        const entries = await tx.run(
          SELECT.from(TimeEntries)
            .columns("durationHours", "status")
            .where({ assignment_ID: assignment.ID, workDate: { between: from, and: to } }),
        );
        const actual = entries
          .filter((entry) => !["CANCELLED", "VOIDED"].includes(entry.status))
          .reduce((sum, entry) => sum + Number(entry.durationHours || 0), 0);
        const pending = Math.max(0, expected - actual);
        const breachKey = `${assignment.ID}:${cutoff}`;
        const existingBreach = breachByKey.get(breachKey);

        if (pending <= 0.01) {
          if (existingBreach?.status === "OPEN") {
            await tx.run(
              UPDATE(TimeEntryCutoffBreaches)
                .set({
                  registeredHours: actual,
                  pendingHours: 0,
                  status: "RESOLVED",
                  lastDetectedAt: now,
                  resolvedAt: now,
                })
                .where({ ID: existingBreach.ID }),
            );
            openBreaches.delete(existingBreach.ID);
            existingBreach.status = "RESOLVED";
          }
          continue;
        }

        const canNotify = assignment.employeeStatus === "AC" && Boolean(assignment.employeeEmail);
        if (phase === "OVERDUE") {
          const daysOverdue = Math.max(1, daysBetween(cutoff, referenceDate));
          if (existingBreach) {
            await tx.run(
              UPDATE(TimeEntryCutoffBreaches)
                .set({
                  expectedHours: expected,
                  registeredHours: actual,
                  pendingHours: pending,
                  status: "OPEN",
                  lastDetectedAt: now,
                  resolvedAt: null,
                  maximumDaysOverdue: Math.max(daysOverdue, Number(existingBreach.maximumDaysOverdue || 0)),
                  reminderCount: Number(existingBreach.reminderCount || 0) + (canNotify ? 1 : 0),
                  lastReminderOn: canNotify ? referenceDate : existingBreach.lastReminderOn,
                })
                .where({ ID: existingBreach.ID }),
            );
            openBreaches.add(existingBreach.ID);
            existingBreach.status = "OPEN";
          } else {
            const breachID = cds.utils.uuid();
            const breach = {
              ID: breachID,
              project_ID: project.ID,
              assignment_ID: assignment.ID,
              employee_ID: assignment.employee_ID,
              cycleStart,
              cutoffDate: cutoff,
              expectedHours: expected,
              registeredHours: actual,
              pendingHours: pending,
              status: "OPEN",
              firstDetectedAt: now,
              lastDetectedAt: now,
              maximumDaysOverdue: daysOverdue,
              reminderCount: canNotify ? 1 : 0,
              lastReminderOn: canNotify ? referenceDate : null,
            };
            await tx.run(INSERT.into(TimeEntryCutoffBreaches).entries(breach));
            breachByKey.set(breachKey, breach);
            openBreaches.add(breachID);
          }
        }

        if (!canNotify) continue;
        const destination = phase === "OVERDUE" ? overdueByEmployee : upcomingByEmployee;
        const block = destination.get(assignment.employee_ID) || {
          employeeName: assignment.employeeName,
          employeeEmail: assignment.employeeEmail,
          projects: [],
        };
        block.projects.push({
          name: project.name,
          cutoff,
          actual,
          expected,
          pending,
          daysOverdue: phase === "OVERDUE" ? daysBetween(cutoff, referenceDate) : 0,
        });
        destination.set(assignment.employee_ID, block);
      }
    }

    let created = 0;
    let urgentCreated = 0;
    for (const [employeeID, block] of upcomingByEmployee) {
      const totalPending = block.projects.reduce((sum, item) => sum + item.pending, 0);
      await queueTimeNotification(tx, {
        type: "TIME_ENTRY_CUTOFF",
        recipientID: block.employeeEmail,
        idempotencyKey: `time-cutoff-upcoming:${employeeID}:${referenceDate}`,
        payload: cutoffNotificationPayload(block, totalPending),
      });
      created += 1;
    }
    for (const [employeeID, block] of overdueByEmployee) {
      const totalPending = block.projects.reduce((sum, item) => sum + item.pending, 0);
      await queueTimeNotification(tx, {
        type: "TIME_ENTRY_CUTOFF_OVERDUE",
        recipientID: block.employeeEmail,
        idempotencyKey: `time-cutoff-overdue:${employeeID}:${referenceDate}`,
        payload: cutoffNotificationPayload(block, totalPending, true),
      });
      created += 1;
      urgentCreated += 1;
    }

    const pendingEmployees = new Set([
      ...upcomingByEmployee.keys(),
      ...overdueByEmployee.keys(),
    ]);

    return {
      exito: true,
      fecha: referenceDate,
      proyectosEvaluados: evaluatedProjects.size,
      colaboradoresPendientes: pendingEmployees.size,
      notificacionesCreadas: created,
      notificacionesUrgentes: urgentCreated,
      incumplimientosAbiertos: openBreaches.size,
      mensaje: `Se evaluaron ${evaluatedProjects.size} proyecto(s), se prepararon ${created} recordatorio(s) y ${urgentCreated} fueron urgentes.`,
    };
  });

  this.on("obtenerMisRegistros", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const weekStart = requirePeriodStart(req, req.data?.semanaInicio);
    const weekEnd = periodEnd(weekStart);
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
        "assignment.project.dailyWarningHours as dailyWarningHours",
      )
      .where({
        employee_ID: employee.ID,
        workDate: { between: weekStart, and: weekEnd },
      });

    return Promise.all(entries.map((entry) => enrichEntry(entry, Evidence)));
  });

  this.on("obtenerMisRegistrosMes", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const monthStart = requireDate(req, req.data?.mesInicio, "mesInicio");
    if (!monthStart.endsWith("-01"))
      reject(
        req,
        400,
        "MES_INVALIDO",
        "La fecha del mes debe corresponder al primer día.",
      );
    const monthEnd = addDays(addMonths(monthStart, 1), -1);
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
        "assignment.project.dailyWarningHours as dailyWarningHours",
      )
      .where({
        employee_ID: employee.ID,
        workDate: { between: monthStart, and: monthEnd },
      });
    return Promise.all(entries.map((entry) => enrichEntry(entry, Evidence)));
  });

  this.on("obtenerDiasNoHabiles", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const from = requireDate(req, req.data?.desde, "desde");
    const to = requireDate(req, req.data?.hasta, "hasta");
    if (to < from)
      reject(
        req,
        400,
        "RANGO_FECHAS_INVALIDO",
        "La fecha final no puede ser anterior a la inicial.",
      );
    const assignments = await SELECT.from(ProjectAssignments)
      .columns("project_ID", "validFrom", "validTo", "status", "project.workCalendar_ID as workCalendar_ID")
      .where({ employee_ID: employee.ID, validFrom: { "<=": to } });
    const active = assignments.filter((a) => a.status !== "INACTIVE" && (!a.validTo || a.validTo >= from));
    const calendars = await loadCalendars(active.map((a) => a.workCalendar_ID));
    const days = [];
    for (let value = from; value <= to; value = addDays(value, 1)) {
      const date = new Date(`${value}T00:00:00Z`);
      const day = date.getUTCDay();
      const applicable = active.filter((a) => a.validFrom <= value && (!a.validTo || a.validTo >= value))
        .map((a) => calendars.get(a.workCalendar_ID)).filter(Boolean);
      const holidays = applicable.flatMap((calendar) =>
        (calendar.holidays.get(value) || []).map((holiday) => `${holiday.name} (${calendar.countryCode})`));
      if (holidays.length)
        days.push({
          fecha: value,
          tipo: "HOLIDAY",
          motivo: [...new Set(holidays)].join(" · "),
        });
      else if (applicable.length && applicable.every((calendar) => !isWorkingDay(calendar, value)))
        days.push({
          fecha: value,
          tipo: "WEEKEND",
          motivo: day === 6 ? "Sábado" : day === 0 ? "Domingo" : "Día no laborable",
        });
    }
    return days;
  });

  this.on("obtenerMisCopias", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const rows = await SELECT.from(TimeBulkCopyOperations)
      .where({ employee_ID: employee.ID })
      .orderBy("createdAt desc")
      .limit(20);
    return rows.map(mapCopyOperation);
  });

  this.on("ejecutarCopiaMasiva", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const sourceID = requireUUID(
      req,
      req.data?.registroOrigenID,
      "registroOrigenID",
    );
    const scope = String(req.data?.alcance || "WEEK")
      .trim()
      .toUpperCase();
    if (!new Set(["WEEK", "MONTH"]).has(scope)) {
      reject(
        req,
        400,
        "ALCANCE_COPIA_INVALIDO",
        "El alcance de la copia no es válido.",
      );
    }
    const dates = [
      ...new Set(
        (req.data?.fechas || [])
          .map((row) => normalizeDate(row?.fecha))
          .filter(Boolean),
      ),
    ];
    if (!dates.length || dates.length > 62) {
      reject(
        req,
        400,
        "FECHAS_COPIA_INVALIDAS",
        "Selecciona entre 1 y 62 fechas válidas para copiar.",
      );
    }
    const source = await SELECT.one
      .from(TimeEntries)
      .where({ ID: sourceID, employee_ID: employee.ID });
    if (!source)
      reject(
        req,
        404,
        "REGISTRO_ORIGEN_NO_ENCONTRADO",
        "El registro de origen no existe.",
      );
    if (!new Set(["DRAFT", "RETURNED"]).has(source.status)) {
      reject(
        req,
        409,
        "REGISTRO_ORIGEN_BLOQUEADO",
        "Solo se pueden copiar registros editables.",
      );
    }
    const assignment = await SELECT.one
      .from(ProjectAssignments)
      .columns(
        "ID",
        "employee_ID",
        "validFrom",
        "validTo",
        "status",
        "project_ID",
        "project.status as projectStatus",
        "project.modality as projectModality",
        "project.dailyWarningHours as dailyWarningHours",
      )
      .where({ ID: source.assignment_ID, employee_ID: employee.ID });
    if (
      !assignment ||
      assignment.status !== "ACTIVE" ||
      assignment.projectStatus !== "ACTIVE"
    ) {
      reject(
        req,
        409,
        "ASIGNACION_COPIA_NO_DISPONIBLE",
        "La asignación del registro ya no está disponible.",
      );
    }

    // Una sola consulta para toda la copia, no una por día.
    const billingRules = await loadBillingRules(assignment.project_ID);

    const operationID = cds.utils.uuid();
    const createdItems = [];
    let omitted = 0;
    for (const destinationDate of dates) {
      if (
        destinationDate === source.workDate ||
        !isDateWithin(destinationDate, assignment.validFrom, assignment.validTo)
      ) {
        omitted += 1;
        continue;
      }
      const destinationSheet = await getOrCreateTimesheet({
        assignment,
        employeeID: employee.ID,
        weekStart: periodStart(destinationDate),
        WeeklyTimesheets,
      });
      if (!new Set(["OPEN", "RETURNED"]).has(destinationSheet.status)) {
        omitted += 1;
        continue;
      }
      const sameDay = await SELECT.from(TimeEntries).where({
        employee_ID: employee.ID,
        workDate: destinationDate,
      });
      const duplicate = sameDay.some((entry) => sameCopiedEntry(entry, source));
      if (duplicate) {
        omitted += 1;
        continue;
      }
      const existingHours = sameDay.reduce(
        (sum, entry) => sum + Number(entry.durationHours || 0),
        0,
      );
      const dailyWarning = exceedsDailyWarning(
        existingHours,
        source.durationHours,
        assignment.dailyWarningHours || 16,
      );
      if (dailyWarning && !source.description) {
        omitted += 1;
        continue;
      }
      const entryID = cds.utils.uuid();
      await INSERT.into(TimeEntries).entries({
        ID: entryID,
        timesheet_ID: destinationSheet.ID,
        billingPeriod_ID: null,
        assignment_ID: assignment.ID,
        employee_ID: employee.ID,
        workDate: destinationDate,
        durationHours: source.durationHours,
        requestedType: source.requestedType,
        description: source.description,
        evidenceRequired: source.evidenceRequired,
        approximateStartTime: source.approximateStartTime,
        approximateEndTime: source.approximateEndTime,
        timeZone: source.timeZone,
        priorAuthorization: source.priorAuthorization,
        exceptionalReason: source.exceptionalReason,
        status: "DRAFT",
        dailyHoursWarning: dailyWarning,
        ...classificationFields({
          entry: {
            durationHours: source.durationHours,
            requestedType: source.requestedType,
            // Una copia arranca sin corrección manual: la del original era
            // para ese día concreto y no tiene por qué heredarse.
            treatmentOverride: null,
          },
          assignment,
          rules: billingRules,
        }),
        version: 1,
      });
      createdItems.push({
        ID: cds.utils.uuid(),
        operation_ID: operationID,
        entryID,
        destinationDate,
        createdVersion: 1,
        status: "CREATED",
      });
    }
    const summary = `${createdItems.length} registro(s) creados y ${omitted} omitido(s).`;
    await INSERT.into(TimeBulkCopyOperations).entries({
      ID: operationID,
      employee_ID: employee.ID,
      sourceEntryID: source.ID,
      sourceDate: source.workDate,
      scope,
      status: createdItems.length ? "ACTIVE" : "EMPTY",
      requestedCount: dates.length,
      createdCount: createdItems.length,
      omittedCount: omitted,
      summary,
    });
    if (createdItems.length)
      await INSERT.into(TimeBulkCopyItems).entries(createdItems);
    const saved = await SELECT.one
      .from(TimeBulkCopyOperations)
      .where({ ID: operationID });
    return {
      exito: createdItems.length > 0,
      mensaje: createdItems.length
        ? `Copia completada: ${summary}`
        : `No se creó ningún registro. ${summary}`,
      operacion: mapCopyOperation(saved),
    };
  });

  this.on("deshacerCopiaMasiva", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const operationID = requireUUID(req, req.data?.operacionID, "operacionID");
    const operation = await SELECT.one
      .from(TimeBulkCopyOperations)
      .where({ ID: operationID, employee_ID: employee.ID });
    if (!operation)
      reject(
        req,
        404,
        "COPIA_NO_ENCONTRADA",
        "La operación de copia no existe.",
      );
    if (operation.status !== "ACTIVE")
      reject(
        req,
        409,
        "COPIA_NO_REVERSIBLE",
        "Esta copia ya no se puede deshacer.",
      );
    const items = await SELECT.from(TimeBulkCopyItems).where({
      operation_ID: operationID,
      status: "CREATED",
    });
    const entryIDs = items.map((item) => item.entryID);
    const entries = entryIDs.length
      ? await SELECT.from(TimeEntries)
          .columns("ID", "status", "version")
          .where({ ID: { in: entryIDs }, employee_ID: employee.ID })
      : [];
    const byID = new Map(entries.map((entry) => [entry.ID, entry]));
    const changed = items.filter((item) => {
      const entry = byID.get(item.entryID);
      return (
        entry &&
        (!new Set(["DRAFT", "RETURNED"]).has(entry.status) ||
          Number(entry.version || 1) !== Number(item.createdVersion || 1))
      );
    });
    if (changed.length) {
      reject(
        req,
        409,
        "COPIA_MODIFICADA",
        "No se puede deshacer porque uno o más registros fueron modificados o enviados.",
      );
    }
    if (entries.length)
      await DELETE.from(TimeEntries).where({
        ID: { in: entries.map((entry) => entry.ID) },
        employee_ID: employee.ID,
      });
    const now = new Date().toISOString();
    await UPDATE(TimeBulkCopyItems)
      .set({ status: "REMOVED" })
      .where({ operation_ID: operationID, status: "CREATED" });
    await UPDATE(TimeBulkCopyOperations)
      .set({ status: "UNDONE", undoneAt: now })
      .where({ ID: operationID, employee_ID: employee.ID });
    const saved = await SELECT.one
      .from(TimeBulkCopyOperations)
      .where({ ID: operationID });
    return {
      exito: true,
      mensaje: `Se deshicieron ${entries.length} registro(s) de la copia masiva.`,
      operacion: mapCopyOperation(saved),
    };
  });

  this.on("guardarBorrador", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const input = req.data || {};
    const assignmentID = requireUUID(req, input.asignacionID, "asignacionID");
    const workDate = requireDate(req, input.fecha, "fecha");
    const assignment = await SELECT.one
      .from(ProjectAssignments)
      .columns(
        "ID",
        "employee_ID",
        "validFrom",
        "validTo",
        "status",
        "project_ID",
        "project.status as projectStatus",
        "project.name as projectName",
        "project.modality as projectModality",
        "project.requiresDescription as requiresDescription",
        "project.requiresEvidence as requiresEvidence",
        "project.dailyWarningHours as dailyWarningHours",
        "project.timeZone as projectTimeZone",
      )
      .where({ ID: assignmentID, employee_ID: employee.ID });

    if (
      !assignment ||
      assignment.status !== "ACTIVE" ||
      assignment.projectStatus !== "ACTIVE"
    ) {
      reject(
        req,
        404,
        "ASIGNACION_NO_DISPONIBLE",
        "La asignación no existe o no está activa para el empleado autenticado.",
      );
    }
    if (!isDateWithin(workDate, assignment.validFrom, assignment.validTo)) {
      reject(
        req,
        400,
        "FECHA_FUERA_DE_ASIGNACION",
        "La fecha no pertenece a la vigencia de la asignación.",
        "fecha",
      );
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
      if (!existing)
        reject(
          req,
          404,
          "REGISTRO_NO_ENCONTRADO",
          "El registro no existe o no pertenece al empleado autenticado.",
        );
      if (!new Set(["DRAFT", "RETURNED"]).has(existing.status)) {
        reject(
          req,
          409,
          "REGISTRO_NO_EDITABLE",
          "Solo se pueden editar registros en borrador o devueltos.",
        );
      }
    }

    const weekStart = periodStart(workDate);
    const timesheet = await getOrCreateTimesheet({
      assignment,
      employeeID: employee.ID,
      weekStart,
      WeeklyTimesheets,
    });
    if (!new Set(["OPEN", "RETURNED"]).has(timesheet.status)) {
      reject(
        req,
        409,
        "SEMANA_NO_EDITABLE",
        "La semana ya fue enviada o cerrada.",
      );
    }

    const sameDay = await SELECT.from(TimeEntries)
      .columns("ID", "durationHours", "requestedType", "status", "assignment.project_ID as projectID")
      .where({ employee_ID: employee.ID, workDate });
    const existingRegularHours = sameDay
      .filter((entry) =>
        entry.ID !== existingID &&
        entry.projectID === assignment.project_ID &&
        entry.status !== "VOIDED" &&
        String(entry.requestedType || "REGULAR").toUpperCase() === "REGULAR",
      )
      .reduce((sum, entry) => sum + Number(entry.durationHours || 0), 0);
    const regularTotal = existingRegularHours + canonical.durationHours;
    if (
      canonical.requestedType === "REGULAR" &&
      regularTotal > 8 &&
      !input.confirmarExcesoRegular
    ) {
      reject(
        req,
        409,
        "CONFIRMAR_EXCESO_TIEMPO_REGULAR",
        `Para el día ${formatDateForUser(workDate)} en el proyecto ${assignment.projectName} ya hay ${formatHours(existingRegularHours)} hora(s) regulares registradas. Con este registro serían ${formatHours(regularTotal)} hora(s). Verifica que no sea un duplicado; si corresponde a tiempo adicional, utiliza Hora extra. Confirma si deseas continuar.`,
      );
    }
    const existingHours = sameDay
      .filter((entry) => entry.ID !== existingID && entry.ID !== null && entry.status !== "VOIDED")
      .reduce((sum, entry) => sum + Number(entry.durationHours || 0), 0);
    const dailyWarning = exceedsDailyWarning(
      existingHours,
      canonical.durationHours,
      assignment.dailyWarningHours || 16,
    );
    if (dailyWarning && !canonical.description) {
      reject(
        req,
        400,
        "DESCRIPCION_ALERTA_DIARIA",
        "Al superar el umbral diario debe explicar las actividades realizadas.",
        "descripcion",
      );
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
      // La clasificación se recalcula en cada guardado porque el empleado
      // pudo cambiar el tipo de tiempo. La corrección manual sobrevive:
      // se le pasa la que ya tenía el registro y el clasificador la respeta.
      ...classificationFields({
        entry: {
          durationHours: canonical.durationHours,
          requestedType: canonical.requestedType,
          treatmentOverride: existing ? existing.treatmentOverride : null,
        },
        assignment,
        rules: await loadBillingRules(assignment.project_ID),
      }),
      version: existing ? Number(existing.version || 1) + 1 : 1,
    };
    if (existing)
      await UPDATE(TimeEntries)
        .set(persistence)
        .where({ ID, employee_ID: employee.ID });
    else await INSERT.into(TimeEntries).entries({ ID, ...persistence });

    const saved = await SELECT.one
      .from(TimeEntries)
      .columns(
        "*",
        "assignment.project.name as projectName",
        "assignment.project.dailyWarningHours as dailyWarningHours",
      )
      .where({ ID, employee_ID: employee.ID });
    return {
      exito: true,
      mensaje: "El borrador se guardó correctamente.",
      registro: await enrichEntry(saved, Evidence),
    };
  });

  this.on("enviarSemana", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const weekStart = requirePeriodStart(req, req.data?.semanaInicio);
    const weekEnd = periodEnd(weekStart);
    const sheets = await SELECT.from(WeeklyTimesheets)
      .columns(
        "*",
        "assignment.project_ID as projectID",
        "assignment.project.name as projectName",
      )
      .where({
        employee_ID: employee.ID,
        weekStart,
      });
    if (!sheets.length)
      reject(
        req,
        404,
        "SEMANA_SIN_REGISTROS",
        "No existen registros para enviar en esta semana.",
      );
    if (
      sheets.some((sheet) => !new Set(["OPEN", "RETURNED"]).has(sheet.status))
    ) {
      reject(
        req,
        409,
        "SEMANA_YA_ENVIADA",
        "Una o más hojas de la semana ya fueron enviadas.",
      );
    }

    const projectIDs = [
      ...new Set(sheets.map((sheet) => sheet.projectID).filter(Boolean)),
    ];
    const projects = projectIDs.length
      ? await SELECT.from("sabnez.times.Projects")
          .columns("ID", "name", "approvalScheme")
          .where({ ID: { in: projectIDs } })
      : [];
    const approverRows = projectIDs.length
      ? await SELECT.from(ProjectApprovers)
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
          .where({ project_ID: { in: projectIDs }, active: true })
      : [];
    const validApprovers = approverRows.filter(
      (row) =>
        row.employeeStatus === "AC" &&
        row.employeeEmail &&
        (!row.validFrom || row.validFrom <= weekEnd) &&
        (!row.validTo || row.validTo >= weekStart) &&
        row.employee_ID !== employee.ID,
    );
    const projectByID = new Map(projects.map((project) => [project.ID, project]));
    const routes = new Map();
    for (const sheet of sheets) {
      const project = projectByID.get(sheet.projectID);
      const roles = initialApprovalRoles(project?.approvalScheme);
      const required = project?.approvalScheme === "LEADER_THEN_ADMIN"
        ? ["LEADER", "ADMIN"]
        : roles;
      const missing = required.filter((role) => !validApprovers.some((row) =>
        row.project_ID === sheet.projectID && String(row.approverType || "").toUpperCase() === role,
      ));
      if (missing.length && project?.approvalScheme !== "LEADER_OR_ADMIN") {
        reject(req, 409, "RUTA_APROBACION_INCOMPLETA",
          `No es posible enviar la semana porque ${sheet.projectName || project?.name || "un proyecto"} no tiene completa su ruta: falta ${missing.join(" y ").toLowerCase()}.`);
      }
      const candidates = roles.flatMap((role) => validApprovers.filter((row) =>
        row.project_ID === sheet.projectID && String(row.approverType || "").toUpperCase() === role,
      ));
      const approver = candidates[0];
      if (!approver) {
        reject(req, 409, "APROBADOR_PROYECTO_NO_CONFIGURADO",
          `No es posible enviar la semana porque ${sheet.projectName || project?.name || "un proyecto"} no tiene configurado el aprobador requerido por su esquema (${approvalSchemeLabel(project?.approvalScheme)}).`);
      }
      routes.set(sheet.ID, {
        ID: approver.employee_ID,
        nombreCompleto: approver.employeeName,
        correoCorporativo: approver.employeeEmail,
        role: String(approver.approverType || "").toUpperCase(),
      });
    }

    const entries = await SELECT.from(TimeEntries).where({
      employee_ID: employee.ID,
      workDate: { between: weekStart, and: weekEnd },
      status: { in: ["DRAFT", "RETURNED"] },
    });
    if (!entries.length)
      reject(
        req,
        404,
        "SEMANA_SIN_REGISTROS",
        "No existen borradores para enviar en esta semana.",
      );

    for (const entry of entries) {
      if (!entry.evidenceRequired) continue;
      const evidence = Evidence
        ? await SELECT.from(Evidence).where({ up__ID: entry.ID })
        : [];
      if (!evidence.length)
        reject(
          req,
          400,
          "SOPORTE_REQUERIDO",
          `El registro del ${entry.workDate} requiere al menos un soporte.`,
        );
      if (evidence.some((file) => file.status !== "Clean")) {
        reject(
          req,
          409,
          "SOPORTE_NO_VALIDADO",
          "Todos los soportes deben superar la validación de seguridad antes del envío.",
        );
      }
    }

    const now = new Date().toISOString();
    for (const sheet of sheets) {
      await UPDATE(WeeklyTimesheets)
        .set({
          status: "SUBMITTED",
          submittedAt: now,
          currentApprover_ID: routes.get(sheet.ID).ID,
          version: Number(sheet.version || 1) + 1,
        })
        .where({ ID: sheet.ID, status: sheet.status });
    }
    await UPDATE(TimeEntries)
      .set({ status: "SUBMITTED" })
      .where({
        employee_ID: employee.ID,
        workDate: { between: weekStart, and: weekEnd },
        status: { in: ["DRAFT", "RETURNED"] },
      });
    const uniqueTargets = [...new Set([...routes.values()].map((route) => route.ID))];
    await INSERT.into(WeeklyTimeApprovalEvents).entries(uniqueTargets.map((targetID) => ({
      ID: cds.utils.uuid(),
      employee_ID: employee.ID,
      weekStart,
      type: "TIME_SUBMITTED",
      actorUserID: req.user?.id || employee.correoCorporativo,
      actorEmployee_ID: employee.ID,
      targetEmployee_ID: targetID,
      detail: `Semana enviada con ${entries.length} registros. Las solicitudes se agruparon por aprobador y etapa según cada proyecto.`,
      occurredAt: now,
    })));
    await notifyConfiguredApprovers({
      tx: cds.tx(req),
      sheets,
      employee,
      weekStart,
      weekEnd,
      TimeEntries,
      notificationKey: now,
      routes,
    });
    return {
      exito: true,
      mensaje: "La semana se envió correctamente para revisión.",
      hojaSemanalID: sheets.length === 1 ? sheets[0].ID : null,
      semanaInicio: weekStart,
      semanaFin: weekEnd,
      estado: "SUBMITTED",
      totalRegistros: entries.length,
      totalHoras: entries.reduce(
        (sum, entry) => sum + Number(entry.durationHours || 0),
        0,
      ),
    };
  });

  this.on("obtenerEstadoSemana", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const weekStart = requirePeriodStart(req, req.data?.semanaInicio);
    const sheets = await SELECT.from(WeeklyTimesheets)
      .columns(
        "status",
        "leaderApprovedAt",
        "internallyApprovedAt",
      )
      .where({ employee_ID: employee.ID, weekStart });

    if (!sheets.length) return weekState("OPEN", true, false, "");

    const statuses = [...new Set(sheets.map((sheet) => sheet.status))];
    const editable = sheets.every((sheet) =>
      new Set(["OPEN", "RETURNED"]).has(sheet.status),
    );
    const approved = sheets.some(
      (sheet) => sheet.leaderApprovedAt || sheet.internallyApprovedAt,
    );
    const canWithdraw =
      !approved &&
      sheets.every((sheet) =>
        new Set(["SUBMITTED", "UNDER_REVIEW"]).has(sheet.status),
      );
    const status = statuses.length === 1 ? statuses[0] : "MIXED";
    return weekState(
      status,
      editable,
      canWithdraw,
      editable
        ? ""
        : canWithdraw
          ? "La semana está enviada. Puedes retirarla mientras no haya sido aprobada."
          : "La semana está en un estado no editable.",
    );
  });

  this.on("retirarSemana", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const weekStart = requirePeriodStart(req, req.data?.semanaInicio);
    const weekEnd = periodEnd(weekStart);
    const sheets = await SELECT.from(WeeklyTimesheets)
      .columns(
        "ID",
        "status",
        "version",
        "leaderApprovedAt",
        "internallyApprovedAt",
      )
      .where({ employee_ID: employee.ID, weekStart });

    if (!sheets.length) {
      reject(req, 404, "SEMANA_NO_ENCONTRADA", "No existe una semana enviada para retirar.");
    }
    if (
      sheets.some(
        (sheet) =>
          sheet.leaderApprovedAt ||
          sheet.internallyApprovedAt ||
          !new Set(["SUBMITTED", "UNDER_REVIEW"]).has(sheet.status),
      )
    ) {
      reject(
        req,
        409,
        "SEMANA_NO_RETIRABLE",
        "La semana solo puede retirarse mientras esté enviada o en revisión y todavía no haya sido aprobada.",
      );
    }

    const approvalEvents = await SELECT.from(WeeklyTimeApprovalEvents)
      .columns("ID")
      .where({
        employee_ID: employee.ID,
        weekStart,
        type: { in: ["TIME_LEADER_APPROVED", "TIME_ADMIN_APPROVED"] },
      });
    if (approvalEvents.length) {
      reject(
        req,
        409,
        "SEMANA_YA_APROBADA",
        "La semana ya registra una aprobación y no puede volver a borrador.",
      );
    }

    const entries = await SELECT.from(TimeEntries)
      .columns("ID", "durationHours")
      .where({ timesheet_ID: { in: sheets.map((sheet) => sheet.ID) } });
    const tx = cds.tx(req);
    for (const sheet of sheets) {
      const changed = await tx.run(
        UPDATE(WeeklyTimesheets)
        .set({
          status: "OPEN",
          submittedAt: null,
          currentApprover_ID: null,
          version: Number(sheet.version || 1) + 1,
        })
        .where({
          ID: sheet.ID,
          status: sheet.status,
          leaderApprovedAt: null,
          internallyApprovedAt: null,
        }),
      );
      if (Number(changed) !== 1) {
        reject(
          req,
          409,
          "SEMANA_CAMBIO_DURANTE_RETIRO",
          "La semana cambió de estado mientras se retiraba. Actualiza la pantalla y verifica su aprobación.",
        );
      }
    }
    await tx.run(
      UPDATE(TimeEntries)
        .set({ status: "DRAFT" })
        .where({ timesheet_ID: { in: sheets.map((sheet) => sheet.ID) } }),
    );
    await tx.run(
      INSERT.into(WeeklyTimeApprovalEvents).entries({
        ID: cds.utils.uuid(),
        employee_ID: employee.ID,
        weekStart,
        type: "TIME_SUBMISSION_WITHDRAWN",
        actorUserID: req.user?.id || employee.correoCorporativo,
        actorEmployee_ID: employee.ID,
        targetEmployee_ID: employee.ID,
        detail: `El empleado retiró el envío antes de su aprobación. ${entries.length} registro(s) volvieron a borrador.`,
        occurredAt: new Date().toISOString(),
      }),
    );

    return {
      exito: true,
      mensaje: "La semana volvió a borrador y ya puedes editarla.",
      hojaSemanalID: sheets.length === 1 ? sheets[0].ID : null,
      semanaInicio: weekStart,
      semanaFin: weekEnd,
      estado: "OPEN",
      totalRegistros: entries.length,
      totalHoras: entries.reduce(
        (sum, entry) => sum + Number(entry.durationHours || 0),
        0,
      ),
    };
  });

  this.on("obtenerSoportes", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);

    const registroID = requireUUID(req, req.data?.registroID, "registroID");

    const entry = await SELECT.one.from(TimeEntries).columns("ID").where({
      ID: registroID,
      employee_ID: employee.ID,
    });

    if (!entry) {
      reject(
        req,
        404,
        "REGISTRO_NO_ENCONTRADO",
        "El registro no existe o no pertenece al empleado autenticado.",
      );
    }

    if (!Evidence) {
      return [];
    }

    const supports = await SELECT.from(Evidence)
      .columns("ID", "filename", "mimeType", "status")
      .where({
        up__ID: registroID,
      })
      .orderBy("createdAt desc");

    return supports.map((support) => ({
      ID: support.ID,
      nombreArchivo: support.filename,
      mimeType: support.mimeType,
      estado: support.status,
    }));
  });

  this.on("cargarSoporte", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const { registroID, nombreArchivo, mimeType, contenido } = req.data || {};
    if (!Evidence || !registroID || !nombreArchivo || !contenido) {
      reject(
        req,
        400,
        "SOPORTE_INCOMPLETO",
        "Faltan los datos necesarios para cargar el soporte.",
      );
    }
    const entry = await SELECT.one
      .from(TimeEntries)
      .where({ ID: registroID, employee_ID: employee.ID });
    if (!entry)
      reject(
        req,
        404,
        "REGISTRO_NO_ENCONTRADO",
        "El registro no existe o no pertenece al empleado autenticado.",
      );
    if (!new Set(["DRAFT", "RETURNED"]).has(entry.status)) {
      reject(
        req,
        409,
        "SOPORTES_BLOQUEADOS",
        "Solo se pueden cargar soportes en registros editables.",
      );
    }
    const buffer = await streamToBuffer(contenido);
    if (!buffer.length)
      reject(req, 400, "ARCHIVO_VACIO", "El archivo recibido está vacío.");
    if (buffer.length > 10 * 1024 * 1024)
      reject(
        req,
        413,
        "ARCHIVO_DEMASIADO_GRANDE",
        "El soporte no puede superar 10 MB.",
      );

    const supportID = cds.utils.uuid();
    const safeName = String(nombreArchivo).trim().slice(0, 255);
    const safeMime = String(mimeType || "application/octet-stream")
      .trim()
      .slice(0, 100);
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
      scanResult = await scanner.send("scan", {
        file: Readable.from([buffer]),
      });
    } catch (error) {
      await DELETE.from(Evidence).where({ ID: supportID, up__ID: registroID });
      reject(
        req,
        502,
        "ESCANEO_SOPORTE_FALLIDO",
        "No fue posible validar el archivo con el servicio de seguridad.",
      );
    }
    const infected = Boolean(scanResult?.isMalware);
    await UPDATE(Evidence)
      .set({
        status: infected ? "Infected" : "Clean",
        lastScan: new Date().toISOString(),
        hash: scanResult?.hash || null,
        note: infected
          ? "El servicio de seguridad detectó contenido malicioso."
          : null,
      })
      .where({ ID: supportID, up__ID: registroID });
    if (infected) {
      await DELETE.from(Evidence).where({ ID: supportID, up__ID: registroID });
      reject(
        req,
        422,
        "ARCHIVO_INFECTADO",
        "El soporte fue rechazado por la validación de seguridad.",
      );
    }
    return {
      exito: true,
      mensaje: "El soporte se cargó y validó correctamente.",
      soporteID: supportID,
    };
  });

  this.on("eliminarRegistros", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);
    const IDs = [
      ...new Set(
        (req.data?.registros || []).map((row) => row?.ID).filter(Boolean),
      ),
    ];
    if (!IDs.length)
      reject(
        req,
        400,
        "REGISTROS_NO_SELECCIONADOS",
        "Selecciona al menos un registro para eliminar.",
      );
    const entries = await SELECT.from(TimeEntries)
      .columns("ID", "status")
      .where({ ID: { in: IDs }, employee_ID: employee.ID });
    if (entries.length !== IDs.length)
      reject(
        req,
        404,
        "REGISTRO_NO_ENCONTRADO",
        "Uno o más registros no existen o no pertenecen al empleado autenticado.",
      );
    const locked = entries.filter(
      (entry) => !new Set(["DRAFT", "RETURNED"]).has(entry.status),
    );
    if (locked.length)
      reject(
        req,
        409,
        "REGISTRO_NO_EDITABLE",
        "Solo se pueden eliminar registros en borrador o devueltos.",
      );
    return DELETE.from(TimeEntries).where({
      ID: { in: IDs },
      employee_ID: employee.ID,
    });
  });

  this.on("eliminarSoporte", async (req) => {
    const employee = await getAuthenticatedEmployee(req, Empleados);

    const registroID = requireUUID(req, req.data?.registroID, "registroID");

    const soporteID = requireUUID(req, req.data?.soporteID, "soporteID");

    const entry = await SELECT.one
      .from(TimeEntries)
      .columns("ID", "status")
      .where({
        ID: registroID,
        employee_ID: employee.ID,
      });

    if (!entry) {
      reject(
        req,
        404,
        "REGISTRO_NO_ENCONTRADO",
        "El registro no existe o no pertenece al empleado autenticado.",
      );
    }

    if (!new Set(["DRAFT", "RETURNED"]).has(entry.status)) {
      reject(
        req,
        409,
        "SOPORTES_BLOQUEADOS",
        "Solo se pueden eliminar soportes de registros editables.",
      );
    }

    const support = Evidence
      ? await SELECT.one.from(Evidence).where({
          ID: soporteID,
          up__ID: registroID,
        })
      : null;

    if (!support) {
      reject(
        req,
        404,
        "SOPORTE_NO_ENCONTRADO",
        "El soporte no existe o no pertenece al registro.",
      );
    }

    await DELETE.from(Evidence).where({
      ID: soporteID,
      up__ID: registroID,
    });

    return {
      exito: true,
      mensaje: "El soporte fue eliminado correctamente.",
      soporteID,
    };
  });
});

async function notifyConfiguredApprovers({
  tx,
  sheets,
  employee,
  weekStart,
  weekEnd,
  TimeEntries,
  notificationKey,
  routes,
}) {
  const entries = await SELECT.from(TimeEntries)
    .columns("timesheet_ID", "durationHours", "assignment.project.name as projectName")
    .where({ timesheet_ID: { in: sheets.map((sheet) => sheet.ID) } });
  const blocks = new Map();
  for (const sheet of sheets) {
    const approver = routes.get(sheet.ID);
    if (!blocks.has(approver.ID)) blocks.set(approver.ID, { approver, sheets: [] });
    blocks.get(approver.ID).sheets.push(sheet);
  }
  for (const block of blocks.values()) {
    const ids = new Set(block.sheets.map((sheet) => sheet.ID));
    const ownEntries = entries.filter((entry) => ids.has(entry.timesheet_ID));
    const projectNames = [...new Set(ownEntries.map((entry) => entry.projectName).filter(Boolean))];
    const totalHours = ownEntries.reduce((sum, entry) => sum + Number(entry.durationHours || 0), 0);
    await queueTimeNotification(tx, {
      type: "TIME_SUBMITTED",
      recipientID: block.approver.correoCorporativo,
      idempotencyKey: `time-submit:${employee.ID}:${weekStart}:${notificationKey}:${block.approver.ID}`,
      payload: {
        recipientName: block.approver.nombreCompleto || "Aprobador",
        solicitanteNombre: employee.nombreCompleto,
        hojaID: block.sheets[0].ID,
        titulo: `${weekStart} a ${weekEnd}`,
        resumen: `${totalHours.toFixed(1)} horas · ${projectNames.join(", ")}`,
        facts: [
          { etiqueta: "Empleado", valor: employee.nombreCompleto, orden: 1 },
          { etiqueta: "Proyectos", valor: projectNames.join(", "), orden: 2 },
          { etiqueta: "Total", valor: `${totalHours.toFixed(1)} horas`, orden: 3 },
          { etiqueta: "Semana", valor: `${weekStart} a ${weekEnd}`, orden: 4 },
        ],
      },
    });
  }
}

function initialApprovalRoles(scheme) {
  if (scheme === "ADMIN_ONLY") return ["ADMIN"];
  if (scheme === "LEADER_OR_ADMIN") return ["LEADER", "ADMIN"];
  return ["LEADER"];
}

function approvalSchemeLabel(scheme) {
  return ({
    ADMIN_ONLY: "solo administración",
    LEADER_ONLY: "solo líder",
    LEADER_OR_ADMIN: "líder o administración",
    LEADER_THEN_ADMIN: "líder y luego administración",
  })[scheme] || "líder y luego administración";
}

function formatDateForUser(value) {
  const parts = String(value || "").split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : value;
}

function formatHours(value) {
  return Number(value || 0).toLocaleString("es-CO", { maximumFractionDigits: 2 });
}

async function getOrCreateTimesheet({
  assignment,
  employeeID,
  weekStart,
  WeeklyTimesheets,
}) {
  let sheet = await SELECT.one
    .from(WeeklyTimesheets)
    .where({ assignment_ID: assignment.ID, weekStart });
  if (sheet) return sheet;
  sheet = {
    ID: cds.utils.uuid(),
    assignment_ID: assignment.ID,
    employee_ID: employeeID,
    weekStart,
    weekEnd: periodEnd(weekStart),
    status: "OPEN",
    version: 1,
  };
  await INSERT.into(WeeklyTimesheets).entries(sheet);
  return sheet;
}

async function enrichEntry(entry, Evidence) {
  const count = Evidence
    ? (await SELECT.from(Evidence).columns("ID").where({ up__ID: entry.ID }))
        .length
    : 0;
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
    umbralAlertaDiaria: entry.dailyWarningHours || 16,
  };
}

function sameCopiedEntry(entry, source) {
  return (
    entry.assignment_ID === source.assignment_ID &&
    entry.requestedType === source.requestedType &&
    Number(entry.durationHours || 0) === Number(source.durationHours || 0) &&
    normalizeComparableText(entry.description) ===
      normalizeComparableText(source.description)
  );
}

function normalizeComparableText(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("es-CO")
    .replace(/\s+/g, " ");
}

function mapCopyOperation(row) {
  return {
    ID: row.ID,
    alcance: row.scope,
    estado: row.status,
    fechaOrigen: row.sourceDate,
    solicitados: Number(row.requestedCount || 0),
    creados: Number(row.createdCount || 0),
    omitidos: Number(row.omittedCount || 0),
    resumen: row.summary,
    creadoEn: row.createdAt,
    deshechoEn: row.undoneAt,
    puedeDeshacer: row.status === "ACTIVE" && Number(row.createdCount || 0) > 0,
  };
}

async function getAuthenticatedEmployee(req, Empleados) {
  const email = getAuthenticatedEmail(req);
  const columns = [
    "ID",
    "correoCorporativo",
    "nombreCompleto",
    // Necesarias para el objetivo del mes: quien entró o salió a mitad
    // de periodo no puede registrar el mes entero.
    "fechaIngreso",
    "fechaRetiro",
    "jefeDirecto_ID",
    "jefeDirecto.nombreCompleto as managerName",
    "jefeDirecto.correoCorporativo as managerEmail",
    "jefeDirecto.estado_codigo as managerStatus",
  ];
  let employee = await SELECT.one
    .from(Empleados)
    .columns(...columns)
    .where({ correoCorporativo: email });
  if (!employee) {
    const employees = await SELECT.from(Empleados).columns(...columns);
    employee = employees.find(
      (row) => normalizeEmail(row.correoCorporativo) === email,
    );
  }
  if (!employee)
    reject(
      req,
      403,
      "EMPLEADO_NO_ASOCIADO",
      `No existe un empleado asociado al correo corporativo ${email}.`,
    );
  if (employee.managerStatus !== "AC") employee.managerEmail = null;
  return employee;
}

function getAuthenticatedEmail(req) {
  const value = [
    req.user?.attr?.email,
    req.user?.attr?.mail,
    req.user?.attr?.emailAddress,
    req.user?.id,
  ].find(
    (candidate) => typeof candidate === "string" && candidate.includes("@"),
  );
  if (!value)
    reject(
      req,
      403,
      "CORREO_AUTENTICADO_NO_DISPONIBLE",
      "No fue posible obtener el correo del usuario autenticado.",
    );
  return normalizeEmail(value);
}

function requireUUID(req, value, target) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    reject(
      req,
      400,
      "UUID_INVALIDO",
      `El campo ${target} debe contener un UUID válido.`,
      target,
    );
  }
  return value;
}

function requireDate(req, value, target) {
  const date = normalizeDate(value);
  if (!date)
    reject(
      req,
      400,
      "FECHA_INVALIDA",
      `El campo ${target} debe usar el formato YYYY-MM-DD.`,
      target,
    );
  return date;
}

function requirePeriodStart(req, value) {
  const date = requireDate(req, value, "semanaInicio");
  if (date !== periodStart(date))
    reject(
      req,
      400,
      "PERIODO_INICIO_INVALIDO",
      "El período debe comenzar un lunes o el primer día del mes.",
      "semanaInicio",
    );
  return date;
}

function normalizeDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

function monthStart(value) {
  return `${String(value).slice(0, 7)}-01`;
}

function periodStart(value) {
  const monday = startOfISOWeek(value);
  const first = monthStart(value);
  return monday < first ? first : monday;
}

function periodEnd(value) {
  const sunday = addDays(startOfISOWeek(value), 6);
  const monthEnd = addDays(addMonths(monthStart(value), 1), -1);
  return sunday > monthEnd ? monthEnd : sunday;
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

function cutoffNotificationPayload(block, totalPending, overdue = false) {
  return {
    recipientName: block.employeeName,
    titulo: block.projects.map((item) => item.name).join(", "),
    resumen: overdue
      ? `El periodo ya cerró y tienes ${totalPending.toFixed(1)} horas pendientes en ${block.projects.length} proyecto(s).`
      : `Tienes ${totalPending.toFixed(1)} horas pendientes en ${block.projects.length} proyecto(s).`,
    facts: block.projects.map((item, index) => ({
      etiqueta: item.name,
      valor: overdue
        ? `${item.pending.toFixed(1)} h pendientes · corte vencido ${item.cutoff} · ${item.daysOverdue} día(s) de atraso`
        : `${item.actual.toFixed(1)} de ${item.expected.toFixed(1)} h · corte ${item.cutoff}`,
      orden: index + 1,
      semanticColor: overdue ? "ERROR" : "WARNING",
    })),
  };
}

function isDateWithin(value, from, to) {
  return (!from || value >= from) && (!to || value <= to);
}

function normalizeEmail(value) {
  return typeof value === "string"
    ? value.trim().toLocaleLowerCase("es-CO")
    : "";
}

function normalizeOptionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function weekState(status, editable, canWithdraw, blockedMessage) {
  const labels = {
    OPEN: "Borrador",
    RETURNED: "Devuelta para corrección",
    SUBMITTED: "Enviada",
    UNDER_REVIEW: "En revisión",
    LEADER_APPROVED: "Aprobada por líder",
    INTERNALLY_APPROVED: "Aprobada internamente",
    CLOSED: "Cerrada",
    MIXED: "Estado en transición",
  };
  return {
    estado: status,
    etiqueta: labels[status] || status,
    editable,
    puedeRetirar: canWithdraw,
    mensajeBloqueo: blockedMessage || "",
  };
}

function employeeCalendarCounter({ assignments, projects, calendars }) {
  const projectByID = new Map(projects.map((p) => [p.ID, p]));
  return (from, to) => {
    let total = 0;
    for (let value = from; value <= to; value = addDays(value, 1)) {
      const applicable = assignments
        .filter((a) => a.validFrom <= value && (!a.validTo || a.validTo >= value))
        .map((a) => calendars.get(projectByID.get(a.project_ID)?.workCalendar_ID))
        .filter(Boolean);
      if (applicable.length && applicable.some((calendar) => isWorkingDay(calendar, value))) total += 1;
    }
    return total;
  };
}

function formatMonthLabel(value) {
  const date = new Date(`${value}T00:00:00Z`);
  const label = new Intl.DateTimeFormat("es-CO", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function todayISOInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function reject(req, status, code, message, target) {
  return req.reject({ status, code, message, target });
}
