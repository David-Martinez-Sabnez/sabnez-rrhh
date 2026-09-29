"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cutoffCyclesForDate,
  nextMonthlyCutoff,
} = require("../srv/lib/time-cutoff-policy");

test("el recordatorio se repite diariamente durante los tres días previos y el día del corte", () => {
  for (const date of ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"]) {
    const cycles = cutoffCyclesForDate({
      referenceDate: date,
      cutoffDay: 30,
      projectActive: true,
    });
    assert.ok(
      cycles.some((cycle) => cycle.cutoff === "2026-09-30" && cycle.phase === "UPCOMING"),
      `${date} debe evaluar el corte del 30 de septiembre`,
    );
  }
});

test("desde el día siguiente al corte se genera una evaluación vencida", () => {
  const cycles = cutoffCyclesForDate({
    referenceDate: "2026-10-01",
    cutoffDay: 30,
    projectActive: true,
  });

  assert.ok(cycles.some((cycle) =>
    cycle.cutoff === "2026-09-30" && cycle.phase === "OVERDUE"));
});

test("un incumplimiento abierto continúa evaluándose aunque cambie el mes o se cierre el proyecto", () => {
  const cycles = cutoffCyclesForDate({
    referenceDate: "2026-11-15",
    cutoffDay: 30,
    projectActive: false,
    openCutoffs: ["2026-09-30"],
  });

  assert.deepEqual(cycles, [{ cutoff: "2026-09-30", phase: "OVERDUE" }]);
});

test("el día 31 se ajusta al último día real de cada mes", () => {
  assert.equal(nextMonthlyCutoff("2027-02-25", 31), "2027-02-28");
  assert.equal(nextMonthlyCutoff("2028-02-25", 31), "2028-02-29");
});
