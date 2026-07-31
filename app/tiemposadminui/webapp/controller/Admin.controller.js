sap.ui.define(["sap/ui/core/mvc/Controller", "sap/ui/model/json/JSONModel", "sap/m/MessageToast", "sap/m/MessageBox"], function (Controller, JSONModel, MessageToast, MessageBox) {
  "use strict";
  var ROOT = "/tiempos-admin/";

  return Controller.extend("sabnez.com.tiemposadminui.controller.Admin", {
    onInit: function () {
      this.getView().setModel(new JSONModel({
        busy: false,
        error: "",
        clients: [],
        projects: [],
        employees: [],
        assignments: [],
        clientForm: { legalName: "", tradeName: "", taxIdentification: "", countryCode: "CO", defaultCurrency: "COP", timeZone: "America/Bogota" },
        projectForm: { clientID: "", code: "", name: "", validFrom: "", validTo: "", modality: "FULL_TIME", currency: "COP", timeZone: "America/Bogota", requiresDescription: false, requiresEvidence: false },
        assignmentForm: { projectID: "", employeeID: "", validFrom: "", validTo: "", role: "Consultor", isPrimary: true }
      }), "view");
      this._loadAll();
    },
    onRefresh: function () { this._loadAll(true); },
    onTabSelect: function () {},
    onDismissError: function () { this.getView().getModel("view").setProperty("/error", ""); },

    onSaveClient: async function () {
      var model = this.getView().getModel("view");
      var form = Object.assign({}, model.getProperty("/clientForm"), { status: "ACTIVE", taxExempt: false });
      if (!form.legalName.trim() || !form.taxIdentification.trim()) return MessageBox.warning("Completa la razón social y la identificación tributaria.");
      await this._save("Clientes", form, "Cliente creado correctamente.");
      model.setProperty("/clientForm", { legalName: "", tradeName: "", taxIdentification: "", countryCode: "CO", defaultCurrency: "COP", timeZone: "America/Bogota" });
    },

    onSaveProject: async function () {
      var model = this.getView().getModel("view");
      var form = model.getProperty("/projectForm");
      if (!form.clientID || !form.code.trim() || !form.name.trim() || !form.validFrom) return MessageBox.warning("Completa cliente, código, nombre y fecha inicial.");
      await this._save("Proyectos", {
        client_ID: form.clientID, code: form.code, name: form.name, validFrom: form.validFrom, validTo: form.validTo || null,
        modality: form.modality, currency: form.currency, timeZone: form.timeZone, requiresDescription: form.requiresDescription,
        requiresEvidence: form.requiresEvidence, requiresClientApproval: false, approvalScheme: "LEADER_THEN_ADMIN", dailyWarningHours: 12, status: "ACTIVE"
      }, "Proyecto creado correctamente.");
      model.setProperty("/projectForm", { clientID: "", code: "", name: "", validFrom: "", validTo: "", modality: "FULL_TIME", currency: "COP", timeZone: "America/Bogota", requiresDescription: false, requiresEvidence: false });
    },

    onSaveAssignment: async function () {
      var model = this.getView().getModel("view");
      var form = model.getProperty("/assignmentForm");
      if (!form.projectID || !form.employeeID || !form.validFrom) return MessageBox.warning("Completa proyecto, empleado y fecha inicial.");
      await this._save("Asignaciones", {
        project_ID: form.projectID, employee_ID: form.employeeID, validFrom: form.validFrom, validTo: form.validTo || null,
        role: form.role, commercialAllocation: 0, isPrimary: form.isPrimary, isBackup: false, status: "ACTIVE"
      }, "Empleado asignado correctamente.");
      model.setProperty("/assignmentForm", { projectID: "", employeeID: "", validFrom: "", validTo: "", role: "Consultor", isPrimary: true });
    },

    _save: async function (entity, payload, successMessage) {
      var model = this.getView().getModel("view");
      model.setProperty("/busy", true);
      try {
        var token = await this._csrf();
        var response = await fetch(ROOT + entity, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": token }, body: JSON.stringify(payload) });
        if (!response.ok) throw await this._error(response);
        MessageToast.show(successMessage);
        await this._loadAll();
      } catch (error) { model.setProperty("/error", error.message || String(error)); }
      finally { model.setProperty("/busy", false); }
    },

    _loadAll: async function (notify) {
      var model = this.getView().getModel("view");
      model.setProperty("/busy", true); model.setProperty("/error", "");
      try {
        var results = await Promise.all([
          this._get("Clientes?$select=ID,legalName,tradeName,taxIdentification,defaultCurrency,status&$orderby=tradeName"),
          this._get("Proyectos?$select=ID,code,name,modality,validFrom,validTo,status&$expand=client($select=tradeName,legalName)&$orderby=name"),
          this._get("Empleados?$select=ID,nombreCompleto,correoCorporativo&$orderby=nombreCompleto"),
          this._get("Asignaciones?$select=ID,role,validFrom,validTo,status&$expand=project($select=name),employee($select=nombreCompleto)&$orderby=validFrom desc")
        ]);
        model.setProperty("/clients", results[0]);
        model.setProperty("/projects", results[1].map(function (row) { return Object.assign(row, { clientName: row.client?.tradeName || row.client?.legalName || "" }); }));
        model.setProperty("/employees", results[2]);
        model.setProperty("/assignments", results[3].map(function (row) { return Object.assign(row, { projectName: row.project?.name || "", employeeName: row.employee?.nombreCompleto || "" }); }));
        if (notify) MessageToast.show("Información actualizada.");
      } catch (error) { model.setProperty("/error", error.message || String(error)); }
      finally { model.setProperty("/busy", false); }
    },

    _get: async function (path) {
      var response = await fetch(ROOT + path, { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!response.ok) throw await this._error(response);
      return (await response.json()).value || [];
    },

    _csrf: async function () {
      var response = await fetch(ROOT, { credentials: "same-origin", headers: { "X-CSRF-Token": "Fetch" } });
      if (!response.ok) throw await this._error(response);
      return response.headers.get("X-CSRF-Token");
    },

    _error: async function (response) {
      var payload = await response.json().catch(function () { return {}; });
      return new Error(payload.error?.message || "No fue posible completar la operación.");
    }
  });
});
