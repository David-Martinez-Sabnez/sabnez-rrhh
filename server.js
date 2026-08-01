"use strict";

const cds = require("@sap/cds");
const {
  normalizarSideEffectFotoInline,
} = require("./srv/lib/request-url-rules");

cds.on("bootstrap", (app) => {
  app.use((req, _res, next) => {
    // @cap-js/attachments 3.13.x usa el sufijo textual `_content$` para
    // distinguir una descarga de stream. Fiori puede generar un side effect
    // de entidad cuyo $select termina en foto_content, lo que produce un falso
    // positivo y un 500. Reordenar $select conserva la misma consulta OData.
    req.url = normalizarSideEffectFotoInline(req.url, req.method);

    next();
  });
});

module.exports = cds.server;
