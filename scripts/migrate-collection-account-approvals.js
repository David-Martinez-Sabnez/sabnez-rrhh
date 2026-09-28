/**
 * Registra en la base de datos la configuración de aprobación de las cuentas
 * de cobro: los dos procesos, sus etapas y el pool de RR. HH.
 *
 *   node scripts/migrate-collection-account-approvals.js
 *
 * Los procesos y las etapas también están en db/data/*.csv, así que un
 * despliegue desde cero los carga solo. El pool NO se siembra por CSV a
 * propósito: apunta a empleados concretos y el seed no crea empleados, así que
 * un CSV rompería el despliegue por clave foránea. Por eso la pertenencia al
 * pool se resuelve aquí, contra los correos corporativos.
 *
 * Es idempotente: correrlo varias veces no duplica nada.
 *
 * Sin este paso sobre una base que ya tenía datos, `submitAccount` falla con
 * APPROVAL_PROCESS_NOT_CONFIGURED porque no encuentra el proceso.
 */

"use strict";

const cds = require("@sap/cds");

const PROCESOS = [
  {
    ID: "a1100000-0000-4000-8000-000000000002",
    codigo: "COLLECTION_ACCOUNT",
    descripcion: "Aprobación de cuentas de cobro de prestadores de servicios",
    horasVencimiento: 72,
    etapa: { ID: "a1200000-0000-4000-8000-000000000002", nombre: "Autorización de RR. HH." },
  },
  {
    ID: "a1100000-0000-4000-8000-000000000003",
    codigo: "COLLECTION_ACCOUNT_CORRECTION",
    descripcion: "Solicitudes de corrección de cuentas de cobro",
    horasVencimiento: 48,
    etapa: { ID: "a1200000-0000-4000-8000-000000000003", nombre: "Revisión de corrección por RR. HH." },
  },
];

// Quiénes reciben las tareas de cuentas de cobro. Se resuelven por correo para
// no depender de IDs de empleado, que cambian entre entornos.
const POOL = ["camila.sabogal@sabnez.com", "david.martinez@sabnez.com"];

const PROCESOS_ENTIDAD = "sabnez.approvals.ApprovalProcessDefinitions";
const ETAPAS_ENTIDAD = "sabnez.approvals.ApprovalStages";
const POOL_ENTIDAD = "sabnez.approvals.ApprovalRolePools";
const EMPLEADOS_ENTIDAD = "sabnez.rrhh.Empleados";

async function main() {
  // El modelo debe cargarse antes de consultar entidades por nombre.
  cds.model = await cds.load("*");
  await cds.connect.to("db");
  const { SELECT, INSERT } = cds.ql;

  let creados = 0;

  for (const proceso of PROCESOS) {
    const existente = await SELECT.one
      .from(PROCESOS_ENTIDAD)
      .where({ codigo: proceso.codigo, version: 1 });

    if (existente) {
      console.log(`· El proceso ${proceso.codigo} ya existe.`);
    } else {
      await INSERT.into(PROCESOS_ENTIDAD).entries({
        ID: proceso.ID,
        codigo: proceso.codigo,
        version: 1,
        dominio: "RRHH",
        descripcion: proceso.descripcion,
        activo: true,
        horasVencimiento: proceso.horasVencimiento,
        rutaOrigen: "CuentasCobro-display",
      });
      console.log(`✓ Proceso ${proceso.codigo} creado.`);
      creados += 1;
    }

    const procesoID = existente?.ID || proceso.ID;
    const etapa = await SELECT.one
      .from(ETAPAS_ENTIDAD)
      .where({ proceso_ID: procesoID, secuencia: 1 });

    if (etapa) {
      console.log(`· La etapa 1 de ${proceso.codigo} ya existe (resolver ${etapa.resolver}).`);
    } else {
      await INSERT.into(ETAPAS_ENTIDAD).entries({
        ID: proceso.etapa.ID,
        proceso_ID: procesoID,
        secuencia: 1,
        nombre: proceso.etapa.nombre,
        resolver: "ROLE_POOL",
        rolRequerido: "CollectionAccountHR",
      });
      console.log(`✓ Etapa 1 de ${proceso.codigo} creada.`);
      creados += 1;
    }
  }

  for (const correo of POOL) {
    const empleado = await SELECT.one
      .from(EMPLEADOS_ENTIDAD)
      .columns("ID", "nombreCompleto")
      .where({ correoCorporativo: correo });

    if (!empleado) {
      console.warn(`! No existe un empleado con el correo ${correo}: se omite del pool.`);
      continue;
    }

    for (const proceso of PROCESOS) {
      const miembro = await SELECT.one
        .from(POOL_ENTIDAD)
        .where({ processCode: proceso.codigo, empleado_ID: empleado.ID });

      if (miembro) {
        console.log(`· ${empleado.nombreCompleto} ya está en el pool de ${proceso.codigo}.`);
        continue;
      }

      await INSERT.into(POOL_ENTIDAD).entries({
        ID: cds.utils.uuid(),
        processCode: proceso.codigo,
        empleado_ID: empleado.ID,
        activo: true,
      });
      console.log(`✓ ${empleado.nombreCompleto} agregado al pool de ${proceso.codigo}.`);
      creados += 1;
    }
  }

  console.log(
    creados
      ? `\nListo: ${creados} registro(s) creados.`
      : "\nListo: la configuración ya estaba completa, no se creó nada.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("La migración falló:", error.message);
    process.exit(1);
  });
