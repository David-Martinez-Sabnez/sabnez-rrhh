"use strict";

const cds = require("@sap/cds");

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
    mailbox: process.env.GRAPH_MAILBOX || "no-reply@sabnez.com",
    fromName: process.env.MAIL_FROM_NAME || "Notificaciones Sabnez",
    approvalAppUrl:
      process.env.APPROVAL_APP_URL ||
      "http://localhost:4004/aprobacionesui/webapp/index.html",
    absenceAppUrl:
      process.env.ABSENCE_APP_URL ||
      "http://localhost:4004/ausenciasui/webapp/index.html",
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function approvalUrl(taskID) {
  const baseUrl = graphConfig().approvalAppUrl.replace(/\/$/, "");

  return `${baseUrl}&/task/${encodeURIComponent(taskID)}`;
}

function detailRows(facts = []) {
  if (!facts.length) {
    return "";
  }

  return facts
    .sort((a, b) => Number(a.orden || 0) - Number(b.orden || 0))
    .map(
      (fact) => `
        <tr>
          <td style="
            width:38%;
            padding:10px 12px;
            border-bottom:1px solid #e5e5e5;
            color:#556b82;
            font-size:14px;
            vertical-align:top;
          ">
            ${escapeHtml(fact.etiqueta || fact.clave)}
          </td>

          <td style="
            padding:10px 12px;
            border-bottom:1px solid #e5e5e5;
            color:#1d2d3e;
            font-size:14px;
            font-weight:600;
            vertical-align:top;
          ">
            ${escapeHtml(fact.valor || "—")}
          </td>
        </tr>
      `,
    )
    .join("");
}

function buildHtml({
  title,
  greeting,
  introduction,
  summary,
  facts,
  status,
  buttonText,
  buttonUrl,
}) {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >
  <title>${escapeHtml(title)}</title>
</head>

<body style="
  margin:0;
  padding:0;
  background:#f5f6f7;
  font-family:'72',Arial,Helvetica,sans-serif;
  color:#1d2d3e;
">
  <table
    role="presentation"
    width="100%"
    cellspacing="0"
    cellpadding="0"
    border="0"
    style="background:#f5f6f7"
  >
    <tr>
      <td align="center" style="padding:32px 16px">
        <table
          role="presentation"
          width="600"
          cellspacing="0"
          cellpadding="0"
          border="0"
          style="
            width:100%;
            max-width:600px;
            background:#ffffff;
            border-radius:12px;
            overflow:hidden;
            box-shadow:0 2px 8px rgba(34,53,72,.16);
          "
        >
          <tr>
            <td style="
              padding:26px 32px;
              background:#0a6ed1;
              color:#ffffff;
            ">
              <div style="
                font-size:23px;
                line-height:30px;
                font-weight:700;
              ">
                ${escapeHtml(title)}
              </div>

              <div style="
                margin-top:6px;
                font-size:14px;
                opacity:.9;
              ">
                Centro de Aprobaciones · Sabnez Consulting
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:30px 32px">
              <p style="
                margin:0 0 16px;
                font-size:16px;
                line-height:24px;
              ">
                ${escapeHtml(greeting)}
              </p>

              <p style="
                margin:0 0 16px;
                font-size:15px;
                line-height:23px;
                color:#354a5f;
              ">
                ${escapeHtml(introduction)}
              </p>

              ${
                summary
                  ? `
                    <div style="
                      margin:0 0 22px;
                      padding:14px 16px;
                      background:#eef5fc;
                      border-left:4px solid #0a6ed1;
                      border-radius:4px;
                      color:#354a5f;
                      font-size:14px;
                      line-height:21px;
                    ">
                      ${escapeHtml(summary)}
                    </div>
                  `
                  : ""
              }

              ${
                status
                  ? `
                    <div style="
                      margin:0 0 20px;
                      font-size:14px;
                      color:#354a5f;
                    ">
                      <strong>Estado:</strong>
                      ${escapeHtml(status)}
                    </div>
                  `
                  : ""
              }

              ${
                facts?.length
                  ? `
                    <table
                      role="presentation"
                      width="100%"
                      cellspacing="0"
                      cellpadding="0"
                      border="0"
                      style="
                        background:#f7f8f9;
                        border:1px solid #e5e5e5;
                        border-radius:8px;
                        overflow:hidden;
                      "
                    >
                      ${detailRows(facts)}
                    </table>
                  `
                  : ""
              }

              ${
                buttonUrl
                  ? `
                    <div
                      style="
                        text-align:center;
                        margin:30px 0 12px;
                      "
                    >
                      <a
                        href="${escapeHtml(buttonUrl)}"
                        style="
                          display:inline-block;
                          padding:12px 25px;
                          background:#0a6ed1;
                          color:#ffffff;
                          text-decoration:none;
                          border-radius:6px;
                          font-size:15px;
                          font-weight:700;
                        "
                      >
                        ${escapeHtml(buttonText)}
                      </a>
                    </div>
                  `
                  : ""
              }

              <p style="
                margin:24px 0 0;
                font-size:12px;
                line-height:18px;
                color:#6a6d70;
              ">
                Este es un mensaje automático. Las decisiones
                deben registrarse desde el Centro de Aprobaciones.
              </p>
            </td>
          </tr>

          <tr>
            <td style="
              padding:16px 32px;
              background:#eef2f5;
              color:#556b82;
              font-size:12px;
            ">
              Sabnez Consulting SAS · Gestión de Recursos Humanos
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function notificationContent(data) {
  const recipientName = data.recipientName || data.destinatarioID || "usuario";

  switch (data.tipo) {
    case "APPROVAL_ASSIGNED":
      return {
        subject: `Nueva solicitud para aprobar: ${data.titulo}`,
        html: buildHtml({
          title: "Nueva solicitud de ausencia",
          greeting: `Hola, ${recipientName}.`,
          introduction:
            `${data.solicitanteNombre} ha enviado una solicitud ` +
            "que requiere tu aprobación.",
          summary: data.resumen,
          facts: data.facts,
          status: "Pendiente de aprobación",
          buttonText: "Revisar solicitud",
          buttonUrl: approvalUrl(data.tareaID),
        }),
      };

    case "APPROVAL_FORWARDED":
      return {
        subject: `Solicitud reasignada: ${data.titulo}`,
        html: buildHtml({
          title: "Solicitud de ausencia reasignada",
          greeting: `Hola, ${recipientName}.`,
          introduction:
            "Se te ha reasignado una solicitud presentada por " +
            `${data.solicitanteNombre}.`,
          summary: data.resumen,
          facts: data.facts,
          status: "Pendiente de aprobación",
          buttonText: "Revisar solicitud",
          buttonUrl: approvalUrl(data.tareaID),
        }),
      };

    case "APPROVAL_DECIDED":
      return {
        subject: `Resultado de tu solicitud: ${data.titulo}`,
        html: buildHtml({
          title: "Resultado de solicitud de ausencia",
          greeting: `Hola, ${recipientName}.`,
          introduction: "Tu solicitud de ausencia ya fue revisada.",
          summary: data.resumen,
          facts: data.facts,
          status: translateStatus(data.estadoInstancia),
          buttonText: "Consultar mis solicitudes",
          buttonUrl: graphConfig().absenceAppUrl,
        }),
      };

    default:
      return {
        subject: `Actualización de aprobación: ${data.titulo}`,
        html: buildHtml({
          title: "Actualización de una solicitud",
          greeting: `Hola, ${recipientName}.`,
          introduction:
            "Se registró una actualización en una solicitud " +
            "relacionada contigo.",
          summary: data.resumen,
          facts: data.facts,
          status: translateStatus(data.estadoInstancia),
          buttonText: "Abrir Centro de Aprobaciones",
          buttonUrl: approvalUrl(data.tareaID),
        }),
      };
  }
}

function translateStatus(status) {
  const statuses = {
    PENDING_ASSIGNMENT: "Pendiente de asignación",
    RUNNING: "En aprobación",
    APPROVED: "Aprobada",
    REJECTED: "Rechazada",
    CANCELLED: "Cancelada",
    ERROR: "Error",
  };

  return statuses[status] || status || "Actualizada";
}

async function sendApprovalEmail(data) {
  const config = graphConfig();

  validateGraphConfig(config);

  if (!data?.destinatarioID) {
    throw new Error("La notificación no contiene destinatarioID.");
  }

  const content = notificationContent(data);

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

  return graphSendMail(config, payload);
}

module.exports = {
  sendApprovalEmail,
};
