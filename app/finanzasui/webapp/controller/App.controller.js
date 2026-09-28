sap.ui.define([
  "sabnez/com/finanzasui/controller/BaseController",
], function (BaseController) {
  "use strict";

  return BaseController.extend("sabnez.com.finanzasui.controller.App", {
    onAreaSelect: function (event) {
      this.getRouter().navTo(event.getParameter("key"));
    },
  });
});
