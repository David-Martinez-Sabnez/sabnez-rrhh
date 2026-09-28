"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildHtml } = require("../srv/lib/mail-template");

test("la plantilla corporativa es compatible con escritorio y móvil", () => {
  const html = buildHtml({
    app: "Gestión de Tiempos",
    titulo: "Completa tus tiempos",
    saludo: "Hola, David.",
    cuerpo: ["Se acerca el cierre del periodo."],
    resumen: "Tienes 8 horas pendientes.",
    estado: "Registro pendiente",
    semantica: "WARNING",
    datos: [{ valor: "8 h", etiqueta: "Horas pendientes" }],
    accion: { texto: "Completar mis tiempos", url: "https://sabnez.test/tiempos?from=mail&value=1" },
  });

  assert.match(html, /role="presentation"/, "usa tablas compatibles con Outlook");
  // El ancho es fluido, no hay media queries: Outlook ignora las hojas de
  // estilo, así que la adaptación al celular tiene que salir del propio
  // maquetado (width:100% con un tope de 640px).
  assert.match(html, /width:100%;max-width:640px/, "el contenedor se adapta al ancho del cliente");
  assert.ok(!html.includes("@media"), "no depende de media queries que Outlook ignora");
  assert.match(
    html,
    /<a href="[^"]*" style="display:block;padding:14px 20px/,
    "la acción principal ocupa todo el ancho de su celda",
  );
  assert.match(html, /SABNEZ<\/span> <span[^>]*>CONSULTING/, "la marca va en una sola línea");
  assert.match(html, /cid:sabnez-logo/);
  assert.match(html, /from=mail&amp;value=1/, "escapa correctamente la URL del botón");
});

test("la plantilla no permite HTML inyectado en campos dinámicos", () => {
  const html = buildHtml({
    titulo: '<img src=x onerror="alert(1)">',
    saludo: "Hola.",
    cuerpo: ["Contenido seguro."],
    datos: [{ etiqueta: "Detalle", valor: "<script>alert(1)</script>" }],
  });

  assert.ok(!html.includes("<script>alert"));
  assert.ok(!html.includes("<img src=x"));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x/);
});

// Esta es la garantía que sostiene la migración: un llamador que todavía use
// el vocabulario anterior no puede quedarse fuera del formato nuevo. Si este
// test se cae, algún correo de la plataforma dejó de verse como los demás.
test("acepta el vocabulario anterior y lo pinta con el formato nuevo", () => {
  const html = buildHtml({
    app: "Centro de Aprobaciones",
    title: "Una solicitud espera tu aprobación",
    greeting: "Hola, Camila.",
    introduction: "David Martínez envió una solicitud.",
    summary: "Vacaciones del 21 al 25 de septiembre.",
    status: "Pendiente de aprobación",
    semantic: "WARNING",
    facts: [
      { etiqueta: "Días solicitados", valor: "5 días hábiles", orden: 20 },
      { etiqueta: "Valor", valor: "$ 1.000.000", orden: 10 },
    ],
    buttonText: "Revisar solicitud",
    buttonUrl: "https://sabnez.test/aprobaciones",
    note: "Mensaje automático.",
  });

  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.match(html, /SABNEZ<\/span> <span[^>]*>CONSULTING/);
  assert.match(html, /Una solicitud espera tu aprobación/);
  assert.match(html, /Hola, Camila\./);
  assert.match(html, /David Martínez envió una solicitud\./);
  assert.match(html, /Vacaciones del 21 al 25 de septiembre\./);
  assert.match(html, /Pendiente de aprobación/);
  assert.match(html, /Revisar solicitud/);
  // Los facts se ordenan por `orden` y el valor manda sobre la etiqueta.
  assert.ok(
    html.indexOf("$ 1.000.000") < html.indexOf("5 días hábiles"),
    "respeta el orden declarado en los facts",
  );
  assert.match(html, /font-size:19px;line-height:26px;font-weight:700[^>]*>\$ 1\.000\.000/);
});

test("el estado sin semántica explícita se deduce del texto", () => {
  const aprobada = buildHtml({ title: "x", status: "Aprobada", facts: [{ etiqueta: "a", valor: "b" }] });
  const rechazada = buildHtml({ title: "x", status: "Rechazada", facts: [{ etiqueta: "a", valor: "b" }] });

  assert.match(aprobada, /#1B7F4B/, "aprobada usa el riel verde");
  assert.match(rechazada, /#C0392B/, "rechazada usa el riel rojo");
});
