"use strict";

const {
  IntelligenceError,
  ProviderExecutionError,
} = require("./errors");

class ProviderEngine {
  constructor({
    registry,
    skillDiscovery,
    defaultProviderId,
  } = {}) {
    if (!registry) {
      throw new TypeError(
        "ProviderEngine requiere un registro de proveedores.",
      );
    }

    if (!skillDiscovery) {
      throw new TypeError(
        "ProviderEngine requiere SkillDiscovery.",
      );
    }

    this.registry = registry;
    this.skillDiscovery = skillDiscovery;
    this.defaultProviderId =
      defaultProviderId || registry.getDefaultProviderId();
  }

  async generate({
    message,
    conversationId,
    user,
    context = {},
    providerId,
  }) {
    const provider = this.registry.getAvailable(
      providerId || this.defaultProviderId,
    );

    const skills =
      this.skillDiscovery.listInstalledSkills(user);

    try {
      const result = await provider.generate({
        message,
        conversationId,
        user,
        context,
        skills,
      });

      return {
        providerId: provider.id,
        providerName: provider.name,
        model: result.model || null,
        message: result.message || "",
        usage: result.usage || {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        metadata: result.metadata || {},
      };
    } catch (error) {
      if (error instanceof IntelligenceError) {
        throw error;
      }

      throw new ProviderExecutionError(provider.id, error);
    }
  }
}

module.exports = {
  ProviderEngine,
};
