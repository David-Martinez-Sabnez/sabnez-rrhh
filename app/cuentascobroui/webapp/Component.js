sap.ui.define(["sap/ui/core/UIComponent", "sap/ui/model/json/JSONModel"], function (UIComponent, JSONModel) {
  "use strict";
  return UIComponent.extend("sabnez.com.cuentascobroui.Component", {
    metadata: { manifest: "json", interfaces: ["sap.ui.core.IAsyncContentCreation"] },
    init: function () {
      UIComponent.prototype.init.apply(this, arguments);
      this.setModel(new JSONModel({
        busy: false, error: "", context: {}, eligible: [], accounts: [],
        selected: null, detail: null, combine: true,
        // Filtros del histórico. El año se ajusta al año en curso en cuanto
        // llegan las opciones del servicio.
        filterYear: String(new Date().getFullYear()), filterPeriod: "",
        years: [], periods: [], visiblePeriods: []
      }), "view");
      this.getRouter().initialize();
    }
  });
});
