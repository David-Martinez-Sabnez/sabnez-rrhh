"use strict";

const cds = require("@sap/cds");
const { SELECT } = cds.ql;

const NOMBRES_DIAS = [
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes"
];

module.exports = cds.service.impl(function () {
  const {
    Empleados,
    ConfiguracionHomeOffice,
    DiasHomeOffice,
    SeleccionesHomeOffice
  } = cds.entities("sabnez.rrhh");

  // ==========================================================
  // CONSULTAR SEMANA DISPONIBLE PARA EL EMPLEADO AUTENTICADO
  // ==========================================================

  this.on("obtenerMiSemana", async (req) => {
    const configuracion = await obtenerConfiguracion(
      req,
      ConfiguracionHomeOffice
    );

    const correo = obtenerCorreoAutenticado(req);

    const empleado = await buscarEmpleadoPorCorreo(
      Empleados,
      correo
    );

    if (!empleado) {
      return req.reject(
        403,
        `No existe un empleado asociado al correo corporativo ${correo}.`
      );
    }

    const ahora = new Date();

    const ciclo = calcularCicloSeleccion(
      ahora,
      configuracion
    );

    const semanaAnteriorInicio = sumarDias(
      ciclo.semanaObjetivoInicio,
      -7
    );

    /*
     * Consultamos:
     * 1. Configuración especial de capacidad por fecha.
     * 2. Todas las selecciones de la semana objetivo.
     * 3. Días confirmados por el empleado la semana anterior.
     */
    const [
      diasConfigurados,
      seleccionesSemana,
      seleccionesSemanaAnterior
    ] = await Promise.all([
      SELECT
        .from(DiasHomeOffice)
        .where({
          semanaInicio: ciclo.semanaObjetivoInicio
        }),

      SELECT
        .from(SeleccionesHomeOffice)
        .where({
          semanaInicio: ciclo.semanaObjetivoInicio
        }),

      SELECT
        .from(SeleccionesHomeOffice)
        .where({
          empleado_ID: empleado.ID,
          semanaInicio: semanaAnteriorInicio,
          estado: "CONFIRMADA"
        })
    ]);

    const seleccionesActivas =
      seleccionesSemana.filter((seleccion) =>
        esSeleccionActiva(seleccion, ahora)
      );

    const misSelecciones =
      seleccionesActivas.filter(
        (seleccion) =>
          seleccion.empleado_ID === empleado.ID
      );

    const misSeleccionesPorFecha = new Map(
      misSelecciones.map((seleccion) => [
        seleccion.fecha,
        seleccion
      ])
    );

    const ocupacionPorFecha = contarOcupacionPorFecha(
      seleccionesActivas
    );

    const capacidadPorFecha = new Map(
      diasConfigurados.map((dia) => [
        dia.fecha,
        Number(dia.capacidad)
      ])
    );

    const diasSemanaAnterior = new Set(
      seleccionesSemanaAnterior.map(
        (seleccion) => Number(seleccion.diaSemana)
      )
    );

    const maxDiasPermitidos = Number(
      configuracion.maxDiasPorSemana
    );

    const cuposPredeterminados = Number(
      configuracion.cuposPorDia
    );

    const resultado = [];

    for (let indice = 0; indice < 5; indice += 1) {
      const diaSemana = indice + 1;

      const fecha = sumarDias(
        ciclo.semanaObjetivoInicio,
        indice
      );

      const miSeleccion =
        misSeleccionesPorFecha.get(fecha);

      const seleccionadoPorMi =
        Boolean(miSeleccion);

      const cuposTotales =
        capacidadPorFecha.get(fecha) ??
        cuposPredeterminados;

      const cuposOcupados =
        ocupacionPorFecha.get(fecha) ?? 0;

      const cuposDisponibles = Math.max(
        cuposTotales - cuposOcupados,
        0
      );

      const bloqueadoSemanaAnterior =
        diasSemanaAnterior.has(diaSemana);

      const cupoCompleto =
        cuposOcupados >= cuposTotales;

      const disponibilidad = determinarDisponibilidad({
        ventanaAbierta: ciclo.ventanaAbierta,
        seleccionadoPorMi,
        bloqueadoSemanaAnterior,
        cupoCompleto,
        diasSeleccionados: misSelecciones.length,
        maxDiasPermitidos
      });

      resultado.push({
        fecha,
        semanaInicio: ciclo.semanaObjetivoInicio,
        diaSemana,
        nombreDia: NOMBRES_DIAS[indice],

        cuposTotales,
        cuposOcupados,
        cuposDisponibles,

        seleccionadoPorMi,
        estadoSeleccion:
          miSeleccion?.estado ?? null,

        tokenReserva:
          miSeleccion?.estado === "RESERVADA"
            ? miSeleccion.tokenReserva
            : null,

        reservaExpiraEn:
          miSeleccion?.estado === "RESERVADA"
            ? miSeleccion.reservaExpiraEn
            : null,

        bloqueadoSemanaAnterior,
        cupoCompleto,

        habilitado:
          disponibilidad.habilitado,

        motivoNoDisponible:
          disponibilidad.motivo,

        diasSeleccionados:
          misSelecciones.length,

        maxDiasPermitidos,

        ventanaAbierta:
          ciclo.ventanaAbierta,

        fechaHoraCierre:
          ciclo.fechaHoraCierre.toISOString()
      });
    }

    return resultado;
  });
});

// ============================================================
// CONFIGURACIÓN
// ============================================================

async function obtenerConfiguracion(
  req,
  ConfiguracionHomeOffice
) {
  const configuracion = await SELECT.one
    .from(ConfiguracionHomeOffice)
    .where({
      ID: "DEFAULT",
      activa: true
    });

  if (!configuracion) {
    return req.reject(
      500,
      "No existe una configuración activa de Home Office."
    );
  }

  return configuracion;
}

// ============================================================
// IDENTIDAD DEL EMPLEADO
// ============================================================

function obtenerCorreoAutenticado(req) {
  /*
   * Dependiendo del proveedor de identidad, el correo puede
   * aparecer como atributo o directamente como req.user.id.
   */
  const candidatos = [
    req.user?.attr?.email,
    req.user?.attr?.mail,
    req.user?.attr?.emailAddress,
    req.user?.id
  ];

  const correo = candidatos.find(
    (valor) =>
      typeof valor === "string" &&
      valor.includes("@")
  );

  if (!correo) {
    return req.reject(
      403,
      "No fue posible obtener el correo del usuario autenticado."
    );
  }

  return normalizarCorreo(correo);
}

async function buscarEmpleadoPorCorreo(
  Empleados,
  correo
) {
  /*
   * Primera búsqueda: coincidencia exacta.
   */
  const empleadoExacto = await SELECT.one
    .from(Empleados)
    .columns(
      "ID",
      "correoCorporativo",
      "nombreCompleto",
      "fechaIngreso",
      "fechaRetiro"
    )
    .where({
      correoCorporativo: correo
    });

  if (empleadoExacto) {
    return empleadoExacto;
  }

  /*
   * Respaldo temporal para los registros antiguos que puedan
   * tener mayúsculas o espacios en el correo.
   *
   * Cuando normalicemos todos los correos existentes,
   * podremos eliminar esta segunda consulta.
   */
  const empleados = await SELECT
    .from(Empleados)
    .columns(
      "ID",
      "correoCorporativo",
      "nombreCompleto",
      "fechaIngreso",
      "fechaRetiro"
    );

  return empleados.find(
    (empleado) =>
      normalizarCorreo(
        empleado.correoCorporativo
      ) === correo
  );
}

function normalizarCorreo(valor) {
  if (typeof valor !== "string") {
    return "";
  }

  return valor.trim().toLowerCase();
}

// ============================================================
// DISPONIBILIDAD DE LOS DÍAS
// ============================================================

function esSeleccionActiva(
  seleccion,
  ahora
) {
  if (seleccion.estado === "CONFIRMADA") {
    return true;
  }

  if (seleccion.estado !== "RESERVADA") {
    return false;
  }

  if (!seleccion.reservaExpiraEn) {
    return false;
  }

  const fechaExpiracion = new Date(
    seleccion.reservaExpiraEn
  );

  return fechaExpiracion.getTime() >
    ahora.getTime();
}

function contarOcupacionPorFecha(
  selecciones
) {
  const ocupacion = new Map();

  for (const seleccion of selecciones) {
    const cantidadActual =
      ocupacion.get(seleccion.fecha) ?? 0;

    ocupacion.set(
      seleccion.fecha,
      cantidadActual + 1
    );
  }

  return ocupacion;
}

function determinarDisponibilidad({
  ventanaAbierta,
  seleccionadoPorMi,
  bloqueadoSemanaAnterior,
  cupoCompleto,
  diasSeleccionados,
  maxDiasPermitidos
}) {
  if (!ventanaAbierta) {
    return {
      habilitado: false,
      motivo:
        "La ventana semanal de selección está cerrada."
    };
  }

  /*
   * Una selección existente debe seguir siendo interactiva
   * para que posteriormente pueda liberarse o cancelarse.
   */
  if (seleccionadoPorMi) {
    return {
      habilitado: true,
      motivo: null
    };
  }

  if (bloqueadoSemanaAnterior) {
    return {
      habilitado: false,
      motivo:
        "Seleccionaste este mismo día la semana anterior."
    };
  }

  if (
    diasSeleccionados >=
    maxDiasPermitidos
  ) {
    return {
      habilitado: false,
      motivo:
        `Ya seleccionaste los ${maxDiasPermitidos} días permitidos.`
    };
  }

  if (cupoCompleto) {
    return {
      habilitado: false,
      motivo:
        "No hay cupos disponibles para este día."
    };
  }

  return {
    habilitado: true,
    motivo: null
  };
}

// ============================================================
// CÁLCULO DE SEMANAS Y VENTANA
// ============================================================

function calcularCicloSeleccion(
  ahora,
  configuracion
) {
  const zonaHoraria =
    configuracion.zonaHoraria ||
    "America/Bogota";

  const partesLocales = obtenerPartesLocales(
    ahora,
    zonaHoraria
  );

  const fechaLocalActual = construirFechaISO({
    anio: partesLocales.anio,
    mes: partesLocales.mes,
    dia: partesLocales.dia
  });

  const diaSemanaActual =
    obtenerDiaSemanaISO(fechaLocalActual);

  const semanaActualInicio = sumarDias(
    fechaLocalActual,
    -(diaSemanaActual - 1)
  );

  const semanasAnticipacion = Number(
    configuracion.semanasAnticipacion ?? 1
  );

  const semanaObjetivoInicio = sumarDias(
    semanaActualInicio,
    semanasAnticipacion * 7
  );

  const fechaCierre = sumarDias(
    semanaActualInicio,
    Number(configuracion.diaCierre ?? 5) - 1
  );

  const fechaHoraApertura =
    convertirFechaLocalAUtc(
      semanaActualInicio,
      "00:00:00",
      zonaHoraria
    );

  const fechaHoraCierre =
    convertirFechaLocalAUtc(
      fechaCierre,
      normalizarHora(
        configuracion.horaCierre,
        "17:00:00"
      ),
      zonaHoraria
    );

  const ventanaAbierta =
    ahora.getTime() >=
      fechaHoraApertura.getTime() &&
    ahora.getTime() <
      fechaHoraCierre.getTime();

  return {
    semanaActualInicio,
    semanaObjetivoInicio,
    fechaHoraApertura,
    fechaHoraCierre,
    ventanaAbierta
  };
}

function obtenerPartesLocales(
  fecha,
  zonaHoraria
) {
  const formato =
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zonaHoraria,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });

  const partes = Object.fromEntries(
    formato
      .formatToParts(fecha)
      .filter(
        (parte) =>
          parte.type !== "literal"
      )
      .map((parte) => [
        parte.type,
        parte.value
      ])
  );

  return {
    anio: Number(partes.year),
    mes: Number(partes.month),
    dia: Number(partes.day),
    hora: Number(partes.hour),
    minuto: Number(partes.minute),
    segundo: Number(partes.second)
  };
}

function convertirFechaLocalAUtc(
  fechaISO,
  hora,
  zonaHoraria
) {
  const [anio, mes, dia] =
    fechaISO.split("-").map(Number);

  const [horas, minutos, segundos] =
    normalizarHora(
      hora,
      "00:00:00"
    )
      .split(":")
      .map(Number);

  const objetivoComoUtc = Date.UTC(
    anio,
    mes - 1,
    dia,
    horas,
    minutos,
    segundos
  );

  let aproximacion = objetivoComoUtc;

  /*
   * Ajustamos iterativamente la diferencia entre la fecha
   * solicitada en la zona local y su instante equivalente UTC.
   */
  for (let intento = 0;
    intento < 3;
    intento += 1) {
    const partes = obtenerPartesLocales(
      new Date(aproximacion),
      zonaHoraria
    );

    const representacionLocalComoUtc =
      Date.UTC(
        partes.anio,
        partes.mes - 1,
        partes.dia,
        partes.hora,
        partes.minuto,
        partes.segundo
      );

    aproximacion +=
      objetivoComoUtc -
      representacionLocalComoUtc;
  }

  return new Date(aproximacion);
}

function normalizarHora(
  valor,
  valorPredeterminado
) {
  if (!valor) {
    return valorPredeterminado;
  }

  if (typeof valor === "string") {
    return valor.substring(0, 8);
  }

  return valorPredeterminado;
}

function construirFechaISO({
  anio,
  mes,
  dia
}) {
  return [
    String(anio).padStart(4, "0"),
    String(mes).padStart(2, "0"),
    String(dia).padStart(2, "0")
  ].join("-");
}

function obtenerDiaSemanaISO(
  fechaISO
) {
  const fecha = new Date(
    `${fechaISO}T00:00:00.000Z`
  );

  const dia = fecha.getUTCDay();

  return dia === 0 ? 7 : dia;
}

function sumarDias(
  fechaISO,
  cantidad
) {
  const fecha = new Date(
    `${fechaISO}T00:00:00.000Z`
  );

  fecha.setUTCDate(
    fecha.getUTCDate() + cantidad
  );

  return fecha
    .toISOString()
    .substring(0, 10);
}