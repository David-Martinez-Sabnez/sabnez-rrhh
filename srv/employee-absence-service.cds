using {sabnez.rrhh as db} from '../db/schema';
using {sabnez.rrhh as cat} from '../db/catalogos';

// Servicio de autogestión. La identidad del empleado siempre se obtiene
// del usuario autenticado; ninguna operación recibe empleado, estado o
// aprobador desde el cliente.
service EmployeeAbsenceService @(
  path    : '/ausencias-empleado',
  requires: 'authenticated-user'
) {
  type ResumenEmpleado {
    nombreEmpleado                  : String(240);
    solicitudesEnCurso             : Integer;
    solicitudesAprobadas           : Integer;
    solicitudesRechazadas          : Integer;
    diasVacacionesCausados          : Decimal(9, 2);
    diasVacacionesReservados        : Decimal(9, 2);
    diasVacacionesDisponibles       : Decimal(9, 2);
    horasValeraAsignadas            : Decimal(7, 2);
    horasValeraReservadas           : Decimal(7, 2);
    horasValeraDisponibles          : Decimal(7, 2);
    horasCumpleaniosAsignadas       : Decimal(7, 2);
    horasCumpleaniosReservadas      : Decimal(7, 2);
    horasCumpleaniosDisponibles     : Decimal(7, 2);
    proximoCumpleanios              : Date;
    semanaCumpleaniosInicio         : Date;
    semanaCumpleaniosFin            : Date;
  }

  type SolicitudAusencia {
    ID                              : UUID;
    tipoAusenciaCodigo              : String(30);
    tipoAusenciaDescripcion         : String(80);
    unidadConsumo                   : String(10);
    fechaInicio                     : Date;
    fechaFin                        : Date;
    horaInicio                      : Time;
    horaFin                         : Time;
    diasHabiles                     : Decimal(6, 2);
    horasSolicitadas                : Decimal(7, 2);
    estado                          : String(20);
    estadoDescripcion               : String(80);
    motivo                          : String(500);
    decisionResultado               : String(15);
    decisionComentario              : String(1000);
    decididaPorNombre               : String(240);
    decisionActuandoPorNombre       : String(240);
    fechaDecision                   : Timestamp;
    requiereSoporte                 : Boolean;
    cantidadSoportes                : Integer;
    puedeEditar                     : Boolean;
    puedeEnviar                     : Boolean;
    puedeCancelar                   : Boolean;
    puedeEliminar                   : Boolean;
    createdAt                       : Timestamp;
    modifiedAt                      : Timestamp;
  }

  type ResultadoSolicitud {
    exito                           : Boolean;
    mensaje                         : String(500);
    solicitud                       : SolicitudAusencia;
  }

  @readonly
  entity TiposAusencia as projection on cat.TiposAusencia;

  // Proyección técnica mínima para usar el protocolo oficial de
  // @cap-js/attachments: POST de metadatos y PUT de .../content.
  // El backend bloquea la entidad raíz y comprueba ownership + BORRADOR
  // en cada operación sobre la composición.
  @cds.redirection.exclude
  entity MisAusencias as projection on db.Ausencias {
    key ID,
        empleado.ID as empleado_ID @UI.Hidden,
        soportes
  };

  function obtenerMiResumen() returns ResumenEmpleado;

  function obtenerMisSolicitudes() returns many SolicitudAusencia;

  action guardarBorrador(
    ID                    : UUID,
    tipoAusenciaCodigo    : String(30),
    fechaInicio           : Date,
    fechaFin              : Date,
    horaInicio            : Time,
    horaFin               : Time,
    motivo                : String(500)
  ) returns ResultadoSolicitud;

  action enviarSolicitud(ID: UUID) returns ResultadoSolicitud;

  action cancelarSolicitud(ID: UUID) returns ResultadoSolicitud;

  action eliminarBorrador(ID: UUID) returns ResultadoSolicitud;
}

annotate EmployeeAbsenceService.ScanStates with @readonly;
annotate EmployeeAbsenceService.ScanStates.texts with @readonly;
