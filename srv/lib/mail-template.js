"use strict";

/**
 * Plantilla única de los correos de Sabnez Enterprise Platform.
 *
 * El orden es lo que la define: primero la tarjeta con los datos accionables y
 * el botón, después el saludo y la explicación. Quien abre el correo en el
 * celular resuelve sin bajar ni leer un párrafo.
 *
 * Dentro de la tarjeta el valor va grande y la etiqueta pequeña debajo: se lee
 * la cifra antes que el rótulo, que es el orden en que la busca el ojo.
 *
 * Todo va con estilos en línea y maquetado con tablas: Outlook usa el motor de
 * Word y no soporta hojas de estilo, flexbox ni grid. El ancho es fluido
 * (`width:100%` con `max-width`), así que no hace falta ninguna media query
 * para que el correo se lea bien en el celular.
 *
 * `buildHtml` acepta dos vocabularios a propósito:
 *   - el nuevo (titulo, datos, accion, llamado, secciones, nota, cierre…);
 *   - el anterior (title, facts, buttonText/buttonUrl, summary, note…).
 * Esa compatibilidad es deliberada: garantiza que ningún correo de la
 * plataforma —presente o futuro, incluido el genérico por defecto— pueda
 * quedarse fuera de este formato por no haber actualizado su llamador.
 */

// -------------------------------------------------------------- identidad
const AZUL = "#174A7E";
const AZUL_CLARO = "#E8F0F8";
const TEXTO = "#1A2733";
const TEXTO_SUAVE = "#5B6E82";
const TEXTO_TENUE = "#8A99A8";
const BORDE = "#DDE4EB";
const FONDO = "#EEF1F5";
const FONDO_TARJETA = "#F7F9FC";

const FUENTE = "'72','72full','Segoe UI',Arial,Helvetica,sans-serif";

// Marca denominativa. El azul está muestreado del logotipo oficial (#325EB4) y
// no es el azul de interfaz. La familia geométrica solo se aplica si el cliente
// de correo la tiene instalada: un correo no puede cargar tipografías web.
const AZUL_MARCA = "#325EB4";
const FUENTE_MARCA = "'Montserrat','Segoe UI',Arial,Helvetica,sans-serif";
const LOGO_CID = "sabnez-logo";

// Colores semánticos: dan el riel de color de la tarjeta y el texto del estado.
// Se conservan las claves antiguas (INFORMATION) además de las nuevas (INFO)
// porque los llamadores históricos usan ambas.
const SEMANTICO = Object.freeze({
  SUCCESS: { riel: "#1B7F4B", texto: "#166B40", fondo: "#EDF7F1" },
  WARNING: { riel: "#D18700", texto: "#8F5A00", fondo: "#FDF6E7" },
  ERROR: { riel: "#C0392B", texto: "#9B2C20", fondo: "#FBEDEC" },
  INFO: { riel: AZUL, texto: AZUL, fondo: AZUL_CLARO },
  INFORMATION: { riel: AZUL, texto: AZUL, fondo: AZUL_CLARO },
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Deduce el color a partir del texto del estado cuando el llamador no lo fija.
 * Se mantiene por compatibilidad: varios tipos mandan el estado crudo.
 */
function estadoSemantico(status = "") {
  const texto = String(status).toLowerCase();
  if (/aprobad|autorizad|complet|atendid|pagad/.test(texto)) return "SUCCESS";
  if (/rechazad|devuelt|cancelad|vencid|error/.test(texto)) return "ERROR";
  if (/pendiente|revisión|revision|espera|corrección|correccion|por vencer/.test(texto)) return "WARNING";
  return "INFORMATION";
}

function paleta(semantic, status) {
  return SEMANTICO[semantic] || SEMANTICO[estadoSemantico(status)] || SEMANTICO.INFO;
}

/**
 * Etiqueta de estado. Ya no se pinta como píldora de color sino como rótulo en
 * versalitas dentro de la tarjeta, pero se conserva exportada porque formaba
 * parte de la API pública del módulo.
 */
function badge(status, semantic) {
  if (!status) return "";
  const color = paleta(semantic, status);
  return `<div style="font-family:${FUENTE};font-size:11.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${color.texto}">${escapeHtml(status)}</div>`;
}

// --------------------------------------------------------------- piezas

/**
 * Normaliza los `facts` heredados al formato de dato destacado.
 * Un fact es {etiqueta|clave, valor, orden, semanticColor}; un dato es
 * {valor, etiqueta, nota, color}. La inversión es intencional: el valor manda.
 */
function normalizarDatos(datos, facts) {
  if (Array.isArray(datos) && datos.length) return datos.filter((d) => d && d.valor !== undefined && d.valor !== null);
  if (!Array.isArray(facts)) return [];
  return facts
    .filter((fact) => fact && fact.valor !== undefined && fact.valor !== null && String(fact.valor).trim() !== "")
    .slice()
    .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))
    .map((fact) => ({
      valor: fact.valor,
      etiqueta: fact.etiqueta || fact.clave || "",
      color: fact.semanticColor,
    }));
}

/**
 * Dato destacado: el valor manda, la etiqueta lo explica debajo.
 * Los valores largos bajan de tamaño; un texto de una línea entera en 19px
 * negrita se lee peor que en 15px, y los facts traen contenido arbitrario.
 */
function datoDestacado({ valor, etiqueta, nota, color }, ultimo) {
  const texto = String(valor);
  const largo = texto.length > 48;
  const tono = (color && SEMANTICO[color]?.texto) || TEXTO;
  return `
  <tr><td style="padding:0 0 ${ultimo ? "4" : "18"}px">
    <div style="font-family:${FUENTE};font-size:${largo ? "15px" : "19px"};line-height:${largo ? "22px" : "26px"};font-weight:700;color:${tono}">${escapeHtml(texto)}</div>
    ${
      etiqueta
        ? `<div style="font-family:${FUENTE};font-size:12.5px;line-height:18px;color:${TEXTO_TENUE};padding-top:1px">${escapeHtml(etiqueta)}${
            nota ? ` <span style="color:${TEXTO_SUAVE}">${escapeHtml(nota)}</span>` : ""
          }</div>`
        : ""
    }
  </td></tr>`;
}

function botonPrimario(texto, url) {
  return `
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr><td align="center" bgcolor="${AZUL}" style="border-radius:4px">
      <a href="${escapeHtml(url)}" style="display:block;padding:14px 20px;font-family:${FUENTE};font-size:15px;font-weight:700;line-height:20px;color:#FFFFFF;text-decoration:none">${escapeHtml(texto)}</a>
    </td></tr>
  </table>`;
}

function botonSecundario(texto, url) {
  return `
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border:1px solid ${AZUL};border-radius:4px">
    <tr><td align="center">
      <a href="${escapeHtml(url)}" style="display:block;padding:11px 18px;font-family:${FUENTE};font-size:14px;font-weight:700;line-height:18px;color:${AZUL};text-decoration:none">${escapeHtml(texto)}</a>
    </td></tr>
  </table>`;
}

/**
 * Nota escrita por una persona (el comentario de RR. HH., por ejemplo).
 * Va enmarcada para que se distinga del texto que genera el sistema: quien lee
 * tiene que saber qué le escribió un humano y qué la plataforma.
 */
function notaDePersona({ autor, texto }) {
  return `
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 22px">
    ${
      autor
        ? `<tr><td style="padding:0 0 6px;font-family:${FUENTE};font-size:12px;font-weight:700;color:${TEXTO_SUAVE}">${escapeHtml(autor)}</td></tr>`
        : ""
    }
    <tr><td style="padding:14px 16px;border:1px solid ${SEMANTICO.WARNING.riel};border-radius:4px;background:${SEMANTICO.WARNING.fondo};font-family:${FUENTE};font-size:14px;line-height:22px;color:${TEXTO}">${escapeHtml(texto)}</td></tr>
  </table>`;
}

/** Resumen neutro del objeto: no lo escribió una persona, no va enmarcado en ámbar. */
function bloqueResumen(texto) {
  return `
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px">
    <tr><td style="padding:13px 16px;border:1px solid ${BORDE};border-radius:4px;background:${FONDO_TARJETA};font-family:${FUENTE};font-size:14px;line-height:22px;color:${TEXTO_SUAVE}">${escapeHtml(texto)}</td></tr>
  </table>`;
}

function seccion({ titulo, parrafos = [], puntos = [] }) {
  return `
  <div style="font-family:${FUENTE};font-size:17px;line-height:24px;font-weight:700;color:${TEXTO};padding:6px 0 8px">${escapeHtml(titulo)}</div>
  ${parrafos.map((p) => `<p style="margin:0 0 12px;font-family:${FUENTE};font-size:14px;line-height:22px;color:${TEXTO_SUAVE}">${escapeHtml(p)}</p>`).join("")}
  ${
    puntos.length
      ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 14px">
          ${puntos
            .map(
              (punto) => `<tr>
            <td width="16" valign="top" style="font-family:${FUENTE};font-size:14px;line-height:22px;color:${AZUL}">•</td>
            <td style="font-family:${FUENTE};font-size:14px;line-height:22px;color:${TEXTO_SUAVE};padding-bottom:6px">${escapeHtml(punto)}</td>
          </tr>`,
            )
            .join("")}
        </table>`
      : ""
  }`;
}

// ------------------------------------------------------------ documento

/**
 * Construye el correo completo.
 *
 * Vocabulario nuevo:
 * @param {object} input
 * @param {string} input.app            Aplicación de origen; primera línea del título.
 * @param {string} input.titulo         Propósito del mensaje, en lenguaje de negocio.
 * @param {string} [input.estado]       Rótulo de estado dentro de la tarjeta.
 * @param {string} [input.semantica]    SUCCESS | WARNING | ERROR | INFO.
 * @param {Array}  [input.datos]        Datos destacados {valor, etiqueta, nota, color}.
 * @param {string} [input.llamado]      Frase corta sobre el botón de la tarjeta.
 * @param {string} [input.llamadoFinal] Frase sobre el botón repetido al cierre.
 * @param {object} [input.accion]       {texto, url} del botón principal.
 * @param {object} [input.accionSecundaria] {texto, url}.
 * @param {string} [input.saludo]
 * @param {Array|string} [input.cuerpo] Párrafos de apertura.
 * @param {Array}  [input.secciones]    {titulo, parrafos, puntos}.
 * @param {object} [input.nota]         {autor, texto} escrito por una persona.
 * @param {string} [input.resumen]      Resumen neutro del objeto.
 * @param {string} [input.cierre]       Despedida.
 * @param {object} [input.soporte]      {texto, correo}; sin él no se pinta el bloque.
 * @param {string} [input.aviso]        Aviso legal del pie.
 * @param {string} [input.logoSrc]      Por defecto el adjunto en línea cid:.
 *
 * Vocabulario heredado, aceptado para que ningún llamador quede fuera del
 * formato: title, greeting, introduction, summary, status, semantic, facts,
 * buttonText, buttonUrl, note.
 */
function buildHtml(input = {}) {
  const {
    app = "Sabnez Enterprise Platform",
    logoSrc = `cid:${LOGO_CID}`,
    llamado,
    llamadoFinal,
    accionSecundaria,
    secciones = [],
    nota,
    soporte,
    cierre = "El equipo de Sabnez",
    aviso = "Mensaje automático de Sabnez Enterprise Platform. No respondas a este correo.",
  } = input;

  // ---- puente entre el vocabulario nuevo y el heredado
  const titulo = input.titulo ?? input.title ?? "";
  const saludo = input.saludo ?? input.greeting ?? "";
  const estado = input.estado ?? input.status;
  const semantica = input.semantica ?? input.semantic;
  const resumen = input.resumen ?? input.summary;
  const datos = normalizarDatos(input.datos, input.facts);
  const accion =
    input.accion || (input.buttonUrl ? { texto: input.buttonText || "Abrir en la plataforma", url: input.buttonUrl } : null);
  const cuerpo = (Array.isArray(input.cuerpo) ? input.cuerpo : [input.cuerpo ?? input.introduction]).filter(Boolean);

  const color = paleta(semantica, estado);
  const preheader = cuerpo[0] || titulo;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(titulo)}</title>
</head>
<body style="margin:0;padding:0;background:${FONDO};font-family:${FUENTE};color:${TEXTO};-webkit-font-smoothing:antialiased">

<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${FONDO}">
<tr><td align="center" style="padding:32px 12px">

<table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;background:#FFFFFF;border:1px solid ${BORDE};border-radius:6px;overflow:hidden">

  <!-- Cabecera: clara, con el logotipo y la marca denominativa -->
  <tr><td style="padding:26px 32px 0">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td valign="middle" width="38" style="padding-right:11px">
          <img src="${escapeHtml(logoSrc)}" width="38" height="38" alt="Sabnez Consulting" style="display:block;width:38px;height:38px;border:0;border-radius:50%">
        </td>
        <td valign="middle" style="font-family:${FUENTE_MARCA};font-size:18px;line-height:24px;letter-spacing:1.7px;color:${AZUL_MARCA}"><span style="font-weight:700">SABNEZ</span> <span style="font-weight:400">CONSULTING</span></td>
      </tr>
    </table>
  </td></tr>

  <!-- Título en dos líneas: el dominio en azul, el propósito en negro -->
  <tr><td style="padding:22px 32px 26px">
    <div style="font-family:${FUENTE};font-size:22px;line-height:29px;font-weight:700;color:${AZUL}">${escapeHtml(app)}</div>
    <div style="font-family:${FUENTE};font-size:22px;line-height:29px;font-weight:400;color:${TEXTO}">${escapeHtml(titulo)}</div>
  </td></tr>

  <!-- Tarjeta accionable: los datos que importan y el botón, antes del texto -->
  ${
    datos.length || accion
      ? `<tr><td style="padding:0 32px 26px">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${FONDO_TARJETA};border-radius:4px">
      <tr>
        <td width="4" bgcolor="${color.riel}" style="width:4px;background:${color.riel};font-size:0;line-height:0">&nbsp;</td>
        <td style="padding:24px 26px">
          ${estado ? `<div style="padding:0 0 16px">${badge(estado, semantica)}</div>` : ""}
          ${
            datos.length
              ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            ${datos.map((dato, i) => datoDestacado(dato, i === datos.length - 1)).join("")}
          </table>`
              : ""
          }
          ${
            accion
              ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:${datos.length ? "22px" : "0"}">
                  <tr><td style="${datos.length ? `border-top:1px solid ${BORDE};padding-top:20px` : ""}">
                    ${llamado ? `<p style="margin:0 0 14px;font-family:${FUENTE};font-size:14px;line-height:21px;color:${TEXTO_SUAVE}">${escapeHtml(llamado)}</p>` : ""}
                    ${botonPrimario(accion.texto, accion.url)}
                    ${accionSecundaria ? `<div style="padding-top:10px">${botonSecundario(accionSecundaria.texto, accionSecundaria.url)}</div>` : ""}
                  </td></tr>
                </table>`
              : ""
          }
        </td>
      </tr>
    </table>
  </td></tr>`
      : ""
  }

  <!-- Cuerpo -->
  <tr><td style="padding:0 32px">
    ${saludo ? `<p style="margin:0 0 14px;font-family:${FUENTE};font-size:17px;line-height:24px;font-weight:700;color:${TEXTO}">${escapeHtml(saludo)}</p>` : ""}
    ${cuerpo.map((p) => `<p style="margin:0 0 14px;font-family:${FUENTE};font-size:14px;line-height:22px;color:${TEXTO_SUAVE}">${escapeHtml(p)}</p>`).join("")}
    ${nota ? notaDePersona(nota) : ""}
    ${resumen ? bloqueResumen(resumen) : ""}
    ${secciones.length ? `<div style="height:10px;line-height:10px;font-size:0">&nbsp;</div>` : ""}
    ${secciones.map(seccion).join("")}
    <p style="margin:18px 0 0;font-family:${FUENTE};font-size:14px;line-height:22px;color:${TEXTO_SUAVE}">${escapeHtml(cierre)}</p>
  </td></tr>

  <!-- El botón se repite al final: quien leyó todo no debe volver a subir -->
  ${
    accion
      ? `<tr><td style="padding:26px 32px 0">
          <div style="font-family:${FUENTE};font-size:14px;font-weight:700;color:${TEXTO};padding-bottom:12px">${escapeHtml(llamadoFinal || `${accion.texto} ahora`)}</div>
          ${botonPrimario(accion.texto, accion.url)}
        </td></tr>`
      : ""
  }

  ${
    soporte?.correo
      ? `<tr><td style="padding:28px 32px 0">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr><td style="border-top:1px solid ${BORDE};padding-top:18px">
              <div style="font-family:${FUENTE};font-size:13px;font-weight:700;color:${TEXTO};padding-bottom:4px">Soporte</div>
              <div style="font-family:${FUENTE};font-size:13px;line-height:20px;color:${TEXTO_SUAVE}">
                <a href="mailto:${escapeHtml(soporte.correo)}" style="color:${AZUL};text-decoration:underline">${escapeHtml(soporte.correo)}</a>${soporte.texto ? ` — ${escapeHtml(soporte.texto)}` : ""}
              </div>
            </td></tr>
          </table>
        </td></tr>`
      : ""
  }

  <tr><td style="padding:26px 32px 30px">
    <p style="margin:0;font-family:${FUENTE};font-size:11.5px;line-height:18px;color:${TEXTO_TENUE}">${escapeHtml(aviso)}</p>
  </td></tr>

</table>

<div style="font-family:${FUENTE};font-size:11.5px;line-height:18px;color:${TEXTO_TENUE};padding:18px 12px 0;max-width:640px">
  © ${new Date().getFullYear()} Sabnez Consulting SAS · NIT 901.763.614-4
</div>

</td></tr>
</table>
</body>
</html>`;
}

module.exports = { buildHtml, escapeHtml, badge, estadoSemantico, LOGO_CID, SEMANTICO };
