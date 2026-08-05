"use strict";

const cds = require("@sap/cds");

const {
  initializeSkills,
  getNavigationTargets,
} = require("./intelligence/modules");

const {
  IntentEngine,
} = require("./intelligence/core/intent-engine");

const {
  ConversationEngine,
} = require("./intelligence/core/conversation-engine");

const {
  ToolExecutor,
} = require("./intelligence/tools/tool-executor");

const {
  SkillDiscovery,
} = require("./intelligence/skills/skill-discovery");

const {
  IntelligenceError,
} = require("./intelligence/core/errors");

module.exports = cds.service.impl(function () {
  const {
    registry,
    skills,
  } = initializeSkills();

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

  const conversationEngine = new ConversationEngine({
    intentEngine,
    toolExecutor,
    skillDiscovery,
  });

  this.on("sendMessage", async (req) => {
    const message =
      typeof req.data?.message === "string"
        ? req.data.message.trim()
        : "";

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
        conversationId:
          req.data?.conversationId || null,
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
        message:
          "Ocurrió un error inesperado al procesar la solicitud.",
      });
    }
  });
});
