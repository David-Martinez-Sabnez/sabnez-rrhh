"use strict";

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config({
    quiet: true,
  });
}

const cds = require("@sap/cds");

const {
  initializeSkills,
  getNavigationTargets,
} = require("./intelligence/modules");

const { IntentEngine } = require("./intelligence/core/intent-engine");

const {
  ConversationEngine,
} = require("./intelligence/core/conversation-engine");

const { ToolExecutor } = require("./intelligence/tools/tool-executor");

const { SkillDiscovery } = require("./intelligence/skills/skill-discovery");

const { ConversationStore } = require("./intelligence/core/conversation-store");

const { IntelligenceError } = require("./intelligence/core/errors");

const providerRegistry = require("./intelligence/providers/provider-registry");

const mockProvider = require("./intelligence/providers/mock-provider");

const { ProviderEngine } = require("./intelligence/core/provider-engine");

const openaiProvider = require("./intelligence/providers/openai-provider");

module.exports = cds.service.impl(function () {
  const { registry, skills } = initializeSkills();

  const intentEngine = new IntentEngine({
    registry,
    navigationTargets: getNavigationTargets(),
  });

  const toolExecutor = new ToolExecutor({
    registry,
  });

  const skillDiscovery = new SkillDiscovery({
    skills,
    registry,
  });

  const conversationStore = new ConversationStore({
    historyLimit: Number(process.env.INTELLIGENCE_HISTORY_LIMIT || 20),
  });

  const mockAlreadyRegistered = providerRegistry
    .list()
    .some((provider) => provider.id === mockProvider.id);

  if (!mockAlreadyRegistered) {
    providerRegistry.register(mockProvider, {
      isDefault: true,
    });
  }

  const openaiAlreadyRegistered = providerRegistry
    .list()
    .some((provider) => provider.id === openaiProvider.id);

  if (!openaiAlreadyRegistered) {
    providerRegistry.register(openaiProvider);
  }

  const configuredProviderId = process.env.INTELLIGENCE_PROVIDER || "openai";

  let effectiveProviderId = configuredProviderId;

  try {
    const configuredProvider = providerRegistry.get(configuredProviderId);

    if (
      typeof configuredProvider.isAvailable === "function" &&
      !configuredProvider.isAvailable()
    ) {
      console.warn(
        `[Sabnez Intelligence] El proveedor "${configuredProviderId}" no está disponible. Se utilizará "mock" temporalmente.`,
      );

      effectiveProviderId = "mock";
    }
  } catch (error) {
    console.warn(
      `[Sabnez Intelligence] El proveedor "${configuredProviderId}" no está registrado. Se utilizará "mock" temporalmente.`,
    );

    effectiveProviderId = "mock";
  }

  const providerEngine = new ProviderEngine({
    registry: providerRegistry,
    skillDiscovery,
    defaultProviderId: effectiveProviderId,
  });

  const conversationEngine = new ConversationEngine({
    intentEngine,
    toolExecutor,
    skillDiscovery,
    providerEngine,
    conversationStore,
  });

  this.on("sendMessage", async (req) => {
    console.log("[Sabnez Intelligence] Usuario:", {
      id: req.user?.id,
      roles: req.user?.roles,
      attr: req.user?.attr,
      authenticated: req.user?.is?.("authenticated-user"),
      editor: req.user?.is?.("Editor"),
      admin: req.user?.is?.("Admin"),
    });

    const message =
      typeof req.data?.message === "string" ? req.data.message.trim() : "";

    if (!message) {
      return req.reject({
        status: 400,
        code: "INTELLIGENCE_MESSAGE_REQUIRED",
        message: "Escribe una solicitud para poder ayudarte.",
        target: "message",
      });
    }

    const tx = cds.tx(req);

    try {
      const response = await conversationEngine.process({
        message,
        conversationId: req.data?.conversationId || null,
        user: req.user,
        context: req.data?.context || {},
        tx,
      });

      return {
        message: response.message,
        conversationId: response.conversationId,
        responseType: response.responseType,
        payload: JSON.stringify(response),
      };
    } catch (error) {
      if (error instanceof IntelligenceError) {
        return req.reject({
          status: error.status,
          code: error.code,
          message: error.message,
          details: error.details,
        });
      }

      req.error(error);

      return req.reject({
        status: 500,
        code: "INTELLIGENCE_UNEXPECTED_ERROR",
        message: "Ocurrió un error inesperado al procesar la solicitud.",
      });
    }
  });
});
