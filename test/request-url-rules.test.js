"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizarSideEffectFotoInline,
  obtenerHeaderHttp,
  obtenerRutaServicioPublica,
} = require("../srv/lib/request-url-rules");

test("evita confundir el side effect de foto con una descarga de stream", () => {
  const original =
    "/admin/Empleados(ID=ef1a2f6b-4e22-4206-9c13-6bedaf3172d0,IsActiveEntity=false)?$select=DraftMessages,foto_content";
  const normalized = normalizarSideEffectFotoInline(original);

  assert.equal(
    new URL(normalized, "http://localhost").searchParams.get("$select"),
    "foto_content,DraftMessages",
  );
  assert.equal(normalized.endsWith("_content"), false);

  const batchInner =
    "/Empleados(ID=ef1a2f6b-4e22-4206-9c13-6bedaf3172d0,IsActiveEntity=false)?$select=DraftMessages,foto_content";
  assert.equal(
    new URL(
      normalizarSideEffectFotoInline(batchInner),
      "http://localhost",
    ).searchParams.get("$select"),
    "foto_content,DraftMessages",
  );
});

test("no altera la ruta directa del stream ni otras consultas", () => {
  const stream =
    "/admin/Empleados(ID=ef1a2f6b-4e22-4206-9c13-6bedaf3172d0,IsActiveEntity=false)/foto_content";
  assert.equal(normalizarSideEffectFotoInline(stream), stream);
  assert.equal(
    normalizarSideEffectFotoInline("/admin/Empleados?$select=ID,foto_content"),
    "/admin/Empleados?$select=ID,foto_content",
  );
});

test("conserva el prefijo público del approuter para descargar la foto", () => {
  const forwardedPath =
    "/5439ce8e.sabnezrrhhservice.sabnezcomempleadosui/~version~/admin/$batch";
  assert.equal(
    obtenerRutaServicioPublica(forwardedPath),
    "/5439ce8e.sabnezrrhhservice.sabnezcomempleadosui/~version~/admin",
  );
  assert.equal(obtenerRutaServicioPublica("/admin/$batch"), "/admin");
  assert.equal(obtenerRutaServicioPublica(undefined), "/admin");
});

test("recupera el prefijo HTTP desde solicitudes internas de activación", () => {
  const forwardedPath = "/destino/~version~/admin/$batch";
  assert.equal(
    obtenerHeaderHttp(
      { _: { req: { headers: { "x-forwarded-path": forwardedPath } } } },
      "x-forwarded-path",
    ),
    forwardedPath,
  );
  assert.equal(
    obtenerHeaderHttp(
      { http: { req: { headers: { "x-forwarded-path": forwardedPath } } } },
      "x-forwarded-path",
    ),
    forwardedPath,
  );
});
