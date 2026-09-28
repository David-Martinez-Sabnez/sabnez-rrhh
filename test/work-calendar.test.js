"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isWorkingDay, businessDaysBetween, nonWorkingDays } = require("../srv/lib/work-calendar");

function calendar(countryCode, holidays = []) {
  return {
    countryCode,
    monday: true, tuesday: true, wednesday: true, thursday: true, friday: true,
    saturday: false, sunday: false,
    holidays: new Map(holidays.map((h) => [h.date, [h]])),
  };
}

test("calcula días hábiles con el calendario del proyecto", () => {
  const chile = calendar("CL", [{ date: "2026-09-18", name: "Fiestas Patrias" }]);
  assert.equal(isWorkingDay(chile, "2026-09-18"), false);
  assert.equal(businessDaysBetween(chile, "2026-09-14", "2026-09-18"), 4);
});

test("combina festivos de varios países para la experiencia del empleado", () => {
  const colombia = calendar("CO", [{ date: "2026-08-07", name: "Batalla de Boyacá" }]);
  const chile = calendar("CL", [{ date: "2026-08-15", name: "Asunción de la Virgen" }]);
  const rows = nonWorkingDays([colombia, chile], "2026-08-07", "2026-08-15");
  assert.match(rows.find((r) => r.fecha === "2026-08-07").motivo, /CO/);
  assert.match(rows.find((r) => r.fecha === "2026-08-15").motivo, /CL/);
});
