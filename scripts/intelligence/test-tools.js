"use strict";

const cds = require("@sap/cds");

const {
  initializeModules,
} = require("../../srv/intelligence/modules");

const {
  ToolExecutor,
} = require("../../srv/intelligence/tools/tool-executor");

async function main() {
  const csn = await cds.load("*");
  cds.model = cds.compile.for.nodejs(csn);

  const db = await cds.connect.to("db");
  const registry = initializeModules();
  const executor = new ToolExecutor({ registry });

  const user = {
    id: "david.martinez@sabnez.com",
    is(role) {
      return ["Editor", "Admin"].includes(role);
    },
  };

  const tx = db.tx();

  try {
    const employeesResult = await executor.execute({
      toolName: "searchEmployees",
      args: {
        activeOnly: true,
        limit: 5,
      },
      user,
      tx,
      context: {
        source: "local-test",
      },
    });

    console.log("\n=== EMPLEADOS ===");
    console.log(JSON.stringify(employeesResult, null, 2));

    const contractsResult = await executor.execute({
      toolName: "expiringContracts",
      args: {
        days: 365,
        limit: 10,
      },
      user,
      tx,
      context: {
        source: "local-test",
      },
    });

    console.log("\n=== CONTRATOS ===");
    console.log(JSON.stringify(contractsResult, null, 2));

    await tx.commit();
  } catch (error) {
    await tx.rollback();

    console.error("\nError:", {
      name: error.name,
      code: error.code,
      status: error.status,
      message: error.message,
      details: error.details,
      stack: error.stack,
    });

    process.exitCode = 1;
  }
}

main();
