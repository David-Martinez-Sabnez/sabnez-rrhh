"use strict";

const { normalizeContext } = require("./context-engine");

class ConversationEngine {
  constructor({
    intentEngine,
    toolExecutor,
    skillDiscovery,
    providerEngine,
    conversationStore,
  } = {}) {
    if (!intentEngine) {
      throw new TypeError(
        "ConversationEngine requiere IntentEngine.",
      );
    }

    if (!toolExecutor) {
      throw new TypeError(
        "ConversationEngine requiere ToolExecutor.",
      );
    }

    if (!skillDiscovery) {
      throw new TypeError(
        "ConversationEngine requiere SkillDiscovery.",
      );
    }

    if (!providerEngine) {
      throw new TypeError(
        "ConversationEngine requiere ProviderEngine.",
      );
    }

    if (!conversationStore) {
      throw new TypeError(
        "ConversationEngine requiere ConversationStore.",
      );
    }

    this.intentEngine = intentEngine;
    this.toolExecutor = toolExecutor;
    this.skillDiscovery = skillDiscovery;
    this.providerEngine = providerEngine;
    this.conversationStore = conversationStore;
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

    const conversation =
      await this.conversationStore.resolveConversation({
        tx,
        conversationId,
        user,
        context: normalizedContext,
      });

    const resolvedConversationId = conversation.ID;

    await this.conversationStore.appendMessage({
      tx,
      conversationId: resolvedConversationId,
      user,
      role: "user",
      content: message,
      context: normalizedContext,
    });

    const history =
      await this.conversationStore.getHistory({
        tx,
        conversationId: resolvedConversationId,
        user,
      });

    const state =
      await this.conversationStore.getState({
        tx,
        conversationId: resolvedConversationId,
        user,
      });

    const intent = this.intentEngine.classify({
      message,
      user,
      history,
      state,
    });

    let response;

    switch (intent.type) {
      case "INVALID":
        response = {
          conversationId: resolvedConversationId,
          responseType: "ERROR",
          message:
            "Escribe una solicitud para poder ayudarte.",
          intent,
          context: normalizedContext,
        };
        break;

      case "DISCOVERY":
        response = this._buildDiscoveryResponse({
          conversationId: resolvedConversationId,
          intent,
          user,
          context: normalizedContext,
          startedAt,
        });
        break;

      case "NAVIGATION":
        response = {
          conversationId: resolvedConversationId,
          responseType: "NAVIGATION",
          message: `Abriendo ${intent.target.name}.`,
          navigation: intent.target,
          intent,
          context: normalizedContext,
        };
        break;

      case "TOOL": {
        const execution =
          await this.toolExecutor.execute({
            toolName: intent.toolName,
            args: intent.args || {},
            user,
            context: normalizedContext,
            tx,
          });

        response = {
          conversationId: resolvedConversationId,
          responseType: "TOOL_RESULT",
          message: this._buildToolMessage(execution),
          intent,
          execution,
          context: normalizedContext,
        };
        break;
      }

      case "FALLBACK":
      default: {
        const generation =
          await this.providerEngine.generate({
            message,
            conversationId: resolvedConversationId,
            user,
            context: normalizedContext,
            history,
            state,
            tx,
          });

        response = {
          conversationId: resolvedConversationId,
          responseType:
            generation.responseType || "AI_RESPONSE",
          message: generation.message,
          intent,
          provider: {
            id: generation.providerId,
            name: generation.providerName,
            model: generation.model,
            usage: generation.usage,
            metadata: generation.metadata,
          },
          execution: generation.execution || null,
          context: normalizedContext,
        };
      }
    }

    response.durationMs = Date.now() - startedAt;

    await this.conversationStore.appendMessage({
      tx,
      conversationId: resolvedConversationId,
      user,
      role: "assistant",
      content: response.message,
      responseType: response.responseType,
      toolName:
        response.execution?.toolName ||
        response.intent?.toolName ||
        null,
      toolArguments:
        response.intent?.args ||
        response.execution?.args ||
        null,
      toolResult:
        response.execution?.result || null,
      provider: response.provider?.id || null,
      model: response.provider?.model || null,
      usage: response.provider?.usage || {},
      context: normalizedContext,
      payload: response,
    });

    return response;
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
          discovery: { skill: null },
          intent,
          context,
          durationMs: Date.now() - startedAt,
        };
      }

      return {
        conversationId,
        responseType: "SKILL_DISCOVERY",
        message:
          `${skill.name} tiene ` +
          `${skill.capabilities.length} capacidades y ` +
          `${skill.tools.length} herramientas disponibles.`,
        discovery: { skill },
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

        return count === 0
          ? "No encontré empleados que cumplan los criterios indicados."
          : `Encontré ${count} empleado${count === 1 ? "" : "s"}.`;
      }

      case "expiringContracts": {
        const count = execution.result?.count || 0;
        const days =
          execution.result?.period?.days || 30;

        return count === 0
          ? `No encontré contratos que venzan en los próximos ${days} días.`
          : `Encontré ${count} contrato${count === 1 ? "" : "s"} que vencen en los próximos ${days} días.`;
      }

      default:
        return "La solicitud fue procesada correctamente.";
    }
  }
}

module.exports = {
  ConversationEngine,
};
