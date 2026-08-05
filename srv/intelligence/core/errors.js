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

class ProviderNotFoundError extends IntelligenceError {
  constructor(providerId) {
    super(`El proveedor de inteligencia "${providerId}" no está registrado.`, {
      code: "INTELLIGENCE_PROVIDER_NOT_FOUND",
      status: 500,
      details: { providerId },
    });
  }
}

class ProviderUnavailableError extends IntelligenceError {
  constructor(providerId, reason = null) {
    super(`El proveedor de inteligencia "${providerId}" no está disponible.`, {
      code: "INTELLIGENCE_PROVIDER_UNAVAILABLE",
      status: 503,
      details: {
        providerId,
        reason,
      },
    });
  }
}

class ProviderExecutionError extends IntelligenceError {
  constructor(providerId, cause) {
    super(
      `No fue posible procesar la solicitud con el proveedor "${providerId}".`,
      {
        code: "INTELLIGENCE_PROVIDER_EXECUTION_FAILED",
        status: 502,
        details: {
          providerId,
          cause: cause?.message || String(cause),
        },
      },
    );

    this.cause = cause;
  }
}

module.exports = {
  IntelligenceError,
  ToolNotFoundError,
  ToolAuthorizationError,
  ToolInputError,
  ToolExecutionError,
  ProviderNotFoundError,
  ProviderUnavailableError,
  ProviderExecutionError,
};
