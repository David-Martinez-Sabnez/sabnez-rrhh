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

  function obtenerMisAsignaciones(fecha: Date) returns many AsignacionDisponible;
  function obtenerMisRegistros(semanaInicio: Date) returns many RegistroTiempo;

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

  action enviarSemana(semanaInicio: Date) returns ResultadoEnvioSemanal;
}
