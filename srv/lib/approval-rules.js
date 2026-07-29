"use strict";

const ASSIGNMENT_PRIORITY = Object.freeze({
  DELEGATE: 40,
  BACKUP: 30,
  PRIMARY: 20,
  POOL: 10,
});

function normalizeIdentity(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function identityFromUser(user) {
  const candidates = [
    user?.attr?.email,
    user?.attr?.mail,
    user?.attr?.emailAddress,
    user?.id,
  ];

  return normalizeIdentity(
    candidates.find((value) => typeof value === "string" && value.trim()),
  );
}

function todayInColombia(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function isISODate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isActiveInterval(from, to, date) {
  return (
    isISODate(date) &&
    (!from || from <= date) &&
    (!to || to >= date)
  );
}

function dateRangesOverlap(fromA, toA, fromB, toB) {
  return fromA <= toB && fromB <= toA;
}

function scopeApplies(delegation, processCode) {
  return (
    delegation?.alcance === "ALL" ||
    (delegation?.alcance === "PROCESS" &&
      delegation?.processCode === processCode)
  );
}

function delegationIsEffective(delegation, processCode, date) {
  return (
    delegation?.estado === "ACTIVE" &&
    scopeApplies(delegation, processCode) &&
    isActiveInterval(delegation.fechaInicio, delegation.fechaFin, date)
  );
}

function scopesOverlap(first, second) {
  if (first.alcance === "ALL" || second.alcance === "ALL") return true;
  return first.processCode === second.processCode;
}

function selectEffectiveAssignment({
  assignments = [],
  delegations = [],
  identity,
  processCode,
  date,
}) {
  const normalizedIdentity = normalizeIdentity(identity);
  const candidates = assignments
    .filter(
      (assignment) =>
        assignment.estado === "ACTIVE" &&
        normalizeIdentity(assignment.approverUserID) === normalizedIdentity &&
        isActiveInterval(
          assignment.validaDesde,
          assignment.validaHasta,
          date,
        ),
    )
    .sort(
      (left, right) =>
        (ASSIGNMENT_PRIORITY[right.tipo] || 0) -
        (ASSIGNMENT_PRIORITY[left.tipo] || 0),
    );

  const assignment = candidates[0];
  if (!assignment) return { assignment: null, canAct: false };

  if (assignment.tipo === "PRIMARY") {
    const isSubstituted = assignments.some((candidate) => {
      if (candidate.estado !== "ACTIVE" || candidate.tipo !== "DELEGATE") {
        return false;
      }
      const delegation = delegations.find(
        (row) => row.ID === candidate.delegacion_ID,
      );
      return (
        delegation?.modo === "SUBSTITUTE" &&
        delegationIsEffective(delegation, processCode, date)
      );
    });

    if (isSubstituted) {
      return { assignment, canAct: false, reason: "SUBSTITUTED" };
    }
  }

  return {
    assignment,
    canAct: true,
    actingForEmployeeID:
      assignment.tipo === "PRIMARY" ? null : assignment.originalApprover_ID,
  };
}

module.exports = {
  ASSIGNMENT_PRIORITY,
  dateRangesOverlap,
  delegationIsEffective,
  identityFromUser,
  isActiveInterval,
  normalizeIdentity,
  scopeApplies,
  scopesOverlap,
  selectEffectiveAssignment,
  todayInColombia,
  _test: {
    dateRangesOverlap,
    delegationIsEffective,
    identityFromUser,
    isActiveInterval,
    normalizeIdentity,
    scopeApplies,
    scopesOverlap,
    selectEffectiveAssignment,
  },
};
