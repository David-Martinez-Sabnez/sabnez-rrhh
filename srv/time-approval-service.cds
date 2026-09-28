using { sabnez.times as times } from '../db/time-management';

service TimeApprovalService @(
  path: '/tiempos-aprobacion',
  requires: 'authenticated-user'
) {
  type HojaResumen {
    ID                  : UUID;
    empleadoNombre      : String(180);
    empleadoCorreo      : String(255);
    clienteNombre       : String(180);
    proyectoNombre      : String(180);
    semanaInicio        : Date;
    semanaFin           : Date;
    estado              : String(25);
    enviadoEn           : Timestamp;
    totalHoras          : Decimal(9,2);
    totalRegistros      : Integer;
    registrosConAlerta : Integer;
    soportesPendientes  : Integer;
    siguienteAccion     : String(80);
    puedeAprobar        : Boolean;
    puedeDevolver       : Boolean;
  }

  type RegistroRevision {
    ID                  : UUID;
    fecha               : Date;
    horas               : Decimal(7,2);
    tipo                : String(25);
    descripcion         : String(2000);
    proyectoNombre      : String(180);
    clienteNombre       : String(180);
    requiereSoporte     : Boolean;
    cantidadSoportes    : Integer;
    alerta              : Boolean;
    soporteID           : UUID;
    soporteNombre       : String(255);
    diaNombre           : String(20);
    soportes            : many SoporteRevision;
  }

  type SoporteRevision {
    ID                  : UUID;
    nombre              : String(255);
  }

  type ResumenProyecto {
    proyectoNombre      : String(180);
    clienteNombre       : String(180);
    totalHoras          : Decimal(9,2);
    totalRegistros      : Integer;
  }

  type EventoRevision {
    ID                  : UUID;
    tipo                : String(40);
    actorNombre         : String(180);
    destinatarioNombre  : String(180);
    detalle             : String(1000);
    fecha               : Timestamp;
  }

  type DetalleHoja {
    resumen   : HojaResumen;
    registros: many RegistroRevision;
    proyectos: many ResumenProyecto;
    eventos  : many EventoRevision;
  }

  type ResultadoDecision {
    exito  : Boolean;
    mensaje: String(500);
    estado : String(25);
  }

  type ArchivoDescarga {
    nombre         : String(255);
    mimeType       : String(100);
    contenidoBase64: LargeString;
  }

  type PermisosReasignacion {
    puedeReasignar : Boolean;
  }

  type IncidenciaReasignacion {
    ID                       : UUID;
    empleadoID               : UUID;
    empleadoNombre           : String(180);
    empleadoCorreo           : String(255);
    clienteNombre            : String(180);
    proyectoNombre           : String(180);
    semanaInicio             : Date;
    semanaFin                : Date;
    estado                   : String(25);
    etapa                    : String(40);
    aprobadorActualID        : UUID;
    aprobadorActualNombre    : String(180);
    aprobadorSugeridoID      : UUID;
    aprobadorSugeridoNombre  : String(180);
    motivo                   : String(500);
    resolubleAutomaticamente : Boolean;
    totalHoras               : Decimal(9,2);
    totalRegistros           : Integer;
  }

  type ResultadoReasignacion {
    exito           : Boolean;
    mensaje         : String(500);
    aprobadorID     : UUID;
    aprobadorNombre : String(180);
  }

  function obtenerPermisosReasignacion() returns PermisosReasignacion;

  @requires: 'TimeApprovalReassign'
  function obtenerIncidenciasReasignacion() returns many IncidenciaReasignacion;

  @requires: 'TimeApprovalReassign'
  action reprocesarAprobacion(hojaID: UUID, comentario: String(1000)) returns ResultadoReasignacion;

  @requires: 'TimeApprovalReassign'
  action reasignarAprobacion(hojaID: UUID, aprobadorID: UUID, comentario: String(1000)) returns ResultadoReasignacion;

  function obtenerBandeja(estado: String) returns many HojaResumen;
  function obtenerDetalle(hojaID: UUID) returns DetalleHoja;
  action aprobarHoja(hojaID: UUID, comentario: String(1000)) returns ResultadoDecision;
  action devolverHoja(hojaID: UUID, comentario: String(1000)) returns ResultadoDecision;
  action reenviarHoja(hojaID: UUID, delegadoID: UUID, comentario: String(1000)) returns ResultadoDecision;
  action descargarSoporte(registroID: UUID, soporteID: UUID) returns ArchivoDescarga;
  action generarReporteCSV(hojaID: UUID) returns ArchivoDescarga;
}
