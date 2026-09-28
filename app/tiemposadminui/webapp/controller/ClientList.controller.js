sap.ui.define([
  "sabnez/com/tiemposadminui/controller/BaseController",
], function (BaseController) {
  "use strict";

  var VACIO = {
    ID: null, legalName: "", tradeName: "", projectCodePrefix: "", projectCodePrefixLocked: false, taxIdentification: "",
    countryCode: "CO", defaultCurrency: "COP", timeZone: "America/Bogota",
    taxExempt: false, paymentTermDays: 30, status: "ACTIVE",
  };

  return BaseController.extend("sabnez.com.tiemposadminui.controller.ClientList", {
    onInit: function () {
      this.getRouter().getRoute("clients").attachPatternMatched(this._onMatched, this);
      this.getRouter().getRoute("clientDetail").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function () {
      this.set("/area", "clients");
    },

    onFilter: function () {
      this.getData().applyFilters();
    },

    onClearFilters: function () {
      this.getData().clearFilters("clients");
    },

    onOpen: function (event) {
      var row = this.rowOf(event.getParameter("listItem"));
      if (row) this.getRouter().navTo("clientDetail", { clientId: row.ID });
    },

    onCreate: async function () {
      this.set("/clientForm", Object.assign({}, VACIO));
      await this.openDialog("ClientDialog");
    },

    onClientCancel: function () {
      this.closeDialog("ClientDialog");
    },

    onClientSave: async function () {
      var form = this.get("/clientForm");
      if (!form.legalName || !form.taxIdentification || !/^[A-Za-z]{3}$/.test(form.projectCodePrefix || "")) {
        return this.fail(new Error("Completa la razón social, la identificación tributaria y un prefijo de tres letras."));
      }
      try {
        var creado = await this.getData().save("Clientes", form.ID, {
          legalName: form.legalName, tradeName: form.tradeName || form.legalName,
          projectCodePrefix: form.projectCodePrefix.toUpperCase(),
          taxIdentification: form.taxIdentification, countryCode: form.countryCode,
          defaultCurrency: form.defaultCurrency, timeZone: form.timeZone,
          taxExempt: Boolean(form.taxExempt),
          paymentTermDays: form.paymentTermDays === "" || form.paymentTermDays == null
            ? null
            : Number(form.paymentTermDays),
          status: form.status,
        });
        this.closeDialog("ClientDialog");
        this.toast(form.ID ? "Cliente actualizado." : "Cliente creado.");
        await this.getData().refresh();
        if (!form.ID && creado && creado.ID) {
          this.getRouter().navTo("clientDetail", { clientId: creado.ID });
        }
      } catch (error) {
        this.fail(error);
      }
    },
  });
});
