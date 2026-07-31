"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("la UI de empleados y CAP comparten la ruta de carga de foto", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(root, "app/empleadosui/webapp/manifest.json"),
      "utf8",
    ),
  );
  const approuter = JSON.parse(
    fs.readFileSync(path.join(root, "app/empleadosui/xs-app.json"), "utf8"),
  );
  const service = fs.readFileSync(
    path.join(root, "srv/admin-service.cds"),
    "utf8",
  );
  const annotations = fs.readFileSync(
    path.join(root, "srv/admin-annotations.cds"),
    "utf8",
  );
  const handler = fs.readFileSync(
    path.join(root, "srv/admin-service.js"),
    "utf8",
  );

  assert.equal(manifest["sap.app"].dataSources.mainService.uri, "/admin/");
  assert.match(service, /path\s*:\s*'\/admin'/);
  assert.ok(
    approuter.routes.some(
      ({ source, target }) =>
        source === "^/admin/(.*)$" && target === "/admin/$1",
    ),
  );
  assert.match(annotations, /Value:\s*foto_content/);
  assert.match(handler, /\/foto_content/);
  assert.match(handler, /this\.before\("PUT"/);
});
