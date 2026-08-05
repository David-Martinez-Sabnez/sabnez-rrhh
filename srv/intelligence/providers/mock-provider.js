"use strict";

module.exports = {
  id: "mock",
  name: "Proveedor simulado",
  capabilities: [
    "text-generation",
  ],

  isAvailable() {
    return true;
  },

  async generate({
    message,
    context,
    skills,
    conversationId,
  }) {
    const skillNames = skills
      .map((skill) => skill.name)
      .join(", ");

    return {
      providerId: this.id,
      model: "mock-v1",
      message:
        `Recibí la solicitud: "${message}". ` +
        `Las Skills disponibles son: ${skillNames || "ninguna"}.`,
      conversationId,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      metadata: {
        simulated: true,
        source: context?.source || "unknown",
      },
    };
  },
};
