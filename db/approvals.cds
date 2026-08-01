namespace sabnez.approvals;

using {
  cuid,
  managed
} from '@sap/cds/common';

using {sabnez.rrhh.Empleados} from './schema';

type EstadoProcesoAprobacion : String(25) enum {
  PENDING_ASSIGNMENT = 'PENDING_ASSIGNMENT';
  RUNNING            = 'RUNNING';
  APPROVED           = 'APPROVED';
  REJECTED           = 'REJECTED';
  CANCELLED          = 'CANCELLED';
  ERROR              = 'ERROR';
};

type EstadoTareaAprobacion : String(20) enum {
  WAITING    = 'WAITING';
  OPEN       = 'OPEN';
  PROCESSING = 'PROCESSING';
  APPROVED   = 'APPROVED';
  REJECTED   = 'REJECTED';
  CANCELLED  = 'CANCELLED';
  EXPIRED    = 'EXPIRED';
};

type TipoAsignacionAprobacion : String(20) enum {
  PRIMARY  = 'PRIMARY';
  BACKUP   = 'BACKUP';
  DELEGATE = 'DELEGATE';
  POOL     = 'POOL';
};

type EstadoAsignacionAprobacion : String(15) enum {
  ACTIVE    = 'ACTIVE';
  REVOKED   = 'REVOKED';
  COMPLETED = 'COMPLETED';
};

type TipoDecisionAprobacion : String(15) enum {
  APPROVE = 'APPROVE';
  REJECT  = 'REJECT';
};

type ModoDelegacionAprobacion : String(15) enum {
  BACKUP     = 'BACKUP';
  SUBSTITUTE = 'SUBSTITUTE';
};

type AlcanceDelegacionAprobacion : String(15) enum {
  ALL_SCOPES = 'ALL';
  PROCESS    = 'PROCESS';
};

type EstadoDelegacionAprobacion : String(15) enum {
  ACTIVE  = 'ACTIVE';
  REVOKED = 'REVOKED';
  EXPIRED = 'EXPIRED';
};

type EstadoNotificacionAprobacion : String(15) enum {
  PENDING    = 'PENDING';
  PROCESSING = 'PROCESSING';
  SENT       = 'SENT';
  FAILED     = 'FAILED';
  CANCELLED  = 'CANCELLED';
};

type PrioridadAprobacion : String(10) enum {
  LOW      = 'LOW';
  MEDIUM   = 'MEDIUM';
  HIGH     = 'HIGH';
  VERY_HIGH = 'VERY_HIGH';
};

type ResolverAprobador : String(30) enum {
  DIRECT_MANAGER = 'DIRECT_MANAGER';
  FIXED_EMPLOYEE = 'FIXED_EMPLOYEE';
  ROLE_POOL      = 'ROLE_POOL';
};

@assert.unique: {codigoVersion: [codigo, version]}
entity ApprovalProcessDefinitions : cuid, managed {
  codigo            : String(40)  @mandatory;
  version           : Integer     @mandatory;
  dominio           : String(40)  @mandatory;
  descripcion       : String(160) @mandatory;
  activo            : Boolean default true;
  horasVencimiento  : Integer default 72;
  rutaOrigen        : String(120);

  etapas            : Composition of many ApprovalStages
                        on etapas.proceso = $self;
}

@assert.unique: {procesoSecuencia: [proceso, secuencia]}
entity ApprovalStages : cuid, managed {
  proceso          : Association to ApprovalProcessDefinitions @mandatory;
  secuencia        : Integer                                   @mandatory;
  nombre           : String(100)                               @mandatory;
  resolver         : ResolverAprobador                         @mandatory;
  rolRequerido     : String(80);
}

@assert.unique: {
  idempotencia   : [idempotencyKey],
  objetoCiclo    : [processCode, businessObjectType, businessObjectID, cycle]
}
entity ApprovalInstances : cuid, managed {
  proceso               : Association to ApprovalProcessDefinitions @mandatory;
  processCode           : String(40)  @mandatory;
  processVersion        : Integer     @mandatory;
  businessObjectType    : String(80)  @mandatory;
  businessObjectID      : String(160) @mandatory;
  cycle                 : Integer default 1;
  idempotencyKey        : String(120) @mandatory;

  solicitante           : Association to Empleados @mandatory;
  solicitanteUserID     : String(255);
  solicitanteNombre     : String(240) @mandatory;

  estado                : EstadoProcesoAprobacion default 'PENDING_ASSIGNMENT';
  titulo                : String(200) @mandatory;
  resumen               : String(1000);
  prioridad             : PrioridadAprobacion default 'MEDIUM';
  currentStage          : Integer default 1;
  submittedAt           : Timestamp;
  dueAt                 : Timestamp;
  completedAt           : Timestamp;
  rutaOrigen            : String(120);

  tareas                : Composition of many ApprovalTasks
                            on tareas.instancia = $self;
  hechos                : Composition of many ApprovalFacts
                            on hechos.instancia = $self;
  eventos               : Composition of many ApprovalEvents
                            on eventos.instancia = $self;
}

entity ApprovalTasks : cuid, managed {
  instancia          : Association to ApprovalInstances @mandatory;
  etapa               : Association to ApprovalStages    @mandatory;
  estado              : EstadoTareaAprobacion default 'OPEN';
  originalApprover    : Association to Empleados;
  responsibleApprover : Association to Empleados;
  responsibleUserID  : String(255);
  dueAt               : Timestamp;
  completedAt         : Timestamp;

  // Contador portable para ETag y compare-and-swap en acciones.
  version             : Integer default 1 @odata.etag;

  asignaciones        : Composition of many ApprovalTaskAssignments
                          on asignaciones.tarea = $self;
  decisiones          : Composition of many ApprovalDecisions
                          on decisiones.tarea = $self;
}

entity ApprovalTaskAssignments : cuid, managed {
  tarea              : Association to ApprovalTasks @mandatory;
  empleado           : Association to Empleados     @mandatory;
  approverUserID     : String(255)                   @mandatory;
  tipo               : TipoAsignacionAprobacion     @mandatory;
  estado             : EstadoAsignacionAprobacion default 'ACTIVE';
  validaDesde        : Date;
  validaHasta        : Date;
  delegacion         : Association to ApprovalDelegations;
}

@assert.unique: {idempotencia: [idempotencyKey]}
entity ApprovalDecisions : cuid, managed {
  instancia       : Association to ApprovalInstances @mandatory;
  tarea           : Association to ApprovalTasks     @mandatory;
  decision        : TipoDecisionAprobacion            @mandatory;
  actor           : Association to Empleados          @mandatory;
  actorUserID     : String(255)                        @mandatory;
  actingFor       : Association to Empleados;
  comentario      : String(1000);
  idempotencyKey  : String(120)                        @mandatory;
  decidedAt       : Timestamp                          @mandatory;
}

@assert.unique: {idempotenciaCreacion: [creationIdempotencyKey]}
entity ApprovalDelegations : cuid, managed {
  otorgante              : Association to Empleados @mandatory;
  otorganteUserID        : String(255)               @mandatory;
  delegado               : Association to Empleados @mandatory;
  delegadoUserID         : String(255)               @mandatory;
  modo                   : ModoDelegacionAprobacion  @mandatory;
  alcance                : AlcanceDelegacionAprobacion default 'ALL';
  processCode            : String(40);
  fechaInicio            : Date                      @mandatory;
  fechaFin               : Date                      @mandatory;
  incluirPendientes      : Boolean default false;
  estado                 : EstadoDelegacionAprobacion default 'ACTIVE';
  motivo                 : String(500);
  creationIdempotencyKey : String(120)               @mandatory;
  revocationIdempotencyKey: String(120);
  revokedAt              : Timestamp;
  revokedByUserID        : String(255);
  version                : Integer default 1 @odata.etag;
}

entity ApprovalFacts : cuid, managed {
  instancia     : Association to ApprovalInstances @mandatory;
  seccion       : String(80) default 'General';
  clave         : String(80)                        @mandatory;
  etiqueta      : String(120)                       @mandatory;
  valor         : String(1000);
  tipoDato      : String(20) default 'TEXT';
  semanticColor : String(20);
  orden         : Integer default 0;
}

@assert.unique: {idempotencia: [idempotencyKey]}
entity ApprovalEvents : cuid, managed {
  instancia       : Association to ApprovalInstances;
  tarea           : Association to ApprovalTasks;
  delegacion      : Association to ApprovalDelegations;
  tipo            : String(50)  @mandatory;
  actorUserID     : String(255);
  actorEmpleado   : Association to Empleados;
  actingFor       : Association to Empleados;
  detalle         : String(1000);
  occurredAt      : Timestamp   @mandatory;
  idempotencyKey  : String(120);
}

// Registro durable independiente del proveedor de correo. La cola CAP usa
// este ID y un adaptador futuro actualizará el estado de entrega.
@assert.unique: {idempotencia: [idempotencyKey]}
entity ApprovalNotificationOutbox : cuid, managed {
  instancia       : Association to ApprovalInstances;
  tarea           : Association to ApprovalTasks;
  tipo            : String(50)  @mandatory;
  destinatarioID  : String(255) @mandatory;
  processCode     : String(40)  @mandatory;
  estado          : EstadoNotificacionAprobacion default 'PENDING';
  intentos        : Integer default 0;
  disponibleDesde : Timestamp;
  ultimoError     : String(1000);
  idempotencyKey  : String(120) @mandatory;
}

@assert.unique: {identidad: [issuer, subjectNormalizado]}
entity ApprovalIdentities : cuid, managed {
  empleado          : Association to Empleados @mandatory;
  issuer            : String(255) default 'CORPORATE_EMAIL';
  subject           : String(255) @mandatory;
  subjectNormalizado: String(255) @mandatory;
  principal         : Boolean default true;
  activa            : Boolean default true;
}
