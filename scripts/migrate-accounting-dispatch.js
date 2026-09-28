/**
 * Deja lista la base para el envío de expedientes a contabilidad:
 * siembra los parámetros de configuración que el código espera encontrar.
 *
 *   node scripts/migrate-accounting-dispatch.js
 *
 * Las columnas nuevas de CollectionAccounts (accountingSentAt y compañía) y la
 * tabla sabnez.config.Parametros las crea el despliegue del modelo. Lo que no
 * hace el despliegue sobre una base con datos es sembrar el CSV, así que el
 * parámetro CONTABILIDAD_EMAIL se inserta aquí.
 *
 * Es idempotente: si el parámetro ya existe, respeta el valor configurado y no
 * lo pisa con el de fábrica.
 */

"use strict";

const cds = require("@sap/cds");

const PARAMETROS = [
  {
    clave: "CONTABILIDAD_EMAIL",
    grupo: "Cuentas de cobro",
    nombre: "Correo de contabilidad",
    descripcion: "Buzón al que RR. HH. envía los expedientes de cuentas de cobro aprobadas.",
    tipo: "EMAIL",
    valor: "contabilidad@sabnez.com",
    sistema: true,
  },
];

const PARAMETROS_ENTIDAD = "sabnez.config.Parametros";

async function main() {
  cds.model = await cds.load("*");
  await cds.connect.to("db");
  const { SELECT, INSERT } = cds.ql;

  let creados = 0;

  for (const parametro of PARAMETROS) {
    const existente = await SELECT.one.from(PARAMETROS_ENTIDAD).where({ clave: parametro.clave });

    if (existente) {
      // No se pisa: el valor de producción manda sobre el de fábrica.
      console.log(`· ${parametro.clave} ya existe con el valor "${existente.valor}".`);
      continue;
    }

    await INSERT.into(PARAMETROS_ENTIDAD).entries(parametro);
    console.log(`✓ ${parametro.clave} creado con el valor "${parametro.valor}".`);
    creados += 1;
  }

  console.log(
    creados
      ? `\nListo: ${creados} parámetro(s) creados. Revísalos en la pestaña Parámetros de la app de RR. HH.`
      : "\nListo: los parámetros ya estaban configurados, no se creó nada.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("La migración falló:", error.message);
    process.exit(1);
  });
