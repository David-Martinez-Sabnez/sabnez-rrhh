namespace sabnez.times;

using {sabnez.calendars as calendars} from './calendars';

using { cuid, managed } from '@sap/cds/common';
using { Attachments } from '@cap-js/attachments';
using { sabnez.rrhh.Empleados } from './schema';

type EstadoMaestro : String(15) enum {
  DRAFT    = 'DRAFT';
  ACTIVE   = 'ACTIVE';
  INACTIVE = 'INACTIVE';
  CLOSED   = 'CLOSED';
};

type ModalidadProyecto : String(15) enum {
  FULL_TIME = 'FULL_TIME';
  HOURLY    = 'HOURLY';
  MIXED     = 'MIXED';
  INTERNAL  = 'INTERNAL';
};

type TipoCicloReporte : String(15) enum {
  MONTHLY = 'MONTHLY';
  WEEKLY  = 'WEEKLY';
  CUSTOM  = 'CUSTOM';
};

type EsquemaAprobacion : String(25) enum {
  LEADER_THEN_ADMIN = 'LEADER_THEN_ADMIN';
  LEADER_ONLY       = 'LEADER_ONLY';
  ADMIN_ONLY        = 'ADMIN_ONLY';
  LEADER_OR_ADMIN   = 'LEADER_OR_ADMIN';
};

type EstadoPeriodoTiempo : String(25) enum {
  OPEN                = 'OPEN';
  SUBMITTED           = 'SUBMITTED';
  UNDER_REVIEW        = 'UNDER_REVIEW';
  WEEKLY_APPROVED     = 'WEEKLY_APPROVED';
  CONSOLIDATING       = 'CONSOLIDATING';
  SENT_TO_CLIENT      = 'SENT_TO_CLIENT';
  CORRECTION_REQUIRED = 'CORRECTION_REQUIRED';
  CLIENT_APPROVED     = 'CLIENT_APPROVED';
  CLOSED              = 'CLOSED';
  INVOICED            = 'INVOICED';
  REOPENED            = 'REOPENED';
};

type EstadoHojaSemanal : String(20) enum {
  OPEN                = 'OPEN';
  SUBMITTED           = 'SUBMITTED';
  UNDER_REVIEW        = 'UNDER_REVIEW';
  RETURNED            = 'RETURNED';
  LEADER_APPROVED     = 'LEADER_APPROVED';
  INTERNALLY_APPROVED = 'INTERNALLY_APPROVED';
  CLOSED              = 'CLOSED';
};

type EstadoRegistroTiempo : String(25) enum {
  DRAFT              = 'DRAFT';
  SUBMITTED          = 'SUBMITTED';
  UNDER_REVIEW       = 'UNDER_REVIEW';
  RETURNED           = 'RETURNED';
  LEADER_APPROVED    = 'LEADER_APPROVED';
  INTERNALLY_APPROVED = 'INTERNALLY_APPROVED';
  CLIENT_OBJECTED    = 'CLIENT_OBJECTED';
  CORRECTED          = 'CORRECTED';
  CLOSED             = 'CLOSED';
  INVOICED           = 'INVOICED';
  VOIDED             = 'VOIDED';
};

type TipoTiempoSolicitado : String(20) enum {
  REGULAR       = 'REGULAR';
  OVERTIME      = 'OVERTIME';
  NIGHT         = 'NIGHT';
  SUNDAY        = 'SUNDAY';
  HOLIDAY       = 'HOLIDAY';
  COMPENSATORY  = 'COMPENSATORY';
  FLEX_INCLUDED = 'FLEX_INCLUDED';
};

type TratamientoComercial : String(25) enum {
  INCLUDED_FULL_TIME = 'INCLUDED_FULL_TIME';
  BILLABLE_REGULAR   = 'BILLABLE_REGULAR';
  BILLABLE_OVERTIME  = 'BILLABLE_OVERTIME';
  SPECIAL_RATE       = 'SPECIAL_RATE';
  NON_BILLABLE       = 'NON_BILLABLE';
  PENDING            = 'PENDING';
};

type EstadoIncumplimientoCorte : String(15) enum {
  OPEN     = 'OPEN';
  RESOLVED = 'RESOLVED';
};

@assert.unique: {
  taxId       : [taxIdentification],
  projectPrefix: [projectCodePrefix]
}
entity Clients : cuid, managed {
  legalName             : String(180) @mandatory;
  tradeName             : String(180);
  // Prefijo de tres letras usado para numerar automáticamente los proyectos
  // del cliente (por ejemplo QCQ001, QCQ002…). Es nullable para permitir la
  // migración de clientes históricos; el servicio lo exige al crear nuevos.
  projectCodePrefix     : String(3);
  taxIdentification     : String(60)  @mandatory;
  countryCode           : String(2)   @mandatory default 'CO';
  defaultCurrency       : String(3)   @mandatory default 'COP';
  timeZone              : String(80)  @mandatory default 'America/Bogota';
  taxExempt              : Boolean default false;
  // Días que se demora este cliente en pagar desde que se emite la factura.
  // Es la base de la proyección de caja: sin esto no se sabe en qué mes
  // entra la plata de lo que se está facturando hoy.
  paymentTermDays        : Integer default 30;
  status                 : EstadoMaestro default 'ACTIVE';
  contracts              : Composition of many ClientContracts on contracts.client = $self;
  projects               : Composition of many Projects on projects.client = $self;
}

@assert.unique: { clientReference: [client, reference] }
entity ClientContracts : cuid, managed {
  client                 : Association to Clients @mandatory;
  reference              : String(80) @mandatory;
  description            : String(500);
  validFrom              : Date @mandatory;
  validTo                : Date;
  currency               : String(3) @mandatory default 'COP';
  totalValue             : Decimal(19, 2);
  renewalNoticeDays      : Integer default 30;
  // Si este contrato negoció un plazo distinto al del cliente, mandá éste.
  // Vacío significa "lo que diga el cliente".
  paymentTermDays        : Integer;
  status                 : EstadoMaestro default 'ACTIVE';
  documents              : Composition of many Attachments;
}

@assert.unique: { clientCode: [client, code] }
entity Projects : cuid, managed {
  client                 : Association to Clients @mandatory;
  contract               : Association to ClientContracts;
  code                   : String(40) @mandatory;
  name                   : String(180) @mandatory;
  description            : String(1000);
  validFrom              : Date @mandatory;
  validTo                : Date;
  // Inicio de la vigencia activa después de la última reapertura. Se
  // conserva validFrom como inicio histórico del proyecto.
  lastReopenedOn         : Date;
  modality               : ModalidadProyecto @mandatory;
  currency               : String(3) @mandatory default 'COP';
  timeZone               : String(80) @mandatory default 'America/Bogota';
  // Calendario laboral que gobierna festivos, días hábiles y prorrateos
  // de este proyecto. Los proyectos existentes se migran a Colombia.
  workCalendar           : Association to calendars.WorkCalendars;
  requiresDescription    : Boolean default false;
  requiresEvidence       : Boolean default false;
  requiresClientApproval : Boolean default false;
  approvalScheme         : EsquemaAprobacion default 'LEADER_THEN_ADMIN';
  dailyWarningHours      : Decimal(5, 2) default 16;
  // Día recurrente en el que el equipo debe completar los tiempos. El 31
  // representa el último día disponible en los meses más cortos.
  timeEntryCutoffDay     : Integer default 31;
  // Horas facturables que se esperan al mes de este proyecto. Sólo tiene
  // sentido en proyectos por horas o mixtos; se reparte entre el equipo
  // según su asignación comercial para calcular el objetivo de cada uno.
  monthlyBillableTarget  : Decimal(9, 2);
  status                 : EstadoMaestro default 'DRAFT';
  reportingCycles        : Composition of many ReportingCycles on reportingCycles.project = $self;
  assignments            : Composition of many ProjectAssignments on assignments.project = $self;
  approvers              : Composition of many ProjectApprovers on approvers.project = $self;
  billingRules           : Composition of many ProjectBillingRules on billingRules.project = $self;
}

// Qué se le puede cobrar al cliente en este proyecto, por tipo de tiempo.
// La regla vive acá y no en la aprobación porque el contrato es lo que
// define si una hora es facturable; el aprobador sólo confirma que se
// trabajó. Se siembra según la modalidad al crear el proyecto y se corrige
// a mano cuando el contrato dice otra cosa.
@assert.unique: { projectType: [project, requestedType] }
entity ProjectBillingRules : cuid, managed {
  project                : Association to Projects @mandatory;
  requestedType          : TipoTiempoSolicitado @mandatory;
  treatment              : TratamientoComercial @mandatory;
  // Factor sobre las horas registradas. 1 = se cobran tal cual; 1.25 = el
  // contrato reconoce recargo; 0 = se reconocen al recurso pero no se cobran.
  billableFactor         : Decimal(5, 2) default 1;
  // Si el recurso igual recibe estas horas aunque no se le cobren al cliente.
  // Éste es el sábado que el cliente no aprobó pero que hay que compensar.
  payableToEmployee      : Boolean default true;
  notes                  : String(500);
  active                 : Boolean default true;
}

entity ReportingCycles : cuid, managed {
  project                : Association to Projects @mandatory;
  name                   : String(120) @mandatory;
  cycleType              : TipoCicloReporte @mandatory;
  startDay               : Integer;
  endDay                 : Integer;
  submitBusinessDay      : Integer default 1;
  correctionBusinessDays: Integer default 5;
  timeZone               : String(80) @mandatory default 'America/Bogota';
  active                 : Boolean default true;
}

@assert.unique: { projectEmployeeStart: [project, employee, validFrom] }
entity ProjectAssignments : cuid, managed {
  project                : Association to Projects @mandatory;
  employee               : Association to Empleados @mandatory;
  // Dos personas del mismo proyecto pueden facturarse en ciclos distintos
  // (por ejemplo 1-fin de mes y 16-15). La regla debe vivir en la
  // asignación, no inferirse de las horas registradas.
  reportingCycle         : Association to ReportingCycles;
  validFrom              : Date @mandatory;
  validTo                : Date;
  role                   : String(100);
  commercialAllocation  : Decimal(7, 2);
  isPrimary              : Boolean default true;
  isBackup               : Boolean default false;
  status                 : EstadoMaestro default 'ACTIVE';
  rates                  : Composition of many AssignmentRates on rates.assignment = $self;
}

entity AssignmentRates : cuid, managed {
  assignment             : Association to ProjectAssignments @mandatory;
  validFrom              : Date @mandatory;
  validTo                : Date;
  // `currency` se conserva para compatibilidad con registros históricos.
  currency               : String(3) @mandatory default 'COP';
  saleCurrency           : String(3);
  costCurrency           : String(3);
  monthlySaleRate        : Decimal(19, 2);
  regularSaleHourlyRate : Decimal(19, 2);
  overtimeSaleHourlyRate: Decimal(19, 2);
  internalMonthlyCost   : Decimal(19, 2);
  internalHourlyCost    : Decimal(19, 2);
  confidential          : Boolean default true;
}

entity ProjectApprovers : cuid, managed {
  project                : Association to Projects @mandatory;
  employee               : Association to Empleados @mandatory;
  approverType           : String(20) @mandatory;
  validFrom              : Date @mandatory;
  validTo                : Date;
  active                 : Boolean default true;
}

@assert.unique: { projectCycleStart: [project, reportingCycle, periodStart] }
entity BillingPeriods : cuid, managed {
  project                : Association to Projects @mandatory;
  reportingCycle         : Association to ReportingCycles @mandatory;
  periodStart            : Date @mandatory;
  periodEnd              : Date @mandatory;
  status                 : EstadoPeriodoTiempo default 'OPEN';
  submittedAt            : Timestamp;
  internallyApprovedAt   : Timestamp;
  sentToClientAt         : Timestamp;
  clientApprovedAt       : Timestamp;
  closedAt               : Timestamp;
  reopenedAt             : Timestamp;
  reopenedByUserID       : String(255);
  reopeningReason        : String(1000);
  entries                : Association to many TimeEntries on entries.billingPeriod = $self;
}

@assert.unique: { assignmentWeek: [assignment, weekStart] }
entity WeeklyTimesheets : cuid, managed {
  assignment             : Association to ProjectAssignments @mandatory;
  employee               : Association to Empleados @mandatory;
  weekStart              : Date @mandatory;
  weekEnd                : Date @mandatory;
  status                 : EstadoHojaSemanal default 'OPEN';
  submittedAt            : Timestamp;
  leaderApprovedAt       : Timestamp;
  internallyApprovedAt   : Timestamp;
  returnedAt             : Timestamp;
  returnComment          : String(1000);
  currentApprover        : Association to Empleados;
  version                : Integer default 1 @odata.etag;
  entries                : Composition of many TimeEntries on entries.timesheet = $self;
}

entity WeeklyTimeApprovalEvents : cuid, managed {
  employee               : Association to Empleados @mandatory;
  weekStart              : Date @mandatory;
  type                   : String(40) @mandatory;
  actorUserID            : String(255);
  actorEmployee          : Association to Empleados;
  targetEmployee         : Association to Empleados;
  detail                 : String(1000);
  occurredAt             : Timestamp @mandatory;
}

// Histórico de personas que llegaron al cierre de un ciclo con horas
// pendientes. Una fila representa una asignación y un corte; los correos
// diarios actualizan la misma fila para conservar una trazabilidad útil en
// evaluaciones posteriores sin inflar el historial con un registro por email.
@assert.unique: {assignmentCutoff: [assignment, cutoffDate]}
entity TimeEntryCutoffBreaches : cuid, managed {
  project                 : Association to Projects @mandatory;
  assignment              : Association to ProjectAssignments @mandatory;
  employee                : Association to Empleados @mandatory;
  cycleStart              : Date @mandatory;
  cutoffDate              : Date @mandatory;
  expectedHours           : Decimal(9, 2) @mandatory;
  registeredHours         : Decimal(9, 2) @mandatory;
  pendingHours            : Decimal(9, 2) @mandatory;
  status                  : EstadoIncumplimientoCorte default 'OPEN';
  firstDetectedAt         : Timestamp @mandatory;
  lastDetectedAt          : Timestamp @mandatory;
  resolvedAt              : Timestamp;
  maximumDaysOverdue      : Integer default 1;
  reminderCount           : Integer default 0;
  lastReminderOn          : Date;
}

entity TimeBulkCopyOperations : cuid, managed {
  employee               : Association to Empleados @mandatory;
  sourceEntryID          : UUID @mandatory;
  sourceDate             : Date @mandatory;
  scope                  : String(15) @mandatory;
  status                 : String(15) @mandatory default 'ACTIVE';
  requestedCount         : Integer default 0;
  createdCount           : Integer default 0;
  omittedCount           : Integer default 0;
  summary                : String(500);
  undoneAt               : Timestamp;
  items                  : Composition of many TimeBulkCopyItems on items.operation = $self;
}

entity TimeBulkCopyItems : cuid, managed {
  operation              : Association to TimeBulkCopyOperations @mandatory;
  entryID                : UUID @mandatory;
  destinationDate       : Date @mandatory;
  createdVersion         : Integer @mandatory default 1;
  status                 : String(15) @mandatory default 'CREATED';
}

entity TimeEntries : cuid, managed {
  timesheet              : Association to WeeklyTimesheets @mandatory;
  billingPeriod          : Association to BillingPeriods;
  assignment             : Association to ProjectAssignments @mandatory;
  employee               : Association to Empleados @mandatory;
  workDate               : Date @mandatory;
  durationHours          : Decimal(7, 2) @mandatory;
  requestedType          : TipoTiempoSolicitado default 'REGULAR';
  description            : String(2000);
  evidenceRequired       : Boolean default false;
  approximateStartTime   : Time;
  approximateEndTime     : Time;
  timeZone               : String(80);
  priorAuthorization     : Boolean default false;
  exceptionalReason      : String(1000);
  status                 : EstadoRegistroTiempo default 'DRAFT';
  dailyHoursWarning      : Boolean default false;
  commercialTreatment    : TratamientoComercial default 'PENDING';
  // Horas que se le cobran al cliente.
  billableHours          : Decimal(7, 2) default 0;
  // Horas que se le reconocen al recurso. Normalmente iguales a las
  // facturables; se separan porque hay horas que el cliente no aprueba y
  // que Sabnez igual compensa. Esa diferencia es costo sin ingreso y tiene
  // que verse, no desaparecer.
  payableHours           : Decimal(7, 2) default 0;
  // Corrección manual. Si viene con valor le gana a la regla del proyecto
  // y el recalculo no la pisa nunca.
  treatmentOverride      : TratamientoComercial;
  overrideReason         : String(1000);
  overriddenByUserID     : String(255);
  overriddenAt           : Timestamp;
  saleRateSnapshot       : Decimal(19, 2);
  internalCostSnapshot   : Decimal(19, 2);
  version                : Integer default 1 @odata.etag;
  evidence               : Composition of many Attachments;
  revisions              : Composition of many TimeEntryRevisions on revisions.entry = $self;
  decisions              : Composition of many TimeEntryDecisions on decisions.entry = $self;
}

/**
 * De dónde sale o a dónde se va una hora de compensatorio.
 */
type OrigenCompensatorio : String(15) enum {
  EARNED  = 'EARNED';   // trabajada y no cobrada al cliente
  TAKEN   = 'TAKEN';    // tomada como descanso
  ADJUST  = 'ADJUST';   // corrección a mano
  EXPIRED = 'EXPIRED';  // vencida sin tomarse
};

/**
 * El libro de compensatorios.
 *
 * Cuando el cliente no aprueba unas horas que el recurso sí trabajó,
 * esas horas no se cobran pero se le siguen debiendo a la persona.
 * Hasta ahora ese saldo no existía en ninguna parte: se veía la brecha
 * en el tablero y se acababa ahí.
 *
 * Cada fila es un movimiento con signo. El saldo de alguien es la suma
 * de sus filas, no un campo que haya que mantener al día: así no puede
 * quedar desalineado con lo que lo produjo.
 */
entity CompensatoryLedger : cuid, managed {
  employee   : Association to Empleados @mandatory;
  entryDate  : Date @mandatory;
  // Positivo cuando se gana, negativo cuando se toma.
  hours      : Decimal(7, 2) @mandatory;
  origin     : OrigenCompensatorio @mandatory;
  // De qué registro de tiempo salió, para poder rehacer el cálculo sin
  // duplicar lo ya asentado.
  timeEntry  : Association to TimeEntries;
  // Qué ausencia lo consumió.
  absenceID  : UUID;
  reason     : String(500);
}

entity TimeEntryRevisions : cuid, managed {
  entry                  : Association to TimeEntries @mandatory;
  revisionNumber         : Integer @mandatory;
  actorUserID            : String(255) @mandatory;
  reason                 : String(1000) @mandatory;
  previousDurationHours  : Decimal(7, 2);
  newDurationHours       : Decimal(7, 2);
  previousDescription    : String(2000);
  newDescription         : String(2000);
}

entity TimeEntryDecisions : cuid, managed {
  entry                  : Association to TimeEntries @mandatory;
  decisionType           : String(30) @mandatory;
  decision               : String(30) @mandatory;
  actorUserID            : String(255) @mandatory;
  actorEmployee          : Association to Empleados;
  comment                : String(1000);
  recognizedHours        : Decimal(7, 2);
  recognizedValue        : Decimal(19, 2);
  decidedAt              : Timestamp @mandatory;
}
