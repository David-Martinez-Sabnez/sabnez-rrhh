"use strict";

/**
 * Verificador estático de una app UI5 freestyle.
 *
 * Comprueba las tres cosas que `ui5 build` deja pasar y que en el
 * navegador se ven igual: una pantalla en blanco, sin un solo error en
 * consola.
 *
 *   1. Cada `press=` (y demás eventos) apunta a un método que existe.
 *   2. Cada formatter referenciado existe, sea del módulo formatter o
 *      un método del propio controller.
 *   3. Ninguna expresión usa == o != , que el parser de UI5 no admite.
 *   4. Cada target del manifest resuelve a una vista real.
 *
 * Uso: node scripts/verify-ui5-app.js app/finanzasui/webapp
 */

const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2];
if (!root) {
  console.error("Uso: node scripts/verify-ui5-app.js <ruta a webapp>");
  process.exit(2);
}

const problemas = [];
const leer = (d) => (fs.existsSync(d) ? fs.readdirSync(d).map((f) => path.join(d, f)) : []);

const vistas = [...leer(path.join(root, "view")), ...leer(path.join(root, "fragment"))]
  .filter((f) => f.endsWith(".xml"));
const controladores = leer(path.join(root, "controller")).filter((f) => f.endsWith(".js"));

// Métodos declarados en cada controller, con la indentación que usa el
// proyecto (cuatro espacios dentro del extend).
const metodos = {};
for (const c of controladores) {
  const src = fs.readFileSync(c, "utf8");
  const nombre = path.basename(c).replace(".controller.js", "").replace(".js", "");
  metodos[nombre] = new Set(
    [...src.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?function/gm)].map((m) => m[1]),
  );
}
const base = metodos.BaseController || new Set();
const todos = new Set([...base]);
for (const s of Object.values(metodos)) for (const m of s) todos.add(m);

const formatterPath = path.join(root, "model", "formatter.js");
const formatters = fs.existsSync(formatterPath)
  ? new Set(
      [...fs.readFileSync(formatterPath, "utf8").matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*:/gm)]
        .map((m) => m[1]),
    )
  : new Set();

const EVENTOS =
  /(?:press|change|itemPress|select|liveChange|selectionChange|search|close|browserEvent)="\.(\w+)"/g;

for (const vista of vistas) {
  const src = fs.readFileSync(vista, "utf8");
  const esVista = vista.includes(`${path.sep}view${path.sep}`);
  const nombre = path.basename(vista).replace(".view.xml", "").replace(".fragment.xml", "");
  // Un fragment lo puede abrir cualquier controller, así que su handler
  // vale si existe en alguno.
  const propios = esVista ? new Set([...(metodos[nombre] || []), ...base]) : todos;

  for (const m of src.matchAll(EVENTOS)) {
    if (!propios.has(m[1]))
      problemas.push(
        `${vista}: el handler .${m[1]} no existe${esVista ? ` en ${nombre}` : " en ningún controller"}`,
      );
  }

  for (const m of src.matchAll(/formatter:\s*'\.(\w+(?:\.\w+)?)'/g)) {
    const ref = m[1];
    if (ref.startsWith("formatter.")) {
      const fn = ref.slice("formatter.".length);
      if (!formatters.has(fn)) problemas.push(`${vista}: el formatter .formatter.${fn} no existe`);
    } else if (!propios.has(ref)) {
      problemas.push(
        `${vista}: el formatter .${ref} no existe${esVista ? ` en ${nombre}` : " en ningún controller"}`,
      );
    }
  }

  // UI5 no admite == ni != en expression binding: sólo === y !==.
  for (const m of src.matchAll(/\{=\s*(?:[^{}]|\$\{[^}]*\})*\}/g)) {
    if (/[^!=<>]==[^=]|[^!<>]!=[^=]/.test(m[0]))
      problemas.push(`${vista}: expresión con == o != (UI5 sólo admite === y !==): ${m[0].slice(0, 80)}`);
  }
}

const manifestPath = path.join(root, "manifest.json");
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const routing = ((manifest["sap.ui5"] || {}).routing) || {};
  for (const [nombre, t] of Object.entries(routing.targets || {})) {
    // En Fiori Elements el target no es una vista local sino un componente
    // (sap.fe.templates.ListReport / ObjectPage), que no vive en view/.
    if (t.type === "Component") continue;

    const vn = t.viewName || t.name;
    if (vn && !fs.existsSync(path.join(root, "view", `${vn}.view.xml`)))
      problemas.push(`manifest: el target ${nombre} apunta a view/${vn}.view.xml, que no existe`);
  }
  const declarados = new Set(Object.keys(routing.targets || {}));
  for (const ruta of routing.routes || [])
    for (const t of [].concat(ruta.target || []))
      if (!declarados.has(t))
        problemas.push(`manifest: la ruta ${ruta.name} apunta al target ${t}, que no está declarado`);
}

if (problemas.length) {
  console.log(problemas.join("\n"));
  process.exit(1);
}
console.log(
  `OK — ${vistas.length} vistas/fragments, ${formatters.size} formatters, ${todos.size} handlers.`,
);
