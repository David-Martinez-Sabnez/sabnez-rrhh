sap.ui.define([
  "sabnez/com/tiemposadminui/controller/BaseController",
], function (BaseController) {
  "use strict";

  return BaseController.extend("sabnez.com.tiemposadminui.controller.RateList", {
    onInit: function () {
      this.getRouter().getRoute("rates").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function () {
      this.set("/area", "rates");
      // Quien no tenga rol financiero no debería llegar aquí ni por URL.
      if (this.get("/profileLoaded") && !this.get("/canSeeRates")) {
        this.getRouter().navTo("projects", {}, true);
      }
    },

    onFilter: function () {
      this.getData().applyFilters();
    },

    onClearFilters: function () {
      this.getData().clearFilters("rates");
    },

    onOpenProject: function (event) {
      var row = this.rowOf(event);
      if (row && row.project_ID) {
        this.getRouter().navTo("projectDetail", { projectId: row.project_ID });
      }
    },
  });
});
