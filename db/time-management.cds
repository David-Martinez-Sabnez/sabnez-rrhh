namespace sabnez.times;

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

@assert.unique: { taxId: [taxIdentification] }
entity Clients : cuid, managed {
  legalName             : String(180) @mandatory;
  tradeName             : String(180);
  taxIdentification     : String(60)  @mandatory;
  countryCode           : String(2)   @mandatory default 'CO';
  defaultCurrency       : String(3)   @mandatory default 'COP';
  timeZone              : String(80)  @mandatory default 'America/Bogota';
  taxExempt              : Boolean default false;
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
  modality               : ModalidadProyecto @mandatory;
  currency               : String(3) @mandatory default 'COP';
  timeZone               : String(80) @mandatory default 'America/Bogota';
  requiresDescription    : Boolean default false;
  requiresEvidence       : Boolean default false;
  requiresClientApproval : Boolean default false;
  approvalScheme         : EsquemaAprobacion default 'LEADER_THEN_ADMIN';
  dailyWarningHours      : Decimal(5, 2) default 16;
  status                 : EstadoMaestro default 'DRAFT';
  reportingCycles        : Composition of many ReportingCycles on reportingCycles.project = $self;
  assignments            : Composition of many ProjectAssignments on assignments.project = $self;
  approvers              : Composition of many ProjectApprovers on approvers.project = $self;
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
  currency               : String(3) @mandatory default 'COP';
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
  billableHours          : Decimal(7, 2) default 0;
  saleRateSnapshot       : Decimal(19, 2);
  internalCostSnapshot   : Decimal(19, 2);
  version                : Integer default 1 @odata.etag;
  evidence               : Composition of many Attachments;
  revisions              : Composition of many TimeEntryRevisions on revisions.entry = $self;
  decisions              : Composition of many TimeEntryDecisions on decisions.entry = $self;
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
