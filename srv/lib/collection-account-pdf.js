"use strict";

const pdfmake = require("pdfmake");
const { SABNEZ_LOGO_DATA_URI } = require("./sabnez-logo");
const { montoEnLetras } = require("./money-words");

// Paleta corporativa del formato de cuenta de cobro.
const AZUL = "#174A7E";
const TEXTO = "#1D2D3E";
const ETIQUETA = "#66788A";
const BORDE = "#D9E2EA";
const FILA_ALTERNA = "#F5F9FD";
const DESTACADO = "#EAF3FC";

const EMISOR = Object.freeze({
  nombre: "SABNEZ CONSULTING SAS",
  nit: "NIT 901.763.614-4",
});

const MODALIDAD_TEXT = Object.freeze({
  FULL_TIME: "Tiempo completo",
  HOURLY: "Por horas",
  MIXED: "Mixta",
  INTERNAL: "Interna",
});

const ESTADO_TEXT = Object.freeze({
  DRAFT: "Borrador",
  PENDING_SIGNATURE: "Pendiente de firma",
  SIGNED: "Firmada",
  SUBMITTED: "Enviada a RR. HH.",
  UNDER_HR_REVIEW: "En revisión de RR. HH.",
  CORRECTION_REQUESTED: "Corrección solicitada",
  HR_APPROVED: "Aprobada por RR. HH.",
  HR_REJECTED: "Devuelta por RR. HH.",
  CANCELLED: "Cancelada",
});

// Helvetica es una de las 14 fuentes estándar de PDF: no hay que empaquetar
// archivos .ttf y el documento generado pesa unos pocos KB.
const FUENTE = Object.freeze({
  normal: "Helvetica",
  bold: "Helvetica-Bold",
  italics: "Helvetica-Oblique",
  bolditalics: "Helvetica-BoldOblique",
});
const FUENTES_PERMITIDAS = new Set(Object.values(FUENTE));

// El documento no descarga recursos externos ni lee el sistema de archivos:
// el logotipo viaja embebido como data URI y las fuentes son estándar.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => FUENTES_PERMITIDAS.has(path));
pdfmake.addFonts({ Helvetica: { ...FUENTE } });

/**
 * Genera el PDF de la cuenta de cobro.
 * @param {object} account fila de CollectionAccounts con los snapshots y la firma ya resueltos
 * @param {Array<object>} items conceptos de la cuenta
 * @returns {Promise<Buffer>}
 */
async function buildCollectionAccountPdf(account, items = []) {
  const currency = account.currency || "COP";
  const documentoID = String(account.ID || "");
  const codigoFirma = String(account.signatureHash || "").slice(0, 12).toUpperCase();
  const firmaManuscrita = account.signatureMethod === "MANUSCRIPT" || account.origin === "ASSISTED_FINANCE";

  const conceptos = items.map((item, index) => {
    const relleno = index % 2 === 1 ? FILA_ALTERNA : null;
    return [
      celda(proyecto(item), { fillColor: relleno }),
      celda(item.concept, { fillColor: relleno }),
      celda(MODALIDAD_TEXT[item.modality] || item.modality || "—", { fillColor: relleno, alignment: "center" }),
      celda(periodo(item.serviceStart, item.serviceEnd), { fillColor: relleno }),
      celda(item.approvedHours == null ? "—" : `${formatNumber(item.approvedHours)} h`, { fillColor: relleno, alignment: "right" }),
      celda(formatMoney(item.amount, currency), { fillColor: relleno, alignment: "right" }),
    ];
  });

  const docDefinition = {
    info: {
      title: `Cuenta de cobro ${account.numero || ""}`.trim(),
      author: EMISOR.nombre,
      subject: "Cuenta de cobro por servicios profesionales",
      creator: "Sabnez Enterprise Platform",
    },
    pageSize: "A4",
    pageMargins: [57, 78, 57, 52],
    defaultStyle: { font: "Helvetica", fontSize: 9.5, color: TEXTO, lineHeight: 1.15 },

    header: () => ({
      margin: [57, 22, 57, 0],
      columns: [
        { image: SABNEZ_LOGO_DATA_URI, width: 26, height: 26 },
        { text: "SABNEZ CONSULTING", style: "marca", margin: [8, 7, 0, 0], width: "*" },
        { text: "CUENTA DE COBRO", style: "marcaSecundaria", width: "auto", margin: [0, 9, 0, 0] },
      ],
    }),

    footer: (currentPage, pageCount) => ({
      margin: [57, 8, 57, 0],
      text: `Documento generado por Sabnez Enterprise Platform  |  ID ${documentoID}  |  Página ${currentPage} de ${pageCount}`,
      style: "pie",
    }),

    content: [
      { text: "Cuenta de cobro", style: "titulo" },
      { text: `Servicios profesionales prestados a ${EMISOR.nombre}`, style: "subtitulo" },

      cuadro([
        [campo("NÚMERO", account.numero), campo("FECHA DE EMISIÓN", formatDate(soloFecha(account.signedAt || account.createdAt)))],
        [campo("PERIODO COBRADO", `${formatDate(account.periodStart)} - ${formatDate(account.periodEnd)}`), campo("ESTADO", ESTADO_TEXT[account.status] || account.status)],
      ], { margin: [0, 14, 0, 0] }),

      { text: "Partes", style: "seccion" },
      cuadro([[
        campo("PAGA", [EMISOR.nombre, EMISOR.nit]),
        campo("PRESTADOR", [
          account.employeeNameSnapshot,
          [account.documentTypeSnapshot, account.documentNumberSnapshot].filter(Boolean).join(" ") +
            (account.documentCitySnapshot ? ` de ${account.documentCitySnapshot}` : ""),
        ]),
      ]]),

      { text: "Detalle de los servicios", style: "seccion" },
      {
        table: {
          headerRows: 1,
          dontBreakRows: true,
          widths: ["20%", "25%", "13%", "15%", "11%", "16%"],
          body: [
            ["Proyecto", "Concepto", "Modalidad", "Periodo", "Horas aprobadas", "Valor"]
              .map((text) => celda(text, { style: "encabezadoTabla", alignment: "center", fillColor: AZUL })),
            ...(conceptos.length ? conceptos : [[celda("Sin conceptos registrados", { colSpan: 6, alignment: "center", color: ETIQUETA }), {}, {}, {}, {}, {}]]),
          ],
        },
        layout: lineasHorizontales(),
      },
      {
        table: {
          widths: ["59%", "41%"],
          body: [[
            celda("Valor bruto", { bold: true, fillColor: DESTACADO }),
            celda(formatMoney(account.grossAmount, currency), { bold: true, fillColor: DESTACADO, alignment: "right", color: AZUL, fontSize: 11 }),
          ]],
        },
        layout: lineasHorizontales(),
      },
      {
        margin: [0, 8, 0, 0],
        text: [
          { text: "Valor en letras  ", bold: true },
          { text: montoEnLetras(account.grossAmount, currency) },
        ],
      },

      { text: "Información para el pago", style: "seccion" },
      cuadro([
        [campo("BANCO", account.bankNameSnapshot), campo("TIPO DE CUENTA", tipoCuenta(account.bankAccountTypeSnapshot))],
        [campo("NÚMERO DE CUENTA", account.bankAccountNumberSnapshot), campo("TITULAR", account.bankHolderSnapshot)],
      ]),

      {
        margin: [0, 12, 0, 0],
        text: [
          { text: "Declaración tributaria  ", bold: true },
          { text: "La presente cuenta se expide por el valor bruto de los honorarios. Las retenciones tributarias aplicables serán determinadas por Contabilidad al momento del pago." },
        ],
      },

      {
        margin: [0, 12, 0, 0],
        unbreakable: true,
        table: {
          widths: ["50%", "50%"],
          body: [[
            celda([
              { text: "FIRMA DEL PRESTADOR", bold: true, margin: [0, 0, 0, 14] },
              firmaManuscrita && !account.signedAt
                ? { text: "\n\n________________________________", color: ETIQUETA, margin: [0, 8, 0, 7] }
                : { text: account.signatureName || "", style: "firmaVisual" },
              { text: account.employeeNameSnapshot || "", bold: true },
              { text: [account.documentTypeSnapshot, account.documentNumberSnapshot].filter(Boolean).join(" "), bold: true },
              account.signatureStatement ? { text: account.signatureStatement, style: "declaracion" } : null,
            ].filter(Boolean), { padding: true }),
            celda([
              { text: firmaManuscrita ? "CONTROL DEL DOCUMENTO" : "EVIDENCIA DE FIRMA ELECTRÓNICA", color: ETIQUETA, margin: [0, 0, 0, 14] },
              dato("Fecha y hora", formatShortDateTime(account.signedAt)),
              dato("Método", firmaManuscrita ? "Firma manuscrita; documento cargado por Finanzas" : "Firma electrónica en Sabnez Enterprise Platform"),
              dato("Código de verificación", codigoFirma),
              account.signatureHash ? dato("Huella de firma", account.signatureHash, { fontSize: 7.5 }) : null,
            ].filter(Boolean), { padding: true }),
          ]],
        },
        layout: cuadroLayout(),
      },
    ],

    styles: {
      marca: { fontSize: 11, bold: true, color: AZUL, characterSpacing: 0.3 },
      marcaSecundaria: { fontSize: 7.5, bold: true, color: ETIQUETA, characterSpacing: 0.8 },
      pie: { fontSize: 7.5, color: ETIQUETA, alignment: "center" },
      titulo: { fontSize: 23, bold: true, margin: [0, 0, 0, 2] },
      subtitulo: { fontSize: 9, color: ETIQUETA },
      seccion: { fontSize: 10.5, bold: true, margin: [0, 16, 0, 6] },
      encabezadoTabla: { bold: true, color: "#FFFFFF", fontSize: 8 },
      etiqueta: { fontSize: 7.5, bold: true, color: ETIQUETA, characterSpacing: 0.5 },
      firmaVisual: { fontSize: 15, bold: true, italics: true, margin: [0, 0, 0, 4] },
      declaracion: { fontSize: 7.5, italics: true, color: ETIQUETA, margin: [0, 10, 0, 0] },
    },
  };

  const pdf = pdfmake.createPdf(docDefinition);
  const buffer = await pdf.getBuffer();
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}

// ---------------------------------------------------------------- constructores

// Cuadro de dos columnas con etiqueta arriba y valor debajo, como en el formato oficial.
function cuadro(filas, options = {}) {
  return {
    margin: options.margin || [0, 0, 0, 0],
    table: { widths: ["50%", "50%"], body: filas },
    layout: cuadroLayout(),
  };
}

function campo(etiqueta, valor) {
  const valores = Array.isArray(valor) ? valor : [valor];
  return celda([
    { text: etiqueta, style: "etiqueta", margin: [0, 0, 0, 2] },
    ...valores.map((text) => ({ text: text == null || text === "" ? "—" : String(text) })),
  ], { padding: true });
}

function dato(etiqueta, valor, options = {}) {
  return {
    margin: [0, 0, 0, 1.5],
    ...options,
    text: [
      { text: `${etiqueta}  `, color: ETIQUETA },
      { text: valor == null || valor === "" ? "—" : String(valor) },
    ],
  };
}

function celda(contenido, options = {}) {
  const base = options.padding ? { margin: [4, 6, 4, 6] } : { margin: [2, 4, 2, 4] };
  if (Array.isArray(contenido)) return { ...base, ...options, stack: contenido };
  return { ...base, ...options, text: contenido == null || contenido === "" ? "—" : String(contenido) };
}

// ------------------------------------------------------------------- layouts

// Borde completo, como los cuadros de datos del formato.
function cuadroLayout() {
  return {
    hLineWidth: () => 0.75,
    vLineWidth: () => 0.75,
    hLineColor: () => BORDE,
    vLineColor: () => BORDE,
    paddingLeft: () => 6,
    paddingRight: () => 6,
    paddingTop: () => 2,
    paddingBottom: () => 2,
  };
}

// Solo líneas horizontales: usado por la tabla de conceptos y el total.
function lineasHorizontales() {
  return {
    hLineWidth: () => 0.75,
    vLineWidth: () => 0,
    hLineColor: () => BORDE,
    paddingLeft: () => 4,
    paddingRight: () => 4,
    paddingTop: () => 2,
    paddingBottom: () => 2,
  };
}

// ----------------------------------------------------------------- formateo

// Nombre del proyecto con el cliente debajo, en gris y más pequeño.
function proyecto(item) {
  const nombre = item.projectName || item.projectCode || "—";
  if (!item.clientName) return nombre;
  return [{ text: nombre }, { text: item.clientName, fontSize: 8, color: ETIQUETA }];
}

// El periodo se imprime en dos líneas cortas para que quepa en la columna.
function periodo(desde, hasta) {
  return [{ text: formatShortDate(desde) }, { text: `al ${formatShortDate(hasta)}` }];
}

function tipoCuenta(value) {
  if (!value) return null;
  const texto = String(value).toLowerCase();
  return texto.charAt(0).toLocaleUpperCase("es-CO") + texto.slice(1);
}

function soloFecha(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("es-CO", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatMoney(value, currency) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: currency || "COP", maximumFractionDigits: 2 }).format(Number(value || 0));
}

function formatShortDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${String(value).slice(0, 10)}T00:00:00Z`));
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", day: "2-digit", month: "long", year: "numeric" }).format(new Date(`${String(value).slice(0, 10)}T00:00:00Z`));
}

// Formato compacto para el bloque de evidencia de firma: 07/09/2026 12:45.
function formatShortDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)).replace(",", "");
}

module.exports = { buildCollectionAccountPdf };
