namespace sabnez.collectionaccounts;

using { cuid, managed } from '@sap/cds/common';
using { sabnez.rrhh.Empleados, sabnez.rrhh.Contratos } from './schema';
using { sabnez.times.ProjectAssignments } from './time-management';

type EstadoCuentaCobro : String(30) enum {
  DRAFT                 = 'DRAFT';
  PENDING_SIGNATURE     = 'PENDING_SIGNATURE';
  SIGNED                = 'SIGNED';
  SUBMITTED             = 'SUBMITTED';
  UNDER_HR_REVIEW       = 'UNDER_HR_REVIEW';
  CORRECTION_REQUESTED  = 'CORRECTION_REQUESTED';
  HR_APPROVED           = 'HR_APPROVED';
  // Estado final: el expediente ya salió hacia contabilidad y no se reenvía.
  SENT_TO_ACCOUNTING    = 'SENT_TO_ACCOUNTING';
  HR_REJECTED           = 'HR_REJECTED';
  CANCELLED             = 'CANCELLED';
};

type RequisitoSeguridadSocial : String(20) enum {
  @title: 'Afiliación como independiente'
  AFFILIATION = 'AFFILIATION';
  @title: 'Comprobante PILA'
  PILA        = 'PILA';
  @title: 'No requerido para esta cuenta'
  NONE        = 'NONE';
};

type EstadoSoporteCuenta : String(20) enum {
  PENDING  = 'PENDING';
  CLEAN    = 'CLEAN';
  REJECTED = 'REJECTED';
  NOT_REQUIRED = 'NOT_REQUIRED';
};

@assert.unique: { numeroCuenta: [numero] }
entity CollectionAccounts : cuid, managed {
  numero                    : String(50) @mandatory;
  // Opcionales para cuentas asistidas de terceros sin ficha de empleado.
  employee                  : Association to Empleados;
  contract                  : Association to Contratos;
  origin                    : String(25) @mandatory default 'SELF_SERVICE';
  preparedByUserID          : String(255);
  periodStart               : Date @mandatory;
  periodEnd                 : Date @mandatory;
  currency                  : String(3) @mandatory default 'COP';
  grossAmount               : Decimal(19, 2) @mandatory;
  status                    : EstadoCuentaCobro default 'PENDING_SIGNATURE';
  combined                  : Boolean default false;

  employeeNameSnapshot      : String(240) @mandatory;
  documentTypeSnapshot      : String(30) @mandatory;
  documentNumberSnapshot    : String(30) @mandatory;
  documentCitySnapshot      : String(100);
  taxAddressSnapshot        : String(200);
  taxCitySnapshot           : String(100);
  bankNameSnapshot          : String(120) @mandatory;
  bankAccountTypeSnapshot   : String(20) @mandatory;
  bankAccountNumberSnapshot : String(60) @mandatory;
  bankHolderSnapshot        : String(240) @mandatory;

  socialSecurityRequirement : RequisitoSeguridadSocial @mandatory;
  socialSecurityFileName    : String(255);
  socialSecurityMimeType    : String(100);
  socialSecurityContent     : LargeBinary;
  socialSecurityHash        : String(128);
  socialSecurityStatus      : EstadoSoporteCuenta default 'PENDING';
  socialSecurityUploadedAt  : Timestamp;

  signatureName             : String(240);
  signatureStatement        : String(1000);
  signedAt                  : Timestamp;
  signedByUserID            : String(255);
  signatureIp               : String(100);
  signatureUserAgent        : String(500);
  signatureHash             : String(128);

  generatedFileName         : String(255);
  generatedMimeType         : String(100);
  generatedContent          : LargeBinary;
  generatedHash             : String(128);
  generatedAt               : Timestamp;

  draftFileName             : String(255);
  draftMimeType             : String(100);
  draftContent              : LargeBinary;
  draftHash                 : String(128);
  signatureMethod           : String(30);

  submittedAt               : Timestamp;
  correctionReason          : String(1000);
  correctionRequestedAt     : Timestamp;
  correctionResolvedAt      : Timestamp;
  correctionResolvedBy      : String(255);
  hrComment                 : String(1000);
  hrReviewedAt              : Timestamp;
  hrReviewedBy              : String(255);

  // Envío del expediente a contabilidad. La fecha es la marca que impide
  // reenviar la misma cuenta en un lote posterior.
  accountingSentAt          : Timestamp;
  accountingSentBy          : String(255);
  accountingRecipient       : String(320);
  accountingBatchID         : String(60);

  items                     : Composition of many CollectionAccountItems
                                on items.account = $self;
  events                    : Composition of many CollectionAccountEvents
                                on events.account = $self;
}

entity CollectionAccountItems : cuid, managed {
  account          : Association to CollectionAccounts @mandatory;
  assignment       : Association to ProjectAssignments;
  serviceStart     : Date @mandatory;
  serviceEnd       : Date @mandatory;
  clientName       : String(180) @mandatory;
  projectCode      : String(40) @mandatory;
  projectName      : String(180) @mandatory;
  modality         : String(15) @mandatory;
  concept          : String(500) @mandatory;
  approvedHours    : Decimal(9, 2) @mandatory;
  unitRate         : Decimal(19, 2);
  amount           : Decimal(19, 2) @mandatory;
  calculationMethod: String(30) @mandatory;
}

entity CollectionAccountEvents : cuid, managed {
  account      : Association to CollectionAccounts @mandatory;
  type         : String(50) @mandatory;
  actorUserID  : String(255);
  detail       : String(1000);
  occurredAt   : Timestamp @mandatory;
}
