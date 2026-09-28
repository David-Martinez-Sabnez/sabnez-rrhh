"use strict";

const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");

const ROOT = __dirname;
const VERSION = "1.5.1";
const SOURCE = path.join(ROOT, "src");
const BASE = path.join(ROOT, "package");
const TEMP = path.join(ROOT, ".build");
const RELEASE = path.join(ROOT, "releases", `Sabnez_Cards_WZ_v${VERSION}.zip`);

function json(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); }

function updateVersions(value) {
  if (!value || typeof value !== "object") return;
  if (value.version && typeof value.version === "string" &&
      (value === value.packageVersion || value === value.artifactVersion)) value.version = VERSION;
  for (const [key, child] of Object.entries(value)) {
    if (["packageVersion", "artifactVersion", "applicationVersion"].includes(key) && child)
      child.version = VERSION;
    updateVersions(child);
  }
}

async function addDirectory(zip, directory, prefix = "") {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const target = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) await addDirectory(zip, absolute, target);
    else zip.file(target, fs.readFileSync(absolute));
  }
}

async function zipDirectory(directory, output) {
  const zip = new JSZip();
  await addDirectory(zip, directory);
  fs.writeFileSync(output, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function main() {
  fs.rmSync(TEMP, { recursive: true, force: true });
  fs.cpSync(BASE, TEMP, { recursive: true });

  for (const artifactName of fs.readdirSync(SOURCE)) {
    const source = path.join(SOURCE, artifactName);
    if (!fs.statSync(source).isDirectory()) continue;
    const artifact = path.join(TEMP, "artifacts", artifactName);
    fs.mkdirSync(path.join(artifact, "i18n"), { recursive: true });

    const wrapper = json(path.join(source, "artifact-manifest.json"));
    updateVersions(wrapper);
    writeJson(path.join(artifact, "manifest.json"), wrapper);
    fs.cpSync(path.join(source, "i18n"), path.join(artifact, "i18n"), { recursive: true });

    const appDirs = fs.readdirSync(source).filter((name) => name.startsWith("com."));
    if (appDirs.length !== 1) throw new Error(`${artifactName}: se esperaba un directorio com.*`);
    const dataTemp = path.join(TEMP, `.data-${artifactName}`);
    fs.mkdirSync(dataTemp, { recursive: true });
    fs.cpSync(path.join(source, appDirs[0]), path.join(dataTemp, appDirs[0]), { recursive: true });
    const cardManifest = json(path.join(dataTemp, appDirs[0], "manifest.json"));
    updateVersions(cardManifest);
    writeJson(path.join(dataTemp, appDirs[0], "manifest.json"), cardManifest);
    await zipDirectory(dataTemp, path.join(artifact, "data.zip"));
    fs.rmSync(dataTemp, { recursive: true, force: true });
  }

  const manifestFile = path.join(TEMP, "manifest.json");
  const content = json(manifestFile);
  updateVersions(content);
  content["sap.package"].version = VERSION;

  const cardManifest = json(path.join(SOURCE, "cuentas-cobro-card", "com.sabnez.cards.cuentascobro", "manifest.json"));
  const artifactManifest = json(path.join(SOURCE, "cuentas-cobro-card", "artifact-manifest.json"));
  const packageData = content["sap.package"];
  if (!packageData.contents.some((row) => row.manifest["sap.artifact"].id === "com.sabnez.cards.cuentascobro")) {
    packageData.contents.push({ manifest: artifactManifest, baseURL: "artifacts/cuentas-cobro-card" });
  }
  if (!packageData.cdmEntities.some((row) => row.identification.id === "sbz.wz.cards.prestadores.role")) {
    packageData.cdmEntities.push({
      _version: "3.2.0",
      identification: {
        id: "sbz.wz.cards.prestadores.role",
        title: "Prestadores de servicios",
        entityType: "role"
      },
      payload: {
        apps: [{ id: "sbz.wz.cards.cuentascobro.app" }]
      },
      texts: [
        { locale: "", textDictionary: {} },
        { locale: "es", textDictionary: {} },
        { locale: "en", textDictionary: {} }
      ]
    });
  }
  if (!packageData.cdmEntities.some((row) => row.identification.id === "sbz.wz.cards.cuentascobro.app")) {
    packageData.cdmEntities.push({
      _version: "3.2.0",
      identification: {
        id: "sbz.wz.cards.cuentascobro.app",
        title: "Mis cuentas de cobro",
        entityType: "businessapp",
        description: "Periodos aprobados y cuentas en proceso"
      },
      payload: {
        visualizations: {
          "sbz.wz.cards.cuentascobro.app.viz": {
            vizType: "sap.card",
            vizConfig: cardManifest,
            vizResources: { artifactId: "com.sabnez.cards.cuentascobro" }
          }
        }
      },
      texts: [
        { locale: "", textDictionary: {} },
        { locale: "es", textDictionary: {} },
        { locale: "en", textDictionary: {} }
      ]
    });
  }
  writeJson(manifestFile, content);
  fs.writeFileSync(path.join(TEMP, "CAMBIOS-v1.5.1.txt"),
    "Versión 1.5.1\n\n- Mis proyectos actuales excluye proyectos internos.\n- Prioriza por dedicación comercial.\n- Muestra el próximo corte de tiempos y su urgencia.\n- Se conserva la card exclusiva de cuentas de cobro para prestadores.\n");
  fs.rmSync(path.join(TEMP, "CAMBIOS-v1.4.9.txt"), { force: true });
  await zipDirectory(TEMP, RELEASE);
  fs.rmSync(TEMP, { recursive: true, force: true });
  console.log(`Paquete generado: ${RELEASE}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
