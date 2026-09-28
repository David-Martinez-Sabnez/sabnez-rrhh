"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const JSZip = require("jszip");

const {
  buildAccountingZip,
  buildAccountingEmail,
  _internal: { safeName, extensionDe },
} = require("../srv/lib/accounting-dispatch");

const PDF = Buffer.from("%PDF-1.4 cuenta de cobro firmada");
const SOPORTE = Buffer.from("%PDF-1.4 comprobante PILA");

function cuenta(overrides = {}) {
  return {
    ID: "cta-1",
    numero: "CC-202608-AAAA1111",
    employeeNameSnapshot: "David Martínez",
    documentTypeSnapshot: "CC",
    documentNumberSnapshot: "1.020.345.678",
    periodStart: "2026-07-20",
    periodEnd: "2026-08-19",
    grossAmount: 5000000,
    currency: "COP",
    bankNameSnapshot: "Bancolombia",
    bankAccountTypeSnapshot: "AHORROS",
    bankAccountNumberSnapshot: "123456",
    bankHolderSnapshot: "David Martínez",
    socialSecurityRequirement: "PILA",
    signedAt: "2026-09-07T17:45:00.000Z",
    hrReviewedAt: "2026-09-08T14:00:00.000Z",
    generatedFileName: "CC-202608-AAAA1111.pdf",
    generatedContent: PDF,
    socialSecurityFileName: "pila-agosto.pdf",
    socialSecurityMimeType: "application/pdf",
    socialSecurityContent: SOPORTE,
    ...overrides,
  };
}

test("arma un ZIP con una carpeta por prestador y su resumen", async () => {
  const { buffer, incluidos, omitidos } = await buildAccountingZip([
    cuenta(),
    cuenta({ ID: "cta-2", numero: "CC-202608-BBBB2222", employeeNameSnapshot: "Ana Torres", grossAmount: 3200000 }),
  ]);

  assert.equal(incluidos.length, 2);
  assert.equal(omitidos.length, 0);

  const zip = await JSZip.loadAsync(buffer);
  const archivos = Object.keys(zip.files).filter((nombre) => !zip.files[nombre].dir).sort();

  assert.ok(archivos.includes("resumen.csv"), "el ZIP debe traer el CSV de control");
  assert.equal(
    archivos.filter((nombre) => nombre.endsWith(".pdf")).length,
    4,
    "dos prestadores aportan dos PDF cada uno",
  );
  assert.ok(
    archivos.some((nombre) => nombre.startsWith("David Martinez - CC-202608-AAAA1111/")),
    "cada prestador va en su propia carpeta",
  );

  // El contenido del PDF llega intacto, no re-codificado.
  const nombrePdf = archivos.find((nombre) => nombre.endsWith("CC-202608-AAAA1111.pdf"));
  const contenido = await zip.file(nombrePdf).async("nodebuffer");
  assert.equal(contenido.toString(), PDF.toString());

  const csv = await zip.file("resumen.csv").async("string");
  assert.match(csv, /CC-202608-AAAA1111/);
  assert.match(csv, /CC-202608-BBBB2222/);
  assert.match(csv, /Comprobante PILA/);
});

test("deja fuera del paquete las cuentas con expediente incompleto", async () => {
  const { incluidos, omitidos } = await buildAccountingZip([
    cuenta(),
    cuenta({ ID: "cta-3", numero: "CC-SIN-SOPORTE", socialSecurityContent: null }),
    cuenta({ ID: "cta-4", numero: "CC-SIN-PDF", generatedContent: null }),
  ]);

  assert.equal(incluidos.length, 1);
  assert.equal(omitidos.length, 2);
  assert.match(omitidos.find((row) => row.numero === "CC-SIN-SOPORTE").motivo, /soporte de seguridad social/i);
  assert.match(omitidos.find((row) => row.numero === "CC-SIN-PDF").motivo, /documento firmado/i);
});

test("acepta el contenido como stream, que es como lo devuelve la base", async () => {
  const { Readable } = require("node:stream");
  const { incluidos, omitidos } = await buildAccountingZip([
    cuenta({ generatedContent: Readable.from([PDF]), socialSecurityContent: Readable.from([SOPORTE]) }),
  ]);
  assert.equal(incluidos.length, 1, "un LargeBinary llega como stream y debe materializarse");
  assert.equal(omitidos.length, 0);
});

test("el correo a contabilidad resume el lote sin abrir el ZIP", () => {
  const { subject, html } = buildAccountingEmail({
    cuentas: [cuenta(), cuenta({ numero: "CC-202608-BBBB2222", employeeNameSnapshot: "Ana Torres", grossAmount: 3200000 })],
    periodo: "20 de julio de 2026 al 19 de agosto de 2026",
    remitente: "camila.sabogal@sabnez.com",
    total: 8200000,
    currency: "COP",
  });

  assert.match(subject, /2 prestador/);
  assert.match(html, /SABNEZ<\/span> <span[^>]*>CONSULTING/);
  assert.match(html, /David Martínez/);
  assert.match(html, /Ana Torres/);
  assert.match(html, /8\.200\.000/, "el total del lote va en el cuerpo");
  assert.match(html, /camila\.sabogal@sabnez\.com/, "queda registrado quién lo envió");
});

test("normaliza nombres de archivo y extensiones", () => {
  // Los nombres van a un ZIP que se abre en Windows: sin acentos ni barras.
  assert.equal(safeName("David Martínez - CC/202608"), "David Martinez - CC202608");
  assert.equal(safeName(""), "documento");
  assert.equal(extensionDe("pila.PDF", null), ".pdf");
  assert.equal(extensionDe("soporte", "image/jpeg"), ".jpg");
  assert.equal(extensionDe(null, "application/pdf"), ".pdf");
  assert.equal(extensionDe(null, "algo/raro"), ".bin");
});
