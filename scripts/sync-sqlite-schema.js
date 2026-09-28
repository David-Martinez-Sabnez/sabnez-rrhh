/**
 * Pone la base local al día con el modelo CDS sin borrar datos.
 *
 *   npm run migrate:sqlite
 *
 * `npm run reset:sqlite` también sincroniza, pero recreando la base: se
 * lleva por delante todo lo que no esté en los CSV de carga —proyectos,
 * asignaciones, tiempos—. Esto hace lo mínimo:
 *
 *   1. Añade a cada tabla las columnas que el modelo tiene y la base no.
 *   2. Rehace todas las vistas.
 *
 * El segundo paso es el que importa y el menos evidente: las
 * proyecciones de los servicios son vistas con la lista de columnas
 * fija, así que añadir una columna a la tabla base no basta — la vista
 * sigue sin verla y las consultas fallan con «no such column».
 *
 * Las vistas no guardan datos, así que rehacerlas es seguro.
 *
 * No cubre borrados ni cambios de tipo: para eso, reset.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { openDatabase } = require("./lib/open-sqlite");

const projectRoot = path.resolve(__dirname, "..");
const dbPath = path.join(projectRoot, "db.sqlite");

if (!fs.existsSync(dbPath)) {
  console.error("No existe db.sqlite. Corre primero `npm run deploy:sqlite`.");
  process.exit(1);
}

// --- 1. DDL que el modelo espera -------------------------------------
const cdsBin = path.join(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "cds.cmd" : "cds",
);
const compilacion = spawnSync(
  cdsBin,
  ["compile", "db", "srv", "--to", "sql", "--dialect", "sqlite"],
  { cwd: projectRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
if (compilacion.status !== 0) {
  console.error("No fue posible compilar el modelo:");
  console.error(compilacion.stderr || compilacion.stdout);
  process.exit(1);
}

const sentencias = compilacion.stdout
  .split(";\n")
  .map((s) => s.trim())
  .filter(Boolean);

const tablas = new Map(); // nombre -> columnas del modelo
const vistas = []; // en orden de dependencia

for (const sentencia of sentencias) {
  const tabla = /^CREATE TABLE\s+(\w+)\s*\(([\s\S]*)\)$/i.exec(sentencia);
  if (tabla) {
    // En el DDL de CAP las columnas van primero y las restricciones
    // después. Al llegar a la primera restricción se corta: sus líneas
    // de continuación (REFERENCES, DEFERRABLE) no son columnas.
    const columnas = [];
    for (const bruta of tabla[2].split("\n")) {
      const linea = bruta.trim().replace(/,$/, "");
      if (!linea) continue;
      if (/^(PRIMARY KEY|UNIQUE|FOREIGN KEY|CONSTRAINT|CHECK)\b/i.test(linea)) break;
      const nombre = linea.split(/\s+/)[0];
      if (nombre) columnas.push({ nombre, ddl: linea.slice(nombre.length).trim() });
    }
    tablas.set(tabla[1], columnas);
    continue;
  }
  const vista = /^CREATE VIEW\s+(\w+)\s/i.exec(sentencia);
  if (vista) vistas.push({ nombre: vista[1], sql: sentencia });
}

console.log(`Modelo: ${tablas.size} tablas, ${vistas.length} vistas.`);

// --- 2. copia de seguridad -------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backup = `${dbPath}.bak-${stamp}`;
fs.copyFileSync(dbPath, backup);
console.log(`Copia de seguridad: ${path.basename(backup)}`);

const db = openDatabase(dbPath);
db.pragma("foreign_keys = OFF");

let columnasAnadidas = 0;
let tablasNuevas = 0;

db.transaction(() => {
  // --- columnas que falten -------------------------------------------
  for (const [tabla, columnas] of tablas) {
    const existe = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(tabla);
    if (!existe) {
      // Tabla entera nueva: se crea vacía y lista.
      const original = sentencias.find((s) =>
        new RegExp(`^CREATE TABLE\\s+${tabla}\\s*\\(`, "i").test(s),
      );
      db.prepare(original).run();
      tablasNuevas += 1;
      console.log(`  tabla nueva  ${tabla}`);
      continue;
    }
    const actuales = new Set(
      db.prepare(`PRAGMA table_info(${tabla})`).all().map((r) => r.name),
    );
    for (const columna of columnas) {
      if (actuales.has(columna.nombre)) continue;
      // SQLite no admite DEFAULT no constante al añadir columna; el
      // resto del DDL (tipo y DEFAULT literal) sí se conserva.
      const ddl = columna.ddl.replace(/\bNOT NULL\b/i, "").trim();
      db.prepare(`ALTER TABLE ${tabla} ADD COLUMN ${columna.nombre} ${ddl}`).run();
      columnasAnadidas += 1;
      console.log(`  columna      ${tabla}.${columna.nombre}`);
    }
  }

  // --- vistas: fuera todas y de nuevo --------------------------------
  const existentes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='view'")
    .all()
    .map((r) => r.name);
  for (const nombre of existentes) db.prepare(`DROP VIEW IF EXISTS ${nombre}`).run();
  for (const vista of vistas) db.prepare(vista.sql).run();
  console.log(`  vistas       ${existentes.length} eliminadas, ${vistas.length} recreadas`);
})();

db.pragma("foreign_keys = ON");
db.close();

console.log(
  `\nListo. ${tablasNuevas} tabla(s) nueva(s), ${columnasAnadidas} columna(s) añadida(s).`,
);
