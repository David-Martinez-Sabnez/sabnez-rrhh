"use strict";

class IntelligenceError extends Error {
  constructor(message, options = {}) {
    super(message);

    this.name = this.constructor.name;
    this.code = options.code || "INTELLIGENCE_ERROR";
    this.status = options.status || 500;
    this.details = options.details || null;

    Error.captureStackTrace?.(this, this.constructor);
  }
}

class ToolNotFoundError extends IntelligenceError {
  constructor(toolName) {
    super(`La herramienta "${toolName}" no está registrada.`, {
      code: "INTELLIGENCE_TOOL_NOT_FOUND",
      status: 404,
      details: { toolName },
    });
  }
}

class ToolAuthorizationError extends IntelligenceError {
  constructor(toolName) {
    super(
      `No tienes autorización para utilizar la herramienta "${toolName}".`,
      {
        code: "INTELLIGENCE_TOOL_FORBIDDEN",
        status: 403,
        details: { toolName },
      },
    );
  }
}

class ToolInputError extends IntelligenceError {
  constructor(toolName, message, details = null) {
    super(message, {
      code: "INTELLIGENCE_TOOL_INPUT_INVALID",
      status: 400,
      details: {
        toolName,
        ...(details || {}),
      },
    });
  }
}

class ToolExecutionError extends IntelligenceError {
  constructor(toolName, cause) {
    super(`No fue posible ejecutar la herramienta "${toolName}".`, {
      code: "INTELLIGENCE_TOOL_EXECUTION_FAILED",
      status: 500,
      details: {
        toolName,
        cause: cause?.message || String(cause),
      },
    });

    this.cause = cause;
  }
}

module.exports = {
  IntelligenceError,
  ToolNotFoundError,
  ToolAuthorizationError,
  ToolInputError,
  ToolExecutionError,
};
