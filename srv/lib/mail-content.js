"use strict";

const { buildHtml } = require("./mail-template");

const APPS = Object.freeze({
  APROBACIONES: "Centro de Aprobaciones",
  TIEMPOS: "Gestión de Tiempos",
  AUSENCIAS: "Gestión de Ausencias",
  CUENTAS: "Cuentas de Cobro",
});

// Va sobre el botón, no al pie: es la instrucción de dónde se decide, y ahí es
// donde la lee quien va a decidir.
const LLAMADO_DECISION = "La decisión queda registrada en el Centro de Aprobaciones.";

const AUTOR_RRHH = "Comentario de RR. HH.";

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

/** Solo se enmarca como nota si de verdad la escribió una persona. */
function comentarioDe(data, autor = AUTOR_RRHH) {
  const texto = String(data.comentario || "").trim();
  return texto ? { autor, texto } : undefined;
}

/**
 * Devuelve asunto y cuerpo del correo para cada tipo de notificación.
 * `urls` inyecta los enlaces ya resueltos para no acoplar la plantilla a la
 * configuración de entorno (facilita además renderizar previsualizaciones).
 */
function notificationContent(data, urls = {}, options = {}) {
  const recipientName = data.recipientName || data.destinatarioID || "usuario";
  const saludo = `Hola, ${String(recipientName).split(" ")[0]}.`;
  const base = { logoSrc: options.logoSrc, saludo, facts: data.facts };

  switch (data.tipo) {
    // ------------------------------------------------------ Cuentas de cobro
    case "COLLECTION_ACCOUNT_SUBMITTED":
      return {
        subject: `Cuenta de cobro por aprobar: ${data.solicitanteNombre} · ${data.titulo}`,
        html: buildHtml({
          ...base,
          app: APPS.APROBACIONES,
          titulo: "Una cuenta de cobro espera tu aprobación",
          estado: "Pendiente de aprobación",
          semantica: "WARNING",
          llamado: "Revisa el documento firmado y el soporte de seguridad social antes de decidir.",
          accion: { texto: "Revisar en el Centro de Aprobaciones", url: urls.tarea },
          llamadoFinal: "¿Apruebas esta cuenta de cobro?",
          cuerpo: [
            `${data.solicitanteNombre} firmó su cuenta de cobro y la envió para autorización de pago. En la tarea vas a encontrar el PDF firmado y el soporte de seguridad social, descargables antes de aprobar.`,
          ],
          secciones: [
            {
              titulo: "Qué conviene verificar",
              puntos: [
                "Que el soporte de seguridad social corresponda al periodo cobrado.",
                "Que las horas aprobadas coincidan con los tiempos cerrados del periodo.",
                "Que la cuenta bancaria del prestador esté vigente.",
              ],
            },
          ],
          resumen: data.resumen,
          aviso: `${LLAMADO_DECISION} Mensaje automático de Sabnez Enterprise Platform: no respondas a este correo.`,
        }),
      };

    case "COLLECTION_ACCOUNT_DECIDED": {
      const aprobada = data.estadoInstancia === "APPROVED";
      return {
        subject: `${aprobada ? "Cuenta de cobro aprobada" : "Cuenta de cobro devuelta"}: ${data.titulo}`,
        html: buildHtml({
          ...base,
          app: APPS.CUENTAS,
          titulo: aprobada ? "Tu cuenta de cobro fue aprobada" : "Tu cuenta de cobro fue devuelta",
          estado: aprobada ? "Aprobada para pago" : "Devuelta para corrección",
          semantica: aprobada ? "SUCCESS" : "ERROR",
          llamado: aprobada
            ? "Puedes descargar el documento firmado cuando lo necesites."
            : "Corrige lo indicado y vuelve a firmarla para reenviarla.",
          accion: {
            texto: aprobada ? "Ver mi cuenta de cobro" : "Corregir mi cuenta de cobro",
            url: urls.cuentas,
          },
          llamadoFinal: aprobada ? "¿Quieres ver el detalle?" : "¿Listo para corregirla?",
          cuerpo: [
            aprobada
              ? "RR. HH. autorizó tu cuenta de cobro y ya entró en la programación de pagos del periodo."
              : "RR. HH. revisó tu cuenta de cobro y la devolvió. Al corregirla tendrás que firmarla de nuevo: la firma anterior queda anulada junto con el documento generado.",
          ],
          nota: comentarioDe(data),
          resumen: data.comentario ? undefined : data.resumen,
        }),
      };
    }

    case "COLLECTION_ACCOUNT_DUE":
      return {
        subject: `Ya puedes generar tu cuenta de cobro · ${data.titulo}`,
        html: buildHtml({
          ...base,
          app: APPS.CUENTAS,
          titulo: "Tu periodo cerró: ya puedes facturar",
          estado: "Pendiente de generar",
          semantica: "INFO",
          llamado: "Genera y firma tu cuenta de cobro para que entre en la programación de pagos.",
          accion: { texto: "Generar mi cuenta de cobro", url: urls.cuentas },
          llamadoFinal: "¿Generamos tu cuenta de cobro?",
          cuerpo: [
            "El periodo que acaba de cerrar ya tiene todas sus horas aprobadas, así que está disponible para facturar.",
          ],
          secciones: [
            {
              titulo: "Antes de enviarla a RR. HH.",
              parrafos: ["La cuenta no se puede enviar sin el soporte de seguridad social del periodo."],
              puntos: [
                "Si es tu primer cobro, adjunta el soporte de afiliación como independiente.",
                "Si ya cobraste antes, adjunta el comprobante PILA del periodo anterior.",
              ],
            },
          ],
          resumen: data.resumen,
        }),
      };

    case "COLLECTION_ACCOUNT_OVERDUE":
      return {
        subject: `Recordatorio: tu cuenta de cobro sigue pendiente · ${data.titulo}`,
        html: buildHtml({
          ...base,
          app: APPS.CUENTAS,
          titulo: "Tu cuenta de cobro sigue sin generarse",
          estado: "Pendiente de generar",
          semantica: "WARNING",
          llamado: "Si no la firmas a tiempo, el pago se corre al siguiente ciclo.",
          accion: { texto: "Generar mi cuenta de cobro", url: urls.cuentas },
          llamadoFinal: "¿La generamos ahora?",
          cuerpo: [
            "Han pasado tres días desde que se abrió el periodo y todavía no has generado tu cuenta de cobro.",
            "Si ya no vas a cobrar este periodo, puedes ignorar este mensaje: el recordatorio no se repite.",
          ],
          resumen: data.resumen,
        }),
      };

    case "COLLECTION_ACCOUNT_CORRECTION_REQUESTED":
      return {
        subject: `Corrección solicitada: ${data.solicitanteNombre} · ${data.titulo}`,
        html: buildHtml({
          ...base,
          app: APPS.APROBACIONES,
          titulo: "Un prestador pidió corregir su cuenta de cobro",
          estado: "Corrección pendiente",
          semantica: "WARNING",
          llamado: "Al aprobar la solicitud, la cuenta se recalcula contra los tiempos aprobados vigentes.",
          accion: { texto: "Revisar en el Centro de Aprobaciones", url: urls.tarea },
          llamadoFinal: "¿Autorizas el recálculo?",
          cuerpo: [
            `${data.solicitanteNombre} pidió corregir su cuenta de cobro antes de firmarla.`,
          ],
          nota: comentarioDe(data, `Motivo que indicó ${data.solicitanteNombre}`),
          resumen: data.comentario ? undefined : data.resumen,
          aviso: `${LLAMADO_DECISION} Mensaje automático de Sabnez Enterprise Platform: no respondas a este correo.`,
        }),
      };

    case "COLLECTION_ACCOUNT_CORRECTION_RESOLVED": {
      const aplicada = data.estadoInstancia === "APPROVED";
      return {
        subject: `Tu solicitud de corrección fue ${aplicada ? "atendida" : "rechazada"}: ${data.titulo}`,
        html: buildHtml({
          ...base,
          app: APPS.CUENTAS,
          titulo: aplicada ? "Tu cuenta de cobro fue recalculada" : "Tu solicitud de corrección fue rechazada",
          estado: aplicada ? "Corrección atendida" : "Corrección no aplicada",
          semantica: aplicada ? "SUCCESS" : "INFO",
          llamado: "Revísala y fírmala para enviarla a aprobación.",
          accion: { texto: "Revisar y firmar mi cuenta", url: urls.cuentas },
          llamadoFinal: "¿La revisamos?",
          cuerpo: [
            aplicada
              ? "RR. HH. atendió tu solicitud y recalculó la cuenta con los tiempos aprobados vigentes."
              : "RR. HH. revisó tu solicitud y no encontró motivo para recalcular la cuenta. El valor se mantiene.",
          ],
          nota: comentarioDe(data),
          resumen: data.comentario ? undefined : data.resumen,
        }),
      };
    }

    // ---------------------------------------------------------------- Tiempos
    case "TIME_ENTRY_CUTOFF":
      return {
        subject: `Completa tus tiempos antes del corte · ${data.titulo}`,
        html: buildHtml({
          ...base,
          app: APPS.TIEMPOS,
          titulo: "Se acerca el corte y te faltan horas por registrar",
          estado: "Registro pendiente",
          semantica: "WARNING",
          llamado: "Registra las horas que faltan antes de la fecha de corte de cada proyecto.",
          accion: { texto: "Completar mis tiempos", url: urls.tiempos },
          llamadoFinal: "¿Completamos tus tiempos?",
          cuerpo: [
            "Faltan tres días para el corte de uno o más proyectos y todavía tienes horas pendientes por registrar.",
          ],
          secciones: [
            {
              titulo: "Cómo se calcula lo que falta",
              parrafos: [
                "El cálculo usa la dedicación de tu asignación y el calendario laboral configurado para cada proyecto, comparados contra las horas que ya registraste.",
              ],
            },
          ],
          // Sin `resumen`: la tarjeta ya trae el detalle por proyecto y
          // repetirlo abajo no agrega nada.
        }),
      };

    case "TIME_SUBMITTED":
      return {
        subject: `Tiempos pendientes: ${data.solicitanteNombre} · ${data.titulo}`,
        html: buildHtml({
          ...base,
          app: APPS.TIEMPOS,
          titulo: "Una hoja de tiempos espera tu revisión",
          estado: "Pendiente de aprobación",
          semantica: "WARNING",
          llamado: LLAMADO_DECISION,
          accion: { texto: "Revisar tiempos", url: urls.tarea },
          llamadoFinal: "¿Apruebas esta hoja de tiempos?",
          cuerpo: [`${data.solicitanteNombre} envió su hoja semanal y requiere tu aprobación.`],
          resumen: data.resumen,
          aviso: `${LLAMADO_DECISION} Mensaje automático de Sabnez Enterprise Platform: no respondas a este correo.`,
        }),
      };

    case "TIME_DECIDED":
      return {
        subject: `Resultado de tiempos: ${data.titulo}`,
        html: buildHtml({
          ...base,
          app: APPS.TIEMPOS,
          titulo: "Ya revisaron tu hoja de tiempos",
          estado: translateStatus(data.estadoInstancia),
          llamado: "Consulta el detalle de la semana en la aplicación.",
          accion: { texto: "Abrir Mis tiempos", url: urls.tiempos },
          llamadoFinal: "¿Quieres ver el detalle?",
          cuerpo: [data.resumen || "Tu hoja de tiempos ya fue revisada."],
          nota: comentarioDe(data, "Comentario del aprobador"),
        }),
      };

    // --------------------------------------------------------------- Ausencias
    case "APPROVAL_ASSIGNED":
      return {
        subject: `Nueva solicitud para aprobar: ${data.titulo}`,
        html: buildHtml({
          ...base,
          app: APPS.APROBACIONES,
          titulo: "Una solicitud de ausencia espera tu aprobación",
          estado: "Pendiente de aprobación",
          semantica: "WARNING",
          llamado: "Puedes aprobarla, rechazarla o reasignarla a otra persona.",
          accion: { texto: "Revisar solicitud", url: urls.tarea },
          llamadoFinal: "¿Apruebas esta solicitud?",
          cuerpo: [`${data.solicitanteNombre} envió una solicitud de ausencia que requiere tu aprobación.`],
          resumen: data.resumen,
          aviso: `${LLAMADO_DECISION} Mensaje automático de Sabnez Enterprise Platform: no respondas a este correo.`,
        }),
      };

    case "APPROVAL_FORWARDED":
      return {
        subject: `Solicitud reasignada: ${data.titulo}`,
        html: buildHtml({
          ...base,
          app: APPS.APROBACIONES,
          titulo: "Se te reasignó una solicitud de ausencia",
          estado: "Pendiente de aprobación",
          semantica: "WARNING",
          llamado: "Quedaste como responsable de decidir sobre esta solicitud.",
          accion: { texto: "Revisar solicitud", url: urls.tarea },
          llamadoFinal: "¿Apruebas esta solicitud?",
          cuerpo: [`Se te reasignó una solicitud presentada por ${data.solicitanteNombre}.`],
          resumen: data.resumen,
          aviso: `${LLAMADO_DECISION} Mensaje automático de Sabnez Enterprise Platform: no respondas a este correo.`,
        }),
      };

    case "APPROVAL_DECIDED":
      return {
        subject: `Resultado de tu solicitud: ${data.titulo}`,
        html: buildHtml({
          ...base,
          app: APPS.AUSENCIAS,
          titulo: "Ya revisaron tu solicitud de ausencia",
          estado: translateStatus(data.estadoInstancia),
          llamado: "Puedes consultar el detalle y tu saldo actualizado.",
          accion: { texto: "Consultar mis solicitudes", url: urls.ausencias },
          llamadoFinal: "¿Quieres ver el detalle?",
          cuerpo: ["Tu solicitud de ausencia ya fue revisada."],
          nota: comentarioDe(data, "Comentario del aprobador"),
          resumen: data.comentario ? undefined : data.resumen,
        }),
      };

    // ------------------------------------------------------------ Delegaciones
    case "DELEGATION_CREATED":
    case "DELEGATION_UPDATED": {
      const nueva = data.tipo === "DELEGATION_CREATED";
      return {
        subject: `${nueva ? "Te delegaron aprobaciones" : "Cambió una delegación de aprobaciones"}: ${data.alcanceTexto || "Centro de Aprobaciones"}`,
        html: buildHtml({
          ...base,
          app: APPS.APROBACIONES,
          titulo: nueva ? "Te delegaron aprobaciones" : "Cambió la delegación que tienes a cargo",
          estado: nueva ? "Delegación activa" : "Delegación actualizada",
          semantica: "INFO",
          llamado: "Las solicitudes delegadas te van a aparecer en el Centro de Aprobaciones.",
          accion: { texto: "Abrir Centro de Aprobaciones", url: urls.tarea },
          llamadoFinal: "¿Revisamos lo que tienes pendiente?",
          cuerpo: [
            nueva
              ? `${data.otorganteNombre || "Un compañero"} te delegó sus aprobaciones${data.vigencia ? ` durante ${data.vigencia}` : ""}.`
              : `${data.otorganteNombre || "Un compañero"} modificó la delegación de aprobaciones que tienes a cargo. Revisa la vigencia y el alcance nuevos.`,
            data.modoTexto === "SUBSTITUTE"
              ? "Quedaste como responsable único: mientras dure la delegación, las solicitudes llegan solo a ti."
              : "Quedaste como respaldo: las solicitudes te llegan a ti y también a quien delegó.",
          ],
          nota: comentarioDe(data, "Motivo de la delegación"),
        }),
      };
    }

    case "DELEGATION_REVOKED":
      return {
        subject: `Terminó una delegación de aprobaciones: ${data.alcanceTexto || "Centro de Aprobaciones"}`,
        html: buildHtml({
          ...base,
          app: APPS.APROBACIONES,
          titulo: "Ya no tienes esta delegación a cargo",
          estado: "Delegación revocada",
          semantica: "INFO",
          llamado: "Las solicitudes que estaban a tu nombre por esta delegación volvieron a su aprobador original.",
          accion: { texto: "Abrir Centro de Aprobaciones", url: urls.tarea },
          llamadoFinal: "¿Revisamos lo que sigue a tu nombre?",
          cuerpo: [
            `${data.otorganteNombre || "Un compañero"} revocó la delegación de aprobaciones que tenías a cargo. No tienes que hacer nada: el cambio ya está aplicado.`,
          ],
          nota: comentarioDe(data, "Motivo de la revocación"),
        }),
      };

    default:
      return {
        subject: `Actualización de aprobación: ${data.titulo}`,
        html: buildHtml({
          ...base,
          app: APPS.APROBACIONES,
          titulo: "Se actualizó una solicitud relacionada contigo",
          estado: translateStatus(data.estadoInstancia),
          llamado: "Consulta el detalle en el Centro de Aprobaciones.",
          accion: { texto: "Abrir Centro de Aprobaciones", url: urls.tarea },
          llamadoFinal: "¿Quieres ver el detalle?",
          cuerpo: ["Se registró una actualización en una solicitud relacionada contigo."],
          resumen: data.resumen,
        }),
      };
  }
}

module.exports = { notificationContent, translateStatus, APPS };
