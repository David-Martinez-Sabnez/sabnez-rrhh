"use strict";

const { filterAllowedTools } = require("./permission-engine");

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[¿?¡!.,;:()[\]{}]/g, " ")
    .replace(/\s+/g, " ");
}

function includesAny(text, expressions = []) {
  return expressions.some((expression) =>
    text.includes(normalizeText(expression)),
  );
}

function extractInteger(text) {
  const match = text.match(/\b(\d{1,4})\b/);

  if (!match) {
    return null;
  }

  return Number(match[1]);
}

function extractTimeWindowDays(text) {
  const explicitDays = text.match(
    /\b(?:en|durante|proximos?|siguientes?)\s+(\d{1,3})\s+dias?\b/,
  );

  if (explicitDays) {
    return Number(explicitDays[1]);
  }

  if (
    includesAny(text, ["esta semana", "durante esta semana", "en la semana"])
  ) {
    return 7;
  }

  if (includesAny(text, ["este mes", "durante este mes", "en el mes"])) {
    return 30;
  }

  if (includesAny(text, ["proximo mes", "mes siguiente", "siguiente mes"])) {
    return 60;
  }

  if (includesAny(text, ["este trimestre", "proximo trimestre"])) {
    return 90;
  }

  return null;
}

function extractToolArgs(toolName, normalizedMessage) {
  switch (toolName) {
    case "searchEmployees": {
      return {
        activeOnly: includesAny(normalizedMessage, [
          "activos",
          "empleados activos",
          "solo activos",
        ]),
      };
    }

    case "expiringContracts": {
      const days =
        extractTimeWindowDays(normalizedMessage) ||
        extractInteger(normalizedMessage) ||
        30;

      return {
        days: Math.min(Math.max(days, 1), 365),
      };
    }

    default:
      return {};
  }
}

class IntentEngine {
  constructor({ registry, navigationTargets = [] } = {}) {
    if (!registry) {
      throw new TypeError(
        "IntentEngine requiere una instancia de ToolRegistry.",
      );
    }

    this.registry = registry;
    this.navigationTargets = navigationTargets;
  }

  classify({ message, user }) {
    const normalizedMessage = normalizeText(message);

    if (!normalizedMessage) {
      return {
        type: "INVALID",
        confidence: 1,
        reason: "EMPTY_MESSAGE",
      };
    }

    const discoveryIntent = this._matchDiscovery(normalizedMessage);

    if (discoveryIntent) {
      return discoveryIntent;
    }

    const navigationIntent = this._matchNavigation(normalizedMessage);

    if (navigationIntent) {
      return navigationIntent;
    }

    const toolIntent = this._matchTool(normalizedMessage, user);

    if (toolIntent) {
      return toolIntent;
    }

    return {
      type: "FALLBACK",
      confidence: 0,
      reason: "NO_DETERMINISTIC_MATCH",
      originalMessage: message,
    };
  }

  _matchDiscovery(message) {
    if (
      includesAny(message, [
        "que puedes hacer",
        "en que puedes ayudarme",
        "como puedes ayudarme",
        "que capacidades tienes",
        "que sabes hacer",
      ])
    ) {
      return {
        type: "DISCOVERY",
        confidence: 1,
        discoveryType: "CAPABILITIES",
      };
    }

    if (
      includesAny(message, [
        "que skills tengo",
        "skills instaladas",
        "skills disponibles",
        "que modulos tengo instalados",
        "modulos instalados",
      ])
    ) {
      return {
        type: "DISCOVERY",
        confidence: 1,
        discoveryType: "INSTALLED_SKILLS",
      };
    }

    if (
      includesAny(message, [
        "que herramientas tiene rrhh",
        "herramientas de rrhh",
        "que puede hacer recursos humanos",
        "capacidades de recursos humanos",
      ])
    ) {
      return {
        type: "DISCOVERY",
        confidence: 1,
        discoveryType: "SKILL_DETAIL",
        skillId: "hr",
      };
    }

    return null;
  }

  _matchNavigation(message) {
    const navigationWords = [
      "abrir",
      "abre",
      "ir a",
      "llevame a",
      "mostrar aplicacion",
      "entrar a",
    ];

    if (!includesAny(message, navigationWords)) {
      return null;
    }

    for (const target of this.navigationTargets) {
      const expressions = [
        target.name,
        target.semanticObject,
        ...(target.aliases || []),
      ].filter(Boolean);

      if (includesAny(message, expressions)) {
        return {
          type: "NAVIGATION",
          confidence: 1,
          target: {
            id: target.id,
            name: target.name,
            semanticObject: target.semanticObject,
            action: target.action,
          },
        };
      }
    }

    return null;
  }

  _matchTool(message, user) {
    if (isExplanatoryRequest(message)) {
      return null;
    }

    const allowedTools = filterAllowedTools(user, this.registry.listTools());

    const matches = [];

    for (const tool of allowedTools) {
      const expressions = [tool.name, ...(tool.intentExamples || [])]
        .map(normalizeText)
        .filter(Boolean);

      const matchedExpressions = expressions.filter((expression) =>
        message.includes(expression),
      );

      if (matchedExpressions.length === 0) {
        continue;
      }

      const score = Math.max(
        ...matchedExpressions.map((expression) => expression.length),
      );

      matches.push({
        tool,
        score,
      });
    }

    if (matches.length === 0) {
      return null;
    }

    matches.sort((left, right) => right.score - left.score);

    const selectedTool = matches[0].tool;

    return {
      type: "TOOL",
      confidence: 1,
      toolName: selectedTool.name,
      moduleId: selectedTool.moduleId,
      args: extractToolArgs(selectedTool.name, message),
    };
  }
}

function isExplanatoryRequest(message) {
  return includesAny(message, [
    "explica",
    "explicame",
    "por que es importante",
    "que significa",
    "como funciona",
    "cuales son las mejores practicas",
    "dame recomendaciones",
    "recomiendame",
    "analiza conceptualmente",
  ]);
}

module.exports = {
  IntentEngine,
  normalizeText,
  extractInteger,
  extractTimeWindowDays,
  extractToolArgs,
  isExplanatoryRequest,
};
