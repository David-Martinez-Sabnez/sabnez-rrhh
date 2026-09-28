"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  completedCollectionCycles,
  collectionCycleContaining,
} = require("../srv/lib/collection-account-cycles");

test("un ingreso el 27 no crea un ciclo 27-26", () => {
  assert.deepEqual(
    completedCollectionCycles("2026-08-27", null, "2026-09-30", 1),
    [
      { start: "2026-08-27", end: "2026-08-31", cycleStart: "2026-08-01", cycleEnd: "2026-08-31" },
      { start: "2026-09-01", end: "2026-09-30", cycleStart: "2026-09-01", cycleEnd: "2026-09-30" },
    ],
  );
});

test("el ciclo alterno conserva periodos 16-15 y recorta el primero", () => {
  assert.deepEqual(
    completedCollectionCycles("2026-08-27", null, "2026-10-15", 16),
    [
      { start: "2026-08-27", end: "2026-09-15", cycleStart: "2026-08-16", cycleEnd: "2026-09-15" },
      { start: "2026-09-16", end: "2026-10-15", cycleStart: "2026-09-16", cycleEnd: "2026-10-15" },
    ],
  );
});

test("ubica cualquier fecha en el ciclo corporativo configurado", () => {
  assert.deepEqual(collectionCycleContaining("2026-09-04", 1), {
    start: "2026-09-01", end: "2026-09-30",
  });
  assert.deepEqual(collectionCycleContaining("2026-09-04", 16), {
    start: "2026-08-16", end: "2026-09-15",
  });
});
