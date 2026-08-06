"use strict";

const MAX_LENGTHS = {
  source: 50,
  userDisplayName: 150,
  appId: 150,
  appName: 150,
  semanticObject: 100,
  action: 100,
  route: 500,
  entity: 150,
  recordId: 150,
};

function cleanString(value, maxLength) {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.trim();

  if (!cleaned) {
    return null;
  }

  return cleaned.slice(0, maxLength);
}

function normalizeContext(context = {}) {
  return {
    source: cleanString(context.source, MAX_LENGTHS.source) || "unknown",
    userDisplayName: cleanString(
      context.userDisplayName,
      MAX_LENGTHS.userDisplayName,
    ),
    appId: cleanString(context.appId, MAX_LENGTHS.appId),
    appName: cleanString(context.appName, MAX_LENGTHS.appName),
    semanticObject: cleanString(
      context.semanticObject,
      MAX_LENGTHS.semanticObject,
    ),
    action: cleanString(context.action, MAX_LENGTHS.action),
    route: cleanString(context.route, MAX_LENGTHS.route),
    entity: cleanString(context.entity, MAX_LENGTHS.entity),
    recordId: cleanString(context.recordId, MAX_LENGTHS.recordId),
  };
}

module.exports = {
  normalizeContext,
};
