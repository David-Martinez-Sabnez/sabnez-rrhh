"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { montoEnLetras } = require("../srv/lib/money-words");

test("expresa el valor de la cuenta de cobro en letras", () => {
  // Apócope delante del sustantivo: "un peso", no "uno peso".
  assert.equal(montoEnLetras(1, "COP"), "Un peso colombiano");
  assert.equal(montoEnLetras(21, "COP"), "Veintiún pesos colombianos");
  assert.equal(montoEnLetras(31, "COP"), "Treinta y un pesos colombianos");
  assert.equal(montoEnLetras(101, "COP"), "Ciento un pesos colombianos");

  assert.equal(montoEnLetras(100, "COP"), "Cien pesos colombianos");
  assert.equal(montoEnLetras(1000, "COP"), "Mil pesos colombianos");
  assert.equal(montoEnLetras(21000, "COP"), "Veintiún mil pesos colombianos");

  // "de" solo cuando la cifra termina exactamente en millón/millones.
  assert.equal(montoEnLetras(1000000, "COP"), "Un millón de pesos colombianos");
  assert.equal(montoEnLetras(5000000, "COP"), "Cinco millones de pesos colombianos");
  assert.equal(montoEnLetras(1500000, "COP"), "Un millón quinientos mil pesos colombianos");
  assert.equal(montoEnLetras(2500000000, "COP"), "Dos mil quinientos millones de pesos colombianos");

  // Centavos en notación de fracción, como en las cuentas de cobro impresas.
  assert.equal(
    montoEnLetras(4350500.5, "COP"),
    "Cuatro millones trescientos cincuenta mil quinientos pesos colombianos con 50/100",
  );

  assert.equal(montoEnLetras(0, "COP"), "Cero pesos colombianos");
  assert.equal(montoEnLetras(null, "COP"), "Cero pesos colombianos");
  assert.equal(montoEnLetras(2000, "USD"), "Dos mil dólares estadounidenses");
});
