sap.ui.define([
  "sabnez/com/tiemposadminui/controller/BaseController",
], function (BaseController) {
  "use strict";

  return BaseController.extend("sabnez.com.tiemposadminui.controller.App", {
    onInit: function () {
      this.set("/area", "projects");
    },

    onAreaSelect: function (event) {
      this.getRouter().navTo(event.getParameter("key"));
    }
  });
});
