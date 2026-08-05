"use strict";

const {
  ToolNotFoundError,
  ToolInputError,
  ToolExecutionError,
  IntelligenceError,
} = require("../core/errors");

const { assertCanExecute } = require("../core/permission-engine");

function validateRequiredProperties(tool, args) {
  const required = tool.inputSchema?.required || [];

  for (const property of required) {
    const value = args[property];

    if (
      value === undefined ||
      value === null ||
      (typeof value === "string" && !value.trim())
    ) {
      throw new ToolInputError(
        tool.name,
        `El parámetro "${property}" es obligatorio para ejecutar "${tool.name}".`,
        { property },
      );
    }
  }
}

function validateAdditionalProperties(tool, args) {
  const schema = tool.inputSchema || {};

  if (schema.additionalProperties !== false) {
    return;
  }

  const allowedProperties = new Set(
    Object.keys(schema.properties || {}),
  );

  const unexpected = Object.keys(args).filter(
    (property) => !allowedProperties.has(property),
  );

  if (unexpected.length > 0) {
    throw new ToolInputError(
      tool.name,
      `La herramienta "${tool.name}" recibió parámetros no permitidos: ${unexpected.join(", ")}.`,
      { unexpected },
    );
  }
}

function validateArgumentTypes(tool, args) {
  const properties = tool.inputSchema?.properties || {};

  for (const [property, definition] of Object.entries(properties)) {
    const value = args[property];

    if (value === undefined || value === null) {
      continue;
    }

    if (
      definition.type === "string" &&
      typeof value !== "string"
    ) {
      throw new ToolInputError(
        tool.name,
        `El parámetro "${property}" debe ser texto.`,
        { property, expectedType: "string" },
      );
    }

    if (
      definition.type === "boolean" &&
      typeof value !== "boolean"
    ) {
      throw new ToolInputError(
        tool.name,
        `El parámetro "${property}" debe ser booleano.`,
        { property, expectedType: "boolean" },
      );
    }

    if (
      definition.type === "integer" &&
      !Number.isInteger(value)
    ) {
      throw new ToolInputError(
        tool.name,
        `El parámetro "${property}" debe ser un número entero.`,
        { property, expectedType: "integer" },
      );
    }

    if (
      definition.type === "integer" &&
      definition.minimum !== undefined &&
      value < definition.minimum
    ) {
      throw new ToolInputError(
        tool.name,
        `El parámetro "${property}" debe ser mayor o igual a ${definition.minimum}.`,
        { property, minimum: definition.minimum },
      );
    }

    if (
      definition.type === "integer" &&
      definition.maximum !== undefined &&
      value > definition.maximum
    ) {
      throw new ToolInputError(
        tool.name,
        `El parámetro "${property}" debe ser menor o igual a ${definition.maximum}.`,
        { property, maximum: definition.maximum },
      );
    }
  }
}

function validateArgs(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new ToolInputError(
      tool.name,
      `Los parámetros de "${tool.name}" deben enviarse como un objeto.`,
    );
  }

  validateRequiredProperties(tool, args);
  validateAdditionalProperties(tool, args);
  validateArgumentTypes(tool, args);
}

class ToolExecutor {
  constructor({ registry }) {
    if (!registry) {
      throw new TypeError(
        "ToolExecutor requiere una instancia de ToolRegistry.",
      );
    }

    this.registry = registry;
  }

  async execute({
    toolName,
    args = {},
    user,
    context = {},
    tx,
  }) {
    const startedAt = Date.now();
    const tool = this.registry.getTool(toolName);

    if (!tool) {
      throw new ToolNotFoundError(toolName);
    }

    assertCanExecute(user, tool);
    validateArgs(tool, args);

    try {
      const result = await tool.execute({
        args,
        user,
        context,
        tx,
      });

      return {
        success: true,
        toolName: tool.name,
        moduleId: tool.moduleId,
        durationMs: Date.now() - startedAt,
        result,
      };
    } catch (error) {
      if (error instanceof IntelligenceError) {
        throw error;
      }

      throw new ToolExecutionError(tool.name, error);
    }
  }
}

module.exports = {
  ToolExecutor,
  validateArgs,
};
