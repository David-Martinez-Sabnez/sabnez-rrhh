/**
 * Añade a la base de datos local las columnas del objetivo facturable
 * sin borrar datos, que es lo que haría `npm run reset:sqlite`.
 *
 *   node scripts/migrate-billing-targets.js
 *
 * Es idempotente: se puede correr las veces que haga falta. En HANA esto
 * lo resuelve el despliegue del hdbtable; este script es sólo para los
 * entornos locales que ya tenían datos antes del cambio.
 */

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const projectRoot = path.resolve(__dirname, "..");
const dbPath = path.join(projectRoot, "db.sqlite");

if (!fs.existsSync(dbPath)) {
  console.error("No existe db.sqlite. Corre primero `npm run deploy:sqlite`.");
  process.exit(1);
}

// Copia de seguridad antes de tocar nada.
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backup = `${dbPath}.bak-${stamp}`;
fs.copyFileSync(dbPath, backup);
console.log(`Copia de seguridad: ${path.basename(backup)}`);

const db = new Database(dbPath);

const NO_FACTURAN = new Set([
  "Representante Legal",
  "Gerente General",
  "Auxiliar de servicios generales",
  "Contador",
]);

function addColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  if (columns.includes(column)) {
    console.log(`  ya existe  ${table}.${column}`);
    return false;
  }
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  console.log(`  añadida    ${table}.${column}`);
  return true;
}

db.transaction(() => {
  addColumn("sabnez_times_Projects", "monthlyBillableTarget", "DECIMAL(9, 2)");
  addColumn("sabnez_rrhh_Cargos", "facturablePorDefecto", "BOOLEAN DEFAULT TRUE");
  addColumn("sabnez_rrhh_Empleados", "facturable", "BOOLEAN");

  // Los cargos de estructura no generan ingreso facturable.
  const cargos = db.prepare("SELECT ID, nombre FROM sabnez_rrhh_Cargos").all();
  const setCargo = db.prepare(
    "UPDATE sabnez_rrhh_Cargos SET facturablePorDefecto = ? WHERE ID = ?",
  );
  for (const cargo of cargos) {
    setCargo.run(NO_FACTURAN.has(cargo.nombre) ? 0 : 1, cargo.ID);
  }

  // Cada empleado hereda de su cargo; quien ya tenga la marca puesta a
  // mano no se toca, que para eso es la excepción.
  db.prepare(`
    UPDATE sabnez_rrhh_Empleados
       SET facturable = COALESCE(
             (SELECT c.facturablePorDefecto
                FROM sabnez_rrhh_Cargos c
               WHERE c.ID = cargo_ID), 1)
     WHERE facturable IS NULL
  `).run();
})();

const recursos = db
  .prepare("SELECT count(*) AS n FROM sabnez_rrhh_Empleados WHERE facturable = 1")
  .get().n;
const total = db.prepare("SELECT count(*) AS n FROM sabnez_rrhh_Empleados").get().n;

console.log(`\nListo. ${recursos} de ${total} empleados quedan como recurso facturable.`);
console.log("Revisa las excepciones en la app de Empleados, bloque Laboral.");

db.close();
