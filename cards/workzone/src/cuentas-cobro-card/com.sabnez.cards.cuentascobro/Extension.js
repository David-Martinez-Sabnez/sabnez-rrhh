sap.ui.define(["sap/ui/integration/Extension"], function (Extension) {
  "use strict";

  var CONTEXTO = "/cuentas-cobro/getContext()";
  var PERIODOS = "/cuentas-cobro/getEligiblePeriods()";

  function filas(data) {
    if (Array.isArray(data)) { return data; }
    return data && Array.isArray(data.value) ? data.value : [];
  }

  function fecha(value) {
    if (!value) { return ""; }
    var p = String(value).slice(0, 10).split("-");
    var meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
    return Number(p[2]) + " " + (meses[Number(p[1]) - 1] || p[1]);
  }

  function dinero(value, currency) {
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: currency || "COP",
      maximumFractionDigits: currency === "COP" || !currency ? 0 : 2
    }).format(Number(value) || 0);
  }

  return Extension.extend("com.sabnez.cards.cuentascobro.Extension", {
    getData: function () {
      var card = this.getCard();
      var p = (card.getCombinedParameters && card.getCombinedParameters()) || {};
      var contextUrl = p.urlContexto || ("{{destinations.sabnezApi}}" + (p.pathContexto || CONTEXTO));
      var periodUrl = p.urlPeriodos || ("{{destinations.sabnezApi}}" + (p.pathPeriodos || PERIODOS));

      return card.request({ url: contextUrl, method: "GET", parameters: { "$format": "json" } })
        .then(function (context) {
          if (!context || !context.isProvider) {
            return {
              eligibleCount: 0,
              pendingCount: Number(context && context.pendingCount) || 0,
              historyCount: Number(context && context.historyCount) || 0,
              headerState: "Neutral",
              alertText: "Disponible para prestadores de servicios",
              items: [{
                title: "Sin perfil de prestador",
                description: "RR. HH. puede revisar la habilitación del perfil.",
                info: "Información",
                state: "Information",
                icon: "sap-icon://employee"
              }]
            };
          }

          return card.request({ url: periodUrl, method: "GET", parameters: { "$format": "json" } })
            .then(function (data) {
              var eligible = filas(data).filter(function (row) { return row.eligible; });
              var items = eligible.slice(0, 3).map(function (row) {
                return {
                  title: row.projectName || row.projectCode || "Servicios profesionales",
                  description: fecha(row.periodStart) + " – " + fecha(row.periodEnd) +
                    (row.clientName ? " · " + row.clientName : ""),
                  info: dinero(row.amount, row.currency),
                  state: "Success",
                  icon: "sap-icon://calendar"
                };
              });
              if (!items.length) {
                items.push({
                  title: "Estás al día",
                  description: "No tienes periodos aprobados pendientes de generar.",
                  info: "Al día",
                  state: "Success",
                  icon: "sap-icon://message-success"
                });
              }
              return {
                eligibleCount: eligible.length,
                pendingCount: Number(context.pendingCount) || 0,
                historyCount: Number(context.historyCount) || 0,
                headerState: eligible.length ? "Critical" : "Good",
                alertText: eligible.length
                  ? (eligible.length === 1
                    ? "Tienes 1 periodo pendiente de generar"
                    : "Tienes " + eligible.length + " periodos pendientes de generar")
                  : "No tienes cuentas pendientes de generar",
                items: items
              };
            });
        });
    }
  });
});
