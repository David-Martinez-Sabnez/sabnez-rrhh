"use strict";

const cds = require("@sap/cds");
const { streamToBuffer } = require("./lib/stream-utils");
const { Readable } = require("node:stream");

const {
  ESTADOS_CONSUMO_AUSENCIA,
  ESTADOS_RESERVA_AUSENCIA,
  ESTADOS_RESERVA_CUMPLEANIOS,
  ESTADOS_UTILIZACION_AUSENCIA,
  ESTADOS_UTILIZACION_CUMPLEANIOS,
  addDays,
  calcularDiasAnticipacion,
  calcularDiasHabilesColombia,
  calcularHorasSolicitadas,
  fechasSeCruzan,
  formatISODate,
  horasSeCruzan,
  isValidISODate,
  normalizarHora,
  obtenerInicioSemanaISO,
  obtenerOcurrenciaCumpleaniosParaFecha,
  obtenerProximaVentanaCumpleanios,
  parseISODate,
  round2,
  tieneSegundos,
  todayInColombia,
} = require("./lib/absence-rules");
const {
  DECISIONS,
  PROCESS_CODES,
  cancelApproval,
  getLatestDecision,
  registerApprovalAdapter,
  startApproval,
} = require("./lib/approval-orchestrator");

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

const CODIGO_VALERA = "VE";
const ORIGEN_AUTOSERVICIO = "AUTOSERVICIO";
const POLITICA_SEMANA_CUMPLEANOS = "SEMANA_CUMPLEANOS";
const BUSINESS_OBJECT_AUSENCIA = "sabnez.rrhh.Ausencias";
const COLUMNAS_EMPLEADO_AUTENTICADO = [
  "ID",
  "correoCorporativo",
  "nombreCompleto",
  "fechaNacimiento",
  "fechaIngreso",
  "fechaRetiro",
  "estado_codigo",
];

registerApprovalAdapter(PROCESS_CODES.ABSENCE, {
  async validateDecision(ctx) {
    const { Ausencias } = cds.entities("sabnez.rrhh");
    const ausencia = await ctx.tx.run(
      SELECT.one.from(Ausencias).where({
        ID: ctx.businessObject.id,
      }),
    );

    if (
      !ausencia ||
      ausencia.origenRegistro !== ORIGEN_AUTOSERVICIO ||
      ausencia.estadoa_codigo !== "SOLICITADA"
    ) {
      reject(
        ctx.req,
        409,
        "AUSENCIA_NO_DECIDIBLE",
        "La solicitud ya no está disponible para aprobación.",
      );
    }

    if (ausencia.empleado_ID === ctx.actor.employeeID) {
      reject(
        ctx.req,
        403,
        "AUTOAPROBACION_NO_PERMITIDA",
        "No puedes decidir una solicitud de ausencia propia.",
      );
    }
  },

  async applyDecision(ctx) {
    const { Ausencias } = cds.entities("sabnez.rrhh");
    const aprobada = ctx.decision === DECISIONS.APPROVE;
    const filasActualizadas = await ctx.tx.run(
      UPDATE(Ausencias)
        .set({
          estadoa_codigo: aprobada ? "APROBADA" : "RECHAZADA",
          aprobadaPor_ID: aprobada ? ctx.actor.employeeID : null,
          fechaAprobacion: aprobada ? todayInColombia() : null,
        })
        .where({
          ID: ctx.businessObject.id,
          origenRegistro: ORIGEN_AUTOSERVICIO,
          estadoa_codigo: "SOLICITADA",
        }),
    );

    if (filasActualizadas !== 1) {
      reject(
        ctx.req,
        409,
        "AUSENCIA_MODIFICADA_CONCURRENTEMENTE",
        "La solicitud cambió mientras se registraba la decisión.",
      );
    }
  },
});

module.exports = cds.service.impl(function () {
  const { MisAusencias } = this.entities;
  const SoportesSrv = this.entities["MisAusencias.soportes"];
  const ScanStatesSrv = this.entities.ScanStates;
  const ScanStatesTextsSrv = this.entities["ScanStates.texts"];

  const entities = cds.entities("sabnez.rrhh");
  const {
    Empleados,
    Contratos,
    Ausencias,
    TiposAusencia,
    EstadosAusencia,
    TiposContrato,
    SaldosValeraEmocional,
  } = entities;
  const SoportesAusencia = entities["Ausencias.soportes"];

  // La proyección raíz existe exclusivamente para navegar a los soportes.
  // Las solicitudes solo se crean y cambian mediante las acciones controladas.
  this.before(["CREATE", "UPDATE", "PATCH", "DELETE"], MisAusencias, (req) => {
    reject(
      req,
      405,
      "OPERACION_DIRECTA_NO_PERMITIDA",
      "Usa las acciones del servicio para administrar solicitudes de ausencia.",
    );
  });

  this.before("READ", MisAusencias, async (req) => {
    const empleado = await obtenerEmpleadoAutenticado(req, Empleados);
    req.query.where({ empleado_ID: empleado.ID });
  });

  [ScanStatesSrv, ScanStatesTextsSrv].filter(Boolean).forEach((entity) => {
    this.before(["CREATE", "UPDATE", "PATCH", "DELETE"], entity, (req) => {
      reject(
        req,
        405,
        "CATALOGO_TECNICO_SOLO_LECTURA",
        "El catálogo técnico de validación de soportes es de solo lectura.",
      );
    });
  });

  if (SoportesSrv && SoportesAusencia) {
    this.before("READ", SoportesSrv, async (req) => {
      const empleado = await obtenerEmpleadoAutenticado(req, Empleados);
      const ausenciasPropias = await SELECT.from(Ausencias)
        .columns("ID")
        .where({ empleado_ID: empleado.ID });
      const IDs = ausenciasPropias.map((ausencia) => ausencia.ID);

      // También protege lecturas directas del entity set técnico. Usar la FK
      // expuesta por OData evita depender de que el adaptador expanda un filtro
      // por asociación en todas las variantes de READ/stream.
      if (IDs.length === 0) {
        req.query.where({ up__ID: null });
      } else {
        req.query.where({ up__ID: { in: IDs } });
      }
    });

    this.before(["CREATE", "DELETE"], SoportesSrv, async (req) => {
      await validarMutacionSoporte(req, Empleados, Ausencias, SoportesAusencia);
    });

    this.before(["UPDATE", "PATCH"], SoportesSrv, async (req) => {
      if (esPeticionDeContenidoSoporte(req)) {
        await validarMutacionSoporte(
          req,
          Empleados,
          Ausencias,
          SoportesAusencia,
        );
        return;
      }

      reject(
        req,
        405,
        "EDICION_SOPORTE_NO_PERMITIDA",
        "Los soportes solo pueden cargarse o eliminarse mientras la solicitud está en borrador.",
      );
    });

    // @cap-js/attachments usa PUT sobre la propiedad stream /content. En CAP
    // ese PUT no siempre se despacha con el target esperado, por lo que el
    // filtro se hace en el handler global del servicio.
    this.before("PUT", async (req) => {
      if (!esPeticionDeSoporte(req, SoportesSrv)) return;
      await validarMutacionSoporte(req, Empleados, Ausencias, SoportesAusencia);
    });
  }

  this.on("obtenerMiResumen", async (req) => {
    const empleado = await obtenerEmpleadoAutenticado(req, Empleados);
    const fechaActual = todayInColombia();
    const anioActual = Number(fechaActual.slice(0, 4));

    const [solicitudes, tipoValera, tipoCumpleanios, saldoVacaciones] =
      await Promise.all([
        SELECT.from(Ausencias)
          .columns(
            "ID",
            "tipoAusencia_codigo",
            "estadoa_codigo",
            "fechaInicio",
            "horasSolicitadas",
          )
          .where({ empleado_ID: empleado.ID }),
        SELECT.one.from(TiposAusencia).where({ codigo: CODIGO_VALERA }),
        SELECT.one.from(TiposAusencia).where({
          politicaFecha: POLITICA_SEMANA_CUMPLEANOS,
          controlaSaldoHoras: true,
        }),
        calcularSaldoVacaciones({
          empleadoID: empleado.ID,
          Contratos,
          TiposContrato,
          TiposAusencia,
          Ausencias,
          fechaActual,
        }),
      ]);

    const proximaVentana = obtenerProximaVentanaCumpleanios(
      empleado.fechaNacimiento,
      fechaActual,
    );
    const elegibilidadCumpleanios = proximaVentana
      ? await evaluarElegibilidadVentanaCumpleanios({
          empleado,
          Contratos,
          ventana: proximaVentana,
        })
      : { elegible: false };

    const [saldoValera, saldoCumpleanios] = await Promise.all([
      calcularSaldoValera({
        empleadoID: empleado.ID,
        anio: anioActual,
        tipoValera,
        SaldosValeraEmocional,
        Ausencias,
      }),
      calcularSaldoCumpleanios({
        empleado,
        ventana: proximaVentana,
        tipoCumpleanios: elegibilidadCumpleanios.elegible
          ? tipoCumpleanios
          : null,
        TiposAusencia,
        Ausencias,
      }),
    ]);

    return {
      nombreEmpleado: empleado.nombreCompleto,
      solicitudesEnCurso: solicitudes.filter((solicitud) =>
        ["BORRADOR", "SOLICITADA"].includes(solicitud.estadoa_codigo),
      ).length,
      solicitudesAprobadas: solicitudes.filter((solicitud) =>
        ["APROBADA", "FINALIZADA"].includes(solicitud.estadoa_codigo),
      ).length,
      solicitudesRechazadas: solicitudes.filter(
        (solicitud) => solicitud.estadoa_codigo === "RECHAZADA",
      ).length,
      diasVacacionesCausados: saldoVacaciones.diasVacacionesCausados,
      diasVacacionesReservados: saldoVacaciones.diasVacacionesReservados,
      diasVacacionesDisponibles: saldoVacaciones.diasVacacionesDisponibles,
      horasValeraAsignadas: saldoValera.horasAsignadas,
      horasValeraUtilizadas: saldoValera.horasUtilizadas,
      horasValeraReservadas: saldoValera.horasReservadas,
      horasValeraDisponibles: saldoValera.horasDisponibles,
      horasCumpleaniosAsignadas: saldoCumpleanios.horasAsignadas,
      horasCumpleaniosUtilizadas: saldoCumpleanios.horasUtilizadas,
      horasCumpleaniosReservadas: saldoCumpleanios.horasReservadas,
      horasCumpleaniosDisponibles: saldoCumpleanios.horasDisponibles,
      proximoCumpleanios: proximaVentana?.fechaCumpleanios ?? null,
      semanaCumpleaniosInicio: proximaVentana?.semanaInicio ?? null,
      semanaCumpleaniosFin: proximaVentana?.semanaFin ?? null,
    };
  });

  this.on("obtenerMisSolicitudes", async (req) => {
    const empleado = await obtenerEmpleadoAutenticado(req, Empleados);
    const solicitudes = await SELECT.from(Ausencias).where({
      empleado_ID: empleado.ID,
    });
    const decisionesPorID = await getLatestDecision(req, {
      processCode: PROCESS_CODES.ABSENCE,
      businessObjectType: BUSINESS_OBJECT_AUSENCIA,
      businessObjectIDs: solicitudes.map((solicitud) => solicitud.ID),
    });

    return enriquecerSolicitudes({
      solicitudes,
      TiposAusencia,
      EstadosAusencia,
      SoportesAusencia,
      decisionesPorID,
    });
  });

  this.on("guardarBorrador", async (req) => {
    const empleadoInicial = await obtenerEmpleadoAutenticado(req, Empleados);
    const empleado = await bloquearEmpleado(req, Empleados, empleadoInicial.ID);
    const ID = req.data?.ID || null;

    let solicitudExistente = null;
    if (ID) {
      solicitudExistente = await SELECT.one.from(Ausencias).where({
        ID,
        empleado_ID: empleado.ID,
      });

      if (!solicitudExistente) {
        reject(
          req,
          404,
          "SOLICITUD_NO_ENCONTRADA",
          "La solicitud no existe o no pertenece al empleado autenticado.",
        );
      }

      exigirSolicitudAutoservicio(req, solicitudExistente);

      if (solicitudExistente.estadoa_codigo !== "BORRADOR") {
        reject(
          req,
          409,
          "SOLICITUD_NO_EDITABLE",
          "Solo puedes editar solicitudes que estén en borrador.",
        );
      }
    }

    const tipoCodigo = normalizarCodigo(req.data?.tipoAusenciaCodigo);
    const tipo = await obtenerTipoAusencia(req, TiposAusencia, tipoCodigo);

    const datos = await construirDatosCanonicos({
      req,
      input: req.data || {},
      tipo,
      empleado,
      Contratos,
      fechaActual: todayInColombia(),
    });

    const solicitudID = ID || cds.utils.uuid();
    const persistencia = {
      empleado_ID: empleado.ID,
      origenRegistro: ORIGEN_AUTOSERVICIO,
      tipoAusencia_codigo: tipo.codigo,
      fechaInicio: datos.fechaInicio,
      fechaFin: datos.fechaFin,
      diasHabiles: datos.diasHabiles,
      horaInicio: datos.horaInicio,
      horaFin: datos.horaFin,
      horasSolicitadas: datos.horasSolicitadas,
      unidadConsumo: datos.unidadConsumo,
      estadoa_codigo: "BORRADOR",
      motivo: normalizarMotivo(req.data?.motivo),
      aprobadaPor_ID: null,
      fechaAprobacion: null,
    };

    if (solicitudExistente) {
      const filasActualizadas = await UPDATE(Ausencias)
        .set(persistencia)
        .where({
          ID: solicitudID,
          empleado_ID: empleado.ID,
          origenRegistro: ORIGEN_AUTOSERVICIO,
          estadoa_codigo: "BORRADOR",
        });
      if (filasActualizadas !== 1) {
        reject(
          req,
          409,
          "SOLICITUD_MODIFICADA_CONCURRENTEMENTE",
          "La solicitud cambió en otra sesión. Actualiza la información antes de continuar.",
        );
      }
    } else {
      await INSERT.into(Ausencias).entries({
        ID: solicitudID,
        ...persistencia,
      });
    }

    const solicitud = await cargarSolicitudPropia(
      req,
      Ausencias,
      empleado.ID,
      solicitudID,
    );

    return resultadoSolicitud(
      "El borrador se guardó correctamente.",
      await enriquecerSolicitud({
        solicitud,
        TiposAusencia,
        EstadosAusencia,
        SoportesAusencia,
      }),
    );
  });

  this.on("enviarSolicitud", async (req) => {
    const empleadoInicial = await obtenerEmpleadoAutenticado(req, Empleados);
    const ID = exigirID(req);

    // Serializa todos los envíos del empleado. Así dos pestañas no pueden
    // consumir simultáneamente el mismo saldo o enviar dos cumpleaños.
    const empleado = await bloquearEmpleado(req, Empleados, empleadoInicial.ID);

    const solicitud = await cargarSolicitudPropia(
      req,
      Ausencias,
      empleado.ID,
      ID,
    );

    exigirSolicitudAutoservicio(req, solicitud);

    if (solicitud.estadoa_codigo !== "BORRADOR") {
      reject(
        req,
        409,
        "SOLICITUD_NO_ENVIABLE",
        "Solo puedes enviar solicitudes que estén en borrador.",
      );
    }

    const tipo = await obtenerTipoAusencia(
      req,
      TiposAusencia,
      solicitud.tipoAusencia_codigo,
    );

    const datos = await construirDatosCanonicos({
      req,
      input: {
        fechaInicio: solicitud.fechaInicio,
        fechaFin: solicitud.fechaFin,
        horaInicio: solicitud.horaInicio,
        horaFin: solicitud.horaFin,
      },
      tipo,
      empleado,
      Contratos,
      fechaActual: todayInColombia(),
    });

    const soportes = await obtenerEstadosSoportes(
      SoportesAusencia,
      solicitud.ID,
    );

    if (tipo.requiereSoporte && soportes.length < 1) {
      reject(
        req,
        400,
        "SOPORTE_REQUERIDO",
        `La ausencia ${tipo.descripcion} requiere al menos un soporte antes de enviarse.`,
        "soportes",
      );
    }

    if (soportes.some((soporte) => soporte.status !== "Clean")) {
      reject(
        req,
        409,
        "SOPORTE_NO_VALIDADO",
        "Todos los soportes deben terminar de cargarse y superar la validación de seguridad antes de enviar la solicitud.",
        "soportes",
      );
    }

    await validarReglasDeEnvio({
      req,
      empleado,
      solicitud: {
        ...solicitud,
        ...datos,
        tipoAusencia_codigo: tipo.codigo,
        estadoa_codigo: "SOLICITADA",
      },
      tipo,
      Ausencias,
      TiposAusencia,
      Contratos,
      TiposContrato,
      SaldosValeraEmocional,
    });

    const filasActualizadas = await UPDATE(Ausencias)
      .set({
        fechaInicio: datos.fechaInicio,
        fechaFin: datos.fechaFin,
        diasHabiles: datos.diasHabiles,
        horaInicio: datos.horaInicio,
        horaFin: datos.horaFin,
        horasSolicitadas: datos.horasSolicitadas,
        unidadConsumo: datos.unidadConsumo,
        estadoa_codigo: "SOLICITADA",
        aprobadaPor_ID: null,
        fechaAprobacion: null,
      })
      .where({
        ID,
        empleado_ID: empleado.ID,
        origenRegistro: ORIGEN_AUTOSERVICIO,
        estadoa_codigo: "BORRADOR",
      });
    if (filasActualizadas !== 1) {
      reject(
        req,
        409,
        "SOLICITUD_MODIFICADA_CONCURRENTEMENTE",
        "La solicitud cambió en otra sesión. Actualiza la información antes de continuar.",
      );
    }

    const periodoAprobacion = construirPeriodoAprobacion({
      fechaInicio: datos.fechaInicio,
      fechaFin: datos.fechaFin,
      horaInicio: datos.horaInicio,
      horaFin: datos.horaFin,
      unidadConsumo: datos.unidadConsumo,
    });
    const cantidadAprobacion = construirCantidadAprobacion({
      diasHabiles: datos.diasHabiles,
      horasSolicitadas: datos.horasSolicitadas,
      unidadConsumo: datos.unidadConsumo,
    });

    await startApproval(req, {
      processCode: PROCESS_CODES.ABSENCE,
      businessObjectType: BUSINESS_OBJECT_AUSENCIA,
      businessObjectID: ID,
      requesterEmployeeID: empleado.ID,
      title: tipo.descripcion,
      summary: `${periodoAprobacion} · ${cantidadAprobacion}`,
      priority: "MEDIUM",
      route: "Ausencias-display",
      cycle: 1,
      idempotencyKey: `ABSENCE:${ID}:1`,
      facts: [
        {
          section: "Solicitud",
          key: "absenceType",
          label: "Tipo de ausencia",
          value: tipo.descripcion,
          order: 10,
        },
        {
          section: "Solicitud",
          key: "period",
          label: "Periodo",
          value: periodoAprobacion,
          order: 20,
        },
        {
          section: "Solicitud",
          key: "quantity",
          label: "Cantidad",
          value: cantidadAprobacion,
          order: 30,
        },
        {
          section: "Solicitud",
          key: "reason",
          label: "Motivo",
          value: solicitud.motivo || "Sin información adicional",
          order: 40,
        },
        {
          section: "Soportes",
          key: "supportCount",
          label: "Archivos adjuntos",
          value: String(soportes.length),
          dataType: "NUMBER",
          order: 50,
        },
      ],
    });

    const actualizada = await cargarSolicitudPropia(
      req,
      Ausencias,
      empleado.ID,
      ID,
    );

    return resultadoSolicitud(
      "La solicitud fue enviada correctamente.",
      await enriquecerSolicitud({
        solicitud: actualizada,
        TiposAusencia,
        EstadosAusencia,
        SoportesAusencia,
      }),
    );
  });

  this.on("cancelarSolicitud", async (req) => {
    const empleado = await obtenerEmpleadoAutenticado(req, Empleados);
    await bloquearEmpleado(req, Empleados, empleado.ID);
    const ID = exigirID(req);
    const solicitud = await cargarSolicitudPropia(
      req,
      Ausencias,
      empleado.ID,
      ID,
    );

    exigirSolicitudAutoservicio(req, solicitud);

    if (solicitud.estadoa_codigo !== "SOLICITADA") {
      reject(
        req,
        409,
        "SOLICITUD_NO_CANCELABLE",
        "Solo puedes cancelar solicitudes que aún estén en estado SOLICITADA.",
      );
    }

    const filasActualizadas = await UPDATE(Ausencias)
      .set({ estadoa_codigo: "CANCELADA" })
      .where({
        ID,
        empleado_ID: empleado.ID,
        origenRegistro: ORIGEN_AUTOSERVICIO,
        estadoa_codigo: "SOLICITADA",
      });
    if (filasActualizadas !== 1) {
      reject(
        req,
        409,
        "SOLICITUD_MODIFICADA_CONCURRENTEMENTE",
        "La solicitud cambió en otra sesión. Actualiza la información antes de continuar.",
      );
    }

    await cancelApproval(req, {
      processCode: PROCESS_CODES.ABSENCE,
      businessObjectType: BUSINESS_OBJECT_AUSENCIA,
      businessObjectID: ID,
      idempotencyKey: `ABSENCE:${ID}:CANCEL`,
      actorUserID: req.user?.id,
      reason: "Cancelada por el empleado solicitante.",
    });

    const actualizada = await cargarSolicitudPropia(
      req,
      Ausencias,
      empleado.ID,
      ID,
    );

    return resultadoSolicitud(
      "La solicitud fue cancelada.",
      await enriquecerSolicitud({
        solicitud: actualizada,
        TiposAusencia,
        EstadosAusencia,
        SoportesAusencia,
      }),
    );
  });

  this.on("eliminarBorrador", async (req) => {
    const empleado = await obtenerEmpleadoAutenticado(req, Empleados);
    await bloquearEmpleado(req, Empleados, empleado.ID);
    const ID = exigirID(req);
    const solicitud = await cargarSolicitudPropia(
      req,
      Ausencias,
      empleado.ID,
      ID,
    );

    exigirSolicitudAutoservicio(req, solicitud);

    if (solicitud.estadoa_codigo !== "BORRADOR") {
      reject(
        req,
        409,
        "SOLICITUD_NO_ELIMINABLE",
        "Solo puedes eliminar solicitudes que estén en borrador.",
      );
    }

    const solicitudEnriquecida = await enriquecerSolicitud({
      solicitud,
      TiposAusencia,
      EstadosAusencia,
      SoportesAusencia,
    });

    // La composición tiene ON DELETE CASCADE. Con el proveedor actual
    // (attachments kind db) esto también elimina los binarios del borrador.
    const filasEliminadas = await DELETE.from(Ausencias).where({
      ID,
      empleado_ID: empleado.ID,
      origenRegistro: ORIGEN_AUTOSERVICIO,
      estadoa_codigo: "BORRADOR",
    });
    if (filasEliminadas !== 1) {
      reject(
        req,
        409,
        "SOLICITUD_MODIFICADA_CONCURRENTEMENTE",
        "La solicitud cambió en otra sesión. Actualiza la información antes de continuar.",
      );
    }

    return resultadoSolicitud("El borrador fue eliminado.", {
      ...solicitudEnriquecida,
      puedeEditar: false,
      puedeEnviar: false,
      puedeCancelar: false,
      puedeEliminar: false,
    });
  });

  this.on("cargarSoporte", async (req) => {
    const { solicitudID, soporteID, contenido, mimeType } = req.data || {};

    if (!solicitudID || !soporteID || !contenido) {
      reject(
        req,
        400,
        "DATOS_SOPORTE_INCOMPLETOS",
        "Faltan solicitudID, soporteID o contenido.",
      );
    }

    const empleado = await obtenerEmpleadoAutenticado(req, Empleados);
    await bloquearEmpleado(req, Empleados, empleado.ID);

    const solicitud = await SELECT.one.from(Ausencias).where({
      ID: solicitudID,
      empleado_ID: empleado.ID,
    });

    if (!solicitud) {
      reject(
        req,
        404,
        "SOLICITUD_NO_ENCONTRADA",
        "La solicitud no existe o no pertenece al usuario.",
      );
    }

    exigirSolicitudAutoservicio(req, solicitud);

    if (solicitud.estadoa_codigo !== "BORRADOR") {
      reject(
        req,
        409,
        "SOPORTES_BLOQUEADOS",
        "Los soportes solo pueden cargarse mientras la solicitud está en borrador.",
      );
    }

    const soporte = await SELECT.one.from(SoportesAusencia).where({
      ID: soporteID,
      up__ID: solicitudID,
    });

    if (!soporte) {
      reject(req, 404, "SOPORTE_NO_ENCONTRADO", "El soporte no existe.");
    }

    const contenidoBuffer = Buffer.isBuffer(contenido)
      ? contenido
      : Buffer.from(contenido, "base64");

    if (!contenidoBuffer.length) {
      reject(req, 400, "ARCHIVO_VACIO", "El archivo recibido está vacío.");
    }

    const tipoMime = mimeType || soporte.mimeType;

    await UPDATE(SoportesAusencia)
      .set({
        content: contenidoBuffer,
        mimeType: tipoMime,
        status: "Scanning",
        lastScan: null,
        hash: null,
        note: null,
      })
      .where({
        ID: soporteID,
        up__ID: solicitudID,
      });

    let scanResult;

    try {
      const malwareScanner = await cds.connect.to("malwareScanner");
      const archivoStream = Readable.from([contenidoBuffer]);

      scanResult = await malwareScanner.send("scan", {
        file: archivoStream,
      });
    } catch (error) {
      await UPDATE(SoportesAusencia)
        .set({
          status: "Failed",
          lastScan: new Date().toISOString(),
          note: String(
            error?.message || "No fue posible escanear el archivo.",
          ).slice(0, 500),
        })
        .where({
          ID: soporteID,
          up__ID: solicitudID,
        });

      cds
        .log("employee-absence-service")
        .error("Falló el escaneo del soporte", {
          solicitudID,
          soporteID,
          message: error?.message,
          code: error?.code,
          stack: error?.stack,
        });

      reject(
        req,
        502,
        "ESCANEO_SOPORTE_FALLIDO",
        "No fue posible validar el archivo con el servicio de seguridad.",
      );
    }

    const esMalware = Boolean(scanResult?.isMalware);

    await UPDATE(SoportesAusencia)
      .set({
        status: esMalware ? "Infected" : "Clean",
        lastScan: new Date().toISOString(),
        hash: scanResult?.hash || null,
        note: esMalware
          ? "El servicio de seguridad detectó contenido malicioso."
          : null,
      })
      .where({
        ID: soporteID,
        up__ID: solicitudID,
      });

    if (esMalware) {
      reject(
        req,
        422,
        "ARCHIVO_INFECTADO",
        "El archivo fue rechazado porque contiene contenido potencialmente malicioso.",
      );
    }

    return true;
  });

  this.on("descargarSoporte", async (req) => {
    const { solicitudID, soporteID } = req.data || {};

    if (!solicitudID || !soporteID) {
      reject(
        req,
        400,
        "DATOS_SOPORTE_INCOMPLETOS",
        "Faltan solicitudID o soporteID.",
      );
    }

    const empleado = await obtenerEmpleadoAutenticado(req, Empleados);

    const solicitud = await SELECT.one.from(Ausencias).columns("ID").where({
      ID: solicitudID,
      empleado_ID: empleado.ID,
    });

    if (!solicitud) {
      reject(
        req,
        404,
        "SOLICITUD_NO_ENCONTRADA",
        "La solicitud no existe o no pertenece al usuario.",
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
      contenidoBuffer = await streamABuffer(soporte.content);
    } catch (error) {
      cds
        .log("employee-absence-service")
        .error("No fue posible leer el contenido del soporte", {
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

  this.on("eliminarSoporte", async (req) => {
    const { solicitudID, soporteID } = req.data || {};

    if (!solicitudID || !soporteID) {
      return req.reject(400, "Faltan solicitudID o soporteID.");
    }

    const empleado = await obtenerEmpleadoAutenticado(req, Empleados);
    await bloquearEmpleado(req, Empleados, empleado.ID);

    const solicitud = await SELECT.one.from(Ausencias).where({
      ID: solicitudID,
      empleado_ID: empleado.ID,
    });

    if (!solicitud) {
      return req.reject(
        404,
        "La solicitud no existe o no pertenece al usuario.",
      );
    }

    exigirSolicitudAutoservicio(req, solicitud);

    if (solicitud.estadoa_codigo !== "BORRADOR") {
      return req.reject(
        409,
        "Solo puedes eliminar soportes de una solicitud en borrador.",
      );
    }

    const filasEliminadas = await DELETE.from(SoportesAusencia).where({
      ID: soporteID,
      up__ID: solicitudID,
    });

    if (filasEliminadas !== 1) {
      return req.reject(404, "El soporte no existe o ya fue eliminado.");
    }

    return true;
  });
});

function reject(req, status, code, message, target) {
  const error = { status, code, message };
  if (target) error.target = target;
  return req.reject(error);
}

function exigirID(req) {
  const ID = req.data?.ID;
  if (!ID) {
    reject(
      req,
      400,
      "ID_REQUERIDO",
      "Debes indicar el identificador de la solicitud.",
      "ID",
    );
  }
  return ID;
}

function exigirSolicitudAutoservicio(req, solicitud) {
  if (solicitud?.origenRegistro === ORIGEN_AUTOSERVICIO) return;

  reject(
    req,
    409,
    "SOLICITUD_HISTORICA_SOLO_LECTURA",
    "Las ausencias históricas registradas por RR. HH. son de solo lectura en el autoservicio.",
  );
}

function normalizarCorreo(value) {
  return value.trim().toLocaleLowerCase("es-CO");
}

function obtenerCorreoAutenticado(req) {
  const candidatos = [
    req.user?.attr?.email,
    req.user?.attr?.mail,
    req.user?.attr?.emailAddress,
    req.user?.id,
  ];

  const correo = candidatos.find(
    (value) => typeof value === "string" && value.includes("@"),
  );

  if (!correo) {
    reject(
      req,
      403,
      "CORREO_AUTENTICADO_NO_DISPONIBLE",
      "No fue posible obtener el correo del usuario autenticado.",
    );
  }

  return normalizarCorreo(correo);
}

async function obtenerEmpleadoAutenticado(req, Empleados) {
  const correo = obtenerCorreoAutenticado(req);

  let empleado = await SELECT.one
    .from(Empleados)
    .columns(...COLUMNAS_EMPLEADO_AUTENTICADO)
    .where({ correoCorporativo: correo });

  if (!empleado) {
    const empleados = await SELECT.from(Empleados).columns(
      ...COLUMNAS_EMPLEADO_AUTENTICADO,
    );
    empleado = empleados.find(
      (row) =>
        typeof row.correoCorporativo === "string" &&
        normalizarCorreo(row.correoCorporativo) === correo,
    );
  }

  if (!empleado) {
    reject(
      req,
      403,
      "EMPLEADO_NO_ASOCIADO",
      `No existe un empleado asociado al correo corporativo ${correo}.`,
    );
  }

  return empleado;
}

async function bloquearEmpleado(req, Empleados, empleadoID) {
  const empleadoBloqueado = await SELECT.one
    .from(Empleados)
    .columns(...COLUMNAS_EMPLEADO_AUTENTICADO)
    .where({ ID: empleadoID })
    .forUpdate({ wait: 10 });

  if (!empleadoBloqueado) {
    reject(
      req,
      403,
      "EMPLEADO_NO_DISPONIBLE",
      "El empleado asociado al usuario ya no existe.",
    );
  }

  const correoAutenticado = obtenerCorreoAutenticado(req);
  if (
    typeof empleadoBloqueado.correoCorporativo !== "string" ||
    normalizarCorreo(empleadoBloqueado.correoCorporativo) !== correoAutenticado
  ) {
    reject(
      req,
      403,
      "EMPLEADO_DESVINCULADO",
      "El correo corporativo del empleado cambió mientras se procesaba la solicitud. Vuelve a iniciar la operación.",
    );
  }

  return empleadoBloqueado;
}

function normalizarCodigo(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizarMotivo(value) {
  if (typeof value !== "string") return null;
  return value.trim() || null;
}

function construirPeriodoAprobacion({
  fechaInicio,
  fechaFin,
  horaInicio,
  horaFin,
  unidadConsumo,
}) {
  const inicio = formatearFechaAprobacion(fechaInicio);
  const fin = formatearFechaAprobacion(fechaFin);

  if (unidadConsumo === "HORAS") {
    const rangoHoras = [horaInicio, horaFin]
      .map((hora) => (typeof hora === "string" ? hora.slice(0, 5) : ""))
      .filter(Boolean)
      .join(" – ");
    return rangoHoras ? `${inicio} · ${rangoHoras}` : inicio;
  }

  return fechaInicio === fechaFin ? inicio : `${inicio} – ${fin}`;
}

function construirCantidadAprobacion({
  diasHabiles,
  horasSolicitadas,
  unidadConsumo,
}) {
  const cantidad = Number(
    unidadConsumo === "HORAS" ? horasSolicitadas : diasHabiles,
  );
  const valor = Number.isFinite(cantidad)
    ? cantidad.toLocaleString("es-CO", { maximumFractionDigits: 2 })
    : "0";
  const unidad = unidadConsumo === "HORAS" ? "horas" : "días hábiles";
  return `${valor} ${unidad}`;
}

function formatearFechaAprobacion(value) {
  if (!isValidISODate(value)) return String(value || "");
  const [anio, mes, dia] = value.split("-");
  return `${dia}/${mes}/${anio}`;
}

async function obtenerTipoAusencia(req, TiposAusencia, codigo) {
  if (!codigo) {
    reject(
      req,
      400,
      "TIPO_AUSENCIA_REQUERIDO",
      "Selecciona un tipo de ausencia.",
      "tipoAusenciaCodigo",
    );
  }

  const tipo = await SELECT.one.from(TiposAusencia).where({ codigo });
  if (!tipo) {
    reject(
      req,
      400,
      "TIPO_AUSENCIA_INVALIDO",
      "Selecciona un tipo de ausencia configurado en el catálogo.",
      "tipoAusenciaCodigo",
    );
  }

  return tipo;
}

async function construirDatosCanonicos({
  req,
  input,
  tipo,
  empleado,
  Contratos,
  fechaActual,
}) {
  const fechaInicio = input.fechaInicio;
  if (!isValidISODate(fechaInicio)) {
    reject(
      req,
      400,
      "FECHA_INICIO_INVALIDA",
      "Indica una fecha inicial válida con formato YYYY-MM-DD.",
      "fechaInicio",
    );
  }

  const unidadConsumo = tipo.unidadConsumo || "DIAS";
  let fechaFin = input.fechaFin;
  let horaInicio = null;
  let horaFin = null;
  let horasSolicitadas = 0;
  let diasHabiles = 0;

  if (unidadConsumo === "HORAS" && tipo.requiereMismoDia) {
    fechaFin = fechaInicio;
  }

  if (!isValidISODate(fechaFin)) {
    reject(
      req,
      400,
      "FECHA_FIN_INVALIDA",
      "Indica una fecha final válida con formato YYYY-MM-DD.",
      "fechaFin",
    );
  }

  if (fechaFin < fechaInicio) {
    reject(
      req,
      400,
      "FECHA_FIN_AUSENCIA_INVALIDA",
      "La fecha final no puede ser anterior a la fecha inicial.",
      "fechaFin",
    );
  }

  if (
    tipo.permiteCruzarAnio === false &&
    fechaInicio.slice(0, 4) !== fechaFin.slice(0, 4)
  ) {
    reject(
      req,
      400,
      "CRUCE_ANIO_NO_PERMITIDO",
      `${tipo.descripcion} no puede cruzar de un año a otro.`,
      "fechaFin",
    );
  }

  if (unidadConsumo === "HORAS") {
    if (tipo.requiereMismoDia && fechaFin !== fechaInicio) {
      reject(
        req,
        400,
        "MISMO_DIA_REQUERIDO",
        `${tipo.descripcion} debe solicitarse para una sola fecha.`,
        "fechaFin",
      );
    }

    if (!input.horaInicio) {
      reject(
        req,
        400,
        "HORA_INICIO_REQUERIDA",
        "Indica la hora inicial.",
        "horaInicio",
      );
    }

    if (!input.horaFin) {
      reject(
        req,
        400,
        "HORA_FIN_REQUERIDA",
        "Indica la hora final.",
        "horaFin",
      );
    }

    if (tieneSegundos(input.horaInicio) || tieneSegundos(input.horaFin)) {
      reject(
        req,
        400,
        "SOLO_HORAS_MINUTOS",
        "Las horas solo admiten minutos; los segundos deben ser 00.",
        tieneSegundos(input.horaInicio) ? "horaInicio" : "horaFin",
      );
    }

    horaInicio = normalizarHora(input.horaInicio);
    horaFin = normalizarHora(input.horaFin);
    if (!horaInicio || !horaFin) {
      reject(
        req,
        400,
        "HORARIO_INVALIDO",
        "Indica horas válidas con formato HH:mm.",
        !horaInicio ? "horaInicio" : "horaFin",
      );
    }

    horasSolicitadas = calcularHorasSolicitadas(horaInicio, horaFin);
    if (horasSolicitadas <= 0) {
      reject(
        req,
        400,
        "HORA_FIN_INVALIDA",
        "La hora final debe ser posterior a la hora inicial.",
        "horaFin",
      );
    }

    const minimoHorasSolicitud = Number(tipo.minimoHorasSolicitud || 0);
    if (minimoHorasSolicitud > 0 && horasSolicitadas < minimoHorasSolicitud) {
      reject(
        req,
        400,
        "MINIMO_HORAS_SOLICITUD_NO_ALCANZADO",
        `${tipo.descripcion} debe solicitarse por mínimo ${minimoHorasSolicitud.toFixed(2)} horas.`,
        "horaFin",
      );
    }

    const maximoHorasSolicitud = Number(tipo.maximoHorasDia || 0);
    if (maximoHorasSolicitud > 0 && horasSolicitadas > maximoHorasSolicitud) {
      reject(
        req,
        400,
        "MAXIMO_HORAS_SOLICITUD_EXCEDIDO",
        `Cada solicitud de ${tipo.descripcion} puede ser de máximo ${maximoHorasSolicitud.toFixed(2)} horas.`,
        "horaFin",
      );
    }
  } else {
    diasHabiles = calcularDiasHabilesColombia(fechaInicio, fechaFin);
  }

  const minimoAnticipacion = Number(tipo.diasAnticipacion || 0);
  if (minimoAnticipacion > 0) {
    const anticipacion = calcularDiasAnticipacion(
      fechaActual,
      fechaInicio,
      tipo.tipoDiasAnticipacion,
    );

    if (anticipacion < minimoAnticipacion) {
      reject(
        req,
        400,
        "ANTICIPACION_INSUFICIENTE",
        `${tipo.descripcion} debe solicitarse con mínimo ${minimoAnticipacion} días de anticipación.`,
        "fechaInicio",
      );
    }
  }

  if (tipo.politicaFecha === POLITICA_SEMANA_CUMPLEANOS) {
    const ventana = obtenerOcurrenciaCumpleaniosParaFecha(
      empleado.fechaNacimiento,
      fechaInicio,
    );

    if (!empleado.fechaNacimiento) {
      reject(
        req,
        409,
        "FECHA_NACIMIENTO_REQUERIDA",
        "No puedes usar el beneficio de cumpleaños hasta que RR. HH. registre tu fecha de nacimiento.",
        "fechaInicio",
      );
    }

    if (!ventana) {
      reject(
        req,
        400,
        "FUERA_DE_SEMANA_CUMPLEANIOS",
        "El beneficio de cumpleaños solo puede solicitarse de lunes a domingo en la misma semana del cumpleaños.",
        "fechaInicio",
      );
    }

    if (horasSolicitadas !== 4) {
      reject(
        req,
        400,
        "DURACION_CUMPLEANIOS_INVALIDA",
        "El beneficio de cumpleaños debe solicitarse por exactamente 4 horas continuas.",
        "horaFin",
      );
    }

    await validarElegibilidadCumpleanios({
      req,
      empleado,
      Contratos,
      fechaBeneficio: fechaInicio,
    });
  }

  return {
    unidadConsumo,
    fechaInicio,
    fechaFin,
    horaInicio,
    horaFin,
    diasHabiles,
    horasSolicitadas,
  };
}

async function validarElegibilidadCumpleanios({
  req,
  empleado,
  Contratos,
  fechaBeneficio,
}) {
  const resultado = await evaluarElegibilidadCumpleanios({
    empleado,
    Contratos,
    fechaBeneficio,
  });
  if (!resultado.elegible) {
    reject(req, 409, resultado.codigo, resultado.mensaje, resultado.target);
  }
}

async function evaluarElegibilidadCumpleanios({
  empleado,
  Contratos,
  fechaBeneficio,
}) {
  if (empleado.estado_codigo !== "AC") {
    return {
      elegible: false,
      codigo: "EMPLEADO_NO_ACTIVO",
      mensaje:
        "El beneficio de cumpleaños está disponible únicamente para empleados activos.",
    };
  }

  if (
    !empleado.fechaIngreso ||
    empleado.fechaIngreso > fechaBeneficio ||
    (empleado.fechaRetiro && empleado.fechaRetiro < fechaBeneficio)
  ) {
    return {
      elegible: false,
      codigo: "EMPLEADO_NO_ACTIVO_EN_FECHA_SOLICITADA",
      mensaje:
        "No existe una relación laboral activa para la fecha seleccionada.",
      target: "fechaInicio",
    };
  }

  const contratos = await SELECT.from(Contratos)
    .columns("ID", "fechaInicio", "fechaFin", "vigente")
    .where({ empleado_ID: empleado.ID, vigente: true });
  const contratoVigente = contratos.some(
    (contrato) =>
      contrato.fechaInicio <= fechaBeneficio &&
      (!contrato.fechaFin || contrato.fechaFin >= fechaBeneficio),
  );

  if (!contratoVigente) {
    return {
      elegible: false,
      codigo: "CONTRATO_VIGENTE_REQUERIDO",
      mensaje:
        "El beneficio de cumpleaños requiere un contrato vigente en la fecha seleccionada.",
      target: "fechaInicio",
    };
  }

  return { elegible: true };
}

async function evaluarElegibilidadVentanaCumpleanios({
  empleado,
  Contratos,
  ventana,
}) {
  if (
    empleado.estado_codigo !== "AC" ||
    !empleado.fechaIngreso ||
    !ventana?.semanaInicio ||
    !ventana?.semanaFin
  ) {
    return { elegible: false };
  }

  const inicioRelacion =
    empleado.fechaIngreso > ventana.semanaInicio
      ? empleado.fechaIngreso
      : ventana.semanaInicio;
  const finRelacion =
    empleado.fechaRetiro && empleado.fechaRetiro < ventana.semanaFin
      ? empleado.fechaRetiro
      : ventana.semanaFin;
  if (inicioRelacion > finRelacion) return { elegible: false };

  const contratos = await SELECT.from(Contratos)
    .columns("fechaInicio", "fechaFin")
    .where({ empleado_ID: empleado.ID, vigente: true });
  const contratoCubreAlgunDia = contratos.some(
    (contrato) =>
      contrato.fechaInicio <= finRelacion &&
      (!contrato.fechaFin || contrato.fechaFin >= inicioRelacion),
  );

  return { elegible: contratoCubreAlgunDia };
}

async function validarReglasDeEnvio({
  req,
  empleado,
  solicitud,
  tipo,
  Ausencias,
  TiposAusencia,
  Contratos,
  TiposContrato,
  SaldosValeraEmocional,
}) {
  const ausencias = await SELECT.from(Ausencias)
    .columns(
      "ID",
      "tipoAusencia_codigo",
      "estadoa_codigo",
      "fechaInicio",
      "fechaFin",
      "horaInicio",
      "horaFin",
      "horasSolicitadas",
      "diasHabiles",
      "unidadConsumo",
    )
    .where({ empleado_ID: empleado.ID });

  const efectivas = ausencias.filter(
    (ausencia) =>
      ausencia.ID !== solicitud.ID &&
      ESTADOS_CONSUMO_AUSENCIA.has(ausencia.estadoa_codigo),
  );

  const tipos = await SELECT.from(TiposAusencia).columns(
    "codigo",
    "unidadConsumo",
    "politicaFecha",
  );
  const unidadPorTipo = new Map(
    tipos.map((row) => [row.codigo, row.unidadConsumo || "DIAS"]),
  );
  const politicaPorTipo = new Map(
    tipos.map((row) => [row.codigo, row.politicaFecha || "LIBRE"]),
  );

  const superpuesta = efectivas.find((existente) => {
    if (
      !fechasSeCruzan(
        solicitud.fechaInicio,
        solicitud.fechaFin,
        existente.fechaInicio,
        existente.fechaFin,
      )
    ) {
      return false;
    }

    const unidadExistente =
      existente.unidadConsumo ||
      unidadPorTipo.get(existente.tipoAusencia_codigo) ||
      "DIAS";

    if (
      solicitud.unidadConsumo === "HORAS" &&
      unidadExistente === "HORAS" &&
      solicitud.fechaInicio === solicitud.fechaFin &&
      existente.fechaInicio === existente.fechaFin &&
      solicitud.fechaInicio === existente.fechaInicio
    ) {
      return horasSeCruzan(
        solicitud.horaInicio,
        solicitud.horaFin,
        existente.horaInicio,
        existente.horaFin,
      );
    }

    return true;
  });

  if (superpuesta) {
    reject(
      req,
      409,
      "AUSENCIA_SUPERPUESTA",
      "La solicitud se cruza con otra ausencia del empleado.",
      solicitud.unidadConsumo === "HORAS" ? "horaInicio" : "fechaInicio",
    );
  }

  if (solicitud.unidadConsumo === "HORAS") {
    const compartePoliticaCumpleanios =
      tipo.politicaFecha === POLITICA_SEMANA_CUMPLEANOS;
    const mismoTipo = efectivas.filter((ausencia) =>
      compartePoliticaCumpleanios
        ? politicaPorTipo.get(ausencia.tipoAusencia_codigo) ===
          POLITICA_SEMANA_CUMPLEANOS
        : ausencia.tipoAusencia_codigo === tipo.codigo,
    );
    const maximoHorasDia = Number(tipo.maximoHorasDia || 0);
    const horasMismoDia = round2(
      mismoTipo
        .filter((ausencia) => ausencia.fechaInicio === solicitud.fechaInicio)
        .reduce(
          (total, ausencia) => total + Number(ausencia.horasSolicitadas || 0),
          0,
        ),
    );

    if (
      maximoHorasDia > 0 &&
      round2(horasMismoDia + solicitud.horasSolicitadas) > maximoHorasDia
    ) {
      reject(
        req,
        409,
        "MAXIMO_HORAS_DIA_EXCEDIDO",
        `El máximo diario para ${tipo.descripcion} es ${maximoHorasDia.toFixed(2)} horas. Ya hay ${horasMismoDia.toFixed(2)} horas reservadas en esa fecha.`,
        "horaFin",
      );
    }

    const inicioSemana = obtenerInicioSemanaISO(solicitud.fechaInicio);
    const finSemana = formatISODate(addDays(parseISODate(inicioSemana), 6));
    const ausenciasSemana = mismoTipo.filter(
      (ausencia) =>
        ausencia.fechaInicio >= inicioSemana &&
        ausencia.fechaInicio <= finSemana,
    );
    const horasSemana = round2(
      ausenciasSemana.reduce(
        (total, ausencia) => total + Number(ausencia.horasSolicitadas || 0),
        0,
      ),
    );
    const maximoHorasSemana = Number(tipo.maximoHorasSemana || 0);

    if (
      maximoHorasSemana > 0 &&
      round2(horasSemana + solicitud.horasSolicitadas) > maximoHorasSemana
    ) {
      reject(
        req,
        409,
        "MAXIMO_HORAS_SEMANA_EXCEDIDO",
        `El máximo semanal para ${tipo.descripcion} es ${maximoHorasSemana.toFixed(2)} horas, de lunes a domingo. Ya hay ${horasSemana.toFixed(2)} horas reservadas.`,
        "horaFin",
      );
    }

    const maximoSolicitudesSemana = Number(tipo.maximoSolicitudesSemana || 0);
    if (
      maximoSolicitudesSemana > 0 &&
      ausenciasSemana.length + 1 > maximoSolicitudesSemana
    ) {
      reject(
        req,
        409,
        "MAXIMO_SOLICITUDES_SEMANA_EXCEDIDO",
        `El máximo para ${tipo.descripcion} es ${maximoSolicitudesSemana} solicitud(es) por semana.`,
        "fechaInicio",
      );
    }

    if (tipo.codigo === CODIGO_VALERA) {
      const saldo = await calcularSaldoValera({
        empleadoID: empleado.ID,
        anio: Number(solicitud.fechaInicio.slice(0, 4)),
        tipoValera: tipo,
        SaldosValeraEmocional,
        Ausencias,
        ausenciaExcluirID: solicitud.ID,
      });

      if (solicitud.horasSolicitadas > saldo.horasDisponibles) {
        reject(
          req,
          409,
          "SALDO_VALERA_INSUFICIENTE",
          `La solicitud es de ${Number(solicitud.horasSolicitadas).toFixed(2)} horas y el saldo de Valera disponible es ${saldo.horasDisponibles.toFixed(2)}.`,
          "horasSolicitadas",
        );
      }
    } else if (tipo.politicaFecha === POLITICA_SEMANA_CUMPLEANOS) {
      const ventana = obtenerOcurrenciaCumpleaniosParaFecha(
        empleado.fechaNacimiento,
        solicitud.fechaInicio,
      );
      const saldo = await calcularSaldoCumpleanios({
        empleado,
        ventana,
        tipoCumpleanios: tipo,
        TiposAusencia,
        Ausencias,
        ausenciaExcluirID: solicitud.ID,
      });

      if (saldo.cantidadSolicitudesEfectivas > 0) {
        reject(
          req,
          409,
          "CUMPLEANIOS_YA_SOLICITADO",
          `El beneficio de cumpleaños para ${ventana.anioOcurrencia} ya fue solicitado.`,
          "fechaInicio",
        );
      }

      if (solicitud.horasSolicitadas > saldo.horasDisponibles) {
        reject(
          req,
          409,
          "SALDO_CUMPLEANIOS_INSUFICIENTE",
          "El beneficio de cumpleaños de esta ocurrencia ya no tiene horas disponibles.",
          "horasSolicitadas",
        );
      }
    } else if (tipo.controlaSaldoHoras && Number(tipo.horasAnuales || 0) > 0) {
      const anio = Number(solicitud.fechaInicio.slice(0, 4));
      const consumidas = round2(
        mismoTipo
          .filter(
            (ausencia) => Number(ausencia.fechaInicio?.slice(0, 4)) === anio,
          )
          .reduce(
            (total, ausencia) => total + Number(ausencia.horasSolicitadas || 0),
            0,
          ),
      );
      const disponibles = round2(Number(tipo.horasAnuales) - consumidas);
      if (solicitud.horasSolicitadas > disponibles) {
        reject(
          req,
          409,
          "SALDO_HORAS_INSUFICIENTE",
          `La solicitud supera el saldo disponible de ${disponibles.toFixed(2)} horas para ${tipo.descripcion}.`,
          "horasSolicitadas",
        );
      }
    }
  } else if (tipo.descuentaSaldo && Number(solicitud.diasHabiles) > 0) {
    const saldo = await calcularSaldoVacaciones({
      empleadoID: empleado.ID,
      ausenciaExcluirID: solicitud.ID,
      Contratos,
      TiposContrato,
      TiposAusencia,
      Ausencias,
      fechaActual: todayInColombia(),
    });

    if (Number(solicitud.diasHabiles) > saldo.diasVacacionesDisponibles) {
      reject(
        req,
        409,
        "SALDO_VACACIONES_INSUFICIENTE",
        `La solicitud es de ${Number(solicitud.diasHabiles).toFixed(2)} días y el saldo disponible es ${saldo.diasVacacionesDisponibles.toFixed(2)}.`,
        "diasHabiles",
      );
    }
  }
}

async function calcularSaldoValera({
  empleadoID,
  anio,
  tipoValera,
  SaldosValeraEmocional,
  Ausencias,
  ausenciaExcluirID = null,
}) {
  if (!empleadoID || !anio || !tipoValera) {
    return {
      horasAsignadas: 0,
      horasUtilizadas: 0,
      horasReservadas: 0,
      horasDisponibles: 0,
    };
  }

  const [saldoConfigurado, ausencias] = await Promise.all([
    SELECT.one
      .from(SaldosValeraEmocional)
      .where({ empleado_ID: empleadoID, anio }),
    SELECT.from(Ausencias)
      .columns("ID", "estadoa_codigo", "fechaInicio", "horasSolicitadas")
      .where({
        empleado_ID: empleadoID,
        tipoAusencia_codigo: CODIGO_VALERA,
      }),
  ]);

  const horasBase = Number(
    saldoConfigurado?.horasBase ?? tipoValera.horasAnuales ?? 0,
  );
  const horasAsignadas = round2(
    horasBase + Number(saldoConfigurado?.horasAjuste || 0),
  );
  const delAnio = ausencias.filter(
    (ausencia) =>
      ausencia.ID !== ausenciaExcluirID &&
      Number(ausencia.fechaInicio?.slice(0, 4)) === anio,
  );
  const horasUtilizadas = round2(
    delAnio
      .filter((ausencia) =>
        ESTADOS_UTILIZACION_AUSENCIA.has(ausencia.estadoa_codigo),
      )
      .reduce(
        (total, ausencia) => total + Number(ausencia.horasSolicitadas || 0),
        0,
      ),
  );
  const horasReservadas = round2(
    delAnio
      .filter((ausencia) =>
        ESTADOS_RESERVA_AUSENCIA.has(ausencia.estadoa_codigo),
      )
      .reduce(
        (total, ausencia) => total + Number(ausencia.horasSolicitadas || 0),
        0,
      ),
  );

  return {
    horasAsignadas,
    horasUtilizadas,
    horasReservadas,
    horasDisponibles: round2(
      horasAsignadas - horasUtilizadas - horasReservadas,
    ),
  };
}

async function calcularSaldoCumpleanios({
  empleado,
  ventana,
  tipoCumpleanios,
  TiposAusencia,
  Ausencias,
  ausenciaExcluirID = null,
}) {
  if (
    !empleado?.ID ||
    !empleado.fechaNacimiento ||
    !ventana ||
    !tipoCumpleanios
  ) {
    return {
      horasAsignadas: 0,
      horasUtilizadas: 0,
      horasReservadas: 0,
      horasDisponibles: 0,
      cantidadSolicitudesEfectivas: 0,
    };
  }

  const tiposMismaPolitica = TiposAusencia
    ? await SELECT.from(TiposAusencia)
        .columns("codigo")
        .where({ politicaFecha: POLITICA_SEMANA_CUMPLEANOS })
    : [];
  const codigosMismaPolitica = new Set([
    tipoCumpleanios.codigo,
    ...tiposMismaPolitica.map((tipo) => tipo.codigo),
  ]);

  const ausencias = await SELECT.from(Ausencias)
    .columns(
      "ID",
      "tipoAusencia_codigo",
      "estadoa_codigo",
      "fechaInicio",
      "horasSolicitadas",
    )
    .where({ empleado_ID: empleado.ID });

  const efectivasOcurrencia = ausencias.filter((ausencia) => {
    if (
      ausencia.ID === ausenciaExcluirID ||
      !codigosMismaPolitica.has(ausencia.tipoAusencia_codigo) ||
      !ESTADOS_CONSUMO_AUSENCIA.has(ausencia.estadoa_codigo)
    ) {
      return false;
    }

    const ocurrencia = obtenerOcurrenciaCumpleaniosParaFecha(
      empleado.fechaNacimiento,
      ausencia.fechaInicio,
    );
    return ocurrencia?.anioOcurrencia === ventana.anioOcurrencia;
  });

  const horasAsignadas = round2(Number(tipoCumpleanios.horasAnuales ?? 4));
  const horasUtilizadas = round2(
    efectivasOcurrencia
      .filter((ausencia) =>
        ESTADOS_UTILIZACION_CUMPLEANIOS.has(ausencia.estadoa_codigo),
      )
      .reduce(
        (total, ausencia) => total + Number(ausencia.horasSolicitadas || 0),
        0,
      ),
  );
  const horasReservadas = round2(
    efectivasOcurrencia
      .filter((ausencia) =>
        ESTADOS_RESERVA_CUMPLEANIOS.has(ausencia.estadoa_codigo),
      )
      .reduce(
        (total, ausencia) => total + Number(ausencia.horasSolicitadas || 0),
        0,
      ),
  );

  return {
    horasAsignadas,
    horasUtilizadas,
    horasReservadas,
    horasDisponibles: round2(
      horasAsignadas - horasUtilizadas - horasReservadas,
    ),
    cantidadSolicitudesEfectivas: efectivasOcurrencia.length,
  };
}

async function calcularSaldoVacaciones({
  empleadoID,
  ausenciaExcluirID = null,
  Contratos,
  TiposContrato,
  TiposAusencia,
  Ausencias,
  fechaActual,
}) {
  const resultadoVacio = {
    diasVacacionesCausados: 0,
    diasVacacionesDisfrutados: 0,
    diasVacacionesReservados: 0,
    diasVacacionesDisponibles: 0,
  };
  if (!empleadoID) return resultadoVacio;

  const contratosVigentes = await SELECT.from(Contratos)
    .columns("tipoContrato_codigo", "fechaInicio", "fechaFin", "vigente")
    .where({ empleado_ID: empleadoID, vigente: true });
  if (contratosVigentes.length === 0) return resultadoVacio;

  const tiposContrato = await SELECT.from(TiposContrato).columns(
    "codigo",
    "causaVacaciones",
  );
  const tiposQueCausan = new Set(
    tiposContrato
      .filter((tipo) => tipo.causaVacaciones === true)
      .map((tipo) => tipo.codigo),
  );
  const contratosValidos = contratosVigentes.filter(
    (contrato) =>
      contrato.fechaInicio &&
      contrato.fechaInicio <= fechaActual &&
      tiposQueCausan.has(contrato.tipoContrato_codigo),
  );
  if (contratosValidos.length === 0) return resultadoVacio;

  const diasTrabajados = contratosValidos.reduce((total, contrato) => {
    const fechaCorte =
      contrato.fechaFin && contrato.fechaFin < fechaActual
        ? contrato.fechaFin
        : fechaActual;
    if (fechaCorte < contrato.fechaInicio) return total;
    return (
      total +
      Math.max(
        0,
        Math.floor(
          (parseISODate(fechaCorte) - parseISODate(contrato.fechaInicio)) /
            (24 * 60 * 60 * 1000),
        ),
      )
    );
  }, 0);
  const diasVacacionesCausados = round2((diasTrabajados * 15) / 360);

  const tiposVacaciones = await SELECT.from(TiposAusencia)
    .columns("codigo")
    .where({ descuentaSaldo: true });
  const codigosVacaciones = new Set(tiposVacaciones.map((tipo) => tipo.codigo));
  const ausencias = await SELECT.from(Ausencias)
    .columns("ID", "tipoAusencia_codigo", "estadoa_codigo", "diasHabiles")
    .where({ empleado_ID: empleadoID });
  const vacaciones = ausencias.filter(
    (ausencia) =>
      ausencia.ID !== ausenciaExcluirID &&
      codigosVacaciones.has(ausencia.tipoAusencia_codigo),
  );
  const diasVacacionesDisfrutados = round2(
    vacaciones
      .filter((ausencia) =>
        ESTADOS_UTILIZACION_AUSENCIA.has(ausencia.estadoa_codigo),
      )
      .reduce(
        (total, ausencia) => total + Number(ausencia.diasHabiles || 0),
        0,
      ),
  );
  const diasVacacionesReservados = round2(
    vacaciones
      .filter((ausencia) =>
        ESTADOS_RESERVA_AUSENCIA.has(ausencia.estadoa_codigo),
      )
      .reduce(
        (total, ausencia) => total + Number(ausencia.diasHabiles || 0),
        0,
      ),
  );

  return {
    diasVacacionesCausados,
    diasVacacionesDisfrutados,
    diasVacacionesReservados,
    diasVacacionesDisponibles: round2(
      diasVacacionesCausados -
        diasVacacionesDisfrutados -
        diasVacacionesReservados,
    ),
  };
}

async function cargarSolicitudPropia(req, Ausencias, empleadoID, ID) {
  const solicitud = await SELECT.one.from(Ausencias).where({
    ID,
    empleado_ID: empleadoID,
  });

  if (!solicitud) {
    reject(
      req,
      404,
      "SOLICITUD_NO_ENCONTRADA",
      "La solicitud no existe o no pertenece al empleado autenticado.",
    );
  }

  return solicitud;
}

async function enriquecerSolicitudes({
  solicitudes,
  TiposAusencia,
  EstadosAusencia,
  SoportesAusencia,
  decisionesPorID = {},
}) {
  const [tipos, estados, conteos] = await Promise.all([
    SELECT.from(TiposAusencia),
    SELECT.from(EstadosAusencia),
    contarSoportesPorSolicitudes(
      SoportesAusencia,
      solicitudes.map((solicitud) => solicitud.ID),
    ),
  ]);
  const tiposPorCodigo = new Map(tipos.map((tipo) => [tipo.codigo, tipo]));
  const estadosPorCodigo = new Map(
    estados.map((estado) => [estado.codigo, estado]),
  );

  return solicitudes
    .map((solicitud) =>
      mapSolicitud(
        solicitud,
        tiposPorCodigo.get(solicitud.tipoAusencia_codigo),
        estadosPorCodigo.get(solicitud.estadoa_codigo),
        conteos.get(solicitud.ID) || 0,
        decisionesPorID?.[solicitud.ID] || null,
      ),
    )
    .sort((a, b) =>
      String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")),
    );
}

async function enriquecerSolicitud({
  solicitud,
  TiposAusencia,
  EstadosAusencia,
  SoportesAusencia,
}) {
  const [tipo, estado, cantidadSoportes] = await Promise.all([
    SELECT.one.from(TiposAusencia).where({
      codigo: solicitud.tipoAusencia_codigo,
    }),
    SELECT.one.from(EstadosAusencia).where({
      codigo: solicitud.estadoa_codigo,
    }),
    contarSoportes(SoportesAusencia, solicitud.ID),
  ]);

  return mapSolicitud(solicitud, tipo, estado, cantidadSoportes);
}

function mapSolicitud(
  solicitud,
  tipo,
  estado,
  cantidadSoportes,
  decision = null,
) {
  const esAutoservicio = solicitud.origenRegistro === ORIGEN_AUTOSERVICIO;
  const esBorrador = esAutoservicio && solicitud.estadoa_codigo === "BORRADOR";
  return {
    ID: solicitud.ID,
    tipoAusenciaCodigo: solicitud.tipoAusencia_codigo,
    tipoAusenciaDescripcion: tipo?.descripcion ?? solicitud.tipoAusencia_codigo,
    unidadConsumo: solicitud.unidadConsumo || tipo?.unidadConsumo || "DIAS",
    fechaInicio: solicitud.fechaInicio,
    fechaFin: solicitud.fechaFin,
    horaInicio: solicitud.horaInicio,
    horaFin: solicitud.horaFin,
    diasHabiles: Number(solicitud.diasHabiles || 0),
    horasSolicitadas: Number(solicitud.horasSolicitadas || 0),
    estado: solicitud.estadoa_codigo,
    estadoDescripcion: estado?.descripcion ?? solicitud.estadoa_codigo,
    motivo: solicitud.motivo,
    decisionResultado: decision?.decision || null,
    decisionComentario: decision?.comment || null,
    decididaPorNombre: decision?.actorName || null,
    decisionActuandoPorNombre: decision?.actingForName || null,
    fechaDecision: decision?.decidedAt || null,
    requiereSoporte: Boolean(tipo?.requiereSoporte),
    cantidadSoportes,
    puedeEditar: esBorrador,
    puedeEnviar: esBorrador,
    puedeCancelar: esAutoservicio && solicitud.estadoa_codigo === "SOLICITADA",
    puedeEliminar: esBorrador,
    createdAt: solicitud.createdAt,
    modifiedAt: solicitud.modifiedAt,
  };
}

function resultadoSolicitud(mensaje, solicitud) {
  return { exito: true, mensaje, solicitud };
}

async function contarSoportes(SoportesAusencia, ausenciaID) {
  if (!SoportesAusencia || !ausenciaID) return 0;
  const rows = await SELECT.from(SoportesAusencia)
    .columns("ID")
    .where({ up__ID: ausenciaID });
  return rows.length;
}

async function obtenerEstadosSoportes(SoportesAusencia, ausenciaID) {
  if (!SoportesAusencia || !ausenciaID) return [];
  return SELECT.from(SoportesAusencia)
    .columns("ID", "status")
    .where({ up__ID: ausenciaID });
}

async function contarSoportesPorSolicitudes(SoportesAusencia, IDs) {
  const counts = new Map();
  if (!SoportesAusencia || IDs.length === 0) return counts;

  const rows = await SELECT.from(SoportesAusencia)
    .columns("ID", "up__ID")
    .where({ up__ID: { in: IDs } });
  rows.forEach((row) => {
    counts.set(row.up__ID, (counts.get(row.up__ID) || 0) + 1);
  });
  return counts;
}

function esPeticionDeSoporte(req, SoportesSrv) {
  if (req.target === SoportesSrv) return true;
  const name = req.target?.name || "";
  if (name.endsWith(".MisAusencias.soportes")) return true;

  const url = req._?.req?.url || req.req?.url || "";
  return /\/(?:MisAusencias(?:\([^)]*\))?\/soportes|MisAusencias_soportes)(?:\([^)]*\))?(?:\/content)?(?:\?|$)/i.test(
    url,
  );
}

async function validarMutacionSoporte(
  req,
  Empleados,
  Ausencias,
  SoportesAusencia,
) {
  const empleado = await obtenerEmpleadoAutenticado(req, Empleados);
  await bloquearEmpleado(req, Empleados, empleado.ID);
  const parentID = await obtenerAusenciaIDDeSoporte(req, SoportesAusencia);

  if (!parentID) {
    reject(
      req,
      400,
      "SOLICITUD_SOPORTE_NO_IDENTIFICADA",
      "No fue posible identificar la solicitud a la que pertenece el soporte.",
    );
  }

  let consultaAusencia = SELECT.one
    .from(Ausencias)
    .columns("ID", "empleado_ID", "origenRegistro", "estadoa_codigo")
    .where({ ID: parentID, empleado_ID: empleado.ID });

  // Serializa los POST de metadata para hacer efectivo el máximo de cinco
  // incluso cuando dos cargas se inician casi simultáneamente.
  if (req.event === "CREATE") {
    consultaAusencia = consultaAusencia.forUpdate({ wait: 10 });
  }

  const ausencia = await consultaAusencia;

  if (!ausencia) {
    reject(
      req,
      404,
      "SOLICITUD_NO_ENCONTRADA",
      "La solicitud no existe o no pertenece al empleado autenticado.",
    );
  }

  exigirSolicitudAutoservicio(req, ausencia);

  if (ausencia.estadoa_codigo !== "BORRADOR") {
    reject(
      req,
      409,
      "SOPORTES_BLOQUEADOS",
      "Los soportes solo pueden cargarse o eliminarse mientras la solicitud está en borrador.",
    );
  }

  if (
    req.event === "CREATE" &&
    (await contarSoportes(SoportesAusencia, parentID)) >= 5
  ) {
    reject(
      req,
      409,
      "MAXIMO_SOPORTES_EXCEDIDO",
      "Cada solicitud admite un máximo de cinco soportes.",
      "soportes",
    );
  }
}

async function obtenerAusenciaIDDeSoporte(req, SoportesAusencia) {
  const params = req.params || [];
  const explicitParent = params.find((param) => param?.up__ID)?.up__ID;
  if (explicitParent) return explicitParent;

  // En navegación, el primer segmento contiene la llave de MisAusencias.
  if (params.length > 1 && params[0]?.ID) return params[0].ID;
  if (req.event === "CREATE" && params[0]?.ID) return params[0].ID;

  if (req.data?.up__ID) return req.data.up__ID;
  if (req.data?.up_?.ID) return req.data.up_.ID;

  const attachmentID =
    req.data?.ID || [...params].reverse().find((param) => param?.ID)?.ID;
  if (!attachmentID) return null;

  const soporte = await SELECT.one
    .from(SoportesAusencia)
    .columns("up__ID")
    .where({ ID: attachmentID });
  return soporte?.up__ID || null;
}

function esPeticionDeContenidoSoporte(req) {
  const subjectRef = req.subject?.ref || [];
  const subjectTail = subjectRef.at(-1);
  const propertyName =
    typeof subjectTail === "string"
      ? subjectTail
      : subjectTail?.id || subjectTail?.ref?.at(-1);

  const url =
    req.req?.originalUrl ||
    req.req?.url ||
    req._?.req?.originalUrl ||
    req._?.req?.url ||
    "";

  return propertyName === "content" || /\/content(?:\?|$)/i.test(url);
}

async function streamABuffer(value) {
  if (value == null) {
    return null;
  }

  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }

  if (typeof value === "string") {
    return Buffer.from(value, "base64");
  }

  if (
    typeof value[Symbol.asyncIterator] === "function" ||
    typeof value.pipe === "function"
  ) {
    const chunks = [];

    for await (const chunk of value) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  throw new TypeError(
    `Formato de contenido no soportado: ${
      value?.constructor?.name || typeof value
    }`,
  );
}

module.exports._test = {
  calcularSaldoCumpleanios,
  calcularSaldoVacaciones,
  calcularSaldoValera,
  construirDatosCanonicos,
  mapSolicitud,
};
