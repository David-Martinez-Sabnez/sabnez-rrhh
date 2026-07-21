const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const databaseFiles = ["db.sqlite", "db.sqlite-shm", "db.sqlite-wal"];

for (const file of databaseFiles) {
  const fullPath = path.join(projectRoot, file);
  if (fs.existsSync(fullPath)) fs.rmSync(fullPath, { force: true });
}

const executable = process.platform === "win32" ? "cds.cmd" : "cds";

const binary = path.join(projectRoot, "node_modules", ".bin", executable);

const result = spawnSync(binary, ["deploy", "--profile", "development"], {
  cwd: projectRoot,
  stdio: "inherit",
});

if (result.error) {
  console.error(`No fue posible ejecutar ${binary}:`, result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
