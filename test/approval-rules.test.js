"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  dateRangesOverlap,
  identityFromUser,
  isActiveInterval,
  normalizeIdentity,
  scopeApplies,
  selectEffectiveAssignment,
} = require("../srv/lib/approval-rules");
const { _test: orchestratorTest } = require("../srv/lib/approval-orchestrator");

test("normaliza la identidad autenticada sin confiar en mayúsculas", () => {
  assert.equal(normalizeIdentity("  JEFE@SABNEZ.COM "), "jefe@sabnez.com");
  assert.equal(
    identityFromUser({
      id: "id-tecnico",
      attr: { email: "Jefe@Sabnez.com" },
    }),
    "jefe@sabnez.com",
  );
});

test("evalúa vigencias y solapes de delegación en límites inclusivos", () => {
  assert.equal(isActiveInterval("2026-07-28", "2026-08-03", "2026-07-28"), true);
  assert.equal(isActiveInterval("2026-07-28", "2026-08-03", "2026-08-03"), true);
  assert.equal(isActiveInterval("2026-07-28", "2026-08-03", "2026-08-04"), false);
  assert.equal(dateRangesOverlap("2026-07-28", "2026-08-03", "2026-08-03", "2026-08-10"), true);
  assert.equal(dateRangesOverlap("2026-07-28", "2026-08-02", "2026-08-03", "2026-08-10"), false);
});

test("aplica alcances globales o por proceso", () => {
  assert.equal(scopeApplies({ alcance: "ALL" }, "ABSENCE"), true);
  assert.equal(
    scopeApplies({ alcance: "PROCESS", processCode: "ABSENCE" }, "ABSENCE"),
    true,
  );
  assert.equal(
    scopeApplies({ alcance: "PROCESS", processCode: "PURCHASE" }, "ABSENCE"),
    false,
  );
});

test("backup y titular pueden actuar en modo cobertura", () => {
  const assignments = [
    assignment("PRIMARY", "jefe@sabnez.com"),
    assignment("BACKUP", "backup@sabnez.com", "delegacion-backup"),
  ];
  const delegations = [delegation("delegacion-backup", "BACKUP")];

  assert.equal(
    selectEffectiveAssignment({
      assignments,
      delegations,
      identity: "jefe@sabnez.com",
      processCode: "ABSENCE",
      date: "2026-07-30",
    }).canAct,
    true,
  );
  assert.equal(
    selectEffectiveAssignment({
      assignments,
      delegations,
      identity: "backup@sabnez.com",
      processCode: "ABSENCE",
      date: "2026-07-30",
    }).canAct,
    true,
  );
});

test("sustitución temporal bloquea al titular y habilita al sustituto", () => {
  const assignments = [
    assignment("PRIMARY", "jefe@sabnez.com"),
    assignment("DELEGATE", "backup@sabnez.com", "delegacion-sustituta"),
  ];
  const delegations = [delegation("delegacion-sustituta", "SUBSTITUTE")];

  const titularDurante = selectEffectiveAssignment({
    assignments,
    delegations,
    identity: "jefe@sabnez.com",
    processCode: "ABSENCE",
    date: "2026-07-30",
  });
  assert.equal(titularDurante.canAct, false);
  assert.equal(titularDurante.reason, "SUBSTITUTED");

  const sustituto = selectEffectiveAssignment({
    assignments,
    delegations,
    identity: "backup@sabnez.com",
    processCode: "ABSENCE",
    date: "2026-07-30",
  });
  assert.equal(sustituto.canAct, true);
  assert.equal(sustituto.assignment.tipo, "DELEGATE");

  const titularDespues = selectEffectiveAssignment({
    assignments,
    delegations,
    identity: "jefe@sabnez.com",
    processCode: "ABSENCE",
    date: "2026-08-04",
  });
  assert.equal(titularDespues.canAct, true);
});

test("las claves derivadas permanecen dentro del límite persistente", () => {
  const key = orchestratorTest.deriveKey("x".repeat(120), "notify-jefe@sabnez.com");
  assert.ok(key.length <= 120);
  assert.match(key, /^AP:[a-f0-9]{64}$/);
});

function assignment(tipo, approverUserID, delegacionID = null) {
  return {
    ID: `${tipo}-${approverUserID}`,
    tipo,
    approverUserID,
    estado: "ACTIVE",
    validaDesde: "2026-07-28",
    validaHasta: tipo === "PRIMARY" ? null : "2026-08-03",
    delegacion_ID: delegacionID,
  };
}

function delegation(ID, modo) {
  return {
    ID,
    modo,
    alcance: "PROCESS",
    processCode: "ABSENCE",
    estado: "ACTIVE",
    fechaInicio: "2026-07-28",
    fechaFin: "2026-08-03",
  };
}
