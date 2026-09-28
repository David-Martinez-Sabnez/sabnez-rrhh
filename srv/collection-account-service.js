"use strict";

const cds = require("@sap/cds");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const {
  DECISIONS,
  PROCESS_CODES,
  registerApprovalAdapter,
  startApproval,
  _internal: { persistNotification },
} = require("./lib/approval-orchestrator");
const { buildCollectionAccountPdf } = require("./lib/collection-account-pdf");
const {
  buildAccountingEmail,
  buildAccountingZip,
  LIMITE_ADJUNTO_BYTES,
} = require("./lib/accounting-dispatch");
const { sendMail } = require("./lib/approval-mailer");
const { streamToBuffer } = require("./lib/stream-utils");
const { loadCalendars, businessDaysBetween } = require("./lib/work-calendar");
const {
  completedCollectionCycles,
  collectionCycleContaining,
} = require("./lib/collection-account-cycles");

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
const APPROVED_ENTRY_STATES = new Set([
  "INTERNALLY_APPROVED",
  "CLOSED",
  "INVOICED",
]);
const OWNER_STATES = new Set([
  "PENDING_SIGNATURE",
  "SIGNED",
  "CORRECTION_REQUESTED",
]);
const SUBMITTABLE_STATES = new Set(["SIGNED"]);
const HR_REVIEW_STATES = new Set(["SUBMITTED", "UNDER_HR_REVIEW"]);
const TERMINAL_CLAIM_STATES = new Set(["CANCELLED", "HR_REJECTED"]);
// Clave del parámetro que fija desde cuándo la plataforma gobierna las cuentas
// de cobro. Vive en el centro de configuración, no en una variable de entorno.
const PARAM_CUENTAS_DESDE = "CUENTAS_COBRO_DESDE";
const STATUS_TEXT = Object.freeze({
  DRAFT: "Borrador",
  PENDING_SIGNATURE: "Pendiente de firma",
  SIGNED: "Firmada",
  SUBMITTED: "Enviada a RR. HH.",
  UNDER_HR_REVIEW: "En revisión de RR. HH.",
  CORRECTION_REQUESTED: "Corrección solicitada",
  HR_APPROVED: "Aprobada por RR. HH.",
  SENT_TO_ACCOUNTING: "Enviada a contabilidad",
  HR_REJECTED: "Devuelta por RR. HH.",
  CANCELLED: "Cancelada",
});
const CRITICIDAD_ESTADO = Object.freeze({
  HR_APPROVED: 3,
  SENT_TO_ACCOUNTING: 3,
  SUBMITTED: 2,
  UNDER_HR_REVIEW: 2,
  CORRECTION_REQUESTED: 2,
  PENDING_SIGNATURE: 2,
  HR_REJECTED: 1,
  CANCELLED: 1,
});

const EVENT_TEXT = Object.freeze({
  CREATED: "Cuenta generada",
  SIGNED: "Firma electrónica registrada",
  SIGNED_DOCUMENT_UPLOADED: "Documento firmado cargado",
  SOCIAL_SECURITY_UPLOADED: "Soporte de seguridad social cargado",
  SUBMITTED: "Cuenta enviada a RR. HH.",
  CORRECTION_REQUESTED: "Corrección solicitada",
  CORRECTION_RESOLVED: "Corrección atendida",
  HR_APPROVED: "Cuenta aprobada por RR. HH.",
  HR_RETURNED: "Cuenta devuelta por RR. HH.",
  CANCELLED: "Borrador cancelado",
  SENT_TO_ACCOUNTING: "Expediente enviado a contabilidad",
});

const BUSINESS_OBJECT_CUENTA = "CollectionAccount";
const ASSISTED_ORIGIN = "ASSISTED_FINANCE";
const ORIGIN_TEXT = Object.freeze({
  SELF_SERVICE: "Autoservicio del prestador",
  ASSISTED_FINANCE: "Elaborada por Finanzas",
});
// Días que se esperan antes de insistirle al prestador que no ha generado.
const DIAS_INSISTENCIA = 3;

/**
 * Aprobación de la cuenta de cobro. RR. HH. decide desde el Centro de
 * Aprobaciones; esta app ya no expone acciones de aprobación propias.
 */
registerApprovalAdapter(PROCESS_CODES.COLLECTION_ACCOUNT, {
  async validateDecision(ctx) {
    const account = await loadAccountForDecision(ctx);
    if (!HR_REVIEW_STATES.has(account.status))
      reject(ctx.req, 409, "CUENTA_NO_DECIDIBLE", "La cuenta ya no está pendiente de revisión.");
    if (account.employee_ID === ctx.actor.employeeID)
      reject(ctx.req, 403, "AUTOAPROBACION_NO_PERMITIDA", "No puedes decidir tu propia cuenta de cobro.");
    if (ctx.decision === DECISIONS.APPROVE && (!account.generatedFileName || !socialSecuritySatisfied(account)))
      reject(ctx.req, 409, "EXPEDIENTE_INCOMPLETO", "La cuenta firmada y el soporte deben estar completos.");
  },

  async applyDecision(ctx) {
    const { CollectionAccounts, CollectionAccountEvents } = cds.entities("sabnez.collectionaccounts");
    const aprobada = ctx.decision === DECISIONS.APPROVE;
    const now = new Date().toISOString();

    // Al devolver se invalida la firma y el documento: el prestador debe
    // corregir y volver a firmar antes de reenviar.
    const cambios = aprobada
      ? { status: "HR_APPROVED", hrComment: ctx.comment, hrReviewedAt: now, hrReviewedBy: ctx.actor.userID }
      : { status: "HR_REJECTED", hrComment: ctx.comment, hrReviewedAt: now, hrReviewedBy: ctx.actor.userID, signatureName: null, signatureStatement: null, signatureMethod: null, signedAt: null, signedByUserID: null, signatureHash: null, generatedFileName: null, generatedMimeType: null, generatedContent: null, generatedHash: null, generatedAt: null };

    const filas = await ctx.tx.run(
      UPDATE(CollectionAccounts).set(cambios).where({ ID: ctx.businessObject.id, status: { in: [...HR_REVIEW_STATES] } }),
    );
    if (filas !== 1)
      reject(ctx.req, 409, "CUENTA_MODIFICADA_CONCURRENTEMENTE", "La cuenta cambió mientras se registraba la decisión.");

    await event(ctx.tx, CollectionAccountEvents, ctx.businessObject.id,
      aprobada ? "HR_APPROVED" : "HR_RETURNED", ctx.actor.userID,
      ctx.comment || (aprobada ? "Cuenta aprobada para pago." : "Cuenta devuelta para corrección."));
  },
});

/**
 * Solicitudes de corrección. Aprobarla recalcula la cuenta contra los tiempos
 * vigentes; rechazarla la devuelve a firma sin recalcular.
 */
registerApprovalAdapter(PROCESS_CODES.COLLECTION_ACCOUNT_CORRECTION, {
  async validateDecision(ctx) {
    const account = await loadAccountForDecision(ctx);
    if (account.status !== "CORRECTION_REQUESTED")
      reject(ctx.req, 409, "CORRECCION_NO_PENDIENTE", "La cuenta no tiene una corrección pendiente.");
    if (!ctx.comment)
      reject(ctx.req, 400, "COMENTARIO_REQUERIDO", "Indica cómo se atendió la solicitud.", "comentario");
  },

  async applyDecision(ctx) {
    const model = cds.entities("sabnez.collectionaccounts");
    const times = cds.entities("sabnez.times");
    const rrhh = cds.entities("sabnez.rrhh");
    const { CollectionAccounts, CollectionAccountItems, CollectionAccountEvents } = model;
    const account = await ctx.tx.run(SELECT.one.from(CollectionAccounts).where({ ID: ctx.businessObject.id }));
    const now = new Date().toISOString();
    const atendida = ctx.decision === DECISIONS.APPROVE;

    // Tanto aceptar como negar la corrección devuelven la cuenta a firma: lo
    // que cambia es si el valor se recalcula contra los tiempos actuales.
    const recalculated = atendida
      ? await recalculateExistingAccount(ctx.req, account, {
          CollectionAccountItems,
          ProjectAssignments: times.ProjectAssignments,
          AssignmentRates: times.AssignmentRates,
          TimeEntries: times.TimeEntries,
          Contratos: rrhh.Contratos,
        })
      : null;

    const filas = await ctx.tx.run(
      UPDATE(CollectionAccounts).set({
        status: "PENDING_SIGNATURE",
        grossAmount: recalculated ? recalculated.total : account.grossAmount,
        correctionResolvedAt: now,
        correctionResolvedBy: ctx.actor.userID,
        hrComment: ctx.comment,
        signatureName: null, signatureStatement: null, signedAt: null,
        signedByUserID: null, signatureHash: null,
        generatedContent: null, generatedHash: null, generatedAt: null,
      }).where({ ID: account.ID, status: "CORRECTION_REQUESTED" }),
    );
    if (filas !== 1)
      reject(ctx.req, 409, "CUENTA_MODIFICADA_CONCURRENTEMENTE", "La cuenta cambió mientras se registraba la decisión.");

    await event(ctx.tx, CollectionAccountEvents, account.ID, "CORRECTION_RESOLVED", ctx.actor.userID,
      atendida
        ? `${ctx.comment} Valor anterior: ${formatMoney(account.grossAmount, account.currency)}. Valor recalculado: ${formatMoney(recalculated.total, account.currency)}.`
        : `Corrección no aplicada: ${ctx.comment} El valor se mantiene en ${formatMoney(account.grossAmount, account.currency)}.`);
  },
});

async function loadAccountForDecision(ctx) {
  const { CollectionAccounts } = cds.entities("sabnez.collectionaccounts");
  const account = await ctx.tx.run(SELECT.one.from(CollectionAccounts).where({ ID: ctx.businessObject.id }));
  if (!account) reject(ctx.req, 404, "CUENTA_NO_ENCONTRADA", "La cuenta de cobro no existe.");
  return account;
}

module.exports = cds.service.impl(function () {
  const model = cds.entities("sabnez.collectionaccounts");
  const rrhh = cds.entities("sabnez.rrhh");
  const times = cds.entities("sabnez.times");
  const {
    CollectionAccounts,
    CollectionAccountItems,
    CollectionAccountEvents,
  } = model;
  const { Empleados, Contratos, CuentasBancarias } = rrhh;
  const { ProjectAssignments, AssignmentRates, TimeEntries } = times;
  const { Parametros } = cds.entities("sabnez.config");

  const { CuentasCobro } = this.entities;

  /**
   * Los campos virtuales del reporte dependen de datos persistidos. Con
   * autoExpandSelect, Fiori puede pedir solamente statusText o
   * expedienteTexto; en ese caso CAP no trae status ni los nombres de los
   * documentos y el after READ no tiene con qué calcularlos.
   */
  this.before("READ", CuentasCobro, (req) => {
    const columns = req.query?.SELECT?.columns;
    if (!Array.isArray(columns)) return;

    const requested = new Set(
      columns
        .filter((column) => Array.isArray(column?.ref) && column.ref.length === 1)
        .map((column) => column.ref[0]),
    );
    const calculated = [
      "statusText",
      "criticidad",
      "listaParaEnviar",
      "expedienteTexto",
      "criticidadExpediente",
      "originText",
    ];
    if (!calculated.some((field) => requested.has(field))) return;

    for (const dependency of [
      "status",
      "generatedFileName",
      "socialSecurityFileName",
      "socialSecurityStatus",
      "socialSecurityRequirement",
      "accountingSentAt",
      "origin",
    ]) {
      if (!requested.has(dependency)) {
        columns.push({ ref: [dependency] });
        requested.add(dependency);
      }
    }
  });

  // Columnas de las que dependen los campos calculados del List Report.
  const FUENTES_CALCULADAS = [
    "status",
    "generatedFileName",
    "socialSecurityFileName",
    "socialSecurityStatus",
    "socialSecurityRequirement",
  ];

  /**
   * Fiori Elements pide con $select solo las columnas anotadas, así que las
   * fuentes de los campos calculados no vendrían en la consulta y el semáforo
   * del expediente saldría mal. Se agregan aquí.
   */
  this.before("READ", CuentasCobro, (req) => {
    const columnas = req.query?.SELECT?.columns;
    if (!columnas) return; // Sin $select la consulta ya trae todo.

    const presentes = new Set(
      columnas.map((columna) => columna.as || columna.ref?.[columna.ref.length - 1]),
    );
    for (const fuente of FUENTES_CALCULADAS) {
      if (!presentes.has(fuente)) columnas.push({ ref: [fuente] });
    }
  });

  /**
   * Rellena los campos calculados del List Report.
   *
   * El semáforo del expediente evita que RR. HH. tenga que abrir cada fila
   * para descubrir por qué una cuenta no se puede mandar a contabilidad.
   */
  this.after("READ", CuentasCobro, (rows) => {
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      if (!row || typeof row !== "object") continue;

      row.statusText = STATUS_TEXT[row.status] || row.status;
      row.originText = ORIGIN_TEXT[row.origin] || row.origin || ORIGIN_TEXT.SELF_SERVICE;
      row.criticidad = CRITICIDAD_ESTADO[row.status] ?? 0;

      const tieneDocumento = Boolean(row.generatedFileName);
      const tieneSoporte = socialSecuritySatisfied(row);
      const yaEnviada = row.status === "SENT_TO_ACCOUNTING";

      if (yaEnviada) {
        row.listaParaEnviar = false;
        row.expedienteTexto = "Ya enviada a contabilidad";
        row.criticidadExpediente = 0;
      } else if (row.status !== "HR_APPROVED") {
        row.listaParaEnviar = false;
        row.expedienteTexto = "Pendiente de aprobación";
        row.criticidadExpediente = 0;
      } else if (!tieneDocumento) {
        row.listaParaEnviar = false;
        row.expedienteTexto = "Falta la cuenta firmada";
        row.criticidadExpediente = 1;
      } else if (!tieneSoporte) {
        row.listaParaEnviar = false;
        row.expedienteTexto = "Falta el soporte de seguridad social";
        row.criticidadExpediente = 1;
      } else {
        row.listaParaEnviar = true;
        row.expedienteTexto = "Lista para enviar";
        row.criticidadExpediente = 3;
      }
    }
  });

  this.on("getContext", async (req) => {
    const employee = await authenticatedEmployee(req, Empleados, false);
    const isHR = hasHRRole(req);
    if (!employee) {
      if (isHR) {
        return {
          employeeID: null,
          employeeName: null,
          isProvider: false,
          isHR: true,
          canGenerate: false,
          pendingCount: 0,
          historyCount: 0,
          approvedAmount: 0,
          approvedCount: 0,
          currency: "COP",
          message: "Tienes acceso al reporte de cuentas de cobro.",
        };
      }
      reject(req, 403, "EMPLEADO_NO_ASOCIADO", "No existe un empleado asociado al usuario autenticado.");
    }
    const accounts = await SELECT.from(CollectionAccounts)
      .columns("ID", "status", "grossAmount", "currency")
      .where({ employee_ID: employee.ID });
    // Solo cuenta como cobrado lo que RR. HH. autorizó para pago.
    const approved = accounts.filter((row) => row.status === "HR_APPROVED");
    const corteGlobal = await parametro(req, PARAM_CUENTAS_DESDE);
    const eligible = employee.generaCuentaCobro
      ? await eligiblePeriods(employee, { Contratos, CuentasBancarias, ProjectAssignments, AssignmentRates, TimeEntries, CollectionAccounts, CollectionAccountItems }, { corteGlobal })
      : [];
    return {
      employeeID: employee.ID,
      employeeName: employee.nombreCompleto,
      isProvider: Boolean(employee.generaCuentaCobro),
      isHR,
      canGenerate: eligible.some((row) => row.eligible),
      pendingCount: accounts.filter((row) => !new Set(["HR_APPROVED", "CANCELLED"]).has(row.status)).length,
      historyCount: accounts.length,
      approvedAmount: roundMoney(approved.reduce((total, row) => total + Number(row.grossAmount || 0), 0)),
      approvedCount: approved.length,
      currency: approved[0]?.currency || accounts[0]?.currency || "COP",
      message: employee.generaCuentaCobro
        ? "Las cuentas se generan por el valor bruto de los honorarios. Las retenciones se determinan al momento del pago."
        : "Tu perfil no está configurado como prestador de servicios con cuenta de cobro.",
    };
  });

  this.on("getEligiblePeriods", async (req) => {
    const employee = await authenticatedEmployee(req, Empleados);
    ensureProvider(req, employee);
    return eligiblePeriods(employee, { Contratos, CuentasBancarias, ProjectAssignments, AssignmentRates, TimeEntries, CollectionAccounts, CollectionAccountItems }, { corteGlobal: await parametro(req, PARAM_CUENTAS_DESDE) });
  });

  this.on("getMyAccounts", async (req) => {
    const employee = await authenticatedEmployee(req, Empleados);
    const where = { employee_ID: employee.ID };

    // Filtro por año del cierre del periodo. Sin año se devuelve todo, que es
    // lo que necesita el selector "Todos los años".
    const year = Number(req.data?.year);
    if (Number.isInteger(year) && year > 1900) {
      where.periodEnd = { between: `${year}-01-01`, and: `${year}-12-31` };
    }

    const rows = await SELECT.from(CollectionAccounts)
      .where(where)
      .orderBy("periodStart desc", "createdAt desc");

    const periodKey = clean(req.data?.periodKey);
    const filtradas = periodKey
      ? rows.filter((row) => accountPeriodKey(row) === periodKey)
      : rows;

    return Promise.all(filtradas.map((row) => summarize(row, CollectionAccountItems, false)));
  });

  this.on("getAccountFilterOptions", async (req) => {
    const employee = await authenticatedEmployee(req, Empleados);
    const rows = await SELECT.from(CollectionAccounts)
      .columns("periodStart", "periodEnd")
      .where({ employee_ID: employee.ID });

    const porAño = new Map();
    const porPeriodo = new Map();
    for (const row of rows) {
      const year = Number(String(row.periodEnd).slice(0, 4));
      porAño.set(year, (porAño.get(year) || 0) + 1);

      const key = accountPeriodKey(row);
      const actual = porPeriodo.get(key);
      if (actual) actual.count += 1;
      else
        porPeriodo.set(key, {
          periodKey: key,
          label: `${formatShortDate(row.periodStart)} al ${formatShortDate(row.periodEnd)}`,
          year,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          count: 1,
        });
    }

    const añoActual = Number(todayColombia().slice(0, 4));
    return {
      // Por defecto se consulta el año en curso; si ese año no tiene cuentas
      // todavía, se muestra el más reciente que sí las tenga.
      defaultYear: porAño.has(añoActual)
        ? añoActual
        : [...porAño.keys()].sort((a, b) => b - a)[0] || añoActual,
      years: [...porAño.entries()]
        .map(([year, count]) => ({ year, count }))
        .sort((a, b) => b.year - a.year),
      periods: [...porPeriodo.values()].sort((a, b) =>
        String(b.periodStart).localeCompare(String(a.periodStart)),
      ),
    };
  });

  this.on("getAccountDetail", async (req) => {
    const employee = await authenticatedEmployee(req, Empleados, false);
    const row = await SELECT.one.from(CollectionAccounts).where({ ID: req.data?.accountID });
    if (!row) reject(req, 404, "CUENTA_NO_ENCONTRADA", "La cuenta de cobro no existe.");
    if (!hasHRRole(req) && row.employee_ID !== employee?.ID)
      reject(req, 403, "CUENTA_NO_AUTORIZADA", "No tienes autorización para consultar esta cuenta.");
    return detail(row, { CollectionAccountItems, CollectionAccountEvents }, hasHRRole(req));
  });

  this.on("createAccounts", async (req) => {
    const employee = await authenticatedEmployee(req, Empleados);
    ensureProvider(req, employee);
    const keys = [...new Set((req.data?.selections || []).map((row) => row?.periodKey).filter(Boolean))];
    if (!keys.length) reject(req, 400, "PERIODOS_REQUERIDOS", "Selecciona al menos un periodo aprobado.");
    const candidates = await eligiblePeriods(employee, { Contratos, CuentasBancarias, ProjectAssignments, AssignmentRates, TimeEntries, CollectionAccounts, CollectionAccountItems }, { corteGlobal: await parametro(req, PARAM_CUENTAS_DESDE) });
    const byKey = new Map(candidates.map((row) => [row.periodKey, row]));
    const selected = keys.map((key) => byKey.get(key));
    if (selected.some((row) => !row)) reject(req, 409, "PERIODO_DESACTUALIZADO", "Uno de los periodos ya no está disponible. Actualiza la pantalla.");
    const blocked = selected.find((row) => !row.eligible);
    if (blocked) reject(req, 409, "PERIODO_NO_ELEGIBLE", blocked.blockingReason || "El periodo todavía no está habilitado.");

    const combine = Boolean(req.data?.combine);
    const groups = combine ? [selected] : selected.map((row) => [row]);
    const tx = cds.tx(req);
    const created = [];
    for (const group of groups) {
      const account = await createAccount(tx, employee, group, req, { Contratos, CuentasBancarias, CollectionAccounts, CollectionAccountItems, CollectionAccountEvents });
      created.push(account);
    }
    const summaries = await Promise.all(created.map((row) => summarize(row, CollectionAccountItems, false)));
    return {
      success: true,
      message: combine
        ? "La cuenta combinada quedó lista para revisión y firma."
        : `${summaries.length} cuenta(s) quedaron listas para revisión y firma.`,
      account: summaries[0],
      accounts: summaries,
    };
  });

  this.on("getAssistedEmployees", async () => {
    const employees = await SELECT.from(Empleados).columns(
      "ID", "nombreCompleto", "tipoDocumento", "numeroDocumento",
      "lugarExpedicionDocumento", "direccionTributaria", "ciudadTributaria",
    ).where({ estado_codigo: "AC" }).orderBy("nombreCompleto");
    const employeeIDs = employees.map((row) => row.ID);
    const banks = employeeIDs.length
      ? await SELECT.from(CuentasBancarias).where({
        empleado_ID: { in: employeeIDs }, principal: true, activa: true,
      })
      : [];
    const bankByEmployee = new Map(banks.map((row) => [row.empleado_ID, row]));
    return employees.map((employee) => {
      const bank = bankByEmployee.get(employee.ID);
      return {
        ID: employee.ID,
        name: employee.nombreCompleto,
        documentType: employee.tipoDocumento,
        documentNumber: employee.numeroDocumento,
        documentCity: employee.lugarExpedicionDocumento,
        taxAddress: employee.direccionTributaria,
        taxCity: employee.ciudadTributaria,
        bankName: bank?.banco,
        bankAccountType: bank?.tipoCuenta,
        bankAccountNumber: bank?.numeroCuenta,
        bankHolder: bank?.titularNombre,
        hasActiveBank: Boolean(bank),
      };
    });
  });

  this.on("createAssistedAccount", async (req) => {
    const preparer = await authenticatedEmployee(req, Empleados);
    const input = assistedAccountInput(req);
    const employee = await SELECT.one.from(Empleados).columns(
      "ID", "nombreCompleto", "tipoDocumento", "numeroDocumento",
      "lugarExpedicionDocumento", "direccionTributaria", "ciudadTributaria",
      "estado_codigo",
    ).where({ ID: input.employeeID });
    if (!employee || employee.estado_codigo !== "AC")
      reject(req, 400, "EMPLEADO_INVALIDO", "Selecciona una persona activa del registro de empleados.", "employeeID");
    const bank = await SELECT.one.from(CuentasBancarias)
      .where({ empleado_ID: employee.ID, principal: true, activa: true });
    if (!bank)
      reject(req, 409, "CUENTA_BANCARIA_REQUERIDA", "La persona seleccionada no tiene una cuenta bancaria principal activa en Gestión de empleados.", "employeeID");
    const tx = cds.tx(req);
    const ID = cds.utils.uuid();
    const account = {
      ID,
      numero: accountNumber(input.periodEnd, ID),
      employee_ID: employee.ID,
      contract_ID: null,
      origin: ASSISTED_ORIGIN,
      preparedByUserID: identity(req),
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      currency: input.currency,
      grossAmount: input.grossAmount,
      status: "PENDING_SIGNATURE",
      combined: false,
      employeeNameSnapshot: employee.nombreCompleto,
      documentTypeSnapshot: employee.tipoDocumento,
      documentNumberSnapshot: employee.numeroDocumento,
      documentCitySnapshot: employee.lugarExpedicionDocumento,
      taxAddressSnapshot: employee.direccionTributaria,
      taxCitySnapshot: employee.ciudadTributaria,
      bankNameSnapshot: bank.banco,
      bankAccountTypeSnapshot: bank.tipoCuenta,
      bankAccountNumberSnapshot: bank.numeroCuenta,
      bankHolderSnapshot: bank.titularNombre,
      socialSecurityRequirement: input.socialSecurityRequirement,
      socialSecurityStatus: input.socialSecurityRequirement === "NONE" ? "NOT_REQUIRED" : "PENDING",
      signatureMethod: "MANUSCRIPT",
    };
    const item = {
      ID: cds.utils.uuid(),
      account_ID: ID,
      assignment_ID: null,
      serviceStart: input.periodStart,
      serviceEnd: input.periodEnd,
      clientName: "Sabnez Consulting SAS",
      projectCode: "SERVICIOS-GENERALES",
      projectName: "Servicios generales",
      modality: "HOURLY",
      concept: input.concept,
      approvedHours: 0,
      unitRate: null,
      amount: input.grossAmount,
      calculationMethod: "MANUAL_ASSISTED",
    };
    const draft = await buildCollectionAccountPdf(account, [item]);
    account.draftFileName = `${safeFile(account.numero)}-para-firmar.pdf`;
    account.draftMimeType = "application/pdf";
    account.draftContent = draft;
    account.draftHash = sha256(draft);

    await tx.run(INSERT.into(CollectionAccounts).entries(account));
    await tx.run(INSERT.into(CollectionAccountItems).entries(item));
    await event(tx, CollectionAccountEvents, ID, "CREATED", identity(req),
      `Cuenta asistida elaborada por ${preparer.nombreCompleto} para ${employee.nombreCompleto}. Valor bruto ${formatMoney(input.grossAmount, input.currency)}.`);

    return {
      success: true,
      message: "La cuenta asistida fue creada. Descarga el PDF, recógelo firmado y carga luego el expediente.",
      account: await summarize(account, CollectionAccountItems, true),
      fileName: account.draftFileName,
      mimeType: account.draftMimeType,
      contentBase64: draft.toString("base64"),
    };
  });

  this.on("downloadAssistedDraft", async (req) => {
    const account = await SELECT.one.from(CollectionAccounts)
      .columns("ID", "origin", "draftFileName", "draftMimeType", "draftContent")
      .where({ ID: req.data?.accountID });
    if (!account) reject(req, 404, "CUENTA_NO_ENCONTRADA", "La cuenta de cobro no existe.");
    if (account.origin !== ASSISTED_ORIGIN)
      reject(req, 409, "CUENTA_NO_ASISTIDA", "Esta cuenta fue creada por el prestador y no tiene un formato para firma manuscrita.");
    const content = await streamToBuffer(account.draftContent);
    if (!content.length) reject(req, 404, "BORRADOR_NO_DISPONIBLE", "El PDF para firma no está disponible.");
    return { fileName: account.draftFileName, mimeType: account.draftMimeType, contentBase64: content.toString("base64") };
  });

  this.on("uploadAssistedSignedPackage", async (req) => {
    const preparer = await authenticatedEmployee(req, Empleados);
    const account = await SELECT.one.from(CollectionAccounts).where({ ID: req.data?.accountID });
    if (!account) reject(req, 404, "CUENTA_NO_ENCONTRADA", "La cuenta de cobro no existe.");
    if (account.origin !== ASSISTED_ORIGIN)
      reject(req, 409, "CUENTA_NO_ASISTIDA", "El expediente manual solo aplica a cuentas elaboradas por Finanzas.");
    if (!new Set(["PENDING_SIGNATURE", "HR_REJECTED"]).has(account.status))
      reject(req, 409, "CARGA_NO_PERMITIDA", "La cuenta no se encuentra pendiente de firma o corrección.");

    const signed = await streamToBuffer(req.data?.signedContent);
    const supportRequired = account.socialSecurityRequirement !== "NONE";
    const support = (await streamToBuffer(req.data?.supportContent)) || Buffer.alloc(0);
    validateUploadedDocument(req, signed, req.data?.signedMimeType, "La cuenta firmada", new Set(["application/pdf"]));
    if (supportRequired || support.length)
      validateUploadedDocument(req, support, req.data?.supportMimeType, "El soporte", new Set(["application/pdf", "image/jpeg", "image/png"]));
    await scan(req, signed);
    if (support.length) await scan(req, support);

    const now = new Date().toISOString();
    const signatureHash = sha256(signed);
    await UPDATE(CollectionAccounts).set({
      status: "SUBMITTED",
      signatureName: account.employeeNameSnapshot,
      signatureStatement: "Documento firmado manuscritamente por el prestador y cargado por Finanzas.",
      signatureMethod: "MANUSCRIPT",
      signedAt: now,
      signedByUserID: null,
      signatureIp: null,
      signatureUserAgent: null,
      signatureHash,
      generatedFileName: clean(req.data?.signedFileName)?.slice(0, 255) || `${safeFile(account.numero)}-firmada.pdf`,
      generatedMimeType: "application/pdf",
      generatedContent: signed,
      generatedHash: signatureHash,
      generatedAt: now,
      ...(support.length ? {
        socialSecurityFileName: clean(req.data?.supportFileName)?.slice(0, 255) || "soporte-seguridad-social",
        socialSecurityMimeType: clean(req.data?.supportMimeType),
        socialSecurityContent: support,
        socialSecurityHash: sha256(support),
        socialSecurityStatus: "CLEAN",
        socialSecurityUploadedAt: now,
      } : {
        socialSecurityStatus: "NOT_REQUIRED",
      }),
      submittedAt: now,
      correctionReason: null,
    }).where({ ID: account.ID });
    await event(cds.tx(req), CollectionAccountEvents, account.ID, "SIGNED_DOCUMENT_UPLOADED", identity(req),
      `Finanzas cargó el documento con firma manuscrita. Huella: ${signatureHash}`);
    if (support.length)
      await event(cds.tx(req), CollectionAccountEvents, account.ID, "SOCIAL_SECURITY_UPLOADED", identity(req),
        "Finanzas cargó el soporte de seguridad social de la persona.");
    await event(cds.tx(req), CollectionAccountEvents, account.ID, "SUBMITTED", identity(req),
      "Expediente asistido enviado para revisión de RR. HH.");

    const items = await SELECT.from(CollectionAccountItems).where({ account_ID: account.ID });
    const submissionCycle = await nextApprovalCycle(req, account.ID, PROCESS_CODES.COLLECTION_ACCOUNT);
    await startApproval(req, {
      processCode: PROCESS_CODES.COLLECTION_ACCOUNT,
      businessObjectType: BUSINESS_OBJECT_CUENTA,
      businessObjectID: account.ID,
      requesterEmployeeID: preparer.ID,
      title: account.numero,
      summary: `Cuenta asistida de ${account.employeeNameSnapshot} por ${formatMoney(account.grossAmount, account.currency)}, periodo del ${formatDate(account.periodStart)} al ${formatDate(account.periodEnd)}.`,
      priority: "MEDIUM",
      route: "CuentasCobro-display",
      cycle: submissionCycle,
      idempotencyKey: `COLLECTION_ACCOUNT:${account.ID}:${submissionCycle}`,
      facts: accountFacts(account, items),
    });
    const updated = await SELECT.one.from(CollectionAccounts).where({ ID: account.ID });
    return result("El expediente firmado fue cargado y enviado al Centro de Aprobaciones.", await summarize(updated, CollectionAccountItems, true));
  });

  this.on("signAccount", async (req) => {
    const employee = await authenticatedEmployee(req, Empleados);
    const account = await ownedAccount(req, req.data?.accountID, employee.ID, CollectionAccounts);
    if (!new Set(["PENDING_SIGNATURE", "HR_REJECTED"]).has(account.status))
      reject(req, 409, "FIRMA_NO_PERMITIDA", "La cuenta no se encuentra en un estado que permita firmarla.");
    if (!req.data?.accepted) reject(req, 400, "ACEPTACION_REQUERIDA", "Debes aceptar la declaración de firma electrónica.");
    const signer = clean(req.data?.signerName);
    if (!signer || normalize(signer) !== normalize(employee.nombreCompleto))
      reject(req, 400, "FIRMANTE_INVALIDO", "Escribe tu nombre completo exactamente como aparece en tu perfil.", "signerName");

    const items = await SELECT.from(CollectionAccountItems).where({ account_ID: account.ID }).orderBy("serviceStart", "projectName");
    const now = new Date().toISOString();
    const statement = "Declaro que la información de esta cuenta de cobro corresponde a los servicios prestados y acepto firmarla electrónicamente.";
    const signatureHash = sha256(JSON.stringify({ accountID: account.ID, signer, user: identity(req), now, amount: account.grossAmount, items }));
    const signed = {
      ...account,
      signatureName: signer,
      signatureStatement: statement,
      signedAt: now,
      signedByUserID: identity(req),
      signatureIp: requestIp(req),
      signatureUserAgent: String(req.headers?.["user-agent"] || "").slice(0, 500),
      signatureHash,
      status: "SIGNED",
    };
    const document = await buildCollectionAccountPdf(signed, items);
    const fileName = `${safeFile(account.numero)}.pdf`;
    const generatedHash = sha256(document);
    await UPDATE(CollectionAccounts).set({
      status: "SIGNED",
      signatureName: signer,
      signatureStatement: statement,
      signedAt: now,
      signedByUserID: identity(req),
      signatureIp: requestIp(req),
      signatureUserAgent: signed.signatureUserAgent,
      signatureHash,
      generatedFileName: fileName,
      generatedMimeType: "application/pdf",
      generatedContent: document,
      generatedHash,
      generatedAt: now,
      correctionReason: null,
    }).where({ ID: account.ID });
    await event(cds.tx(req), CollectionAccountEvents, account.ID, "SIGNED", identity(req), `Firma: ${signer}. Huella: ${signatureHash}`);
    const updated = await SELECT.one.from(CollectionAccounts).where({ ID: account.ID });
    return result("La cuenta fue firmada electrónicamente.", await summarize(updated, CollectionAccountItems, false));
  });

  this.on("uploadSocialSecurity", async (req) => {
    const employee = await authenticatedEmployee(req, Empleados);
    const account = await ownedAccount(req, req.data?.accountID, employee.ID, CollectionAccounts);
    if (!OWNER_STATES.has(account.status)) reject(req, 409, "SOPORTE_BLOQUEADO", "El soporte no se puede modificar en el estado actual.");
    const content = await streamToBuffer(req.data?.content);
    if (!content.length) reject(req, 400, "ARCHIVO_VACIO", "Selecciona un archivo con contenido.");
    if (content.length > 15 * 1024 * 1024) reject(req, 413, "ARCHIVO_GRANDE", "El soporte no puede superar 15 MB.");
    const mime = clean(req.data?.mimeType) || "application/octet-stream";
    if (!new Set(["application/pdf", "image/jpeg", "image/png"]).has(mime))
      reject(req, 415, "TIPO_ARCHIVO_INVALIDO", "Carga el soporte en PDF, JPG o PNG.");
    await scan(req, content);
    const now = new Date().toISOString();
    await UPDATE(CollectionAccounts).set({
      socialSecurityFileName: clean(req.data?.fileName)?.slice(0, 255) || "soporte-seguridad-social",
      socialSecurityMimeType: mime,
      socialSecurityContent: content,
      socialSecurityHash: sha256(content),
      socialSecurityStatus: "CLEAN",
      socialSecurityUploadedAt: now,
    }).where({ ID: account.ID });
    await event(cds.tx(req), CollectionAccountEvents, account.ID, "SOCIAL_SECURITY_UPLOADED", identity(req), account.socialSecurityRequirement === "AFFILIATION" ? "Soporte de afiliación como independiente." : "Comprobante PILA del periodo anterior.");
    const updated = await SELECT.one.from(CollectionAccounts).where({ ID: account.ID });
    return result("El soporte fue cargado y validado.", await summarize(updated, CollectionAccountItems, false));
  });

  this.on("submitAccount", async (req) => {
    const employee = await authenticatedEmployee(req, Empleados);
    const account = await ownedAccount(req, req.data?.accountID, employee.ID, CollectionAccounts);
    if (!SUBMITTABLE_STATES.has(account.status)) reject(req, 409, "CUENTA_NO_FIRMADA", "Primero debes firmar la cuenta de cobro.");
    if (account.socialSecurityStatus !== "CLEAN" || !account.socialSecurityFileName)
      reject(req, 409, "SOPORTE_REQUERIDO", account.socialSecurityRequirement === "AFFILIATION"
        ? "Para el primer cobro debes adjuntar el soporte de afiliación como independiente."
        : "Debes adjuntar el comprobante PILA del periodo anterior.");
    const now = new Date().toISOString();
    await UPDATE(CollectionAccounts).set({ status: "SUBMITTED", submittedAt: now }).where({ ID: account.ID });
    await event(cds.tx(req), CollectionAccountEvents, account.ID, "SUBMITTED", identity(req), "Cuenta firmada y soporte enviados para revisión de RR. HH.");

    const items = await SELECT.from(CollectionAccountItems).where({ account_ID: account.ID });
    const submissionCycle = await nextApprovalCycle(req, account.ID, PROCESS_CODES.COLLECTION_ACCOUNT);
    await startApproval(req, {
      processCode: PROCESS_CODES.COLLECTION_ACCOUNT,
      businessObjectType: BUSINESS_OBJECT_CUENTA,
      businessObjectID: account.ID,
      requesterEmployeeID: employee.ID,
      title: account.numero,
      summary: `Cuenta de cobro por ${formatMoney(account.grossAmount, account.currency)} correspondiente al periodo del ${formatDate(account.periodStart)} al ${formatDate(account.periodEnd)}.`,
      priority: "MEDIUM",
      route: "CuentasCobro-display",
      // El ciclo permite reenviar la cuenta tras una devolución de RR. HH.
      cycle: submissionCycle,
      idempotencyKey: `COLLECTION_ACCOUNT:${account.ID}:${submissionCycle}`,
      facts: accountFacts(account, items),
    });

    const updated = await SELECT.one.from(CollectionAccounts).where({ ID: account.ID });
    return result("La cuenta fue enviada al Centro de Aprobaciones de RR. HH.", await summarize(updated, CollectionAccountItems, false));
  });

  this.on("requestCorrection", async (req) => {
    const employee = await authenticatedEmployee(req, Empleados);
    const account = await ownedAccount(req, req.data?.accountID, employee.ID, CollectionAccounts);
    if (!new Set(["PENDING_SIGNATURE", "SIGNED", "HR_REJECTED"]).has(account.status))
      reject(req, 409, "CORRECCION_NO_PERMITIDA", "En este estado no se puede solicitar una corrección.");
    const reason = clean(req.data?.reason);
    if (!reason || reason.length < 10) reject(req, 400, "MOTIVO_REQUERIDO", "Explica la corrección solicitada con al menos 10 caracteres.");
    const now = new Date().toISOString();
    await UPDATE(CollectionAccounts).set({ status: "CORRECTION_REQUESTED", correctionReason: reason, correctionRequestedAt: now }).where({ ID: account.ID });
    await event(cds.tx(req), CollectionAccountEvents, account.ID, "CORRECTION_REQUESTED", identity(req), reason);

    const cycle = await nextApprovalCycle(req, account.ID, PROCESS_CODES.COLLECTION_ACCOUNT_CORRECTION);
    await startApproval(req, {
      processCode: PROCESS_CODES.COLLECTION_ACCOUNT_CORRECTION,
      businessObjectType: BUSINESS_OBJECT_CUENTA,
      businessObjectID: account.ID,
      requesterEmployeeID: employee.ID,
      title: account.numero,
      summary: reason,
      priority: "HIGH",
      route: "CuentasCobro-display",
      cycle,
      idempotencyKey: `COLLECTION_ACCOUNT_CORRECTION:${account.ID}:${cycle}`,
      facts: [
        { section: "Cuenta", key: "account", label: "Cuenta", value: account.numero, order: 10 },
        { section: "Cuenta", key: "provider", label: "Prestador", value: account.employeeNameSnapshot, order: 20 },
        { section: "Cuenta", key: "period", label: "Periodo", value: `${formatDate(account.periodStart)} al ${formatDate(account.periodEnd)}`, order: 30 },
        { section: "Cuenta", key: "amount", label: "Valor bruto", value: formatMoney(account.grossAmount, account.currency), order: 40 },
        { section: "Corrección", key: "reason", label: "Motivo", value: reason, order: 50, semanticColor: "WARNING" },
      ],
    });

    const updated = await SELECT.one.from(CollectionAccounts).where({ ID: account.ID });
    return result("La solicitud de corrección fue enviada al Centro de Aprobaciones.", await summarize(updated, CollectionAccountItems, false));
  });

  this.on("cancelDraft", async (req) => {
    const employee = await authenticatedEmployee(req, Empleados);
    const account = await ownedAccount(req, req.data?.accountID, employee.ID, CollectionAccounts);
    if (!new Set(["PENDING_SIGNATURE", "SIGNED", "HR_REJECTED"]).has(account.status)) reject(req, 409, "CANCELACION_NO_PERMITIDA", "Solo se pueden cancelar cuentas que aún no han sido aprobadas por RR. HH.");
    await UPDATE(CollectionAccounts).set({ status: "CANCELLED" }).where({ ID: account.ID });
    await event(cds.tx(req), CollectionAccountEvents, account.ID, "CANCELLED", identity(req), "Cancelada por el prestador.");
    const updated = await SELECT.one.from(CollectionAccounts).where({ ID: account.ID });
    return result("La cuenta fue cancelada.", await summarize(updated, CollectionAccountItems, false));
  });

  this.on("downloadAccount", async (req) => {
    const account = await authorizedAccount(req, req.data?.accountID, CollectionAccounts, Empleados);
    const file = await SELECT.one.from(CollectionAccounts).columns("generatedFileName", "generatedMimeType", "generatedContent").where({ ID: account.ID });
    const content = await streamToBuffer(file?.generatedContent);
    if (!content?.length) reject(req, 409, "DOCUMENTO_NO_GENERADO", "La cuenta todavía no ha sido firmada y generada.");
    return { fileName: file.generatedFileName, mimeType: file.generatedMimeType, contentBase64: content.toString("base64") };
  });

  this.on("downloadSocialSecurity", async (req) => {
    const account = await authorizedAccount(req, req.data?.accountID, CollectionAccounts, Empleados);
    const file = await SELECT.one.from(CollectionAccounts).columns("socialSecurityFileName", "socialSecurityMimeType", "socialSecurityContent").where({ ID: account.ID });
    const content = await streamToBuffer(file?.socialSecurityContent);
    if (!content?.length) reject(req, 404, "SOPORTE_NO_ENCONTRADO", "La cuenta no tiene soporte de seguridad social.");
    return { fileName: file.socialSecurityFileName, mimeType: file.socialSecurityMimeType, contentBase64: content.toString("base64") };
  });

  this.on("getHRAccounts", async (req) => {
    const where = {};
    const from = req.data?.from;
    const to = req.data?.to;
    if (from) where.periodEnd = { ">=": from };
    if (to) where.periodStart = { "<=": to };
    if (req.data?.status) where.status = req.data.status;
    const rows = await SELECT.from(CollectionAccounts).where(where).orderBy("periodStart desc", "employeeNameSnapshot");
    return Promise.all(rows.map((row) => summarize(row, CollectionAccountItems, true)));
  });

  /**
   * Recordatorios de generación de la cuenta de cobro.
   *
   * Se avisa dos veces por periodo: el día en que abre (el siguiente al cierre
   * del ciclo) y tres días después si la cuenta sigue sin generarse. Solo se
   * notifica a quien ya puede facturar —horas aprobadas, contrato y cuenta
   * bancaria en orden— para no avisar a alguien que todavía no puede hacer nada.
   *
   * La idempotencia vive en la clave de la outbox, así que repetir la
   * ejecución del mismo día no vuelve a enviar nada.
   */
  this.on("enviarRecordatoriosCuentaCobro", async (req) => {
    const referenceDate = clean(req.data?.fecha) || todayColombia();
    const tx = cds.tx(req);
    const approval = cds.entities("sabnez.approvals");

    const providers = await SELECT.from(Empleados)
      .columns("ID", "nombreCompleto", "correoCorporativo", "generaCuentaCobro", "estado_codigo")
      .where({ generaCuentaCobro: true, estado_codigo: "AC" });

    let dueSent = 0;
    let overdueSent = 0;
    let skipped = 0;

    // Una sola lectura del parámetro para todo el lote: no cambia a mitad de
    // la corrida y así el job no consulta la configuración por cada prestador.
    const corteGlobal = await parametro(req, PARAM_CUENTAS_DESDE);

    for (const employee of providers) {
      if (!employee.correoCorporativo) { skipped += 1; continue; }

      const periods = (await eligiblePeriods(employee, {
        Contratos, CuentasBancarias, ProjectAssignments, AssignmentRates,
        TimeEntries, CollectionAccounts, CollectionAccountItems,
      }, { corteGlobal })).filter((period) => period.eligible);

      if (!periods.length) { skipped += 1; continue; }

      // El periodo queda disponible el día siguiente a su cierre.
      const due = periods.filter((period) => addDays(period.periodEnd, 1) === referenceDate);
      const overdue = periods.filter((period) => addDays(period.periodEnd, DIAS_INSISTENCIA + 1) === referenceDate);

      if (due.length) {
        const enviado = await queueReminder(tx, approval, employee, due, "COLLECTION_ACCOUNT_DUE", referenceDate);
        if (enviado) dueSent += 1;
      }
      if (overdue.length) {
        const enviado = await queueReminder(tx, approval, employee, overdue, "COLLECTION_ACCOUNT_OVERDUE", referenceDate);
        if (enviado) overdueSent += 1;
      }
      if (!due.length && !overdue.length) skipped += 1;
    }

    return {
      success: true,
      message: `Recordatorios del ${referenceDate}: ${dueSent} de apertura y ${overdueSent} de insistencia sobre ${providers.length} prestador(es).`,
      referenceDate,
      dueSent,
      overdueSent,
      skipped,
    };
  });

  /**
   * Cuentas aprobadas que pueden salir hacia contabilidad. Devuelve también
   * las que no están listas, con el motivo, para que RR. HH. lo vea antes de
   * enviar en vez de descubrirlo en el resultado.
   */
  this.on("getAccountingCandidates", async (req) => {
    const where = { status: { in: ["HR_APPROVED", "SENT_TO_ACCOUNTING"] } };
    if (req.data?.from) where.periodEnd = { ">=": req.data.from };
    if (req.data?.to) where.periodStart = { "<=": req.data.to };

    const rows = await SELECT.from(CollectionAccounts)
      .where(where)
      .orderBy("periodStart desc", "employeeNameSnapshot");

    const incluirEnviadas = req.data?.includeSent !== false;

    return rows
      .filter((row) => incluirEnviadas || row.status !== "SENT_TO_ACCOUNTING")
      .map((row) => {
        const hasDocument = Boolean(row.generatedFileName);
        const hasSocialEvidence = socialSecuritySatisfied(row);
        const yaEnviada = row.status === "SENT_TO_ACCOUNTING";
        const blockingReason = yaEnviada
          ? `Ya se envió a ${row.accountingRecipient || "contabilidad"} el ${formatDate(String(row.accountingSentAt || "").slice(0, 10))}.`
          : !hasDocument
            ? "La cuenta no tiene el documento firmado generado."
            : !hasSocialEvidence
              ? "Falta el soporte de seguridad social validado."
              : null;

        return {
          ID: row.ID,
          number: row.numero,
          employeeName: row.employeeNameSnapshot,
          documentNumber: row.documentNumberSnapshot,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          grossAmount: row.grossAmount,
          currency: row.currency,
          status: row.status,
          statusText: STATUS_TEXT[row.status] || row.status,
          hasDocument,
          hasSocialEvidence,
          socialRequirementText: requirementText(row.socialSecurityRequirement),
          readyToSend: !blockingReason,
          blockingReason,
          approvedAt: row.hrReviewedAt,
          accountingSentAt: row.accountingSentAt,
          accountingRecipient: row.accountingRecipient,
        };
      });
  });

  /**
   * Empaqueta las cuentas seleccionadas y se las manda a contabilidad en un
   * solo correo con un ZIP. Al terminar deja las cuentas en
   * SENT_TO_ACCOUNTING, que es lo que impide reenviarlas.
   */
  this.on("enviarCuentasAContabilidad", async (req) => {
    const IDs = [...new Set((req.data?.accountIDs || []).filter(Boolean))];
    if (!IDs.length) reject(req, 400, "SELECCION_VACIA", "Selecciona al menos una cuenta de cobro.");

    const destinatario = await parametro(req, "CONTABILIDAD_EMAIL");
    if (!destinatario)
      reject(req, 409, "CONTABILIDAD_SIN_CORREO", "No hay un correo de contabilidad configurado en los parámetros.");

    // CAP omite los LargeBinary en un SELECT general. El ZIP necesita pedir
    // expresamente ambos contenidos; de lo contrario solo llegan los nombres
    // de archivo y el expediente se interpreta erróneamente como incompleto.
    const cuentas = await SELECT.from(CollectionAccounts)
      .columns("*", "generatedContent", "socialSecurityContent")
      .where({ ID: { in: IDs } });
    if (cuentas.length !== IDs.length)
      reject(req, 404, "CUENTA_NO_ENCONTRADA", "Alguna de las cuentas seleccionadas ya no existe.");

    // Solo salen expedientes aprobados: la contadora valida para pagar, no
    // para opinar sobre cuentas que todavía pueden devolverse.
    const noAprobadas = cuentas.filter((row) => row.status !== "HR_APPROVED");
    if (noAprobadas.length)
      reject(req, 409, "CUENTA_NO_APROBADA",
        `${noAprobadas.length} cuenta(s) no están aprobadas para pago o ya fueron enviadas: ${noAprobadas.map((row) => row.numero).join(", ")}.`);

    const { buffer, incluidos, omitidos } = await buildAccountingZip(cuentas);
    if (!incluidos.length)
      reject(req, 409, "EXPEDIENTES_INCOMPLETOS",
        `Ninguna cuenta tiene el expediente completo. ${omitidos.map((row) => `${row.numero}: ${row.motivo}`).join(" ")}`);

    if (buffer.length > LIMITE_ADJUNTO_BYTES)
      reject(req, 413, "PAQUETE_DEMASIADO_GRANDE",
        `El paquete pesa ${Math.round(buffer.length / 1048576)} MB y supera el límite de correo. Envía el periodo en dos lotes más pequeños.`);

    const currency = incluidos[0].currency || "COP";
    const total = roundMoney(incluidos.reduce((suma, row) => suma + Number(row.grossAmount || 0), 0));
    const desde = incluidos.reduce((min, row) => (row.periodStart < min ? row.periodStart : min), incluidos[0].periodStart);
    const hasta = incluidos.reduce((max, row) => (row.periodEnd > max ? row.periodEnd : max), incluidos[0].periodEnd);
    const periodo = `${formatDate(desde)} al ${formatDate(hasta)}`;
    const remitente = identity(req);
    const batchID = `CTB-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${cds.utils.uuid().slice(0, 6).toUpperCase()}`;

    const correo = buildAccountingEmail({ cuentas: incluidos, periodo, remitente, total, currency });
    await sendMail({
      to: destinatario,
      subject: correo.subject,
      html: correo.html,
      attachments: [{
        name: `cuentas-de-cobro-${batchID}.zip`,
        contentType: "application/zip",
        content: buffer,
      }],
    });

    // El correo ya salió: marcar después evita dejar cuentas como enviadas
    // cuando el envío falló.
    const now = new Date().toISOString();
    const tx = cds.tx(req);
    for (const cuenta of incluidos) {
      await tx.run(UPDATE(CollectionAccounts).set({
        status: "SENT_TO_ACCOUNTING",
        accountingSentAt: now,
        accountingSentBy: remitente,
        accountingRecipient: destinatario,
        accountingBatchID: batchID,
      }).where({ ID: cuenta.ID, status: "HR_APPROVED" }));
      await event(tx, CollectionAccountEvents, cuenta.ID, "SENT_TO_ACCOUNTING", remitente,
        `Expediente enviado a ${destinatario} en el lote ${batchID}.${clean(req.data?.nota) ? ` Nota: ${clean(req.data.nota)}` : ""}`);
    }

    return {
      success: true,
      message: omitidos.length
        ? `Se enviaron ${incluidos.length} cuenta(s) a ${destinatario}. ${omitidos.length} quedaron fuera por expediente incompleto.`
        : `Se enviaron ${incluidos.length} cuenta(s) de cobro a ${destinatario}.`,
      recipient: destinatario,
      batchID,
      sentCount: incluidos.length,
      skippedCount: omitidos.length,
      totalAmount: total,
      currency,
      zipSizeBytes: buffer.length,
      skipped: omitidos.map((row) => ({ number: row.numero, reason: row.motivo })),
    };
  });

  // --- Parámetros ---------------------------------------------------------
  this.on("getParametros", async (req) => {
    const where = clean(req.data?.grupo) ? { grupo: req.data.grupo } : {};
    return SELECT.from(Parametros).where(where).orderBy("grupo", "nombre");
  });

  this.on("guardarParametro", async (req) => {
    const clave = clean(req.data?.clave);
    if (!clave) reject(req, 400, "CLAVE_REQUERIDA", "Indica el parámetro a modificar.");
    const fila = await SELECT.one.from(Parametros).where({ clave });
    if (!fila) reject(req, 404, "PARAMETRO_NO_EXISTE", `El parámetro ${clave} no existe.`);

    const valor = clean(req.data?.valor);
    if (fila.tipo === "EMAIL" && valor && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(valor))
      reject(req, 400, "CORREO_INVALIDO", "Escribe una dirección de correo válida.", "valor");
    if (fila.tipo === "NUMBER" && valor && Number.isNaN(Number(valor)))
      reject(req, 400, "NUMERO_INVALIDO", "El parámetro espera un número.", "valor");

    await UPDATE(Parametros).set({ valor }).where({ clave });
    return {
      success: true,
      message: `El parámetro ${fila.nombre} quedó actualizado.`,
      parametro: await SELECT.one.from(Parametros).where({ clave }),
    };
  });

  this.on("downloadHRReport", async (req) => {
    const where = {};
    if (req.data?.from) where.periodEnd = { ">=": req.data.from };
    if (req.data?.to) where.periodStart = { "<=": req.data.to };
    if (req.data?.status) where.status = req.data.status;
    const rows = await SELECT.from(CollectionAccounts).where(where).orderBy("periodStart", "employeeNameSnapshot");
    const header = ["Número", "Prestador", "Documento", "Desde", "Hasta", "Valor bruto", "Moneda", "Estado", "Soporte", "Firma", "Enviada", "Aprobada", "Enviada a contabilidad", "Lote"];
    const lines = [header, ...rows.map((row) => [row.numero, row.employeeNameSnapshot, `${row.documentTypeSnapshot || ""} ${row.documentNumberSnapshot || ""}`.trim(), row.periodStart, row.periodEnd, row.grossAmount, row.currency, STATUS_TEXT[row.status] || row.status, row.socialSecurityFileName || "", row.signedAt || "", row.submittedAt || "", row.hrReviewedAt || "", row.accountingSentAt || "", row.accountingBatchID || ""])];
    const csv = lines.map((line) => line.map(csvCell).join(";")).join("\n");
    return { fileName: `reporte-cuentas-cobro-${req.data?.from || "inicio"}-${req.data?.to || "hoy"}.csv`, mimeType: "text/csv;charset=utf-8", contentBase64: Buffer.from(`\ufeff${csv}`, "utf8").toString("base64") };
  });
});

async function recalculateExistingAccount(req, account, entities) {
  const items = await SELECT.from(entities.CollectionAccountItems).where({ account_ID: account.ID });
  let total = 0;
  for (const item of items) {
    const assignment = await SELECT.one.from(entities.ProjectAssignments).columns(
      "ID", "validFrom", "validTo", "commercialAllocation",
      "project.modality as modality", "project.currency as currency",
      "project.workCalendar_ID as workCalendarID",
    ).where({ ID: item.assignment_ID });
    if (!assignment) reject(req, 409, "ASIGNACION_NO_ENCONTRADA", `La asignación de ${item.projectName} ya no existe.`);
    const entries = await SELECT.from(entities.TimeEntries).columns("durationHours", "payableHours", "status").where({
      assignment_ID: item.assignment_ID,
      workDate: { between: item.serviceStart, and: item.serviceEnd },
    });
    const pending = entries.filter((entry) => !APPROVED_ENTRY_STATES.has(entry.status));
    if (!entries.length || pending.length) reject(req, 409, "TIEMPOS_NO_APROBADOS", `No se puede recalcular ${item.projectName}: sus horas no tienen aprobación final.`);
    const hours = round(entries.reduce((sum, row) => sum + Number(row.payableHours ?? row.durationHours ?? 0), 0));
    const rate = await effectiveRate(entities.AssignmentRates, assignment.ID, item.serviceStart, item.serviceEnd);
    const contract = await SELECT.one.from(entities.Contratos).where({ ID: account.contract_ID });
    const cycle = collectionCycleContaining(item.serviceStart, contract?.diaInicioCuentaCobro || 1);
    const calendar = (await loadCalendars([assignment.workCalendarID])).get(assignment.workCalendarID);
    const calculated = calculateAmount(assignment, {
      start: item.serviceStart,
      end: item.serviceEnd,
      cycleStart: cycle.start,
      cycleEnd: cycle.end,
      calendar,
    }, hours, rate, contract);
    if (!calculated.amount) reject(req, 409, "HONORARIO_NO_CONFIGURADO", calculated.reason || `No fue posible calcular ${item.projectName}.`);
    await UPDATE(entities.CollectionAccountItems).set({
      approvedHours: hours,
      unitRate: calculated.rate || null,
      amount: calculated.amount,
      calculationMethod: calculated.method,
    }).where({ ID: item.ID });
    total += Number(calculated.amount);
  }
  return { total: roundMoney(total) };
}

/**
 * @param {object} [opciones]
 * @param {string} [opciones.corteGlobal] Fecha desde la que la plataforma
 *   gobierna las cuentas de cobro (parámetro CUENTAS_COBRO_DESDE). La fecha de
 *   corte del propio contrato, si existe, la sustituye.
 */
async function eligiblePeriods(employee, entities, opciones = {}) {
  const assignments = await SELECT.from(entities.ProjectAssignments).columns(
    "ID", "validFrom", "validTo", "status", "commercialAllocation",
    "project_ID", "project.code as projectCode", "project.name as projectName",
    "project.modality as modality", "project.currency as currency",
    "project.workCalendar_ID as workCalendarID",
    "project.client.tradeName as clientTradeName", "project.client.legalName as clientLegalName",
  ).where({ employee_ID: employee.ID, status: { in: ["ACTIVE", "CLOSED", "INACTIVE"] } });
  const existingItems = assignments.length ? await SELECT.from(entities.CollectionAccountItems).columns(
    "assignment_ID", "serviceStart", "serviceEnd", "account.status as accountStatus",
  ).where({ assignment_ID: { in: assignments.map((row) => row.ID) } }) : [];
  const claimed = new Set(existingItems.filter((row) => !TERMINAL_CLAIM_STATES.has(row.accountStatus)).map((row) => periodKey(row.assignment_ID, row.serviceStart, row.serviceEnd)));
  const contracts = await SELECT.from(entities.Contratos).where({ empleado_ID: employee.ID, tipoContrato_codigo: "PS" }).orderBy("fechaInicio desc");
  const banks = await SELECT.from(entities.CuentasBancarias).where({ empleado_ID: employee.ID, principal: true, activa: true });
  const today = todayColombia();
  const calendars = await loadCalendars(assignments.map((row) => row.workCalendarID));
  const output = [];
  for (const assignment of assignments) {
    const applicable = contracts.filter((contract) =>
      overlaps(contract.fechaInicio, contract.fechaFin, assignment.validFrom, assignment.validTo),
    );
    const periods = applicable.flatMap((contract) => {
      const base = contract.fechaInicio > assignment.validFrom ? contract.fechaInicio : assignment.validFrom;
      // Los periodos anteriores a la entrada en vigor de la aplicación ya se
      // cobraron por fuera: el corte sólo puede retrasar el arranque, nunca
      // adelantarlo, por eso se toma el mayor de los tres.
      const corte = contract.fechaCorteCuentaCobro || opciones.corteGlobal;
      const validFrom = corte && base && corte > base ? corte : base;
      const possibleEnds = [contract.fechaFin, assignment.validTo].filter(Boolean).sort();
      const validTo = possibleEnds[0] || null;
      return completedCollectionCycles(
        validFrom,
        validTo,
        today,
        contract.diaInicioCuentaCobro || 1,
      ).map((period) => ({ ...period, contract }));
    });
    for (const period of periods) {
      const key = periodKey(assignment.ID, period.start, period.end);
      const overlapsExisting = existingItems.some((item) =>
        item.assignment_ID === assignment.ID &&
        !TERMINAL_CLAIM_STATES.has(item.accountStatus) &&
        overlaps(item.serviceStart, item.serviceEnd, period.start, period.end),
      );
      if (claimed.has(key) || overlapsExisting) continue;
      const entries = await SELECT.from(entities.TimeEntries).columns("ID", "durationHours", "payableHours", "status").where({ assignment_ID: assignment.ID, workDate: { between: period.start, and: period.end } });
      const unapproved = entries.filter((entry) => !APPROVED_ENTRY_STATES.has(entry.status));
      const approvedHours = round(entries.reduce((sum, row) => sum + Number(row.payableHours ?? row.durationHours ?? 0), 0));
      const contract = period.contract;
      const rate = await effectiveRate(entities.AssignmentRates, assignment.ID, period.start, period.end);
      const calculated = calculateAmount(
        assignment,
        { ...period, calendar: calendars.get(assignment.workCalendarID) },
        approvedHours,
        rate,
        contract,
      );
      let blockingReason = null;
      if (!contract) blockingReason = "No existe un contrato de prestación de servicios vigente para este periodo.";
      else if (!banks.length) blockingReason = "No existe una cuenta bancaria principal activa en Gestión de empleados.";
      else if (!entries.length) blockingReason = "El periodo todavía no tiene horas registradas.";
      else if (unapproved.length) blockingReason = `${unapproved.length} registro(s) de tiempo todavía no tienen aprobación final.`;
      else if (!calculated.amount) blockingReason = calculated.reason;
      else if (
        calculated.method === "CONTRACT_MONTHLY_FEE" &&
        assignments.some((other) =>
          other.ID !== assignment.ID &&
          overlaps(other.validFrom, other.validTo, period.start, period.end),
        )
      ) {
        blockingReason = "El prestador tiene varias asignaciones en este periodo. Configura el costo interno mensual de cada asignación para distribuir los honorarios sin duplicarlos.";
      }
      const securityRequirement = await securityRequirementFor(employee.ID, period.start, entities.CollectionAccounts);
      output.push({
        periodKey: key,
        assignmentID: assignment.ID,
        projectCode: assignment.projectCode,
        projectName: assignment.projectName,
        clientName: assignment.clientTradeName || assignment.clientLegalName,
        modality: assignment.modality,
        periodStart: period.start,
        periodEnd: period.end,
        approvedHours,
        amount: calculated.amount || 0,
        currency: calculated.currency || contract?.moneda || assignment.currency || "COP",
        calculationMethod: calculated.method,
        eligible: !blockingReason,
        blockingReason,
        securityRequirement,
        securityRequirementText: requirementText(securityRequirement),
        contractID: contract?.ID,
        calculationRate: calculated.rate,
        concept: `Servicios profesionales en ${assignment.projectName} (${period.start} a ${period.end})`,
      });
    }
  }
  return output.sort((a, b) => b.periodStart.localeCompare(a.periodStart) || a.projectName.localeCompare(b.projectName, "es"));
}

async function createAccount(tx, employee, candidates, req, entities) {
  const contractID = candidates[0].contractID;
  if (candidates.some((row) => row.contractID !== contractID)) reject(req, 409, "CONTRATOS_DIFERENTES", "Solo se pueden combinar conceptos pertenecientes al mismo contrato de prestación de servicios.");
  const currencies = [...new Set(candidates.map((row) => row.currency))];
  if (currencies.length !== 1) reject(req, 409, "MONEDAS_DIFERENTES", "No se pueden combinar conceptos expresados en monedas diferentes.");
  const bank = await SELECT.one.from(entities.CuentasBancarias).where({ empleado_ID: employee.ID, principal: true, activa: true });
  if (!bank) reject(req, 409, "CUENTA_BANCARIA_REQUERIDA", "Configura una cuenta bancaria principal activa antes de generar la cuenta.");
  const periodStart = candidates.map((row) => row.periodStart).sort()[0];
  const periodEnd = candidates.map((row) => row.periodEnd).sort().at(-1);
  const securityRequirement = await securityRequirementFor(employee.ID, periodStart, entities.CollectionAccounts);
  const ID = cds.utils.uuid();
  const account = {
    ID,
    numero: accountNumber(periodEnd, ID),
    employee_ID: employee.ID,
    contract_ID: contractID,
    periodStart,
    periodEnd,
    currency: currencies[0],
    grossAmount: roundMoney(candidates.reduce((sum, row) => sum + Number(row.amount || 0), 0)),
    status: "PENDING_SIGNATURE",
    combined: candidates.length > 1,
    employeeNameSnapshot: employee.nombreCompleto,
    documentTypeSnapshot: employee.tipoDocumento,
    documentNumberSnapshot: employee.numeroDocumento,
    documentCitySnapshot: employee.lugarExpedicionDocumento,
    taxAddressSnapshot: employee.direccionTributaria,
    taxCitySnapshot: employee.ciudadTributaria,
    bankNameSnapshot: bank.banco,
    bankAccountTypeSnapshot: bank.tipoCuenta,
    bankAccountNumberSnapshot: bank.numeroCuenta,
    bankHolderSnapshot: bank.titularNombre,
    socialSecurityRequirement: securityRequirement,
    socialSecurityStatus: "PENDING",
  };
  await tx.run(INSERT.into(entities.CollectionAccounts).entries(account));
  await tx.run(INSERT.into(entities.CollectionAccountItems).entries(candidates.map((row) => ({
    ID: cds.utils.uuid(), account_ID: ID, assignment_ID: row.assignmentID,
    serviceStart: row.periodStart, serviceEnd: row.periodEnd,
    clientName: row.clientName, projectCode: row.projectCode, projectName: row.projectName,
    modality: row.modality, concept: row.concept, approvedHours: row.approvedHours,
    unitRate: row.calculationRate || null, amount: row.amount, calculationMethod: row.calculationMethod,
  }))));
  await event(tx, entities.CollectionAccountEvents, ID, "CREATED", identity(req), `${candidates.length} concepto(s), valor bruto ${formatMoney(account.grossAmount, account.currency)}.`);
  return account;
}

function calculateAmount(assignment, period, hours, rate, contract) {
  const currency = rate?.currency || contract?.moneda || assignment.currency || "COP";
  if (assignment.modality === "HOURLY") {
    const unit = Number(rate?.internalHourlyCost || 0);
    return unit > 0
      ? { amount: roundMoney(hours * unit), rate: unit, currency, method: "APPROVED_HOURS" }
      : { amount: 0, currency, method: "APPROVED_HOURS", reason: "Falta configurar el costo interno por hora de la asignación." };
  }
  if (assignment.modality === "MIXED" && Number(rate?.internalHourlyCost || 0) > 0) {
    const unit = Number(rate.internalHourlyCost);
    return { amount: roundMoney(hours * unit), rate: unit, currency, method: "APPROVED_HOURS" };
  }
  const internalMonthly = Number(rate?.internalMonthlyCost || 0);
  const monthly = internalMonthly || Number(contract?.salario || 0);
  if (!monthly) return { amount: 0, currency, method: "MONTHLY_FEE", reason: "Falta configurar el honorario mensual de la asignación o del contrato." };
  const fullPeriod = period.start === period.cycleStart && period.end === period.cycleEnd;
  if (fullPeriod) {
    return {
      amount: roundMoney(monthly),
      rate: monthly,
      currency,
      method: internalMonthly ? "MONTHLY_FEE" : "CONTRACT_MONTHLY_FEE",
    };
  }
  if (!period.calendar) {
    return {
      amount: 0,
      currency,
      method: "PRORATED_MONTHLY_FEE",
      reason: "El proyecto no tiene un calendario laboral activo para calcular el proporcional del honorario.",
    };
  }
  const fullDays = businessDaysBetween(period.calendar, period.cycleStart, period.cycleEnd);
  const serviceDays = businessDaysBetween(period.calendar, period.start, period.end);
  if (fullDays <= 0 || serviceDays <= 0) {
    return {
      amount: 0,
      currency,
      method: "PRORATED_MONTHLY_FEE",
      reason: "El calendario laboral no contiene días hábiles para este periodo.",
    };
  }
  const method = internalMonthly ? "PRORATED_MONTHLY_FEE" : "PRORATED_CONTRACT_MONTHLY_FEE";
  return {
    amount: roundMoney(monthly * serviceDays / fullDays),
    rate: monthly,
    currency,
    method,
  };
}

async function effectiveRate(AssignmentRates, assignmentID, from, to) {
  const rows = await SELECT.from(AssignmentRates).where({ assignment_ID: assignmentID }).orderBy("validFrom desc");
  return rows.find((row) => overlaps(row.validFrom, row.validTo, from, to));
}

async function securityRequirementFor(employeeID, periodStart, CollectionAccounts) {
  const prior = await SELECT.one.from(CollectionAccounts).columns("ID").where({ employee_ID: employeeID, periodEnd: { "<": periodStart }, status: { "not in": ["CANCELLED", "HR_REJECTED"] } });
  return prior ? "PILA" : "AFFILIATION";
}

async function authenticatedEmployee(req, Empleados, required = true) {
  const email = identity(req);
  const columns = ["ID", "nombreCompleto", "correoCorporativo", "tipoDocumento", "numeroDocumento", "lugarExpedicionDocumento", "direccionTributaria", "ciudadTributaria", "generaCuentaCobro"];
  let employee = email ? await SELECT.one.from(Empleados).columns(...columns).where({ correoCorporativo: email }) : null;
  if (!employee && email) employee = (await SELECT.from(Empleados).columns(...columns)).find((row) => normalize(row.correoCorporativo) === normalize(email));
  if (!employee && required) reject(req, 403, "EMPLEADO_NO_ASOCIADO", `No existe un empleado asociado a ${email || "este usuario"}.`);
  return employee;
}

async function ownedAccount(req, ID, employeeID, CollectionAccounts) {
  if (!ID) reject(req, 400, "CUENTA_REQUERIDA", "Debes indicar la cuenta de cobro.");
  const account = await SELECT.one.from(CollectionAccounts).where({ ID });
  if (!account) reject(req, 404, "CUENTA_NO_ENCONTRADA", "La cuenta de cobro no existe.");
  if (account.employee_ID !== employeeID) reject(req, 403, "CUENTA_NO_AUTORIZADA", "La cuenta no pertenece al usuario autenticado.");
  return account;
}

async function authorizedAccount(req, ID, CollectionAccounts, Empleados) {
  const account = await SELECT.one.from(CollectionAccounts).where({ ID });
  if (!account) reject(req, 404, "CUENTA_NO_ENCONTRADA", "La cuenta de cobro no existe.");
  if (hasHRRole(req)) return account;
  const employee = await authenticatedEmployee(req, Empleados);
  if (account.employee_ID !== employee.ID) reject(req, 403, "CUENTA_NO_AUTORIZADA", "La cuenta no pertenece al usuario autenticado.");
  return account;
}

async function summarize(row, Items, isHR) {
  const items = await SELECT.from(Items).columns("ID").where({ account_ID: row.ID });
  return {
    ID: row.ID, number: row.numero, employeeName: row.employeeNameSnapshot,
    periodStart: row.periodStart, periodEnd: row.periodEnd,
    grossAmount: row.grossAmount, currency: row.currency, status: row.status,
    statusText: STATUS_TEXT[row.status] || row.status, combined: Boolean(row.combined),
    itemCount: items.length, socialRequirement: row.socialSecurityRequirement,
    socialRequirementText: requirementText(row.socialSecurityRequirement),
    hasSocialEvidence: socialSecuritySatisfied(row),
    canSign: new Set(["PENDING_SIGNATURE", "HR_REJECTED"]).has(row.status),
    canSubmit: row.status === "SIGNED" && socialSecuritySatisfied(row),
    canRequestCorrection: new Set(["PENDING_SIGNATURE", "SIGNED", "HR_REJECTED"]).has(row.status),
    canCancel: new Set(["PENDING_SIGNATURE", "SIGNED", "HR_REJECTED"]).has(row.status),
    canHRApprove: Boolean(isHR && HR_REVIEW_STATES.has(row.status)),
    origin: row.origin || "SELF_SERVICE",
    originText: ORIGIN_TEXT[row.origin] || row.origin || ORIGIN_TEXT.SELF_SERVICE,
    preparedByUserID: row.preparedByUserID,
    signatureMethod: row.signatureMethod,
    createdAt: row.createdAt, signedAt: row.signedAt, submittedAt: row.submittedAt, hrReviewedAt: row.hrReviewedAt,
  };
}

async function detail(row, entities, isHR) {
  const items = await SELECT.from(entities.CollectionAccountItems).where({ account_ID: row.ID }).orderBy("serviceStart", "projectName");
  const events = await SELECT.from(entities.CollectionAccountEvents).where({ account_ID: row.ID }).orderBy("occurredAt desc");
  return {
    summary: await summarize(row, entities.CollectionAccountItems, isHR),
    documentType: row.documentTypeSnapshot, documentNumber: row.documentNumberSnapshot,
    documentCity: row.documentCitySnapshot, taxAddress: row.taxAddressSnapshot, taxCity: row.taxCitySnapshot,
    bankName: row.bankNameSnapshot, bankAccountType: row.bankAccountTypeSnapshot,
    bankAccountNumber: row.bankAccountNumberSnapshot, bankHolder: row.bankHolderSnapshot,
    correctionReason: row.correctionReason, hrComment: row.hrComment,
    items: items.map((item) => ({ ID: item.ID, projectCode: item.projectCode, projectName: item.projectName, clientName: item.clientName, modality: item.modality, concept: item.concept, serviceStart: item.serviceStart, serviceEnd: item.serviceEnd, approvedHours: item.approvedHours, unitRate: item.unitRate, amount: item.amount, calculationMethod: item.calculationMethod })),
    events: events.map((item) => ({ ID: item.ID, type: item.type, typeText: EVENT_TEXT[item.type] || item.type, actorUserID: item.actorUserID, detail: item.detail, occurredAt: item.occurredAt })),
  };
}

/**
 * Siguiente ciclo de aprobación del objeto. Una cuenta devuelta y reenviada
 * necesita una instancia nueva, y la clave única del orquestador incluye el
 * ciclo, así que se cuenta lo ya existente.
 */
/**
 * Encola un recordatorio en la outbox durable. Un solo mensaje por prestador y
 * día agrupa todos sus periodos pendientes, en vez de un correo por proyecto.
 *
 * @returns {Promise<boolean>} false si ya se había encolado el mismo aviso.
 */
async function queueReminder(tx, approval, employee, periods, type, referenceDate) {
  const total = periods.reduce((sum, period) => sum + Number(period.amount || 0), 0);
  const horas = periods.reduce((sum, period) => sum + Number(period.approvedHours || 0), 0);
  const currency = periods[0].currency || "COP";
  const desde = periods.reduce((min, period) => (period.periodStart < min ? period.periodStart : min), periods[0].periodStart);
  const hasta = periods.reduce((max, period) => (period.periodEnd > max ? period.periodEnd : max), periods[0].periodEnd);
  const proyectos = [...new Set(periods.map((period) => period.projectName).filter(Boolean))];
  const insistencia = type === "COLLECTION_ACCOUNT_OVERDUE";

  const facts = [
    { etiqueta: "Periodo", valor: `${formatShortDate(desde)} al ${formatShortDate(hasta)}`, orden: 10 },
    insistencia
      ? { etiqueta: "Días transcurridos", valor: `${DIAS_INSISTENCIA} días`, orden: 20, semanticColor: "WARNING" }
      : null,
    { etiqueta: "Horas aprobadas", valor: `${formatNumber(horas)} h`, orden: 30 },
    { etiqueta: "Valor estimado", valor: formatMoney(total, currency), orden: 40 },
    proyectos.length ? { etiqueta: "Proyectos", valor: proyectos.join(", "), orden: 50 } : null,
    !insistencia
      ? { etiqueta: "Soporte requerido", valor: requirementText(periods[0].securityRequirement), orden: 60 }
      : null,
  ].filter(Boolean);

  const encolado = await persistNotification(tx, approval, {
    type,
    recipientID: employee.correoCorporativo,
    processCode: PROCESS_CODES.COLLECTION_ACCOUNT,
    // Un aviso por prestador, tipo y fecha de referencia.
    idempotencyKey: `${type}:${employee.ID}:${referenceDate}`,
    payload: {
      recipientName: employee.nombreCompleto,
      titulo: `Periodo ${formatShortDate(desde)} – ${formatShortDate(hasta)}`,
      resumen: insistencia
        ? `El periodo lleva ${DIAS_INSISTENCIA} días abierto y tu cuenta de cobro por ${formatMoney(total, currency)} sigue sin generarse.`
        : `Tienes ${formatNumber(horas)} horas aprobadas por ${formatMoney(total, currency)} listas para facturar en el periodo que acaba de cerrar.`,
      diasTranscurridos: insistencia ? DIAS_INSISTENCIA : 0,
      facts,
    },
  });

  return Boolean(encolado);
}

/**
 * Lee un parámetro de configuración. Centraliza el acceso para que el día que
 * exista el centro de parametrizaciones solo cambie esta función.
 */
async function parametro(req, clave, porDefecto = null) {
  const { Parametros } = cds.entities("sabnez.config");
  const fila = await cds.tx(req).run(SELECT.one.from(Parametros).columns("valor").where({ clave }));
  return clean(fila?.valor) || porDefecto;
}

async function nextApprovalCycle(req, accountID, processCode) {
  const { ApprovalInstances } = cds.entities("sabnez.approvals");
  const previas = await cds.tx(req).run(
    SELECT.from(ApprovalInstances).columns("ID").where({
      processCode,
      businessObjectType: BUSINESS_OBJECT_CUENTA,
      businessObjectID: accountID,
    }),
  );
  return previas.length + 1;
}

// Hechos que ve RR. HH. en la tarjeta de la tarea y en el correo.
function accountFacts(account, items) {
  const proyectos = [...new Set(items.map((item) => item.projectName).filter(Boolean))];
  const horas = items.reduce((total, item) => total + Number(item.approvedHours || 0), 0);
  const facts = [
    { section: "Prestador", key: "provider", label: "Prestador", value: `${account.employeeNameSnapshot} · ${account.documentTypeSnapshot} ${account.documentNumberSnapshot}`, order: 10 },
    { section: "Cuenta", key: "period", label: "Periodo", value: `${formatDate(account.periodStart)} al ${formatDate(account.periodEnd)}`, order: 20 },
    { section: "Cuenta", key: "amount", label: "Valor bruto", value: formatMoney(account.grossAmount, account.currency), order: 40 },
    { section: "Soporte", key: "socialSecurity", label: "Soporte de seguridad social", value: requirementText(account.socialSecurityRequirement), order: 50 },
    { section: "Cuenta", key: "projects", label: "Conceptos", value: proyectos.length ? proyectos.join(", ") : `${items.length} concepto(s)`, order: 60 },
    { section: "Pago", key: "bank", label: "Cuenta para el pago", value: `${account.bankNameSnapshot} · ${account.bankAccountTypeSnapshot} ${account.bankAccountNumberSnapshot}`, order: 70 },
  ];
  if (horas > 0) facts.splice(2, 0, { section: "Cuenta", key: "hours", label: "Horas aprobadas", value: `${formatNumber(horas)} h`, order: 30 });
  return facts.filter((fact) => fact.value && !String(fact.value).includes("undefined"));
}

async function event(tx, Events, accountID, type, actor, detailText) {
  return tx.run(INSERT.into(Events).entries({ ID: cds.utils.uuid(), account_ID: accountID, type, actorUserID: actor, detail: detailText, occurredAt: new Date().toISOString() }));
}

async function scan(req, buffer) {
  try {
    const scanner = await cds.connect.to("malwareScanner");
    const result = await scanner.send("scan", { file: Readable.from([buffer]) });
    if (result?.isMalware) reject(req, 422, "ARCHIVO_INFECTADO", "El soporte fue rechazado por la validación de seguridad.");
  } catch (error) {
    if (error.code === "ARCHIVO_INFECTADO" || error.status === 422) throw error;
    reject(req, 502, "ESCANEO_FALLIDO", "No fue posible validar el soporte con el servicio de seguridad.");
  }
}

function assistedAccountInput(req) {
  const required = (field, label) => {
    const value = clean(req.data?.[field]);
    if (!value) reject(req, 400, "CAMPO_REQUERIDO", `Completa el campo ${label}.`, field);
    return value;
  };
  const periodStart = required("periodStart", "Periodo desde");
  const periodEnd = required("periodEnd", "Periodo hasta");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) || periodEnd < periodStart)
    reject(req, 400, "PERIODO_INVALIDO", "El periodo trabajado no es válido.", "periodEnd");
  const grossAmount = Number(req.data?.grossAmount);
  if (!Number.isFinite(grossAmount) || grossAmount <= 0)
    reject(req, 400, "VALOR_INVALIDO", "El valor bruto debe ser mayor que cero.", "grossAmount");
  const currency = required("currency", "Moneda").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) reject(req, 400, "MONEDA_INVALIDA", "Indica una moneda ISO de tres letras.", "currency");
  const socialSecurityRequirement = required("socialSecurityRequirement", "Soporte requerido").toUpperCase();
  if (!new Set(["AFFILIATION", "PILA", "NONE"]).has(socialSecurityRequirement))
    reject(req, 400, "SOPORTE_INVALIDO", "Selecciona el soporte aplicable o indica que no se requiere.", "socialSecurityRequirement");
  return {
    employeeID: required("employeeID", "Empleado"),
    periodStart,
    periodEnd,
    concept: required("concept", "Concepto"),
    grossAmount: roundMoney(grossAmount),
    currency,
    socialSecurityRequirement,
  };
}

function validateUploadedDocument(req, content, mimeType, label, allowedTypes) {
  if (!content?.length) reject(req, 400, "ARCHIVO_VACIO", `${label} es obligatorio.`);
  if (content.length > 15 * 1024 * 1024) reject(req, 413, "ARCHIVO_GRANDE", `${label} no puede superar 15 MB.`);
  const mime = clean(mimeType) || "application/octet-stream";
  if (!allowedTypes.has(mime)) reject(req, 415, "TIPO_ARCHIVO_INVALIDO", `${label} tiene un formato no permitido.`);
}

function ensureProvider(req, employee) {
  if (!employee.generaCuentaCobro) reject(req, 409, "NO_ES_PRESTADOR", "El empleado no está habilitado para generar cuentas de cobro.");
}
function hasHRRole(req) { return Boolean(req.user?.is?.("CollectionAccountHR") || req.user?.is?.("TimeFinance") || req.user?.is?.("Editor") || req.user?.is?.("Admin")); }
function identity(req) { return [req.user?.attr?.email, req.user?.attr?.mail, req.user?.attr?.emailAddress, req.user?.id].find((value) => typeof value === "string" && value.trim())?.trim().toLowerCase() || "usuario-desconocido"; }
function requestIp(req) { return String(req.headers?.["x-forwarded-for"] || req.req?.socket?.remoteAddress || "").split(",")[0].trim().slice(0, 100); }
function socialSecuritySatisfied(account) {
  return account?.socialSecurityRequirement === "NONE" ||
    (account?.socialSecurityStatus === "CLEAN" && Boolean(account?.socialSecurityFileName));
}
function requirementText(value) {
  if (value === "NONE") return "No requerido para esta cuenta";
  return value === "AFFILIATION" ? "Soporte de afiliación como independiente (primer cobro)" : "Comprobante PILA del periodo anterior";
}
function result(message, account) { return { success: true, message, account, accounts: account ? [account] : [] }; }
function periodKey(id, from, to) { return `${id}|${from}|${to}`; }
// Un extremo nulo significa "abierto", en los dos lados del intervalo. Sin las
// guardas de `toB` y `fromB`, JavaScript convierte el null a 0 y la fecha a NaN,
// y la comparación da false: dos intervalos abiertos nunca se solapaban.
function overlaps(fromA, toA, fromB, toB) {
  return (!fromA || !toB || fromA <= toB) && (!toA || !fromB || toA >= fromB);
}
function addDays(value, days) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return isoDate(date); }
function isoDate(date) { return date.toISOString().slice(0, 10); }
function todayColombia() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function round(value) { return Number(Number(value || 0).toFixed(2)); }
function roundMoney(value) { return Number(Number(value || 0).toFixed(2)); }
function clean(value) { const result = typeof value === "string" ? value.trim() : ""; return result || null; }
function normalize(value) { return String(value || "").trim().toLocaleLowerCase("es-CO").replace(/\s+/g, " "); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function accountPeriodKey(row) { return `${row.periodStart}|${row.periodEnd}`; }
function formatShortDate(value) { if (!value) return ""; return new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${String(value).slice(0, 10)}T00:00:00Z`)); }
function accountNumber(periodEnd, ID) { return `CC-${String(periodEnd).slice(0, 7).replace("-", "")}-${ID.slice(0, 8).toUpperCase()}`; }
function safeFile(value) { return String(value || "cuenta-cobro").replace(/[^a-zA-Z0-9._-]/g, "-"); }
function formatNumber(value) { return Number(value || 0).toLocaleString("es-CO", { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
function formatDate(value) { if (!value) return ""; return new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", day: "2-digit", month: "long", year: "numeric" }).format(new Date(`${String(value).slice(0, 10)}T00:00:00Z`)); }
function formatMoney(value, currency) { return new Intl.NumberFormat("es-CO", { style: "currency", currency: currency || "COP", maximumFractionDigits: 2 }).format(Number(value || 0)); }
function csvCell(value) { const text = String(value ?? ""); return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
function reject(req, status, code, message, target) { return req.reject({ status, code, message, target }); }
