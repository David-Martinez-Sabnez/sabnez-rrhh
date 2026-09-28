sap.ui.define(["sap/ui/integration/Extension"], function (Extension) {
  "use strict";

  var PATH_DEFECTO = "/ausencias-empleado/obtenerMiResumen()";

  function n(v) { return Number(v) || 0; }
  function fmt(v) {
    var x = Math.round(n(v) * 100) / 100;
    return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }
  function pct(disponible, total) {
    if (total <= 0) { return 0; }
    return Math.max(0, Math.min(100, Math.round((disponible / total) * 100)));
  }

  return Extension.extend("com.sabnez.cards.vacacionesbienestar.Extension", {
    getData: function () {
      var oCard = this.getCard();
      var p = (oCard.getCombinedParameters && oCard.getCombinedParameters()) || {};
      var sUrl = p.urlResumen || ("{{destinations.sabnezApi}}" + (p.pathResumen || PATH_DEFECTO));

      return oCard.request({ url: sUrl, method: "GET", parameters: { "$format": "json" } })
        .then(function (d) {
          var vacDisp = n(d.diasVacacionesDisponibles),
              vacCaus = n(d.diasVacacionesCausados),
              vacRes  = n(d.diasVacacionesReservados);
          var vacConsum = Math.max(vacCaus - vacDisp - vacRes, 0);

          var valAsig = n(d.horasValeraAsignadas),
              valDisp = n(d.horasValeraDisponibles),
              valUs   = n(d.horasValeraUtilizadas);

          return {
            items: [
              {
                titulo: "Vacaciones",
                // Texto corto a proposito: medido, entra desde 280 px de columna.
                // Si tus columnas son de 320 px o mas, puedes usar la version larga:
                //   fmt(vacDisp) + " de " + fmt(vacCaus) + " dias · " + fmt(vacConsum) + " tomados"
                descripcion: fmt(vacDisp) + " de " + fmt(vacCaus) + " días",
                disponible: pct(vacDisp, vacCaus) + " %",
                // NO usar "Error": el rojo de SAP significa que algo esta roto.
                // Quedarse sin dias es un estado, no un fallo. Va en naranja.
                estado: vacDisp > 0 ? "Success" : "Warning",
                icono: "sap-icon://calendar"
              },
              {
                titulo: "Valera emocional",
                descripcion: fmt(valDisp) + " de " + fmt(valAsig) + " h",
                disponible: pct(valDisp, valAsig) + " %",
                estado: valDisp > 0 ? "Success" : "Warning",
                icono: "sap-icon://heart"
              }
            ],
            // se conserva el detalle por si quieres mostrarlo en otro sitio
            detalle: {
              vacacionesConsumidas: vacConsum,
              vacacionesReservadas: vacRes,
              valeraUtilizada: valUs
            }
          };
        });
    }
  });
});
