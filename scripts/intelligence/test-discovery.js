"use strict";

const cds = require("@sap/cds");

const {
  initializeSkills,
  getNavigationTargets,
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

const {
  SkillDiscovery,
} = require("../../srv/intelligence/skills/skill-discovery");

async function main() {
  const csn = await cds.load("*");
  cds.model = cds.compile.for.nodejs(csn);

  const db = await cds.connect.to("db");

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

  const user = {
    id: "david.martinez@sabnez.com",
    is(role) {
      return ["Editor", "Admin"].includes(role);
    },
  };

  const tx = db.tx();

  try {
    const messages = [
      "¿Qué puedes hacer?",
      "¿Qué Skills tengo instaladas?",
      "¿Qué herramientas tiene RRHH?",
      "Buscar empleados activos",
    ];

    let conversationId;

    for (const message of messages) {
      const response = await conversationEngine.process({
        message,
        conversationId,
        user,
        tx,
        context: {
          source: "skill-discovery-test",
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
    console.error(error);
    process.exitCode = 1;
  }
}

main();
