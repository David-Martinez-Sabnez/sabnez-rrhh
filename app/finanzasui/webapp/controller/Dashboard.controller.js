sap.ui.define([
  "sabnez/com/finanzasui/controller/BaseController",
], function (BaseController) {
  "use strict";

  return BaseController.extend("sabnez.com.finanzasui.controller.Dashboard", {
    onInit: function () {
      this.getRouter().getRoute("dashboard").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function () {
      this.set("/area", "dashboard");
    },

    // Rehacer el libro de compensatorios desde los registros de tiempo y
    // las ausencias. Es idempotente, así que se puede pulsar sin miedo.
    onRecalcCompensatory: async function () {
      var rango = this.get("/rango");
      try {
        var res = await this.getData().action("recalcularCompensatorios", {
          desde: rango.desde,
          hasta: rango.hasta,
        });
        this.toast(res && res.mensaje ? res.mensaje : "Compensatorios recalculados.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    // Cambiar el rango vuelve a pedir el tablero: los meses los calcula
    // el servicio, no el navegador, porque el devengado sale de recorrer
    // todos los registros de tiempo del periodo.
    onRangeChange: async function () {
      var rango = this.get("/rango");
      if (!rango.desde || !rango.hasta) return;
      if (rango.desde > rango.hasta) {
        return this.fail(new Error("El rango empieza después de terminar."));
      }
      await this.getData().refresh();
    },
  });
});
