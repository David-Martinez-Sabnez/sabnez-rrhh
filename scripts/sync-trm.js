"use strict";

/**
 * Trae la TRM oficial y la guarda.
 *
 * Pensado para correr una vez al día. En BTP eso se hace con el Job
 * Scheduler apuntando a la acción `sincronizarTRM` del servicio; este
 * script es la versión local, para el entorno de desarrollo y para
 * ponerse al día a mano si el trabajo programado falló.
 *
 * Si el entorno no puede salir a internet, no pasa nada grave: la app
 * avisa qué días faltan y la tasa se puede digitar desde Configuración.
 * Además, emitir una factura en moneda extranjera sin TRM del día está
 * bloqueado, así que el hueco no se convierte en un número inventado.
 *
 * Uso: node scripts/sync-trm.js [días hacia atrás]
 */

const path = require("node:path");
const crypto = require("node:crypto");
const { openDatabase } = require("./lib/open-sqlite");
const { fetchOfficialRates, newRatesOnly, missingRateDates } = require("../srv/lib/trm");

const dias = Number(process.argv[2]) || 45;
const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
const hoy = new Date().toISOString().slice(0, 10);

(async () => {
  let traidas;
  try {
    traidas = await fetchOfficialRates({ since: desde, limit: 400 });
  } catch (error) {
    console.error(`No se pudo consultar la TRM oficial: ${error.message}`);
    console.error("Se puede registrar a mano desde Configuración en la app de Finanzas.");
    process.exit(1);
  }

  const db = openDatabase(path.resolve(__dirname, "..", "db.sqlite"));
  const existentes = db.prepare("SELECT currency, validFrom FROM sabnez_finance_ExchangeRates").all();
  const nuevas = newRatesOnly({ fetched: traidas, existing: existentes });

  if (nuevas.length) {
    const ahora = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO sabnez_finance_ExchangeRates
         (ID, createdAt, createdBy, modifiedAt, modifiedBy, currency, validFrom, validTo, rate, source, capturedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const cargar = db.transaction(() => {
      for (const f of nuevas)
        insert.run(crypto.randomUUID(), ahora, "sync-trm", ahora, "sync-trm",
          f.currency, f.validFrom, f.validTo, f.rate, f.source, ahora);
    });
    cargar();
  }

  const todas = db.prepare("SELECT currency, validFrom, validTo, rate, source FROM sabnez_finance_ExchangeRates").all();
  const faltantes = missingRateDates({ rates: todas, from: desde, to: hoy });
  db.close();

  console.log(`${nuevas.length} tasa(s) nueva(s) de ${traidas.length} consultada(s).`);
  if (traidas[0]) console.log(`Más reciente: ${traidas[0].validFrom} a ${traidas[0].rate}.`);
  if (faltantes.length)
    console.log(`Quedan ${faltantes.length} día(s) hábiles sin TRM en los últimos ${dias} días.`);
})();
