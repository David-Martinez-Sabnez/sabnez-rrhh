sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/ui/model/odata/v4/ODataModel",
  "sabnez/com/aprobacionesui/model/models"
], function (UIComponent, ODataModel, models) {
  "use strict";

  return UIComponent.extend("sabnez.com.aprobacionesui.Component", {
    metadata: {
      manifest: "json",
      interfaces: ["sap.ui.core.IAsyncContentCreation"]
    },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);
      var sServiceUrl = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
        ? "/aprobaciones/"
        : this.getManifestObject().resolveUri("aprobaciones/");
      this.setModel(new ODataModel({
        serviceUrl: sServiceUrl,
        operationMode: "Server",
        autoExpandSelect: true,
        earlyRequests: true,
        groupId: "$direct",
        updateGroupId: "$direct"
      }));
      this.setModel(models.createDeviceModel(), "device");
      this.getRouter().initialize();
    }
  });
});
