using {sabnez.times as times} from '../db/time-management';
using {sabnez.times.reporting as reporting} from '../db/time-reporting';

@path    : '/time-reports'
@requires: 'TimeAdmin'
service TimeReportingService {

  @readonly
  entity TimeDetails  as projection on reporting.TimeDetails;

  @readonly
  entity DailySummary as projection on reporting.DailySummary;

  @readonly
  entity Clients      as
    projection on times.Clients {
      key ID,
          legalName,
          tradeName,
          status
    };

  @readonly
  entity Projects     as
    projection on times.Projects {
      key ID,
          code,
          name,
          client.ID        as client_ID,
          client.legalName as clientName,
          status
    };

  @readonly
  entity Employees    as
    select from times.ProjectAssignments as assignment {
      key assignment.employee.ID             as ID,
          assignment.employee.codigoInterno  as employeeCode,
          assignment.employee.nombreCompleto as employeeName
    }
    group by
      assignment.employee.ID,
      assignment.employee.codigoInterno,
      assignment.employee.nombreCompleto;

  type DashboardSummary {
    totalHours    : Decimal(15, 2);
    billableHours : Decimal(15, 2);
    approvedHours : Decimal(15, 2);
    pendingHours  : Decimal(15, 2);
    employeeCount : Integer;
    projectCount  : Integer;
    clientCount   : Integer;
    entryCount    : Integer;
  }

  type DashboardAnalyticsResult {
    dataJson : LargeString;
  }

  action   getDashboardSummary(dateFrom: Date,
                               dateTo: Date,
                               clientIDsJson: LargeString,
                               projectIDsJson: LargeString,
                               employeeIDsJson: LargeString,
                               statusIDsJson: LargeString)   returns DashboardSummary;

  action   getDashboardAnalytics(dateFrom: Date,
                                 dateTo: Date,
                                 clientIDsJson: LargeString,
                                 projectIDsJson: LargeString,
                                 employeeIDsJson: LargeString,
                                 statusIDsJson: LargeString) returns DashboardAnalyticsResult;

  type GeneratedDeliverable {
    fileName      : String(255);
    mimeType      : String(120);
    contentBase64 : LargeString;
    entryCount    : Integer;
    evidenceCount : Integer;
    warningText   : String(1000);
  }

  function getCurrentUserPermissions()                       returns {
    canGenerateDeliverables : Boolean;
  };

  @requires: 'TimeDeliverables'
  action   generateDeliverable(dateFrom: Date,
                               dateTo: Date,
                               clientID: UUID,
                               projectIDsJson: LargeString,
                               formatType: String(20),
                               includeEvidence: Boolean)     returns GeneratedDeliverable;
}
