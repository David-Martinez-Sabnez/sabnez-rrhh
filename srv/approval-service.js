"use strict";

const cds = require("@sap/cds");
const { streamToBuffer } = require("./lib/stream-utils");

const {
  ASSIGNMENT_TYPES,
  DECISIONS,
  DELEGATION_MODES,
  decideApproval,
  _internal: {
    appendEvent,
    approvalError,
    persistNotification,
    resolveEmployeeUserID,
  },
} = require("./lib/approval-orchestrator");
const {
  dateRangesOverlap,
  delegationIsEffective,
  identityFromUser,
  normalizeIdentity,
  scopesOverlap,
  selectEffectiveAssignment,
  todayInColombia,
} = require("./lib/approval-rules");

const { sendApprovalEmail } = require("./lib/approval-mailer");

const { SELECT, INSERT, UPDATE } = cds.ql;

module.exports = cds.service.impl(function () {
  const { EmpleadosElegibles, AusenciasAprobables } = this.entities;
  const SoportesAprobables = this.entities["AusenciasAprobables.soportes"];
  const approval = cds.entities("sabnez.approvals");
  const rrhh = cds.entities("sabnez.rrhh");
  const SoportesAusencia = rrhh["Ausencias.soportes"];

  this.before("READ", EmpleadosElegibles, async (req) => {
    const employee = await authenticatedEmployee(req, approval, rrhh);
    req.query.where({ ID: { "!=": employee.ID } });
  });

  if (AusenciasAprobables && SoportesAprobables && SoportesAusencia) {
    this.before("READ", AusenciasAprobables, async (req) => {
      const IDs = await authorizedAbsenceIDs(req, approval, rrhh);
      applyAuthorizedParentFilter(req, "ID", IDs);
    });

    this.before("READ", SoportesAprobables, async (req) => {
      const IDs = await authorizedAbsenceIDs(req, approval, rrhh);
      applyAuthorizedParentFilter(req, "up__ID", IDs);
    });

    this.before(
      ["CREATE", "UPDATE", "PATCH", "DELETE"],
      [AusenciasAprobables, SoportesAprobables],
      (req) => {
        reject(
          req,
          405,
          "APPROVAL_SUPPORT_READ_ONLY",
          "Los soportes solo pueden consultarse desde el centro de aprobaciones.",
        );
      },
    );

    // Los streams de @cap-js/attachments pueden llegar como PUT global sin
    // conservar el target de la composición. Se bloquean explícitamente.
    this.before("PUT", (req) => {
      if (!isApprovalSupportRequest(req)) return;
      reject(
        req,
        405,
        "APPROVAL_SUPPORT_READ_ONLY",
        "Los soportes solo pueden consultarse desde el centro de aprobaciones.",
      );
    });
  }

  this.on("obtenerMiResumen", async (req) => {
    const context = await inboxContext(req, approval, rrhh);
    const tasks = await visibleTasks(req, approval, rrhh, context);
    const now = new Date().toISOString();
    const delegations = await SELECT.from(approval.ApprovalDelegations).where({
      otorgante_ID: context.employee.ID,
    });

    return {
      pendientes: tasks.filter(
        (task) => task.estado === "OPEN" && task.puedeAprobar,
      ).length,
      vencidas: tasks.filter(
        (task) =>
          task.estado === "OPEN" &&
          task.puedeAprobar &&
          task.fechaVencimiento &&
          task.fechaVencimiento < now,
      ).length,
      comoBackup: tasks.filter(
        (task) =>
          task.estado === "OPEN" &&
          [ASSIGNMENT_TYPES.BACKUP, ASSIGNMENT_TYPES.DELEGATE].includes(
            task.tipoAsignacion,
          ),
      ).length,
      delegadasPorMi: delegations.filter(
        (delegation) =>
          effectiveDelegationState(delegation, context.today) === "ACTIVE",
      ).length,
      aprobadas: tasks.filter((task) => task.estado === "APPROVED").length,
      rechazadas: tasks.filter((task) => task.estado === "REJECTED").length,
    };
  });

  this.on("obtenerMisTareas", async (req) => {
    const context = await inboxContext(req, approval, rrhh);
    return visibleTasks(req, approval, rrhh, context);
  });

  this.on("obtenerDetalleTarea", async (req) => {
    const ID = required(req.data?.ID, "ID");
    const context = await inboxContext(req, approval, rrhh);
    const tasks = await visibleTasks(req, approval, rrhh, context, ID);
    const task = tasks.find((row) => row.ID === ID);
    if (!task) {
      reject(req, 404, "APPROVAL_TASK_NOT_FOUND", "La tarea no existe.");
    }

    const taskRow = await SELECT.one.from(approval.ApprovalTasks).where({ ID });
    const [facts, events, supportFacts] = await Promise.all([
      SELECT.from(approval.ApprovalFacts).where({
        instancia_ID: taskRow.instancia_ID,
      }),
      SELECT.from(approval.ApprovalEvents).where({
        instancia_ID: taskRow.instancia_ID,
      }),
      buildAbsenceSupportFacts(task, SoportesAusencia),
    ]);
    const employeeIDs = new Set();
    events.forEach((event) => {
      if (event.actorEmpleado_ID) employeeIDs.add(event.actorEmpleado_ID);
      if (event.actingFor_ID) employeeIDs.add(event.actingFor_ID);
    });
    const names = await employeeNames(rrhh, employeeIDs);

    return {
      tarea: task,
      hechos: [...facts, ...supportFacts]
        .sort((a, b) => a.orden - b.orden)
        .map((fact) => ({
          ID: fact.ID,
          seccion: fact.seccion,
          clave: fact.clave,
          etiqueta: fact.etiqueta,
          valor: fact.valor,
          enlace: fact.enlace || null,
          tipoDato: fact.tipoDato,
          semanticColor: fact.semanticColor,
          orden: fact.orden,
        })),
      eventos: events
        .sort((a, b) =>
          String(b.occurredAt).localeCompare(String(a.occurredAt)),
        )
        .map((event) => ({
          ID: event.ID,
          tipo: event.tipo,
          actorNombre:
            names.get(event.actorEmpleado_ID) || event.actorUserID || null,
          actuandoPorNombre: names.get(event.actingFor_ID) || null,
          detalle: event.detalle,
          fecha: event.occurredAt,
        })),
    };
  });

  this.on("obtenerMisDelegaciones", async (req) => {
    const context = await inboxContext(req, approval, rrhh);
    const rows = await SELECT.from(approval.ApprovalDelegations).where({
      otorgante_ID: context.employee.ID,
    });
    const delegateIDs = new Set(rows.map((row) => row.delegado_ID));
    const delegates = await eligibleEmployeesByID(rrhh, delegateIDs);
    return rows
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((row) =>
        mapDelegation(row, delegates.get(row.delegado_ID), context.today),
      );
  });

  this.on("aprobar", (req) => handleDecision(req, DECISIONS.APPROVE));
  this.on("rechazar", (req) => handleDecision(req, DECISIONS.REJECT));

  this.on("reenviar", async (req) => {
    const taskID = required(req.data?.ID, "ID");
    const delegateID = required(req.data?.delegadoID, "delegadoID");
    const expectedVersion = integerVersion(req.data?.expectedVersion);
    const idempotencyKey = required(req.data?.idempotencyKey, "idempotencyKey");
    const comment = clean(req.data?.comentario, 1000);
    const tx = cds.tx(req);

    const previousEvent = await tx.run(
      SELECT.one.from(approval.ApprovalEvents).where({ idempotencyKey }),
    );
    if (previousEvent) {
      if (previousEvent.tarea_ID !== taskID) {
        reject(
          req,
          409,
          "APPROVAL_IDEMPOTENCY_KEY_REUSED",
          "La clave de idempotencia ya fue utilizada.",
        );
      }
      return actionResult(
        req,
        approval,
        rrhh,
        taskID,
        "La tarea ya había sido reenviada.",
      );
    }

    const bundle = await taskBundle(tx, approval, taskID);
    if (!bundle.task || !bundle.instance) {
      reject(req, 404, "APPROVAL_TASK_NOT_FOUND", "La tarea no existe.");
    }
    const context = await inboxContext(req, approval, rrhh);
    const adminException =
      req.user?.is("ApprovalAdmin") && bundle.task.estado === "WAITING";
    let assignment = null;
    if (!adminException) {
      assignment = effectiveAssignment(bundle, context);
      if (
        !assignment.canAct ||
        assignment.assignment?.tipo !== ASSIGNMENT_TYPES.PRIMARY
      ) {
        reject(
          req,
          403,
          "APPROVAL_FORWARD_NOT_ALLOWED",
          "Solo el responsable principal puede reenviar la tarea.",
        );
      }
    }
    if (!["OPEN", "WAITING"].includes(bundle.task.estado)) {
      reject(
        req,
        409,
        "APPROVAL_TASK_NOT_OPEN",
        "La tarea ya no está pendiente.",
      );
    }
    if (bundle.task.version !== expectedVersion) {
      reject(
        req,
        412,
        "APPROVAL_ETAG_MISMATCH",
        "La tarea cambió. Actualiza la bandeja.",
      );
    }

    const delegate = await eligibleEmployee(tx, approval, rrhh, delegateID);
    if (
      delegate.ID === context.employee.ID ||
      delegate.ID === bundle.instance.solicitante_ID
    ) {
      reject(
        req,
        400,
        "APPROVAL_FORWARD_INVALID_DELEGATE",
        "No puedes reenviar la tarea a ti mismo ni al solicitante.",
      );
    }

    const reservedVersion = expectedVersion + 1;
    const reserved = await tx.run(
      UPDATE(approval.ApprovalTasks)
        .set({ estado: "PROCESSING", version: reservedVersion })
        .where({
          ID: taskID,
          estado: bundle.task.estado,
          version: expectedVersion,
        }),
    );
    if (reserved !== 1) {
      reject(
        req,
        412,
        "APPROVAL_ETAG_MISMATCH",
        "Otra persona modificó la tarea.",
      );
    }

    await tx.run(
      UPDATE(approval.ApprovalTaskAssignments)
        .set({ estado: "REVOKED" })
        .where({ tarea_ID: taskID, estado: "ACTIVE" }),
    );
    await tx.run(
      INSERT.into(approval.ApprovalTaskAssignments).entries({
        ID: cds.utils.uuid(),
        tarea_ID: taskID,
        empleado_ID: delegate.ID,
        approverUserID: delegate.userID,
        tipo: ASSIGNMENT_TYPES.DELEGATE,
        estado: "ACTIVE",
        validaDesde: context.today,
      }),
    );
    const finalVersion = reservedVersion + 1;
    await tx.run(
      UPDATE(approval.ApprovalTasks)
        .set({
          estado: "OPEN",
          responsibleApprover_ID: delegate.ID,
          responsibleUserID: delegate.userID,
          version: finalVersion,
        })
        .where({ ID: taskID, estado: "PROCESSING", version: reservedVersion }),
    );

    const eventID = await appendEvent(tx, approval, {
      instanceID: bundle.instance.ID,
      taskID,
      type: "APPROVAL_FORWARDED",
      actorUserID: context.identity,
      actorEmployeeID: context.employee.ID,
      actingForEmployeeID: bundle.task.originalApprover_ID,
      detail: comment || `Reenviada a ${delegate.nombreCompleto}.`,
      idempotencyKey,
    });
    await persistNotification(tx, approval, {
      eventID,
      type: "APPROVAL_FORWARDED",
      instanceID: bundle.instance.ID,
      taskID,
      recipientID: delegate.userID,
      processCode: bundle.instance.processCode,
      idempotencyKey: derivedKey(idempotencyKey, "notify"),
    });

    return actionResult(
      req,
      approval,
      rrhh,
      taskID,
      "La tarea fue reenviada correctamente.",
    );
  });

  this.on("guardarDelegacion", async (req) => {
    const tx = cds.tx(req);
    const context = await inboxContext(req, approval, rrhh);
    const ID = req.data?.ID || null;
    const delegateID = required(req.data?.delegadoID, "delegadoID");
    const mode = String(req.data?.modo || "").toUpperCase();
    const scope = String(req.data?.alcance || "ALL").toUpperCase();
    const processCode = req.data?.processCode
      ? String(req.data.processCode).trim().toUpperCase()
      : null;
    const from = required(req.data?.fechaInicio, "fechaInicio");
    const to = required(req.data?.fechaFin, "fechaFin");
    const includePending = Boolean(req.data?.incluirPendientes);
    const idempotencyKey = required(req.data?.idempotencyKey, "idempotencyKey");
    const reason = clean(req.data?.motivo, 500);

    validateDelegationInput(req, { mode, scope, processCode, from, to });
    if (to < context.today) {
      reject(
        req,
        400,
        "APPROVAL_DELEGATION_ALREADY_EXPIRED",
        "La fecha final no puede estar en el pasado.",
      );
    }

    const delegate = await eligibleEmployee(tx, approval, rrhh, delegateID);
    if (delegate.ID === context.employee.ID) {
      reject(
        req,
        400,
        "APPROVAL_SELF_DELEGATION_FORBIDDEN",
        "No puedes designarte como tu propio backup.",
      );
    }

    if (scope === "PROCESS") {
      const configured = await tx.run(
        SELECT.one.from(approval.ApprovalProcessDefinitions).where({
          codigo: processCode,
          activo: true,
        }),
      );
      if (!configured) {
        reject(
          req,
          400,
          "APPROVAL_PROCESS_NOT_CONFIGURED",
          "El proceso indicado no está configurado.",
        );
      }
    }

    let row;
    if (!ID) {
      const duplicate = await tx.run(
        SELECT.one.from(approval.ApprovalDelegations).where({
          creationIdempotencyKey: idempotencyKey,
        }),
      );
      if (duplicate) {
        if (duplicate.otorgante_ID !== context.employee.ID) {
          reject(
            req,
            409,
            "APPROVAL_IDEMPOTENCY_KEY_REUSED",
            "La clave de idempotencia ya fue utilizada.",
          );
        }
        const delegates = await eligibleEmployeesByID(
          rrhh,
          new Set([duplicate.delegado_ID]),
        );
        return {
          exito: true,
          mensaje: "La delegación ya existía.",
          delegacion: mapDelegation(
            duplicate,
            delegates.get(duplicate.delegado_ID),
            context.today,
          ),
        };
      }
      await assertNoDelegationOverlap(tx, approval, context.employee.ID, null, {
        alcance: scope,
        processCode,
        fechaInicio: from,
        fechaFin: to,
      });
      row = {
        ID: cds.utils.uuid(),
        otorgante_ID: context.employee.ID,
        otorganteUserID: context.identity,
        delegado_ID: delegate.ID,
        delegadoUserID: delegate.userID,
        modo: mode,
        alcance: scope,
        processCode: scope === "PROCESS" ? processCode : null,
        fechaInicio: from,
        fechaFin: to,
        incluirPendientes: includePending,
        estado: "ACTIVE",
        motivo: reason,
        creationIdempotencyKey: idempotencyKey,
        version: 1,
      };
      await tx.run(INSERT.into(approval.ApprovalDelegations).entries(row));
    } else {
      row = await tx.run(
        SELECT.one.from(approval.ApprovalDelegations).where({
          ID,
          otorgante_ID: context.employee.ID,
        }),
      );
      if (!row) {
        reject(
          req,
          404,
          "APPROVAL_DELEGATION_NOT_FOUND",
          "La delegación no existe.",
        );
      }
      if (row.estado !== "ACTIVE") {
        reject(
          req,
          409,
          "APPROVAL_DELEGATION_NOT_ACTIVE",
          "Solo puedes editar delegaciones activas.",
        );
      }
      const expectedVersion = integerVersion(req.data?.expectedVersion);
      if (row.version !== expectedVersion) {
        reject(
          req,
          412,
          "APPROVAL_ETAG_MISMATCH",
          "La delegación cambió. Actualiza la información.",
        );
      }
      await assertNoDelegationOverlap(tx, approval, context.employee.ID, ID, {
        alcance: scope,
        processCode,
        fechaInicio: from,
        fechaFin: to,
      });
      const changed = await tx.run(
        UPDATE(approval.ApprovalDelegations)
          .set({
            delegado_ID: delegate.ID,
            delegadoUserID: delegate.userID,
            modo: mode,
            alcance: scope,
            processCode: scope === "PROCESS" ? processCode : null,
            fechaInicio: from,
            fechaFin: to,
            incluirPendientes: includePending,
            motivo: reason,
            version: expectedVersion + 1,
          })
          .where({ ID, estado: "ACTIVE", version: expectedVersion }),
      );
      if (changed !== 1) {
        reject(
          req,
          412,
          "APPROVAL_ETAG_MISMATCH",
          "Otra sesión modificó la delegación.",
        );
      }
      await tx.run(
        UPDATE(approval.ApprovalTaskAssignments)
          .set({ estado: "REVOKED" })
          .where({ delegacion_ID: ID, estado: "ACTIVE" }),
      );
      row = {
        ...row,
        delegado_ID: delegate.ID,
        delegadoUserID: delegate.userID,
        modo: mode,
        alcance: scope,
        processCode: scope === "PROCESS" ? processCode : null,
        fechaInicio: from,
        fechaFin: to,
        incluirPendientes: includePending,
        motivo: reason,
        version: expectedVersion + 1,
      };
    }

    if (includePending) {
      await attachDelegationToPendingTasks(tx, approval, row);
    }

    const eventID = await appendEvent(tx, approval, {
      delegationID: row.ID,
      type: ID ? "DELEGATION_UPDATED" : "DELEGATION_CREATED",
      actorUserID: context.identity,
      actorEmployeeID: context.employee.ID,
      actingForEmployeeID: context.employee.ID,
      detail:
        reason || `Delegación ${mode} asignada a ${delegate.nombreCompleto}.`,
      idempotencyKey: ID ? idempotencyKey : derivedKey(idempotencyKey, "event"),
    });
    await persistNotification(tx, approval, {
      eventID,
      type: ID ? "DELEGATION_UPDATED" : "DELEGATION_CREATED",
      recipientID: delegate.userID,
      processCode: processCode || "ALL",
      idempotencyKey: derivedKey(idempotencyKey, "notify"),
    });

    const persisted = await tx.run(
      SELECT.one.from(approval.ApprovalDelegations).where({ ID: row.ID }),
    );
    return {
      exito: true,
      mensaje: ID
        ? "La delegación fue actualizada."
        : "La delegación fue creada.",
      delegacion: mapDelegation(persisted, delegate, context.today),
    };
  });

  this.on("revocarDelegacion", async (req) => {
    const tx = cds.tx(req);
    const context = await inboxContext(req, approval, rrhh);
    const ID = required(req.data?.ID, "ID");
    const expectedVersion = integerVersion(req.data?.expectedVersion);
    const idempotencyKey = required(req.data?.idempotencyKey, "idempotencyKey");
    const reason = clean(req.data?.motivo, 500);
    const row = await tx.run(
      SELECT.one.from(approval.ApprovalDelegations).where({
        ID,
        otorgante_ID: context.employee.ID,
      }),
    );
    if (!row) {
      reject(
        req,
        404,
        "APPROVAL_DELEGATION_NOT_FOUND",
        "La delegación no existe.",
      );
    }
    if (row.revocationIdempotencyKey === idempotencyKey) {
      const delegates = await eligibleEmployeesByID(
        rrhh,
        new Set([row.delegado_ID]),
      );
      return {
        exito: true,
        mensaje: "La delegación ya había sido revocada.",
        delegacion: mapDelegation(
          row,
          delegates.get(row.delegado_ID),
          context.today,
        ),
      };
    }
    if (row.estado !== "ACTIVE" || row.version !== expectedVersion) {
      reject(
        req,
        412,
        "APPROVAL_ETAG_MISMATCH",
        "La delegación cambió o ya no está activa.",
      );
    }

    const now = new Date().toISOString();
    const changed = await tx.run(
      UPDATE(approval.ApprovalDelegations)
        .set({
          estado: "REVOKED",
          revocationIdempotencyKey: idempotencyKey,
          revokedAt: now,
          revokedByUserID: context.identity,
          version: expectedVersion + 1,
        })
        .where({ ID, estado: "ACTIVE", version: expectedVersion }),
    );
    if (changed !== 1) {
      reject(
        req,
        412,
        "APPROVAL_ETAG_MISMATCH",
        "Otra sesión modificó la delegación.",
      );
    }
    await tx.run(
      UPDATE(approval.ApprovalTaskAssignments)
        .set({ estado: "REVOKED" })
        .where({ delegacion_ID: ID, estado: "ACTIVE" }),
    );

    const eventID = await appendEvent(tx, approval, {
      delegationID: ID,
      type: "DELEGATION_REVOKED",
      actorUserID: context.identity,
      actorEmployeeID: context.employee.ID,
      detail: reason,
      idempotencyKey,
    });
    await persistNotification(tx, approval, {
      eventID,
      type: "DELEGATION_REVOKED",
      recipientID: row.delegadoUserID,
      processCode: row.processCode || "ALL",
      idempotencyKey: derivedKey(idempotencyKey, "notify"),
    });

    const persisted = await tx.run(
      SELECT.one.from(approval.ApprovalDelegations).where({ ID }),
    );
    const delegates = await eligibleEmployeesByID(
      rrhh,
      new Set([row.delegado_ID]),
    );
    return {
      exito: true,
      mensaje: "La delegación fue revocada.",
      delegacion: mapDelegation(
        persisted,
        delegates.get(row.delegado_ID),
        context.today,
      ),
    };
  });

  this.on("ApprovalNotificationRequested", async (req) => {
    const eventID = req.data?.eventID;

    if (!eventID) {
      cds
        .log("approval-mailer")
        .warn("Se recibió una notificación sin eventID.");
      return;
    }

    const tx = cds.db;

    const notification = await tx.run(
      SELECT.one
        .from(approval.ApprovalNotificationOutbox)
        .where({ ID: eventID }),
    );

    if (!notification) {
      cds
        .log("approval-mailer")
        .warn("No se encontró la notificación en la outbox.", { eventID });
      return;
    }

    if (notification.estado === "SENT") {
      return;
    }

    if (notification.estado !== "PENDING" && notification.estado !== "FAILED") {
      return;
    }

    /*
     * Claim optimista para evitar que dos procesos envíen
     * simultáneamente el mismo correo.
     */
    const claimed = await tx.run(
      UPDATE(approval.ApprovalNotificationOutbox)
        .set({
          estado: "PROCESSING",
          intentos: Number(notification.intentos || 0) + 1,
          ultimoError: null,
        })
        .where({
          ID: eventID,
          estado: notification.estado,
        }),
    );

    const affectedRows =
      typeof claimed === "number"
        ? claimed
        : Number(claimed?.changes || claimed?.affectedRows || 0);

    if (affectedRows === 0) {
      return;
    }

    if (!claimed) {
      return;
    }

    try {
      const instance = notification.instancia_ID
        ? await tx.run(
            SELECT.one
              .from(approval.ApprovalInstances)
              .where({ ID: notification.instancia_ID }),
          )
        : null;

      const task = notification.tarea_ID
        ? await tx.run(
            SELECT.one
              .from(approval.ApprovalTasks)
              .where({ ID: notification.tarea_ID }),
          )
        : null;

      const facts = notification.instancia_ID
        ? await tx.run(
            SELECT.from(approval.ApprovalFacts)
              .columns(
                "seccion",
                "clave",
                "etiqueta",
                "valor",
                "tipoDato",
                "semanticColor",
                "orden",
              )
              .where({ instancia_ID: notification.instancia_ID })
              .orderBy("orden"),
          )
        : [];

      const recipient = await findEmployeeByEmail(
        tx,
        rrhh,
        notification.destinatarioID,
      );

      await sendApprovalEmail({
        eventID,
        tipo: notification.tipo,
        destinatarioID: notification.destinatarioID,
        recipientName: recipient?.nombreCompleto || notification.destinatarioID,
        processCode: notification.processCode,
        instanciaID: notification.instancia_ID,
        tareaID: notification.tarea_ID,
        titulo: instance?.titulo || "Solicitud de aprobación",
        resumen: instance?.resumen || "",
        solicitanteNombre: instance?.solicitanteNombre || "Un empleado",
        estadoInstancia: instance?.estado,
        taskStatus: task?.estado,
        facts,
      });

      await tx.run(
        UPDATE(approval.ApprovalNotificationOutbox)
          .set({
            estado: "SENT",
            ultimoError: null,
          })
          .where({ ID: eventID }),
      );
    } catch (error) {
      const message = String(
        error?.message || "Error desconocido enviando el correo.",
      ).slice(0, 1000);

      await tx.run(
        UPDATE(approval.ApprovalNotificationOutbox)
          .set({
            estado: "FAILED",
            ultimoError: message,
          })
          .where({ ID: eventID }),
      );

      cds
        .log("approval-mailer")
        .error("No fue posible enviar la notificación.", {
          eventID,
          destinatario: notification.destinatarioID,
          message,
        });

      /*
       * No relanzamos el error porque la solicitud de ausencia
       * ya fue procesada correctamente. La outbox queda en FAILED
       * para un reintento posterior.
       */
    }
  });

  this.on("descargarSoporteAusencia", async (req) => {
    const { solicitudID, soporteID } = req.data || {};

    if (!solicitudID || !soporteID) {
      reject(
        req,
        400,
        "DATOS_SOPORTE_INCOMPLETOS",
        "Faltan solicitudID o soporteID.",
      );
    }

    /*
     * Solo permite descargar adjuntos de ausencias relacionadas con tareas
     * visibles para el aprobador autenticado, incluyendo su historial
     * autorizado.
     */
    const IDsAutorizados = await authorizedAbsenceIDs(req, approval, rrhh);

    if (!IDsAutorizados.includes(solicitudID)) {
      reject(
        req,
        404,
        "SOLICITUD_NO_DISPONIBLE",
        "La solicitud no existe o no está disponible para el usuario.",
      );
    }

    const soporte = await SELECT.one
      .from(SoportesAusencia)
      .columns("ID", "filename", "mimeType", "content", "status")
      .where({
        ID: soporteID,
        up__ID: solicitudID,
      });

    if (!soporte) {
      reject(req, 404, "SOPORTE_NO_ENCONTRADO", "El soporte no existe.");
    }

    if (soporte.status !== "Clean") {
      reject(
        req,
        409,
        "SOPORTE_NO_VALIDADO",
        "El archivo todavía no ha superado la validación de seguridad.",
      );
    }

    let contenidoBuffer;

    try {
      contenidoBuffer = await streamToBuffer(soporte.content);
    } catch (error) {
      cds
        .log("approval-service")
        .error("No fue posible leer el soporte de la ausencia", {
          solicitudID,
          soporteID,
          contentType:
            soporte.content?.constructor?.name || typeof soporte.content,
          error: error?.message,
        });

      reject(
        req,
        500,
        "LECTURA_SOPORTE_FALLIDA",
        "No fue posible leer el contenido del archivo.",
      );
    }

    if (!contenidoBuffer?.length) {
      reject(
        req,
        404,
        "CONTENIDO_NO_DISPONIBLE",
        "El archivo no tiene contenido almacenado.",
      );
    }

    return {
      filename: soporte.filename,
      mimeType: soporte.mimeType || "application/octet-stream",
      contenidoBase64: contenidoBuffer.toString("base64"),
    };
  });

  async function handleDecision(req, decision) {
    const result = await decideApproval(req, {
      taskID: req.data?.ID,
      decision,
      expectedVersion: req.data?.expectedVersion,
      idempotencyKey: req.data?.idempotencyKey,
      comment: req.data?.comentario,
    });
    const message =
      decision === DECISIONS.APPROVE
        ? "La solicitud fue aprobada."
        : "La solicitud fue rechazada.";
    return actionResult(req, approval, rrhh, result.task.ID, message, result);
  }
});

async function findEmployeeByEmail(tx, rrhh, email) {
  const normalizedEmail = normalizeIdentity(email);

  if (!normalizedEmail) {
    return null;
  }

  let employee = await tx.run(
    SELECT.one
      .from(rrhh.Empleados)
      .columns("ID", "nombreCompleto", "correoCorporativo")
      .where({ correoCorporativo: normalizedEmail }),
  );

  if (employee) {
    return employee;
  }

  /*
   * Compatibilidad temporal con correos antiguos almacenados
   * con mayúsculas o espacios.
   */
  const employees = await tx.run(
    SELECT.from(rrhh.Empleados).columns(
      "ID",
      "nombreCompleto",
      "correoCorporativo",
    ),
  );

  return (
    employees.find(
      (row) => normalizeIdentity(row.correoCorporativo) === normalizedEmail,
    ) || null
  );
}

async function inboxContext(req, approval, rrhh) {
  const identity = identityFromUser(req.user);
  if (!identity) {
    reject(
      req,
      403,
      "APPROVAL_IDENTITY_MISSING",
      "No fue posible obtener tu identidad autenticada.",
    );
  }
  const employee = await authenticatedEmployee(req, approval, rrhh, identity);
  return {
    identity,
    employee,
    today: todayInColombia(),
    isAdmin: Boolean(req.user?.is("ApprovalAdmin")),
  };
}

async function authorizedAbsenceIDs(req, approval, rrhh) {
  const context = await inboxContext(req, approval, rrhh);
  const tasks = await visibleTasks(req, approval, rrhh, context);
  return [
    ...new Set(
      tasks
        .filter(
          (task) =>
            task.processCode === "ABSENCE" &&
            task.businessObjectType === "sabnez.rrhh.Ausencias" &&
            task.businessObjectID,
        )
        .map((task) => task.businessObjectID),
    ),
  ];
}

function applyAuthorizedParentFilter(req, field, IDs) {
  req.query.where({
    [field]: IDs.length ? { in: IDs } : null,
  });
}

async function buildAbsenceSupportFacts(task, SoportesAusencia) {
  if (
    !SoportesAusencia ||
    task.processCode !== "ABSENCE" ||
    task.businessObjectType !== "sabnez.rrhh.Ausencias"
  ) {
    return [];
  }

  const requestID = task.businessObjectID;
  const supports = await SELECT.from(SoportesAusencia)
    .columns("ID", "filename", "mimeType", "status")
    .where({ up__ID: requestID });

  return supports
    .filter((support) => support.status === "Clean")
    .sort((left, right) =>
      String(left.filename || "").localeCompare(String(right.filename || "")),
    )
    .map((support, index) => ({
      ID: support.ID,
      seccion: "Soportes",
      clave: `support-${support.ID}`,
      etiqueta: `Soporte ${index + 1}`,
      valor: support.filename || `Archivo ${index + 1}`,
      enlace:
        `/aprobaciones/AusenciasAprobables(ID=${encodeURIComponent(requestID)})` +
        `/soportes(up__ID=${encodeURIComponent(requestID)},ID=${encodeURIComponent(support.ID)})/content`,
      tipoDato: "LINK",
      semanticColor: null,
      orden: 1000 + index,
    }));
}

function isApprovalSupportRequest(req) {
  const targetName = req.target?.name || "";
  if (targetName.endsWith(".AusenciasAprobables.soportes")) return true;
  const url = req._?.req?.url || req.req?.url || "";
  return /\/AusenciasAprobables(?:\([^)]*\))?\/soportes(?:\([^)]*\))?(?:\/content)?(?:\?|$)/i.test(
    url,
  );
}

async function authenticatedEmployee(req, approval, rrhh, knownIdentity) {
  const identity = knownIdentity || identityFromUser(req.user);
  if (!identity) {
    reject(
      req,
      403,
      "APPROVAL_IDENTITY_MISSING",
      "No fue posible obtener tu identidad autenticada.",
    );
  }

  const mapped = await SELECT.one.from(approval.ApprovalIdentities).where({
    subjectNormalizado: identity,
    activa: true,
  });
  if (mapped) {
    const employee = await SELECT.one
      .from(rrhh.Empleados)
      .columns("ID", "nombreCompleto", "correoCorporativo", "estado_codigo")
      .where({ ID: mapped.empleado_ID });
    if (employee) return employee;
  }

  let employee = await SELECT.one
    .from(rrhh.Empleados)
    .columns("ID", "nombreCompleto", "correoCorporativo", "estado_codigo")
    .where({ correoCorporativo: identity });
  if (!employee) {
    const employees = await SELECT.from(rrhh.Empleados).columns(
      "ID",
      "nombreCompleto",
      "correoCorporativo",
      "estado_codigo",
    );
    employee = employees.find(
      (row) => normalizeIdentity(row.correoCorporativo) === identity,
    );
  }
  if (!employee) {
    reject(
      req,
      403,
      "APPROVAL_EMPLOYEE_NOT_FOUND",
      "No existe un empleado asociado a tu identidad.",
    );
  }
  if (employee.estado_codigo !== "AC") {
    reject(
      req,
      403,
      "APPROVAL_EMPLOYEE_NOT_ACTIVE",
      "El empleado asociado no está activo.",
    );
  }
  return employee;
}

async function visibleTasks(req, approval, rrhh, context, requestedID) {
  const assignments = await SELECT.from(approval.ApprovalTaskAssignments).where(
    {
      approverUserID: context.identity,
    },
  );
  const taskIDs = new Set(assignments.map((row) => row.tarea_ID));
  if (context.isAdmin) {
    const waiting = await SELECT.from(approval.ApprovalTasks).where({
      estado: "WAITING",
    });
    waiting.forEach((task) => taskIDs.add(task.ID));
  }
  if (requestedID && !taskIDs.has(requestedID)) return [];

  const tasks = [];
  for (const taskID of taskIDs) {
    if (requestedID && taskID !== requestedID) continue;
    const bundle = await taskBundle(cds.tx(req), approval, taskID);
    if (!bundle.task || !bundle.instance) continue;
    const effective = effectiveAssignment(bundle, context);
    const isAdminException =
      context.isAdmin && bundle.task.estado === "WAITING";
    if (!effective.assignment && !isAdminException) {
      // Las tareas completadas siguen visibles por su asignación histórica.
      const historical = bundle.assignments.find(
        (row) => normalizeIdentity(row.approverUserID) === context.identity,
      );
      if (!historical) continue;
      effective.assignment = historical;
    }
    tasks.push(
      await mapTask({
        rrhh,
        bundle,
        effective,
        isAdminException,
      }),
    );
  }
  return tasks.sort((left, right) => {
    if (left.estado === "OPEN" && right.estado !== "OPEN") return -1;
    if (right.estado === "OPEN" && left.estado !== "OPEN") return 1;
    return String(right.fechaSolicitud).localeCompare(
      String(left.fechaSolicitud),
    );
  });
}

function effectiveAssignment(bundle, context) {
  return selectEffectiveAssignment({
    assignments: bundle.assignments,
    delegations: bundle.delegations,
    identity: context.identity,
    processCode: bundle.instance.processCode,
    date: context.today,
  });
}

async function mapTask({ rrhh, bundle, effective, isAdminException }) {
  const original = bundle.task.originalApprover_ID
    ? await SELECT.one
        .from(rrhh.Empleados)
        .columns("ID", "nombreCompleto")
        .where({ ID: bundle.task.originalApprover_ID })
    : null;
  const canAct =
    bundle.task.estado === "OPEN" &&
    Boolean(effective.canAct && effective.assignment);
  return {
    ID: bundle.task.ID,
    instanciaID: bundle.instance.ID,
    processCode: bundle.instance.processCode,
    businessObjectType: bundle.instance.businessObjectType,
    businessObjectID: bundle.instance.businessObjectID,
    titulo: bundle.instance.titulo,
    resumen: bundle.instance.resumen,
    solicitanteNombre: bundle.instance.solicitanteNombre,
    prioridad: bundle.instance.prioridad,
    estado: bundle.task.estado,
    tipoAsignacion: isAdminException
      ? "ADMIN_EXCEPTION"
      : effective.assignment?.tipo || null,
    actuandoPorNombre:
      effective.assignment?.tipo === "PRIMARY"
        ? null
        : original?.nombreCompleto || null,
    fechaSolicitud: bundle.instance.submittedAt,
    fechaVencimiento: bundle.task.dueAt,
    version: bundle.task.version,
    modifiedAt: bundle.task.modifiedAt,
    rutaOrigen: bundle.instance.rutaOrigen,
    puedeAprobar: canAct,
    puedeRechazar: canAct,
    puedeReenviar:
      isAdminException ||
      (canAct && effective.assignment?.tipo === ASSIGNMENT_TYPES.PRIMARY),
  };
}

async function taskBundle(tx, approval, taskID) {
  const task = await tx.run(
    SELECT.one.from(approval.ApprovalTasks).where({ ID: taskID }),
  );
  if (!task) return {};
  const [instance, stage, assignments, delegations] = await Promise.all([
    tx.run(
      SELECT.one.from(approval.ApprovalInstances).where({
        ID: task.instancia_ID,
      }),
    ),
    tx.run(
      SELECT.one.from(approval.ApprovalStages).where({ ID: task.etapa_ID }),
    ),
    tx.run(
      SELECT.from(approval.ApprovalTaskAssignments).where({ tarea_ID: taskID }),
    ),
    tx.run(
      SELECT.from(approval.ApprovalDelegations).where({ estado: "ACTIVE" }),
    ),
  ]);
  return { task, instance, stage, assignments, delegations };
}

async function eligibleEmployee(tx, approval, rrhh, employeeID) {
  const employee = await tx.run(
    SELECT.one
      .from(rrhh.Empleados)
      .columns("ID", "nombreCompleto", "correoCorporativo", "estado_codigo")
      .where({ ID: employeeID }),
  );
  if (
    !employee ||
    employee.estado_codigo !== "AC" ||
    !normalizeIdentity(employee.correoCorporativo)
  ) {
    throw approvalError(
      400,
      "APPROVAL_DELEGATE_NOT_ELIGIBLE",
      "El empleado seleccionado debe estar activo y tener correo corporativo.",
      "delegadoID",
    );
  }
  const userID = await resolveEmployeeUserID(tx, approval, employee);
  if (!userID) {
    throw approvalError(
      400,
      "APPROVAL_DELEGATE_IDENTITY_MISSING",
      "El empleado seleccionado no tiene identidad aprobadora.",
      "delegadoID",
    );
  }
  return { ...employee, userID };
}

async function assertNoDelegationOverlap(
  tx,
  approval,
  grantorID,
  excludedID,
  candidate,
) {
  const existing = await tx.run(
    SELECT.from(approval.ApprovalDelegations).where({
      otorgante_ID: grantorID,
      estado: "ACTIVE",
    }),
  );
  const conflict = existing.find(
    (row) =>
      row.ID !== excludedID &&
      dateRangesOverlap(
        row.fechaInicio,
        row.fechaFin,
        candidate.fechaInicio,
        candidate.fechaFin,
      ) &&
      scopesOverlap(row, candidate),
  );
  if (conflict) {
    throw approvalError(
      409,
      "APPROVAL_DELEGATION_OVERLAP",
      "Ya existe una delegación activa que se cruza con ese periodo y alcance.",
    );
  }
}

async function attachDelegationToPendingTasks(tx, approval, delegation) {
  const tasks = await tx.run(
    SELECT.from(approval.ApprovalTasks).where({
      originalApprover_ID: delegation.otorgante_ID,
      estado: "OPEN",
    }),
  );
  for (const task of tasks) {
    const instance = await tx.run(
      SELECT.one.from(approval.ApprovalInstances).where({
        ID: task.instancia_ID,
      }),
    );
    if (
      delegation.alcance === "PROCESS" &&
      instance?.processCode !== delegation.processCode
    ) {
      continue;
    }
    const existing = await tx.run(
      SELECT.one.from(approval.ApprovalTaskAssignments).where({
        tarea_ID: task.ID,
        delegacion_ID: delegation.ID,
        estado: "ACTIVE",
      }),
    );
    if (existing) continue;
    await tx.run(
      INSERT.into(approval.ApprovalTaskAssignments).entries({
        ID: cds.utils.uuid(),
        tarea_ID: task.ID,
        empleado_ID: delegation.delegado_ID,
        approverUserID: delegation.delegadoUserID,
        tipo:
          delegation.modo === DELEGATION_MODES.SUBSTITUTE
            ? ASSIGNMENT_TYPES.DELEGATE
            : ASSIGNMENT_TYPES.BACKUP,
        estado: "ACTIVE",
        validaDesde: delegation.fechaInicio,
        validaHasta: delegation.fechaFin,
        delegacion_ID: delegation.ID,
      }),
    );
  }
}

function validateDelegationInput(req, input) {
  if (!Object.values(DELEGATION_MODES).includes(input.mode)) {
    reject(
      req,
      400,
      "APPROVAL_DELEGATION_MODE_INVALID",
      "El modo debe ser BACKUP o SUBSTITUTE.",
      "modo",
    );
  }
  if (!["ALL", "PROCESS"].includes(input.scope)) {
    reject(
      req,
      400,
      "APPROVAL_DELEGATION_SCOPE_INVALID",
      "El alcance debe ser ALL o PROCESS.",
      "alcance",
    );
  }
  if (input.scope === "PROCESS" && !input.processCode) {
    reject(
      req,
      400,
      "APPROVAL_DELEGATION_PROCESS_REQUIRED",
      "Debes indicar el proceso de la delegación.",
      "processCode",
    );
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.to) ||
    input.from > input.to
  ) {
    reject(
      req,
      400,
      "APPROVAL_DELEGATION_DATES_INVALID",
      "El periodo de la delegación no es válido.",
    );
  }
}

async function actionResult(
  req,
  approval,
  rrhh,
  taskID,
  message,
  decisionResult,
) {
  const context = await inboxContext(req, approval, rrhh);
  const bundle = await taskBundle(cds.tx(req), approval, taskID);
  let effective = decisionResult?.actor?.assignment
    ? { assignment: decisionResult.actor.assignment, canAct: false }
    : effectiveAssignment(bundle, context);
  if (!effective.assignment) {
    const historical = bundle.assignments.find(
      (row) => normalizeIdentity(row.approverUserID) === context.identity,
    );
    if (historical) effective = { assignment: historical, canAct: false };
  }
  return {
    exito: true,
    mensaje: message,
    tarea: await mapTask({ rrhh, bundle, effective, isAdminException: false }),
  };
}

function mapDelegation(row, delegate, today) {
  return {
    ID: row.ID,
    delegadoID: row.delegado_ID,
    delegadoNombre: delegate?.nombreCompleto || row.delegadoUserID,
    delegadoCorreo: delegate?.correoCorporativo || row.delegadoUserID,
    modo: row.modo,
    alcance: row.alcance,
    processCode: row.processCode,
    fechaInicio: row.fechaInicio,
    fechaFin: row.fechaFin,
    incluirPendientes: row.incluirPendientes,
    estado: effectiveDelegationState(row, today),
    motivo: row.motivo,
    version: row.version,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt,
  };
}

function effectiveDelegationState(row, today) {
  if (row.estado !== "ACTIVE") return row.estado;
  return row.fechaFin < today ? "EXPIRED" : row.estado;
}

async function eligibleEmployeesByID(rrhh, IDs) {
  const result = new Map();
  for (const ID of IDs) {
    const row = await SELECT.one
      .from(rrhh.Empleados)
      .columns("ID", "nombreCompleto", "correoCorporativo")
      .where({ ID });
    if (row) result.set(ID, row);
  }
  return result;
}

async function employeeNames(rrhh, IDs) {
  const employees = await eligibleEmployeesByID(rrhh, IDs);
  return new Map(
    [...employees.entries()].map(([ID, employee]) => [
      ID,
      employee.nombreCompleto,
    ]),
  );
}

function integerVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw approvalError(
      428,
      "APPROVAL_VERSION_REQUIRED",
      "Debes enviar la versión vigente del registro.",
      "expectedVersion",
    );
  }
  return version;
}

function reject(req, status, code, message, target) {
  const error = { status, code, message };
  if (target) error.target = target;
  req.reject(error);
}

function required(value, field) {
  const normalized = clean(value, 255);
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

function clean(value, maxLength) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw approvalError(
      400,
      "APPROVAL_TEXT_TOO_LONG",
      `El texto supera ${maxLength} caracteres.`,
    );
  }
  return normalized;
}

function derivedKey(base, suffix) {
  const value = `${base}:${suffix}`;
  return value.length <= 120 ? value : `${base.slice(0, 100)}:${suffix}`;
}
