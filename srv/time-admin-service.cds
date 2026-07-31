using { sabnez.times as times } from '../db/time-management';
using { sabnez.rrhh as rrhh } from '../db/schema';

service TimeAdminService @(
  path    : '/tiempos-admin',
  requires: 'TimeAdmin'
) {
  @readonly
  entity Empleados as select from rrhh.Empleados {
    key ID,
        nombreCompleto,
        correoCorporativo,
        fechaIngreso,
        fechaRetiro,
        estado.codigo as estadoCodigo
  } where estado.codigo = 'AC';

  entity Clientes       as projection on times.Clients;
  entity Contratos      as projection on times.ClientContracts;
  entity Proyectos      as projection on times.Projects;
  entity CiclosReporte  as projection on times.ReportingCycles;
  entity Asignaciones   as projection on times.ProjectAssignments;
  entity Aprobadores    as projection on times.ProjectApprovers;

  @restrict: [{ grant: '*', to: 'TimeFinance' }]
  entity Tarifas        as projection on times.AssignmentRates;
}
