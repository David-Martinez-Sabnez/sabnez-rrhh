"use strict";

const { ToolAuthorizationError } = require("./errors");

function normalizeRoles(requiredRoles) {
  if (!Array.isArray(requiredRoles)) {
    return [];
  }

  return requiredRoles
    .filter((role) => typeof role === "string")
    .map((role) => role.trim())
    .filter(Boolean);
}

function hasRole(user, role) {
  if (!user || !role) {
    return false;
  }

  if (typeof user.is === "function") {
    return Boolean(user.is(role));
  }

  if (Array.isArray(user.roles)) {
    return user.roles.includes(role);
  }

  return false;
}

/**
 * Determina si el usuario puede utilizar una herramienta.
 *
 * Una herramienta sin requiredRoles está disponible para cualquier
 * usuario autenticado. Esto podrá endurecerse más adelante.
 */
function canExecute(user, tool) {
  if (!user) {
    return false;
  }

  const requiredRoles = normalizeRoles(tool?.requiredRoles);

  if (requiredRoles.length === 0) {
    return true;
  }

  return requiredRoles.some((role) => hasRole(user, role));
}

function assertCanExecute(user, tool) {
  if (!tool?.name) {
    throw new TypeError(
      "No es posible validar permisos de una herramienta sin nombre.",
    );
  }

  if (!canExecute(user, tool)) {
    throw new ToolAuthorizationError(tool.name);
  }
}

/**
 * Devuelve únicamente las herramientas disponibles para el usuario.
 */
function filterAllowedTools(user, tools = []) {
  return tools.filter((tool) => canExecute(user, tool));
}

module.exports = {
  canExecute,
  assertCanExecute,
  filterAllowedTools,
};
