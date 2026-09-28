sap.ui.define([], function () {
  "use strict";

  var ESTADO = {
    DRAFT: "Borrador",
    ACTIVE: "Activo",
    INACTIVE: "Inactivo",
    CLOSED: "Cerrado",
  };
  var ESTADO_STATE = {
    DRAFT: "Warning",
    ACTIVE: "Success",
    INACTIVE: "None",
    CLOSED: "Information",
  };
  var MODALIDAD = {
    FULL_TIME: "Tiempo completo",
    HOURLY: "Por horas",
    MIXED: "Mixto",
    INTERNAL: "Interno",
  };
  var TIPO_APROBADOR = {
    ADMIN: "Administrativo",
    LEADER: "Líder de proyecto",
    BACKUP: "Suplente",
  };
  var ESQUEMA = {
    LEADER_THEN_ADMIN: "Líder y luego administración",
    LEADER_ONLY: "Solo líder",
    ADMIN_ONLY: "Solo administración",
    LEADER_OR_ADMIN: "Líder o administración",
  };
  var TIPO_TIEMPO = {
    REGULAR: "Jornada ordinaria",
    OVERTIME: "Horas extra",
    NIGHT: "Recargo nocturno",
    SUNDAY: "Dominical",
    HOLIDAY: "Festivo",
    COMPENSATORY: "Tiempo compensatorio",
    FLEX_INCLUDED: "Flexible incluido",
  };
  var TRATAMIENTO = {
    INCLUDED_FULL_TIME: "Incluido en la mensualidad",
    BILLABLE_REGULAR: "Se factura como ordinaria",
    BILLABLE_OVERTIME: "Se factura como extra",
    SPECIAL_RATE: "Tarifa especial",
    NON_BILLABLE: "No se factura",
    PENDING: "Sin clasificar",
  };
  var TRATAMIENTO_STATE = {
    INCLUDED_FULL_TIME: "Success",
    BILLABLE_REGULAR: "Success",
    BILLABLE_OVERTIME: "Success",
    SPECIAL_RATE: "Information",
    NON_BILLABLE: "Warning",
    PENDING: "Error",
  };
  var MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

  function fecha(value) {
    if (!value) return "";
    var parts = String(value).slice(0, 10).split("-");
    if (parts.length !== 3) return String(value);
    var mes = MESES[Number(parts[1]) - 1] || parts[1];
    return Number(parts[2]) + " " + mes + " " + parts[0];
  }

  return {
    estado: function (value) {
      return ESTADO[value] || value || "";
    },
    estadoState: function (value) {
      return ESTADO_STATE[value] || "None";
    },
    modalidad: function (value) {
      return MODALIDAD[value] || value || "";
    },
    tipoAprobador: function (value) {
      return TIPO_APROBADOR[value] || value || "";
    },
    tipoTiempo: function (value) {
      return TIPO_TIEMPO[value] || value || "";
    },
    tratamiento: function (value) {
      return TRATAMIENTO[value] || value || "";
    },
    tratamientoState: function (value) {
      return TRATAMIENTO_STATE[value] || "None";
    },
    // El factor sólo se muestra cuando dice algo. Un "x1" repetido en
    // cada fila es ruido; un "x1,75" es información.
    factor: function (value) {
      var n = Number(value);
      if (!isFinite(n) || n === 1) return "—";
      return "x" + String(n).replace(".", ",");
    },
    // Días de plazo, con el matiz de si el contrato lo hereda del cliente.
    plazoPago: function (dias, heredado) {
      if (dias == null || dias === "") return "Sin definir";
      var texto = dias === 0 ? "De contado" : dias + " días";
      return heredado ? texto + " (del cliente)" : texto;
    },
    esquemaAprobacion: function (value) {
      return ESQUEMA[value] || value || "";
    },
    activo: function (value) {
      return value ? "Activo" : "Inactivo";
    },
    activoState: function (value) {
      return value ? "Success" : "None";
    },
    fecha: fecha,
    vigencia: function (desde, hasta) {
      if (!desde) return "";
      return fecha(desde) + " — " + (hasta ? fecha(hasta) : "sin fecha fin");
    },
    // "4 de 26 proyectos" — vacío cuando no hay filtro activo
    conteo: function (visibles, total, singular, plural) {
      var v = visibles || 0;
      var t = total || 0;
      var sustantivo = t === 1 ? singular : plural;
      return v === t ? v + " " + sustantivo : v + " de " + t + " " + sustantivo;
    },
    importe: function (value, moneda) {
      if (value === null || value === undefined || value === "") return "";
      var numero = Number(value);
      if (!isFinite(numero)) return String(value);
      return numero.toLocaleString("es-CO", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }) + (moneda ? " " + moneda : "");
    },
  };
});
