"use strict";

const BASE_URL = "https://date.nager.at/api/v3/PublicHolidays";

function normalizeCountryCode(value) {
  const code = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new Error("El país debe usar un código ISO de dos letras.");
  return code;
}

function normalizeHoliday(item, countryCode) {
  const types = Array.isArray(item?.holidayTypes) ? item.holidayTypes : (Array.isArray(item?.types) ? item.types : []);
  const subdivisions = Array.isArray(item?.subdivisionCodes)
    ? item.subdivisionCodes.filter(Boolean)
    : (Array.isArray(item?.counties) ? item.counties.filter(Boolean) : []);
  const date = String(item?.date || "").slice(0, 10);
  const name = String(item?.localName || item?.name || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !name) return null;
  return {
    date,
    name,
    countryCode,
    subdivisionCodes: subdivisions,
    nationalHoliday: item?.nationalHoliday !== false && item?.global !== false,
    holidayType: types.includes("Public") ? "Public" : (types[0] || "Public"),
    // Un país puede tener más de un festivo público en la misma fecha
    // (por ejemplo, Día de las Madres y Día del Padre en El Salvador).
    // El nombre forma parte de la identidad para no colisionarlos.
    externalKey: [countryCode, date, subdivisions.sort().join(","), name].join("|"),
  };
}

function appliesToCalendar(holiday, subdivisionCode) {
  if (!holiday) return false;
  if (holiday.holidayType !== "Public") return false;
  if (holiday.nationalHoliday || holiday.subdivisionCodes.length === 0) return true;
  const subdivision = String(subdivisionCode || "").trim().toUpperCase();
  return Boolean(subdivision && holiday.subdivisionCodes.map(String).map((v) => v.toUpperCase()).includes(subdivision));
}

async function fetchPublicHolidays({ countryCode, year, subdivisionCode, fetchImpl = globalThis.fetch }) {
  const country = normalizeCountryCode(countryCode);
  const numericYear = Number(year);
  if (!Number.isInteger(numericYear) || numericYear < 2000 || numericYear > 2100)
    throw new Error("El año debe estar entre 2000 y 2100.");
  if (typeof fetchImpl !== "function") throw new Error("El entorno no permite consultar la API de festivos.");

  const response = await fetchImpl(`${BASE_URL}/${numericYear}/${encodeURIComponent(country)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`La API de festivos respondió HTTP ${response.status}.`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("La API de festivos devolvió una respuesta inesperada.");
  return payload
    .map((item) => normalizeHoliday(item, country))
    .filter((item) => appliesToCalendar(item, subdivisionCode));
}

module.exports = { BASE_URL, normalizeCountryCode, normalizeHoliday, appliesToCalendar, fetchPublicHolidays };
