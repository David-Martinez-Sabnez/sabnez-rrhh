"use strict";

require("dotenv").config();

const openaiProvider = require(
  "../../srv/intelligence/providers/openai-provider",
);

async function main() {
  if (!openaiProvider.isAvailable()) {
    throw new Error(
      "OPENAI_API_KEY no está configurada.",
    );
  }

  const result = await openaiProvider.generate({
    message:
      "Explica en una frase qué es Sabnez Cloud ERP.",
    conversationId:
      "00000000-0000-0000-0000-000000000001",
    context: {
      source: "openai-provider-test",
      appName: "Empleados",
    },
    skills: [
      {
        id: "hr",
        name: "Recursos Humanos",
        description:
          "Consulta empleados y contratos.",
        capabilities: [],
        tools: [],
        examples: [],
      },
    ],
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error({
    name: error.name,
    message: error.message,
    status: error.status,
    code: error.code,
  });

  process.exitCode = 1;
});
