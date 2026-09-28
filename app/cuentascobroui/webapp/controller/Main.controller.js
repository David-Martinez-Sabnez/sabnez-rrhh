sap.ui.define([
  "sap/ui/core/mvc/Controller", "sap/ui/core/Fragment", "sap/m/MessageBox", "sap/m/MessageToast",
  "sap/m/Dialog", "sap/m/Button", "sap/m/Input", "sap/m/TextArea", "sap/m/CheckBox", "sap/m/Label", "sap/m/VBox"
], function (Controller, Fragment, MessageBox, MessageToast, Dialog, Button, Input, TextArea, CheckBox, Label, VBox) {
  "use strict";

  return Controller.extend("sabnez.com.cuentascobroui.controller.Main", {
    onInit: function () { this.getOwnerComponent().getRouter().getRoute("main").attachPatternMatched(this._loadAll, this); },

    _loadAll: async function () {
      var vm = this.getView().getModel("view");
      vm.setProperty("/busy", true); vm.setProperty("/error", "");
      try {
        var context = await this._call("getContext");
        vm.setProperty("/context", context);
        var eligible = context.employeeID && context.isProvider ? await this._call("getEligiblePeriods") : [];
        context.eligibleCount = eligible.filter(function (row) { return row.eligible; }).length;
        context.canGenerate = context.eligibleCount > 0;
        vm.setProperty("/context", context); vm.setProperty("/eligible", eligible);
        if (context.employeeID) { await this._loadFilterOptions(); await this._loadAccounts(); }
        else vm.setProperty("/accounts", []);
      } catch (error) { vm.setProperty("/error", this._error(error)); }
      finally { vm.setProperty("/busy", false); }
    },

    onRefresh: function () { return this._loadAll(); },

    // Al cambiar de año se recalculan los periodos ofrecidos y se descarta el
    // periodo seleccionado si ya no pertenece al año elegido.
    onYearChange: function () {
      var vm = this.getView().getModel("view");
      this._applyVisiblePeriods();
      var vigente = vm.getProperty("/visiblePeriods").some(function (row) {
        return row.periodKey === vm.getProperty("/filterPeriod");
      });
      if (!vigente) vm.setProperty("/filterPeriod", "");
      return this._reloadAccounts();
    },

    onPeriodChange: function () { return this._reloadAccounts(); },

    onClearFilters: function () {
      var vm = this.getView().getModel("view");
      vm.setProperty("/filterYear", "");
      vm.setProperty("/filterPeriod", "");
      this._applyVisiblePeriods();
      return this._reloadAccounts();
    },

    _reloadAccounts: async function () {
      var vm = this.getView().getModel("view"); vm.setProperty("/busy", true);
      try { await this._loadAccounts(); }
      catch (error) { MessageBox.error(this._error(error)); }
      finally { vm.setProperty("/busy", false); }
    },

    _loadAccounts: async function () {
      var vm = this.getView().getModel("view");
      var year = parseInt(vm.getProperty("/filterYear"), 10);
      vm.setProperty("/accounts", await this._call("getMyAccounts", {
        year: isNaN(year) ? null : year,
        periodKey: vm.getProperty("/filterPeriod") || null
      }));
    },

    _loadFilterOptions: async function () {
      var vm = this.getView().getModel("view");
      var options = await this._call("getAccountFilterOptions");
      var years = options.years || [];
      var total = years.reduce(function (sum, row) { return sum + row.count; }, 0);
      // La opción "Todos" viaja dentro de la lista enlazada: un Select de UI5
      // no admite mezclar ítems estáticos con ítems de un binding.
      vm.setProperty("/years", [{ key: "", label: "Todos los años (" + total + ")" }].concat(
        years.map(function (row) { return { key: String(row.year), label: row.year + " (" + row.count + ")" }; })
      ));
      vm.setProperty("/periods", options.periods || []);
      // Por defecto el año en curso, que es lo que el servicio devuelve como
      // defaultYear cuando hay cuentas de ese año.
      if (!vm.getProperty("/filterTouched")) {
        vm.setProperty("/filterYear", options.defaultYear ? String(options.defaultYear) : "");
        vm.setProperty("/filterTouched", true);
      }
      this._applyVisiblePeriods();
    },

    _applyVisiblePeriods: function () {
      var vm = this.getView().getModel("view");
      var year = vm.getProperty("/filterYear");
      var periods = vm.getProperty("/periods") || [];
      var visibles = year
        ? periods.filter(function (row) { return String(row.year) === String(year); })
        : periods;
      vm.setProperty("/visiblePeriods", [{ periodKey: "", label: "Todos los periodos" }].concat(
        visibles.map(function (row) { return { periodKey: row.periodKey, label: row.label + " (" + row.count + ")" }; })
      ));
    },

    onGenerate: async function () {
      var selected = this.byId("eligibleTable").getSelectedItems().map(function (item) { return item.getBindingContext("view").getObject(); });
      if (!selected.length) return MessageBox.warning("Selecciona al menos un periodo aprobado.");
      var blocked = selected.find(function (row) { return !row.eligible; });
      if (blocked) return MessageBox.warning(blocked.blockingReason);
      var combine = this.getView().getModel("view").getProperty("/combine");
      if (combine && new Set(selected.map(function (row) { return row.currency; })).size > 1) return MessageBox.warning("Selecciona periodos con la misma moneda para combinarlos.");
      var confirmed = await this._confirm(combine ? "Se generará una sola cuenta con los conceptos seleccionados." : "Se generará una cuenta separada por cada concepto seleccionado.");
      if (!confirmed) return;
      await this._run("createAccounts", { selections: selected.map(function (row) { return { periodKey: row.periodKey }; }), combine: combine });
    },

    onOpenAccount: async function (event) {
      var row = event.getSource().getBindingContext("view").getObject();
      await this._openDetail(row.ID);
    },

    _openDetail: async function (ID) {
      var vm = this.getView().getModel("view"); vm.setProperty("/busy", true);
      try {
        vm.setProperty("/detail", await this._call("getAccountDetail", { accountID: ID }));
        if (!this._detail) this._detail = await Fragment.load({ id: this.getView().getId(), name: "sabnez.com.cuentascobroui.fragment.AccountDetail", controller: this });
        this.getView().addDependent(this._detail); this._detail.open();
      } catch (error) { MessageBox.error(this._error(error)); }
      finally { vm.setProperty("/busy", false); }
    },

    onCloseDetail: function () { this._detail && this._detail.close(); },
    onSupportFileChange: function (event) { this._supportFile = event.getParameter("files")?.[0] || null; },

    onUploadSupport: async function () {
      if (!this._supportFile) return MessageBox.warning("Selecciona un archivo PDF, JPG o PNG.");
      var file = this._supportFile;
      var bytes = await file.arrayBuffer();
      var base64 = this._arrayBufferToBase64(bytes);
      await this._runDetail("uploadSocialSecurity", { accountID: this._detailID(), fileName: file.name, mimeType: file.type || this._mimeFromName(file.name), content: base64 });
      this._supportFile = null;
    },

    onSign: function () {
      var name = new Input({ value: this.getView().getModel("view").getProperty("/context/employeeName"), width: "100%" });
      var accept = new CheckBox({ text: "Acepto firmar electrónicamente y declaro que la información corresponde a los servicios prestados.", width: "100%" })
        .addStyleClass("signatureConsent");
      var dialog = new Dialog({ title: "Firmar cuenta de cobro", contentWidth: "34rem", content: [new VBox({ class: "sapUiMediumMargin", items: [new Label({ text: "Nombre completo" }), name, accept] })], beginButton: new Button({ text: "Firmar", type: "Emphasized", press: async function () { dialog.close(); await this._runDetail("signAccount", { accountID: this._detailID(), signerName: name.getValue(), accepted: accept.getSelected() }); }.bind(this) }), endButton: new Button({ text: "Cancelar", press: function () { dialog.close(); } }), afterClose: function () { dialog.destroy(); } });
      dialog.open();
    },

    onSubmit: async function () { if (await this._confirm("La cuenta firmada y el soporte se enviarán a RR. HH. para revisión.")) await this._runDetail("submitAccount", { accountID: this._detailID() }); },
    onRequestCorrection: function () { this._textDialog("Solicitar corrección", "Describe qué valor, periodo o concepto debe revisarse.", "Enviar solicitud", async function (text) { await this._runDetail("requestCorrection", { accountID: this._detailID(), reason: text }); }.bind(this)); },
    onCancelAccount: async function () {
      if (await this._confirm("La cuenta quedará cancelada en el histórico y sus periodos volverán a estar disponibles. Esta acción no elimina la trazabilidad.")) {
        await this._runDetail("cancelDraft", { accountID: this._detailID() });
      }
    },

    onDownloadAccount: async function () { await this._download("downloadAccount", { accountID: this._detailID() }); },
    onDownloadSupport: async function () { await this._download("downloadSocialSecurity", { accountID: this._detailID() }); },
    // El reporte sigue disponible para RR. HH. aunque la revisión se haga
    // desde el Centro de Aprobaciones: cubre el año filtrado en pantalla.
    onDownloadReport: async function () {
      var year = parseInt(this.getView().getModel("view").getProperty("/filterYear"), 10);
      await this._download("downloadHRReport", isNaN(year)
        ? {}
        : { from: year + "-01-01", to: year + "-12-31" });
    },

    _run: async function (name, params) {
      var vm = this.getView().getModel("view"); vm.setProperty("/busy", true);
      try { var result = await this._action(name, params); MessageToast.show(result.message || "Operación realizada"); await this._loadAll(); return result; }
      catch (error) { MessageBox.error(this._error(error)); }
      finally { vm.setProperty("/busy", false); }
    },
    _runDetail: async function (name, params) { var result = await this._run(name, params); if (result) await this._openDetail(params.accountID); },
    _call: async function (name, params) { return this._invoke(name, params || {}); },
    _action: async function (name, params) { return this._invoke(name, params || {}); },
    _invoke: async function (name, params) {
      var binding = this.getOwnerComponent().getModel().bindContext("/" + name + "(...)");
      Object.keys(params).forEach(function (key) { binding.setParameter(key, params[key]); });
      await binding.execute("$direct");
      var result = binding.getBoundContext()?.getObject();
      // Las funciones OData que retornan colecciones llegan como { value: [...] },
      // mientras que las estructuras individuales llegan directamente.
      if (result && Object.prototype.hasOwnProperty.call(result, "value")) return result.value;
      return result || {};
    },
    _detailID: function () { return this.getView().getModel("view").getProperty("/detail/summary/ID"); },
    _download: async function (name, params) { try { var file = await this._call(name, params); var binary = atob(file.contentBase64 || ""); var bytes = new Uint8Array(binary.length); for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i); var url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType || "application/octet-stream" })); var a = document.createElement("a"); a.href = url; a.download = file.fileName || "archivo"; a.click(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); } catch (e) { MessageBox.error(this._error(e)); } },
    _arrayBufferToBase64: function (buffer) { var bytes = new Uint8Array(buffer), chunk = 0x8000, binary = ""; for (var i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)); return btoa(binary); },
    _mimeFromName: function (name) { var lower = String(name || "").toLowerCase(); if (lower.endsWith(".pdf")) return "application/pdf"; if (lower.endsWith(".png")) return "image/png"; return "image/jpeg"; },
    _confirm: function (text) {
      return new Promise(function (resolve) {
        var continueAction = "Continuar";
        var cancelAction = "Cancelar";
        MessageBox.confirm(text, {
          actions: [continueAction, cancelAction],
          emphasizedAction: continueAction,
          onClose: function (action) { resolve(action === continueAction); }
        });
      });
    },
    _textDialog: function (title, placeholder, actionText, handler, required) { var input = new TextArea({ rows: 5, width: "100%", placeholder: placeholder }); var dialog = new Dialog({ title: title, contentWidth: "34rem", content: [new VBox({ class: "sapUiMediumMargin", items: [input] })], beginButton: new Button({ text: actionText, type: "Emphasized", press: async function () { var text = input.getValue().trim(); if (required !== false && text.length < 10) return MessageBox.warning("Escribe una explicación de al menos 10 caracteres."); dialog.close(); await handler(text || null); } }), endButton: new Button({ text: "Cancelar", press: function () { dialog.close(); } }), afterClose: function () { dialog.destroy(); } }); dialog.open(); },
    _iso: function (value) { if (!value) return null; var d = value instanceof Date ? value : new Date(value); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-"); },
    _error: function (error) { try { return JSON.parse(error.responseText).error.message; } catch (_) { return error.message || "Ocurrió un error inesperado."; } },
    formatPeriod: function (from, to) { return this._date(from) + " – " + this._date(to); },
    formatDateTime: function (value) { return value ? new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : ""; },
    _date: function (value) { return value ? new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }).format(new Date(value + "T00:00:00Z")) : ""; },
    formatMoney: function (amount, currency) { return new Intl.NumberFormat("es-CO", { style: "currency", currency: currency || "COP", maximumFractionDigits: 0 }).format(Number(amount || 0)); },
    statusState: function (status) { return ({ HR_APPROVED: "Success", SIGNED: "Information", SUBMITTED: "Warning", UNDER_HR_REVIEW: "Warning", CORRECTION_REQUESTED: "Error", HR_REJECTED: "Error", CANCELLED: "None" })[status] || "Information"; }
  });
});
