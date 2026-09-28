sap.ui.define(["sap/ui/model/json/JSONModel"], function (JSONModel) {
  "use strict";

  // Capa de datos única de la aplicación. Antes cada pantalla era un
  // controller con su propio fetch; ahora hay un solo modelo compartido
  // que todas las vistas leen, y una sola recarga tras cada guardado.
  var AdminData = function (component) {
    this._component = component;
    this._csrfToken = null;
    this._model = new JSONModel({
      busy: false,
      error: "",
      canSeeRates: false,
      canReactivateAssignments: false,
      profileLoaded: false,
      clients: [],
      contracts: [],
      projects: [],
      calendars: [],
      cycles: [],
      employees: [],
      assignments: [],
      approvers: [],
      rates: [],
      billingRules: [],
      missingRates: [],
      documents: [],
      filteredProjects: [],
      filteredClients: [],
      filteredRates: [],
      filters: {
        projects: { search: "", clientID: "", modality: "", status: "ACTIVE", rateIssue: "" },
        clients: { search: "", status: "ACTIVE" },
        rates: { projectID: "", employeeID: "", currency: "" },
      },
    });
    this._model.setSizeLimit(1000);
  };

  AdminData.prototype.getModel = function () {
    return this._model;
  };

  AdminData.prototype.get = function (path) {
    return this._model.getProperty(path);
  };

  AdminData.prototype.set = function (path, value) {
    this._model.setProperty(path, value);
  };

  // ---------------------------------------------------------------
  // Carga
  // ---------------------------------------------------------------

  AdminData.prototype.loadProfile = async function () {
    try {
      var perfil = await this.request("GET", "miPerfil()");
      this.set("/canSeeRates", perfil && perfil.puedeVerTarifas === true);
      this.set("/canReactivateAssignments", perfil && perfil.puedeReactivarAsignaciones === true);
    } catch (error) {
      this.set("/canSeeRates", false);
      this.set("/canReactivateAssignments", false);
    } finally {
      this.set("/profileLoaded", true);
    }
  };

  AdminData.prototype.loadAll = async function () {
    this.set("/busy", true);
    this.set("/error", "");
    try {
      var puedeVerTarifas = this.get("/canSeeRates");
      var peticiones = [
        this.list("Clientes?$select=ID,legalName,tradeName,projectCodePrefix,taxIdentification,countryCode,defaultCurrency,timeZone,taxExempt,paymentTermDays,status&$orderby=tradeName"),
        this.list("Contratos?$select=ID,client_ID,reference,description,validFrom,validTo,currency,totalValue,renewalNoticeDays,paymentTermDays,status&$expand=client($select=tradeName,legalName)&$orderby=validFrom desc"),
        this.list("Proyectos?$select=ID,client_ID,contract_ID,workCalendar_ID,code,name,description,modality,validFrom,validTo,lastReopenedOn,currency,timeZone,requiresDescription,requiresEvidence,requiresClientApproval,approvalScheme,dailyWarningHours,timeEntryCutoffDay,monthlyBillableTarget,status&$expand=client($select=tradeName,legalName),contract($select=reference),workCalendar($select=name,countryCode)&$orderby=name"),
        this.list("Empleados?$select=ID,nombreCompleto,correoCorporativo&$orderby=nombreCompleto"),
        this.list("Asignaciones?$select=ID,project_ID,employee_ID,reportingCycle_ID,role,validFrom,validTo,commercialAllocation,isPrimary,isBackup,status&$expand=project($select=name),employee($select=nombreCompleto,correoCorporativo),reportingCycle($select=name,cycleType,startDay,endDay)&$orderby=validFrom desc"),
        this.list("Aprobadores?$select=ID,project_ID,employee_ID,approverType,validFrom,validTo,active&$expand=project($select=name),employee($select=nombreCompleto,correoCorporativo)&$orderby=validFrom desc"),
        puedeVerTarifas
          ? this.list("Tarifas?$select=ID,assignment_ID,validFrom,validTo,currency,saleCurrency,costCurrency,monthlySaleRate,regularSaleHourlyRate,overtimeSaleHourlyRate,internalMonthlyCost,internalHourlyCost&$expand=assignment($select=project_ID,employee_ID,validFrom,validTo,status;$expand=project($select=name),employee($select=nombreCompleto))&$orderby=validFrom desc")
          : Promise.resolve([]),
        this.list("obtenerDocumentosContrato()"),
        this.list("ReglasFacturacion?$select=ID,project_ID,requestedType,treatment,billableFactor,payableToEmployee,notes,active"),
        puedeVerTarifas
          ? this.list("obtenerAsignacionesSinTarifa()")
          : Promise.resolve([]),
        this.list("CiclosReporte?$select=ID,project_ID,name,cycleType,startDay,endDay,active&$orderby=name"),
        this.list("Calendarios?$select=ID,name,countryCode,hoursPerDay&$orderby=name"),
      ];

      var r = await Promise.all(peticiones);
      var documentos = r[7] || [];
      this.set("/billingRules", r[8] || []);
      var sinTarifa = r[9] || [];
      this.set("/missingRates", sinTarifa);
      this.set("/cycles", r[10] || []);
      this.set("/calendars", r[11] || []);

      this.set("/clients", r[0]);
      this.set("/documents", documentos);

      var plazoPorCliente = {};
      (r[0] || []).forEach(function (c) { plazoPorCliente[c.ID] = c.paymentTermDays; });

      this.set("/contracts", r[1].map(function (row) {
        var docs = documentos.filter(function (doc) { return doc.contratoID === row.ID; });
        return Object.assign(row, {
          clientName: (row.client && (row.client.tradeName || row.client.legalName)) || "",
          // Vacío en el contrato significa "lo que diga el cliente".
          effectivePaymentTermDays: row.paymentTermDays != null
            ? row.paymentTermDays
            : plazoPorCliente[row.client_ID],
          paymentTermInherited: row.paymentTermDays == null,
          documentCount: docs.length,
          firstDocument: docs[0] || null,
        });
      }));

      var asignaciones = r[4].map(function (row) {
        return Object.assign(row, {
          projectName: (row.project && row.project.name) || "",
          employeeName: (row.employee && row.employee.nombreCompleto) || "",
          employeeEmail: (row.employee && row.employee.correoCorporativo) || "",
          reportingCycleName: (row.reportingCycle && row.reportingCycle.name) || "",
        });
      });
      this.set("/assignments", asignaciones);

      var aprobadores = r[5].map(function (row) {
        return Object.assign(row, {
          projectName: (row.project && row.project.name) || "",
          employeeName: (row.employee && row.employee.nombreCompleto) || "",
          employeeEmail: (row.employee && row.employee.correoCorporativo) || "",
        });
      });
      this.set("/approvers", aprobadores);

      var tarifas = (r[6] || []).map(function (row) {
        var asignacion = row.assignment || {};
        var vigencia = asignacion.validFrom || "sin inicio";
        vigencia += " — " + (asignacion.validTo || "vigente");
        return Object.assign(row, {
          saleCurrency: row.saleCurrency || row.currency || "COP",
          costCurrency: row.costCurrency || row.currency || "COP",
          project_ID: asignacion.project_ID || "",
          employee_ID: asignacion.employee_ID || "",
          projectName: (asignacion.project && asignacion.project.name) || "",
          employeeName: (asignacion.employee && asignacion.employee.nombreCompleto) || "",
          assignmentLabel: ((asignacion.employee && asignacion.employee.nombreCompleto) || "") + " · " + vigencia,
        });
      });
      this.set("/rates", tarifas);

      // Cada proyecto lleva ya resuelto lo que la lista necesita mostrar
      // sin que el usuario tenga que ir a mirarlo a otra pestaña.
      this.set("/projects", r[2].map(function (row) {
        var equipo = asignaciones.filter(function (a) {
          return a.project_ID === row.ID && a.status === "ACTIVE";
        });
        var propios = aprobadores.filter(function (ap) {
          return ap.project_ID === row.ID && ap.active;
        });
        var tieneAdmin = propios.some(function (ap) { return ap.approverType === "ADMIN"; });
        var tieneLider = propios.some(function (ap) { return ap.approverType === "LEADER"; });
        var scheme = row.approvalScheme || "LEADER_THEN_ADMIN";
        var completo = scheme === "ADMIN_ONLY"
          ? tieneAdmin
          : scheme === "LEADER_ONLY"
            ? tieneLider
            : scheme === "LEADER_OR_ADMIN"
              ? tieneLider || tieneAdmin
              : tieneLider && tieneAdmin;
        var faltante = completo
          ? "Completa"
          : scheme === "ADMIN_ONLY"
            ? "Falta administrativo"
            : scheme === "LEADER_ONLY"
              ? "Falta líder"
              : scheme === "LEADER_OR_ADMIN"
                ? "Falta líder o administrativo"
                : !tieneLider ? "Falta líder" : "Falta administrativo";
        var incidenciasTarifa = sinTarifa.filter(function (item) {
          return item.projectID === row.ID;
        });
        return Object.assign(row, {
          clientName: (row.client && (row.client.tradeName || row.client.legalName)) || "",
          contractReference: (row.contract && row.contract.reference) || "",
          teamSize: equipo.length,
          approverCount: propios.length,
          approvalComplete: completo,
          approvalGap: faltante,
          missingRateCount: incidenciasTarifa.length,
          missingRateHours: incidenciasTarifa.reduce(function (sum, item) {
            return sum + Number(item.horas || 0);
          }, 0),
        });
      }));

      // El cliente muestra cuántos proyectos tiene sin abrir su ficha.
      var proyectos = this.get("/projects");
      this.set("/clients", r[0].map(function (row) {
        return Object.assign(row, {
          projectCount: proyectos.filter(function (p) { return p.client_ID === row.ID; }).length,
        });
      }));

      this.set("/employees", r[3]);
      this.applyFilters();
      // El modelo avisa cuando hay datos nuevos. Las vistas de detalle
      // se repintan con esto, tanto en la primera carga como tras
      // cualquier guardado.
      this._model.fireEvent("dataLoaded");
    } catch (error) {
      this.set("/error", error.message || String(error));
    } finally {
      this.set("/busy", false);
    }
  };

  AdminData.prototype.refresh = function () {
    return this.loadAll();
  };

  // ---------------------------------------------------------------
  // Filtros
  // ---------------------------------------------------------------

  function coincide(valor, texto) {
    return String(valor || "").toLowerCase().indexOf(String(texto || "").trim().toLowerCase()) >= 0;
  }

  AdminData.prototype.applyFilters = function () {
    var f = this.get("/filters");

    this.set("/filteredProjects", (this.get("/projects") || []).filter(function (row) {
      var texto = !f.projects.search
        || coincide(row.code, f.projects.search)
        || coincide(row.name, f.projects.search)
        || coincide(row.clientName, f.projects.search);
      return texto
        && (!f.projects.clientID || row.client_ID === f.projects.clientID)
        && (!f.projects.modality || row.modality === f.projects.modality)
        && (!f.projects.status || row.status === f.projects.status)
        && (!f.projects.rateIssue || (f.projects.rateIssue === "MISSING" && row.missingRateCount > 0));
    }));

    this.set("/filteredClients", (this.get("/clients") || []).filter(function (row) {
      var texto = !f.clients.search
        || coincide(row.legalName, f.clients.search)
        || coincide(row.tradeName, f.clients.search)
        || coincide(row.taxIdentification, f.clients.search);
      return texto && (!f.clients.status || row.status === f.clients.status);
    }));

    this.set("/filteredRates", (this.get("/rates") || []).filter(function (row) {
      return (!f.rates.projectID || row.project_ID === f.rates.projectID)
        && (!f.rates.employeeID || row.employee_ID === f.rates.employeeID)
        && (!f.rates.currency || row.currency === f.rates.currency);
    }));
  };

  AdminData.prototype.clearFilters = function (grupo) {
    var vacios = {
      projects: { search: "", clientID: "", modality: "", status: "", rateIssue: "" },
      clients: { search: "", status: "" },
      rates: { projectID: "", employeeID: "", currency: "" },
    };
    this.set("/filters/" + grupo, vacios[grupo]);
    this.applyFilters();
  };

  // ---------------------------------------------------------------
  // Lecturas derivadas
  // ---------------------------------------------------------------

  AdminData.prototype.project = function (ID) {
    return (this.get("/projects") || []).filter(function (row) { return row.ID === ID; })[0] || null;
  };

  AdminData.prototype.client = function (ID) {
    return (this.get("/clients") || []).filter(function (row) { return row.ID === ID; })[0] || null;
  };

  AdminData.prototype.byProject = function (coleccion, ID) {
    return (this.get(coleccion) || []).filter(function (row) { return row.project_ID === ID; });
  };

  AdminData.prototype.ratesOfProject = function (ID) {
    return (this.get("/rates") || []).filter(function (row) { return row.project_ID === ID; });
  };

  // La matriz de facturabilidad del proyecto, en el orden en que se lee:
  // primero la jornada ordinaria, después los recargos.
  var ORDEN_TIPOS = [
    "REGULAR", "FLEX_INCLUDED", "OVERTIME", "NIGHT",
    "SUNDAY", "HOLIDAY", "COMPENSATORY",
  ];

  AdminData.prototype.billingRulesOfProject = function (ID) {
    return (this.get("/billingRules") || [])
      .filter(function (row) { return row.project_ID === ID; })
      .sort(function (a, b) {
        return ORDEN_TIPOS.indexOf(a.requestedType) - ORDEN_TIPOS.indexOf(b.requestedType);
      });
  };

  AdminData.prototype.contractsOfClient = function (ID) {
    return (this.get("/contracts") || []).filter(function (row) { return row.client_ID === ID; });
  };

  AdminData.prototype.projectsOfClient = function (ID) {
    return (this.get("/projects") || []).filter(function (row) { return row.client_ID === ID; });
  };

  // ---------------------------------------------------------------
  // Escrituras
  // ---------------------------------------------------------------

  AdminData.prototype.save = async function (entidad, ID, payload) {
    return this.request(
      ID ? "PATCH" : "POST",
      entidad + (ID ? "(" + encodeURIComponent(ID) + ")" : ""),
      payload,
    );
  };

  AdminData.prototype.remove = function (entidad, ID) {
    return this.request("DELETE", entidad + "(" + encodeURIComponent(ID) + ")");
  };

  AdminData.prototype.action = function (nombre, payload) {
    return this.request("POST", nombre, payload || {});
  };

  // ---------------------------------------------------------------
  // Transporte
  // ---------------------------------------------------------------

  AdminData.prototype.list = async function (path) {
    var result = await this.request("GET", path);
    return (result && result.value) || [];
  };

  AdminData.prototype.request = async function (method, path, payload) {
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

  AdminData.prototype._csrf = async function () {
    if (this._csrfToken) return this._csrfToken;
    var response = await fetch(this.serviceRoot(), {
      credentials: "same-origin",
      headers: { "X-CSRF-Token": "Fetch" },
    });
    if (!response.ok) throw await this._error(response);
    this._csrfToken = response.headers.get("X-CSRF-Token");
    return this._csrfToken;
  };

  AdminData.prototype._error = async function (response) {
    var payload = await response.json().catch(function () { return null; });
    var mensaje = (payload && payload.error && payload.error.message)
      || response.statusText
      || ("Error " + response.status);
    var error = new Error(mensaje);
    error.status = response.status;
    error.code = payload && payload.error && payload.error.code;
    return error;
  };

  AdminData.prototype.serviceRoot = function () {
    if (/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) return "/tiempos-admin/";
    return this._component.getManifestObject().resolveUri("tiempos-admin/");
  };

  return AdminData;
});
