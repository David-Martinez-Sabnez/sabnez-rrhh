"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { notificationContent } = require("../srv/lib/mail-content");

const URLS = {
  tarea: "https://sabnez.test/aprobaciones#/task/abc",
  cuentas: "https://sabnez.test/cuentascobroui",
  tiempos: "https://sabnez.test/tiemposempleadoui",
  ausencias: "https://sabnez.test/ausenciasui",
};

const base = {
  recipientName: "Camila Sabogal",
  solicitanteNombre: "David Martínez",
  titulo: "CC-202608-FFA4A97D",
  resumen: "Cuenta de cobro por $ 5.000.000.",
  facts: [{ etiqueta: "Valor bruto", valor: "$ 5.000.000", orden: 10 }],
};

// La lista tiene que cubrir TODOS los tipos que llegan a la outbox, más uno
// inventado para el caso por defecto: es lo que garantiza que ningún correo de
// la plataforma se quede fuera del formato.
const TIPOS = [
  "COLLECTION_ACCOUNT_SUBMITTED",
  "COLLECTION_ACCOUNT_DECIDED",
  "COLLECTION_ACCOUNT_DUE",
  "COLLECTION_ACCOUNT_OVERDUE",
  "COLLECTION_ACCOUNT_CORRECTION_REQUESTED",
  "COLLECTION_ACCOUNT_CORRECTION_RESOLVED",
  "TIME_ENTRY_CUTOFF",
  "TIME_ENTRY_CUTOFF_OVERDUE",
  "TIME_SUBMITTED",
  "TIME_DECIDED",
  "APPROVAL_ASSIGNED",
  "APPROVAL_FORWARDED",
  "APPROVAL_DECIDED",
  "DELEGATION_CREATED",
  "DELEGATION_UPDATED",
  "DELEGATION_REVOKED",
  "TIPO_NO_REGISTRADO",
];

test("todos los tipos producen un correo con la identidad de Sabnez", () => {
  for (const tipo of TIPOS) {
    const { subject, html } = notificationContent({ ...base, tipo }, URLS);
    assert.ok(subject.length > 0, `${tipo} debe tener asunto`);
    assert.ok(html.startsWith("<!DOCTYPE html>"), `${tipo} debe ser un documento HTML`);
    assert.match(html, /SABNEZ<\/span> <span[^>]*>CONSULTING/, `${tipo} debe llevar la marca`);
    // El logotipo va como adjunto en línea: Gmail y Outlook bloquean data URI.
    assert.match(html, /src="cid:sabnez-logo"/, `${tipo} debe referenciar el logotipo adjunto`);
    assert.match(html, /NIT 901\.763\.614-4/, `${tipo} debe llevar el pie corporativo`);
    assert.ok(!/undefined|\[object Object\]/.test(html), `${tipo} no debe dejar huecos sin resolver`);
  }
});

test("todos los tipos llevan la acción arriba y repetida al cierre", () => {
  for (const tipo of TIPOS) {
    const { html } = notificationContent({ ...base, tipo }, URLS);
    const botones = html.match(/<a href="https:\/\/sabnez\.test/g) || [];
    assert.equal(botones.length, 2, `${tipo} debe llevar el botón en la tarjeta y al cierre`);
  }
});

test("el correo de corte lleva al registro de tiempos y conserva el detalle por proyecto", () => {
  const { subject, html } = notificationContent(
    {
      ...base,
      tipo: "TIME_ENTRY_CUTOFF",
      titulo: "Codelco HCM, Soporte regional",
      resumen: "Tienes 12.0 horas pendientes en 2 proyectos.",
      facts: [
        { etiqueta: "Codelco HCM", valor: "4.0 de 8.0 h · corte 2026-10-01", orden: 1 },
        { etiqueta: "Soporte regional", valor: "0.0 de 8.0 h · corte 2026-10-03", orden: 2 },
      ],
    },
    URLS,
  );

  assert.match(subject, /Completa tus tiempos antes del corte/);
  assert.match(html, /Codelco HCM/);
  assert.match(html, /Soporte regional/);
  assert.match(html, /tiemposempleadoui/);
  // El detalle por proyecto va en la tarjeta, antes de cualquier párrafo.
  assert.ok(
    html.indexOf("Codelco HCM") < html.indexOf("Hola, Camila."),
    "los datos accionables van antes del texto",
  );
});

test("el correo de corte vencido conserva la plantilla y comunica la urgencia", () => {
  const { subject, html } = notificationContent(
    {
      ...base,
      tipo: "TIME_ENTRY_CUTOFF_OVERDUE",
      titulo: "Codelco HCM",
      resumen: "El periodo ya cerró y tienes 8.0 horas pendientes.",
      facts: [
        {
          etiqueta: "Codelco HCM",
          valor: "8.0 h pendientes · corte vencido 2026-09-30 · 1 día(s) de atraso",
          orden: 1,
          semanticColor: "ERROR",
        },
      ],
    },
    URLS,
  );

  assert.match(subject, /Urgente: el periodo cerró/);
  assert.match(html, /Cierre incumplido/);
  assert.match(html, /#C0392B/, "la urgencia usa la semántica roja del formato corporativo");
  assert.match(html, /El incumplimiento ya quedó registrado/);
  assert.match(html, /tiemposempleadoui/);
  assert.match(html, /src="cid:sabnez-logo"/, "conserva la plantilla corporativa vigente");
});

test("el resultado de la cuenta cambia según la decisión de RR. HH.", () => {
  const aprobada = notificationContent(
    { ...base, tipo: "COLLECTION_ACCOUNT_DECIDED", estadoInstancia: "APPROVED" },
    URLS,
  );
  assert.match(aprobada.subject, /aprobada/i);
  assert.match(aprobada.html, /Aprobada para pago/);
  assert.match(aprobada.html, /#1B7F4B/, "el estado aprobado usa el riel verde");

  const devuelta = notificationContent(
    { ...base, tipo: "COLLECTION_ACCOUNT_DECIDED", estadoInstancia: "REJECTED" },
    URLS,
  );
  assert.match(devuelta.subject, /devuelta/i);
  assert.match(devuelta.html, /Devuelta para corrección/);
  assert.match(devuelta.html, /#C0392B/, "el estado devuelto usa el riel rojo");
});

test("el comentario de una persona se distingue del texto del sistema", () => {
  const conComentario = notificationContent(
    {
      ...base,
      tipo: "COLLECTION_ACCOUNT_DECIDED",
      estadoInstancia: "REJECTED",
      comentario: "El comprobante PILA corresponde a julio y el periodo cobrado es agosto.",
    },
    URLS,
  );
  assert.match(conComentario.html, /Comentario de RR\. HH\./, "el comentario se atribuye a quien lo escribió");
  assert.match(conComentario.html, /comprobante PILA corresponde a julio/);

  const sinComentario = notificationContent(
    { ...base, tipo: "COLLECTION_ACCOUNT_DECIDED", estadoInstancia: "REJECTED" },
    URLS,
  );
  assert.ok(
    !/Comentario de RR\. HH\./.test(sinComentario.html),
    "sin comentario no se pinta un recuadro vacío",
  );
});

test("las delegaciones dicen quién delegó, con qué alcance y hasta cuándo", () => {
  const { subject, html } = notificationContent(
    {
      tipo: "DELEGATION_CREATED",
      recipientName: "Ana Pérez",
      titulo: "Ausencias",
      resumen: "",
      otorganteNombre: "Camila Sabogal",
      alcanceTexto: "Ausencias",
      vigencia: "del 01/10/2026 al 15/10/2026",
      modoTexto: "SUBSTITUTE",
      facts: [
        { etiqueta: "Alcance de la delegación", valor: "Ausencias", orden: 10 },
        { etiqueta: "Vigencia", valor: "del 01/10/2026 al 15/10/2026", orden: 20 },
      ],
    },
    URLS,
  );

  assert.match(subject, /Te delegaron aprobaciones/);
  assert.match(html, /Camila Sabogal/);
  assert.match(html, /del 01\/10\/2026 al 15\/10\/2026/);
  assert.match(html, /responsable único/, "SUBSTITUTE se explica en palabras");
});

test("una delegación sin datos sigue produciendo un correo utilizable", () => {
  const { subject, html } = notificationContent(
    { tipo: "DELEGATION_REVOKED", recipientName: "Ana Pérez", titulo: "Solicitud de aprobación", resumen: "", facts: [] },
    URLS,
  );

  assert.ok(subject.length > 0);
  assert.match(html, /aprobaciones#\/task\/abc/, "conserva el enlace al Centro de Aprobaciones");
  assert.ok(!/undefined/.test(html), "no deja huecos cuando faltan los datos");
});

test("cada notificación enlaza a la aplicación que corresponde", () => {
  const aRevisar = notificationContent({ ...base, tipo: "COLLECTION_ACCOUNT_SUBMITTED" }, URLS);
  assert.match(aRevisar.html, /aprobaciones#\/task\/abc/, "RR. HH. entra por el Centro de Aprobaciones");

  const recordatorio = notificationContent({ ...base, tipo: "COLLECTION_ACCOUNT_DUE" }, URLS);
  assert.match(recordatorio.html, /cuentascobroui/, "el prestador entra por su app de cuentas de cobro");
});

test("escapa el contenido variable para no romper el HTML del correo", () => {
  const { html } = notificationContent(
    { ...base, tipo: "COLLECTION_ACCOUNT_DUE", resumen: '<script>alert("x")</script>' },
    URLS,
  );
  assert.ok(!html.includes("<script>alert"), "el resumen no debe inyectar etiquetas");
  assert.match(html, /&lt;script&gt;/);
});
