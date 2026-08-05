"use strict";

const toolRegistry = require("../tools/tool-registry");
const hrSkill = require("../modules/hr");

const installedSkills = [
  hrSkill,
];

let initialized = false;

function validateSkill(skill) {
  if (!skill || typeof skill !== "object") {
    throw new TypeError("La definición de una Skill debe ser un objeto.");
  }

  if (typeof skill.id !== "string" || !skill.id.trim()) {
    throw new TypeError("La Skill debe declarar un identificador válido.");
  }

  if (typeof skill.name !== "string" || !skill.name.trim()) {
    throw new TypeError(
      `La Skill "${skill.id}" debe declarar un nombre válido.`,
    );
  }

  if (!Array.isArray(skill.tools)) {
    throw new TypeError(
      `La Skill "${skill.id}" debe declarar un arreglo de herramientas.`,
    );
  }

  if (!Array.isArray(skill.capabilities)) {
    throw new TypeError(
      `La Skill "${skill.id}" debe declarar sus capacidades.`,
    );
  }

  if (!Array.isArray(skill.navigation)) {
    throw new TypeError(
      `La Skill "${skill.id}" debe declarar sus destinos de navegación.`,
    );
  }
}

function initializeSkills() {
  if (initialized) {
    return {
      registry: toolRegistry,
      skills: installedSkills,
    };
  }

  for (const skill of installedSkills) {
    validateSkill(skill);
    toolRegistry.registerModule(skill);
  }

  initialized = true;

  return {
    registry: toolRegistry,
    skills: installedSkills,
  };
}

function getInstalledSkills() {
  return [...installedSkills];
}

function getNavigationTargets() {
  return installedSkills.flatMap((skill) =>
    (skill.navigation || []).map((target) => ({
      ...target,
      skillId: skill.id,
    })),
  );
}

module.exports = {
  initializeSkills,
  getInstalledSkills,
  getNavigationTargets,
};
