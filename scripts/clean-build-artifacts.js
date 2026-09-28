"use strict";

const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const cleanAll = process.argv.includes("--all");
const targets = cleanAll
  ? ["resources", "mta_archives", "gen", ".sabnez-rrhh_mta_build_tmp", "_tmp_verify"]
  : ["gen"];

for (const target of targets) {
  fs.rmSync(path.join(projectRoot, target), {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

if (cleanAll) {
  const appRoot = path.join(projectRoot, "app");
  if (fs.existsSync(appRoot)) {
    for (const entry of fs.readdirSync(appRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const generated of ["dist", "node_modules"]) {
        fs.rmSync(path.join(appRoot, entry.name, generated), {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      }
    }
  }

  // Archivos creados por Finder; se excluye .git deliberadamente.
  for (const directory of [projectRoot, appRoot]) {
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") fs.rmSync(path.join(directory, entry.name), { force: true });
      if (directory === appRoot && entry.isDirectory()) {
        fs.rmSync(path.join(directory, entry.name, ".DS_Store"), { force: true });
      }
    }
  }
}
