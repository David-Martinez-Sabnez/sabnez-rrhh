"use strict";

const OpenAI = require("openai");

function getApiKey() {
  return process.env.OPENAI_API_KEY || null;
}

function buildSystemPrompt(skills = [], context = {}) {
  const skillSummary = skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    capabilities: skill.capabilities,
    tools: skill.tools,
    examples: skill.examples,
  }));

  return [
    "Eres Sabnez Intelligence, el motor inteligente de Sabnez Cloud ERP.",
    "Responde en español claro, profesional y breve.",
    "No afirmes que ejecutaste una acción si no se ejecutó una herramienta.",
    "No inventes datos del ERP.",
    "Cuando la información disponible no sea suficiente, indícalo.",
    "",
    `Contexto actual: ${JSON.stringify(context)}`,
    "",
    `Skills disponibles: ${JSON.stringify(skillSummary)}`,
  ].join("\n");
}

module.exports = {
  id: "openai",
  name: "OpenAI",
  capabilities: ["text-generation"],

  isAvailable() {
    return Boolean(getApiKey());
  },

  async generate({ message, context, skills, conversationId }) {
    const apiKey = getApiKey();

    if (!apiKey) {
      throw new Error("La variable OPENAI_API_KEY no está configurada.");
    }

    const client = new OpenAI({
      apiKey,
    });

    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      instructions: buildSystemPrompt(skills, context),
      input: message,

      reasoning: {
        effort: process.env.OPENAI_REASONING_EFFORT || "minimal",
      },

      text: {
        verbosity: process.env.OPENAI_VERBOSITY || "low",
      },

      max_output_tokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 600),
    });

    return {
      providerId: this.id,
      model: response.model || process.env.OPENAI_MODEL || "gpt-5-mini",
      message: response.output_text || "",
      conversationId,
      usage: {
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
        totalTokens: response.usage?.total_tokens || 0,
      },
      metadata: {
        responseId: response.id || null,
      },
    };
  },
};
