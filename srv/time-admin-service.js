"use strict";

const cds = require("@sap/cds");
const { Readable } = require("node:stream");
const { streamToBuffer } = require("./lib/stream-utils");
const { entityKey } = require("./lib/entity-key");
const { rateFor, hourlySaleRate } = require("./lib/revenue-accrual");
const {
  seedRulesForProject,
  classifyEntry,
  TIPOS_TIEMPO,
  TRATAMIENTOS,
} = require("./lib/commercial-classification");
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

module.exports = cds.service.impl(function () {
  const ContractDocuments =
    cds.entities("sabnez.times")["ClientContracts.documents"];
  const {
    Clientes,
    Contratos,
    Proyectos,
    Calendarios,
    CiclosReporte,
    Asignaciones,
    Aprobadores,
    Tarifas,
    ReglasFacturacion,
  } = this.entities;

  this.on("miPerfil", (req) => ({
    usuario: req.user?.id || "",
    puedeVerTarifas: req.user?.is?.("TimeFinance") === true,
    puedeReactivarAsignaciones:
      req.user?.is?.("TimeAssignmentReactivate") === true,
  }));

  this.on("obtenerAsignacionesSinTarifa", async () => {
    const TimeEntries = cds.entities("sabnez.times").TimeEntries;
    const [entries, assignments, rates] = await Promise.all([
      SELECT.from(TimeEntries).columns(
        "workDate", "billableHours", "commercialTreatment", "assignment_ID",
      ).where({ billableHours: { ">": 0 } }),
      SELECT.from(Asignaciones).columns(
        "ID", "project_ID",
        "project.name as projectName",
        "employee.nombreCompleto as employeeName",
      ),
      SELECT.from(Tarifas),
    ]);
    const assignmentByID = new Map(assignments.map((row) => [row.ID, row]));
    const continuous = new Set(["INCLUDED_FULL_TIME"]);
    const hourly = new Set(["BILLABLE_REGULAR", "BILLABLE_OVERTIME", "SPECIAL_RATE"]);
    const missing = new Map();

    for (const entry of entries) {
      const treatment = entry.commercialTreatment;
      if (!continuous.has(treatment) && !hourly.has(treatment)) continue;
      const rate = rateFor({ rates, assignmentID: entry.assignment_ID, date: entry.workDate });
      const saleValue = continuous.has(treatment)
        ? Number(rate?.monthlySaleRate || 0)
        : hourlySaleRate(rate, treatment);
      if (saleValue > 0) continue;
      const assignment = assignmentByID.get(entry.assignment_ID);
      if (!assignment) continue;
      const current = missing.get(entry.assignment_ID) || {
        assignmentID: entry.assignment_ID,
        projectID: assignment.project_ID,
        projectName: assignment.projectName || "",
        employeeName: assignment.employeeName || "",
        desde: entry.workDate,
        hasta: entry.workDate,
        horas: 0,
      };
      if (entry.workDate < current.desde) current.desde = entry.workDate;
      if (entry.workDate > current.hasta) current.hasta = entry.workDate;
      current.horas = Math.round((Number(current.horas) + Number(entry.billableHours || 0)) * 100) / 100;
      missing.set(entry.assignment_ID, current);
    }
    return [...missing.values()].sort((a, b) =>
      a.projectName.localeCompare(b.projectName) || a.employeeName.localeCompare(b.employeeName),
    );
  });

  this.on("obtenerDocumentosContrato", async () => {
    const rows = await SELECT.from(ContractDocuments).columns(
      "ID",
      "up__ID",
      "filename",
      "mimeType",
      "status",
    );
    return rows.map((row) => ({
      ID: row.ID,
      contratoID: row.up__ID,
      filename: row.filename,
      mimeType: row.mimeType,
      status: row.status,
    }));
  });

  this.before(["CREATE", "UPDATE"], Clientes, async (req) => {
    let existing;
    if (req.event === "UPDATE") {
      existing = await SELECT.one.from(Clientes).where({ ID: entityKey(req) });
      if (existing?.status === "INACTIVE")
        reject(req, 409, "CLIENTE_INACTIVO", "El cliente está inactivo. Reactívalo antes de modificarlo.");
      rejectManagedClosureFields(req, existing, ["status"]);
    }
    validatePaymentTerm(req);
    normalizeCode(req.data, "countryCode", 2);
    normalizeCode(req.data, "defaultCurrency", 3);
    requireText(req, "legalName", "La razón social es obligatoria.");
    requireText(
      req,
      "taxIdentification",
      "La identificación tributaria es obligatoria.",
    );
    const prefix = String(req.data.projectCodePrefix ?? existing?.projectCodePrefix ?? "")
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}$/.test(prefix)) {
      reject(req, 400, "PREFIJO_PROYECTO_INVALIDO", "El prefijo para proyectos debe contener exactamente tres letras.", "projectCodePrefix");
    }
    if (req.event === "UPDATE" && existing?.projectCodePrefix && prefix !== existing.projectCodePrefix) {
      const project = await SELECT.one.from(Proyectos).columns("ID").where({ client_ID: existing.ID });
      if (project) reject(req, 409, "PREFIJO_EN_USO", "El prefijo no se puede cambiar porque el cliente ya tiene proyectos numerados.", "projectCodePrefix");
    }
    const duplicatePrefix = await SELECT.one.from(Clientes)
      .columns("ID", "legalName")
      .where({ projectCodePrefix: prefix });
    if (duplicatePrefix && duplicatePrefix.ID !== (req.data.ID || req.params?.[0]?.ID)) {
      reject(req, 409, "PREFIJO_DUPLICADO", `El prefijo ${prefix} ya está asignado a ${duplicatePrefix.legalName}.`, "projectCodePrefix");
    }
    req.data.projectCodePrefix = prefix;

    const taxIdentification = req.data.taxIdentification
      ?.trim()
      .toUpperCase();

    if (!taxIdentification) {
      return;
    }

    req.data.taxIdentification = taxIdentification;

    const clientId = req.data.ID || req.params?.[0]?.ID;
    const existingClient = await SELECT.one
      .from(Clientes)
      .columns("ID", "legalName")
      .where({ taxIdentification });

    if (existingClient && existingClient.ID !== clientId) {
      return req.reject(
        409,
        `Ya existe un cliente con la identificación tributaria ${taxIdentification}.`,
      );
    }
  });

  this.before(["CREATE", "UPDATE"], Contratos, async (req) => {
    if (req.event === "UPDATE") {
      const existing = await SELECT.one.from(Contratos).where({ ID: entityKey(req) });
      assertOpenRecord(req, existing, "contrato");
      rejectManagedClosureFields(req, existing, ["validTo", "status"]);
    }
    validatePaymentTerm(req);
    normalizeCode(req.data, "currency", 3);
    validateDateRange(req, "validFrom", "validTo");
    if (req.event === "CREATE")
      await requireExisting(
        req,
        Clientes,
        req.data.client_ID,
        "CLIENTE_NO_EXISTE",
        "El cliente seleccionado no existe.",
      );
  });

  this.before(["CREATE", "UPDATE"], Proyectos, async (req) => {
    let existingProject;
    if (req.event === "UPDATE") {
      existingProject = await SELECT.one.from(Proyectos).where({ ID: entityKey(req) });
      if (existingProject?.status === "CLOSED")
        reject(req, 409, "PROYECTO_CERRADO", "El proyecto está cerrado. Reábrelo antes de modificarlo.");
      rejectManagedClosureFields(req, existingProject, ["validTo", "status"]);
      if (req.data.client_ID && req.data.client_ID !== existingProject?.client_ID)
        reject(req, 409, "CLIENTE_PROYECTO_INMUTABLE", "El cliente de un proyecto existente no se puede cambiar.", "client_ID");
      if (req.data.code && req.data.code !== existingProject?.code)
        reject(req, 409, "CODIGO_PROYECTO_AUTOMATICO", "El código del proyecto es automático y no se puede modificar.", "code");
    }
    normalizeCode(req.data, "currency", 3);
    validateDateRange(req, "validFrom", "validTo");
    validatePositive(req, "dailyWarningHours", true);
    if (req.data.timeEntryCutoffDay != null) {
      const cutoff = Number(req.data.timeEntryCutoffDay);
      if (!Number.isInteger(cutoff) || cutoff < 1 || cutoff > 31)
        reject(req, 400, "CORTE_TIEMPOS_INVALIDO", "El día de corte debe estar entre 1 y 31.", "timeEntryCutoffDay");
      req.data.timeEntryCutoffDay = cutoff;
    } else if (req.event === "CREATE") {
      req.data.timeEntryCutoffDay = 31;
    }
    validatePositive(req, "monthlyBillableTarget", false);
    const calendarID = req.data.workCalendar_ID || existingProject?.workCalendar_ID;
    if (!calendarID)
      reject(req, 400, "CALENDARIO_REQUERIDO", "Selecciona el calendario laboral del proyecto.", "workCalendar_ID");
    await requireExisting(
      req,
      Calendarios,
      calendarID,
      "CALENDARIO_NO_EXISTE",
      "El calendario seleccionado no existe o está inactivo.",
    );
    // El umbral es de horas facturables: en un proyecto interno o de
    // tiempo completo no significa nada y confundiría el objetivo.
    if (
      req.data.monthlyBillableTarget != null &&
      Number(req.data.monthlyBillableTarget) > 0 &&
      req.data.modality &&
      !["HOURLY", "MIXED"].includes(req.data.modality)
    ) {
      reject(
        req,
        400,
        "UMBRAL_SOLO_POR_HORAS",
        "El umbral de horas facturables sólo aplica a proyectos por horas o mixtos.",
        "monthlyBillableTarget",
      );
    }
    if (req.event === "CREATE") {
      const client = await SELECT.one.from(Clientes)
        .columns("ID", "projectCodePrefix", "defaultCurrency")
        .where({ ID: req.data.client_ID });
      if (!client) reject(req, 400, "CLIENTE_NO_EXISTE", "El cliente seleccionado no existe.");
      if (!/^[A-Z]{3}$/.test(client.projectCodePrefix || ""))
        reject(req, 409, "CLIENTE_SIN_PREFIJO", "Configura primero el prefijo de tres letras del cliente.", "client_ID");
      const existingCodes = await SELECT.from(Proyectos).columns("code").where({ client_ID: client.ID });
      const expression = new RegExp(`^${client.projectCodePrefix}(\\d{3})$`);
      const lastNumber = existingCodes.reduce((max, row) => {
        const match = expression.exec(String(row.code || "").toUpperCase());
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0);
      if (lastNumber >= 999)
        reject(req, 409, "NUMERACION_AGOTADA", `El cliente agotó la numeración disponible para el prefijo ${client.projectCodePrefix}.`);
      req.data.code = `${client.projectCodePrefix}${String(lastNumber + 1).padStart(3, "0")}`;
      if (req.data.modality === "INTERNAL") req.data.currency = client.defaultCurrency || "COP";
    }
    const modality = req.data.modality || existingProject?.modality;
    if (modality === "INTERNAL") {
      req.data.contract_ID = null;
      req.data.requiresClientApproval = false;
      req.data.monthlyBillableTarget = null;
    }
    if (req.data.contract_ID && req.data.client_ID) {
      const contract = await SELECT.one
        .from(Contratos)
        .columns("ID", "client_ID")
        .where({ ID: req.data.contract_ID });
      if (!contract || contract.client_ID !== req.data.client_ID) {
        reject(
          req,
          400,
          "CONTRATO_DE_OTRO_CLIENTE",
          "El contrato debe pertenecer al mismo cliente del proyecto.",
          "contract_ID",
        );
      }
    }
  });

  this.before(["CREATE", "UPDATE"], ReglasFacturacion, async (req) => {
    const data = req.data || {};
    const existing = req.event === "UPDATE"
      ? await SELECT.one.from(ReglasFacturacion).columns("ID", "project_ID").where({ ID: entityKey(req) })
      : null;
    await assertProjectOpen(req, Proyectos, data.project_ID || existing?.project_ID);
    const ruleProject = await SELECT.one.from(Proyectos)
      .columns("ID", "modality")
      .where({ ID: data.project_ID || existing?.project_ID });
    if (ruleProject?.modality === "INTERNAL") {
      req.data.treatment = "NON_BILLABLE";
      req.data.billableFactor = 0;
    }
    if (data.requestedType && !TIPOS_TIEMPO.includes(data.requestedType)) {
      reject(
        req,
        400,
        "TIPO_TIEMPO_DESCONOCIDO",
        "El tipo de tiempo no existe.",
        "requestedType",
      );
    }
    if (data.treatment && !TRATAMIENTOS.includes(data.treatment)) {
      reject(
        req,
        400,
        "TRATAMIENTO_DESCONOCIDO",
        "El tratamiento comercial no existe.",
        "treatment",
      );
    }
    if (data.billableFactor != null && Number(data.billableFactor) < 0) {
      reject(
        req,
        400,
        "FACTOR_NEGATIVO",
        "El factor de facturación no puede ser negativo.",
        "billableFactor",
      );
    }
    if (req.event === "CREATE" && data.project_ID) {
      await requireExisting(
        req,
        Proyectos,
        data.project_ID,
        "PROYECTO_NO_EXISTE",
        "El proyecto seleccionado no existe.",
      );
    }
  });

  // Un proyecto nuevo nace con su matriz completa. Si no, el primer
  // registro de tiempo caería en el defecto de la modalidad y nadie
  // sabría por qué quedó clasificado así.
  this.after("CREATE", Proyectos, async (project) => {
    if (!project || !project.ID) return;
    await sembrarReglas(project);
  });

  this.after("UPDATE", Proyectos, async (project) => {
    if (!project?.ID) return;
    const updated = await SELECT.one.from(Proyectos).columns("ID", "modality").where({ ID: project.ID });
    if (updated?.modality !== "INTERNAL") return;
    await UPDATE(ReglasFacturacion)
      .set({ treatment: "NON_BILLABLE", billableFactor: 0 })
      .where({ project_ID: project.ID });
  });

  this.on("sembrarReglasFacturacion", async (req) => {
    const proyectoID = req.data?.proyectoID;
    const project = proyectoID
      ? await SELECT.one
          .from(Proyectos)
          .columns("ID", "modality", "name", "status")
          .where({ ID: proyectoID })
      : null;
    if (!project) {
      reject(
        req,
        404,
        "PROYECTO_NO_EXISTE",
        "El proyecto seleccionado no existe.",
      );
    }
    if (project.status === "CLOSED")
      reject(req, 409, "PROYECTO_CERRADO", "El proyecto está cerrado. Reábrelo antes de completar su clasificación.");
    return completarClasificacion([project]);
  });

  this.on("completarClasificacionComercial", async () => {
    const projects = await SELECT.from(Proyectos).columns(
      "ID",
      "modality",
      "name",
    );
    return completarClasificacion(projects);
  });

  // Sólo agrega lo que falte. Sembrar dos veces no puede pisar una regla
  // que alguien ya corrigió a mano.
  async function sembrarReglas(project) {
    const existentes = await SELECT.from(ReglasFacturacion)
      .columns("requestedType")
      .where({ project_ID: project.ID });
    const yaEstan = new Set(existentes.map((r) => r.requestedType));
    const faltantes = seedRulesForProject(project).filter(
      (r) => !yaEstan.has(r.requestedType),
    );
    if (faltantes.length) await INSERT.into(ReglasFacturacion).entries(faltantes);
    return faltantes.length;
  }

  async function completarClasificacion(projects) {
    const seleccionados = (projects || []).filter((project) => project?.ID);
    let reglasCreadas = 0;
    for (const project of seleccionados) {
      reglasCreadas += await sembrarReglas(project);
    }

    if (!seleccionados.length) {
      return resultadoReglas({ proyectosProcesados: 0, reglasCreadas: 0 });
    }

    const projectIDs = seleccionados.map((project) => project.ID);
    const tarifasHeredadas = await heredarTarifasFaltantes(projectIDs);
    const projectByID = new Map(
      seleccionados.map((project) => [project.ID, project]),
    );
    const rules = await SELECT.from(ReglasFacturacion).where({
      project_ID: { in: projectIDs },
      active: true,
    });
    const rulesByProject = new Map();
    for (const rule of rules) {
      if (!rulesByProject.has(rule.project_ID))
        rulesByProject.set(rule.project_ID, []);
      rulesByProject.get(rule.project_ID).push(rule);
    }

    const TimeEntries = cds.entities("sabnez.times").TimeEntries;
    const assignments = await SELECT.from(Asignaciones)
      .columns("ID")
      .where({ project_ID: { in: projectIDs } });
    const assignmentIDs = assignments.map((assignment) => assignment.ID);
    if (!assignmentIDs.length) {
      return resultadoReglas({
        proyectosProcesados: seleccionados.length,
        reglasCreadas,
        tarifasHeredadas,
      });
    }
    const entries = await SELECT.from(TimeEntries)
      .columns(
        "ID",
        "durationHours",
        "requestedType",
        "status",
        "commercialTreatment",
        "treatmentOverride",
        "assignment.project_ID as projectID",
      )
      .where({
        commercialTreatment: "PENDING",
        assignment_ID: { in: assignmentIDs },
      });

    const closed = new Set(["INVOICED", "VOIDED"]);
    const eligible = entries.filter(
      (entry) => !closed.has(entry.status) && !entry.treatmentOverride,
    );
    let horasFacturables = 0;
    let horasPagables = 0;
    for (const entry of eligible) {
      const project = projectByID.get(entry.projectID);
      const classification = classifyEntry({
        entry,
        project: { ID: project.ID, modality: project.modality },
        rules: rulesByProject.get(project.ID) || [],
      });
      horasFacturables += classification.billableHours;
      horasPagables += classification.payableHours;
      await UPDATE(TimeEntries)
        .set({
          commercialTreatment: classification.commercialTreatment,
          billableHours: classification.billableHours,
          payableHours: classification.payableHours,
        })
        .where({
          ID: entry.ID,
          commercialTreatment: "PENDING",
          treatmentOverride: null,
        });
    }

    return resultadoReglas({
      proyectosProcesados: seleccionados.length,
      reglasCreadas,
      tarifasHeredadas,
      registrosReclasificados: eligible.length,
      registrosOmitidos: entries.length - eligible.length,
      horasFacturables,
      horasPagables,
    });
  }

  function resultadoReglas(values) {
    const redondear = (value) => Math.round(Number(value || 0) * 100) / 100;
    const result = {
      proyectosProcesados: Number(values.proyectosProcesados || 0),
      reglasCreadas: Number(values.reglasCreadas || 0),
      tarifasHeredadas: Number(values.tarifasHeredadas || 0),
      registrosReclasificados: Number(values.registrosReclasificados || 0),
      registrosOmitidos: Number(values.registrosOmitidos || 0),
      horasFacturables: redondear(values.horasFacturables),
      horasPagables: redondear(values.horasPagables),
    };
    const parts = [
      `${result.proyectosProcesados} proyecto(s) procesado(s).`,
      `${result.reglasCreadas} regla(s) creada(s).`,
      `${result.tarifasHeredadas} tarifa(s) heredada(s) en asignaciones que no tenían una.`,
      `${result.registrosReclasificados} registro(s) pendiente(s) reclasificado(s).`,
      `${result.horasFacturables} hora(s) quedaron facturables.`,
      result.registrosOmitidos
        ? `${result.registrosOmitidos} registro(s) protegido(s) fueron omitidos.`
        : null,
    ].filter(Boolean);
    return { exito: true, mensaje: parts.join(" "), ...result };
  }

  async function heredarTarifasFaltantes(projectIDs) {
    if (!projectIDs.length) return 0;
    const assignments = await SELECT.from(Asignaciones)
      .columns("ID", "project_ID", "employee_ID", "validFrom", "validTo")
      .where({ project_ID: { in: projectIDs } });
    if (!assignments.length) return 0;
    const rates = await SELECT.from(Tarifas).where({
      assignment_ID: { in: assignments.map((row) => row.ID) },
    });
    const ratesByAssignment = new Map();
    for (const rate of rates) {
      if (!ratesByAssignment.has(rate.assignment_ID)) ratesByAssignment.set(rate.assignment_ID, []);
      ratesByAssignment.get(rate.assignment_ID).push(rate);
    }
    const ordered = assignments.sort((a, b) =>
      String(a.validFrom || "").localeCompare(String(b.validFrom || "")),
    );
    let created = 0;
    for (const assignment of ordered) {
      if (ratesByAssignment.has(assignment.ID)) continue;
      const previous = ordered
        .filter((candidate) => candidate.ID !== assignment.ID &&
          candidate.project_ID === assignment.project_ID &&
          candidate.employee_ID === assignment.employee_ID &&
          String(candidate.validFrom || "") < String(assignment.validFrom || "") &&
          ratesByAssignment.has(candidate.ID))
        .sort((a, b) => String(b.validFrom || "").localeCompare(String(a.validFrom || "")))[0];
      if (!previous) continue;
      const source = ratesByAssignment.get(previous.ID)
        .sort((a, b) => String(b.validFrom || "").localeCompare(String(a.validFrom || "")))[0];
      const inherited = {
        ID: cds.utils.uuid(), assignment_ID: assignment.ID,
        validFrom: assignment.validFrom, validTo: assignment.validTo || null,
        currency: source.saleCurrency || source.currency,
        saleCurrency: source.saleCurrency || source.currency,
        costCurrency: source.costCurrency || source.currency,
        monthlySaleRate: source.monthlySaleRate,
        regularSaleHourlyRate: source.regularSaleHourlyRate,
        overtimeSaleHourlyRate: source.overtimeSaleHourlyRate,
        internalMonthlyCost: source.internalMonthlyCost,
        internalHourlyCost: source.internalHourlyCost,
        confidential: source.confidential,
      };
      await INSERT.into(Tarifas).entries(inherited);
      ratesByAssignment.set(assignment.ID, [inherited]);
      created += 1;
    }
    return created;
  }

  // --- corrección manual de la facturabilidad ---------------------------
  //
  // Estados en los que un registro ya no se toca: si la factura salió,
  // cambiarle la facturabilidad al registro deja la factura y el sistema
  // contando cosas distintas.
  const ESTADOS_CERRADOS = new Set(["INVOICED", "VOIDED"]);

  this.on("corregirFacturacion", async (req) => {
    const tratamiento = String(req.data?.tratamiento || "").toUpperCase();
    const motivo = String(req.data?.motivo || "").trim();
    if (!TRATAMIENTOS.includes(tratamiento) || tratamiento === "PENDING") {
      reject(
        req,
        400,
        "TRATAMIENTO_DESCONOCIDO",
        "Debe indicar un tratamiento comercial válido.",
        "tratamiento",
      );
    }
    // Sin motivo la corrección es imposible de auditar después, y estos
    // son justo los registros por los que alguien va a preguntar.
    if (motivo.length < 5) {
      reject(
        req,
        400,
        "MOTIVO_REQUERIDO",
        "Explique por qué se corrige la facturabilidad de estos registros.",
        "motivo",
      );
    }
    return aplicarCorreccion(req, { tratamiento, motivo });
  });

  this.on("quitarCorreccionFacturacion", async (req) =>
    aplicarCorreccion(req, { tratamiento: null, motivo: null }),
  );

  async function aplicarCorreccion(req, { tratamiento, motivo }) {
    const ids = [...new Set((req.data?.registroIDs || []).filter(Boolean))];
    if (!ids.length) {
      reject(
        req,
        400,
        "SIN_REGISTROS",
        "Seleccione al menos un registro de tiempo.",
        "registroIDs",
      );
    }

    const times = cds.entities("sabnez.times");
    const TimeEntries = times.TimeEntries;
    const ProjectBillingRules = times.ProjectBillingRules;

    const entries = await SELECT.from(TimeEntries)
      .columns(
        "ID",
        "durationHours",
        "requestedType",
        "status",
        "assignment_ID",
        "assignment.project_ID as projectID",
        "assignment.project.modality as projectModality",
      )
      .where({ ID: { in: ids } });

    const editables = entries.filter((e) => !ESTADOS_CERRADOS.has(e.status));
    const omitidos = ids.length - editables.length;

    // Las reglas de todos los proyectos involucrados, de una sola vez.
    const proyectoIDs = [
      ...new Set(editables.map((e) => e.projectID).filter(Boolean)),
    ];
    const reglas = proyectoIDs.length
      ? await SELECT.from(ProjectBillingRules).where({
          project_ID: { in: proyectoIDs },
          active: true,
        })
      : [];
    const reglasPorProyecto = new Map();
    for (const r of reglas) {
      if (!reglasPorProyecto.has(r.project_ID))
        reglasPorProyecto.set(r.project_ID, []);
      reglasPorProyecto.get(r.project_ID).push(r);
    }

    const ahora = new Date().toISOString();
    const usuario = req.user?.id || "";
    let facturables = 0;
    let pagables = 0;

    for (const entry of editables) {
      const r = classifyEntry({
        entry: {
          durationHours: entry.durationHours,
          requestedType: entry.requestedType,
          treatmentOverride: tratamiento,
        },
        project: { ID: entry.projectID, modality: entry.projectModality },
        rules: reglasPorProyecto.get(entry.projectID) || [],
      });
      facturables += r.billableHours;
      pagables += r.payableHours;
      await UPDATE(TimeEntries)
        .set({
          treatmentOverride: tratamiento,
          overrideReason: motivo,
          overriddenByUserID: tratamiento ? usuario : null,
          overriddenAt: tratamiento ? ahora : null,
          commercialTreatment: r.commercialTreatment,
          billableHours: r.billableHours,
          payableHours: r.payableHours,
        })
        .where({ ID: entry.ID });
    }

    const redondear = (v) => Math.round(v * 100) / 100;
    const porCompensar = redondear(Math.max(0, pagables - facturables));
    const partes = [
      `${editables.length} registro(s) actualizado(s).`,
      porCompensar
        ? `Quedan ${porCompensar} hora(s) reconocidas al recurso que no se le cobran al cliente.`
        : null,
      omitidos
        ? `${omitidos} registro(s) omitido(s) por estar ya facturados o anulados.`
        : null,
    ].filter(Boolean);

    return {
      exito: true,
      mensaje: partes.join(" "),
      registrosActualizados: editables.length,
      registrosOmitidos: omitidos,
      horasFacturables: redondear(facturables),
      horasPagables: redondear(pagables),
      horasPorCompensar: porCompensar,
    };
  }

  this.before(["CREATE", "UPDATE"], CiclosReporte, (req) => {
    for (const field of ["startDay", "endDay"]) validateDayOfMonth(req, field);
    validatePositive(req, "submitBusinessDay", false);
    validatePositive(req, "correctionBusinessDays", false);
    if (req.data.cycleType === "MONTHLY" && req.data.startDay == null)
      req.data.startDay = 1;
  });

  this.before(["CREATE", "UPDATE"], Asignaciones, async (req) => {
    let existing;
    if (req.event === "UPDATE") {
      existing = await SELECT.one.from(Asignaciones).where({ ID: entityKey(req) });
      assertOpenRecord(req, existing, "asignación");
      await assertProjectOpen(req, Proyectos, existing?.project_ID);
      rejectManagedClosureFields(req, existing, ["validTo", "status"]);
    } else {
      await assertProjectOpen(req, Proyectos, req.data.project_ID);
    }
    validateDateRange(req, "validFrom", "validTo");
    validatePositive(req, "commercialAllocation", false);
    const projectID = req.data.project_ID || existing?.project_ID;
    const assignmentProject = await SELECT.one.from(Proyectos)
      .columns("ID", "modality")
      .where({ ID: projectID });
    if (assignmentProject?.modality === "INTERNAL") req.data.reportingCycle_ID = null;
    if (req.data.reportingCycle_ID) {
      const cycle = await SELECT.one
        .from(CiclosReporte)
        .columns("ID", "project_ID", "active")
        .where({ ID: req.data.reportingCycle_ID });
      if (!cycle || cycle.project_ID !== projectID || cycle.active === false)
        reject(
          req,
          400,
          "CICLO_ASIGNACION_INVALIDO",
          "Seleccione un ciclo de facturación activo del mismo proyecto.",
          "reportingCycle_ID",
        );
    }
    if (req.event !== "CREATE") return;
    const [project, employee] = await Promise.all([
      SELECT.one
        .from(Proyectos)
        .columns("ID", "validFrom", "validTo", "lastReopenedOn", "status")
        .where({ ID: req.data.project_ID }),
      SELECT.one
        .from("sabnez.rrhh.Empleados")
        .columns("ID", "fechaIngreso", "fechaRetiro")
        .where({ ID: req.data.employee_ID }),
    ]);
    if (!project)
      reject(
        req,
        400,
        "PROYECTO_NO_EXISTE",
        "El proyecto seleccionado no existe.",
        "project_ID",
      );
    if (!employee)
      reject(
        req,
        400,
        "EMPLEADO_NO_EXISTE",
        "El empleado seleccionado no existe.",
        "employee_ID",
      );
    if (
      !within(req.data.validFrom, project.lastReopenedOn || project.validFrom, project.validTo) ||
      (req.data.validTo &&
        !within(req.data.validTo, project.validFrom, project.validTo))
    ) {
      reject(
        req,
        400,
        "ASIGNACION_FUERA_DE_PROYECTO",
        "La asignación debe estar dentro de la vigencia del proyecto.",
      );
    }
  });

  // Una nueva vigencia del mismo empleado conserva la última condición
  // económica del proyecto. La tarifa se copia a la nueva asignación para
  // mantener intacto el histórico de ambas vigencias.
  this.after("CREATE", Asignaciones, async (created) => {
    if (!created?.ID || !created.project_ID || !created.employee_ID) return;
    const anteriores = await SELECT.from(Asignaciones)
      .columns("ID", "validFrom")
      .where({
        project_ID: created.project_ID,
        employee_ID: created.employee_ID,
        ID: { "!=": created.ID },
      });
    if (!anteriores.length) return;
    const rates = await SELECT.from(Tarifas).where({
      assignment_ID: { in: anteriores.map((row) => row.ID) },
    });
    const ultima = rates.sort((a, b) =>
      String(b.validFrom || "").localeCompare(String(a.validFrom || "")),
    )[0];
    if (!ultima) return;
    await INSERT.into(Tarifas).entries({
      ID: cds.utils.uuid(),
      assignment_ID: created.ID,
      validFrom: created.validFrom,
      validTo: created.validTo || null,
      currency: ultima.saleCurrency || ultima.currency,
      saleCurrency: ultima.saleCurrency || ultima.currency,
      costCurrency: ultima.costCurrency || ultima.currency,
      monthlySaleRate: ultima.monthlySaleRate,
      regularSaleHourlyRate: ultima.regularSaleHourlyRate,
      overtimeSaleHourlyRate: ultima.overtimeSaleHourlyRate,
      internalMonthlyCost: ultima.internalMonthlyCost,
      internalHourlyCost: ultima.internalHourlyCost,
      confidential: ultima.confidential,
    });
  });

  this.before(["CREATE", "UPDATE"], Aprobadores, async (req) => {
    const approverID = entityKey(req);
    const existing =
      req.event === "UPDATE" && approverID
        ? await SELECT.one.from(Aprobadores).where({ ID: approverID })
        : null;
    const candidate = { ...(existing || {}), ...req.data, ID: approverID };
    if (req.event === "UPDATE") {
      if (existing?.active === false) assertOpenRecord(req, existing, "aprobador");
      await assertProjectOpen(req, Proyectos, existing?.project_ID);
      rejectManagedClosureFields(req, existing, ["validTo", "active"]);
    } else {
      await assertProjectOpen(req, Proyectos, candidate.project_ID);
    }
    if (candidate.approverType)
      candidate.approverType = String(candidate.approverType)
        .trim()
        .toUpperCase();
    req.data.approverType = candidate.approverType;
    if (
      candidate.validFrom &&
      candidate.validTo &&
      candidate.validFrom > candidate.validTo
    ) {
      reject(
        req,
        400,
        "RANGO_FECHAS_INVALIDO",
        "La fecha final no puede ser anterior a la fecha inicial.",
        "validTo",
      );
    }
    if (!new Set(["LEADER", "BACKUP", "ADMIN"]).has(candidate.approverType)) {
      reject(
        req,
        400,
        "TIPO_APROBADOR_INVALIDO",
        "El tipo de aprobador seleccionado no es válido.",
        "approverType",
      );
    }
    const employee = await SELECT.one
      .from("sabnez.rrhh.Empleados")
      .columns("ID", "correoCorporativo", "estado_codigo")
      .where({ ID: candidate.employee_ID });
    if (!employee || employee.estado_codigo !== "AC") {
      reject(
        req,
        400,
        "APROBADOR_NO_ACTIVO",
        "El aprobador debe ser un empleado activo.",
        "employee_ID",
      );
    }
    if (!String(employee.correoCorporativo || "").trim()) {
      reject(
        req,
        400,
        "APROBADOR_SIN_CORREO",
        "El aprobador debe tener correo corporativo registrado.",
        "employee_ID",
      );
    }
    const duplicates = await SELECT.from(Aprobadores)
      .columns("ID", "validFrom", "validTo")
      .where({
        project_ID: candidate.project_ID,
        approverType: candidate.approverType,
      });
    const duplicate = duplicates.find(
      (row) =>
        row.ID !== approverID &&
        rangesOverlap(
          candidate.validFrom,
          candidate.validTo,
          row.validFrom,
          row.validTo,
        ),
    );
    if (duplicate) {
      reject(
        req,
        409,
        "APROBADOR_DUPLICADO",
        "El proyecto ya tiene un aprobador para ese rol en un periodo que se cruza. Cierra primero la vigencia anterior.",
      );
    }
  });

  this.before(["CREATE", "UPDATE"], Tarifas, async (req) => {
    const existing = req.event === "UPDATE"
      ? await SELECT.one.from(Tarifas).where({ ID: entityKey(req) })
      : null;
    if (existing) {
      assertOpenRecord(req, existing, "tarifa");
      rejectManagedClosureFields(req, existing, ["validTo"]);
    }
    const assignmentID = req.data.assignment_ID || existing?.assignment_ID;
    const assignment = assignmentID
      ? await SELECT.one.from(Asignaciones).columns(
          "ID", "project_ID", "validFrom", "validTo", "status",
          "project.modality as projectModality",
        ).where({ ID: assignmentID })
      : null;
    if (!assignment)
      reject(req, 400, "ASIGNACION_NO_EXISTE", "La asignación seleccionada no existe.");
    if (assignment.status === "INACTIVE" && req.event === "UPDATE")
      reject(req, 409, "ASIGNACION_CERRADA", "No se puede modificar una tarifa de una asignación cerrada.");
    await assertProjectOpen(req, Proyectos, assignment.project_ID);
    // Una tarifa faltante puede registrarse después del cierre para valorar
    // tiempo histórico. Debe terminar junto con la asignación y permanecer
    // inmutable desde su creación.
    if (req.event === "CREATE" && assignment.status === "INACTIVE") {
      if (!assignment.validTo)
        reject(req, 409, "ASIGNACION_CERRADA_SIN_FECHA", "La asignación cerrada no tiene una fecha final válida.");
      req.data.validTo = assignment.validTo;
    }
    const rateFrom = req.data.validFrom || existing?.validFrom;
    const rateTo = req.data.validTo !== undefined ? req.data.validTo : existing?.validTo;
    if (!within(rateFrom, assignment.validFrom, assignment.validTo) ||
      (rateTo && !within(rateTo, assignment.validFrom, assignment.validTo)))
      reject(req, 400, "TARIFA_FUERA_DE_ASIGNACION", "La tarifa debe quedar dentro de la vigencia de la asignación seleccionada.");
    validateDateRange(req, "validFrom", "validTo");
    normalizeCode(req.data, "currency", 3);
    normalizeCode(req.data, "saleCurrency", 3);
    normalizeCode(req.data, "costCurrency", 3);
    const internalProject = assignment.projectModality === "INTERNAL";
    const saleCurrency = req.data.saleCurrency || existing?.saleCurrency || req.data.currency || existing?.currency;
    const costCurrency = req.data.costCurrency || existing?.costCurrency || req.data.currency || existing?.currency;
    if ((!internalProject && !saleCurrency) || !costCurrency)
      reject(req, 400, "MONEDAS_TARIFA_REQUERIDAS", "Selecciona la moneda de venta y la moneda de costo.");
    req.data.saleCurrency = internalProject ? costCurrency : saleCurrency;
    req.data.costCurrency = costCurrency;
    // Mantiene la lectura de integraciones anteriores durante la transición.
    req.data.currency = internalProject ? costCurrency : saleCurrency;
    if (internalProject) {
      req.data.monthlySaleRate = null;
      req.data.regularSaleHourlyRate = null;
      req.data.overtimeSaleHourlyRate = null;
    }
    for (const field of [
      "monthlySaleRate",
      "regularSaleHourlyRate",
      "overtimeSaleHourlyRate",
      "internalMonthlyCost",
      "internalHourlyCost",
    ]) {
      validatePositive(req, field, false);
    }
  });

  this.before("DELETE", Clientes, async (req) => {
    const ID = req.data.ID;
    const [projects, contracts] = await Promise.all([
      SELECT.one.from(Proyectos).columns("ID").where({ client_ID: ID }),
      SELECT.one.from(Contratos).columns("ID").where({ client_ID: ID }),
    ]);
    if (projects || contracts)
      reject(
        req,
        409,
        "CLIENTE_EN_USO",
        "No se puede eliminar el cliente porque tiene proyectos o contratos asociados.",
      );
  });

  this.before("DELETE", Contratos, async (req) => {
    if (
      await SELECT.one
        .from(Proyectos)
        .columns("ID")
        .where({ contract_ID: req.data.ID })
    ) {
      reject(
        req,
        409,
        "CONTRATO_EN_USO",
        "No se puede eliminar el contrato porque está asociado a un proyecto.",
      );
    }
  });

  this.before("DELETE", Proyectos, async (req) => {
    if (
      await SELECT.one
        .from(Asignaciones)
        .columns("ID")
        .where({ project_ID: req.data.ID })
    ) {
      reject(
        req,
        409,
        "PROYECTO_EN_USO",
        "No se puede eliminar el proyecto porque tiene empleados asignados.",
      );
    }
  });

  this.before("DELETE", Asignaciones, async (req) => {
    if (
      await SELECT.one
        .from("sabnez.times.TimeEntries")
        .columns("ID")
        .where({ assignment_ID: req.data.ID })
    ) {
      reject(
        req,
        409,
        "ASIGNACION_EN_USO",
        "No se puede eliminar la asignación porque ya tiene registros de tiempo.",
      );
    }
  });

  // ------------------------------------------------------------------
  // Bajas explícitas.
  // Las consultas dentro de un handler van directas a la base, así que
  // estas transiciones internas no reentran en los before-handlers de
  // alta: validan lo suyo aquí y nada más.
  // ------------------------------------------------------------------

  this.on("desactivarCliente", async (req) => {
    const cliente = await SELECT.one
      .from(Clientes)
      .columns("ID", "legalName", "tradeName", "status")
      .where({ ID: req.data.clienteID });
    if (!cliente) reject(req, 404, "CLIENTE_NO_EXISTE", "El cliente no existe.");
    if (cliente.status === "INACTIVE")
      return resultado("El cliente ya estaba inactivo.");

    const abiertos = await SELECT.from(Proyectos)
      .columns("ID", "name")
      .where({ client_ID: cliente.ID, status: { in: ["DRAFT", "ACTIVE"] } });
    if (abiertos.length) {
      reject(
        req,
        409,
        "CLIENTE_CON_PROYECTOS_ABIERTOS",
        `No se puede desactivar ${nombre(cliente)}: ${abiertos.length} proyecto(s) siguen abiertos (${listar(abiertos.map((p) => p.name))}). Ciérralos primero.`,
      );
    }

    const contratos = await SELECT.from(Contratos)
      .columns("ID")
      .where({ client_ID: cliente.ID, status: { in: ["DRAFT", "ACTIVE"] } });
    if (contratos.length) {
      await UPDATE(Contratos)
        .set({ status: "INACTIVE" })
        .where({ ID: { in: contratos.map((row) => row.ID) } });
    }
    await UPDATE(Clientes).set({ status: "INACTIVE" }).where({ ID: cliente.ID });

    return resultado(
      `${nombre(cliente)} quedó inactivo.` +
        (contratos.length ? ` Se desactivaron ${contratos.length} contrato(s).` : ""),
      { contratosDesactivados: contratos.length },
    );
  });

  this.on("reactivarCliente", async (req) => {
    const cliente = await SELECT.one
      .from(Clientes)
      .columns("ID", "legalName", "tradeName", "status")
      .where({ ID: req.data.clienteID });
    if (!cliente) reject(req, 404, "CLIENTE_NO_EXISTE", "El cliente no existe.");
    if (cliente.status === "ACTIVE")
      return resultado("El cliente ya estaba activo.");
    await UPDATE(Clientes).set({ status: "ACTIVE" }).where({ ID: cliente.ID });
    return resultado(
      `${nombre(cliente)} vuelve a estar activo. Sus contratos y proyectos siguen como estaban.`,
    );
  });

  this.on("cerrarProyecto", async (req) => {
    const proyecto = await SELECT.one
      .from(Proyectos)
      .columns("ID", "name", "code", "validFrom", "validTo", "status")
      .where({ ID: req.data.proyectoID });
    if (!proyecto) reject(req, 404, "PROYECTO_NO_EXISTE", "El proyecto no existe.");
    if (proyecto.status === "CLOSED")
      return resultado("El proyecto ya estaba cerrado.");

    const fecha = req.data.fechaCierre || hoy();
    if (proyecto.validFrom && fecha < proyecto.validFrom) {
      reject(
        req,
        400,
        "CIERRE_ANTES_DEL_INICIO",
        "La fecha de cierre no puede ser anterior al inicio del proyecto.",
        "fechaCierre",
      );
    }

    const asignaciones = await SELECT.from(Asignaciones)
      .columns("ID", "validFrom", "validTo", "status")
      .where({ project_ID: proyecto.ID });

    // El cierre se bloquea si queda tiempo sin resolver: cerrar aquí
    // dejaría hojas huérfanas que nadie podría aprobar después.
    if (asignaciones.length) {
      const abiertas = await SELECT.from("sabnez.times.WeeklyTimesheets")
        .columns("ID")
        .where({
          assignment_ID: { in: asignaciones.map((row) => row.ID) },
          status: { in: ["OPEN", "SUBMITTED", "UNDER_REVIEW", "RETURNED"] },
        });
      if (abiertas.length) {
        reject(
          req,
          409,
          "PROYECTO_CON_HOJAS_ABIERTAS",
          `No se puede cerrar ${proyecto.name}: hay ${abiertas.length} hoja(s) semanal(es) sin aprobar. Resuélvelas antes de cerrar.`,
        );
      }
    }

    // Cascada: todas las vigencias activas se cierran con la fecha del
    // proyecto. Cerrar una tarifa no elimina su histórico: sólo limita
    // hasta qué día puede utilizarse para valorar tiempo.
    let asignacionesCerradas = 0;
    for (const row of asignaciones) {
      if (row.status === "INACTIVE") continue;
      await UPDATE(Asignaciones)
        .set({ status: "INACTIVE", validTo: finCascada(row, fecha) })
        .where({ ID: row.ID });
      asignacionesCerradas += 1;
    }

    const tarifas = asignaciones.length
      ? await SELECT.from(Tarifas)
        .columns("ID", "validFrom", "validTo")
        .where({ assignment_ID: { in: asignaciones.map((row) => row.ID) } })
      : [];
    for (const row of tarifas.filter((rate) => !rate.validTo || rate.validTo > fecha)) {
      await UPDATE(Tarifas)
        .set({ validTo: finCascada(row, fecha) })
        .where({ ID: row.ID });
    }

    const aprobadores = await SELECT.from(Aprobadores)
      .columns("ID", "validFrom", "validTo", "active")
      .where({ project_ID: proyecto.ID, active: true });
    for (const row of aprobadores) {
      await UPDATE(Aprobadores)
        .set({ active: false, validTo: finCascada(row, fecha) })
        .where({ ID: row.ID });
    }

    await UPDATE(Proyectos)
      .set({ status: "CLOSED", validTo: finCascada(proyecto, fecha) })
      .where({ ID: proyecto.ID });

    return resultado(
      `${proyecto.name} cerrado con fecha ${fecha}. Se cerraron ${asignacionesCerradas} asignación(es), ${aprobadores.length} aprobador(es) y ${tarifas.length} tarifa(s). El histórico se conserva.`,
      {
        asignacionesCerradas,
        aprobadoresCerrados: aprobadores.length,
      },
    );
  });

  this.on("reabrirProyecto", async (req) => {
    const proyecto = await SELECT.one
      .from(Proyectos)
      .columns("ID", "name", "validFrom", "validTo", "status")
      .where({ ID: req.data.proyectoID });
    if (!proyecto) reject(req, 404, "PROYECTO_NO_EXISTE", "El proyecto no existe.");
    if (proyecto.status === "ACTIVE")
      return resultado("El proyecto ya estaba activo.");
    const fecha = req.data.fechaApertura || hoy();
    if (proyecto.validFrom && fecha < proyecto.validFrom)
      reject(req, 400, "APERTURA_ANTES_DEL_INICIO", "La fecha de apertura no puede ser anterior al inicio histórico del proyecto.", "fechaApertura");
    if (proyecto.validTo && fecha <= proyecto.validTo)
      reject(req, 400, "APERTURA_ANTES_DEL_CIERRE", "La fecha de apertura debe ser posterior a la fecha de cierre.", "fechaApertura");
    await UPDATE(Proyectos)
      .set({ status: "ACTIVE", validTo: null, lastReopenedOn: fecha })
      .where({ ID: proyecto.ID });
    return resultado(
      `${proyecto.name} vuelve a estar activo desde ${fecha}. Las asignaciones, tarifas y aprobadores históricos permanecen cerrados; crea nuevas vigencias cuando corresponda.`,
    );
  });

  this.on("finalizarAsignacion", async (req) => {
    const asignacion = await SELECT.one
      .from(Asignaciones)
      .columns("ID", "validFrom", "validTo", "status", "employee_ID", "project_ID")
      .where({ ID: req.data.asignacionID });
    if (!asignacion)
      reject(req, 404, "ASIGNACION_NO_EXISTE", "La asignación no existe.");

    const fecha = req.data.fechaFin || hoy();
    if (asignacion.validFrom && fecha < asignacion.validFrom) {
      reject(
        req,
        400,
        "FIN_ANTES_DEL_INICIO",
        "La fecha final no puede ser anterior al inicio de la asignación.",
        "fechaFin",
      );
    }

    const posteriores = await SELECT.from("sabnez.times.TimeEntries")
      .columns("ID")
      .where({ assignment_ID: asignacion.ID, workDate: { ">": fecha } });
    if (posteriores.length) {
      reject(
        req,
        409,
        "TIEMPOS_POSTERIORES_AL_CIERRE",
        `Hay ${posteriores.length} registro(s) de tiempo posteriores al ${fecha}. Ajusta la fecha final o anula esos registros.`,
        "fechaFin",
      );
    }

    await UPDATE(Asignaciones)
      .set({ status: "INACTIVE", validTo: fecha })
      .where({ ID: asignacion.ID });
    const rates = await SELECT.from(Tarifas)
      .columns("ID", "validFrom", "validTo")
      .where({ assignment_ID: asignacion.ID });
    for (const rate of rates.filter((item) => !item.validTo || item.validTo > fecha)) {
      await UPDATE(Tarifas).set({ validTo: finCascada(rate, fecha) }).where({ ID: rate.ID });
    }
    return resultado(`Asignación finalizada el ${fecha}. Se cerraron ${rates.length} tarifa(s) asociada(s) sin borrar su histórico.`, {
      asignacionesCerradas: 1,
    });
  });

  // Reactivar no modifica la vigencia cerrada: crea una nueva para que la
  // interrupción y las condiciones históricas sigan siendo auditables.
  this.on("reactivarAsignacion", async (req) => {
    const anterior = await SELECT.one
      .from(Asignaciones)
      .columns(
        "ID", "project_ID", "employee_ID", "reportingCycle_ID", "role",
        "validFrom", "validTo", "commercialAllocation", "isPrimary",
        "isBackup", "status",
      )
      .where({ ID: req.data.asignacionID });
    if (!anterior)
      reject(req, 404, "ASIGNACION_NO_EXISTE", "La asignación no existe.");
    if (anterior.status !== "INACTIVE" || !anterior.validTo)
      reject(req, 409, "ASIGNACION_NO_CERRADA", "Solo se puede reactivar una asignación finalizada.");

    const fecha = req.data.fechaApertura || hoy();
    if (fecha <= anterior.validTo)
      reject(req, 400, "REACTIVACION_ANTES_DEL_CIERRE", "La nueva fecha de inicio debe ser posterior al cierre de la asignación anterior.", "fechaApertura");

    const [proyecto, empleado, activas] = await Promise.all([
      SELECT.one.from(Proyectos)
        .columns("ID", "name", "validFrom", "validTo", "lastReopenedOn", "status", "modality")
        .where({ ID: anterior.project_ID }),
      SELECT.one.from("sabnez.rrhh.Empleados")
        .columns("ID", "nombreCompleto", "fechaIngreso", "fechaRetiro", "estado_codigo")
        .where({ ID: anterior.employee_ID }),
      SELECT.from(Asignaciones).columns("ID").where({
        project_ID: anterior.project_ID,
        employee_ID: anterior.employee_ID,
        status: "ACTIVE",
      }),
    ]);
    if (!proyecto || proyecto.status !== "ACTIVE")
      reject(req, 409, "PROYECTO_CERRADO", "El proyecto debe estar activo para reactivar la asignación.");
    if (!within(fecha, proyecto.lastReopenedOn || proyecto.validFrom, proyecto.validTo))
      reject(req, 400, "ASIGNACION_FUERA_DE_PROYECTO", "La nueva vigencia debe estar dentro de la vigencia activa del proyecto.", "fechaApertura");
    if (!empleado || empleado.estado_codigo !== "AC" || !within(fecha, empleado.fechaIngreso, empleado.fechaRetiro))
      reject(req, 409, "EMPLEADO_NO_ACTIVO", "La persona debe estar activa en la fecha de reactivación.", "fechaApertura");
    if (activas.length)
      reject(req, 409, "ASIGNACION_ACTIVA_EXISTENTE", "La persona ya tiene una asignación activa en este proyecto.");

    const nuevaID = cds.utils.uuid();
    await INSERT.into(Asignaciones).entries({
      ID: nuevaID,
      project_ID: anterior.project_ID,
      employee_ID: anterior.employee_ID,
      reportingCycle_ID: proyecto.modality === "INTERNAL" ? null : anterior.reportingCycle_ID,
      role: anterior.role,
      validFrom: fecha,
      validTo: null,
      commercialAllocation: anterior.commercialAllocation,
      isPrimary: anterior.isPrimary,
      isBackup: anterior.isBackup,
      status: "ACTIVE",
    });

    const tarifas = await SELECT.from(Tarifas)
      .where({ assignment_ID: anterior.ID });
    const ultima = tarifas.sort((a, b) =>
      String(b.validFrom || "").localeCompare(String(a.validFrom || "")),
    )[0];
    if (ultima) {
      await INSERT.into(Tarifas).entries({
        ID: cds.utils.uuid(), assignment_ID: nuevaID, validFrom: fecha, validTo: null,
        currency: ultima.saleCurrency || ultima.currency,
        saleCurrency: ultima.saleCurrency || ultima.currency,
        costCurrency: ultima.costCurrency || ultima.currency,
        monthlySaleRate: ultima.monthlySaleRate,
        regularSaleHourlyRate: ultima.regularSaleHourlyRate,
        overtimeSaleHourlyRate: ultima.overtimeSaleHourlyRate,
        internalMonthlyCost: ultima.internalMonthlyCost,
        internalHourlyCost: ultima.internalHourlyCost,
        confidential: ultima.confidential,
      });
    }
    return resultado(
      `Asignación de ${empleado.nombreCompleto || "la persona"} reactivada desde ${fecha}. Se creó una nueva vigencia${ultima ? " con sus condiciones económicas heredadas" : ""} y se conservó el histórico anterior.`,
    );
  });

  this.on("finalizarAprobador", async (req) => {
    const row = await SELECT.one.from(Aprobadores)
      .columns("ID", "project_ID", "validFrom", "validTo", "active")
      .where({ ID: req.data.aprobadorID });
    if (!row) reject(req, 404, "APROBADOR_NO_EXISTE", "El aprobador no existe.");
    if (!row.active) return resultado("El aprobador ya estaba cerrado.");
    const fecha = validateClosingDate(req, row, req.data.fechaFin, "fechaFin");
    await assertProjectOpen(req, Proyectos, row.project_ID);
    await UPDATE(Aprobadores).set({ active: false, validTo: fecha }).where({ ID: row.ID });
    return resultado(`Aprobador cerrado el ${fecha}.`, { aprobadoresCerrados: 1 });
  });

  this.on("finalizarTarifa", async (req) => {
    const row = await SELECT.one.from(Tarifas)
      .columns("ID", "assignment_ID", "validFrom", "validTo")
      .where({ ID: req.data.tarifaID });
    if (!row) reject(req, 404, "TARIFA_NO_EXISTE", "La tarifa no existe.");
    if (row.validTo) return resultado("La tarifa ya estaba cerrada.");
    const assignment = await SELECT.one.from(Asignaciones)
      .columns("ID", "project_ID").where({ ID: row.assignment_ID });
    await assertProjectOpen(req, Proyectos, assignment?.project_ID);
    const fecha = validateClosingDate(req, row, req.data.fechaFin, "fechaFin");
    await UPDATE(Tarifas).set({ validTo: fecha }).where({ ID: row.ID });
    return resultado(`Tarifa cerrada el ${fecha}. El histórico permanece disponible.`);
  });

  this.on("finalizarContrato", async (req) => {
    const row = await SELECT.one.from(Contratos)
      .columns("ID", "reference", "validFrom", "validTo", "status")
      .where({ ID: req.data.contratoID });
    if (!row) reject(req, 404, "CONTRATO_NO_EXISTE", "El contrato no existe.");
    if (row.status === "INACTIVE") return resultado("El contrato ya estaba cerrado.");
    const fecha = validateClosingDate(req, row, req.data.fechaFin, "fechaFin");
    await UPDATE(Contratos).set({ status: "INACTIVE", validTo: fecha }).where({ ID: row.ID });
    return resultado(`Contrato ${row.reference} cerrado el ${fecha}.`);
  });

  this.on("cargarDocumentoContrato", async (req) => {
    const { contratoID, nombreArchivo, mimeType, contenido } = req.data || {};
    if (!contratoID || !nombreArchivo || !contenido)
      reject(
        req,
        400,
        "DOCUMENTO_INCOMPLETO",
        "Faltan los datos del documento.",
      );
    if (
      !(await SELECT.one
        .from(Contratos)
        .columns("ID")
        .where({ ID: contratoID }))
    )
      reject(req, 404, "CONTRATO_NO_EXISTE", "El contrato no existe.");
    const buffer = await streamToBuffer(contenido);
    if (!buffer.length)
      reject(req, 400, "ARCHIVO_VACIO", "El documento está vacío.");
    if (buffer.length > 10 * 1024 * 1024)
      reject(
        req,
        413,
        "ARCHIVO_DEMASIADO_GRANDE",
        "El documento no puede superar 10 MB.",
      );
    const ID = cds.utils.uuid();
    await INSERT.into(ContractDocuments).entries({
      ID,
      up__ID: contratoID,
      filename: String(nombreArchivo).slice(0, 255),
      mimeType: String(mimeType || "application/octet-stream").slice(0, 100),
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
      await DELETE.from(ContractDocuments).where({ ID, up__ID: contratoID });
      reject(
        req,
        502,
        "ESCANEO_DOCUMENTO_FALLIDO",
        "No fue posible validar el documento con el servicio de seguridad.",
      );
    }
    if (scanResult?.isMalware) {
      await DELETE.from(ContractDocuments).where({ ID, up__ID: contratoID });
      reject(
        req,
        422,
        "ARCHIVO_INFECTADO",
        "El documento fue rechazado por la validación de seguridad.",
      );
    }
    await UPDATE(ContractDocuments)
      .set({
        status: "Clean",
        lastScan: new Date().toISOString(),
        hash: scanResult?.hash || null,
      })
      .where({ ID, up__ID: contratoID });
    return {
      exito: true,
      mensaje: "Documento contractual cargado correctamente.",
      documentoID: ID,
    };
  });

  this.on("descargarDocumentoContrato", async (req) => {
    const { contratoID, documentoID } = req.data || {};
    const row = await SELECT.one
      .from(ContractDocuments)
      .columns("filename", "mimeType", "content", "status")
      .where({ ID: documentoID, up__ID: contratoID });
    if (!row)
      reject(req, 404, "DOCUMENTO_NO_ENCONTRADO", "El documento no existe.");
    if (row.status !== "Clean")
      reject(
        req,
        409,
        "DOCUMENTO_NO_VALIDADO",
        "El documento aún no está validado para descarga.",
      );
    const buffer = await streamToBuffer(row.content);
    if (!buffer?.length)
      reject(
        req,
        404,
        "CONTENIDO_NO_DISPONIBLE",
        "El documento no tiene contenido almacenado.",
      );
    return {
      filename: row.filename,
      mimeType: row.mimeType || "application/octet-stream",
      contenidoBase64: buffer.toString("base64"),
    };
  });
});

function hoy() {
  return new Date().toISOString().slice(0, 10);
}

// Cierra en la fecha indicada, salvo que la fila ya terminara antes
// (se respeta) o que nunca llegara a empezar (se cierra en su inicio).
function finCascada(row, fecha) {
  if (row.validTo && row.validTo <= fecha) return row.validTo;
  if (row.validFrom && row.validFrom > fecha) return row.validFrom;
  return fecha;
}

function validateClosingDate(req, row, value, field) {
  const fecha = value || hoy();
  if (row.validFrom && fecha < row.validFrom)
    reject(req, 400, "CIERRE_ANTES_DEL_INICIO", "La fecha de cierre no puede ser anterior a la fecha de inicio.", field);
  return fecha;
}

function assertOpenRecord(req, row, label) {
  if (!row) reject(req, 404, "REGISTRO_NO_EXISTE", `El registro de ${label} no existe.`);
  if (row.status === "CLOSED" || row.status === "INACTIVE" || row.active === false || row.validTo)
    reject(req, 409, "REGISTRO_CERRADO", `La ${label} está cerrada y su histórico no se puede editar.`);
}

async function assertProjectOpen(req, Proyectos, projectID) {
  const project = projectID
    ? await SELECT.one.from(Proyectos).columns("ID", "status").where({ ID: projectID })
    : null;
  if (!project) reject(req, 400, "PROYECTO_NO_EXISTE", "El proyecto no existe.");
  if (project.status === "CLOSED")
    reject(req, 409, "PROYECTO_CERRADO", "El proyecto está cerrado. Reábrelo antes de realizar cambios.");
}

function rejectManagedClosureFields(req, existing, fields) {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(req.data || {}, field) && req.data[field] !== existing?.[field])
      reject(req, 400, "CAMPO_CICLO_VIDA", "La fecha final y el estado sólo se actualizan mediante las acciones de cerrar o reabrir.", field);
  }
}

function nombre(cliente) {
  return cliente.tradeName || cliente.legalName || "El cliente";
}

function listar(nombres) {
  return nombres.slice(0, 3).join(", ") + (nombres.length > 3 ? "…" : "");
}

function resultado(mensaje, extra) {
  return {
    exito: true,
    mensaje,
    asignacionesCerradas: 0,
    aprobadoresCerrados: 0,
    contratosDesactivados: 0,
    ...(extra || {}),
  };
}

async function requireExisting(req, entity, ID, code, message) {
  if (!ID || !(await SELECT.one.from(entity).columns("ID").where({ ID })))
    reject(req, 400, code, message);
}

function requireText(req, field, message) {
  if (field in req.data && !(req.data[field] || "").trim())
    reject(req, 400, "CAMPO_OBLIGATORIO", message, field);
}

function normalizeCode(data, field, maxLength) {
  if (!(field in data) || data[field] == null) return;
  data[field] = String(data[field]).trim().toUpperCase().slice(0, maxLength);
}

function validateDateRange(req, fromField, toField) {
  const from = req.data[fromField];
  const to = req.data[toField];
  if (from && to && from > to)
    reject(
      req,
      400,
      "RANGO_FECHAS_INVALIDO",
      "La fecha final no puede ser anterior a la fecha inicial.",
      toField,
    );
}

function validateDayOfMonth(req, field) {
  if (!(field in req.data) || req.data[field] == null) return;
  const value = Number(req.data[field]);
  if (!Number.isInteger(value) || value < 1 || value > 31)
    reject(
      req,
      400,
      "DIA_MES_INVALIDO",
      "El día del mes debe estar entre 1 y 31.",
      field,
    );
}

function validatePositive(req, field, strictlyPositive) {
  if (!(field in req.data) || req.data[field] == null) return;
  const value = Number(req.data[field]);
  if (!Number.isFinite(value) || (strictlyPositive ? value <= 0 : value < 0))
    reject(
      req,
      400,
      "VALOR_INVALIDO",
      `El campo ${field} contiene un valor inválido.`,
      field,
    );
}

// El plazo de pago es la base de la proyección de caja. Un plazo absurdo
// no rompe nada hoy pero desplaza el ingreso de un mes a otro sin que
// nadie se dé cuenta, así que mejor atajarlo acá.
function validatePaymentTerm(req) {
  if (!("paymentTermDays" in req.data) || req.data.paymentTermDays == null)
    return;
  const dias = Number(req.data.paymentTermDays);
  if (!Number.isInteger(dias) || dias < 0 || dias > 365)
    reject(
      req,
      400,
      "PLAZO_PAGO_INVALIDO",
      "El plazo de pago debe estar entre 0 y 365 días.",
      "paymentTermDays",
    );
}

function within(value, from, to) {
  return (!from || value >= from) && (!to || value <= to);
}

function rangesOverlap(fromA, toA, fromB, toB) {
  const maxDate = "9999-12-31";
  return (
    (fromA || "0001-01-01") <= (toB || maxDate) &&
    (fromB || "0001-01-01") <= (toA || maxDate)
  );
}

function reject(req, status, code, message, target) {
  return req.reject({ status, code, message, target });
}
