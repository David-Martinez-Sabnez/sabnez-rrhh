"use strict";

const cds = require("@sap/cds");

const { SELECT } = cds.ql;

/**
 * Validación de los parámetros según su tipo declarado.
 *
 * Es lo que impide que alguien deje el correo de contabilidad en un valor que
 * Microsoft Graph después rechaza, o un umbral numérico con texto.
 */
module.exports = cds.service.impl(function () {
  const { Parametros } = this.entities;

  this.before(["CREATE", "UPDATE"], Parametros, async (req) => {
    const valor = typeof req.data.valor === "string" ? req.data.valor.trim() : req.data.valor;
    if (valor === undefined) return;

    // En un flujo con draft la fila puede llegar sin el tipo: se lee del activo.
    const tipo = req.data.tipo || (await SELECT.one
      .from(Parametros)
      .columns("tipo")
      .where({ clave: req.data.clave }))?.tipo;

    if (valor === null || valor === "") {
      req.data.valor = null;
      return;
    }

    if (tipo === "EMAIL" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(valor)) {
      req.reject({
        status: 400,
        code: "CORREO_INVALIDO",
        message: "Escribe una dirección de correo válida.",
        target: "valor",
      });
    }

    if (tipo === "NUMBER" && Number.isNaN(Number(valor))) {
      req.reject({
        status: 400,
        code: "NUMERO_INVALIDO",
        message: "Este parámetro espera un número.",
        target: "valor",
      });
    }

    if (tipo === "BOOLEAN" && !["true", "false"].includes(String(valor).toLowerCase())) {
      req.reject({
        status: 400,
        code: "BOOLEANO_INVALIDO",
        message: "Este parámetro espera true o false.",
        target: "valor",
      });
    }

    req.data.valor = valor;
  });
});
