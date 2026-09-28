sap.ui.define([
  "sabnez/com/finanzasui/controller/BaseController",
], function (BaseController) {
  "use strict";

  function hoy() {
    return new Date().toISOString().slice(0, 10);
  }

  // El periodo que casi siempre se quiere facturar es el mes pasado.
  function mesAnterior() {
    var h = new Date();
    var desde = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth() - 1, 1));
    var hasta = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), 0));
    return {
      desde: desde.toISOString().slice(0, 10),
      hasta: hasta.toISOString().slice(0, 10),
    };
  }

  return BaseController.extend("sabnez.com.finanzasui.controller.InvoiceList", {
    onInit: function () {
      this.getRouter().getRoute("invoices").attachPatternMatched(this._onMatched, this);
      this.getRouter().getRoute("invoiceDetail").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function () {
      this.set("/area", "invoices");
    },

    onFilter: function () {
      this.getData().applyFilters();
    },

    onOpen: function (event) {
      var fila = this.rowOf(event);
      if (fila) this.getRouter().navTo("invoiceDetail", { invoiceId: fila.ID });
    },

    // ---------------- borrador ----------------

    onNewDraft: async function () {
      var rango = mesAnterior();
      this.set("/draftForm", {
        clienteID: "",
        desde: rango.desde,
        hasta: rango.hasta,
        moneda: "COP",
      });
      this.set("/draftConcepts", []);
      await this.openDialog("DraftDialog");
    },

    // La moneda por defecto es la del cliente: facturarle en pesos a
    // alguien del exterior es el error que uno descubre tarde.
    onDraftClientChange: function () {
      var cliente = this.getData().client(this.get("/draftForm/clienteID"));
      if (cliente && cliente.defaultCurrency)
        this.set("/draftForm/moneda", cliente.defaultCurrency);
      this.set("/draftConcepts", []);
    },

    onDraftCriteriaChange: function () {
      this.set("/draftConcepts", []);
    },

    onDraftConceptSelection: function (event) {
      var item = event.getParameter("listItem");
      var concepto = item && item.getBindingContext("view").getObject();
      if (event.getParameter("selected") && concepto && !concepto.seleccionable) {
        event.getSource().setSelectedItem(item, false);
        this.toast(concepto.validacion || "Este concepto todavía no se puede facturar.");
      }
    },

    onDraftLoadConcepts: async function () {
      var form = this.get("/draftForm");
      if (!form.clienteID || !form.desde || !form.hasta) {
        return this.fail(new Error("Indica el cliente y el periodo que quieres consultar."));
      }
      if (form.desde > form.hasta) {
        return this.fail(new Error("El periodo empieza después de terminar."));
      }
      this.set("/draftLoading", true);
      try {
        var res = await this.getData().action("obtenerConceptosFacturables", {
          clienteID: form.clienteID,
          periodoDesde: form.desde,
          periodoHasta: form.hasta,
          moneda: form.moneda,
        });
        var conceptos = (res && res.value) || res || [];
        this.set("/draftConcepts", conceptos);
        var tabla = this.byId("draftConceptsTable");
        if (tabla) tabla.removeSelections(true);
        if (!conceptos.length) this.toast("No hay conceptos aprobados y pendientes de facturar en ese rango.");
      } catch (error) {
        this.fail(error);
      } finally {
        this.set("/draftLoading", false);
      }
    },

    onDraftCancel: function () {
      this.closeDialog("DraftDialog");
    },

    onDraftSave: async function () {
      var form = this.get("/draftForm");
      if (!form.clienteID || !form.desde || !form.hasta) {
        return this.fail(new Error("Indica el cliente y el periodo que quieres facturar."));
      }
      if (form.desde > form.hasta) {
        return this.fail(new Error("El periodo empieza después de terminar."));
      }
      var tabla = this.byId("draftConceptsTable");
      var seleccionados = tabla ? tabla.getSelectedItems().map(function (item) {
        return item.getBindingContext("view").getObject();
      }) : [];
      if (!seleccionados.length) {
        return this.fail(new Error("Selecciona por lo menos un concepto para incluir en la factura."));
      }
      var registroIDs = [];
      seleccionados.forEach(function (concepto) {
        (concepto.registroIDs || []).forEach(function (ID) {
          if (registroIDs.indexOf(ID) < 0) registroIDs.push(ID);
        });
      });
      try {
        var res = await this.getData().action("generarFacturaBorrador", {
          clienteID: form.clienteID,
          periodoDesde: form.desde,
          periodoHasta: form.hasta,
          proyectoIDs: [],
          registroIDs: registroIDs,
          moneda: form.moneda,
        });
        this.closeDialog("DraftDialog");
        this.toast(res && res.mensaje ? res.mensaje : "Borrador armado.");
        await this.getData().refresh();
        if (res && res.facturaID)
          this.getRouter().navTo("invoiceDetail", { invoiceId: res.facturaID });
      } catch (error) {
        this.fail(error);
      }
    },
  });
});
