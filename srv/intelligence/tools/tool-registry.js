"use strict";

/**
 * Registro central de capacidades disponibles para Sabnez Intelligence.
 *
 * El núcleo no conoce RR. HH., clientes, inventario ni ventas.
 * Cada módulo registra sus herramientas mediante este componente.
 */
class ToolRegistry {
  constructor() {
    this._tools = new Map();
    this._modules = new Map();
  }

  /**
   * Registra un módulo funcional completo.
   *
   * @param {{
   *   id: string,
   *   name: string,
   *   description?: string,
   *   tools: Array<object>
   * }} moduleDefinition
   */
  registerModule(moduleDefinition) {
    this._validateModule(moduleDefinition);

    if (this._modules.has(moduleDefinition.id)) {
      throw new Error(
        `El módulo de inteligencia "${moduleDefinition.id}" ya está registrado.`,
      );
    }

    for (const tool of moduleDefinition.tools) {
      this.registerTool(tool, moduleDefinition.id);
    }

    this._modules.set(moduleDefinition.id, {
      id: moduleDefinition.id,
      name: moduleDefinition.name,
      description: moduleDefinition.description || "",
      tools: moduleDefinition.tools.map((tool) => tool.name),
    });

    return this;
  }

  /**
   * Registra una herramienta individual.
   *
   * @param {object} tool
   * @param {string} moduleId
   */
  registerTool(tool, moduleId) {
    this._validateTool(tool);

    if (this._tools.has(tool.name)) {
      throw new Error(
        `La herramienta de inteligencia "${tool.name}" ya está registrada.`,
      );
    }

    this._tools.set(tool.name, {
      ...tool,
      moduleId,
      requiredRoles: Array.isArray(tool.requiredRoles)
        ? [...tool.requiredRoles]
        : [],
    });

    return this;
  }

  /**
   * Obtiene una herramienta por nombre.
   *
   * @param {string} name
   * @returns {object|undefined}
   */
  getTool(name) {
    return this._tools.get(name);
  }

  /**
   * Devuelve todas las herramientas registradas.
   *
   * @returns {Array<object>}
   */
  listTools() {
    return Array.from(this._tools.values());
  }

  /**
   * Devuelve los módulos funcionales registrados.
   *
   * @returns {Array<object>}
   */
  listModules() {
    return Array.from(this._modules.values());
  }

  hasTool(name) {
    return this._tools.has(name);
  }

  clear() {
    this._tools.clear();
    this._modules.clear();
  }

  _validateModule(moduleDefinition) {
    if (!moduleDefinition || typeof moduleDefinition !== "object") {
      throw new TypeError(
        "La definición del módulo de inteligencia debe ser un objeto.",
      );
    }

    if (
      typeof moduleDefinition.id !== "string" ||
      !moduleDefinition.id.trim()
    ) {
      throw new TypeError(
        "El módulo de inteligencia debe tener un identificador válido.",
      );
    }

    if (
      typeof moduleDefinition.name !== "string" ||
      !moduleDefinition.name.trim()
    ) {
      throw new TypeError(
        `El módulo "${moduleDefinition.id}" debe tener un nombre válido.`,
      );
    }

    if (!Array.isArray(moduleDefinition.tools)) {
      throw new TypeError(
        `El módulo "${moduleDefinition.id}" debe declarar un arreglo de herramientas.`,
      );
    }
  }

  _validateTool(tool) {
    if (!tool || typeof tool !== "object") {
      throw new TypeError(
        "La definición de una herramienta debe ser un objeto.",
      );
    }

    if (typeof tool.name !== "string" || !tool.name.trim()) {
      throw new TypeError("La herramienta debe tener un nombre válido.");
    }

    if (
      typeof tool.description !== "string" ||
      !tool.description.trim()
    ) {
      throw new TypeError(
        `La herramienta "${tool.name}" debe tener una descripción.`,
      );
    }

    if (!tool.inputSchema || typeof tool.inputSchema !== "object") {
      throw new TypeError(
        `La herramienta "${tool.name}" debe declarar un inputSchema.`,
      );
    }

    if (typeof tool.execute !== "function") {
      throw new TypeError(
        `La herramienta "${tool.name}" debe implementar execute().`,
      );
    }
  }
}

module.exports = new ToolRegistry();
module.exports.ToolRegistry = ToolRegistry;
