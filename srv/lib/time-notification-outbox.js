"use strict";

const cds = require("@sap/cds");
const {
  _internal: { deriveKey, persistNotification },
} = require("./approval-orchestrator");

/**
 * Guarda las notificaciones de Tiempos en la misma outbox durable utilizada
 * por Ausencias. El payload permite reconstruir el correo sin crear una
 * ApprovalInstance paralela para la hoja semanal.
 */
async function queueTimeNotification(tx, input) {
  const approval = cds.entities("sabnez.approvals");
  return persistNotification(tx, approval, {
    type: input.type,
    recipientID: input.recipientID,
    processCode: "TIME",
    idempotencyKey: deriveKey(input.idempotencyKey, input.recipientID),
    payload: input.payload,
  });
}

module.exports = {
  queueTimeNotification,
};
