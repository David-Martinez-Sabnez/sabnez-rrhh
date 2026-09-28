sap.ui.define(["sap/ui/integration/Extension"], function (Extension) {
  "use strict";
  return Extension.extend("com.sabnez.cards.bienvenida.Extension", {
    getData: function () {
      var sFecha = new Intl.DateTimeFormat("es-CO", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
      sFecha = sFecha.charAt(0).toUpperCase() + sFecha.slice(1);
      return Promise.resolve({ fechaActual: sFecha });
    }
  });
});
