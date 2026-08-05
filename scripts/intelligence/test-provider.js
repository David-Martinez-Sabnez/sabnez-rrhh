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

const {
  ProviderEngine,
} = require("../../srv/intelligence/core/provider-engine");

const providerRegistry = require(
  "../../srv/intelligence/providers/provider-registry",
);

const mockProvider = require(
  "../../srv/intelligence/providers/mock-provider",
);

async function main() {
  const csn = await cds.load("*");
  cds.model = cds.compile.for.nodejs(csn);

  const db = await cds.connect.to("db");

  const {
    registry,
    skills,
  } = initializeSkills();

  const skillDiscovery = new SkillDiscovery({
    skills,
    registry,
  });

  providerRegistry.register(mockProvider, {
    isDefault: true,
  });

  const providerEngine = new ProviderEngine({
    registry: providerRegistry,
    skillDiscovery,
  });

  const conversationEngine = new ConversationEngine({
    intentEngine: new IntentEngine({
      registry,
      navigationTargets: getNavigationTargets(),
    }),
    toolExecutor: new ToolExecutor({
      registry,
    }),
    skillDiscovery,
    providerEngine,
  });

  const user = {
    id: "david.martinez@sabnez.com",
    is(role) {
      return ["Editor", "Admin"].includes(role);
    },
  };

  const tx = db.tx();

  try {
    const response = await conversationEngine.process({
      message:
        "Explícame cuáles son los mayores riesgos laborales actuales",
      user,
      tx,
      context: {
        source: "provider-test",
      },
    });

    console.log(JSON.stringify(response, null, 2));

    await tx.commit();
  } catch (error) {
    await tx.rollback();
    console.error(error);
    process.exitCode = 1;
  }
}

main();
