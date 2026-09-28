sap.ui.define(["sap/ui/model/json/JSONModel"], function (JSONModel) {
  "use strict";

  function hoy() {
    return new Date().toISOString().slice(0, 10);
  }

  // Ventana por defecto del tablero: tres meses atrás para ver de dónde
  // se viene, seis adelante porque es hasta donde la caja está realmente
  // comprometida por facturas ya emitidas.
  function ventanaPorDefecto() {
    const h = new Date();
    const desde = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth() - 3, 1));
    const hasta = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth() + 7, 0));
    return {
      desde: desde.toISOString().slice(0, 10),
      hasta: hasta.toISOString().slice(0, 10),
    };
  }

  var FinanceData = function (component) {
    this._component = component;
    this._csrfToken = null;
    var ventana = ventanaPorDefecto();
    this._model = new JSONModel({
      busy: false,
      error: "",
      area: "dashboard",
      hoy: hoy(),
      rango: ventana,
      tablero: {
        meses: [], cartera: [], avisos: [],
        carteraTotalCOP: 0, disponibleCOP: 0, cajaRecibidaCOP: 0,
        ivaPorDeclararCOP: 0, anticiposRentaCOP: 0, diferenciaCambioCOP: 0,
        compensatorioHoras: 0, compensatorioCostoCOP: 0,
      },
      compensatorios: [],
      // Máximos para dimensionar las barras de las tablas.
      escalas: { mes: 0, cartera: 0, compensatorio: 0 },
      clientes: [],
      proyectos: [],
      facturas: [],
      filteredFacturas: [],
      retenciones: [],
      tasas: [],
      currentInvoice: null,
      currentLines: [],
      currentWithholdings: [],
      currentPayments: [],
      filters: { estado: "", clienteID: "", texto: "" },
      draftForm: null,
      draftConcepts: [],
      draftLoading: false,
      issueForm: null,
      paymentForm: null,
      withholdingForm: null,
      rateForm: null,
    });
    this._model.setSizeLimit(2000);
  };

  FinanceData.prototype.getModel = function () { return this._model; };
  FinanceData.prototype.get = function (path) { return this._model.getProperty(path); };
  FinanceData.prototype.set = function (path, value) { this._model.setProperty(path, value); };

  // ---------------------------------------------------------------
  // Carga
  // ---------------------------------------------------------------

  FinanceData.prototype.loadAll = async function () {
    this.set("/busy", true);
    this.set("/error", "");
    try {
      var rango = this.get("/rango");
      var r = await Promise.all([
        this.request("POST", "obtenerTableroFinanciero", { desde: rango.desde, hasta: rango.hasta }),
        this.list("Facturas?$select=ID,client_ID,number,status,currency,issueDate,periodStart,periodEnd,paymentTermDays,expectedPaymentDate,exportOfServices,subtotal,taxRate,taxAmount,total,withheldAmount,netExpected,exchangeRate,totalCOP,netExpectedCOP,paidAmount,paidAmountCOP,fxDifferenceCOP,notes&$expand=client($select=tradeName,legalName)&$orderby=issueDate desc,createdAt desc"),
        this.list("Clientes?$select=ID,legalName,tradeName,countryCode,defaultCurrency,paymentTermDays,status&$orderby=tradeName"),
        this.list("Proyectos?$select=ID,client_ID,code,name,modality,status&$orderby=name"),
        this.list("PerfilRetenciones?$select=ID,client_ID,type,label,rate,base,minimumBase,validFrom,validTo,active&$orderby=validFrom desc"),
        this.list("TasasCambio?$select=ID,currency,validFrom,validTo,rate,source,capturedAt&$orderby=validFrom desc"),
        this.request("POST", "obtenerSaldosCompensatorios", {}),
      ]);

      this.setTablero(r[0]);
      this.setCompensatorios(r[6]);
      this.set("/clientes", r[2]);
      this.set("/proyectos", r[3]);
      this.set("/retenciones", r[4]);
      this.set("/tasas", (r[5] || []).slice(0, 90));

      var nombreCliente = {};
      (r[2] || []).forEach(function (c) {
        nombreCliente[c.ID] = c.tradeName || c.legalName;
      });
      var hoyISO = this.get("/hoy");
      this.set("/facturas", (r[1] || []).map(function (row) {
        var pendiente = Math.max(0, Number(row.netExpected || 0) - Number(row.paidAmount || 0));
        var vence = row.expectedPaymentDate ? String(row.expectedPaymentDate).slice(0, 10) : null;
        var cobrable = ["ISSUED", "SENT", "PARTIALLY_PAID"].indexOf(row.status) >= 0;
        return Object.assign(row, {
          clientName: (row.client && (row.client.tradeName || row.client.legalName))
            || nombreCliente[row.client_ID] || "",
          pendiente: pendiente,
          // Vencida es la que ya pasó su fecha y todavía debe plata.
          vencida: Boolean(cobrable && vence && vence < hoyISO && pendiente > 0),
          diasMora: vence ? Math.round(
            (new Date(hoyISO + "T00:00:00Z") - new Date(vence + "T00:00:00Z")) / 86400000) : null,
        });
      }));
      this.applyFilters();
      this._model.fireEvent("dataLoaded");
    } catch (error) {
      this.set("/error", error.message || String(error));
    } finally {
      this.set("/busy", false);
    }
  };

  // El tablero llega con los meses ya calculados; acá sólo se guardan las
  // escalas para que las barras de las tablas compartan un mismo máximo y
  // se puedan comparar entre filas.
  FinanceData.prototype.setTablero = function (tablero) {
    var t = tablero || {};
    var meses = t.meses || [];
    var maxMes = 0;
    meses.forEach(function (m) {
      maxMes = Math.max(
        maxMes,
        Number(m.devengadoCOP || 0),
        Number(m.facturadoCOP || 0),
        Number(m.cajaEsperadaCOP || 0) + Number(m.cajaRecibidaCOP || 0),
      );
    });
    var maxCartera = 0;
    (t.cartera || []).forEach(function (c) {
      maxCartera = Math.max(maxCartera, Number(c.montoCOP || 0));
    });
    this.set("/tablero", t);
    this.set("/escalas", { mes: maxMes, cartera: maxCartera });
  };

  // Los saldos vienen ordenados de mayor a menor; acá sólo se guarda el
  // máximo para que las barras de la tabla compartan escala.
  FinanceData.prototype.setCompensatorios = function (saldos) {
    var filas = (saldos && saldos.value) || saldos || [];
    var maximo = 0;
    filas.forEach(function (f) { maximo = Math.max(maximo, Math.abs(Number(f.saldo || 0))); });
    this.set("/compensatorios", filas);
    this.set("/escalas/compensatorio", maximo);
  };

  FinanceData.prototype.refresh = function () { return this.loadAll(); };

  // ---------------------------------------------------------------
  // Filtros y consultas locales
  // ---------------------------------------------------------------

  function coincide(valor, texto) {
    return String(valor || "").toLowerCase().indexOf(String(texto || "").trim().toLowerCase()) >= 0;
  }

  FinanceData.prototype.applyFilters = function () {
    var f = this.get("/filters");
    this.set("/filteredFacturas", (this.get("/facturas") || []).filter(function (row) {
      var texto = !f.texto
        || coincide(row.number, f.texto)
        || coincide(row.clientName, f.texto);
      return texto
        && (!f.estado || row.status === f.estado)
        && (!f.clienteID || row.client_ID === f.clienteID);
    }));
  };

  FinanceData.prototype.invoice = function (ID) {
    return (this.get("/facturas") || []).filter(function (r) { return r.ID === ID; })[0] || null;
  };

  FinanceData.prototype.client = function (ID) {
    return (this.get("/clientes") || []).filter(function (r) { return r.ID === ID; })[0] || null;
  };

  FinanceData.prototype.withholdingsOfClient = function (ID) {
    return (this.get("/retenciones") || []).filter(function (r) { return r.client_ID === ID; });
  };

  // Carga el detalle de una factura sólo cuando se abre: las líneas de
  // todas las facturas del año no caben en memoria ni hacen falta.
  FinanceData.prototype.loadInvoiceDetail = async function (ID) {
    if (!ID) return;
    this.set("/busy", true);
    try {
      var r = await Promise.all([
        this.list("LineasFactura?$filter=invoice_ID eq " + ID + "&$orderby=position"),
        this.list("RetencionesFactura?$filter=invoice_ID eq " + ID),
        this.list("Recaudos?$filter=invoice_ID eq " + ID + "&$orderby=paymentDate"),
      ]);
      this.set("/currentLines", r[0]);
      this.set("/currentWithholdings", r[1]);
      this.set("/currentPayments", r[2]);
    } catch (error) {
      this.set("/error", error.message || String(error));
    } finally {
      this.set("/busy", false);
    }
  };

  // ---------------------------------------------------------------
  // Escrituras
  // ---------------------------------------------------------------

  FinanceData.prototype.save = function (entidad, ID, payload) {
    return this.request(
      ID ? "PATCH" : "POST",
      entidad + (ID ? "(" + encodeURIComponent(ID) + ")" : ""),
      payload,
    );
  };

  FinanceData.prototype.remove = function (entidad, ID) {
    return this.request("DELETE", entidad + "(" + encodeURIComponent(ID) + ")");
  };

  FinanceData.prototype.action = function (nombre, payload) {
    return this.request("POST", nombre, payload || {});
  };

  // ---------------------------------------------------------------
  // Transporte
  // ---------------------------------------------------------------

  FinanceData.prototype.list = async function (path) {
    var result = await this.request("GET", path);
    return (result && result.value) || [];
  };

  FinanceData.prototype.request = async function (method, path, payload) {
    var token = method === "GET" ? null : await this._csrf();
    var headers = Object.assign(
      { Accept: "application/json" },
      payload ? { "Content-Type": "application/json" } : {},
      token ? { "X-CSRF-Token": token } : {},
    );
    var response = await fetch(this.serviceRoot() + path, {
      method: method,
      credentials: "same-origin",
      headers: headers,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (!response.ok) throw await this._error(response);
    if (response.status === 204) return null;
    return response.json().catch(function () { return null; });
  };

  FinanceData.prototype._csrf = async function () {
    if (this._csrfToken) return this._csrfToken;
    var response = await fetch(this.serviceRoot(), {
      credentials: "same-origin",
      headers: { "X-CSRF-Token": "Fetch" },
    });
    if (!response.ok) throw await this._error(response);
    this._csrfToken = response.headers.get("X-CSRF-Token");
    return this._csrfToken;
  };

  FinanceData.prototype._error = async function (response) {
    var payload = await response.json().catch(function () { return null; });
    var mensaje = (payload && payload.error && payload.error.message)
      || response.statusText
      || ("Error " + response.status);
    var error = new Error(mensaje);
    error.status = response.status;
    return error;
  };

  FinanceData.prototype.serviceRoot = function () {
    if (/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) return "/finanzas/";
    return this._component.getManifestObject().resolveUri("finanzas/");
  };

  return FinanceData;
});
