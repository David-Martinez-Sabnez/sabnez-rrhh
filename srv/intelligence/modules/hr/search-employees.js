"use strict";

const cds = require("@sap/cds");
const { SELECT } = cds.ql;

function normalizeLimit(value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    return 10;
  }

  return Math.min(Math.max(parsed, 1), 20);
}

module.exports = {
  name: "searchEmployees",

  description:
    "Busca empleados por nombre completo, código interno o correo corporativo.",

  intentExamples: [
    "buscar empleado",
    "buscar empleados",
    "consultar empleado",
    "consultar empleados",
    "mostrar empleados",
    "listar empleados",
    "empleados activos",
  ],

  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Texto opcional para buscar por nombre, código interno o correo corporativo.",
      },
      activeOnly: {
        type: "boolean",
        description:
          "Cuando es verdadero, excluye empleados que tengan fecha de retiro.",
        default: true,
      },
      limit: {
        type: "integer",
        description: "Cantidad máxima de empleados que deben devolverse.",
        minimum: 1,
        maximum: 20,
        default: 10,
      },
    },
    additionalProperties: false,
  },

  requiredRoles: ["Editor", "Admin"],

  async execute({ args = {}, tx }) {
    if (!tx || typeof tx.run !== "function") {
      throw new TypeError(
        'La herramienta "searchEmployees" requiere una transacción CAP válida.',
      );
    }

    const queryText =
      typeof args.query === "string" ? args.query.trim().toLowerCase() : "";

    const activeOnly = args.activeOnly !== false;
    const limit = normalizeLimit(args.limit);

    const Empleados =
      tx.model?.entities?.["sabnez.rrhh.Empleados"] ||
      cds.model?.entities?.["sabnez.rrhh.Empleados"];

    if (!Empleados) {
      throw new Error(
        'No fue posible resolver la entidad "sabnez.rrhh.Empleados".',
      );
    }

    let statement = SELECT.from(Empleados)
      .columns(
        "ID",
        "codigoInterno",
        "nombreCompleto",
        "correoCorporativo",
        "fechaIngreso",
        "fechaRetiro",
        "cargo_ID",
        "estado_codigo",
      )
      .orderBy("nombreCompleto")
      .limit(limit);

    if (queryText) {
      const pattern = `%${queryText}%`;

      statement = statement.where`
        lower(nombreCompleto) like ${pattern}
        or lower(codigoInterno) like ${pattern}
        or lower(correoCorporativo) like ${pattern}
      `;
    }

    if (activeOnly) {
      statement = queryText
        ? statement.and`fechaRetiro is null`
        : statement.where`fechaRetiro is null`;
    }

    const rows = await tx.run(statement);

    return {
      count: rows.length,
      employees: rows.map((employee) => ({
        id: employee.ID,
        internalCode: employee.codigoInterno,
        fullName: employee.nombreCompleto,
        corporateEmail: employee.correoCorporativo || null,
        entryDate: employee.fechaIngreso || null,
        retirementDate: employee.fechaRetiro || null,
        positionId: employee.cargo_ID || null,
        statusCode: employee.estado_codigo || null,
      })),
    };
  },
};
