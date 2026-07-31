"use strict";

const SPECIAL_TIME_TYPES = new Set([
  "OVERTIME",
  "NIGHT",
  "SUNDAY",
  "HOLIDAY",
  "COMPENSATORY",
]);

function isHalfHourIncrement(value) {
  const hours = Number(value);
  return Number.isFinite(hours) && hours >= 0.5 && Number.isInteger(hours * 2);
}

function validateTimeEntry(entry, project = {}) {
  const errors = [];
  const requestedType = entry.requestedType || "REGULAR";
  const isSpecial = SPECIAL_TIME_TYPES.has(requestedType);
  const descriptionRequired = Boolean(project.requiresDescription) || isSpecial;
  const evidenceRequired = Boolean(project.requiresEvidence) || isSpecial;

  if (!isHalfHourIncrement(entry.durationHours)) {
    errors.push("La duración debe ser mínimo 0,5 horas y usar incrementos de media hora.");
  }

  if (descriptionRequired && !(entry.description || "").trim()) {
    errors.push("La descripción es obligatoria para este registro.");
  }

  if (isSpecial && (!entry.approximateStartTime || !entry.approximateEndTime)) {
    errors.push("Las horas aproximadas de inicio y finalización son obligatorias para tiempo especial.");
  }

  if (isSpecial && !entry.priorAuthorization && !(entry.exceptionalReason || "").trim()) {
    errors.push("Debe indicar la autorización previa o justificar por qué el trabajo fue imprevisto.");
  }

  return { errors, evidenceRequired, descriptionRequired, isSpecial };
}

function exceedsDailyWarning(existingHours, newHours, threshold = 12) {
  return Number(existingHours || 0) + Number(newHours || 0) > Number(threshold);
}

module.exports = {
  SPECIAL_TIME_TYPES,
  exceedsDailyWarning,
  isHalfHourIncrement,
  validateTimeEntry,
};
