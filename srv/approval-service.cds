using {sabnez.approvals as approval} from '../db/approvals';
using {sabnez.rrhh as rrhh} from '../db/schema';

service ApprovalService @(
  path    : '/aprobaciones',
  requires: 'authenticated-user'
) {
  type ResumenAprobaciones {
    pendientes     : Integer;
    vencidas       : Integer;
    comoBackup     : Integer;
    delegadasPorMi : Integer;
    aprobadas      : Integer;
    rechazadas     : Integer;
  }

  type TareaAprobacion {
    ID                 : UUID;
    instanciaID        : UUID;
    processCode        : String(40);
    businessObjectType : String(80);
    businessObjectID   : String(160);
    titulo             : String(200);
    resumen            : String(1000);
    solicitanteNombre  : String(240);
    prioridad          : String(10);
    estado             : String(20);
    tipoAsignacion     : String(20);
    actuandoPorNombre  : String(240);
    fechaSolicitud     : Timestamp;
    fechaVencimiento   : Timestamp;
    version            : Integer;
    modifiedAt         : Timestamp;
    rutaOrigen         : String(120);
    puedeAprobar       : Boolean;
    puedeRechazar      : Boolean;
    puedeReenviar      : Boolean;
  }

  type HechoAprobacion {
    ID            : UUID;
    seccion       : String(80);
    clave         : String(80);
    etiqueta      : String(120);
    valor         : String(1000);
    enlace        : String(1000);
    tipoDato      : String(20);
    semanticColor : String(20);
    orden         : Integer;
  }

  type EventoAprobacion {
    ID                : UUID;
    tipo              : String(50);
    actorNombre       : String(240);
    actuandoPorNombre : String(240);
    detalle           : String(1000);
    fecha             : Timestamp;
  }

  type DetalleAprobacion {
    tarea   : TareaAprobacion;
    hechos  : many HechoAprobacion;
    eventos : many EventoAprobacion;
  }

  type DelegacionAprobacion {
    ID                : UUID;
    delegadoID        : UUID;
    delegadoNombre    : String(240);
    delegadoCorreo    : String(120);
    modo              : String(15);
    alcance           : String(15);
    processCode       : String(40);
    fechaInicio       : Date;
    fechaFin          : Date;
    incluirPendientes : Boolean;
    estado            : String(15);
    motivo            : String(500);
    version           : Integer;
    createdAt         : Timestamp;
    modifiedAt        : Timestamp;
  }

  type ResultadoAccion {
    exito   : Boolean;
    mensaje : String(500);
    tarea   : TareaAprobacion;
  }

  type ResultadoDelegacion {
    exito      : Boolean;
    mensaje    : String(500);
    delegacion : DelegacionAprobacion;
  }

  type EventoNotificacion {
    eventID        : UUID;
    tipo           : String(50);
    instanciaID    : UUID;
    tareaID        : UUID;
    destinatarioID : String(255);
    processCode    : String(40);
    occurredAt     : Timestamp;
  }

  type ArchivoSoporte {
    filename        : String(255);
    mimeType        : String(255);
    contenidoBase64 : LargeString;
  }

  // Lista mínima para selects; no expone datos personales adicionales.
  @readonly
  entity EmpleadosElegibles  as
    select from rrhh.Empleados {
      key ID,
          nombreCompleto,
          correoCorporativo
    }
    where
          estado.codigo     =      'AC'
      and correoCorporativo is not null;

  // Proyección técnica de solo lectura para que quien tenga una tarea de
  // ausencia asignada pueda consultar sus soportes. La implementación filtra
  // tanto la raíz como la composición según las asignaciones del usuario.
  @readonly
  @cds.redirection.exclude
  entity AusenciasAprobables as
    projection on rrhh.Ausencias {
      key ID,
          soportes
    };

  function obtenerMiResumen()                        returns ResumenAprobaciones;
  function obtenerMisTareas()                        returns many TareaAprobacion;
  function obtenerDetalleTarea(ID: UUID)             returns DetalleAprobacion;
  function obtenerMisDelegaciones()                  returns many DelegacionAprobacion;

  action   aprobar(ID: UUID,
                   expectedVersion: Integer,
                   idempotencyKey: String(120),
                   comentario: String(1000))         returns ResultadoAccion;

  action   rechazar(ID: UUID,
                    expectedVersion: Integer,
                    idempotencyKey: String(120),
                    comentario: String(1000))        returns ResultadoAccion;

  action   reenviar(ID: UUID,
                    delegadoID: UUID,
                    expectedVersion: Integer,
                    idempotencyKey: String(120),
                    comentario: String(1000))        returns ResultadoAccion;

  action   guardarDelegacion(ID: UUID,
                             delegadoID: UUID,
                             modo: String(15),
                             fechaInicio: Date,
                             fechaFin: Date,
                             alcance: String(15),
                             processCode: String(40),
                             incluirPendientes: Boolean,
                             expectedVersion: Integer,
                             idempotencyKey: String(120),
                             motivo: String(500))    returns ResultadoDelegacion;

  action   revocarDelegacion(ID: UUID,
                             expectedVersion: Integer,
                             idempotencyKey: String(120),
                             motivo: String(500))    returns ResultadoDelegacion;


  action   descargarSoporteAusencia(solicitudID: UUID,
                                    soporteID: UUID) returns ArchivoSoporte;

  // Se procesa mediante la cola transaccional; el adaptador de correo se
  // conectará posteriormente sin cambiar el flujo de aprobación.
  event ApprovalNotificationRequested : EventoNotificacion;
}

annotate ApprovalService.ScanStates with @readonly;
annotate ApprovalService.ScanStates.texts with @readonly;
