"use strict";

const cds = require("@sap/cds");
const { calcularDiasHabilesColombia } = require("./lib/absence-rules");
const { loadCalendars, businessDaysBetween } = require("./lib/work-calendar");
const {
  resolvePaymentTerm,
  round2,
  addDays,
  monthKey,
  toISODate,
  buildInvoiceTotals,
  computePayment,
  settleInvoice,
  receivablesAging,
  cashProjection,
} = require("./lib/invoice-math");
const {
  fetchOfficialRates,
  resolveRate,
  missingRateDates,
  newRatesOnly,
} = require("./lib/trm");
const {
  accruedRevenue,
  rateFor,
  hourlySaleRate,
} = require("./lib/revenue-accrual");
const {
  accrualsFor,
  consumptionsFor,
  balances,
  totalOwed,
} = require("./lib/compensatory-balance");

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

// Un registro entra en una factura sólo si ya pasó la aprobación interna.
// Facturar algo que un líder todavía puede devolver es pedir una nota
// crédito.
const ESTADOS_FACTURABLES = new Set([
  "INTERNALLY_APPROVED",
  "CORRECTED",
  "CLOSED",
]);

const TRATAMIENTOS_CONTINUOS = new Set(["INCLUDED_FULL_TIME"]);
const TRATAMIENTOS_POR_HORA = new Set([
  "BILLABLE_REGULAR",
  "BILLABLE_OVERTIME",
  "SPECIAL_RATE",
]);

const ETIQUETA_TRATAMIENTO = {
  INCLUDED_FULL_TIME: "Servicio mensual",
  BILLABLE_REGULAR: "Horas ordinarias",
  BILLABLE_OVERTIME: "Horas extra y recargos",
  SPECIAL_RATE: "Horas a tarifa especial",
};

module.exports = cds.service.impl(function () {
  const times = cds.entities("sabnez.times");
  const finance = cds.entities("sabnez.finance");
  const {
    TimeEntries,
    ProjectAssignments,
    AssignmentRates,
    Projects,
    Clients,
    BillingPeriods,
    CompensatoryLedger,
  } = times;
  const Empleados = cds.entities("sabnez.rrhh").Empleados;
  const Ausencias = cds.entities("sabnez.rrhh").Ausencias;
  const {
    Invoices,
    InvoiceLines,
    InvoiceWithholdings,
    InvoicePayments,
    ClientWithholdings,
    ExchangeRates,
  } = finance;
  const ClientContracts = times.ClientContracts;

  async function calendarCounterForProjects(projectRows) {
    const rows = projectRows || [];
    const calendars = await loadCalendars(rows.map((p) => p.workCalendar_ID));
    const projectByID = new Map(rows.map((p) => [p.ID, p]));
    return (from, to, projectID) => {
      const calendar = calendars.get(projectByID.get(projectID)?.workCalendar_ID);
      return calendar ? businessDaysBetween(calendar, from, to) : calcularDiasHabilesColombia(from, to);
    };
  }

  // ------------------------------------------------------------------
  // TRM
  // ------------------------------------------------------------------

  async function todasLasTasas() {
    return (await SELECT.from(ExchangeRates)) || [];
  }

  // Devuelve una función de conversión ya cargada, para no consultar la
  // tabla una vez por registro cuando se recorre un mes entero.
  async function conversor() {
    const tasas = await todasLasTasas();
    const resolver = ({ currency, date }) =>
      resolveRate({ rates: tasas, currency, date });
    return {
      tasas,
      resolver,
      aCOP(monto, moneda, fecha) {
        const r = resolver({ currency: moneda || "COP", date: fecha });
        return round2(Number(monto || 0) * (r.rate || 1));
      },
      convertir(monto, desde, hacia, fecha) {
        const origen = String(desde || "COP").toUpperCase();
        const destino = String(hacia || "COP").toUpperCase();
        if (origen === destino) return round2(monto);
        const enPesos = resolver({ currency: origen, date: fecha }).rate || 1;
        const aDestino = resolver({ currency: destino, date: fecha }).rate || 1;
        return round2((Number(monto || 0) * enPesos) / (aDestino || 1));
      },
    };
  }

  this.on("obtenerTRM", async (req) => {
    const fecha = toISODate(req.data?.fecha) || hoy();
    const moneda = (req.data?.moneda || "USD").toUpperCase();
    const r = resolveRate({ rates: await todasLasTasas(), currency: moneda, date: fecha });
    return {
      moneda,
      fecha,
      valor: r.rate,
      exacta: Boolean(r.exact),
      origen: r.source || null,
      vigenciaDesde: r.validFrom || null,
    };
  });

  this.on("sincronizarTRM", async (req) => {
    const desde = toISODate(req.data?.desde) || addDays(hoy(), -30);
    let traidas;
    try {
      traidas = await fetchOfficialRates({ since: desde, limit: 200 });
    } catch (error) {
      // Que el entorno no pueda salir a internet no puede tumbar la app:
      // la captura manual sigue estando y hay que decir por qué falló.
      reject(
        req,
        502,
        "TRM_NO_DISPONIBLE",
        `No se pudo consultar la TRM oficial (${error.message}). Puede registrarla a mano mientras tanto.`,
      );
    }

    const nuevas = newRatesOnly({ fetched: traidas, existing: await todasLasTasas() });
    const ahora = new Date().toISOString();
    if (nuevas.length)
      await INSERT.into(ExchangeRates).entries(
        nuevas.map((f) => Object.assign({ ID: cds.utils.uuid(), capturedAt: ahora }, f)),
      );

    const ultima = traidas[0] || null;
    return {
      exito: true,
      tasasCargadas: nuevas.length,
      ultimaFecha: ultima ? ultima.validFrom : null,
      ultimoValor: ultima ? ultima.rate : null,
      mensaje: nuevas.length
        ? `Se cargaron ${nuevas.length} tasa(s). La más reciente es del ${ultima.validFrom} a ${ultima.rate}.`
        : "La TRM ya estaba al día.",
    };
  });

  this.on("registrarTRMManual", async (req) => {
    const fecha = toISODate(req.data?.fecha);
    const valor = Number(req.data?.valor);
    const moneda = (req.data?.moneda || "USD").toUpperCase();
    if (!fecha) reject(req, 400, "FECHA_REQUERIDA", "Indique la fecha de la tasa.", "fecha");
    if (!Number.isFinite(valor) || valor <= 0)
      reject(req, 400, "VALOR_INVALIDO", "La tasa debe ser un número positivo.", "valor");

    const existente = await SELECT.one
      .from(ExchangeRates)
      .where({ currency: moneda, validFrom: fecha });
    const fila = {
      currency: moneda,
      validFrom: fecha,
      validTo: fecha,
      rate: valor,
      source: "MANUAL",
      capturedAt: new Date().toISOString(),
    };
    if (existente) await UPDATE(ExchangeRates).set(fila).where({ ID: existente.ID });
    else await INSERT.into(ExchangeRates).entries(Object.assign({ ID: cds.utils.uuid() }, fila));

    return {
      exito: true,
      tasasCargadas: 1,
      ultimaFecha: fecha,
      ultimoValor: valor,
      mensaje: `TRM del ${fecha} registrada a mano en ${valor}.`,
    };
  });

  // ------------------------------------------------------------------
  // Facturas
  // ------------------------------------------------------------------

  async function perfilRetenciones(clientID) {
    return (
      (await SELECT.from(ClientWithholdings).where({
        client_ID: clientID,
        active: true,
      })) || []
    );
  }

  async function cargarFactura(req, facturaID) {
    const factura = facturaID
      ? await SELECT.one.from(Invoices).where({ ID: facturaID })
      : null;
    if (!factura)
      reject(req, 404, "FACTURA_NO_EXISTE", "La factura no existe.", "facturaID");
    return factura;
  }

  // Recalcula impuestos, retenciones y equivalentes en pesos a partir de
  // las líneas guardadas. Es el único sitio donde se escriben esos
  // totales, para que no puedan quedar dos versiones del mismo número.
  async function recomputar(factura, { cambio, perfil } = {}) {
    const conv = cambio || (await conversor());
    const [lineas, cliente] = await Promise.all([
      SELECT.from(InvoiceLines).where({ invoice_ID: factura.ID }),
      SELECT.one.from(Clients).columns("ID", "taxExempt").where({ ID: factura.client_ID }),
    ]);
    const filas = perfil || (await perfilRetenciones(factura.client_ID));
    const fecha = toISODate(factura.issueDate) || hoy();
    const tasaIVA = Boolean(factura.exportOfServices) || Boolean(cliente?.taxExempt)
      ? 0
      : (factura.taxRate == null ? 19 : Number(factura.taxRate));

    const trm =
      String(factura.currency || "COP").toUpperCase() === "COP"
        ? 1
        : conv.resolver({ currency: factura.currency, date: fecha }).rate;

    const totales = buildInvoiceTotals({
      lines: lineas,
      taxRate: tasaIVA,
      exportOfServices: Boolean(factura.exportOfServices),
      withholdingProfile: filas,
      issueDate: factura.issueDate ? fecha : null,
      paymentTermDays: factura.paymentTermDays,
      exchangeRate: trm,
    });

    await DELETE.from(InvoiceWithholdings).where({ invoice_ID: factura.ID });
    if (totales.withholdings.length)
      await INSERT.into(InvoiceWithholdings).entries(
        totales.withholdings.map((w) => ({
          ID: cds.utils.uuid(),
          invoice_ID: factura.ID,
          type: w.type,
          label: w.label,
          base: w.base,
          rate: w.rate,
          amount: w.amount,
        })),
      );

    const set = {
      taxRate: totales.taxRate,
      subtotal: totales.subtotal,
      taxAmount: totales.taxAmount,
      total: totales.total,
      withheldAmount: totales.withheldAmount,
      netExpected: totales.netExpected,
      exchangeRate: totales.exchangeRate,
      totalCOP: totales.totalCOP,
      netExpectedCOP: totales.netExpectedCOP,
      expectedPaymentDate: totales.expectedPaymentDate,
    };
    await UPDATE(Invoices).set(set).where({ ID: factura.ID });
    return Object.assign({}, factura, set, { lineas: lineas.length, totales });
  }

  this.on("recalcularFactura", async (req) => {
    const factura = await cargarFactura(req, req.data?.facturaID);
    if (factura.status === "VOID")
      reject(req, 409, "FACTURA_ANULADA", "Una factura anulada no se recalcula.");
    const r = await recomputar(factura);
    return respuesta(r, "Factura recalculada.");
  });

  async function registrosFacturables({ clienteID, desde, hasta, proyectoIDs, registroIDs }) {
    const proyectos = (proyectoIDs || []).filter(Boolean);
    const seleccion = (registroIDs || []).filter(Boolean);
    const seleccionados = new Set(seleccion);
    const registros = await SELECT.from(TimeEntries)
      .columns(
        "ID",
        "workDate",
        "billableHours",
        "payableHours",
        "commercialTreatment",
        "status",
        "assignment_ID",
        "assignment.employee.nombreCompleto as employeeName",
        "assignment.validFrom as assignmentValidFrom",
        "assignment.validTo as assignmentValidTo",
        "assignment.reportingCycle_ID as reportingCycle_ID",
        "assignment.reportingCycle.cycleType as reportingCycleType",
        "assignment.reportingCycle.startDay as reportingCycleStartDay",
        "assignment.reportingCycle.endDay as reportingCycleEndDay",
        "assignment.project_ID as project_ID",
        "assignment.project.name as projectName",
        "assignment.project.code as projectCode",
        "assignment.project.modality as modality",
        "assignment.project.monthlyBillableTarget as monthlyBillableTarget",
        "assignment.project.client_ID as clientID",
        "assignment.project.contract_ID as contractID",
        "billingPeriod_ID",
        "billingPeriod.periodStart as billingPeriodStart",
        "billingPeriod.periodEnd as billingPeriodEnd",
      )
      .where`workDate >= ${desde} and workDate <= ${hasta} and invoice_ID is null`;

    return registros.filter(
      (e) =>
        e.clientID === clienteID &&
        ESTADOS_FACTURABLES.has(e.status) &&
        (!proyectos.length || proyectos.includes(e.project_ID)) &&
        (!seleccionados.size || seleccionados.has(e.ID)) &&
        (TRATAMIENTOS_CONTINUOS.has(e.commercialTreatment) ||
          (TRATAMIENTOS_POR_HORA.has(e.commercialTreatment) &&
            Number(e.billableHours) > 0)),
    ).map((entry) => {
      const periodoGuardado = entry.billingPeriodStart && entry.billingPeriodEnd
        ? {
            start: toISODate(entry.billingPeriodStart),
            end: toISODate(entry.billingPeriodEnd),
          }
        : null;
      const inicioPredeterminado = Number(String(entry.assignmentValidFrom || "").slice(8, 10)) || 1;
      const periodoCalculado = cicloMensualDeFecha({
        fecha: entry.workDate,
        inicio: entry.reportingCycleType === "MONTHLY"
          ? Number(entry.reportingCycleStartDay) || 1
          : inicioPredeterminado,
        fin: entry.reportingCycleType === "MONTHLY"
          ? Number(entry.reportingCycleEndDay) || null
          : null,
      });
      const periodo = periodoGuardado || periodoCalculado;
      return Object.assign(entry, {
        invoiceCycleStart: periodo.start,
        invoiceCycleEnd: periodo.end,
        invoiceCycleKey: `${periodo.start}|${periodo.end}`,
      });
    });
  }

  this.on("obtenerConceptosFacturables", async (req) => {
    const clienteID = req.data?.clienteID;
    const desde = toISODate(req.data?.periodoDesde);
    const hasta = toISODate(req.data?.periodoHasta);
    if (!clienteID || !desde || !hasta)
      reject(req, 400, "PARAMETROS_INCOMPLETOS", "Indique cliente y rango de fechas del periodo.");
    if (desde > hasta)
      reject(req, 400, "RANGO_INVALIDO", "El periodo empieza después de terminar.", "periodoHasta");

    const cliente = await SELECT.one.from(Clients).where({ ID: clienteID });
    if (!cliente) reject(req, 404, "CLIENTE_NO_EXISTE", "El cliente no existe.", "clienteID");
    const moneda = (req.data?.moneda || cliente.defaultCurrency || "COP").toUpperCase();
    const registros = await registrosFacturables({ clienteID, desde, hasta });
    if (!registros.length) return [];

    const conv = await conversor();
    const asignaciones = await SELECT.from(ProjectAssignments);
    const tarifas = await SELECT.from(AssignmentRates);
    const porAsignacion = new Map(asignaciones.map((a) => [a.ID, a]));
    const proyectos = await SELECT.from(Projects).where({ ID: { in: [...new Set(registros.map((r) => r.project_ID))] } });
    const contarDiasProyecto = await calendarCounterForProjects(proyectos);
    const grupos = new Map();

    for (const registro of registros) {
      // El periodo de aprobación/facturación tiene prioridad. En datos
      // antiguos sin periodo, se conserva cada asignación y mes por
      // separado para evitar mezclar recursos por accidente.
      const periodo = registro.billingPeriod_ID || registro.invoiceCycleKey;
      const clave = [
        registro.assignment_ID,
        periodo,
        registro.commercialTreatment,
      ].join("|");
      if (!grupos.has(clave)) grupos.set(clave, []);
      grupos.get(clave).push(registro);
    }

    const conceptos = [];
    for (const [clave, grupo] of grupos) {
      const primera = grupo[0];
      const lineas = construirLineas({
        registros: grupo, tarifas, porAsignacion, moneda, conv,
        periodoDesde: desde, periodoHasta: hasta, contarDiasProyecto,
      });
      const valor = round2(lineas.reduce((suma, linea) => suma + Number(linea.amount || 0), 0));
      const periodoDesde = [primera.invoiceCycleStart, desde, toISODate(primera.assignmentValidFrom)]
        .filter(Boolean).sort().at(-1);
      const periodoHasta = [primera.invoiceCycleEnd, hasta, toISODate(primera.assignmentValidTo)]
        .filter(Boolean).sort()[0];
      conceptos.push({
        clave,
        registroIDs: grupo.map((e) => e.ID),
        assignmentID: primera.assignment_ID,
        projectID: primera.project_ID,
        proyecto: primera.projectName || primera.projectCode || "Proyecto sin nombre",
        recurso: primera.employeeName || "Recurso sin nombre",
        concepto: ETIQUETA_TRATAMIENTO[primera.commercialTreatment] || primera.commercialTreatment,
        periodoDesde,
        periodoHasta,
        horas: round2(grupo.reduce((suma, e) => suma + Number(e.billableHours || 0), 0)),
        valorEstimado: valor,
        moneda,
        registros: grupo.length,
        seleccionable: valor > 0,
        validacion: valor > 0 ? "Listo para facturar" : "No tiene tarifa de venta vigente.",
      });
    }

    return conceptos.sort((a, b) =>
      String(a.periodoDesde).localeCompare(String(b.periodoDesde)) ||
      String(a.recurso).localeCompare(String(b.recurso)) ||
      String(a.proyecto).localeCompare(String(b.proyecto)),
    );
  });

  this.on("generarFacturaBorrador", async (req) => {
    const clienteID = req.data?.clienteID;
    const desde = toISODate(req.data?.periodoDesde);
    const hasta = toISODate(req.data?.periodoHasta);
    if (!clienteID || !desde || !hasta)
      reject(
        req,
        400,
        "PARAMETROS_INCOMPLETOS",
        "Indique cliente y rango de fechas del periodo.",
      );
    if (desde > hasta)
      reject(req, 400, "RANGO_INVALIDO", "El periodo empieza después de terminar.", "periodoHasta");

    const cliente = await SELECT.one.from(Clients).where({ ID: clienteID });
    if (!cliente)
      reject(req, 404, "CLIENTE_NO_EXISTE", "El cliente no existe.", "clienteID");

    const filtroProyectos = (req.data?.proyectoIDs || []).filter(Boolean);
    const filtroRegistros = (req.data?.registroIDs || []).filter(Boolean);
    const moneda = (req.data?.moneda || cliente.defaultCurrency || "COP").toUpperCase();
    // Un pagador del exterior no genera IVA ni retenciones colombianas.
    const exportacion = String(cliente.countryCode || "CO").toUpperCase() !== "CO";

    const elegibles = await registrosFacturables({
      clienteID,
      desde,
      hasta,
      proyectoIDs: filtroProyectos,
      registroIDs: filtroRegistros,
    });

    if (filtroRegistros.length && elegibles.length !== new Set(filtroRegistros).size)
      reject(
        req,
        409,
        "SELECCION_DESACTUALIZADA",
        "Uno o más conceptos seleccionados ya no están disponibles. Consulte de nuevo los conceptos antes de armar el borrador.",
      );

    if (!elegibles.length)
      reject(
        req,
        409,
        "SIN_HORAS_FACTURABLES",
        "No hay horas aprobadas y sin facturar en ese periodo para este cliente.",
      );

    const conv = await conversor();
    const asignaciones = await SELECT.from(ProjectAssignments);
    const tarifas = await SELECT.from(AssignmentRates);
    const porAsignacion = new Map(asignaciones.map((a) => [a.ID, a]));
    const proyectos = await SELECT.from(Projects).where({ ID: { in: [...new Set(elegibles.map((r) => r.project_ID))] } });
    const contarDiasProyecto = await calendarCounterForProjects(proyectos);

    const lineas = construirLineas({
      registros: elegibles,
      tarifas,
      porAsignacion,
      moneda,
      conv,
      periodoDesde: desde,
      periodoHasta: hasta,
      contarDiasProyecto,
    });

    if (!lineas.length)
      reject(
        req,
        409,
        "SIN_TARIFAS",
        "Hay horas aprobadas pero ninguna asignación tiene tarifa de venta cargada. Sin tarifa la factura saldría en cero.",
      );

    // El plazo sale del contrato si el contrato negoció uno propio. Es lo
    // que decide en qué mes cae la plata, así que tomar siempre el del
    // cliente desplazaba la proyección sin que nadie se enterara.
    const contratoIDs = [
      ...new Set(elegibles.map((e) => e.contractID).filter(Boolean)),
    ];
    const contratos = contratoIDs.length
      ? await SELECT.from(ClientContracts)
          .columns("ID", "reference", "paymentTermDays")
          .where({ ID: { in: contratoIDs } })
      : [];
    // Un proyecto sin contrato asociado también cuenta como "otro
    // origen": si unos vienen con contrato y otros no, no hay un plazo
    // del contrato que aplicarle a toda la factura entera.
    const plazo = resolvePaymentTerm({
      client: cliente,
      contracts: contratos,
      mixed: contratos.length > 0 && elegibles.some((e) => !e.contractID),
    });

    const facturaID = cds.utils.uuid();
    await INSERT.into(Invoices).entries({
      ID: facturaID,
      client_ID: clienteID,
      contract_ID: plazo.contractID,
      status: "DRAFT",
      currency: moneda,
      periodStart: desde,
      periodEnd: hasta,
      paymentTermDays: plazo.days,
      exportOfServices: exportacion,
      taxRate: exportacion || cliente.taxExempt ? 0 : 19,
    });
    await INSERT.into(InvoiceLines).entries(
      lineas.map((l, i) =>
        Object.assign({ ID: cds.utils.uuid(), invoice_ID: facturaID, position: (i + 1) * 10 }, l),
      ),
    );

    // Se reservan los registros de una vez: si alguien genera el mismo
    // periodo dos veces, el segundo borrador sale vacío en vez de
    // duplicar el ingreso.
    await UPDATE(TimeEntries)
      .set({ invoice_ID: facturaID })
      .where({ ID: { in: elegibles.map((e) => e.ID) } });

    const factura = await SELECT.one.from(Invoices).where({ ID: facturaID });
    const r = await recomputar(factura, { cambio: conv });
    return respuesta(
      r,
      `Borrador armado con ${lineas.length} línea(s) sobre ${elegibles.length} registro(s) de tiempo.`,
      elegibles.length,
    );
  });

  this.on("emitirFactura", async (req) => {
    const factura = await cargarFactura(req, req.data?.facturaID);
    const numero = String(req.data?.numero || "").trim();
    const fecha = toISODate(req.data?.fechaEmision) || hoy();

    if (factura.status !== "DRAFT")
      reject(
        req,
        409,
        "FACTURA_YA_EMITIDA",
        "Esta factura ya salió. Para corregirla hay que anularla y volver a armarla.",
      );
    // El número lo asigna Siigo, que es quien la reporta a la DIAN. Sin
    // él no hay forma de cruzar esta proyección con la factura real.
    if (!numero)
      reject(
        req,
        400,
        "NUMERO_REQUERIDO",
        "Indique el número que le asignó Siigo a la factura.",
        "numero",
      );

    const duplicada = await SELECT.one
      .from(Invoices)
      .where({ number: numero, status: { "!=": "VOID" } });
    if (duplicada && duplicada.ID !== factura.ID)
      reject(req, 409, "NUMERO_DUPLICADO", `Ya hay una factura con el número ${numero}.`, "numero");

    const conv = await conversor();
    const esPesos = String(factura.currency || "COP").toUpperCase() === "COP";
    const tasa = esPesos ? null : conv.resolver({ currency: factura.currency, date: fecha });
    if (!esPesos && (!tasa || !tasa.rate))
      reject(
        req,
        409,
        "SIN_TRM",
        `No hay TRM registrada para el ${fecha}. Sincronícela o regístrela a mano antes de emitir en ${factura.currency}.`,
      );

    await UPDATE(Invoices)
      .set({
        number: numero,
        externalReference: req.data?.referenciaExterna || null,
        issueDate: fecha,
        status: "ISSUED",
      })
      .where({ ID: factura.ID });

    // Los registros quedan marcados como facturados: de acá en adelante
    // ni se recalifican ni entran en otra factura.
    await UPDATE(TimeEntries)
      .set({ status: "INVOICED" })
      .where({ invoice_ID: factura.ID });

    const periodosCerrados = await cerrarPeriodos(factura.ID, fecha);

    const actualizada = await SELECT.one.from(Invoices).where({ ID: factura.ID });
    const r = await recomputar(actualizada, { cambio: conv });
    const avisos = [];
    if (!esPesos && tasa && !tasa.exact)
      avisos.push(
        "Ojo: se usó la TRM vigente más cercana porque no hay una exacta para ese día.",
      );
    if (periodosCerrados)
      avisos.push(`Se cerraron ${periodosCerrados} periodo(s) de facturación.`);
    return respuesta(
      r,
      [`Factura ${numero} emitida. Se espera el pago el ${r.expectedPaymentDate}.`, ...avisos].join(" "),
    );
  });

  this.on("registrarRecaudo", async (req) => {
    const factura = await cargarFactura(req, req.data?.facturaID);
    const fecha = toISODate(req.data?.fecha) || hoy();
    const monto = Number(req.data?.monto);

    if (!["ISSUED", "SENT", "PARTIALLY_PAID"].includes(factura.status))
      reject(
        req,
        409,
        "FACTURA_NO_COBRABLE",
        "Sólo se le registran recaudos a una factura emitida y sin saldar.",
      );
    if (!Number.isFinite(monto) || monto <= 0)
      reject(req, 400, "MONTO_INVALIDO", "El monto debe ser mayor que cero.", "monto");

    const conv = await conversor();
    const esPesos = String(factura.currency || "COP").toUpperCase() === "COP";
    const tasaManual = Number(req.data?.tasaCambio);
    const tasa =
      esPesos
        ? null
        : Number.isFinite(tasaManual) && tasaManual > 0
          ? tasaManual
          : conv.resolver({ currency: factura.currency, date: fecha }).rate;
    if (!esPesos && !tasa)
      reject(
        req,
        409,
        "SIN_TRM",
        `No hay TRM para el ${fecha}. Regístrela o indíquela en el recaudo para poder medir la diferencia en cambio.`,
      );

    const calculado = computePayment({
      invoice: factura,
      payment: { amount: monto, exchangeRate: tasa },
    });

    await INSERT.into(InvoicePayments).entries({
      ID: cds.utils.uuid(),
      invoice_ID: factura.ID,
      paymentDate: fecha,
      amount: calculado.amount,
      exchangeRate: calculado.exchangeRate,
      amountCOP: calculado.amountCOP,
      fxDifferenceCOP: calculado.fxDifferenceCOP,
      reference: req.data?.referencia || null,
      notes: req.data?.notas || null,
    });

    const pagos = await SELECT.from(InvoicePayments).where({ invoice_ID: factura.ID });
    const saldo = settleInvoice({ invoice: factura, payments: pagos });
    await UPDATE(Invoices)
      .set({
        paidAmount: saldo.paidAmount,
        paidAmountCOP: saldo.paidAmountCOP,
        fxDifferenceCOP: saldo.fxDifferenceCOP,
        status: saldo.status,
      })
      .where({ ID: factura.ID });

    const partes = [
      saldo.status === "PAID"
        ? "Factura saldada."
        : `Abono registrado. Queda un saldo de ${saldo.outstanding} ${factura.currency}.`,
    ];
    if (calculado.fxDifferenceCOP)
      partes.push(
        calculado.fxDifferenceCOP < 0
          ? `La TRM cayó desde la emisión: se perdieron ${Math.abs(calculado.fxDifferenceCOP)} pesos en diferencia en cambio.`
          : `La TRM subió desde la emisión: ${calculado.fxDifferenceCOP} pesos a favor.`,
      );

    const actualizada = await SELECT.one.from(Invoices).where({ ID: factura.ID });
    return respuesta(actualizada, partes.join(" "));
  });

  this.on("anularFactura", async (req) => {
    const factura = await cargarFactura(req, req.data?.facturaID);
    const motivo = String(req.data?.motivo || "").trim();
    if (factura.status === "DRAFT")
      reject(
        req,
        409,
        "BORRADOR_SE_ELIMINA",
        "Los borradores no se anulan: elimínelos para que no queden en el histórico.",
      );
    if (factura.status === "VOID")
      reject(req, 409, "FACTURA_ANULADA", "Esta factura ya está anulada.");
    if (Number(factura.paidAmount) > 0)
      reject(
        req,
        409,
        "FACTURA_CON_RECAUDOS",
        "No se puede anular una factura que ya recibió plata. Registre una nota crédito en Siigo.",
      );
    if (motivo.length < 5)
      reject(req, 400, "MOTIVO_REQUERIDO", "Explique por qué se anula.", "motivo");

    await UPDATE(Invoices)
      .set({ status: "VOID", voidedAt: new Date().toISOString(), voidReason: motivo })
      .where({ ID: factura.ID });

    // Las horas vuelven a quedar disponibles: si se anuló es porque hay
    // que volver a facturarlas de otra forma.
    const periodos = await periodosDeLaFactura(factura.ID);
    await UPDATE(TimeEntries)
      .set({ invoice_ID: null, status: "CLOSED" })
      .where({ invoice_ID: factura.ID });
    if (periodos.length)
      await UPDATE(BillingPeriods)
        .set({ status: "CLOSED" })
        .where({ ID: { in: periodos }, status: "INVOICED" });

    return respuesta(
      Object.assign({}, factura, { status: "VOID" }),
      "Factura anulada. Las horas quedaron libres para volver a facturarse.",
    );
  });

  this.on("eliminarFacturaBorrador", async (req) => {
    const factura = await cargarFactura(req, req.data?.facturaID);
    // También permite retirar borradores antiguos que fueron anulados antes
    // de que existiera esta acción. Una factura numerada o emitida siempre
    // conserva su registro y sólo puede anularse.
    const nuncaEmitida = factura.status === "DRAFT" || (
      factura.status === "VOID" && !factura.number && !factura.issueDate
    );
    if (!nuncaEmitida)
      reject(
        req,
        409,
        "SOLO_BORRADORES",
        "Sólo se pueden eliminar borradores. Una factura emitida debe anularse para conservar la trazabilidad.",
      );

    // Primero se liberan los registros y luego se retira el agregado. La
    // operación corre en la misma transacción CAP: no puede quedar a medias.
    await UPDATE(TimeEntries)
      .set({ invoice_ID: null, status: "CLOSED" })
      .where({ invoice_ID: factura.ID });
    const periodos = await periodosDeLaFactura(factura.ID);
    if (periodos.length)
      await UPDATE(BillingPeriods)
        .set({ status: "CLOSED" })
        .where({ ID: { in: periodos }, status: "INVOICED" });
    await DELETE.from(InvoiceWithholdings).where({ invoice_ID: factura.ID });
    await DELETE.from(InvoiceLines).where({ invoice_ID: factura.ID });
    await DELETE.from(Invoices).where({ ID: factura.ID });

    return respuesta(
      Object.assign({}, factura, { lineas: 0 }),
      "Borrador eliminado. Sus horas quedaron disponibles para armar una nueva factura.",
    );
  });

  // ------------------------------------------------------------------
  // Compensatorios
  // ------------------------------------------------------------------

  this.on("recalcularCompensatorios", async (req) => {
    const hoyISO = hoy();
    const desde = toISODate(req.data?.desde) || `${monthKey(addDays(hoyISO, -365))}-01`;
    const hasta = toISODate(req.data?.hasta) || hoyISO;

    const [registros, ausencias, libro] = await Promise.all([
      SELECT.from(TimeEntries)
        .columns(
          "ID",
          "employee_ID",
          "workDate",
          "status",
          "requestedType",
          "billableHours",
          "payableHours",
          "treatmentOverride",
        )
        .where`workDate >= ${desde} and workDate <= ${hasta}`,
      SELECT.from(Ausencias)
        .columns(
          "ID",
          "empleado_ID",
          "tipoAusencia_codigo",
          "estadoa_codigo",
          "fechaInicio",
          "horasSolicitadas",
        )
        .where`fechaInicio >= ${desde} and fechaInicio <= ${hasta}`,
      SELECT.from(CompensatoryLedger),
    ]);

    const movimientos = [
      ...accrualsFor({ entries: registros, ledger: libro }),
      ...consumptionsFor({ absences: ausencias, ledger: libro }),
    ];

    if (movimientos.length)
      await INSERT.into(CompensatoryLedger).entries(
        movimientos.map((m) => Object.assign({ ID: cds.utils.uuid() }, m)),
      );

    const saldos = await calcularSaldos();
    const horas = totalOwed(saldos);
    return {
      exito: true,
      movimientosNuevos: movimientos.length,
      horasPorPagar: horas,
      personas: saldos.filter((s) => s.saldo > 0).length,
      mensaje: movimientos.length
        ? `Se asentaron ${movimientos.length} movimiento(s). Quedan ${horas} hora(s) por compensar.`
        : `El libro ya estaba al día. Quedan ${horas} hora(s) por compensar.`,
    };
  });

  this.on("obtenerSaldosCompensatorios", async () => calcularSaldos());

  /**
   * Los saldos con su costo estimado.
   *
   * El costo sale de la tarifa interna por hora de la asignación más
   * reciente de cada persona: es una estimación para dimensionar la
   * deuda, no una liquidación de nómina.
   */
  async function calcularSaldos() {
    const [libro, empleados, asignaciones, tarifas] = await Promise.all([
      SELECT.from(CompensatoryLedger),
      SELECT.from(Empleados).columns("ID", "nombreCompleto"),
      SELECT.from(ProjectAssignments).columns("ID", "employee_ID", "validFrom"),
      SELECT.from(AssignmentRates).columns(
        "assignment_ID",
        "validFrom",
        "currency",
        "internalHourlyCost",
        "costCurrency",
      ),
    ]);

    const conv = await conversor();
    const costoPorEmpleado = new Map();
    for (const asignacion of asignaciones) {
      const tarifa = rateFor({
        rates: tarifas,
        assignmentID: asignacion.ID,
        date: hoy(),
      });
      const costo = Number(tarifa && tarifa.internalHourlyCost) || 0;
      if (!costo) continue;
      const enPesos = conv.aCOP(costo, (tarifa && (tarifa.costCurrency || tarifa.currency)) || "COP", hoy());
      const actual = costoPorEmpleado.get(asignacion.employee_ID) || 0;
      // Entre varias asignaciones se toma la más cara: subestimar una
      // deuda con el equipo es peor que sobrestimarla.
      if (enPesos > actual) costoPorEmpleado.set(asignacion.employee_ID, enPesos);
    }

    return balances({ ledger: libro, employees: empleados }).map((s) =>
      Object.assign({}, s, {
        empleadoID: s.employee_ID,
        costoEstimadoCOP: round2(
          Math.max(0, s.saldo) * (costoPorEmpleado.get(s.employee_ID) || 0),
        ),
      }),
    );
  }

  // ------------------------------------------------------------------
  // Tablero
  // ------------------------------------------------------------------

  this.on("obtenerTableroFinanciero", async (req) => {
    const hoyISO = hoy();
    const desde = toISODate(req.data?.desde) || `${monthKey(addDays(hoyISO, -90))}-01`;
    const hasta = toISODate(req.data?.hasta) || finDeMes(addDays(hoyISO, 180));

    const conv = await conversor();
    const [facturas, pagos, registros, asignaciones, tarifas, proyectos] =
      await Promise.all([
        SELECT.from(Invoices),
        SELECT.from(InvoicePayments),
        SELECT.from(TimeEntries)
          .columns(
            "ID",
            "workDate",
            "billableHours",
            "payableHours",
            "commercialTreatment",
            "assignment_ID",
            "assignment.project_ID as project_ID",
          )
          .where`workDate >= ${desde} and workDate <= ${hasta}`,
        SELECT.from(ProjectAssignments),
        SELECT.from(AssignmentRates),
        SELECT.from(Projects),
      ]);

    const pagosPorFactura = new Map();
    for (const p of pagos) {
      if (!pagosPorFactura.has(p.invoice_ID)) pagosPorFactura.set(p.invoice_ID, []);
      pagosPorFactura.get(p.invoice_ID).push(p);
    }
    const conPagos = facturas.map((f) =>
      Object.assign({}, f, { payments: pagosPorFactura.get(f.ID) || [] }),
    );

    const caja = cashProjection({ invoices: conPagos, from: desde, to: hasta, today: hoyISO });
    const devengado = accruedRevenue({
      entries: registros,
      assignments: asignaciones,
      rates: tarifas,
      projects: proyectos,
      from: desde,
      to: hasta,
      resolveExchangeRate: conv.resolver,
      businessDaysBetween: await calendarCounterForProjects(proyectos),
    });

    // Se fusionan por mes: caja y devengado hablan de meses distintos a
    // propósito, y el punto del tablero es poder verlos lado a lado.
    const porMes = new Map();
    const mes = (clave) => {
      if (!porMes.has(clave))
        porMes.set(clave, {
          mes: clave,
          devengadoCOP: 0, costoCOP: 0, margenCOP: 0,
          facturadoCOP: 0, cajaEsperadaCOP: 0, cajaRecibidaCOP: 0,
          ivaCOP: 0, anticiposCOP: 0, vencidoCOP: 0,
          horasFacturables: 0, horasPorCompensar: 0,
        });
      return porMes.get(clave);
    };
    for (const m of devengado.meses) Object.assign(mes(m.mes), m);
    for (const m of caja) Object.assign(mes(m.mes), m, {
      devengadoCOP: mes(m.mes).devengadoCOP,
      costoCOP: mes(m.mes).costoCOP,
      margenCOP: mes(m.mes).margenCOP,
      horasFacturables: mes(m.mes).horasFacturables,
      horasPorCompensar: mes(m.mes).horasPorCompensar,
    });

    const meses = [...porMes.values()].sort((a, b) => (a.mes < b.mes ? -1 : 1));
    const cartera = receivablesAging({ invoices: conPagos, today: hoyISO });

    let ivaPorDeclarar = 0;
    let anticiposRenta = 0;
    let diferenciaCambio = 0;
    let cajaRecibida = 0;
    const retenciones = await SELECT.from(InvoiceWithholdings);
    const facturaDe = new Map(conPagos.map((f) => [f.ID, f]));
    for (const f of conPagos) {
      if (f.status === "VOID" || f.status === "DRAFT") continue;
      const trm = Number(f.exchangeRate) > 0 ? Number(f.exchangeRate) : 1;
      ivaPorDeclarar = round2(ivaPorDeclarar + Number(f.taxAmount || 0) * trm);
      diferenciaCambio = round2(diferenciaCambio + Number(f.fxDifferenceCOP || 0));
      cajaRecibida = round2(cajaRecibida + Number(f.paidAmountCOP || 0));
    }
    for (const r of retenciones) {
      const f = facturaDe.get(r.invoice_ID);
      if (!f || f.status === "VOID" || f.status === "DRAFT") continue;
      const trm = Number(f.exchangeRate) > 0 ? Number(f.exchangeRate) : 1;
      if (r.type === "RETEIVA")
        ivaPorDeclarar = round2(ivaPorDeclarar - Number(r.amount || 0) * trm);
      else anticiposRenta = round2(anticiposRenta + Number(r.amount || 0) * trm);
    }

    const saldos = await calcularSaldos();
    const horasPorCompensar = totalOwed(saldos);
    const costoCompensatorio = round2(
      saldos.reduce((suma, x) => suma + Number(x.costoEstimadoCOP || 0), 0),
    );

    return {
      desde,
      hasta,
      meses,
      compensatorioHoras: horasPorCompensar,
      compensatorioCostoCOP: costoCompensatorio,
      cartera: cartera.tramos,
      carteraTotalCOP: cartera.totalCOP,
      cajaRecibidaCOP: cajaRecibida,
      ivaPorDeclararCOP: ivaPorDeclarar,
      anticiposRentaCOP: anticiposRenta,
      // Lo cobrado no es todo tuyo: el IVA está de paso hacia la DIAN.
      disponibleCOP: round2(cajaRecibida - ivaPorDeclarar),
      diferenciaCambioCOP: diferenciaCambio,
      avisos: await construirAvisos({
        conv,
        facturas: conPagos,
        sinTarifa: devengado.sinTarifa,
        compensatorio: { horas: horasPorCompensar, costo: costoCompensatorio },
        hoyISO,
      }),
    };
  });

  async function construirAvisos({ conv, facturas, sinTarifa, compensatorio, hoyISO }) {
    const avisos = [];

    const faltantes = missingRateDates({
      rates: conv.tasas,
      from: addDays(hoyISO, -7),
      to: hoyISO,
    });
    if (faltantes.length)
      avisos.push({
        tipo: "TRM",
        mensaje: `Faltan ${faltantes.length} día(s) de TRM en la última semana. Las facturas en dólares se están valorando con una tasa aproximada.`,
      });

    const borradores = facturas.filter((f) => f.status === "DRAFT").length;
    if (borradores)
      avisos.push({
        tipo: "BORRADOR",
        mensaje: `Hay ${borradores} factura(s) en borrador esperando número de Siigo. Esas horas no están proyectando caja todavía.`,
      });

    const vencidas = facturas.filter(
      (f) =>
        ["ISSUED", "SENT", "PARTIALLY_PAID"].includes(f.status) &&
        f.expectedPaymentDate &&
        toISODate(f.expectedPaymentDate) < hoyISO,
    );
    if (vencidas.length)
      avisos.push({
        tipo: "CARTERA",
        mensaje: `${vencidas.length} factura(s) pasaron su fecha esperada de pago.`,
      });

    if (sinTarifa && sinTarifa.length)
      avisos.push({
        tipo: "TARIFA",
        mensaje: `${sinTarifa.length} asignación(es) registraron horas facturables sin tarifa de venta cargada. Esas horas están devengando cero.`,
      });

    if (compensatorio && compensatorio.horas > 0)
      avisos.push({
        tipo: "COMPENSATORIO",
        mensaje: `El equipo tiene ${compensatorio.horas} hora(s) por compensar, unos ${Math.round(compensatorio.costo).toLocaleString("es-CO")} pesos de costo ya causado que no se le cobró a ningún cliente.`,
      });

    return avisos;
  }

  // ------------------------------------------------------------------
  // Auxiliares
  // ------------------------------------------------------------------

  /**
   * Arma las líneas de la factura.
   *
   * Una línea por proyecto y tipo de cobro. Las horas se valoran registro
   * por registro con la tarifa que estaba vigente ese día, y el precio
   * unitario que queda en la línea es el promedio ponderado: así el total
   * es exacto aunque en el mes haya habido un cambio de tarifa.
   *
   * La mensualidad no se suma por registro. Se acumula por asignación y
   * mes, prorrateada, porque el cliente paga por tener el recurso y no
   * por cada hora que reporte.
   */
  function construirLineas({ registros, tarifas, porAsignacion, moneda, conv, periodoDesde, periodoHasta, contarDiasProyecto }) {
    const porHora = new Map();
    const mensuales = new Map();

    for (const entry of registros) {
      const fecha = toISODate(entry.workDate);
      const tarifa = rateFor({ rates: tarifas, assignmentID: entry.assignment_ID, date: fecha });
      if (!tarifa) continue;

      if (TRATAMIENTOS_CONTINUOS.has(entry.commercialTreatment)) {
        const cicloDesde = entry.invoiceCycleStart || `${monthKey(fecha)}-01`;
        const cicloHasta = entry.invoiceCycleEnd || finDeMes(fecha);
        const clave = `${entry.project_ID}|${entry.assignment_ID}|${cicloDesde}|${cicloHasta}`;
        if (!mensuales.has(clave))
          mensuales.set(clave, {
            project_ID: entry.project_ID,
            projectName: entry.projectName,
            projectCode: entry.projectCode,
            assignment_ID: entry.assignment_ID,
            cicloDesde,
            cicloHasta,
            tarifa,
            horas: 0,
            objetivoMensual: Number(entry.monthlyBillableTarget) || 0,
          });
        mensuales.get(clave).horas = round2(
          mensuales.get(clave).horas + (Number(entry.billableHours) || 0),
        );
        continue;
      }

      const precio = hourlySaleRate(tarifa, entry.commercialTreatment);
      if (precio <= 0) continue;
      const clave = `${entry.project_ID}|${entry.commercialTreatment}`;
      if (!porHora.has(clave))
        porHora.set(clave, {
          project_ID: entry.project_ID,
          projectName: entry.projectName,
          projectCode: entry.projectCode,
          treatment: entry.commercialTreatment,
          horas: 0,
          importe: 0,
        });
      const acumulado = porHora.get(clave);
      const horas = Number(entry.billableHours) || 0;
      acumulado.horas = round2(acumulado.horas + horas);
      acumulado.importe = round2(
        acumulado.importe +
          conv.convertir(horas * precio, tarifa.saleCurrency || tarifa.currency || "COP", moneda, fecha),
      );
    }

    const lineas = [];

    for (const fila of mensuales.values()) {
      const asignacion = porAsignacion.get(fila.assignment_ID);
      const tramoDesde = [fila.cicloDesde, periodoDesde, toISODate(asignacion?.validFrom)]
        .filter(Boolean).sort().at(-1);
      const tramoHasta = [fila.cicloHasta, periodoHasta, toISODate(asignacion?.validTo)]
        .filter(Boolean).sort()[0];
      const cubreCiclo = periodoDesde <= fila.cicloDesde && periodoHasta >= fila.cicloHasta;
      const cumpleObjetivo = fila.objetivoMensual > 0 && fila.horas >= fila.objetivoMensual;
      let fraccion;
      if (cumpleObjetivo) {
        fraccion = fraccionCicloMensual({
          assignment: asignacion,
          desde: fila.cicloDesde,
          hasta: fila.cicloHasta,
          businessDaysBetween: (from, to) => contarDiasProyecto(from, to, fila.project_ID),
        });
      } else {
        // Consultar el ciclo completo no significa que la mensualidad esté
        // completa. Una misma persona puede estar full time en dos proyectos
        // y cubrir sólo parte de la capacidad en uno de ellos. Para el ciclo
        // completo manda el objetivo comercial de ESA asignación/proyecto;
        // en una consulta parcial manda la capacidad hábil del tramo visible.
        const horasDisponibles = cubreCiclo && fila.objetivoMensual > 0
          ? fila.objetivoMensual
          : contarDiasProyecto(
            fila.cicloDesde > periodoDesde ? fila.cicloDesde : periodoDesde,
            fila.cicloHasta < periodoHasta ? fila.cicloHasta : periodoHasta,
            fila.project_ID,
          ) * 8;
        fraccion = horasDisponibles > 0 ? Math.min(1, fila.horas / horasDisponibles) : 0;
      }
      const mensual = Number(fila.tarifa.monthlySaleRate) || 0;
      if (mensual <= 0) continue;
      const importe = conv.convertir(
        mensual * fraccion,
        fila.tarifa.saleCurrency || fila.tarifa.currency || "COP",
        moneda,
        fila.cicloDesde,
      );
      if (importe <= 0) continue;
      lineas.push({
        project_ID: fila.project_ID,
        description: `${fila.projectCode ? fila.projectCode + " · " : ""}${fila.projectName} · ${ETIQUETA_TRATAMIENTO.INCLUDED_FULL_TIME} ${tramoDesde} a ${tramoHasta}${fraccion < 1 ? " (proporcional)" : ""}`,
        quantity: 1,
        unitPrice: importe,
        amount: importe,
        taxable: true,
      });
    }

    for (const fila of porHora.values()) {
      if (fila.horas <= 0 || fila.importe <= 0) continue;
      lineas.push({
        project_ID: fila.project_ID,
        description: `${fila.projectCode ? fila.projectCode + " · " : ""}${fila.projectName} · ${ETIQUETA_TRATAMIENTO[fila.treatment] || fila.treatment}`,
        quantity: fila.horas,
        unitPrice: round2(fila.importe / fila.horas),
        amount: fila.importe,
        taxable: true,
      });
    }

    return lineas;
  }

  /**
   * Los periodos de facturación que toca esta factura.
   *
   * Hoy devuelve vacío casi siempre: los periodos existen en el modelo
   * pero nadie los genera todavía, porque son la pieza del flujo de
   * aprobación del cliente y eso está pendiente. Cuando se activen, esto
   * ya los cierra sin tocar nada más.
   */
  async function periodosDeLaFactura(facturaID) {
    const registros = await SELECT.from(TimeEntries)
      .columns("billingPeriod_ID")
      .where({ invoice_ID: facturaID });
    return [...new Set(registros.map((r) => r.billingPeriod_ID).filter(Boolean))];
  }

  /**
   * Cierra un periodo sólo cuando ya no le queda nada por facturar. Si la
   * factura cubrió la mitad del periodo, el periodo sigue abierto: lo
   * contrario dejaría horas aprobadas sin poder cobrarse nunca.
   */
  async function cerrarPeriodos(facturaID, fecha) {
    const periodos = await periodosDeLaFactura(facturaID);
    if (!periodos.length) return 0;
    let cerrados = 0;
    for (const periodoID of periodos) {
      const pendientes = await SELECT.from(TimeEntries)
        .columns("ID")
        .where`billingPeriod_ID = ${periodoID} and invoice_ID is null`;
      if (pendientes.length) continue;
      await UPDATE(BillingPeriods)
        .set({ status: "INVOICED", closedAt: new Date().toISOString() })
        .where({ ID: periodoID });
      cerrados += 1;
    }
    return cerrados;
  }

  function respuesta(factura, mensaje, registros) {
    return {
      exito: true,
      mensaje,
      facturaID: factura.ID,
      numero: factura.number || null,
      total: factura.total == null ? 0 : Number(factura.total),
      netoEsperado: factura.netExpected == null ? 0 : Number(factura.netExpected),
      lineas: factura.lineas == null ? 0 : factura.lineas,
      registros: registros == null ? 0 : registros,
    };
  }
});

function hoy() {
  return new Date().toISOString().slice(0, 10);
}

function finDeMes(isoDate) {
  const [anio, mes] = String(isoDate).slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(anio, mes, 0)).toISOString().slice(0, 10);
}



function fechaDelMes(anio, mesCero, dia) {
  const ultimo = new Date(Date.UTC(anio, mesCero + 1, 0)).getUTCDate();
  return new Date(Date.UTC(anio, mesCero, Math.min(Math.max(1, dia), ultimo)))
    .toISOString().slice(0, 10);
}

// Ubica la fecha dentro del ciclo mensual que le corresponde. El final
// puede ser explícito (16-15) o, si no está informado, es el día anterior
// al próximo inicio. Esto también corrige febrero y meses de 31 días.
function cicloMensualDeFecha({ fecha, inicio, fin }) {
  const value = toISODate(fecha);
  const date = new Date(`${value}T00:00:00Z`);
  const startDay = Math.min(Math.max(Number(inicio) || 1, 1), 31);
  const currentDay = date.getUTCDate();
  const startMonth = currentDay >= startDay ? date.getUTCMonth() : date.getUTCMonth() - 1;
  const start = fechaDelMes(date.getUTCFullYear(), startMonth, startDay);

  if (Number(fin)) {
    const endDay = Math.min(Math.max(Number(fin), 1), 31);
    const endMonth = startMonth + (endDay < startDay ? 1 : 0);
    return { start, end: fechaDelMes(date.getUTCFullYear(), endMonth, endDay) };
  }

  const nextStart = new Date(`${fechaDelMes(date.getUTCFullYear(), startMonth + 1, startDay)}T00:00:00Z`);
  nextStart.setUTCDate(nextStart.getUTCDate() - 1);
  return { start, end: nextStart.toISOString().slice(0, 10) };
}

function fraccionCicloMensual({ assignment, desde, hasta, businessDaysBetween }) {
  if (typeof businessDaysBetween !== "function") return 1;
  const inicioAsignacion = toISODate(assignment && assignment.validFrom);
  const finAsignacion = toISODate(assignment && assignment.validTo);
  const inicioActivo = inicioAsignacion && inicioAsignacion > desde ? inicioAsignacion : desde;
  const finActivo = finAsignacion && finAsignacion < hasta ? finAsignacion : hasta;
  if (inicioActivo > finActivo) return 0;
  const total = Number(businessDaysBetween(desde, hasta)) || 0;
  if (total <= 0) return 1;
  return Math.min(1, Number(businessDaysBetween(inicioActivo, finActivo)) / total);
}

function reject(req, status, code, message, target) {
  return req.reject({ status, code, message, target });
}
