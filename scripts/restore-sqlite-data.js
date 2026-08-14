const path = require("node:path");
const Database = require("better-sqlite3");

const projectRoot = path.resolve(__dirname, "..");

const currentDatabasePath = path.join(projectRoot, "db.sqlite");
const backupDatabasePath = path.join(
  projectRoot,
  "db.sqlite.backup-20260806"
);

const db = new Database(currentDatabasePath);

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

try {
  db.pragma("foreign_keys = OFF");

  db.exec(`
    ATTACH DATABASE '${backupDatabasePath.replaceAll("'", "''")}'
    AS backup
  `);

  const currentTables = db
    .prepare(`
      SELECT name
      FROM main.sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
    `)
    .all()
    .map((row) => row.name);

  const backupTables = new Set(
    db
      .prepare(`
        SELECT name
        FROM backup.sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
      `)
      .all()
      .map((row) => row.name)
  );

  const commonTables = currentTables.filter((table) =>
    backupTables.has(table)
  );

  const restore = db.transaction(() => {
    for (const table of commonTables) {
      const currentColumns = db
        .prepare(`PRAGMA main.table_info(${quoteIdentifier(table)})`)
        .all()
        .map((column) => column.name);

      const backupColumns = new Set(
        db
          .prepare(`PRAGMA backup.table_info(${quoteIdentifier(table)})`)
          .all()
          .map((column) => column.name)
      );

      const commonColumns = currentColumns.filter((column) =>
        backupColumns.has(column)
      );

      if (commonColumns.length === 0) {
        console.log(`⏭️  Sin columnas compatibles: ${table}`);
        continue;
      }

      const columnList = commonColumns
        .map(quoteIdentifier)
        .join(", ");

      db.exec(`
        DELETE FROM main.${quoteIdentifier(table)};

        INSERT INTO main.${quoteIdentifier(table)}
          (${columnList})
        SELECT
          ${columnList}
        FROM backup.${quoteIdentifier(table)};
      `);

      const count = db
        .prepare(
          `SELECT COUNT(*) AS total
           FROM main.${quoteIdentifier(table)}`
        )
        .get().total;

      console.log(`✅ ${table}: ${count} registros restaurados`);
    }
  });

  restore();

  db.exec("DETACH DATABASE backup");
  db.pragma("foreign_keys = ON");

  const integrity = db.pragma("foreign_key_check");

  if (integrity.length > 0) {
    console.warn(
      "⚠️ Restauración terminada con referencias pendientes:",
      integrity
    );
  } else {
    console.log("✅ Restauración terminada correctamente");
  }
} catch (error) {
  console.error("❌ No fue posible restaurar la información:");
  console.error(error);
  process.exitCode = 1;
} finally {
  db.close();
}