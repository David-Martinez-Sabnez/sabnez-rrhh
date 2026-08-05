"use strict";

const searchEmployees = require("./search-employees");
const expiringContracts = require("./expiring-contracts");

module.exports = {
  id: "hr",
  name: "Recursos Humanos",
  version: "1.0.0",

  description:
    "Capacidades para consultar empleados, contratos, ausencias y beneficios laborales.",

  capabilities: [
    {
      id: "employee-search",
      name: "Búsqueda de empleados",
      description:
        "Busca empleados por nombre, código interno o correo corporativo.",
    },
    {
      id: "contract-expiration",
      name: "Vencimiento de contratos",
      description:
        "Consulta contratos laborales próximos a finalizar.",
    },
    {
      id: "hr-navigation",
      name: "Navegación de Recursos Humanos",
      description:
        "Permite abrir aplicaciones relacionadas con empleados, ausencias y aprobaciones.",
    },
  ],

  navigation: [
    {
      id: "employees",
      name: "Empleados",
      semanticObject: "Empleados",
      action: "display",
      aliases: [
        "empleados",
        "recursos humanos",
        "rrhh",
        "personal",
      ],
    },
    {
      id: "absences",
      name: "Ausencias",
      semanticObject: "Ausencias",
      action: "display",
      aliases: [
        "ausencias",
        "vacaciones",
        "permisos",
        "incapacidades",
      ],
    },
    {
      id: "approvals",
      name: "Aprobaciones",
      semanticObject: "Aprobaciones",
      action: "display",
      aliases: [
        "aprobaciones",
        "solicitudes pendientes",
        "pendientes de aprobar",
      ],
    },
  ],

  examples: [
    "Buscar empleados activos",
    "Muéstrame los contratos que vencen en 30 días",
    "Abrir empleados",
    "Llévame a ausencias",
  ],

  permissions: [
    "Editor",
    "Admin",
  ],

  tools: [
    searchEmployees,
    expiringContracts,
  ],
};
