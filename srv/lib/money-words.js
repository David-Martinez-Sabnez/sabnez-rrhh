"use strict";

const UNIDADES = [
  "cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve",
  "diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete",
  "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidós", "veintitrés",
  "veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve",
];
const DECENAS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const CENTENAS = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];
const MONEDAS = Object.freeze({
  COP: { singular: "peso colombiano", plural: "pesos colombianos" },
  USD: { singular: "dólar estadounidense", plural: "dólares estadounidenses" },
  EUR: { singular: "euro", plural: "euros" },
});

// Convierte 0-999 a letras. `apocope` aplica la forma corta "un" (un mil, veintiún millones).
function centenasEnLetras(value, apocope) {
  if (value === 100) return "cien";
  const centena = Math.floor(value / 100);
  const resto = value % 100;
  const partes = [];
  if (centena) partes.push(CENTENAS[centena]);
  if (resto) partes.push(decenasEnLetras(resto, apocope));
  return partes.join(" ");
}

function decenasEnLetras(value, apocope) {
  if (value < 30) {
    if (apocope && value === 1) return "un";
    if (apocope && value === 21) return "veintiún";
    return UNIDADES[value];
  }
  const decena = Math.floor(value / 10);
  const unidad = value % 10;
  if (!unidad) return DECENAS[decena];
  const sufijo = apocope && unidad === 1 ? "un" : UNIDADES[unidad];
  return `${DECENAS[decena]} y ${sufijo}`;
}

/**
 * Convierte un entero no negativo a letras en español.
 * `apocope` usa la forma corta delante de un sustantivo: "un peso", "veintiún pesos".
 */
function enteroEnLetras(value, apocope = false) {
  const entero = Math.trunc(Math.abs(Number(value) || 0));
  if (entero === 0) return "cero";
  if (entero > 999999999999) return String(entero);

  const millones = Math.floor(entero / 1000000);
  const miles = Math.floor((entero % 1000000) / 1000);
  const resto = entero % 1000;
  const partes = [];

  if (millones === 1) partes.push("un millón");
  else if (millones > 1) partes.push(`${grupoEnLetras(millones)} millones`);
  if (miles === 1) partes.push("mil");
  else if (miles > 1) partes.push(`${centenasEnLetras(miles, true)} mil`);
  if (resto) partes.push(centenasEnLetras(resto, apocope));

  return partes.join(" ");
}

// Los millones se leen como un número completo: "dos mil quinientos millones".
function grupoEnLetras(value) {
  const miles = Math.floor(value / 1000);
  const resto = value % 1000;
  const partes = [];
  if (miles === 1) partes.push("mil");
  else if (miles > 1) partes.push(`${centenasEnLetras(miles, true)} mil`);
  if (resto) partes.push(centenasEnLetras(resto, true));
  return partes.join(" ");
}

/**
 * Devuelve el valor en letras listo para imprimir en la cuenta de cobro.
 * Ej.: 5000000 COP -> "Cinco millones de pesos colombianos"
 *      4350500,50 COP -> "Cuatro millones trescientos cincuenta mil quinientos pesos colombianos con 50/100"
 */
function montoEnLetras(value, currency = "COP") {
  const amount = Math.abs(Number(value) || 0);
  const entero = Math.trunc(amount);
  const centavos = Math.round((amount - entero) * 100);
  const moneda = MONEDAS[String(currency || "COP").toUpperCase()] || {
    singular: String(currency).toUpperCase(),
    plural: String(currency).toUpperCase(),
  };

  const letras = enteroEnLetras(entero, true);
  const nombre = entero === 1 ? moneda.singular : moneda.plural;
  // "un millón DE pesos": el "de" solo aplica cuando la cifra termina en millón/millones.
  const conector = /mill(ón|ones)$/.test(letras) ? "de " : "";
  const base = `${letras} ${conector}${nombre}`;
  const texto = centavos ? `${base} con ${String(centavos).padStart(2, "0")}/100` : base;
  return texto.charAt(0).toLocaleUpperCase("es-CO") + texto.slice(1);
}

module.exports = { montoEnLetras, enteroEnLetras };
