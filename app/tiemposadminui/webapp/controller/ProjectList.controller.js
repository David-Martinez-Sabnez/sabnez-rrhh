sap.ui.define([
  "sabnez/com/tiemposadminui/controller/BaseController",
], function (BaseController) {
  "use strict";

  var VACIO = {
    ID: null, clientID: "", contractID: "", code: "", name: "", description: "",
    validFrom: "", validTo: "", modality: "FULL_TIME", currency: "COP",
    timeZone: "America/Bogota", requiresDescription: false, requiresEvidence: false,
    requiresClientApproval: false, approvalScheme: "LEADER_THEN_ADMIN",
    dailyWarningHours: 16, timeEntryCutoffDay: 31, monthlyBillableTarget: 0, workCalendarID: "", status: "ACTIVE",
  };

  return BaseController.extend("sabnez.com.tiemposadminui.controller.ProjectList", {
    onInit: function () {
      this.getRouter().getRoute("projects").attachPatternMatched(this._onMatched, this);
      this.getRouter().getRoute("projectDetail").attachPatternMatched(this._onDetailMatched, this);
      // La fila abierta se vuelve a marcar cuando llegan los datos, que
      // es lo que pasa al entrar por URL directa.
      this.getViewModel().attachEvent("dataLoaded", this._reselect, this);
    },

    _onMatched: function () {
      this.set("/area", "projects");
      this._projectId = null;
      this.byId("projectsTable").removeSelections(true);
    },

    _onDetailMatched: function (event) {
      this.set("/area", "projects");
      this._projectId = event.getParameter("arguments").projectId;
      this._select(this._projectId);
    },

    // Mantiene marcada en la lista la fila abierta en el detalle, también
    // cuando se llega por URL directa o al recargar.
    _select: function (projectId) {
      var table = this.byId("projectsTable");
      var item = (table.getItems() || []).filter(function (row) {
        var ctx = row.getBindingContext("view");
        return ctx && ctx.getObject().ID === projectId;
      })[0];
      if (item) table.setSelectedItem(item);
    },

    _reselect: function () {
      if (this._projectId) this._select(this._projectId);
    },

    onFilter: function () {
      this.getData().applyFilters();
    },

    onClearFilters: function () {
      this.getData().clearFilters("projects");
    },

    onOpen: function (event) {
      var row = this.rowOf(event.getParameter("listItem"));
      if (row) this.getRouter().navTo("projectDetail", { projectId: row.ID });
    },

    onCreate: async function () {
      this.set("/projectForm", Object.assign({}, VACIO));
      this._syncContracts();
      await this.openDialog("ProjectDialog");
    },

    onCompleteCommercialClassification: async function () {
      var confirmed = await this.confirm(
        "Se completarán las reglas faltantes de todos los proyectos y se reclasificarán los registros pendientes. No se tocarán facturas, anulaciones ni correcciones manuales.",
        "Completar clasificación comercial",
        "Completar",
      );
      if (!confirmed) return;
      this.set("/busy", true);
      try {
        var result = await this.getData().action(
          "completarClasificacionComercial",
          {},
        );
        this.toast(result.mensaje);
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      } finally {
        this.set("/busy", false);
      }
    },

    onDialogClientChange: function () {
      this.set("/projectForm/contractID", "");
      this._syncAutomaticCode();
      this._syncContracts();
    },

    _syncAutomaticCode: function () {
      var form = this.get("/projectForm") || {};
      if (form.ID) return;
      var client = (this.get("/clients") || []).find(function (row) { return row.ID === form.clientID; });
      var prefix = String(client && client.projectCodePrefix || "").toUpperCase();
      if (!/^[A-Z]{3}$/.test(prefix)) {
        this.set("/projectForm/code", "Configura el prefijo del cliente");
        return;
      }
      var expression = new RegExp("^" + prefix + "(\\d{3})$");
      var last = (this.get("/projects") || []).reduce(function (max, project) {
        if (project.client_ID !== form.clientID) return max;
        var match = expression.exec(String(project.code || "").toUpperCase());
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0);
      this.set("/projectForm/code", last >= 999 ? "Numeración agotada" : prefix + String(last + 1).padStart(3, "0"));
    },

    onDialogModalityChange: function () {
      if (this.get("/projectForm/modality") !== "INTERNAL") return;
      this.set("/projectForm/contractID", "");
      this.set("/projectForm/requiresClientApproval", false);
      this.set("/projectForm/monthlyBillableTarget", 0);
    },

    // El servicio rechaza un contrato de otro cliente, así que la lista
    // sólo ofrece los del cliente elegido.
    _syncContracts: function () {
      var clientID = this.get("/projectForm/clientID");
      this.set("/contractsForProject", (this.get("/contracts") || []).filter(function (row) {
        return !clientID || row.client_ID === clientID;
      }));
    },

    onDialogCancel: function () {
      this.closeDialog("ProjectDialog");
    },

    onDialogSave: async function () {
      var form = this.get("/projectForm");
      if (!form.clientID || !form.name || !form.validFrom || !form.workCalendarID) {
        return this.fail(new Error("Completa cliente, nombre, fecha de inicio y calendario laboral."));
      }
      try {
        var creado = await this.getData().save("Proyectos", form.ID, {
          client_ID: form.clientID,
          contract_ID: form.modality === "INTERNAL" ? null : (form.contractID || null),
          name: form.name,
          description: form.description || null,
          validFrom: form.validFrom,
          validTo: form.validTo || null,
          modality: form.modality,
          currency: form.currency,
          timeZone: form.timeZone,
          workCalendar_ID: form.workCalendarID,
          requiresDescription: Boolean(form.requiresDescription),
          requiresEvidence: Boolean(form.requiresEvidence),
          requiresClientApproval: form.modality === "INTERNAL" ? false : Boolean(form.requiresClientApproval),
          approvalScheme: form.approvalScheme,
          dailyWarningHours: Number(form.dailyWarningHours) || 16,
          timeEntryCutoffDay: Number(form.timeEntryCutoffDay) || 31,
          monthlyBillableTarget: form.modality === "INTERNAL" ? null : (Number(form.monthlyBillableTarget) || null),
          status: form.status,
        });
        this.closeDialog("ProjectDialog");
        this.toast(form.ID ? "Proyecto actualizado." : "Proyecto creado.");
        await this.getData().refresh();
        if (!form.ID && creado && creado.ID) {
          this.getRouter().navTo("projectDetail", { projectId: creado.ID });
        }
      } catch (error) {
        this.fail(error);
      }
    },
  });
});
