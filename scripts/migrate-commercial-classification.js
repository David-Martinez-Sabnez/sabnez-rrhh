"use strict";

/**
 * Reprocesa la clasificación comercial del histórico.
 *
 * Hasta ahora cada registro de tiempo nacía con tratamiento `PENDING` y
 * cero horas facturables, y nada lo volvía a tocar. Es decir: toda la
 * historia está sin clasificar. Sin este reproceso el dashboard arranca
 * en blanco y no hay contra qué comparar.
 *
 * Hace dos cosas:
 *   1. Le siembra la matriz de facturabilidad a los proyectos que no la
 *      tienen, según su modalidad.
 *   2. Recalcula cada registro con esa matriz.
 *
 * Lo que NO toca:
 *   - Registros ya facturados o anulados. Cambiarles la facturabilidad
 *     dejaría la factura emitida y el sistema contando cosas distintas.
 *   - Correcciones manuales. Si alguien marcó a mano que el cliente no
 *     aprobó ese sábado, esa decisión manda sobre cualquier regla.
 *
 * Uso:
 *   node scripts/migrate-commercial-classification.js [--dry]
 */

const path = require("node:path");
const crypto = require("node:crypto");
const { openDatabase } = require("./lib/open-sqlite");
const {
  seedRulesForProject,
  classifyEntry,
} = require("../srv/lib/commercial-classification");

const DRY = process.argv.includes("--dry");
const ESTADOS_CERRADOS = new Set(["INVOICED", "VOIDED"]);

const dbPath = path.resolve(__dirname, "..", "db.sqlite");
const db = openDatabase(dbPath);

const proyectos = db
  .prepare("SELECT ID, code, name, modality FROM sabnez_times_Projects")
  .all();

const reglasExistentes = db
  .prepare("SELECT * FROM sabnez_times_ProjectBillingRules")
  .all()
  .filter((r) => r.active !== 0 && r.active !== false);

console.log(
  `${proyectos.length} proyecto(s), ${reglasExistentes.length} regla(s) configurada(s).`,
);

// --- 1. sembrar las matrices que falten ---------------------------------

const porProyecto = new Map();
for (const r of reglasExistentes) {
  if (!porProyecto.has(r.project_ID)) porProyecto.set(r.project_ID, []);
  porProyecto.get(r.project_ID).push(r);
}

const ahora = new Date().toISOString();
const nuevas = [];
for (const proyecto of proyectos) {
  const yaEstan = new Set(
    (porProyecto.get(proyecto.ID) || []).map((r) => r.requestedType),
  );
  const faltantes = seedRulesForProject(proyecto).filter(
    (r) => !yaEstan.has(r.requestedType),
  );
  if (!faltantes.length) continue;
  console.log(
    `  matriz       ${proyecto.code || proyecto.ID} (${proyecto.modality}) +${faltantes.length}`,
  );
  for (const r of faltantes) {
    const fila = Object.assign({ ID: crypto.randomUUID() }, r);
    nuevas.push(fila);
    if (!porProyecto.has(proyecto.ID)) porProyecto.set(proyecto.ID, []);
    porProyecto.get(proyecto.ID).push(fila);
  }
}

if (nuevas.length && !DRY) {
  const insert = db.prepare(
    `INSERT INTO sabnez_times_ProjectBillingRules
       (ID, createdAt, createdBy, modifiedAt, modifiedBy, project_ID,
        requestedType, treatment, billableFactor, payableToEmployee, notes, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const cargar = db.transaction(() => {
    for (const r of nuevas)
      insert.run(
        r.ID,
        ahora,
        "migracion",
        ahora,
        "migracion",
        r.project_ID,
        r.requestedType,
        r.treatment,
        r.billableFactor,
        r.payableToEmployee ? 1 : 0,
        null,
        1,
      );
  });
  cargar();
}

// --- 2. reclasificar los registros --------------------------------------

const modalidades = new Map(proyectos.map((p) => [p.ID, p.modality]));

const registros = db
  .prepare(
    `SELECT e.ID, e.durationHours, e.requestedType, e.status,
            e.commercialTreatment, e.billableHours, e.payableHours,
            e.treatmentOverride, a.project_ID AS project_ID
       FROM sabnez_times_TimeEntries e
       JOIN sabnez_times_ProjectAssignments a ON a.ID = e.assignment_ID`,
  )
  .all();

const actualizar = db.prepare(
  `UPDATE sabnez_times_TimeEntries
      SET commercialTreatment = ?, billableHours = ?, payableHours = ?
    WHERE ID = ?`,
);

let cambiados = 0;
let intactos = 0;
let cerrados = 0;
let facturables = 0;
let porCompensar = 0;
const resumen = new Map();

const reclasificar = db.transaction(() => {
  for (const entry of registros) {
    if (ESTADOS_CERRADOS.has(entry.status)) {
      cerrados += 1;
      continue;
    }
    const r = classifyEntry({
      entry,
      project: {
        ID: entry.project_ID,
        modality: modalidades.get(entry.project_ID),
      },
      rules: porProyecto.get(entry.project_ID) || [],
    });

    facturables += r.billableHours;
    porCompensar += r.compensationGap;
    resumen.set(
      r.commercialTreatment,
      (resumen.get(r.commercialTreatment) || 0) + 1,
    );

    const igual =
      entry.commercialTreatment === r.commercialTreatment &&
      Number(entry.billableHours) === r.billableHours &&
      Number(entry.payableHours) === r.payableHours;
    if (igual) {
      intactos += 1;
      continue;
    }
    cambiados += 1;
    if (!DRY)
      actualizar.run(
        r.commercialTreatment,
        r.billableHours,
        r.payableHours,
        entry.ID,
      );
  }
});
reclasificar();

db.close();

console.log("");
console.log(`Registros:      ${registros.length}`);
console.log(`  reclasificados ${cambiados}`);
console.log(`  sin cambio     ${intactos}`);
console.log(`  intocables     ${cerrados} (ya facturados o anulados)`);
console.log("");
for (const [tratamiento, n] of [...resumen].sort((a, b) => b[1] - a[1]))
  console.log(`  ${tratamiento.padEnd(20)} ${n}`);
console.log("");
console.log(`Horas facturables:  ${Math.round(facturables * 100) / 100}`);
console.log(`Horas por compensar: ${Math.round(porCompensar * 100) / 100}`);
if (DRY) console.log("\n(--dry: no se escribió nada)");
