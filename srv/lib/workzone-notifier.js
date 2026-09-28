"use strict";

const cds = require("@sap/cds");

const LOG = cds.log("workzone-notifier");

/**
 * Publica la notificación en el centro de notificaciones de SAP Build Work Zone,
 * en paralelo al correo. En local el plugin @cap-js/notifications solo escribe
 * en consola, así que el flujo funciona igual sin servicios de BTP.
 *
 * Los tipos y sus plantillas viven en srv/notification-types.json.
 */

// Cada tipo de la outbox se traduce a un tipo registrado en Work Zone.
// Un tipo sin entrada aquí simplemente no genera notificación en la campana.
const MAPEO = Object.freeze({
  COLLECTION_ACCOUNT_SUBMITTED: (data) => ({
    type: "CollectionAccountSubmitted",
    data: {
      prestador: data.solicitanteNombre,
      cuenta: data.titulo,
      valor: fact(data, "Valor bruto"),
      periodo: fact(data, "Periodo"),
    },
  }),
  COLLECTION_ACCOUNT_DECIDED: (data) =>
    data.estadoInstancia === "APPROVED"
      ? {
          type: "CollectionAccountApproved",
          data: {
            cuenta: data.titulo,
            valor: fact(data, "Valor bruto"),
            aprobador: fact(data, "Aprobada por") || "RR. HH.",
          },
        }
      : {
          type: "CollectionAccountReturned",
          data: {
            cuenta: data.titulo,
            motivo: data.comentario || fact(data, "Motivo") || "Revisa el detalle en la aplicación.",
          },
        },
  COLLECTION_ACCOUNT_CORRECTION_REQUESTED: (data) => ({
    type: "CollectionAccountCorrectionRequested",
    data: {
      prestador: data.solicitanteNombre,
      cuenta: data.titulo,
      motivo: data.resumen || fact(data, "Motivo"),
    },
  }),
  COLLECTION_ACCOUNT_CORRECTION_RESOLVED: (data) => ({
    type: "CollectionAccountCorrectionResolved",
    data: {
      cuenta: data.titulo,
      motivo: data.comentario || "Revisa el detalle en la aplicación.",
    },
  }),
  COLLECTION_ACCOUNT_DUE: (data) => ({
    type: "CollectionAccountDue",
    data: {
      periodo: data.titulo,
      horas: fact(data, "Horas aprobadas"),
      valor: fact(data, "Valor estimado"),
    },
  }),
  COLLECTION_ACCOUNT_OVERDUE: (data) => ({
    type: "CollectionAccountOverdue",
    data: {
      periodo: data.titulo,
      dias: String(data.diasTranscurridos ?? 3),
      valor: fact(data, "Valor estimado"),
    },
  }),
});

function fact(data, etiqueta) {
  return data.facts?.find((row) => row.etiqueta === etiqueta)?.valor || "";
}

/**
 * @param {object} data payload de la outbox, ya enriquecido con destinatario y hechos
 * @returns {Promise<boolean>} true si se publicó, false si el tipo no aplica
 */
async function sendWorkZoneNotification(data) {
  const mapear = MAPEO[data?.tipo];
  if (!mapear) return false;
  if (!data.destinatarioID) return false;

  const { type, data: payload } = mapear(data);

  // Si el plugin no está configurado, cds.connect.to lanza: no debe tumbar el
  // correo, que es el canal obligatorio.
  const alert = await cds.connect.to("notifications");
  await alert.notify(type, {
    recipients: [data.destinatarioID],
    data: payload,
  });

  LOG.info("Notificación publicada en Work Zone", {
    eventID: data.eventID,
    tipo: data.tipo,
    notificationType: type,
    destinatario: data.destinatarioID,
  });

  return true;
}

module.exports = { sendWorkZoneNotification };
