"use strict";

const { createHash } = require("node:crypto");
const cds = require("@sap/cds");

const {
  delegationIsEffective,
  identityFromUser,
  normalizeIdentity,
  selectEffectiveAssignment,
  todayInColombia,
} = require("./approval-rules");

const { SELECT, INSERT, UPDATE } = cds.ql;
const LOG = cds.log("approval-orchestrator");

const PROCESS_CODES = Object.freeze({ ABSENCE: "ABSENCE" });
const DECISIONS = Object.freeze({ APPROVE: "APPROVE", REJECT: "REJECT" });
const DELEGATION_MODES = Object.freeze({
  BACKUP: "BACKUP",
  SUBSTITUTE: "SUBSTITUTE",
});
const ASSIGNMENT_TYPES = Object.freeze({
  PRIMARY: "PRIMARY",
  BACKUP: "BACKUP",
  DELEGATE: "DELEGATE",
  POOL: "POOL",
});

const adapters = new Map();

function registerApprovalAdapter(processCode, adapter) {
  const code = normalizeCode(processCode);
  if (!adapter || typeof adapter.applyDecision !== "function") {
    throw new TypeError(
      `El adaptador ${code} debe implementar applyDecision(context).`,
    );
  }

  // Reemplazar es intencional para soportar tests y hot reload.
  adapters.set(code, adapter);
  return adapter;
}

function getApprovalAdapter(processCode) {
  return adapters.get(normalizeCode(processCode));
}

async function startApproval(req, input = {}) {
  const tx = transactionFor(req);
  const entities = approvalEntities();
  const employees = employeeEntities();
  const normalized = normalizeStartInput(req, input);

  const existing = await tx.run(
    SELECT.one.from(entities.ApprovalInstances).where({
      idempotencyKey: normalized.idempotencyKey,
    }),
  );
  if (existing) {
    assertSameBusinessObject(existing, normalized);
    return loadStartResult(tx, entities, existing);
  }

  const process = await loadConfiguredProcess(
    tx,
    entities,
    normalized.processCode,
  );
  const stage = await tx.run(
    SELECT.one.from(entities.ApprovalStages).where({
      proceso_ID: process.ID,
      secuencia: 1,
    }),
  );
  if (!stage) {
    throw approvalError(
      503,
      "APPROVAL_STAGE_NOT_CONFIGURED",
      `El proceso ${process.codigo} no tiene una primera etapa configurada.`,
    );
  }

  const requester = await tx.run(
    SELECT.one
      .from(employees.Empleados)
      .columns(
        "ID",
        "nombreCompleto",
        "correoCorporativo",
        "jefeDirecto_ID",
        "estado_codigo",
      )
      .where({ ID: normalized.requesterEmployeeID }),
  );
  if (!requester) {
    throw approvalError(
      403,
      "APPROVAL_REQUESTER_NOT_FOUND",
      "El solicitante no está asociado a un empleado.",
    );
  }
  if (requester.estado_codigo !== "AC") {
    throw approvalError(
      403,
      "APPROVAL_REQUESTER_NOT_ACTIVE",
      "El solicitante no está activo.",
    );
  }
  await assertRequesterIdentity(tx, entities, requester, normalized.requesterUserID);

  const submittedAt = normalized.submittedAt || new Date().toISOString();
  const dueAt =
    normalized.dueAt || addHours(submittedAt, process.horasVencimiento || 72);
  const instanceID = cds.utils.uuid();

  const approverResolution = await resolveDirectManager({
    tx,
    entities,
    employees,
    requester,
  });
  const instanceState = approverResolution.approver
    ? "RUNNING"
    : "PENDING_ASSIGNMENT";

  try {
    await tx.run(
      INSERT.into(entities.ApprovalInstances).entries({
        ID: instanceID,
        proceso_ID: process.ID,
        processCode: process.codigo,
        processVersion: process.version,
        businessObjectType: normalized.businessObjectType,
        businessObjectID: normalized.businessObjectID,
        cycle: normalized.cycle,
        idempotencyKey: normalized.idempotencyKey,
        solicitante_ID: requester.ID,
        solicitanteUserID: normalized.requesterUserID,
        solicitanteNombre: requester.nombreCompleto,
        estado: instanceState,
        titulo: normalized.title,
        resumen: normalized.summary,
        prioridad: normalized.priority,
        currentStage: 1,
        submittedAt,
        dueAt,
        rutaOrigen: normalized.route,
      }),
    );
  } catch (error) {
    const duplicate = await tx.run(
      SELECT.one.from(entities.ApprovalInstances).where({
        idempotencyKey: normalized.idempotencyKey,
      }),
    );
    if (!duplicate) throw error;
    assertSameBusinessObject(duplicate, normalized);
    return loadStartResult(tx, entities, duplicate);
  }

  await insertFacts(tx, entities, instanceID, normalized.facts);

  let task = null;
  if (approverResolution.approver) {
    task = await createAssignedTask({
      tx,
      entities,
      instanceID,
      process,
      stage,
      approver: approverResolution.approver,
      approverUserID: approverResolution.userID,
      submittedAt,
      dueAt,
      idempotencyKey: normalized.idempotencyKey,
    });
  } else {
    task = await createUnassignedTask({
      tx,
      entities,
      instanceID,
      stage,
      dueAt,
    });
    await appendEvent(tx, entities, {
      instanceID,
      taskID: task.ID,
      type: "PENDING_ASSIGNMENT",
      actorUserID: normalized.requesterUserID,
      actorEmployeeID: requester.ID,
      detail: approverResolution.reason,
      idempotencyKey: deriveKey(normalized.idempotencyKey, "pending-assignment"),
    });
  }

  await appendEvent(tx, entities, {
    instanceID,
    taskID: task.ID,
    type: "APPROVAL_REQUESTED",
    actorUserID: normalized.requesterUserID,
    actorEmployeeID: requester.ID,
    detail: "Solicitud enviada al centro de aprobaciones.",
    idempotencyKey: deriveKey(normalized.idempotencyKey, "requested"),
  });

  const instance = await tx.run(
    SELECT.one.from(entities.ApprovalInstances).where({ ID: instanceID }),
  );
  return formatStartResult(instance, task, approverResolution, false);
}

async function cancelApproval(req, input = {}) {
  const tx = transactionFor(req);
  const entities = approvalEntities();
  const processCode = normalizeCode(input.processCode);
  const businessObjectType = requiredText(
    input.businessObjectType,
    "businessObjectType",
  );
  const businessObjectID = requiredText(
    input.businessObjectID,
    "businessObjectID",
  );
  const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey");
  const actorUserID = normalizeIdentity(
    input.actorUserID || identityFromUser(req?.user),
  );

  const priorEvent = await tx.run(
    SELECT.one.from(entities.ApprovalEvents).where({ idempotencyKey }),
  );
  if (priorEvent) {
    return { cancelled: true, instanceID: priorEvent.instancia_ID };
  }

  const instances = await tx.run(
    SELECT.from(entities.ApprovalInstances).where({
      processCode,
      businessObjectType,
      businessObjectID,
    }),
  );
  const instance = instances
    .filter((row) => ["RUNNING", "PENDING_ASSIGNMENT"].includes(row.estado))
    .sort((left, right) => right.cycle - left.cycle)[0];
  if (!instance) return { cancelled: false, instanceID: null };

  const now = new Date().toISOString();
  const changed = await tx.run(
    UPDATE(entities.ApprovalInstances)
      .set({ estado: "CANCELLED", completedAt: now })
      .where({ ID: instance.ID, estado: instance.estado }),
  );
  if (changed !== 1) {
    throw approvalError(
      409,
      "APPROVAL_CHANGED_CONCURRENTLY",
      "La aprobación cambió en otra sesión.",
    );
  }

  const tasks = await tx.run(
    SELECT.from(entities.ApprovalTasks).where({ instancia_ID: instance.ID }),
  );
  for (const task of tasks) {
    if (!["OPEN", "WAITING"].includes(task.estado)) continue;
    await tx.run(
      UPDATE(entities.ApprovalTasks)
        .set({
          estado: "CANCELLED",
          completedAt: now,
          version: task.version + 1,
        })
        .where({ ID: task.ID, estado: task.estado, version: task.version }),
    );
    await tx.run(
      UPDATE(entities.ApprovalTaskAssignments)
        .set({ estado: "COMPLETED" })
        .where({ tarea_ID: task.ID, estado: "ACTIVE" }),
    );
  }

  await appendEvent(tx, entities, {
    instanceID: instance.ID,
    type: "APPROVAL_CANCELLED",
    actorUserID,
    detail: safeText(input.reason, 1000),
    idempotencyKey,
  });

  return { cancelled: true, instanceID: instance.ID };
}

async function decideApproval(req, input = {}) {
  const tx = transactionFor(req);
  const entities = approvalEntities();
  const employees = employeeEntities();
  const taskID = requiredText(input.taskID || input.ID, "ID");
  const decision = normalizeCode(input.decision);
  const expectedVersion = Number(input.expectedVersion);
  const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey");
  const comment = safeText(input.comment ?? input.comentario, 1000);

  if (!Object.values(DECISIONS).includes(decision)) {
    throw approvalError(400, "APPROVAL_DECISION_INVALID", "Decisión inválida.");
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw approvalError(
      428,
      "APPROVAL_VERSION_REQUIRED",
      "Actualiza la tarea antes de decidirla.",
    );
  }
  if (decision === DECISIONS.REJECT && !comment) {
    throw approvalError(
      400,
      "APPROVAL_REJECTION_COMMENT_REQUIRED",
      "Debes indicar el motivo del rechazo.",
      "comentario",
    );
  }

  const duplicate = await tx.run(
    SELECT.one.from(entities.ApprovalDecisions).where({ idempotencyKey }),
  );
  if (duplicate) {
    if (duplicate.tarea_ID !== taskID || duplicate.decision !== decision) {
      throw approvalError(
        409,
        "APPROVAL_IDEMPOTENCY_KEY_REUSED",
        "La clave de idempotencia ya fue usada para otra decisión.",
      );
    }
    const replayIdentity = identityFromUser(req?.user);
    if (
      !replayIdentity ||
      replayIdentity !== normalizeIdentity(duplicate.actorUserID)
    ) {
      throw approvalError(
        403,
        "APPROVAL_IDEMPOTENT_REPLAY_FORBIDDEN",
        "Solo quien tomó la decisión puede repetir esta operación.",
      );
    }
    return loadDecisionResult(tx, entities, employees, duplicate);
  }

  const bundle = await loadTaskBundle(tx, entities, taskID);
  if (!bundle.task || !bundle.instance) {
    throw approvalError(404, "APPROVAL_TASK_NOT_FOUND", "La tarea no existe.");
  }
  if (bundle.task.estado !== "OPEN") {
    throw approvalError(
      409,
      "APPROVAL_TASK_NOT_OPEN",
      "La tarea ya no está pendiente.",
    );
  }
  if (bundle.task.version !== expectedVersion) {
    throw approvalError(
      412,
      "APPROVAL_ETAG_MISMATCH",
      "La tarea cambió. Actualiza la bandeja antes de decidir.",
    );
  }

  const actor = await authorizeTaskActor({
    req,
    tx,
    entities,
    employees,
    bundle,
  });
  if (bundle.instance.solicitante_ID === actor.employee.ID) {
    throw approvalError(
      403,
      "APPROVAL_SELF_DECISION_FORBIDDEN",
      "No puedes decidir una solicitud propia.",
    );
  }

  const reservedVersion = expectedVersion + 1;
  const reserved = await tx.run(
    UPDATE(entities.ApprovalTasks)
      .set({ estado: "PROCESSING", version: reservedVersion })
      .where({ ID: taskID, estado: "OPEN", version: expectedVersion }),
  );
  if (reserved !== 1) {
    throw approvalError(
      412,
      "APPROVAL_ETAG_MISMATCH",
      "Otra persona ya procesó o modificó la tarea.",
    );
  }

  const adapter = getApprovalAdapter(bundle.instance.processCode);
  if (!adapter) {
    throw approvalError(
      503,
      "APPROVAL_DOMAIN_ADAPTER_NOT_REGISTERED",
      `No está registrado el adaptador ${bundle.instance.processCode}.`,
    );
  }

  const actingForEmployeeID =
    actor.assignment.tipo === "PRIMARY"
      ? null
      : bundle.task.originalApprover_ID;
  const actingFor = actingForEmployeeID
    ? await tx.run(
        SELECT.one
          .from(employees.Empleados)
          .columns("ID", "nombreCompleto", "correoCorporativo")
          .where({ ID: actingForEmployeeID }),
      )
    : null;
  const context = {
    req,
    tx,
    processCode: bundle.instance.processCode,
    decision,
    comment,
    instance: bundle.instance,
    task: { ...bundle.task, version: reservedVersion },
    actor: {
      employeeID: actor.employee.ID,
      userID: actor.identity,
      name: actor.employee.nombreCompleto,
    },
    actingFor: actingFor
      ? {
          employeeID: actingFor.ID,
          userID: normalizeIdentity(actingFor.correoCorporativo),
          name: actingFor.nombreCompleto,
        }
      : null,
    businessObject: {
      type: bundle.instance.businessObjectType,
      id: bundle.instance.businessObjectID,
    },
  };

  if (typeof adapter.validateDecision === "function") {
    await adapter.validateDecision(context);
  }
  await adapter.applyDecision(context);

  const now = new Date().toISOString();
  const decisionID = cds.utils.uuid();
  await tx.run(
    INSERT.into(entities.ApprovalDecisions).entries({
      ID: decisionID,
      instancia_ID: bundle.instance.ID,
      tarea_ID: taskID,
      decision,
      actor_ID: actor.employee.ID,
      actorUserID: actor.identity,
      actingFor_ID: actingForEmployeeID,
      comentario: comment,
      idempotencyKey,
      decidedAt: now,
    }),
  );

  const finalTaskState = decision === DECISIONS.APPROVE ? "APPROVED" : "REJECTED";
  const finalInstanceState = finalTaskState;
  const finalVersion = reservedVersion + 1;
  await tx.run(
    UPDATE(entities.ApprovalTasks)
      .set({
        estado: finalTaskState,
        completedAt: now,
        version: finalVersion,
      })
      .where({ ID: taskID, estado: "PROCESSING", version: reservedVersion }),
  );
  await tx.run(
    UPDATE(entities.ApprovalTaskAssignments)
      .set({ estado: "COMPLETED" })
      .where({ tarea_ID: taskID, estado: "ACTIVE" }),
  );
  await tx.run(
    UPDATE(entities.ApprovalInstances)
      .set({ estado: finalInstanceState, completedAt: now })
      .where({ ID: bundle.instance.ID, estado: "RUNNING" }),
  );

  const eventID = await appendEvent(tx, entities, {
    instanceID: bundle.instance.ID,
    taskID,
    type: decision === DECISIONS.APPROVE ? "APPROVAL_APPROVED" : "APPROVAL_REJECTED",
    actorUserID: actor.identity,
    actorEmployeeID: actor.employee.ID,
    actingForEmployeeID,
    detail: comment,
    idempotencyKey: deriveKey(idempotencyKey, "event"),
  });
  await persistNotification(tx, entities, {
    eventID,
    type: "APPROVAL_DECIDED",
    instanceID: bundle.instance.ID,
    taskID,
    recipientID: bundle.instance.solicitanteUserID,
    processCode: bundle.instance.processCode,
    idempotencyKey: deriveKey(idempotencyKey, "notify-requester"),
  });

  const finalTask = await tx.run(
    SELECT.one.from(entities.ApprovalTasks).where({ ID: taskID }),
  );
  return {
    idempotent: false,
    decision,
    decisionID,
    task: finalTask,
    instance: { ...bundle.instance, estado: finalInstanceState, completedAt: now },
    actor,
    actingFor,
  };
}

async function getLatestDecision(req, input = {}) {
  const tx = transactionFor(req);
  const entities = approvalEntities();
  const employees = employeeEntities();
  const processCode = normalizeCode(input.processCode);
  const businessObjectType = requiredText(
    input.businessObjectType,
    "businessObjectType",
  );
  const IDs = Array.isArray(input.businessObjectIDs)
    ? input.businessObjectIDs.map(String)
    : [requiredText(input.businessObjectID, "businessObjectID")];

  const output = {};
  for (const businessObjectID of IDs) {
    const instances = await tx.run(
      SELECT.from(entities.ApprovalInstances).where({
        processCode,
        businessObjectType,
        businessObjectID,
      }),
    );
    const instance = instances.sort((a, b) => b.cycle - a.cycle)[0];
    if (!instance) {
      output[businessObjectID] = null;
      continue;
    }
    const decisions = await tx.run(
      SELECT.from(entities.ApprovalDecisions).where({
        instancia_ID: instance.ID,
      }),
    );
    const decision = decisions.sort((a, b) =>
      String(b.decidedAt).localeCompare(String(a.decidedAt)),
    )[0];
    if (!decision) {
      output[businessObjectID] = null;
      continue;
    }
    const [actor, actingFor] = await Promise.all([
      tx.run(
        SELECT.one
          .from(employees.Empleados)
          .columns("ID", "nombreCompleto")
          .where({ ID: decision.actor_ID }),
      ),
      decision.actingFor_ID
        ? tx.run(
            SELECT.one
              .from(employees.Empleados)
              .columns("ID", "nombreCompleto")
              .where({ ID: decision.actingFor_ID }),
          )
        : null,
    ]);
    output[businessObjectID] = {
      decision: decision.decision,
      comment: decision.comentario,
      actorName: actor?.nombreCompleto || decision.actorUserID,
      actorEmployeeID: decision.actor_ID,
      actingForName: actingFor?.nombreCompleto || null,
      decidedAt: decision.decidedAt,
    };
  }

  return Array.isArray(input.businessObjectIDs)
    ? output
    : output[IDs[0]];
}

async function createAssignedTask({
  tx,
  entities,
  instanceID,
  process,
  stage,
  approver,
  approverUserID,
  submittedAt,
  dueAt,
  idempotencyKey,
}) {
  const taskID = cds.utils.uuid();
  await tx.run(
    INSERT.into(entities.ApprovalTasks).entries({
      ID: taskID,
      instancia_ID: instanceID,
      etapa_ID: stage.ID,
      estado: "OPEN",
      originalApprover_ID: approver.ID,
      responsibleApprover_ID: approver.ID,
      responsibleUserID: approverUserID,
      dueAt,
      version: 1,
    }),
  );

  const assignments = [
    {
      ID: cds.utils.uuid(),
      tarea_ID: taskID,
      empleado_ID: approver.ID,
      approverUserID,
      tipo: "PRIMARY",
      estado: "ACTIVE",
      validaDesde: submittedAt.slice(0, 10),
    },
  ];

  const date = todayInColombia(new Date(submittedAt));
  const delegations = await tx.run(
    SELECT.from(entities.ApprovalDelegations).where({
      otorgante_ID: approver.ID,
      estado: "ACTIVE",
    }),
  );
  for (const delegation of delegations) {
    if (!delegationIsEffective(delegation, process.codigo, date)) continue;
    assignments.push({
      ID: cds.utils.uuid(),
      tarea_ID: taskID,
      empleado_ID: delegation.delegado_ID,
      approverUserID: delegation.delegadoUserID,
      tipo:
        delegation.modo === "SUBSTITUTE"
          ? ASSIGNMENT_TYPES.DELEGATE
          : ASSIGNMENT_TYPES.BACKUP,
      estado: "ACTIVE",
      validaDesde: delegation.fechaInicio,
      validaHasta: delegation.fechaFin,
      delegacion_ID: delegation.ID,
    });
  }
  await tx.run(INSERT.into(entities.ApprovalTaskAssignments).entries(assignments));

  await appendEvent(tx, entities, {
    instanceID,
    taskID,
    type: "APPROVAL_ASSIGNED",
    actorEmployeeID: approver.ID,
    detail: `Asignada a ${approver.nombreCompleto}.`,
    idempotencyKey: deriveKey(idempotencyKey, "assigned"),
  });

  const uniqueRecipients = new Set(
    assignments.map((assignment) => assignment.approverUserID),
  );
  for (const recipientID of uniqueRecipients) {
    await persistNotification(tx, entities, {
      type: "APPROVAL_ASSIGNED",
      instanceID,
      taskID,
      recipientID,
      processCode: process.codigo,
      idempotencyKey: deriveKey(idempotencyKey, `notify-${recipientID}`),
    });
  }

  return tx.run(SELECT.one.from(entities.ApprovalTasks).where({ ID: taskID }));
}

async function createUnassignedTask({ tx, entities, instanceID, stage, dueAt }) {
  const ID = cds.utils.uuid();
  await tx.run(
    INSERT.into(entities.ApprovalTasks).entries({
      ID,
      instancia_ID: instanceID,
      etapa_ID: stage.ID,
      estado: "WAITING",
      dueAt,
      version: 1,
    }),
  );
  return tx.run(SELECT.one.from(entities.ApprovalTasks).where({ ID }));
}

async function resolveDirectManager({ tx, entities, employees, requester }) {
  if (!requester.jefeDirecto_ID) {
    return { reason: "El empleado no tiene jefe directo configurado." };
  }
  if (requester.jefeDirecto_ID === requester.ID) {
    return { reason: "La relación de jefe directo genera autoaprobación." };
  }

  const approver = await tx.run(
    SELECT.one
      .from(employees.Empleados)
      .columns("ID", "nombreCompleto", "correoCorporativo", "estado_codigo")
      .where({ ID: requester.jefeDirecto_ID }),
  );
  if (!approver || approver.estado_codigo !== "AC") {
    return { reason: "El jefe directo no existe o no está activo." };
  }
  const userID = await resolveEmployeeUserID(tx, entities, approver);
  if (!userID) {
    return { reason: "El jefe directo no tiene una identidad aprobadora." };
  }
  return { approver, userID };
}

async function resolveEmployeeUserID(tx, entities, employee) {
  const identities = await tx.run(
    SELECT.from(entities.ApprovalIdentities).where({
      empleado_ID: employee.ID,
      activa: true,
    }),
  );
  const identity =
    identities.find((row) => row.principal) || identities[0] || null;
  return (
    normalizeIdentity(identity?.subjectNormalizado) ||
    normalizeIdentity(employee.correoCorporativo)
  );
}

async function assertRequesterIdentity(tx, entities, requester, identity) {
  if (!identity) {
    throw approvalError(
      403,
      "APPROVAL_REQUESTER_IDENTITY_MISSING",
      "No fue posible identificar al solicitante autenticado.",
    );
  }
  const identities = await tx.run(
    SELECT.from(entities.ApprovalIdentities).where({
      empleado_ID: requester.ID,
      activa: true,
    }),
  );
  const allowed = new Set([
    normalizeIdentity(requester.correoCorporativo),
    ...identities.map((row) => normalizeIdentity(row.subjectNormalizado)),
  ]);
  allowed.delete("");
  if (!allowed.has(identity)) {
    throw approvalError(
      403,
      "APPROVAL_REQUESTER_IDENTITY_MISMATCH",
      "La identidad autenticada no corresponde al solicitante.",
    );
  }
}

async function authorizeTaskActor({ req, tx, entities, employees, bundle }) {
  const identity = identityFromUser(req?.user);
  if (!identity) {
    throw approvalError(
      403,
      "APPROVAL_IDENTITY_MISSING",
      "No fue posible identificar al aprobador autenticado.",
    );
  }
  const date = todayInColombia();
  const effective = selectEffectiveAssignment({
    assignments: bundle.assignments,
    delegations: bundle.delegations,
    identity,
    processCode: bundle.instance.processCode,
    date,
  });
  if (!effective.assignment || !effective.canAct) {
    throw approvalError(
      403,
      "APPROVAL_TASK_NOT_ASSIGNED",
      "La tarea no está asignada a tu identidad o existe un sustituto activo.",
    );
  }

  const employee = await tx.run(
    SELECT.one
      .from(employees.Empleados)
      .columns("ID", "nombreCompleto", "correoCorporativo", "estado_codigo")
      .where({ ID: effective.assignment.empleado_ID }),
  );
  if (!employee || employee.estado_codigo !== "AC") {
    throw approvalError(
      403,
      "APPROVAL_ACTOR_NOT_ELIGIBLE",
      "El aprobador asignado no está activo.",
    );
  }
  const expectedIdentity = await resolveEmployeeUserID(tx, entities, employee);
  if (normalizeIdentity(expectedIdentity) !== identity) {
    throw approvalError(
      403,
      "APPROVAL_ACTOR_IDENTITY_MISMATCH",
      "La identidad autenticada no corresponde al empleado asignado.",
    );
  }

  if (bundle.stage?.rolRequerido && !req.user?.is(bundle.stage.rolRequerido)) {
    throw approvalError(
      403,
      "APPROVAL_REQUIRED_ROLE_MISSING",
      "No tienes el rol requerido para decidir esta tarea.",
    );
  }
  return { identity, assignment: effective.assignment, employee };
}

async function loadTaskBundle(tx, entities, taskID) {
  const task = await tx.run(
    SELECT.one.from(entities.ApprovalTasks).where({ ID: taskID }),
  );
  if (!task) return {};
  const [instance, stage, assignments, delegations] = await Promise.all([
    tx.run(
      SELECT.one.from(entities.ApprovalInstances).where({
        ID: task.instancia_ID,
      }),
    ),
    tx.run(
      SELECT.one.from(entities.ApprovalStages).where({ ID: task.etapa_ID }),
    ),
    tx.run(
      SELECT.from(entities.ApprovalTaskAssignments).where({ tarea_ID: taskID }),
    ),
    tx.run(
      SELECT.from(entities.ApprovalDelegations).where({ estado: "ACTIVE" }),
    ),
  ]);
  return { task, instance, stage, assignments, delegations };
}

async function loadConfiguredProcess(tx, entities, processCode) {
  const processes = await tx.run(
    SELECT.from(entities.ApprovalProcessDefinitions).where({
      codigo: processCode,
      activo: true,
    }),
  );
  const process = processes.sort((a, b) => b.version - a.version)[0];
  if (!process) {
    throw approvalError(
      503,
      "APPROVAL_PROCESS_NOT_CONFIGURED",
      `No existe una versión activa del proceso ${processCode}.`,
    );
  }
  return process;
}

async function insertFacts(tx, entities, instanceID, facts) {
  if (!facts.length) return;
  const rows = facts.map((fact, index) => ({
    ID: cds.utils.uuid(),
    instancia_ID: instanceID,
    seccion: safeText(fact.section ?? fact.seccion, 80) || "General",
    clave: requiredText(fact.key ?? fact.clave, `facts[${index}].key`),
    etiqueta: requiredText(
      fact.label ?? fact.etiqueta,
      `facts[${index}].label`,
    ),
    valor: safeText(fact.value ?? fact.valor, 1000),
    tipoDato: safeText(fact.dataType ?? fact.tipoDato, 20) || "TEXT",
    semanticColor: safeText(fact.semanticColor, 20),
    orden: Number.isInteger(fact.order ?? fact.orden)
      ? fact.order ?? fact.orden
      : index,
  }));
  await tx.run(INSERT.into(entities.ApprovalFacts).entries(rows));
}

async function appendEvent(tx, entities, input) {
  const existing = input.idempotencyKey
    ? await tx.run(
        SELECT.one.from(entities.ApprovalEvents).where({
          idempotencyKey: input.idempotencyKey,
        }),
      )
    : null;
  if (existing) return existing.ID;

  const ID = cds.utils.uuid();
  await tx.run(
    INSERT.into(entities.ApprovalEvents).entries({
      ID,
      instancia_ID: input.instanceID || null,
      tarea_ID: input.taskID || null,
      delegacion_ID: input.delegationID || null,
      tipo: input.type,
      actorUserID: normalizeIdentity(input.actorUserID) || null,
      actorEmpleado_ID: input.actorEmployeeID || null,
      actingFor_ID: input.actingForEmployeeID || null,
      detalle: safeText(input.detail, 1000),
      occurredAt: new Date().toISOString(),
      idempotencyKey: input.idempotencyKey || null,
    }),
  );
  return ID;
}

async function persistNotification(tx, entities, input) {
  if (!input.recipientID) return null;
  const existing = await tx.run(
    SELECT.one.from(entities.ApprovalNotificationOutbox).where({
      idempotencyKey: input.idempotencyKey,
    }),
  );
  if (existing) return existing.ID;

  const ID = input.eventID || cds.utils.uuid();
  const occurredAt = new Date().toISOString();
  await tx.run(
    INSERT.into(entities.ApprovalNotificationOutbox).entries({
      ID,
      instancia_ID: input.instanceID || null,
      tarea_ID: input.taskID || null,
      tipo: input.type,
      destinatarioID: normalizeIdentity(input.recipientID),
      processCode: input.processCode,
      estado: "PENDING",
      intentos: 0,
      disponibleDesde: occurredAt,
      idempotencyKey: input.idempotencyKey,
    }),
  );

  try {
    const service = await cds.connect.to("ApprovalService");
    await cds.queued(service).emit("ApprovalNotificationRequested", {
      eventID: ID,
      tipo: input.type,
      instanciaID: input.instanceID,
      tareaID: input.taskID,
      destinatarioID: normalizeIdentity(input.recipientID),
      processCode: input.processCode,
      occurredAt,
    });
  } catch (error) {
    // El registro durable queda PENDING para que un worker futuro lo retome.
    LOG.warn("No fue posible programar inmediatamente la notificación", {
      eventID: ID,
      message: error.message,
    });
  }
  return ID;
}

async function loadStartResult(tx, entities, instance) {
  const task = await tx.run(
    SELECT.one.from(entities.ApprovalTasks).where({
      instancia_ID: instance.ID,
    }),
  );
  return formatStartResult(instance, task, {
    approver: task?.responsibleApprover_ID
      ? { ID: task.responsibleApprover_ID }
      : null,
    userID: task?.responsibleUserID || null,
  }, true);
}

function formatStartResult(instance, task, resolution, idempotent) {
  return {
    instanceID: instance.ID,
    taskID: task?.ID || null,
    state: instance.estado,
    taskState: task?.estado || null,
    approverEmployeeID: resolution.approver?.ID || null,
    approverUserID: resolution.userID || null,
    idempotent: Boolean(idempotent),
  };
}

async function loadDecisionResult(tx, entities, employees, decision) {
  const [task, instance, actor, actingFor, assignments] = await Promise.all([
    tx.run(
      SELECT.one.from(entities.ApprovalTasks).where({ ID: decision.tarea_ID }),
    ),
    tx.run(
      SELECT.one.from(entities.ApprovalInstances).where({
        ID: decision.instancia_ID,
      }),
    ),
    tx.run(
      SELECT.one
        .from(employees.Empleados)
        .columns("ID", "nombreCompleto", "correoCorporativo", "estado_codigo")
        .where({ ID: decision.actor_ID }),
    ),
    decision.actingFor_ID
      ? tx.run(
          SELECT.one
            .from(employees.Empleados)
            .columns("ID", "nombreCompleto")
            .where({ ID: decision.actingFor_ID }),
        )
      : null,
    tx.run(
      SELECT.from(entities.ApprovalTaskAssignments).where({
        tarea_ID: decision.tarea_ID,
      }),
    ),
  ]);
  const assignment = assignments.find(
    (row) => row.empleado_ID === decision.actor_ID,
  );
  return {
    idempotent: true,
    decision: decision.decision,
    task,
    instance,
    actor: {
      identity: normalizeIdentity(decision.actorUserID),
      assignment: assignment || null,
      employee: actor || null,
    },
    actingFor: actingFor || null,
  };
}

function normalizeStartInput(req, input) {
  const processCode = normalizeCode(input.processCode || PROCESS_CODES.ABSENCE);
  const requesterUserID = normalizeIdentity(
    input.requesterUserID || identityFromUser(req?.user),
  );
  return {
    processCode,
    businessObjectType: requiredText(
      input.businessObjectType,
      "businessObjectType",
    ),
    businessObjectID: requiredText(input.businessObjectID, "businessObjectID"),
    requesterEmployeeID: requiredText(
      input.requesterEmployeeID,
      "requesterEmployeeID",
    ),
    requesterUserID,
    title: requiredText(input.title, "title", 200),
    summary: safeText(input.summary, 1000),
    priority: normalizeCode(input.priority || "MEDIUM"),
    route: safeText(input.route, 120),
    facts: Array.isArray(input.facts) ? input.facts : [],
    cycle: Number.isInteger(input.cycle) && input.cycle > 0 ? input.cycle : 1,
    idempotencyKey: requiredText(input.idempotencyKey, "idempotencyKey", 120),
    submittedAt: input.submittedAt || null,
    dueAt: input.dueAt || null,
  };
}

function assertSameBusinessObject(existing, input) {
  if (
    existing.processCode !== input.processCode ||
    existing.businessObjectType !== input.businessObjectType ||
    existing.businessObjectID !== input.businessObjectID
  ) {
    throw approvalError(
      409,
      "APPROVAL_IDEMPOTENCY_KEY_REUSED",
      "La clave de idempotencia ya pertenece a otra solicitud.",
    );
  }
}

function transactionFor(req) {
  return req ? cds.tx(req) : cds.db;
}

function approvalEntities() {
  const entities = cds.entities("sabnez.approvals");
  if (!entities?.ApprovalInstances) {
    throw new Error("El modelo sabnez.approvals no está cargado.");
  }
  return entities;
}

function employeeEntities() {
  const entities = cds.entities("sabnez.rrhh");
  if (!entities?.Empleados) {
    throw new Error("El modelo sabnez.rrhh no está cargado.");
  }
  return entities;
}

function normalizeCode(value) {
  return requiredText(value, "code").toUpperCase();
}

function requiredText(value, field, maxLength = 255) {
  const normalized = safeText(value, maxLength);
  if (!normalized) {
    throw approvalError(
      400,
      "APPROVAL_REQUIRED_FIELD",
      `El campo ${field} es obligatorio.`,
      field,
    );
  }
  return normalized;
}

function safeText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw approvalError(
      400,
      "APPROVAL_TEXT_TOO_LONG",
      `El texto supera el máximo de ${maxLength} caracteres.`,
    );
  }
  return normalized;
}

function approvalError(status, code, message, target) {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  error.code = code;
  if (target) error.target = target;
  return error;
}

function addHours(timestamp, hours) {
  return new Date(new Date(timestamp).getTime() + hours * 60 * 60 * 1000)
    .toISOString();
}

function deriveKey(base, suffix) {
  const candidate = `${base}:${suffix}`;
  if (candidate.length <= 120) return candidate;
  return `AP:${createHash("sha256").update(candidate).digest("hex")}`;
}

module.exports = {
  ASSIGNMENT_TYPES,
  DECISIONS,
  DELEGATION_MODES,
  PROCESS_CODES,
  cancelApproval,
  decideApproval,
  getApprovalAdapter,
  getLatestDecision,
  registerApprovalAdapter,
  startApproval,
  _internal: {
    appendEvent,
    approvalError,
    approvalEntities,
    authorizeTaskActor,
    deriveKey,
    employeeEntities,
    loadTaskBundle,
    persistNotification,
    resolveEmployeeUserID,
    transactionFor,
  },
  _test: {
    addHours,
    assertSameBusinessObject,
    deriveKey,
    normalizeStartInput,
    registerApprovalAdapter,
    safeText,
  },
};
