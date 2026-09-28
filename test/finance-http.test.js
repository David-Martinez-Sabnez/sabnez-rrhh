"use strict";

// Contrato HTTP del servicio financiero.
//
// Las demás pruebas llaman al servicio en proceso con `srv.send`, que se
// salta HTTP entero. Por eso no cazaron que `obtenerTableroFinanciero`
// estuviera declarado como `function` —GET, con los parámetros en la
// URL— mientras el navegador lo llamaba con POST y cuerpo JSON: la app
// arrancaba y el tablero devolvía 405 Method Not Allowed.
//
// Esta prueba habla el mismo protocolo que el navegador.

const test = require("node:test");
const assert = require("node:assert/strict");
const cds = require("@sap/cds");
const path = require("node:path");

// El perfil de pruebas es el que trae los usuarios simulados con rol
// financiero y la base en memoria. Se fija antes de levantar el servidor
// para que `npm test` funcione sin variables de entorno por delante.
process.env.CDS_ENV = process.env.CDS_ENV || "test";

// El servicio exige el rol financiero, así que las llamadas van
// autenticadas como el usuario simulado del perfil de pruebas. Sin esto
// todo responde 401 y la comprobación del método no prueba nada.
const app = cds.test(path.join(__dirname, ".."));
app.axios.defaults.auth = { username: "david.martinez@sabnez.com", password: "test" };
const { GET, POST } = app;

// La lista no se escribe a mano: se lee del propio modelo. Así, cuando
// se agregue una operación nueva, esta prueba la cubre sola en vez de
// quedarse mirando las viejas.
function operacionesDelServicio() {
  const srv = cds.model && cds.model.definitions
    ? cds.model.definitions["FinanceService"]
    : null;
  const acciones = (srv && srv.actions) || {};
  return Object.entries(acciones).map(([nombre, def]) => ({
    nombre,
    // En OData V4 una `function` va por GET con los parámetros en la URL
    // y una `action` por POST con cuerpo JSON. El front habla POST.
    esAccion: def.kind !== "function",
  }));
}

test("todas las operaciones del servicio aceptan POST con cuerpo JSON", async () => {
  // Se comprueba el protocolo, no el resultado. Un 400 o un 404 con
  // código de negocio significan que la operación existe, se enrutó bien
  // y validó sus datos. Un 405, o un 404 sin código propio, significan
  // que el navegador nunca va a poder llamarla.
  const operaciones = operacionesDelServicio();
  assert.ok(operaciones.length >= 9, `sólo se encontraron ${operaciones.length} operaciones`);

  const funciones = operaciones.filter((o) => !o.esAccion).map((o) => o.nombre);
  assert.deepEqual(
    funciones,
    [],
    `estas operaciones están declaradas como function y el front las llama con POST: ${funciones.join(", ")}`,
  );

  for (const { nombre } of operaciones) {
    let status;
    let cuerpo;
    try {
      const r = await POST(`/finanzas/${nombre}`, {});
      status = r.status;
      cuerpo = r.data;
    } catch (error) {
      status = error.response ? error.response.status : error.status;
      cuerpo = error.response ? error.response.data : null;
    }
    const codigo = cuerpo && cuerpo.error ? cuerpo.error.code : null;

    assert.notEqual(
      status,
      405,
      `${nombre} responde 405: está declarada como function y el front la llama con POST`,
    );
    if (status === 404)
      assert.ok(
        codigo && /^[A-Z_]+$/.test(String(codigo)),
        `${nombre} responde 404 sin código de negocio: la ruta no existe`,
      );
  }
});

test("el tablero responde a la misma llamada que hace el navegador", async () => {
  const { status, data } = await POST("/finanzas/obtenerTableroFinanciero", {
    desde: "2026-05-01",
    hasta: "2027-02-28",
  });
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.meses), "meses debe venir como lista");
  assert.ok(Array.isArray(data.cartera), "cartera debe venir como lista");
  assert.equal(data.cartera.length, 5, "los cinco tramos de antigüedad");
  assert.ok(Array.isArray(data.avisos));
  assert.equal(typeof data.disponibleCOP, "number");
});

test("las entidades del servicio se leen con los mismos $select del front", async () => {
  const rutas = [
    "/finanzas/Facturas?$select=ID,number,status,currency,total,netExpected,paidAmount,expectedPaymentDate&$expand=client($select=tradeName)",
    "/finanzas/Clientes?$select=ID,legalName,tradeName,countryCode,defaultCurrency,paymentTermDays,status",
    "/finanzas/Proyectos?$select=ID,code,name,modality,status",
    "/finanzas/PerfilRetenciones?$select=ID,client_ID,type,label,rate,base,minimumBase,validFrom,validTo,active",
    "/finanzas/TasasCambio?$select=ID,currency,validFrom,validTo,rate,source",
    "/finanzas/LineasFactura?$orderby=position",
    "/finanzas/RetencionesFactura",
    "/finanzas/Recaudos?$orderby=paymentDate",
  ];
  for (const ruta of rutas) {
    const { status } = await GET(ruta);
    assert.equal(status, 200, `falló ${ruta}`);
  }
});

test("el detalle de una factura se filtra por su UUID como lo hace el front", async () => {
  // El front arma `$filter=invoice_ID eq <uuid>` sin comillas, que es como
  // OData V4 espera un Edm.Guid. Si eso no se acepta, el detalle abre vacío.
  const uuid = "12345678-1234-1234-1234-123456789abc";
  for (const entidad of ["LineasFactura", "RetencionesFactura", "Recaudos"]) {
    const { status, data } = await GET(`/finanzas/${entidad}?$filter=invoice_ID eq ${uuid}`);
    assert.equal(status, 200, `falló el filtro por UUID en ${entidad}`);
    assert.ok(Array.isArray(data.value));
  }
});
