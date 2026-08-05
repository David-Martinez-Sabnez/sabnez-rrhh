"use strict";

const {
  ProviderNotFoundError,
  ProviderUnavailableError,
} = require("../core/errors");

class ProviderRegistry {
  constructor() {
    this._providers = new Map();
    this._defaultProviderId = null;
  }

  register(provider, { isDefault = false } = {}) {
    this._validateProvider(provider);

    if (this._providers.has(provider.id)) {
      throw new Error(
        `El proveedor de inteligencia "${provider.id}" ya está registrado.`,
      );
    }

    this._providers.set(provider.id, provider);

    if (isDefault || !this._defaultProviderId) {
      this._defaultProviderId = provider.id;
    }

    return this;
  }

  get(providerId) {
    const resolvedId = providerId || this._defaultProviderId;
    const provider = this._providers.get(resolvedId);

    if (!provider) {
      throw new ProviderNotFoundError(resolvedId);
    }

    return provider;
  }

  getAvailable(providerId) {
    const provider = this.get(providerId);

    if (
      typeof provider.isAvailable === "function" &&
      !provider.isAvailable()
    ) {
      throw new ProviderUnavailableError(
        provider.id,
        "El proveedor no tiene la configuración requerida.",
      );
    }

    return provider;
  }

  getDefaultProviderId() {
    return this._defaultProviderId;
  }

  list() {
    return Array.from(this._providers.values()).map((provider) => ({
      id: provider.id,
      name: provider.name,
      available:
        typeof provider.isAvailable === "function"
          ? provider.isAvailable()
          : true,
      capabilities: [...(provider.capabilities || [])],
    }));
  }

  _validateProvider(provider) {
    if (!provider || typeof provider !== "object") {
      throw new TypeError(
        "La definición del proveedor debe ser un objeto.",
      );
    }

    if (typeof provider.id !== "string" || !provider.id.trim()) {
      throw new TypeError(
        "El proveedor debe declarar un identificador válido.",
      );
    }

    if (
      typeof provider.name !== "string" ||
      !provider.name.trim()
    ) {
      throw new TypeError(
        `El proveedor "${provider.id}" debe declarar un nombre.`,
      );
    }

    if (typeof provider.generate !== "function") {
      throw new TypeError(
        `El proveedor "${provider.id}" debe implementar generate().`,
      );
    }
  }
}

module.exports = new ProviderRegistry();
module.exports.ProviderRegistry = ProviderRegistry;
