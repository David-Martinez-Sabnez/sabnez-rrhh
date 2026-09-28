"use strict";

const cds = require("@sap/cds");
const JSZip = require("jszip");

const { buildHtml } = require("./mail-template");
const { streamToBuffer } = require("./stream-utils");

const LOG = cds.log("accounting-dispatch");

// Microsoft Graph rechaza el mensaje completo por encima de ~4 MB cuando los
// adjuntos van en línea. Se deja margen para el cuerpo y la codificación
// base64, que infla el binario un tercio.
const LIMITE_ADJUNTO_BYTES = 3 * 1024 * 1024;

/**
 * Arma el paquete que recibe la contadora: un ZIP con una carpeta por
 * prestador, cada una con la cuenta de cobro firmada y su soporte de
 * seguridad social, más un CSV de control en la raíz.
 *
 * @param {Array<object>} expedientes filas de CollectionAccounts con documentos
 * @returns {Promise<{buffer: Buffer, incluidos: Array, omitidos: Array}>}
 */
async function buildAccountingZip(expedientes) {
  const zip = new JSZip();
  const incluidos = [];
  const omitidos = [];

  for (const cuenta of expedientes) {
    const documento = await streamToBuffer(cuenta.generatedContent);
    const soporte = await streamToBuffer(cuenta.socialSecurityContent);

    // Sin cuenta firmada no hay nada que validar; sin soporte la contadora no
    // puede verificar la seguridad social, que es justo lo que revisa.
    if (!documento?.length) {
      omitidos.push({ numero: cuenta.numero, motivo: "La cuenta no tiene el documento firmado generado." });
      continue;
    }
    if (!soporte?.length) {
      omitidos.push({ numero: cuenta.numero, motivo: "La cuenta no tiene soporte de seguridad social cargado." });
      continue;
    }

    const carpeta = safeName(`${cuenta.employeeNameSnapshot} - ${cuenta.numero}`);
    zip.file(`${carpeta}/${safeName(cuenta.generatedFileName || `${cuenta.numero}.pdf`)}`, documento);
    zip.file(
      `${carpeta}/soporte-seguridad-social${extensionDe(cuenta.socialSecurityFileName, cuenta.socialSecurityMimeType)}`,
      soporte,
    );

    incluidos.push(cuenta);
  }

  if (incluidos.length) zip.file("resumen.csv", buildCsv(incluidos));

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  return { buffer, incluidos, omitidos };
}

function buildCsv(cuentas) {
  const encabezado = [
    "Número", "Prestador", "Tipo documento", "Número documento",
    "Periodo desde", "Periodo hasta", "Valor bruto", "Moneda",
    "Banco", "Tipo de cuenta", "Número de cuenta", "Titular",
    "Soporte requerido", "Firmada el", "Aprobada el",
  ];
  const filas = cuentas.map((row) => [
    row.numero, row.employeeNameSnapshot, row.documentTypeSnapshot, row.documentNumberSnapshot,
    row.periodStart, row.periodEnd, row.grossAmount, row.currency,
    row.bankNameSnapshot, row.bankAccountTypeSnapshot, row.bankAccountNumberSnapshot, row.bankHolderSnapshot,
    row.socialSecurityRequirement === "AFFILIATION" ? "Afiliación como independiente" : "Comprobante PILA",
    row.signedAt, row.hrReviewedAt,
  ]);
  const csv = [encabezado, ...filas].map((linea) => linea.map(csvCell).join(";")).join("\n");
  // BOM para que Excel en español no rompa los acentos.
  return Buffer.from(`﻿${csv}`, "utf8");
}

/**
 * Cuerpo del correo que acompaña al ZIP.
 *
 * Usa la misma plantilla que el resto de la plataforma: los datos del lote
 * arriba, en la tarjeta, y el listado de prestadores abajo para que la
 * contadora sepa qué trae el paquete sin descomprimirlo.
 */
function buildAccountingEmail({ cuentas, periodo, remitente, total, currency, logoSrc }) {
  const prestadores = cuentas.length;

  return {
    subject: `Cuentas de cobro para validación · ${periodo} · ${prestadores} prestador(es)`,
    html: buildHtml({
      logoSrc,
      app: "Cuentas de Cobro",
      titulo: "Cuentas de cobro aprobadas para pago",
      estado: "Aprobadas para pago",
      semantica: "SUCCESS",
      datos: [
        { valor: formatMoney(total, currency), etiqueta: "Valor bruto total del lote" },
        { valor: String(prestadores), etiqueta: "Cuentas de cobro adjuntas" },
        { valor: periodo, etiqueta: "Periodo" },
        { valor: remitente, etiqueta: "Enviado por" },
      ],
      saludo: "Buen día.",
      cuerpo: [
        `Adjunto encontrarás ${prestadores} cuenta(s) de cobro ya aprobadas por RR. HH., cada una con su ` +
          "soporte de seguridad social para tu validación.",
        "El archivo comprimido trae una carpeta por prestador y un CSV de control con los datos bancarios y los valores.",
      ],
      secciones: [{ titulo: "Prestadores incluidos", puntos: listaPrestadores(cuentas) }],
      aviso:
        "Este envío se generó desde Sabnez Enterprise Platform. Si detectas una inconsistencia, escríbele a RR. HH. antes de procesar el pago.",
    }),
  };
}

// Un renglón por prestador, para leer el lote sin abrir el ZIP.
function listaPrestadores(cuentas) {
  return cuentas.map(
    (row) => `${row.employeeNameSnapshot} — ${row.numero} — ${formatMoney(row.grossAmount, row.currency)}`,
  );
}


function safeName(value) {
  return String(value || "documento")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9 ._-]/g, "")
    .trim()
    .slice(0, 80) || "documento";
}

function extensionDe(fileName, mimeType) {
  const desdeNombre = /\.([a-zA-Z0-9]{2,5})$/.exec(String(fileName || ""));
  if (desdeNombre) return `.${desdeNombre[1].toLowerCase()}`;
  if (String(mimeType).includes("pdf")) return ".pdf";
  if (String(mimeType).includes("png")) return ".png";
  if (String(mimeType).includes("jpeg") || String(mimeType).includes("jpg")) return ".jpg";
  return ".bin";
}

function csvCell(value) {
  const texto = String(value ?? "");
  return /[;"\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

function formatMoney(value, currency) {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: currency || "COP",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

module.exports = {
  buildAccountingZip,
  buildAccountingEmail,
  LIMITE_ADJUNTO_BYTES,
  _internal: { safeName, extensionDe, buildCsv },
};
