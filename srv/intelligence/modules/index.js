"use strict";

const {
  initializeSkills,
  getInstalledSkills,
  getNavigationTargets,
} = require("../skills/skill-loader");

/**
 * Alias temporal para no romper los scripts ya creados.
 * Conceptualmente los módulos ya son Skills.
 */
function initializeModules() {
  return initializeSkills().registry;
}

module.exports = {
  initializeModules,
  initializeSkills,
  getInstalledSkills,
  getNavigationTargets,
};
