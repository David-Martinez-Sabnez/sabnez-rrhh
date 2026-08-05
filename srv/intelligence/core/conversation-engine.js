"use strict";

const { randomUUID } = require("node:crypto");
const { normalizeContext } = require("./context-engine");

class ConversationEngine {
  constructor({
    intentEngine,
    toolExecutor,
    skillDiscovery,
  } = {}) {
    if (!intentEngine) {
      throw new TypeError(
        "ConversationEngine requiere una instancia de IntentEngine.",
      );
    }

    if (!toolExecutor) {
      throw new TypeError(
        "ConversationEngine requiere una instancia de ToolExecutor.",
      );
    }

    if (!skillDiscovery) {
      throw new TypeError(
        "ConversationEngine requiere una instancia de SkillDiscovery.",
      );
    }

    this.intentEngine = intentEngine;
    this.toolExecutor = toolExecutor;
    this.skillDiscovery = skillDiscovery;
  }

  async process({
    message,
    conversationId,
    user,
    context = {},
    tx,
  }) {
    const startedAt = Date.now();
    const normalizedContext = normalizeContext(context);
    const resolvedConversationId =
      conversationId || randomUUID();

    const intent = this.intentEngine.classify({
      message,
      user,
    });

    switch (intent.type) {
      case "INVALID":
        return {
          conversationId: resolvedConversationId,
          responseType: "ERROR",
          message: "Escribe una solicitud para poder ayudarte.",
          intent,
          durationMs: Date.now() - startedAt,
        };

      case "DISCOVERY":
        return this._buildDiscoveryResponse({
          conversationId: resolvedConversationId,
          intent,
          user,
          context: normalizedContext,
          startedAt,
        });

      case "NAVIGATION":
        return {
          conversationId: resolvedConversationId,
          responseType: "NAVIGATION",
          message: `Abriendo ${intent.target.name}.`,
          navigation: intent.target,
          intent,
          context: normalizedContext,
          durationMs: Date.now() - startedAt,
        };

      case "TOOL": {
        const execution = await this.toolExecutor.execute({
          toolName: intent.toolName,
          args: intent.args || {},
          user,
          context: normalizedContext,
          tx,
        });

        return {
          conversationId: resolvedConversationId,
          responseType: "TOOL_RESULT",
          message: this._buildToolMessage(execution),
          intent,
          execution,
          context: normalizedContext,
          durationMs: Date.now() - startedAt,
        };
      }

      case "FALLBACK":
      default:
        return {
          conversationId: resolvedConversationId,
          responseType: "AI_REQUIRED",
          message:
            "Esta solicitud necesita interpretación adicional del proveedor de inteligencia artificial.",
          intent,
          context: normalizedContext,
          durationMs: Date.now() - startedAt,
        };
    }
  }

  _buildDiscoveryResponse({
    conversationId,
    intent,
    user,
    context,
    startedAt,
  }) {
    if (intent.discoveryType === "SKILL_DETAIL") {
      const skill =
        this.skillDiscovery.describeSkillById(
          intent.skillId,
          user,
        );

      if (!skill) {
        return {
          conversationId,
          responseType: "SKILL_DISCOVERY",
          message:
            "No encontré esa Skill entre las capacidades disponibles.",
          discovery: {
            skill: null,
          },
          intent,
          context,
          durationMs: Date.now() - startedAt,
        };
      }

      return {
        conversationId,
        responseType: "SKILL_DISCOVERY",
        message:
          `${skill.name} tiene ${skill.capabilities.length} capacidad` +
          `${skill.capabilities.length === 1 ? "" : "es"} y ` +
          `${skill.tools.length} herramienta` +
          `${skill.tools.length === 1 ? "" : "s"} disponibles.`,
        discovery: {
          skill,
        },
        intent,
        context,
        durationMs: Date.now() - startedAt,
      };
    }

    const summary =
      this.skillDiscovery.buildGeneralSummary(user);

    return {
      conversationId,
      responseType: "SKILL_DISCOVERY",
      message: summary.message,
      discovery: {
        skills: summary.skills,
      },
      intent,
      context,
      durationMs: Date.now() - startedAt,
    };
  }

  _buildToolMessage(execution) {
    switch (execution.toolName) {
      case "searchEmployees": {
        const count = execution.result?.count || 0;

        if (count === 0) {
          return "No encontré empleados que cumplan los criterios indicados.";
        }

        return `Encontré ${count} empleado${count === 1 ? "" : "s"}.`;
      }

      case "expiringContracts": {
        const count = execution.result?.count || 0;
        const days = execution.result?.period?.days || 30;

        if (count === 0) {
          return `No encontré contratos que venzan en los próximos ${days} días.`;
        }

        return `Encontré ${count} contrato${count === 1 ? "" : "s"} que vencen en los próximos ${days} días.`;
      }

      default:
        return "La solicitud fue procesada correctamente.";
    }
  }
}

module.exports = {
  ConversationEngine,
};
