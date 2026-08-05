"use strict";

const cds = require("@sap/cds");

const {
  initializeModules,
} = require("../../srv/intelligence/modules");

const {
  IntentEngine,
} = require("../../srv/intelligence/core/intent-engine");

const {
  ConversationEngine,
} = require("../../srv/intelligence/core/conversation-engine");

const {
  ToolExecutor,
} = require("../../srv/intelligence/tools/tool-executor");

const navigationTargets = require(
  "../../srv/intelligence/core/navigation-targets",
);

async function main() {
  const csn = await cds.load("*");
  cds.model = cds.compile.for.nodejs(csn);

  const db = await cds.connect.to("db");
  const registry = initializeModules();

  const intentEngine = new IntentEngine({
    registry,
    navigationTargets,
  });

  const toolExecutor = new ToolExecutor({
    registry,
  });

  const conversationEngine = new ConversationEngine({
    intentEngine,
    toolExecutor,
  });

  const user = {
    id: "david.martinez@sabnez.com",
    is(role) {
      return ["Editor", "Admin"].includes(role);
    },
  };

  const tx = db.tx();

  try {
    const messages = [
      "Buscar empleados activos",
      "Muéstrame los contratos que vencen en 365 días",
      "Abrir empleados",
      "Explícame cuáles son los mayores riesgos laborales actuales",
    ];

    let conversationId;

    for (const message of messages) {
      const response = await conversationEngine.process({
        message,
        conversationId,
        user,
        tx,
        context: {
          source: "local-test",
          appId: "sabnezcomempleadosui",
          appName: "Empleados",
          semanticObject: "Empleados",
          action: "display",
        },
      });

      conversationId = response.conversationId;

      console.log("\n=== MENSAJE ===");
      console.log(message);

      console.log("\n=== RESPUESTA ===");
      console.log(JSON.stringify(response, null, 2));
    }

    await tx.commit();
  } catch (error) {
    await tx.rollback();

    console.error("\nError:", {
      name: error.name,
      code: error.code,
      status: error.status,
      message: error.message,
      details: error.details,
      stack: error.stack,
    });

    process.exitCode = 1;
  }
}

main();
