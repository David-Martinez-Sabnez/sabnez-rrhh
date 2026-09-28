sap.ui.define([
  "sabnez/com/finanzasui/controller/BaseController",
], function (BaseController) {
  "use strict";

  function hoy() {
    return new Date().toISOString().slice(0, 10);
  }

  return BaseController.extend("sabnez.com.finanzasui.controller.InvoiceDetail", {
    onInit: function () {
      this.getRouter().getRoute("invoiceDetail").attachPatternMatched(this._onMatched, this);
      // Al entrar por URL directa los datos aún no están; el modelo avisa
      // cuando llegan.
      this.getViewModel().attachEvent("dataLoaded", this._bind, this);
    },

    _onMatched: function (event) {
      this._invoiceId = event.getParameter("arguments").invoiceId;
      this._bind();
    },

    _bind: function () {
      if (!this._invoiceId) return;
      var factura = this.getData().invoice(this._invoiceId);
      if (!factura) return;
      this.set("/currentInvoice", factura);
      this.getData().loadInvoiceDetail(this._invoiceId);
    },

    onCloseDetail: function () {
      this.getRouter().navTo("invoices");
    },

    // ---------------- emitir ----------------

    onIssue: async function () {
      this.set("/issueForm", { numero: "", fecha: hoy(), referencia: "" });
      await this.openDialog("IssueDialog");
    },

    onIssueCancel: function () {
      this.closeDialog("IssueDialog");
    },

    onIssueSave: async function () {
      var form = this.get("/issueForm");
      if (!form.numero || !String(form.numero).trim()) {
        return this.fail(new Error("Indica el número que le asignó Siigo a la factura."));
      }
      try {
        var res = await this.getData().action("emitirFactura", {
          facturaID: this._invoiceId,
          numero: String(form.numero).trim(),
          fechaEmision: form.fecha,
          referenciaExterna: form.referencia || null,
        });
        this.closeDialog("IssueDialog");
        this.toast(res && res.mensaje ? res.mensaje : "Factura emitida.");
        await this.getData().refresh();
        this._bind();
      } catch (error) {
        this.fail(error);
      }
    },

    // ---------------- recaudo ----------------

    onPayment: async function () {
      var factura = this.get("/currentInvoice") || {};
      var pendiente = Math.max(0, Number(factura.netExpected || 0) - Number(factura.paidAmount || 0));
      this.set("/paymentForm", {
        fecha: hoy(),
        // Se propone el saldo completo, que es el caso normal; si fue un
        // abono se corrige.
        monto: pendiente,
        tasa: "",
        referencia: "",
      });
      await this.openDialog("PaymentDialog");
    },

    onPaymentCancel: function () {
      this.closeDialog("PaymentDialog");
    },

    onPaymentSave: async function () {
      var form = this.get("/paymentForm");
      var monto = Number(form.monto);
      if (!isFinite(monto) || monto <= 0) {
        return this.fail(new Error("El monto debe ser mayor que cero."));
      }
      try {
        var res = await this.getData().action("registrarRecaudo", {
          facturaID: this._invoiceId,
          fecha: form.fecha,
          monto: monto,
          tasaCambio: form.tasa ? Number(form.tasa) : null,
          referencia: form.referencia || null,
          notas: null,
        });
        this.closeDialog("PaymentDialog");
        this.toast(res && res.mensaje ? res.mensaje : "Recaudo registrado.");
        await this.getData().refresh();
        this._bind();
      } catch (error) {
        this.fail(error);
      }
    },

    // ---------------- recalcular, eliminar y anular ----------------

    onRecalculate: async function () {
      try {
        var res = await this.getData().action("recalcularFactura", { facturaID: this._invoiceId });
        this.toast(res && res.mensaje ? res.mensaje : "Factura recalculada.");
        await this.getData().refresh();
        this._bind();
      } catch (error) {
        this.fail(error);
      }
    },

    onDeleteDraft: async function () {
      var ok = await this.confirm(
        "Se eliminará este borrador y sus horas volverán a quedar disponibles para otra factura. Esta acción no deja el borrador en el histórico.",
        "Eliminar borrador",
        "Eliminar",
      );
      if (!ok) return;
      try {
        var res = await this.getData().action("eliminarFacturaBorrador", {
          facturaID: this._invoiceId,
        });
        this.toast(res && res.mensaje ? res.mensaje : "Borrador eliminado.");
        await this.getData().refresh();
        this.getRouter().navTo("invoices");
      } catch (error) {
        this.fail(error);
      }
    },

    onVoid: async function () {
      var factura = this.get("/currentInvoice") || {};
      var ok = await this.confirm(
        "Se anulará la factura " + (factura.number || "en borrador")
          + " y las horas que la componen volverán a quedar disponibles para facturarse. "
          + "Si ya salió en Siigo, allá hay que registrar la nota crédito aparte.",
        "Anular factura",
        "Anular",
      );
      if (!ok) return;
      try {
        var res = await this.getData().action("anularFactura", {
          facturaID: this._invoiceId,
          motivo: "Anulada desde Control Financiero.",
        });
        this.toast(res && res.mensaje ? res.mensaje : "Factura anulada.");
        await this.getData().refresh();
        this._bind();
      } catch (error) {
        this.fail(error);
      }
    },
  });
});
