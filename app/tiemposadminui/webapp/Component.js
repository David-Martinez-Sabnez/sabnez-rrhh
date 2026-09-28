sap.ui.define([
  "sap/ui/core/UIComponent",
  "sabnez/com/tiemposadminui/model/AdminData",
], function (UIComponent, AdminData) {
  "use strict";

  return UIComponent.extend("sabnez.com.tiemposadminui.Component", {
    metadata: { manifest: "json", interfaces: ["sap.ui.core.IAsyncContentCreation"] },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);

      // Un solo modelo para toda la app: las vistas no vuelven a pedir
      // datos al navegar entre lista y detalle.
      this._data = new AdminData(this);
      this.setModel(this._data.getModel(), "view");

      // El permiso de tarifas se resuelve antes de la primera carga,
      // para no pedir una entidad que el usuario no puede ver.
      this._data.loadProfile().then(this._data.loadAll.bind(this._data));

      this.getRouter().initialize();
    },

    getData: function () {
      return this._data;
    },
  });
});
