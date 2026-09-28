"use strict";

/**
 * La TRM, que es el precio oficial del dólar de cada día.
 *
 * Importa porque una factura en dólares se contabiliza a la TRM del día
 * en que se emite y se cobra a la del día en que entra la plata. Entre
 * una y otra pasan treinta días y el dólar se mueve; esa diferencia es
 * dinero real que hoy no aparece por ninguna parte.
 *
 * La fuente es el conjunto de datos abiertos que publica la
 * Superintendencia Financiera. Si el entorno no puede salir a internet
 * se digita a mano y la fila queda marcada como MANUAL, para que nadie
 * confunda un dato oficial con uno tecleado.
 */

const FUENTE =
  "https://www.datos.gov.co/resource/32sa-8pi3.json";

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toISODate(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

/**
 * Convierte lo que publica la fuente en filas para la tabla.
 *
 * La TRM trae vigencia de varios días: la del viernes rige hasta el
 * domingo. Se conserva el rango tal cual en vez de partirlo en días,
 * porque es como se publica y como la exige la DIAN.
 */
function parseOfficialRows(rows) {
  const filas = Array.isArray(rows) ? rows : [];
  const resultado = [];
  for (const fila of filas) {
    const rate = num(fila && fila.valor);
    const validFrom = toISODate(fila && fila.vigenciadesde);
    if (!rate || !validFrom) continue;
    resultado.push({
      currency: "USD",
      validFrom,
      validTo: toISODate(fila.vigenciahasta) || validFrom,
      rate,
      source: "BANREP",
    });
  }
  // De más reciente a más antigua, sin repetidos por fecha de inicio.
  const vistas = new Set();
  return resultado
    .sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))
    .filter((f) => {
      const clave = `${f.currency}|${f.validFrom}`;
      if (vistas.has(clave)) return false;
      vistas.add(clave);
      return true;
    });
}

/**
 * Trae la TRM oficial. Se le inyecta el `fetch` para poder probarlo sin
 * red y para que el servicio decida los tiempos de espera.
 */
async function fetchOfficialRates({ fetchImpl, since, limit = 60 } = {}) {
  const f = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!f) throw new Error("No hay forma de hacer peticiones HTTP en este entorno.");

  const params = new URLSearchParams({
    $order: "vigenciadesde DESC",
    $limit: String(Math.max(1, Math.min(1000, num(limit) || 60))),
  });
  if (since) params.set("$where", `vigenciadesde >= '${toISODate(since)}T00:00:00'`);

  const respuesta = await f(`${FUENTE}?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!respuesta || !respuesta.ok)
    throw new Error(
      `La fuente de TRM respondió ${respuesta ? respuesta.status : "sin respuesta"}.`,
    );
  return parseOfficialRows(await respuesta.json());
}

/**
 * La tasa que rige en una fecha.
 *
 * Primero busca la vigencia que contiene el día. Si no hay ninguna —un
 * festivo que la fuente no cubrió, o un hueco de sincronización— toma la
 * última anterior, que es como se hace en la práctica, y avisa que fue
 * aproximada para que el número no se lea como si fuera oficial.
 */
function resolveRate({ rates, currency = "USD", date }) {
  const dia = toISODate(date);
  const moneda = String(currency || "USD").toUpperCase();
  if (moneda === "COP") return { rate: 1, exact: true, source: "COP" };
  if (!dia) return { rate: null, exact: false, source: null };

  const candidatas = (Array.isArray(rates) ? rates : [])
    .filter((f) => String(f.currency || "USD").toUpperCase() === moneda)
    .sort((a, b) => (toISODate(a.validFrom) < toISODate(b.validFrom) ? 1 : -1));

  const exacta = candidatas.find((f) => {
    const desde = toISODate(f.validFrom);
    const hasta = toISODate(f.validTo) || desde;
    return desde <= dia && dia <= hasta;
  });
  if (exacta) return { rate: num(exacta.rate), exact: true, source: exacta.source, validFrom: exacta.validFrom };

  const anterior = candidatas.find((f) => toISODate(f.validFrom) <= dia);
  if (anterior)
    return { rate: num(anterior.rate), exact: false, source: anterior.source, validFrom: anterior.validFrom };

  return { rate: null, exact: false, source: null };
}

/**
 * Días hábiles del rango que se quedaron sin TRM.
 *
 * Sirve para avisar en la app en vez de dejar que alguien emita una
 * factura en dólares con una tasa de hace dos semanas sin enterarse.
 */
function missingRateDates({ rates, from, to, currency = "USD" }) {
  const desde = toISODate(from);
  const hasta = toISODate(to);
  if (!desde || !hasta || desde > hasta) return [];
  const faltantes = [];
  const cursor = new Date(`${desde}T00:00:00Z`);
  const fin = new Date(`${hasta}T00:00:00Z`);
  while (cursor <= fin) {
    const dia = cursor.toISOString().slice(0, 10);
    const finDeSemana = cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6;
    if (!finDeSemana && !resolveRate({ rates, currency, date: dia }).exact)
      faltantes.push(dia);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return faltantes;
}

/**
 * Qué filas hay que insertar: sólo las que no estén ya guardadas. Traer
 * la TRM dos veces el mismo día no puede duplicar nada.
 */
function newRatesOnly({ fetched, existing }) {
  const yaEstan = new Set(
    (Array.isArray(existing) ? existing : []).map(
      (f) => `${String(f.currency || "USD").toUpperCase()}|${toISODate(f.validFrom)}`,
    ),
  );
  return (Array.isArray(fetched) ? fetched : []).filter(
    (f) => !yaEstan.has(`${String(f.currency || "USD").toUpperCase()}|${toISODate(f.validFrom)}`),
  );
}

module.exports = {
  FUENTE,
  parseOfficialRows,
  fetchOfficialRates,
  resolveRate,
  missingRateDates,
  newRatesOnly,
};
