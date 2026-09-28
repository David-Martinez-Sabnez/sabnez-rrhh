sap.ui.define([
  "sap/ui/core/UIComponent",
  "sabnez/com/finanzasui/model/FinanceData",
], function (UIComponent, FinanceData) {
  "use strict";

  return UIComponent.extend("sabnez.com.finanzasui.Component", {
    metadata: { manifest: "json", interfaces: ["sap.ui.core.IAsyncContentCreation"] },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);

      // Un solo modelo compartido: el tablero, la lista de facturas y la
      // configuración leen de lo mismo y se recargan de una vez tras
      // cada acción.
      this._data = new FinanceData(this);
      this.setModel(this._data.getModel(), "view");
      this._data.loadAll();

      this.getRouter().initialize();
    },

    getData: function () {
      return this._data;
    },
  });
});
