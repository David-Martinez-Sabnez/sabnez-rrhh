"use strict";

/**
 * better-sqlite3 es un binario nativo: el compilado para macOS no carga en
 * la VM Linux del puente de archivos y la migración moría con "invalid ELF
 * header". `node:sqlite` viene con Node 22 y hace lo mismo, así que el
 * script deja de depender de dónde se ejecute.
 */
function openDatabase(file) {
  try {
    const Database = require("better-sqlite3");
    return new Database(file);
  } catch (err) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file);
    return {
      pragma: (sentencia) => db.exec(`PRAGMA ${sentencia}`),
      prepare: (sql) => {
        const st = db.prepare(sql);
        return {
          run: (...args) => st.run(...args),
          all: (...args) => st.all(...args),
          get: (...args) => st.get(...args),
        };
      },
      transaction: (fn) => (...args) => {
        db.exec("BEGIN");
        try {
          const resultado = fn(...args);
          db.exec("COMMIT");
          return resultado;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
      close: () => db.close(),
    };
  }
}

module.exports = { openDatabase };
