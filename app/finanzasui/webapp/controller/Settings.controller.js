sap.ui.define([
  "sabnez/com/finanzasui/controller/BaseController",
], function (BaseController) {
  "use strict";

  function hoy() {
    return new Date().toISOString().slice(0, 10);
  }

  // Valores de arranque de cada tipo. Son los que aplican al caso más
  // común —servicios, declarante, Bogotá— y hay que confirmarlos con la
  // contadora, no darlos por buenos.
  var SUGERENCIA = {
    RETEFUENTE: { label: "Retefuente servicios", base: "SUBTOTAL", rate: 4, minimumBase: 104748 },
    RETEICA: { label: "ReteICA servicios", base: "SUBTOTAL", rate: 0.966, minimumBase: 0 },
    RETEIVA: { label: "ReteIVA", base: "TAX", rate: 15, minimumBase: 0 },
    OTRA: { label: "", base: "SUBTOTAL", rate: 0, minimumBase: 0 },
  };

  return BaseController.extend("sabnez.com.finanzasui.controller.Settings", {
    onInit: function () {
      this.getRouter().getRoute("settings").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function () {
      this.set("/area", "settings");
    },

    nombreCliente: function (ID) {
      var cliente = this.getData().client(ID);
      return cliente ? cliente.tradeName || cliente.legalName : "";
    },

    // ---------------- retenciones ----------------

    onAddWithholding: async function () {
      this.set("/withholdingForm", Object.assign(
        { ID: null, clienteID: "", type: "RETEFUENTE", validFrom: hoy(), validTo: "", active: true },
        SUGERENCIA.RETEFUENTE,
      ));
      await this.openDialog("WithholdingDialog");
    },

    onEditWithholding: async function (event) {
      var fila = this.rowOf(event);
      if (!fila) return;
      this.set("/withholdingForm", {
        ID: fila.ID,
        clienteID: fila.client_ID,
        type: fila.type,
        label: fila.label || "",
        base: fila.base,
        rate: Number(fila.rate),
        minimumBase: Number(fila.minimumBase || 0),
        validFrom: fila.validFrom ? String(fila.validFrom).slice(0, 10) : hoy(),
        validTo: fila.validTo ? String(fila.validTo).slice(0, 10) : "",
        active: fila.active !== false,
      });
      await this.openDialog("WithholdingDialog");
    },

    // Cambiar el tipo propone su tarifa y su base habituales. El reteIVA
    // va sobre el impuesto y no sobre el servicio: es el error que más
    // se comete al configurarlo a mano.
    onWithholdingTypeChange: function () {
      var tipo = this.get("/withholdingForm/type");
      var sugerido = SUGERENCIA[tipo] || SUGERENCIA.OTRA;
      var form = this.get("/withholdingForm");
      this.set("/withholdingForm", Object.assign({}, form, sugerido));
    },

    onWithholdingCancel: function () {
      this.closeDialog("WithholdingDialog");
    },

    onWithholdingSave: async function () {
      var form = this.get("/withholdingForm");
      var tarifa = Number(form.rate);
      if (!form.clienteID) return this.fail(new Error("Indica a qué cliente le aplica."));
      if (!form.validFrom) return this.fail(new Error("Indica desde cuándo rige."));
      if (!isFinite(tarifa) || tarifa <= 0) {
        return this.fail(new Error("La tarifa debe ser mayor que cero."));
      }
      try {
        await this.getData().save("PerfilRetenciones", form.ID, {
          client_ID: form.clienteID,
          type: form.type,
          label: form.label || null,
          base: form.base,
          rate: tarifa,
          minimumBase: Number(form.minimumBase) || 0,
          validFrom: form.validFrom,
          validTo: form.validTo || null,
          active: Boolean(form.active),
        });
        this.closeDialog("WithholdingDialog");
        this.toast("Retención guardada. Aplica a las facturas que se armen desde ahora.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    // ---------------- TRM ----------------

    onSyncRates: async function () {
      try {
        var res = await this.getData().action("sincronizarTRM", { desde: null });
        this.toast(res && res.mensaje ? res.mensaje : "TRM actualizada.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    onAddRate: async function () {
      this.set("/rateForm", { fecha: hoy(), moneda: "USD", valor: "" });
      await this.openDialog("RateDialog");
    },

    onRateCancel: function () {
      this.closeDialog("RateDialog");
    },

    onRateSave: async function () {
      var form = this.get("/rateForm");
      var valor = Number(form.valor);
      if (!form.fecha) return this.fail(new Error("Indica la fecha de la tasa."));
      if (!isFinite(valor) || valor <= 0) {
        return this.fail(new Error("La tasa debe ser un número positivo."));
      }
      try {
        var res = await this.getData().action("registrarTRMManual", {
          fecha: form.fecha,
          valor: valor,
          moneda: form.moneda,
        });
        this.closeDialog("RateDialog");
        this.toast(res && res.mensaje ? res.mensaje : "TRM registrada.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },
  });
});
