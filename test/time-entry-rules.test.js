"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  exceedsDailyWarning,
  isHalfHourIncrement,
  validateTimeEntry,
} = require("../srv/lib/time-entry-rules");

test("acepta solamente incrementos positivos de media hora", () => {
  for (const value of [0.5, 1, 1.5, 8, 12.5]) {
    assert.equal(isHalfHourIncrement(value), true, String(value));
  }
  for (const value of [0, -0.5, 0.25, 1.25, 1.75, "abc", null]) {
    assert.equal(isHalfHourIncrement(value), false, String(value));
  }
});

test("un registro regular respeta la configuración del proyecto", () => {
  const result = validateTimeEntry(
    { durationHours: 2, requestedType: "REGULAR", description: "" },
    { requiresDescription: true, requiresEvidence: false },
  );
  assert.equal(result.descriptionRequired, true);
  assert.equal(result.evidenceRequired, false);
  assert.deepEqual(result.errors, ["La descripción es obligatoria para este registro."]);
});

test("el tiempo extra siempre exige detalle, franja y evidencia", () => {
  const result = validateTimeEntry(
    { durationHours: 1.5, requestedType: "OVERTIME", priorAuthorization: false },
    {},
  );
  assert.equal(result.evidenceRequired, true);
  assert.equal(result.isSpecial, true);
  assert.equal(result.errors.length, 3);
});

test("acepta tiempo especial autorizado y documentado", () => {
  const result = validateTimeEntry({
    durationHours: 2,
    requestedType: "HOLIDAY",
    description: "Soporte a salida productiva",
    approximateStartTime: "08:00:00",
    approximateEndTime: "10:00:00",
    priorAuthorization: true,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.evidenceRequired, true);
});

test("la alerta diaria se activa por encima de doce horas sin bloquear doce exactas", () => {
  assert.equal(exceedsDailyWarning(10, 2, 12), false);
  assert.equal(exceedsDailyWarning(10, 2.5, 12), true);
});
