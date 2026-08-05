"use strict";

const cds = require("@sap/cds");
const { SELECT } = cds.ql;

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

function normalizeDays(value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    return DEFAULT_DAYS;
  }

  return Math.min(Math.max(parsed, 1), MAX_DAYS);
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

module.exports = {
  name: "expiringContracts",

  description:
    "Consulta contratos laborales que tienen fecha de finalización dentro de un número determinado de días.",

  intentExamples: [
    "contratos por vencer",
    "contratos proximos a vencer",
    "contratos que vencen",
    "contratos vencen",
    "que contratos vencen",
    "vencimiento de contratos",
    "contratos vencen este mes",
    "contratos vencen en",
  ],

  inputSchema: {
    type: "object",
    properties: {
      days: {
        type: "integer",
        description:
          "Cantidad de días futuros que deben revisarse para identificar contratos próximos a vencer.",
        minimum: 1,
        maximum: MAX_DAYS,
        default: DEFAULT_DAYS,
      },
      limit: {
        type: "integer",
        description: "Cantidad máxima de contratos que deben devolverse.",
        minimum: 1,
        maximum: 50,
        default: 20,
      },
    },
    additionalProperties: false,
  },

  requiredRoles: ["Editor", "Admin"],

  async execute({ args = {}, tx }) {
    if (!tx || typeof tx.run !== "function") {
      throw new TypeError(
        'La herramienta "expiringContracts" requiere una transacción CAP válida.',
      );
    }

    const days = normalizeDays(args.days);
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);

    const today = new Date();
    const startDate = toIsoDate(today);
    const endDate = toIsoDate(addDays(today, days));

    const Contratos =
      tx.model?.entities?.["sabnez.rrhh.Contratos"] ||
      cds.model?.entities?.["sabnez.rrhh.Contratos"];

    if (!Contratos) {
      throw new Error(
        'No fue posible resolver la entidad "sabnez.rrhh.Contratos".',
      );
    }

    const statement = SELECT.from(Contratos)
      .columns(
        "ID",
        "empleado_ID",
        "tipoContrato_codigo",
        "cargo_ID",
        "fechaInicio",
        "fechaFin",
        "vigente",
        {
          ref: ["empleado", "codigoInterno"],
          as: "empleadoCodigoInterno",
        },
        {
          ref: ["empleado", "nombreCompleto"],
          as: "empleadoNombreCompleto",
        },
        {
          ref: ["empleado", "correoCorporativo"],
          as: "empleadoCorreoCorporativo",
        },
        {
          ref: ["cargo", "nombre"],
          as: "cargoNombre",
        },
      )
      .where`
        fechaFin is not null
        and fechaFin >= ${startDate}
        and fechaFin <= ${endDate}
      `
      .orderBy("fechaFin")
      .limit(limit);

    const rows = await tx.run(statement);

    return {
      period: {
        from: startDate,
        to: endDate,
        days,
      },
      count: rows.length,
      contracts: rows.map((contract) => ({
        id: contract.ID,
        employeeId: contract.empleado_ID,
        employeeCode: contract.empleadoCodigoInterno || null,
        employeeName: contract.empleadoNombreCompleto || null,
        corporateEmail: contract.empleadoCorreoCorporativo || null,
        contractTypeCode: contract.tipoContrato_codigo || null,
        positionId: contract.cargo_ID || null,
        positionName: contract.cargoNombre || null,
        startDate: contract.fechaInicio || null,
        endDate: contract.fechaFin || null,
        active: Boolean(contract.vigente),
      })),
    };
  },
};
