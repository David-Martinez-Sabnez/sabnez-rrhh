namespace sabnez.times.reporting;

using {sabnez.times as times} from './time-management';

entity TimeDetails  as
    select from times.TimeEntries as entry {
        key entry.ID                                  as ID,
            entry.workDate                            as workDate,

            entry.employee.ID                         as employee_ID,
            entry.employee.codigoInterno              as employeeCode,
            entry.employee.nombreCompleto             as employeeName,

            entry.assignment.ID                       as assignment_ID,
            entry.assignment.role                     as assignmentRole,
            entry.assignment.commercialAllocation     as commercialAllocation,

            entry.assignment.project.ID               as project_ID,
            entry.assignment.project.code             as projectCode,
            entry.assignment.project.name             as projectName,

            entry.assignment.project.client.ID        as client_ID,
            entry.assignment.project.client.legalName as clientName,

            entry.approximateStartTime                as approximateStartTime,
            entry.approximateEndTime                  as approximateEndTime,
            entry.requestedType                       as requestedType,
            case
                entry.requestedType
                when 'REGULAR'
                     then 'Tiempo regular'
                when 'OVERTIME'
                     then 'Hora extra'
                when 'NIGHT'
                     then 'Trabajo nocturno'
                when 'SUNDAY'
                     then 'Trabajo dominical'
                when 'HOLIDAY'
                     then 'Trabajo festivo'
                when 'COMPENSATORY'
                     then 'Tiempo compensatorio'
                when 'FLEX_INCLUDED'
                     then 'Incluido en modalidad flexible'
                else entry.requestedType
            end                                       as requestedTypeText       : String(80),
            entry.description                         as description,

            entry.durationHours                       as registeredHours,
            entry.billableHours                       as billableHours,

            entry.commercialTreatment                 as commercialTreatment,
            case
                entry.commercialTreatment
                when 'INCLUDED_FULL_TIME'
                     then 'Incluido en dedicación mensual'
                when 'BILLABLE_REGULAR'
                     then 'Facturable regular'
                when 'BILLABLE_OVERTIME'
                     then 'Facturable hora extra'
                when 'SPECIAL_RATE'
                     then 'Tarifa especial'
                when 'NON_BILLABLE'
                     then 'No facturable'
                when 'PENDING'
                     then 'Pendiente de clasificación'
                else entry.commercialTreatment
            end                                       as commercialTreatmentText : String(100),
            entry.status                              as entryStatus,
            case
                entry.status
                when 'DRAFT'
                     then 'Borrador'
                when 'SUBMITTED'
                     then 'Enviado'
                when 'UNDER_REVIEW'
                     then 'En revisión'
                when 'RETURNED'
                     then 'Devuelto'
                when 'LEADER_APPROVED'
                     then 'Aprobado por líder'
                when 'INTERNALLY_APPROVED'
                     then 'Aprobado internamente'
                when 'CLIENT_OBJECTED'
                     then 'Objetado por cliente'
                when 'CORRECTED'
                     then 'Corregido'
                when 'CLOSED'
                     then 'Cerrado'
                when 'INVOICED'
                     then 'Facturado'
                when 'VOIDED'
                     then 'Anulado'
                else entry.status
            end                                       as entryStatusText         : String(80),
            case
                entry.status
                when 'INTERNALLY_APPROVED'
                     then 3
                when 'LEADER_APPROVED'
                     then 3
                when 'CLOSED'
                     then 3
                when 'INVOICED'
                     then 3

                when 'SUBMITTED'
                     then 2
                when 'UNDER_REVIEW'
                     then 2
                when 'CORRECTED'
                     then 2

                when 'RETURNED'
                     then 1
                when 'CLIENT_OBJECTED'
                     then 1
                when 'VOIDED'
                     then 1

                else 0
            end                                       as entryStatusCriticality  : Integer,
            entry.timesheet.status                    as timesheetStatus,
            entry.billingPeriod.status                as billingPeriodStatus,

            entry.evidenceRequired                    as evidenceRequired,
            entry.dailyHoursWarning                   as dailyHoursWarning,
            entry.priorAuthorization                  as priorAuthorization,
            entry.exceptionalReason                   as exceptionalReason,
            entry.timeZone                            as timeZone,

            entry.createdAt                           as createdAt,
            entry.modifiedAt                          as modifiedAt
    };

entity DailySummary as
    select from times.TimeEntries as entry {
        key entry.workDate                            as workDate,
        key entry.employee.ID                         as employee_ID,
        key entry.assignment.project.ID               as project_ID,

            entry.employee.codigoInterno              as employeeCode,
            entry.employee.nombreCompleto             as employeeName,

            entry.assignment.project.code             as projectCode,
            entry.assignment.project.name             as projectName,

            entry.assignment.project.client.ID        as client_ID,
            entry.assignment.project.client.legalName as clientName,

            cast(
                sum(entry.durationHours) as Decimal(15, 2)
            )                                         as registeredHours,

            cast(
                sum(entry.billableHours) as Decimal(15, 2)
            )                                         as billableHours
    }
    group by
        entry.workDate,
        entry.employee.ID,
        entry.employee.codigoInterno,
        entry.employee.nombreCompleto,
        entry.assignment.project.ID,
        entry.assignment.project.code,
        entry.assignment.project.name,
        entry.assignment.project.client.ID,
        entry.assignment.project.client.legalName;
