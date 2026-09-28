"use strict";

// La clave de una entidad llega por vías distintas según cómo se pida
// la actualización:
//   - PATCH Entidad(ID) desde una UI  -> req.params = [{ ID }]
//   - UPDATE(...).where({ ID })       -> CAP la dobla en req.data
//   - payload con la clave incluida   -> req.data.ID
// Leer sólo req.data.ID deja fuera el primer caso, que es justo el que
// usan las aplicaciones.
function entityKey(req) {
  if (req?.data?.ID) return req.data.ID;

  const key = req?.params?.[0];
  if (key) return typeof key === "string" ? key : key.ID || null;

  const where = req?.query?.UPDATE?.where;
  if (Array.isArray(where)) {
    const i = where.findIndex((token) => token?.ref?.[0] === "ID");
    if (i >= 0 && where[i + 1] === "=" && where[i + 2]?.val) {
      return where[i + 2].val;
    }
  }
  return null;
}

module.exports = { entityKey };
