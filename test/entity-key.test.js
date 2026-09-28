"use strict";

// entityKey resuelve la clave de la entidad venga por donde venga.
// El caso que importa es el segundo: es el que usa la UI al editar, y
// el que antes hacía que un aprobador se detectara a sí mismo como
// duplicado y no se pudiera guardar.

const test = require("node:test");
const assert = require("node:assert/strict");
const { entityKey } = require("../srv/lib/entity-key");

const ID = "3f1c9a10-0000-4000-8000-000000000001";

test("lee la clave del cuerpo cuando viene incluida", () => {
  assert.equal(entityKey({ data: { ID, active: false } }), ID);
});

test("lee la clave de la URL en un PATCH Entidad(ID) — el caso de la UI", () => {
  const req = { data: { active: false }, params: [{ ID }] };
  assert.equal(entityKey(req), ID, "sin esto el registro se compara contra undefined");
});

test("acepta la clave como cadena suelta en params", () => {
  assert.equal(entityKey({ data: {}, params: [ID] }), ID);
});

test("lee la clave del where de una consulta programática", () => {
  const req = {
    data: { active: false },
    query: { UPDATE: { where: [{ ref: ["ID"] }, "=", { val: ID }] } },
  };
  assert.equal(entityKey(req), ID);
});

test("devuelve null en un CREATE, donde todavía no hay clave", () => {
  assert.equal(entityKey({ data: { active: true }, params: [] }), null);
  assert.equal(entityKey({}), null);
});

test("no confunde otro campo del where con la clave", () => {
  const req = {
    data: {},
    query: { UPDATE: { where: [{ ref: ["project_ID"] }, "=", { val: "otro" }] } },
  };
  assert.equal(entityKey(req), null);
});
