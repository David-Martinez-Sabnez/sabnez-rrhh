sap.ui.define([], function () {
  "use strict";

  var ESTADO_FACTURA = {
    DRAFT: "Borrador",
    ISSUED: "Emitida",
    SENT: "Enviada al cliente",
    PARTIALLY_PAID: "Abonada",
    PAID: "Pagada",
    VOID: "Anulada",
  };
  // El estado dice qué hay que hacer, no sólo dónde está: un borrador es
  // trabajo pendiente, una emitida es plata en camino, una pagada ya no
  // pide nada.
  var ESTADO_STATE = {
    DRAFT: "Warning",
    ISSUED: "Information",
    SENT: "Information",
    PARTIALLY_PAID: "Warning",
    PAID: "Success",
    VOID: "None",
  };
  var TIPO_RETENCION = {
    RETEFUENTE: "Retención en la fuente",
    RETEICA: "Retención de ICA",
    RETEIVA: "Retención de IVA",
    OTRA: "Otra retención",
  };
  var AVISO_STATE = {
    TRM: "Warning",
    BORRADOR: "Information",
    CARTERA: "Error",
    TARIFA: "Warning",
  };
  var MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  var MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun",
    "jul", "ago", "sep", "oct", "nov", "dic"];

  function numero(value) {
    var n = Number(value);
    return isFinite(n) ? n : 0;
  }

  // Los pesos no tienen centavos y una cifra con decimales en un tablero
  // sólo estorba. Las monedas extranjeras sí los llevan.
  function importe(value, moneda) {
    var n = numero(value);
    var cop = !moneda || String(moneda).toUpperCase() === "COP";
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: moneda || "COP",
      minimumFractionDigits: cop ? 0 : 2,
      maximumFractionDigits: cop ? 0 : 2,
    }).format(n);
  }

  return {
    // Cifras grandes en un tablero: "$ 33,8 M" se lee de un vistazo,
    // "$ 33.799.936" hay que contarlo con el dedo.
    compacto: function (value) {
      var n = numero(value);
      var signo = n < 0 ? "-" : "";
      var abs = Math.abs(n);
      if (abs >= 1000000000) return signo + "$ " + (abs / 1000000000).toFixed(1).replace(".", ",") + " MM";
      if (abs >= 1000000) return signo + "$ " + (abs / 1000000).toFixed(1).replace(".", ",") + " M";
      if (abs >= 1000) return signo + "$ " + Math.round(abs / 1000) + " mil";
      return signo + "$ " + Math.round(abs);
    },
    importe: importe,
    pesos: function (value) {
      return importe(value, "COP");
    },
    // Positivo o negativo con su signo: la diferencia en cambio se lee
    // mal si no se ve de entrada si ganaste o perdiste.
    conSigno: function (value) {
      var n = numero(value);
      return (n > 0 ? "+" : "") + importe(n, "COP");
    },
    // La misma cifra en la fila de indicadores, donde todo va compacto.
    // Mezclar "$ 28,9 M" con "-$ 2.340.000" al lado hace que las
    // magnitudes dejen de compararse de un vistazo.
    conSignoCompacto: function (value) {
      var n = numero(value);
      var signo = n < 0 ? "-" : n > 0 ? "+" : "";
      var abs = Math.abs(n);
      var texto;
      if (abs >= 1000000000) texto = "$ " + (abs / 1000000000).toFixed(1).replace(".", ",") + " MM";
      else if (abs >= 1000000) texto = "$ " + (abs / 1000000).toFixed(1).replace(".", ",") + " M";
      else if (abs >= 1000) texto = "$ " + Math.round(abs / 1000) + " mil";
      else texto = "$ " + Math.round(abs);
      return signo + texto;
    },
    signoState: function (value) {
      var n = numero(value);
      if (n > 0) return "Success";
      if (n < 0) return "Error";
      return "None";
    },
    horas: function (value) {
      var n = numero(value);
      return (Math.round(n * 100) / 100).toLocaleString("es-CO") + " h";
    },
    estadoFactura: function (value) {
      return ESTADO_FACTURA[value] || value || "";
    },
    estadoFacturaState: function (value) {
      return ESTADO_STATE[value] || "None";
    },
    tipoRetencion: function (value) {
      return TIPO_RETENCION[value] || value || "";
    },
    avisoState: function (value) {
      return AVISO_STATE[value] || "Information";
    },
    // "2026-10" -> "octubre 2026"
    mesLargo: function (value) {
      if (!value) return "";
      var partes = String(value).split("-");
      var m = MESES[Number(partes[1]) - 1];
      return m ? m + " " + partes[0] : String(value);
    },
    mesCorto: function (value) {
      if (!value) return "";
      var partes = String(value).split("-");
      var m = MESES_CORTOS[Number(partes[1]) - 1];
      return m ? m + " " + String(partes[0]).slice(2) : String(value);
    },
    fecha: function (value) {
      if (!value) return "—";
      var partes = String(value).slice(0, 10).split("-");
      if (partes.length !== 3) return String(value);
      var m = MESES_CORTOS[Number(partes[1]) - 1] || partes[1];
      return Number(partes[2]) + " " + m + " " + partes[0];
    },
    rangoFechas: function (desde, hasta) {
      function corta(value) {
        if (!value) return "—";
        var p = String(value).slice(0, 10).split("-");
        var mes = p.length === 3 ? (MESES_CORTOS[Number(p[1]) - 1] || p[1]) : "";
        return p.length === 3 ? Number(p[2]) + " " + mes + " " + p[0] : String(value);
      }
      return corta(desde) + " – " + corta(hasta);
    },
    // "1 ago – 31 ago 2026", o vacío si no hay periodo.
    periodo: function (desde, hasta) {
      if (!desde && !hasta) return "—";
      var f = function (v) {
        if (!v) return "";
        var p = String(v).slice(0, 10).split("-");
        var MC = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
        return Number(p[2]) + " " + (MC[Number(p[1]) - 1] || p[1]);
      };
      var anio = String(hasta || desde).slice(0, 4);
      return f(desde) + " – " + f(hasta) + " " + anio;
    },
    conteo: function (visibles, total) {
      if (visibles === total) return total + " factura(s)";
      return visibles + " de " + total + " factura(s)";
    },
    cantidad: function (value) {
      var n = numero(value);
      if (n === 1) return "1";
      return new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 }).format(n) + " h";
    },
    masIva: function (subtotal, moneda) {
      return importe(subtotal, moneda) + " + IVA";
    },
    pendienteHint: function (pendiente, moneda) {
      var n = numero(pendiente);
      if (n <= 0) return "Nada pendiente";
      return "Faltan " + importe(n, moneda);
    },
    vigencia: function (desde, hasta) {
      var f = function (v) {
        if (!v) return "";
        var p = String(v).slice(0, 10).split("-");
        var MC = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
        return Number(p[2]) + " " + (MC[Number(p[1]) - 1] || p[1]) + " " + p[0];
      };
      if (!desde) return "—";
      if (!hasta) return "Desde " + f(desde);
      if (String(desde).slice(0, 10) === String(hasta).slice(0, 10)) return f(desde);
      return f(desde) + " – " + f(hasta);
    },
    // Se nombra el monto vencido en vez de pintar de rojo el mes entero:
    // que 8 de 34 millones estén atrasados no convierte todo el mes en un
    // problema.
    vencidoNota: function (value) {
      var n = numero(value);
      if (n <= 0) return "";
      var abs = n >= 1000000
        ? "$ " + (n / 1000000).toFixed(1).replace(".", ",") + " M"
        : "$ " + Math.round(n / 1000) + " mil";
      return abs + " ya vencidos";
    },
    // Un cero en horas se muestra como raya: una columna llena de "0 h"
    // es ruido que tapa las filas que sí dicen algo.
    horasOCero: function (value) {
      var n = numero(value);
      if (!n) return "—";
      return (Math.round(n * 100) / 100).toLocaleString("es-CO") + " h";
    },
    costoCompensatorio: function (value) {
      var n = numero(value);
      if (!n) return "Costo ya causado, sin cobrar a nadie";
      return "Unos " + new Intl.NumberFormat("es-CO", {
        style: "currency", currency: "COP",
        minimumFractionDigits: 0, maximumFractionDigits: 0,
      }).format(n) + " de costo sin ingreso";
    },
    ultimoMovimiento: function (value) {
      if (!value) return "";
      var p = String(value).slice(0, 10).split("-");
      var MC = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
      return "último movimiento " + Number(p[2]) + " " + (MC[Number(p[1]) - 1] || p[1]) + " " + p[0];
    },
    /**
     * La barra del saldo de compensatorios. A favor del recurso va hacia
     * la derecha; en rojo y hacia la derecha también cuando está en
     * negativo, porque lo que importa es el tamaño de la anomalía.
     */
    barraSaldo: function (saldo, maximo) {
      var m = numero(maximo);
      var n = numero(saldo);
      if (m <= 0 || n === 0) return '<span class="finBarra"></span>';
      var ancho = Math.max(1, Math.min(100, (Math.abs(n) / m) * 100));
      var clase = n < 0 ? "finBarraDeuda" : "finBarraCompensatorio";
      return '<span class="finBarra"><span class="finBarraTramo ' + clase +
        '" style="width:' + ancho.toFixed(2) + '%"></span></span>';
    },
    plazo: function (dias) {
      if (dias == null || dias === "") return "Sin definir";
      return Number(dias) === 0 ? "De contado" : Number(dias) + " días";
    },
    tasa: function (value) {
      if (!value) return "—";
      return new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 }).format(Number(value));
    },
    porcentaje: function (value) {
      var n = numero(value);
      return new Intl.NumberFormat("es-CO", { maximumFractionDigits: 4 }).format(n) + " %";
    },
    // Ancho de la barra dentro de una fila, en porcentaje del máximo.
    anchoBarra: function (value, maximo) {
      var m = numero(maximo);
      if (m <= 0) return "0%";
      return Math.max(0, Math.min(100, (numero(value) / m) * 100)) + "%";
    },

    /**
     * La barra de caja del mes: lo que ya entró y lo que falta por
     * entrar, en la misma escala que el resto de meses para que las
     * filas se puedan comparar entre sí.
     *
     * Los dos tramos van separados por dos píxeles de fondo para que no
     * se lean como un solo bloque, y cada uno lleva su cifra en la fila,
     * así que la identidad nunca depende sólo del color.
     */
    barraCaja: function (recibida, esperada, maximo) {
      var m = numero(maximo);
      if (m <= 0) return "<span></span>";
      var r = Math.max(0, (numero(recibida) / m) * 100);
      var e = Math.max(0, (numero(esperada) / m) * 100);
      if (r + e <= 0) return '<span class="finBarra"></span>';
      var tramos = "";
      if (r > 0)
        tramos += '<span class="finBarraTramo finBarraRecibida" style="width:' +
          r.toFixed(2) + '%" title="Ya entró"></span>';
      if (e > 0)
        tramos += '<span class="finBarraTramo finBarraEsperada" style="width:' +
          e.toFixed(2) + '%" title="Se espera"></span>';
      return '<span class="finBarra">' + tramos + "</span>";
    },

    /**
     * La barra de un tramo de cartera. Una sola tonalidad de claro a
     * oscuro según la antigüedad: es magnitud ordenada, no identidad.
     */
    barraCartera: function (monto, maximo, clave) {
      var m = numero(maximo);
      var orden = { corriente: 1, d1_30: 2, d31_60: 3, d61_90: 4, d90_mas: 5 };
      var paso = orden[clave] || 1;
      if (m <= 0 || numero(monto) <= 0) return '<span class="finBarra"></span>';
      var ancho = Math.max(1, Math.min(100, (numero(monto) / m) * 100));
      return '<span class="finBarra"><span class="finBarraTramo finCartera' + paso +
        '" style="width:' + ancho.toFixed(2) + '%"></span></span>';
    },
  };
});
