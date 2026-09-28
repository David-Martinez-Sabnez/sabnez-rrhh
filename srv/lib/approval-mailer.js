"use strict";

const cds = require("@sap/cds");

const { LOGO_CID } = require("./mail-template");
const { notificationContent } = require("./mail-content");
const { SABNEZ_LOGO_DATA_URI } = require("./sabnez-logo");

const LOG = cds.log("approval-mailer");

const TOKEN_SAFETY_WINDOW_MS = 60_000;

let cachedToken = null;
let tokenExpiresAt = 0;
let tokenRequest = null;

function graphConfig() {
  return {
    tenantId: process.env.GRAPH_TENANT_ID,
    clientId: process.env.GRAPH_CLIENT_ID,
    clientSecret: process.env.GRAPH_CLIENT_SECRET,
    // GRAPH_SENDER fue el nombre usado originalmente en Cloud Foundry.
    // GRAPH_MAILBOX queda como nombre preferido sin romper el despliegue actual.
    mailbox:
      process.env.GRAPH_MAILBOX ||
      process.env.GRAPH_SENDER ||
      "no-reply@sabnez.com",
    fromName: process.env.MAIL_FROM_NAME || "Notificaciones Sabnez",
    approvalAppUrl:
      process.env.APPROVAL_APP_URL ||
      "http://localhost:4004/aprobacionesui/webapp/index.html",
    absenceAppUrl:
      process.env.ABSENCE_APP_URL ||
      "http://localhost:4004/ausenciasui/webapp/index.html",
    timeEmployeeAppUrl:
      process.env.TIME_EMPLOYEE_APP_URL ||
      "http://localhost:4004/tiemposempleadoui/webapp/index.html",
    collectionAccountAppUrl:
      process.env.COLLECTION_ACCOUNT_APP_URL ||
      "http://localhost:4004/cuentascobroui/webapp/index.html",
  };
}

function validateGraphConfig(config) {
  const missing = [];

  if (!config.tenantId) missing.push("GRAPH_TENANT_ID");
  if (!config.clientId) missing.push("GRAPH_CLIENT_ID");
  if (!config.clientSecret) missing.push("GRAPH_CLIENT_SECRET");
  if (!config.mailbox) missing.push("GRAPH_MAILBOX");

  if (missing.length) {
    throw new Error(
      `Faltan variables de configuración de Microsoft Graph: ${missing.join(", ")}.`,
    );
  }
}

async function readResponseBody(response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function graphError(operation, response, body) {
  const detail =
    typeof body === "string"
      ? body
      : body?.error?.message || body?.error_description || response.statusText;

  const error = new Error(
    `${operation} falló con HTTP ${response.status}: ${
      detail || "sin detalle"
    }`,
  );

  error.status = response.status;
  error.graphResponse = body;

  return error;
}

async function requestAccessToken(config) {
  const tokenUrl =
    `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}` +
    "/oauth2/v2.0/token";

  const form = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form,
  });

  const body = await readResponseBody(response);

  if (!response.ok) {
    throw graphError(
      "La obtención del token de Microsoft Graph",
      response,
      body,
    );
  }

  if (!body?.access_token) {
    throw new Error("Microsoft Entra no devolvió access_token.");
  }

  const expiresInSeconds = Number(body.expires_in || 3600);

  cachedToken = body.access_token;
  tokenExpiresAt =
    Date.now() + Math.max(expiresInSeconds * 1000 - TOKEN_SAFETY_WINDOW_MS, 0);

  return cachedToken;
}

async function getAccessToken(config) {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  if (!tokenRequest) {
    tokenRequest = requestAccessToken(config).finally(() => {
      tokenRequest = null;
    });
  }

  return tokenRequest;
}

function invalidateAccessToken() {
  cachedToken = null;
  tokenExpiresAt = 0;
}

async function graphSendMail(config, payload, retryOnUnauthorized = true) {
  const accessToken = await getAccessToken(config);
  const mailbox = encodeURIComponent(config.mailbox);

  const endpoint =
    `https://graph.microsoft.com/v1.0/users/` + `${mailbox}/sendMail`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 401 && retryOnUnauthorized) {
    invalidateAccessToken();
    return graphSendMail(config, payload, false);
  }

  if (!response.ok) {
    const body = await readResponseBody(response);

    throw graphError("El envío de correo por Microsoft Graph", response, body);
  }

  return {
    accepted: true,
    status: response.status,
    messageId: response.headers.get("request-id") || null,
  };
}

function approvalUrl(taskID) {
  const baseUrl = graphConfig().approvalAppUrl.replace(/\/$/, "");
  const routeSeparator = baseUrl.includes("?") ? "&" : "#";

  return `${baseUrl}${routeSeparator}/task/${encodeURIComponent(taskID)}`;
}

// Enlaces que la plantilla usa para el botón de acción. Las notificaciones de
// Tiempos apuntan a la hoja, que en el Centro de Aprobaciones es la tarea.
function resolveUrls(data) {
  const config = graphConfig();
  const taskID = data.tareaID || data.hojaID;

  return {
    tarea: taskID ? approvalUrl(taskID) : config.approvalAppUrl,
    tiempos: config.timeEmployeeAppUrl,
    ausencias: config.absenceAppUrl,
    cuentas: config.collectionAccountAppUrl,
  };
}

// Adjunto en línea con el logotipo: los clientes de correo bloquean data URI.
function logoAttachment() {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: "sabnez-logo.png",
    contentType: "image/png",
    contentId: LOGO_CID,
    isInline: true,
    contentBytes: SABNEZ_LOGO_DATA_URI.split(",")[1],
  };
}

async function sendApprovalEmail(data) {
  const config = graphConfig();

  validateGraphConfig(config);

  if (!data?.destinatarioID) {
    throw new Error("La notificación no contiene destinatarioID.");
  }

  const content = notificationContent(data, resolveUrls(data));

  LOG.info("Enviando correo de aprobación mediante Microsoft Graph", {
    eventID: data.eventID,
    tipo: data.tipo,
    destinatario: data.destinatarioID,
    mailbox: config.mailbox,
  });

  const payload = {
    message: {
      subject: content.subject,
      body: {
        contentType: "HTML",
        content: content.html,
      },
      from: {
        emailAddress: {
          name: config.fromName,
          address: config.mailbox,
        },
      },
      toRecipients: [
        {
          emailAddress: {
            address: data.destinatarioID,
          },
        },
      ],
    },
    saveToSentItems: false,
  };

  payload.message.attachments = [logoAttachment()];

  return graphSendMail(config, payload);
}

/**
 * Envío genérico por Microsoft Graph, para correos que no nacen de la outbox
 * de aprobaciones: por ejemplo el paquete de cuentas de cobro que RR. HH. le
 * manda a contabilidad.
 *
 * @param {object} input
 * @param {string|string[]} input.to destinatario(s)
 * @param {string} input.subject
 * @param {string} input.html cuerpo ya renderizado
 * @param {Array<{name:string,contentType:string,content:Buffer}>} [input.attachments]
 * @param {boolean} [input.includeLogo] adjunta el logotipo en línea del pie
 */
async function sendMail({ to, subject, html, attachments = [], includeLogo = true }) {
  const config = graphConfig();
  validateGraphConfig(config);

  const destinatarios = (Array.isArray(to) ? to : [to])
    .map((correo) => String(correo || "").trim())
    .filter(Boolean);
  if (!destinatarios.length) throw new Error("El correo no tiene destinatarios.");

  const adjuntos = attachments.map((archivo) => ({
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: archivo.name,
    contentType: archivo.contentType || "application/octet-stream",
    contentBytes: Buffer.isBuffer(archivo.content)
      ? archivo.content.toString("base64")
      : String(archivo.content),
  }));
  if (includeLogo) adjuntos.push(logoAttachment());

  LOG.info("Enviando correo por Microsoft Graph", {
    destinatarios: destinatarios.length,
    adjuntos: adjuntos.length,
    mailbox: config.mailbox,
  });

  return graphSendMail(config, {
    message: {
      subject,
      body: { contentType: "HTML", content: html },
      from: { emailAddress: { name: config.fromName, address: config.mailbox } },
      toRecipients: destinatarios.map((address) => ({ emailAddress: { address } })),
      attachments: adjuntos,
    },
    saveToSentItems: true,
  });
}

module.exports = {
  sendApprovalEmail,
  sendMail,
};
