using {sabnez.collectionaccounts as ca} from '../db/collection-accounts';

service CollectionAccountService @(
  path: '/cuentas-cobro',
  requires: 'authenticated-user'
) {
  type Contexto {
    employeeID     : UUID;
    employeeName   : String(240);
    isProvider     : Boolean;
    isHR           : Boolean;
    canGenerate    : Boolean;
    pendingCount   : Integer;
    historyCount   : Integer;
    // Acumulado de lo efectivamente cobrado: solo suma las cuentas que RR. HH.
    // ya aprobó para pago.
    approvedAmount : Decimal(19, 2);
    approvedCount  : Integer;
    currency       : String(3);
    message        : String(500);
  }

  type EligiblePeriod {
    periodKey             : String(120);
    assignmentID          : UUID;
    projectCode           : String(40);
    projectName           : String(180);
    clientName            : String(180);
    modality              : String(15);
    periodStart           : Date;
    periodEnd             : Date;
    approvedHours         : Decimal(9, 2);
    amount                : Decimal(19, 2);
    currency              : String(3);
    calculationMethod     : String(30);
    eligible              : Boolean;
    blockingReason        : String(500);
    securityRequirement   : String(20);
    securityRequirementText: String(180);
  }

  type PeriodSelection {
    periodKey : String(120);
  }

  type AccountSummary {
    ID                    : UUID;
    number                : String(50);
    employeeName          : String(240);
    periodStart           : Date;
    periodEnd             : Date;
    grossAmount           : Decimal(19, 2);
    currency              : String(3);
    status                : String(30);
    statusText            : String(80);
    combined              : Boolean;
    itemCount             : Integer;
    socialRequirement     : String(20);
    socialRequirementText : String(180);
    hasSocialEvidence     : Boolean;
    canSign               : Boolean;
    canSubmit             : Boolean;
    canRequestCorrection  : Boolean;
    canCancel             : Boolean;
    canHRApprove          : Boolean;
    createdAt             : Timestamp;
    signedAt              : Timestamp;
    submittedAt           : Timestamp;
    hrReviewedAt          : Timestamp;
    origin                : String(25);
    originText            : String(80);
    preparedByUserID      : String(255);
    signatureMethod       : String(30);
  }

  type AssistedCreationResult {
    success       : Boolean;
    message       : String(500);
    account       : AccountSummary;
    fileName      : String(255);
    mimeType      : String(100);
    contentBase64 : LargeString;
  }

  type AssistedEmployee {
    ID                    : UUID;
    name                  : String(240);
    documentType          : String(30);
    documentNumber        : String(30);
    documentCity          : String(100);
    taxAddress            : String(200);
    taxCity               : String(100);
    bankName              : String(120);
    bankAccountType       : String(20);
    bankAccountNumber     : String(60);
    bankHolder            : String(240);
    hasActiveBank         : Boolean;
  }

  type AccountItem {
    ID                : UUID;
    projectCode       : String(40);
    projectName       : String(180);
    clientName        : String(180);
    modality          : String(15);
    concept           : String(500);
    serviceStart      : Date;
    serviceEnd        : Date;
    approvedHours     : Decimal(9, 2);
    unitRate          : Decimal(19, 2);
    amount            : Decimal(19, 2);
    calculationMethod : String(30);
  }

  type AccountEvent {
    ID          : UUID;
    type        : String(50);
    typeText    : String(100);
    actorUserID : String(255);
    detail      : String(1000);
    occurredAt  : Timestamp;
  }

  type AccountDetail {
    summary          : AccountSummary;
    documentType     : String(30);
    documentNumber   : String(30);
    documentCity     : String(100);
    taxAddress       : String(200);
    taxCity          : String(100);
    bankName         : String(120);
    bankAccountType  : String(20);
    bankAccountNumber: String(60);
    bankHolder       : String(240);
    correctionReason : String(1000);
    hrComment        : String(1000);
    items            : many AccountItem;
    events           : many AccountEvent;
  }

  type OperationResult {
    success : Boolean;
    message : String(500);
    account : AccountSummary;
    accounts: many AccountSummary;
  }

  // Opciones para los filtros del histórico. Se derivan de las cuentas que
  // realmente existen, de modo que no se ofrecen periodos vacíos.
  type AccountYearOption {
    year  : Integer;
    count : Integer;
  }

  type AccountPeriodOption {
    periodKey   : String(60);
    label       : String(120);
    year        : Integer;
    periodStart : Date;
    periodEnd   : Date;
    count       : Integer;
  }

  type AccountFilterOptions {
    defaultYear : Integer;
    years       : many AccountYearOption;
    periods     : many AccountPeriodOption;
  }

  // Expediente listo para contabilidad: la cuenta más el estado de sus dos
  // documentos, para que RR. HH. sepa antes de enviar si algo falta.
  type AccountingCandidate {
    ID                  : UUID;
    number              : String(50);
    employeeName        : String(240);
    documentNumber      : String(30);
    periodStart         : Date;
    periodEnd           : Date;
    grossAmount         : Decimal(19, 2);
    currency            : String(3);
    status              : String(30);
    statusText          : String(80);
    hasDocument         : Boolean;
    hasSocialEvidence   : Boolean;
    socialRequirementText: String(180);
    readyToSend         : Boolean;
    blockingReason      : String(500);
    approvedAt          : Timestamp;
    accountingSentAt    : Timestamp;
    accountingRecipient : String(320);
  }

  type AccountingDispatchResult {
    success       : Boolean;
    message       : String(500);
    recipient     : String(320);
    batchID       : String(60);
    sentCount     : Integer;
    skippedCount  : Integer;
    totalAmount   : Decimal(19, 2);
    currency      : String(3);
    zipSizeBytes  : Integer;
    skipped       : many AccountingSkipped;
  }

  type AccountingSkipped {
    number : String(50);
    reason : String(500);
  }

  type Parametro {
    clave       : String(60);
    grupo       : String(60);
    nombre      : String(120);
    descripcion : String(500);
    tipo        : String(15);
    valor       : String(500);
    sistema     : Boolean;
  }

  type ParametroResult {
    success   : Boolean;
    message   : String(500);
    parametro : Parametro;
  }

  type ReminderResult {
    success       : Boolean;
    message       : String(500);
    referenceDate : Date;
    dueSent       : Integer;
    overdueSent   : Integer;
    skipped       : Integer;
  }

  type DownloadFile {
    fileName      : String(255);
    mimeType      : String(100);
    contentBase64 : LargeString;
  }

  /**
   * Proyección para el List Report de RR. HH.
   *
   * Es de solo lectura: la cuenta la crea y firma el prestador, RR. HH. la
   * aprueba en el Centro de Aprobaciones y desde aquí solo se consulta y se
   * envía a contabilidad.
   *
   * El PDF y el soporte se exponen como streams de OData (@Core.MediaType), así
   * que Fiori Elements los ofrece como descarga sin código propio.
   */
  @readonly
  @requires: ['CollectionAccountHR', 'TimeFinance']
  entity CuentasCobro   as
    projection on ca.CollectionAccounts {
      key ID,
          numero                                as numero,
          employeeNameSnapshot                  as prestador,
          documentTypeSnapshot                  as tipoDocumento,
          documentNumberSnapshot                as numeroDocumento,
          periodStart,
          periodEnd,
          grossAmount,
          currency,
          status,
          socialSecurityRequirement,
          socialSecurityFileName,
          socialSecurityMimeType,
          socialSecurityStatus,
          generatedFileName,
          generatedMimeType,
          bankNameSnapshot                      as banco,
          bankAccountTypeSnapshot               as tipoCuenta,
          bankAccountNumberSnapshot             as numeroCuenta,
          bankHolderSnapshot                    as titularCuenta,
          signatureName                         as firmadaPor,
          signedAt,
          submittedAt,
          hrComment,
          hrReviewedAt,
          hrReviewedBy,
          accountingSentAt,
          accountingSentBy,
          accountingRecipient,
          accountingBatchID,
          origin,
          preparedByUserID,
          signatureMethod,
          createdAt,

          // Documentos descargables directamente por el navegador.
          generatedContent                      as documento,
          socialSecurityContent                 as soporte,

          items                                 as conceptos      : redirected to CuentasCobroConceptos,
          events                                as trazabilidad   : redirected to CuentasCobroEventos,

          // Campos calculados que el List Report usa para filtrar y para
          // colorear el semáforo del expediente. Se llenan en un after READ.
          virtual null                          as listaParaEnviar       : Boolean,
          virtual null                          as expedienteTexto       : String(500),
          virtual null                          as statusText            : String(80),
          virtual null                          as criticidad            : Integer,
          virtual null                          as criticidadExpediente  : Integer,
          virtual null                          as originText            : String(80)
    };

  /**
   * Conceptos y trazabilidad del expediente. Se proyectan aparte, sin la
   * asociación a la asignación: esa ruta arrastraba tarifas de venta y costos
   * internos a un servicio donde RR. HH. no tiene por qué verlos.
   */
  @readonly
  @requires: ['CollectionAccountHR', 'TimeFinance']
  entity CuentasCobroConceptos as
    projection on ca.CollectionAccountItems {
      key ID,
          account,
          projectCode,
          projectName,
          clientName,
          modality,
          concept,
          serviceStart,
          serviceEnd,
          approvedHours,
          amount,
          calculationMethod
    };

  @readonly
  @requires: ['CollectionAccountHR', 'TimeFinance']
  entity CuentasCobroEventos   as
    projection on ca.CollectionAccountEvents {
      key ID,
          account,
          type,
          actorUserID,
          detail,
          occurredAt
    };

  function getContext() returns Contexto;
  function getEligiblePeriods() returns many EligiblePeriod;
  function getMyAccounts(year: Integer, periodKey: String(60)) returns many AccountSummary;
  function getAccountFilterOptions() returns AccountFilterOptions;
  function getAccountDetail(accountID: UUID) returns AccountDetail;

  action createAccounts(selections: many PeriodSelection, combine: Boolean) returns OperationResult;
  action signAccount(accountID: UUID, signerName: String(240), accepted: Boolean) returns OperationResult;
  action uploadSocialSecurity(accountID: UUID, fileName: String(255), mimeType: String(100), content: LargeBinary) returns OperationResult;
  action submitAccount(accountID: UUID) returns OperationResult;
  action requestCorrection(accountID: UUID, reason: String(1000)) returns OperationResult;
  action cancelDraft(accountID: UUID) returns OperationResult;
  action downloadAccount(accountID: UUID) returns DownloadFile;
  action downloadSocialSecurity(accountID: UUID) returns DownloadFile;

  @requires: ['CollectionAccountHR', 'TimeFinance']
  function getAssistedEmployees() returns many AssistedEmployee;

  @requires: ['CollectionAccountHR', 'TimeFinance']
  action createAssistedAccount(
    employeeID: UUID,
    periodStart: Date,
    periodEnd: Date,
    concept: String(500),
    grossAmount: Decimal(19,2),
    currency: String(3),
    socialSecurityRequirement: String(20)
  ) returns AssistedCreationResult;

  @requires: ['CollectionAccountHR', 'TimeFinance']
  action downloadAssistedDraft(accountID: UUID) returns DownloadFile;

  @requires: ['CollectionAccountHR', 'TimeFinance']
  action uploadAssistedSignedPackage(
    accountID: UUID,
    signedFileName: String(255),
    signedMimeType: String(100),
    signedContent: LargeBinary,
    supportFileName: String(255),
    supportMimeType: String(100),
    supportContent: LargeBinary
  ) returns OperationResult;

  @requires: 'CollectionAccountHR'
  function getHRAccounts(from: Date, to: Date, status: String(30)) returns many AccountSummary;

  // Recordatorios de generación de la cuenta de cobro. La dispara el
  // planificador (SAP Job Scheduling Service) una vez al día; es idempotente,
  // así que repetir la ejecución del mismo día no vuelve a notificar.
  @requires: 'CollectionAccountJob'
  action enviarRecordatoriosCuentaCobro(fecha: Date) returns ReminderResult;

  // La aprobación, la devolución y la resolución de correcciones se ejecutan
  // desde el Centro de Aprobaciones (procesos COLLECTION_ACCOUNT y
  // COLLECTION_ACCOUNT_CORRECTION), no desde esta app.

  @requires: 'CollectionAccountHR'
  action downloadHRReport(from: Date, to: Date, status: String(30)) returns DownloadFile;

  // --- Envío del expediente a contabilidad -------------------------------
  @requires: 'CollectionAccountHR'
  function getAccountingCandidates(from: Date, to: Date, includeSent: Boolean) returns many AccountingCandidate;

  @requires: 'CollectionAccountHR'
  action enviarCuentasAContabilidad(accountIDs: many UUID, nota: String(1000)) returns AccountingDispatchResult;

  // --- Parámetros: semilla del centro de configuración -------------------
  @requires: 'CollectionAccountHR'
  function getParametros(grupo: String(60)) returns many Parametro;

  @requires: 'Admin'
  action guardarParametro(clave: String(60), valor: String(500)) returns ParametroResult;
}

annotate CollectionAccountService with @cds.server.body_parser.limit: '20mb';
