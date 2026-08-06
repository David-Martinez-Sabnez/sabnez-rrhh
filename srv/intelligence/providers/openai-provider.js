"use strict";

const OpenAI = require("openai");

const {
  buildSystemPrompt,
} = require("../prompts/system-prompt");

function getApiKey() {
  return process.env.OPENAI_API_KEY || null;
}

function buildConversationInput(history = [], message = "") {
  const input = history
    .filter(
      (item) =>
        ["user", "assistant"].includes(item.role) &&
        typeof item.content === "string" &&
        item.content.trim(),
    )
    .map((item) => ({
      role: item.role,
      content: item.content,
    }));

  /*
   * Normalmente ConversationEngine guarda el mensaje actual antes
   * de llamar al proveedor. Este fallback evita una petición vacía
   * si generate() se prueba aisladamente sin historial.
   */
  if (
    input.length === 0 &&
    typeof message === "string" &&
    message.trim()
  ) {
    input.push({
      role: "user",
      content: message.trim(),
    });
  }

  return input;
}

function normalizeSkills(skills = []) {
  return Array.isArray(skills) ? skills : [];
}

module.exports = {
  id: "openai",
  name: "OpenAI",
  capabilities: ["text-generation"],

  isAvailable() {
    return Boolean(getApiKey());
  },

  async generate({
    message,
    context = {},
    skills = [],
    conversationId,
    history = [],
    state = null,
    user = null,
  }) {
    const apiKey = getApiKey();

    if (!apiKey) {
      throw new Error(
        "La variable OPENAI_API_KEY no está configurada.",
      );
    }

    const input = buildConversationInput(
      history,
      message,
    );

    if (input.length === 0) {
      throw new Error(
        "No hay mensajes disponibles para enviar al proveedor OpenAI.",
      );
    }

    const client = new OpenAI({
      apiKey,
    });

    const response = await client.responses.create({
      model:
        process.env.OPENAI_MODEL ||
        "gpt-5-mini",

      instructions: buildSystemPrompt({
        skills: normalizeSkills(skills),
        context,
        state,
        user,
      }),

      input,

      reasoning: {
        effort:
          process.env.OPENAI_REASONING_EFFORT ||
          "minimal",
      },

      text: {
        verbosity:
          process.env.OPENAI_VERBOSITY ||
          "low",
      },

      max_output_tokens: Number(
        process.env.OPENAI_MAX_OUTPUT_TOKENS ||
          600,
      ),
    });

    return {
      providerId: this.id,
      providerName: this.name,
      model:
        response.model ||
        process.env.OPENAI_MODEL ||
        "gpt-5-mini",

      message:
        typeof response.output_text === "string"
          ? response.output_text.trim()
          : "",

      conversationId,

      usage: {
        inputTokens:
          response.usage?.input_tokens || 0,
        outputTokens:
          response.usage?.output_tokens || 0,
        totalTokens:
          response.usage?.total_tokens || 0,
      },

      metadata: {
        responseId: response.id || null,
      },
    };
  },
};
