using { sabnez.times as times } from '../db/time-management';

service EmployeeTimeService @(
  path    : '/tiempos-empleado',
  requires: 'authenticated-user'
) {
  type AsignacionDisponible {
    ID                  : UUID;
    proyectoID          : UUID;
    proyectoCodigo      : String(40);
    proyectoNombre      : String(180);
    clienteNombre       : String(180);
    modalidad           : String(15);
    fechaInicio         : Date;
    fechaFin            : Date;
    requiereDescripcion : Boolean;
    requiereSoporte     : Boolean;
    zonaHoraria         : String(80);
    umbralAlertaDiaria  : Decimal(5, 2);
  }

  type RegistroTiempo {
    ID                    : UUID;
    hojaSemanalID         : UUID;
    asignacionID          : UUID;
    proyectoNombre        : String(180);
    fecha                 : Date;
    duracionHoras         : Decimal(7, 2);
    tipoSolicitado        : String(20);
    descripcion           : String(2000);
    requiereSoporte       : Boolean;
    horaInicioAproximada  : Time;
    horaFinAproximada     : Time;
    zonaHoraria           : String(80);
    autorizacionPrevia    : Boolean;
    motivoExcepcional     : String(1000);
    estado                : String(25);
    alertaHorasDiarias    : Boolean;
    cantidadSoportes      : Integer;
    puedeEditar           : Boolean;
    version               : Integer;
    umbralAlertaDiaria    : Decimal(5, 2);
  }

  type ResultadoRegistro {
    exito    : Boolean;
    mensaje  : String(500);
    registro : RegistroTiempo;
  }

  type ResultadoEnvioSemanal {
    exito          : Boolean;
    mensaje        : String(500);
    hojaSemanalID  : UUID;
    semanaInicio   : Date;
    semanaFin      : Date;
    estado         : String(20);
    totalRegistros : Integer;
    totalHoras     : Decimal(9, 2);
  }

  type ResultadoSoporte {
    exito     : Boolean;
    mensaje   : String(500);
    soporteID : UUID;
  }

  type DiaNoHabil {
    fecha  : Date;
    tipo   : String(15);
    motivo : String(120);
  }

  type EstadoEnvioSemana {
    permitido : Boolean;
    mensaje   : String(500);
  }

  type ContextoEmpleado {
    empleadoID : UUID;
  }

  type RegistroID { ID: UUID; }

  type FechaCopia { fecha: Date; }

  type OperacionCopia {
    ID             : UUID;
    alcance        : String(15);
    estado         : String(15);
    fechaOrigen    : Date;
    solicitados    : Integer;
    creados        : Integer;
    omitidos       : Integer;
    resumen        : String(500);
    creadoEn       : Timestamp;
    deshechoEn     : Timestamp;
    puedeDeshacer  : Boolean;
  }

  type ResultadoCopia {
    exito          : Boolean;
    mensaje        : String(500);
    operacion      : OperacionCopia;
  }

  function obtenerMisAsignaciones(fecha: Date) returns many AsignacionDisponible;
  function obtenerMisRegistros(semanaInicio: Date) returns many RegistroTiempo;
  function obtenerMisRegistrosMes(mesInicio: Date) returns many RegistroTiempo;
  function obtenerDiasNoHabiles(desde: Date, hasta: Date) returns many DiaNoHabil;
  function obtenerEstadoEnvioSemana() returns EstadoEnvioSemana;
  function obtenerMiContexto() returns ContextoEmpleado;

  action guardarBorrador(
    ID: UUID,
    asignacionID: UUID,
    fecha: Date,
    duracionHoras: Decimal(7, 2),
    tipoSolicitado: String(20),
    descripcion: String(2000),
    horaInicioAproximada: Time,
    horaFinAproximada: Time,
    zonaHoraria: String(80),
    autorizacionPrevia: Boolean,
    motivoExcepcional: String(1000)
  ) returns ResultadoRegistro;

  action cargarSoporte(
    registroID: UUID,
    nombreArchivo: String(255),
    mimeType: String(100),
    contenido: LargeBinary
  ) returns ResultadoSoporte;

  action eliminarRegistros(registros: many RegistroID) returns Integer;

  function obtenerMisCopias() returns many OperacionCopia;
  action ejecutarCopiaMasiva(
    registroOrigenID: UUID,
    fechas: many FechaCopia,
    alcance: String(15)
  ) returns ResultadoCopia;
  action deshacerCopiaMasiva(operacionID: UUID) returns ResultadoCopia;

  action enviarSemana(semanaInicio: Date) returns ResultadoEnvioSemanal;
}
