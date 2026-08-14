const cds = require("@sap/cds");
const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");
const JSZip = require("jszip");
const {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  TextRun,
} = require("docx");
const { streamToBuffer } = require("./lib/stream-utils");

const { SELECT } = cds.ql;

module.exports = cds.service.impl(function () {
  const { TimeDetails } = this.entities;
  const times = cds.entities("sabnez.times");
  const {
    Clients,
    Projects,
    ProjectAssignments,
    AssignmentRates,
    TimeEntries,
  } = times;
  const Evidence = times["TimeEntries.evidence"];

  this.on("getDashboardSummary", async (req) => {
    const {
      dateFrom,
      dateTo,
      clientIDsJson,
      projectIDsJson,
      employeeIDsJson,
      statusIDsJson,
    } = req.data;

    const parseIDs = (value) => {
      if (!value) {
        return [];
      }

      try {
        const parsed = JSON.parse(value);

        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
      } catch (error) {
        req.reject(
          400,
          "Los criterios del reporte tienen un formato inválido.",
        );
      }
    };

    const clientIDs = parseIDs(clientIDsJson);
    const projectIDs = parseIDs(projectIDsJson);
    const employeeIDs = parseIDs(employeeIDsJson);
    const statusIDs = parseIDs(statusIDsJson);

    if (!dateFrom || !dateTo) {
      return req.reject(400, "El periodo desde y hasta es obligatorio.");
    }

    if (dateFrom > dateTo) {
      return req.reject(
        400,
        "La fecha inicial no puede ser posterior a la fecha final.",
      );
    }

    let query = SELECT.from(TimeDetails).columns(
      "employee_ID",
      "project_ID",
      "client_ID",
      "registeredHours",
      "billableHours",
      "entryStatus",
    ).where`workDate >= ${dateFrom} and workDate <= ${dateTo}`;

    if (clientIDs.length > 0) {
      query = query.and({
        client_ID: {
          in: clientIDs,
        },
      });
    }

    if (projectIDs.length > 0) {
      query = query.and({
        project_ID: {
          in: projectIDs,
        },
      });
    }

    if (employeeIDs.length > 0) {
      query = query.and({
        employee_ID: {
          in: employeeIDs,
        },
      });
    }

    if (statusIDs.length > 0) {
      query = query.and({
        entryStatus: {
          in: statusIDs,
        },
      });
    }

    const rows = await cds.run(query);

    const approvedStatuses = new Set([
      "LEADER_APPROVED",
      "INTERNALLY_APPROVED",
      "CLOSED",
      "INVOICED",
    ]);

    const employees = new Set();
    const projects = new Set();
    const clients = new Set();

    let totalHours = 0;
    let billableHours = 0;
    let approvedHours = 0;
    let pendingHours = 0;

    for (const row of rows) {
      const registered = Number(row.registeredHours || 0);
      const billable = Number(row.billableHours || 0);

      totalHours += registered;
      billableHours += billable;

      if (approvedStatuses.has(row.entryStatus)) {
        approvedHours += registered;
      } else {
        pendingHours += registered;
      }

      if (row.employee_ID) {
        employees.add(row.employee_ID);
      }

      if (row.project_ID) {
        projects.add(row.project_ID);
      }

      if (row.client_ID) {
        clients.add(row.client_ID);
      }
    }

    return {
      totalHours: Number(totalHours.toFixed(2)),
      billableHours: Number(billableHours.toFixed(2)),
      approvedHours: Number(approvedHours.toFixed(2)),
      pendingHours: Number(pendingHours.toFixed(2)),
      employeeCount: employees.size,
      projectCount: projects.size,
      clientCount: clients.size,
      entryCount: rows.length,
    };
  });

  this.on("getDashboardAnalytics", async (req) => {
    const {
      dateFrom,
      dateTo,
      clientIDsJson,
      projectIDsJson,
      employeeIDsJson,
      statusIDsJson,
    } = req.data;

    if (!dateFrom || !dateTo) {
      return req.reject(400, "El periodo desde y hasta es obligatorio.");
    }

    if (dateFrom > dateTo) {
      return req.reject(
        400,
        "La fecha inicial no puede ser posterior a la fecha final.",
      );
    }

    const parseIDs = (value) => {
      if (!value) {
        return [];
      }

      try {
        const parsed = JSON.parse(value);

        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
      } catch (error) {
        req.reject(
          400,
          "Los criterios del reporte tienen un formato inválido.",
        );
      }
    };

    const clientIDs = parseIDs(clientIDsJson);
    const projectIDs = parseIDs(projectIDsJson);
    const employeeIDs = parseIDs(employeeIDsJson);
    const statusIDs = parseIDs(statusIDsJson);

    let query = SELECT.from(TimeDetails).columns(
      "workDate",
      "employee_ID",
      "employeeName",
      "project_ID",
      "projectCode",
      "projectName",
      "client_ID",
      "clientName",
      "registeredHours",
      "billableHours",
      "entryStatus",
      "entryStatusText",
    ).where`workDate >= ${dateFrom} and workDate <= ${dateTo}`;

    if (clientIDs.length > 0) {
      query = query.and({
        client_ID: {
          in: clientIDs,
        },
      });
    }

    if (projectIDs.length > 0) {
      query = query.and({
        project_ID: {
          in: projectIDs,
        },
      });
    }

    if (employeeIDs.length > 0) {
      query = query.and({
        employee_ID: {
          in: employeeIDs,
        },
      });
    }

    if (statusIDs.length > 0) {
      query = query.and({
        entryStatus: {
          in: statusIDs,
        },
      });
    }

    const rows = await cds.run(query);

    const byClient = new Map();
    const byProject = new Map();
    const byEmployee = new Map();
    const byStatus = new Map();
    const byDay = new Map();

    let totalHours = 0;
    let billableHours = 0;

    const addHours = (map, key, initialData, registered, billable) => {
      if (!key) {
        return;
      }

      const current = map.get(key) || {
        ...initialData,
        registeredHours: 0,
        billableHours: 0,
      };

      current.registeredHours += registered;
      current.billableHours += billable;

      map.set(key, current);
    };

    for (const row of rows) {
      const registered = Number(row.registeredHours || 0);

      const billable = Number(row.billableHours || 0);

      totalHours += registered;
      billableHours += billable;

      addHours(
        byClient,
        row.client_ID,
        {
          id: row.client_ID,
          name: row.clientName || "Sin cliente",
        },
        registered,
        billable,
      );

      addHours(
        byProject,
        row.project_ID,
        {
          id: row.project_ID,
          code: row.projectCode || "",
          name: row.projectName || "Sin proyecto",
          clientName: row.clientName || "",
        },
        registered,
        billable,
      );

      addHours(
        byEmployee,
        row.employee_ID,
        {
          id: row.employee_ID,
          name: row.employeeName || "Sin empleado",
        },
        registered,
        billable,
      );

      addHours(
        byStatus,
        row.entryStatus || "UNDEFINED",
        {
          id: row.entryStatus || "UNDEFINED",
          name: row.entryStatusText || row.entryStatus || "Sin estado",
        },
        registered,
        billable,
      );

      addHours(
        byDay,
        row.workDate,
        {
          date: row.workDate,
        },
        registered,
        billable,
      );
    }

    const round = (value) => Number(Number(value || 0).toFixed(2));

    const normalize = (map) =>
      Array.from(map.values()).map((item) => ({
        ...item,
        registeredHours: round(item.registeredHours),
        billableHours: round(item.billableHours),
      }));

    const sortDescending = (items) =>
      items.sort((a, b) => b.registeredHours - a.registeredHours);

    const analytics = {
      summary: {
        totalHours: round(totalHours),
        billableHours: round(billableHours),

        billablePercentage:
          totalHours > 0 ? round((billableHours / totalHours) * 100) : 0,
      },

      byClient: sortDescending(normalize(byClient)),

      byProject: sortDescending(normalize(byProject)),

      byEmployee: sortDescending(normalize(byEmployee)),

      byStatus: sortDescending(normalize(byStatus)),

      byDay: normalize(byDay).sort((a, b) =>
        String(a.date).localeCompare(String(b.date)),
      ),
    };

    return {
      dataJson: JSON.stringify(analytics),
    };
  });

  this.on("getCurrentUserPermissions", (req) => {
    return {
      canGenerateDeliverables: req.user.is("TimeDeliverables"),
    };
  });

  this.before("generateDeliverable", (req) => {
    if (!req.user.is("TimeDeliverables")) {
      return req.reject(403, "No tiene permisos para generar entregables.");
    }
  });

  this.on("generateDeliverable", async (req) => {
    const {
      dateFrom,
      dateTo,
      clientID,
      projectIDsJson,
      formatType,
      includeEvidence,
    } = req.data || {};

    if (!dateFrom || !dateTo) {
      return req.reject(400, "El periodo desde y hasta es obligatorio.");
    }
    if (dateFrom > dateTo) {
      return req.reject(
        400,
        "La fecha inicial no puede ser posterior a la fecha final.",
      );
    }
    if (!clientID) {
      return req.reject(400, "Seleccione el cliente del entregable.");
    }

    let projectIDs;
    try {
      const parsed = JSON.parse(projectIDsJson || "[]");
      projectIDs = Array.isArray(parsed)
        ? [...new Set(parsed.filter(Boolean))]
        : [];
    } catch (error) {
      return req.reject(
        400,
        "La selección de proyectos tiene un formato inválido.",
      );
    }
    if (!projectIDs.length) {
      return req.reject(400, "Seleccione al menos un proyecto.");
    }

    const normalizedType = String(formatType || "").toUpperCase();
    if (!new Set(["SUMMARY", "DETAILED"]).has(normalizedType)) {
      return req.reject(400, "El tipo de entregable no es válido.");
    }
    if (normalizedType !== "DETAILED" && includeEvidence) {
      return req.reject(
        400,
        "Las evidencias solo aplican al reporte detallado.",
      );
    }

    const client = await SELECT.one
      .from(Clients)
      .columns("ID", "legalName", "tradeName", "status")
      .where({ ID: clientID });

    if (!client) {
      return req.reject(404, "El cliente seleccionado no existe.");
    }

    const projects = await SELECT.from(Projects)
      .columns("ID", "code", "name", "client_ID", "modality", "status")
      .where({ ID: { in: projectIDs } });

    if (projects.length !== projectIDs.length) {
      return req.reject(404, "Uno o más proyectos seleccionados no existen.");
    }
    const foreignProject = projects.find(
      (project) => project.client_ID !== clientID,
    );
    if (foreignProject) {
      return req.reject(
        400,
        "Todos los proyectos deben pertenecer al cliente seleccionado.",
      );
    }

    const selectedAssignments = await SELECT.from(ProjectAssignments)
      .columns("ID", "project_ID")
      .where({ project_ID: { in: projectIDs } });
    const selectedAssignmentIDs = selectedAssignments.map(
      (assignment) => assignment.ID,
    );

    if (!selectedAssignmentIDs.length) {
      return req.reject(
        404,
        "Los proyectos seleccionados no tienen asignaciones configuradas.",
      );
    }

    let entriesQuery = SELECT.from(TimeEntries).columns(
      "ID",
      "workDate",
      "durationHours",
      "billableHours",
      "requestedType",
      "description",
      "approximateStartTime",
      "approximateEndTime",
      "commercialTreatment",
      "status",
      "employee_ID",
      "employee.nombreCompleto as employeeName",
      "assignment_ID",
      "assignment.role as assignmentRole",
      "assignment.validFrom as assignmentValidFrom",
      "assignment.validTo as assignmentValidTo",
      "assignment.project.ID as project_ID",
      "assignment.project.code as projectCode",
      "assignment.project.name as projectName",
    ).where`workDate >= ${dateFrom} and workDate <= ${dateTo}`;
    entriesQuery = entriesQuery.and({
      assignment_ID: { in: selectedAssignmentIDs },
    });
    const entries = await entriesQuery;

    const filteredEntries = entries
      .filter((entry) => entry.status !== "VOIDED")
      .sort(compareEntries);

    if (!filteredEntries.length) {
      return req.reject(
        404,
        "No existen registros de tiempo para el periodo y los proyectos seleccionados.",
      );
    }

    let workbookBuffer;
    let fileName;
    let mimeType;
    let evidenceCount = 0;
    let warningText = buildStatusWarning(filteredEntries);

    if (normalizedType === "SUMMARY") {
      const assignmentIDs = [
        ...new Set(
          filteredEntries.map((entry) => entry.assignment_ID).filter(Boolean),
        ),
      ];
      const [assignments, rates] = await Promise.all([
        assignmentIDs.length
          ? SELECT.from(ProjectAssignments)
              .columns(
                "ID",
                "project_ID",
                "employee_ID",
                "employee.nombreCompleto as employeeName",
                "validFrom",
                "validTo",
              )
              .where({ ID: { in: assignmentIDs } })
          : [],
        assignmentIDs.length
          ? SELECT.from(AssignmentRates)
              .columns(
                "ID",
                "assignment_ID",
                "validFrom",
                "validTo",
                "currency",
                "monthlySaleRate",
                "regularSaleHourlyRate",
                "overtimeSaleHourlyRate",
              )
              .where({ assignment_ID: { in: assignmentIDs } })
          : [],
      ]);

      workbookBuffer = await buildSummaryWorkbook({
        client,
        projects,
        entries: filteredEntries,
        assignments,
        rates,
        dateFrom,
        dateTo,
      });
      fileName = `Reporte_Resumen_${safeFilePart(client.legalName)}_${dateFrom}_${dateTo}.xlsx`;
      mimeType =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    } else {
      workbookBuffer = await buildDetailedWorkbook({
        client,
        projects,
        entries: filteredEntries,
        dateFrom,
        dateTo,
      });
      fileName = `Reporte_Detallado_${safeFilePart(client.legalName)}_${dateFrom}_${dateTo}.xlsx`;
      mimeType =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

      if (includeEvidence) {
        if (!Evidence) {
          return req.reject(
            500,
            "El repositorio de evidencias no está disponible.",
          );
        }

        const entryIDs = filteredEntries.map((entry) => entry.ID);
        const evidenceRows = await SELECT.from(Evidence)
          .columns("ID", "up__ID", "filename", "mimeType", "content", "status")
          .where({ up__ID: { in: entryIDs }, status: "Clean" });

        const evidenceFiles = [];
        for (const row of evidenceRows) {
          const buffer = await streamToBuffer(row.content);
          if (!buffer.length) continue;
          evidenceFiles.push({ ...row, buffer });
        }

        evidenceCount = evidenceFiles.length;
        if (!evidenceCount) {
          return req.reject(
            409,
            "No se encontraron evidencias limpias para los registros seleccionados. Genere el reporte detallado sin evidencias o cargue primero los soportes.",
          );
        }

        const evidenceDocx = await buildEvidenceDocument({
          client,
          projects,
          entries: filteredEntries,
          evidenceFiles,
          dateFrom,
          dateTo,
        });

        const zip = new JSZip();
        zip.file(fileName, workbookBuffer);
        zip.file(
          `Reporte_Evidencias_${safeFilePart(client.legalName)}_${dateFrom}_${dateTo}.docx`,
          evidenceDocx,
        );

        let additionalIndex = 0;
        for (const evidence of evidenceFiles) {
          if (isEmbeddableImage(evidence.mimeType, evidence.filename)) continue;
          additionalIndex += 1;
          zip.file(
            `Evidencias_adicionales/${String(additionalIndex).padStart(3, "0")}_${safeFilePart(evidence.filename || "evidencia")}`,
            evidence.buffer,
          );
        }

        workbookBuffer = await zip.generateAsync({
          type: "nodebuffer",
          compression: "DEFLATE",
        });
        fileName = `Entregable_Detallado_${safeFilePart(client.legalName)}_${dateFrom}_${dateTo}.zip`;
        mimeType = "application/zip";
      }
    }

    return {
      fileName,
      mimeType,
      contentBase64: Buffer.from(workbookBuffer).toString("base64"),
      entryCount: filteredEntries.length,
      evidenceCount,
      warningText,
    };
  });
});

const BRAND = {
  companyName: process.env.REPORT_BRAND_COMPANY || "Sabnez Consulting SAS",
  primaryColor: normalizeHex(
    process.env.REPORT_BRAND_PRIMARY_COLOR || "1E6FD9",
  ),
  secondaryColor: normalizeHex(
    process.env.REPORT_BRAND_SECONDARY_COLOR || "0B2347",
  ),
  accentColor: normalizeHex(process.env.REPORT_BRAND_ACCENT_COLOR || "EAF3FF"),
  footerText:
    process.env.REPORT_BRAND_FOOTER ||
    "Documento generado desde la plataforma de gestión de tiempos de Sabnez Consulting.",
  logoPath:
    process.env.REPORT_BRAND_LOGO_PATH ||
    path.join(__dirname, "assets", "sabnez-logo.png"),
};

function normalizeHex(value) {
  return String(value || "")
    .replace(/^#/, "")
    .toUpperCase();
}

function safeFilePart(value) {
  return (
    String(value || "archivo")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "archivo"
  );
}

function safeSheetName(value, used) {
  const base =
    String(value || "Reporte")
      .replace(/[\\/*?:\[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 31) || "Reporte";
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    const suffix = ` ${index++}`;
    candidate = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function compareEntries(a, b) {
  return (
    String(a.projectName || "").localeCompare(
      String(b.projectName || ""),
      "es",
    ) ||
    String(a.employeeName || "").localeCompare(
      String(b.employeeName || ""),
      "es",
    ) ||
    String(a.workDate || "").localeCompare(String(b.workDate || "")) ||
    String(a.approximateStartTime || "").localeCompare(
      String(b.approximateStartTime || ""),
    )
  );
}

function buildStatusWarning(entries) {
  const clientReady = new Set([
    "LEADER_APPROVED",
    "INTERNALLY_APPROVED",
    "CLOSED",
    "INVOICED",
  ]);
  const pending = entries.filter((entry) => !clientReady.has(entry.status));
  if (!pending.length) return "";
  return `El archivo incluye ${pending.length} registro(s) que todavía no están aprobados o cerrados.`;
}

function parseDate(value) {
  const parts = String(value || "")
    .slice(0, 10)
    .split("-")
    .map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part)))
    return null;
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
}

function formatDateEs(value, withWeekday = false) {
  const date = parseDate(value);
  if (!date) return String(value || "");
  return new Intl.DateTimeFormat("es-CO", {
    weekday: withWeekday ? "long" : undefined,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatMonthYear(value) {
  const date = parseDate(value);
  if (!date) return "";
  const text = new Intl.DateTimeFormat("es-CO", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatTime(value) {
  const text = String(value || "").slice(0, 8);
  if (!text) return "";
  const [hour, minute] = text.split(":");
  return hour && minute ? `${hour}:${minute}` : text;
}

function requestedCategory(value) {
  const map = {
    REGULAR: "Estándar",
    OVERTIME: "Hora extra",
    NIGHT: "Nocturno",
    SUNDAY: "Dominical",
    HOLIDAY: "Festivo",
    COMPENSATORY: "Compensatorio",
    FLEX_INCLUDED: "Modalidad flexible",
  };
  return map[value] || value || "Estándar";
}

function periodText(dateFrom, dateTo) {
  return `${formatDateEs(dateFrom)} - ${formatDateEs(dateTo)}`;
}

function excelBorder(color = "D9E2EC") {
  return {
    top: { style: "thin", color: { argb: `FF${color}` } },
    left: { style: "thin", color: { argb: `FF${color}` } },
    bottom: { style: "thin", color: { argb: `FF${color}` } },
    right: { style: "thin", color: { argb: `FF${color}` } },
  };
}

function applyWorkbookMetadata(workbook, title) {
  workbook.creator = BRAND.companyName;
  workbook.lastModifiedBy = BRAND.companyName;
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = title;
  workbook.company = BRAND.companyName;
}

function addExcelBrandHeader(workbook, sheet, title, subtitle, lastColumn) {
  sheet.mergeCells(`A1:${lastColumn}1`);
  const titleCell = sheet.getCell("A1");
  titleCell.value = title;
  titleCell.font = { bold: true, size: 17, color: { argb: "FFFFFFFF" } };
  titleCell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: `FF${BRAND.secondaryColor}` },
  };
  titleCell.alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(1).height = 30;

  sheet.mergeCells(`A2:${lastColumn}2`);
  const brandCell = sheet.getCell("A2");
  brandCell.value = `${BRAND.companyName} · ${subtitle}`;
  brandCell.font = { size: 10, color: { argb: "FF50667A" } };
  brandCell.alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(2).height = 20;

  if (BRAND.logoPath && fs.existsSync(BRAND.logoPath)) {
    try {
      const extension = path
        .extname(BRAND.logoPath)
        .replace(".", "")
        .toLowerCase();
      if (["png", "jpeg", "jpg"].includes(extension)) {
        const imageId = workbook.addImage({
          filename: BRAND.logoPath,
          extension: extension === "jpg" ? "jpeg" : extension,
        });
        sheet.addImage(imageId, {
          tl: { col: Math.max(0, sheet.columnCount - 2), row: 0 },
          ext: { width: 105, height: 28 },
        });
      }
    } catch (error) {
      console.warn("No fue posible insertar el logo en Excel:", error.message);
    }
  }
}

async function buildDetailedWorkbook({ client, entries, dateFrom, dateTo }) {
  const workbook = new ExcelJS.Workbook();
  applyWorkbookMetadata(workbook, "Reporte detallado de tiempos");
  const usedNames = new Set();
  const groups = new Map();

  for (const entry of entries) {
    const key = `${entry.project_ID}||${entry.employee_ID}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  for (const groupEntries of groups.values()) {
    const first = groupEntries[0];
    const sheetName = safeSheetName(
      `${first.projectCode || first.projectName} - ${first.employeeName}`,
      usedNames,
    );
    const sheet = workbook.addWorksheet(sheetName, {
      views: [{ state: "frozen", ySplit: 7 }],
      pageSetup: {
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
      properties: { defaultRowHeight: 18 },
    });

    addExcelBrandHeader(
      workbook,
      sheet,
      `REPORTE DETALLADO DE TIEMPOS - ${formatMonthYear(dateFrom).toUpperCase()}`,
      client.legalName,
      "H",
    );

    sheet.mergeCells("A3:B3");
    sheet.getCell("A3").value = "Proyecto";
    sheet.getCell("C3").value = first.projectName || "";
    sheet.mergeCells("C3:H3");
    sheet.mergeCells("A4:B4");
    sheet.getCell("A4").value = "Consultor";
    sheet.getCell("C4").value = first.employeeName || "";
    sheet.mergeCells("C4:H4");
    sheet.mergeCells("A5:B5");
    sheet.getCell("A5").value = "Periodo";
    sheet.getCell("C5").value = periodText(dateFrom, dateTo);
    sheet.mergeCells("C5:H5");

    for (const row of [3, 4, 5]) {
      sheet.getCell(`A${row}`).font = {
        bold: true,
        color: { argb: `FF${BRAND.secondaryColor}` },
      };
      sheet.getCell(`C${row}`).font = { color: { argb: "FF243746" } };
    }

    const headerRow = 7;
    const headers = [
      "#",
      "Fecha",
      "Hora Inicio",
      "Hora Fin",
      "Actividad",
      "Horas",
      "Categoría",
      "Comentarios",
    ];
    sheet.getRow(headerRow).values = headers;
    sheet.getRow(headerRow).height = 24;
    sheet.getRow(headerRow).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: `FF${BRAND.primaryColor}` },
      };
      cell.alignment = {
        vertical: "middle",
        horizontal: "center",
        wrapText: true,
      };
      cell.border = excelBorder(BRAND.primaryColor);
    });

    const dataStart = headerRow + 1;
    groupEntries.forEach((entry, index) => {
      const row = sheet.getRow(dataStart + index);
      row.values = [
        index + 1,
        parseDate(entry.workDate),
        formatTime(entry.approximateStartTime),
        formatTime(entry.approximateEndTime),
        entry.assignmentRole || entry.projectName || "Actividad reportada",
        Number(entry.durationHours || 0),
        requestedCategory(entry.requestedType),
        entry.description || "",
      ];
      row.getCell(2).numFmt = "dd/mm/yyyy";
      row.getCell(6).numFmt = "0.00";
      row.eachCell((cell) => {
        cell.border = excelBorder();
        cell.alignment = { vertical: "top", wrapText: true };
      });
    });

    const totalRow = dataStart + groupEntries.length;
    sheet.mergeCells(`A${totalRow}:E${totalRow}`);
    sheet.getCell(`A${totalRow}`).value = "TOTAL HORAS";
    sheet.getCell(`A${totalRow}`).font = {
      bold: true,
      color: { argb: `FF${BRAND.secondaryColor}` },
    };
    sheet.getCell(`A${totalRow}`).alignment = { horizontal: "right" };
    sheet.getCell(`F${totalRow}`).value = {
      formula: `SUM(F${dataStart}:F${totalRow - 1})`,
    };
    sheet.getCell(`F${totalRow}`).numFmt = "0.00";
    sheet.getCell(`F${totalRow}`).font = {
      bold: true,
      color: { argb: `FF${BRAND.secondaryColor}` },
    };

    const footerRow = totalRow + 2;
    sheet.mergeCells(`A${footerRow}:H${footerRow}`);
    sheet.getCell(`A${footerRow}`).value = BRAND.footerText;
    sheet.getCell(`A${footerRow}`).font = {
      italic: true,
      size: 9,
      color: { argb: "FF6A7785" },
    };

    const widths = [6, 13, 12, 12, 28, 10, 18, 48];
    widths.forEach((width, idx) => {
      sheet.getColumn(idx + 1).width = width;
    });
    sheet.autoFilter = {
      from: `A${headerRow}`,
      to: `H${Math.max(headerRow, totalRow - 1)}`,
    };
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function buildSummaryWorkbook({
  client,
  projects,
  entries,
  assignments,
  rates,
  dateFrom,
  dateTo,
}) {
  const workbook = new ExcelJS.Workbook();
  applyWorkbookMetadata(workbook, "Reporte resumen de tiempos");
  const sheet = workbook.addWorksheet("Resumen", {
    views: [{ state: "frozen", ySplit: 7 }],
    pageSetup: {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });

  addExcelBrandHeader(
    workbook,
    sheet,
    `REPORTE RESUMEN DE TIEMPOS - ${formatMonthYear(dateFrom).toUpperCase()}`,
    client.legalName,
    "F",
  );

  sheet.mergeCells("A3:B3");
  sheet.getCell("A3").value = "Cliente";
  sheet.getCell("C3").value = client.legalName;
  sheet.mergeCells("C3:F3");
  sheet.mergeCells("A4:B4");
  sheet.getCell("A4").value = "Periodo";
  sheet.getCell("C4").value = periodText(dateFrom, dateTo);
  sheet.mergeCells("C4:F4");
  sheet.getCell("A3").font = sheet.getCell("A4").font = {
    bold: true,
    color: { argb: `FF${BRAND.secondaryColor}` },
  };

  const assignmentMap = new Map(
    assignments.map((assignment) => [assignment.ID, assignment]),
  );
  const projectMap = new Map(projects.map((project) => [project.ID, project]));
  const ratesByAssignment = new Map();
  for (const rate of rates) {
    if (!ratesByAssignment.has(rate.assignment_ID))
      ratesByAssignment.set(rate.assignment_ID, []);
    ratesByAssignment.get(rate.assignment_ID).push(rate);
  }

  const groups = new Map();
  for (const entry of entries) {
    const key = entry.assignment_ID;
    if (!groups.has(key)) {
      groups.set(key, {
        assignmentID: entry.assignment_ID,
        projectID: entry.project_ID,
        projectName: entry.projectName,
        employeeName: entry.employeeName,
        registeredHours: 0,
        billableHours: 0,
      });
    }
    const group = groups.get(key);
    group.registeredHours += Number(entry.durationHours || 0);
    group.billableHours += Number(entry.billableHours || 0);
  }

  const rows = Array.from(groups.values())
    .map((group) => {
      const assignment = assignmentMap.get(group.assignmentID) || {};
      const project = projectMap.get(group.projectID) || {};
      const overlappingRates = (ratesByAssignment.get(group.assignmentID) || [])
        .filter((rate) =>
          dateRangesOverlap(rate.validFrom, rate.validTo, dateFrom, dateTo),
        )
        .sort((a, b) =>
          String(b.validFrom || "").localeCompare(String(a.validFrom || "")),
        );
      const rate = overlappingRates[0] || {};
      const monthly = Number(rate.monthlySaleRate || 0);
      const hourly = Number(rate.regularSaleHourlyRate || 0);
      const overtime = Number(rate.overtimeSaleHourlyRate || 0);
      const baseHours =
        group.billableHours > 0 ? group.billableHours : group.registeredHours;
      const value = monthly > 0 ? monthly : hourly > 0 ? baseHours * hourly : 0;
      const rateType =
        monthly > 0
          ? "Tarifa mensual"
          : hourly > 0
            ? "Tarifa por hora"
            : "Sin tarifa configurada";
      return {
        ...group,
        projectCode: project.code || "",
        currency: rate.currency || project.currency || "COP",
        value,
        rateType,
        assignmentFrom: assignment.validFrom,
        assignmentTo: assignment.validTo,
        overtimeRate: overtime,
      };
    })
    .sort(
      (a, b) =>
        String(a.projectName || "").localeCompare(
          String(b.projectName || ""),
          "es",
        ) ||
        String(a.employeeName || "").localeCompare(
          String(b.employeeName || ""),
          "es",
        ),
    );

  const headerRow = 6;
  const headers = [
    "Proyecto",
    "Consultor",
    "Valor",
    "Moneda",
    "Periodo / modalidad",
    "Horas registradas",
  ];
  sheet.getRow(headerRow).values = headers;
  sheet.getRow(headerRow).height = 24;
  sheet.getRow(headerRow).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: `FF${BRAND.primaryColor}` },
    };
    cell.alignment = {
      horizontal: "center",
      vertical: "middle",
      wrapText: true,
    };
    cell.border = excelBorder(BRAND.primaryColor);
  });

  const dataStart = headerRow + 1;
  rows.forEach((item, index) => {
    const row = sheet.getRow(dataStart + index);
    row.values = [
      item.projectName,
      item.employeeName,
      item.value,
      item.currency,
      `${item.rateType} · ${periodText(dateFrom, dateTo)}`,
      item.registeredHours,
    ];
    row.getCell(3).numFmt = "#,##0.00";
    row.getCell(6).numFmt = "0.00";
    row.eachCell((cell) => {
      cell.border = excelBorder();
      cell.alignment = { vertical: "top", wrapText: true };
    });
  });

  const totalRow = dataStart + rows.length;
  sheet.mergeCells(`A${totalRow}:B${totalRow}`);
  sheet.getCell(`A${totalRow}`).value = "TOTAL";
  sheet.getCell(`A${totalRow}`).font = {
    bold: true,
    color: { argb: `FF${BRAND.secondaryColor}` },
  };
  sheet.getCell(`A${totalRow}`).alignment = { horizontal: "right" };
  sheet.getCell(`C${totalRow}`).value = {
    formula: `SUM(C${dataStart}:C${totalRow - 1})`,
  };
  sheet.getCell(`C${totalRow}`).numFmt = "#,##0.00";
  sheet.getCell(`C${totalRow}`).font = {
    bold: true,
    color: { argb: `FF${BRAND.secondaryColor}` },
  };
  sheet.getCell(`F${totalRow}`).value = {
    formula: `SUM(F${dataStart}:F${totalRow - 1})`,
  };
  sheet.getCell(`F${totalRow}`).numFmt = "0.00";
  sheet.getCell(`F${totalRow}`).font = {
    bold: true,
    color: { argb: `FF${BRAND.secondaryColor}` },
  };

  const noRateRows = rows.filter((row) => row.value === 0);
  if (noRateRows.length) {
    const warningRow = totalRow + 2;
    sheet.mergeCells(`A${warningRow}:F${warningRow}`);
    sheet.getCell(`A${warningRow}`).value =
      `Advertencia: ${noRateRows.length} asignación(es) no tienen tarifa de venta aplicable al periodo. Revise Configuración Comercial.`;
    sheet.getCell(`A${warningRow}`).font = {
      italic: true,
      color: { argb: "FFB35A00" },
    };
    sheet.getCell(`A${warningRow}`).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFFF4D6" },
    };
  }

  const footerRow = totalRow + 4;
  sheet.mergeCells(`A${footerRow}:F${footerRow}`);
  sheet.getCell(`A${footerRow}`).value = BRAND.footerText;
  sheet.getCell(`A${footerRow}`).font = {
    italic: true,
    size: 9,
    color: { argb: "FF6A7785" },
  };

  [28, 28, 18, 11, 34, 18].forEach((width, idx) => {
    sheet.getColumn(idx + 1).width = width;
  });
  sheet.autoFilter = {
    from: `A${headerRow}`,
    to: `F${Math.max(headerRow, totalRow - 1)}`,
  };

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function dateRangesOverlap(fromA, toA, fromB, toB) {
  const aFrom = String(fromA || "0001-01-01");
  const aTo = String(toA || "9999-12-31");
  const bFrom = String(fromB || "0001-01-01");
  const bTo = String(toB || "9999-12-31");
  return aFrom <= bTo && aTo >= bFrom;
}

async function buildEvidenceDocument({
  client,
  entries,
  evidenceFiles,
  dateFrom,
  dateTo,
}) {
  const entryByID = new Map(entries.map((entry) => [entry.ID, entry]));
  const filesByDate = new Map();

  for (const evidence of evidenceFiles) {
    const entry = entryByID.get(evidence.up__ID);
    if (!entry) continue;
    if (!filesByDate.has(entry.workDate)) filesByDate.set(entry.workDate, []);
    filesByDate.get(entry.workDate).push({ entry, evidence });
  }

  const children = [];
  const logo = loadBrandLogo();
  if (logo) {
    const dimensions = scaledImageDimensions(logo.buffer, 150, 54);
    children.push(
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new ImageRun({
            data: logo.buffer,
            type: logo.type,
            transformation: dimensions,
          }),
        ],
      }),
    );
  }

  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [
        new TextRun({
          text: "Reporte de evidencias",
          bold: true,
          color: BRAND.secondaryColor,
        }),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `Cliente: ${client.legalName}`, bold: true }),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `Periodo: ${periodText(dateFrom, dateTo)}` }),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: BRAND.footerText,
          italics: true,
          color: "64788E",
          size: 18,
        }),
      ],
    }),
  );

  const dates = Array.from(filesByDate.keys()).sort();
  for (const date of dates) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 140 },
        children: [
          new TextRun({
            text: capitalize(formatDateEs(date, true)),
            bold: true,
            color: BRAND.primaryColor,
          }),
        ],
      }),
    );

    for (const { entry, evidence } of filesByDate.get(date)) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `${entry.employeeName} · ${entry.projectName}`,
              bold: true,
              color: BRAND.secondaryColor,
            }),
          ],
        }),
      );
      if (entry.description) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: "Actividad: ", bold: true }),
              new TextRun({ text: entry.description }),
            ],
          }),
        );
      }
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `Evidencia: ${evidence.filename || "archivo"}`,
              italics: true,
              color: "64788E",
            }),
          ],
        }),
      );

      if (isEmbeddableImage(evidence.mimeType, evidence.filename)) {
        const type = imageType(evidence.mimeType, evidence.filename);
        const dimensions = scaledImageDimensions(evidence.buffer, 620, 700);
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 100, after: 240 },
            children: [
              new ImageRun({
                data: evidence.buffer,
                type,
                transformation: dimensions,
              }),
            ],
          }),
        );
      } else {
        children.push(
          new Paragraph({
            spacing: { after: 240 },
            children: [
              new TextRun({
                text: "El archivo no es una imagen embebible y se incluye en la carpeta Evidencias_adicionales del ZIP.",
                italics: true,
                color: "B35A00",
              }),
            ],
          }),
        );
      }
    }
  }

  const doc = new Document({
    creator: BRAND.companyName,
    title: "Reporte de evidencias",
    description: `Evidencias de tiempos para ${client.legalName}`,
    sections: [
      {
        properties: {
          page: {
            margin: { top: 720, right: 720, bottom: 720, left: 720 },
          },
        },
        children,
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

function capitalize(value) {
  const text = String(value || "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function loadBrandLogo() {
  if (!BRAND.logoPath || !fs.existsSync(BRAND.logoPath)) return null;
  try {
    const buffer = fs.readFileSync(BRAND.logoPath);
    const type = imageType("", BRAND.logoPath);
    return type ? { buffer, type } : null;
  } catch (error) {
    console.warn("No fue posible cargar el logo configurado:", error.message);
    return null;
  }
}

function isEmbeddableImage(mimeType, filename) {
  return Boolean(imageType(mimeType, filename));
}

function imageType(mimeType, filename) {
  const mime = String(mimeType || "").toLowerCase();
  const ext = path.extname(String(filename || "")).toLowerCase();
  if (mime.includes("png") || ext === ".png") return "png";
  if (
    mime.includes("jpeg") ||
    mime.includes("jpg") ||
    ext === ".jpg" ||
    ext === ".jpeg"
  )
    return "jpg";
  return null;
}

function scaledImageDimensions(buffer, maxWidth, maxHeight) {
  const size = readImageDimensions(buffer) || {
    width: maxWidth,
    height: Math.round(maxWidth * 0.62),
  };
  const ratio = Math.min(maxWidth / size.width, maxHeight / size.height, 1);
  return {
    width: Math.max(1, Math.round(size.width * ratio)),
    height: Math.max(1, Math.round(size.height * ratio)),
  };
}

function readImageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  // PNG
  if (buffer.slice(1, 4).toString("ascii") === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) return null;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        return {
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5),
        };
      }
      offset += 2 + length;
    }
  }
  return null;
}

