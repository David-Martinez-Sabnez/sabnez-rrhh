"use strict";

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[¿?¡!.,;:()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getRecentText(history = [], role, limit = 6) {
  return history
    .slice(-limit)
    .filter((item) => item.role === role)
    .map((item) => normalizeText(item.content))
    .join(" ");
}

function referencesEmployees(text) {
  return /\b(empleado|empleados|colaborador|colaboradores|personal|trabajador|trabajadores)\b/.test(
    text,
  );
}

function requestsListing(text) {
  return /\b(lista|listado|listar|listame|muestra|muestrame|ver|buscar|busca|dame|consulta|consultar|todos)\b/.test(
    text,
  );
}

function requestsActive(text) {
  return /\b(activo|activos|vigente|vigentes|trabajando|no retirados)\b/.test(
    text,
  );
}

function requestsAllData(text) {
  return /\b(todos sus datos|todos los datos|completo|completa|detalle|detallado|detallada)\b/.test(
    text,
  );
}

function requestsScreen(text) {
  return /\b(en pantalla|mostrar|muestralo|muestralos|ver aqui|aqui)\b/.test(
    text,
  );
}

function isAffirmative(text) {
  return /^(si|sí|dale|ok|okay|correcto|procede|hazlo|adelante)$/.test(
    text,
  );
}

class ConversationIntentResolver {
  resolve({
    message,
    history = [],
    state = null,
  } = {}) {
    const current = normalizeText(message);
    const recentUser = getRecentText(history, "user");
    const recentAssistant = getRecentText(
      history,
      "assistant",
    );

    const combinedContext = [
      recentUser,
      recentAssistant,
      normalizeText(state?.activeGoal),
      normalizeText(
        JSON.stringify(state?.knownArguments || {}),
      ),
    ].join(" ");

    const employeeContext =
      referencesEmployees(current) ||
      referencesEmployees(combinedContext);

    const listingContext =
      requestsListing(current) ||
      requestsListing(combinedContext);

    if (!employeeContext || !listingContext) {
      return null;
    }

    /*
     * Si el usuario ya pidió empleados y luego responde:
     * "todos", "todos con todos sus datos", "en pantalla",
     * "sí", etc., la consulta ya es ejecutable.
     */
    const shouldExecute =
      referencesEmployees(current) ||
      requestsAllData(current) ||
      requestsScreen(current) ||
      current === "todos" ||
      current === "todos los activos" ||
      isAffirmative(current);

    if (!shouldExecute) {
      return null;
    }

    return {
      type: "TOOL",
      confidence: 0.99,
      toolName: "searchEmployees",
      moduleId: "hr",
      args: {
        activeOnly:
          requestsActive(current) ||
          requestsActive(combinedContext),
        includeDetails:
          requestsAllData(current) ||
          requestsAllData(combinedContext),
        output: requestsScreen(current)
          ? "screen"
          : "screen",
      },
      conversationState: {
        activeGoal: "LIST_EMPLOYEES",
        pendingQuestion: null,
        knownArguments: {
          activeOnly:
            requestsActive(current) ||
            requestsActive(combinedContext),
          includeDetails:
            requestsAllData(current) ||
            requestsAllData(combinedContext),
          output: "screen",
        },
      },
    };
  }
}

module.exports = {
  ConversationIntentResolver,
};
