"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCountryCode, appliesToCalendar, fetchPublicHolidays } = require("../srv/lib/holiday-provider");

test("normaliza el código ISO del país", () => {
  assert.equal(normalizeCountryCode(" cl "), "CL");
  assert.throws(() => normalizeCountryCode("Chile"));
});

test("incluye festivos nacionales y sólo los regionales aplicables", () => {
  const national = { holidayType: "Public", nationalHoliday: true, subdivisionCodes: [] };
  const regional = { holidayType: "Public", nationalHoliday: false, subdivisionCodes: ["CL-BI"] };
  assert.equal(appliesToCalendar(national, null), true);
  assert.equal(appliesToCalendar(regional, "CL-BI"), true);
  assert.equal(appliesToCalendar(regional, "CL-RM"), false);
});

test("sincroniza y normaliza la respuesta sin depender de la red", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [{
      date: "2026-08-15", localName: "Asunción de la Virgen", name: "Assumption of Mary", countryCode: "CL",
      global: true, counties: null, types: ["Public"],
    }],
  });
  const rows = await fetchPublicHolidays({ countryCode: "cl", year: 2026, fetchImpl });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, "2026-08-15");
  assert.equal(rows[0].countryCode, "CL");
  assert.equal(rows[0].name, "Asunción de la Virgen");
  assert.equal(rows[0].externalKey, "CL|2026-08-15||Asunción de la Virgen");
});

test("distingue dos festivos del mismo país y fecha", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [
      { date: "2026-05-10", localName: "Día de las Madres", countryCode: "SV", global: true, types: ["Public"] },
      { date: "2026-05-10", localName: "Día del Padre", countryCode: "SV", global: true, types: ["Public"] },
    ],
  });
  const rows = await fetchPublicHolidays({ countryCode: "SV", year: 2026, fetchImpl });
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].externalKey, rows[1].externalKey);
});
