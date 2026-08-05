"use strict";

const {
  canExecute,
} = require("../core/permission-engine");

class SkillDiscovery {
  constructor({ skills = [], registry } = {}) {
    if (!registry) {
      throw new TypeError(
        "SkillDiscovery requiere una instancia de ToolRegistry.",
      );
    }

    this.skills = skills;
    this.registry = registry;
  }

  listInstalledSkills(user) {
    return this.skills
      .map((skill) => this.describeSkill(skill, user))
      .filter((skill) =>
        skill.tools.length > 0 ||
        skill.navigation.length > 0,
      );
  }

  describeSkillById(skillId, user) {
    const skill = this.skills.find(
      (candidate) => candidate.id === skillId,
    );

    if (!skill) {
      return null;
    }

    return this.describeSkill(skill, user);
  }

  describeSkill(skill, user) {
    const tools = (skill.tools || [])
      .map((definition) =>
        this.registry.getTool(definition.name),
      )
      .filter(Boolean)
      .filter((tool) => canExecute(user, tool))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        moduleId: tool.moduleId,
      }));

    return {
      id: skill.id,
      name: skill.name,
      version: skill.version || "1.0.0",
      description: skill.description || "",
      capabilities: [...(skill.capabilities || [])],
      navigation: (skill.navigation || []).map((target) => ({
        id: target.id,
        name: target.name,
        semanticObject: target.semanticObject,
        action: target.action,
      })),
      examples: [...(skill.examples || [])],
      tools,
    };
  }

  buildGeneralSummary(user) {
    const skills = this.listInstalledSkills(user);

    if (skills.length === 0) {
      return {
        message:
          "No tienes Skills de Sabnez Intelligence disponibles actualmente.",
        skills: [],
      };
    }

    const capabilityCount = skills.reduce(
      (total, skill) =>
        total + skill.capabilities.length,
      0,
    );

    const toolCount = skills.reduce(
      (total, skill) => total + skill.tools.length,
      0,
    );

    return {
      message:
        `Actualmente tienes ${skills.length} Skill instalada` +
        `${skills.length === 1 ? "" : "s"}, ` +
        `${capabilityCount} capacidad` +
        `${capabilityCount === 1 ? "" : "es"} y ` +
        `${toolCount} herramienta` +
        `${toolCount === 1 ? "" : "s"} disponible` +
        `${toolCount === 1 ? "" : "s"}.`,
      skills,
    };
  }
}

module.exports = {
  SkillDiscovery,
};
