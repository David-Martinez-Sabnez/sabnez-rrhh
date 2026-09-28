sap.ui.define(["sap/ui/integration/Extension"], function (Extension) {
  "use strict";

  var PATH_DEFECTO = "/tiempos-empleado/obtenerMisProyectosActuales()";

  // ── Etiquetas legibles ────────────────────────────────────────────
  // El servicio devuelve el enum crudo (HOURLY, FULL_TIME...) y eso no
  // se le puede mostrar a un empleado.
  //
  // OJO CON EL LARGO. El campo "info" de la card mide 82 px a 300 px de
  // columna; lo medi renderizando. Lo que pase de ahi se parte en dos
  // lineas, crece el item y el ultimo proyecto se sale de la card.
  // Por eso "Tiempo completo" (82 px, se partia) es "Completo" (60 px).
  // Anchos medidos: Parcial 42 · Hibrido 44 · Remoto 48 · Practica 50
  // Por dias 50 · Temporal 57 · Por horas 59 · Completo 60
  // Indefinido 61 · Presencial 64 · Contratista 67 · Practicante 69.
  // Si agregas etiquetas nuevas, no pases de 11 caracteres.
  var LIMITE = 11;

  var ETIQUETAS = {
    FULL_TIME:   "Completo",
    PART_TIME:   "Parcial",
    HOURLY:      "Por horas",
    DAILY:       "Por dias",
    WEEKLY:      "Semanal",
    MONTHLY:     "Mensual",
    REMOTE:      "Remoto",
    HYBRID:      "Hibrido",
    ONSITE:      "Presencial",
    ON_SITE:     "Presencial",
    CONTRACTOR:  "Contratista",
    INTERN:      "Practicante",
    TEMPORARY:   "Temporal",
    PERMANENT:   "Indefinido",
    BILLABLE:    "Facturable",
    NON_BILLABLE:"Interno",
    ACTIVE:      "Vigente",
    CLOSED:      "Cerrado"
  };

  function etiqueta(v) {
    if (!v) { return ""; }
    var k = String(v).trim().toUpperCase().replace(/[\s-]+/g, "_");
    if (ETIQUETAS[k]) { return ETIQUETAS[k]; }

    // Valor que no esta en la tabla: se embellece solo.
    // WEEKEND_SHIFT -> "Weekend shift" -> no cabe -> "Weekend".
    var t = k.toLowerCase().replace(/_/g, " ");
    t = t.charAt(0).toUpperCase() + t.slice(1);
    if (t.length > LIMITE) { t = t.split(" ")[0]; }
    if (t.length > LIMITE) { t = t.slice(0, LIMITE - 1) + "\u2026"; }
    return t;
  }

  return Extension.extend("com.sabnez.cards.proyectosactuales.Extension", {
    getData: function () {
      var oCard = this.getCard();
      var p = (oCard.getCombinedParameters && oCard.getCombinedParameters()) || {};
      var sUrl = p.urlProyectos || ("{{destinations.sabnezApi}}" + (p.pathProyectos || PATH_DEFECTO));

      return oCard.request({ url: sUrl, method: "GET", parameters: { "$format": "json" } })
        .then(function (d) {
          var rows = Array.isArray(d) ? d : (Array.isArray(d.value) ? d.value : []);
          rows = rows.filter(function (x) { return x.modalidad !== "INTERNAL"; });
          rows.sort(function (a, b) {
            return Number(b.carga || 0) - Number(a.carga || 0)
              || Number(a.diasParaCorte || 0) - Number(b.diasParaCorte || 0);
          });
          return {
            items: rows.map(function (x) {
              var cutoff = x.fechaCorte
                ? new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", timeZone: "UTC" })
                    .format(new Date(x.fechaCorte + "T00:00:00Z"))
                    .replace(".", "")
                : "";
              return {
                proyectoNombre: x.proyectoNombre || x.proyectoCodigo || "Proyecto",
                // Solo el cliente. Medido: con "Rol: ... - Modalidad: ..." se
                // cortaba incluso a 400 px de columna.
                descripcion: (x.clienteNombre || "") + (x.carga ? " · " + Number(x.carga) + " %" : ""),
                // La modalidad entra desde 280 px. Si tus columnas son de
                // 320 px o mas, puedes cambiarla por el rol: x.rol
                info: cutoff ? "Corte " + cutoff : (etiqueta(x.modalidad) || "Vigente"),
                infoState: x.estadoCorte || "Information"
              };
            })
          };
        });
    }
  });
});
