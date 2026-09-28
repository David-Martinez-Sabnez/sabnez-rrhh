using { sabnez.times as times } from '../db/time-management';
using { sabnez.rrhh as rrhh } from '../db/schema';
using { sabnez.calendars as calendars } from '../db/calendars';

service TimeAdminService @(
  path    : '/tiempos-admin',
  requires: 'TimeAdmin'
) {
  type ResultadoDocumento {
    exito      : Boolean;
    mensaje    : String(500);
    documentoID: UUID;
  }
  type DocumentoContrato {
    ID        : UUID;
    contratoID: UUID;
    filename  : String(255);
    mimeType  : String(100);
    status    : String(30);
  }
  type ResultadoCicloVida {
    exito                 : Boolean;
    mensaje               : String(500);
    asignacionesCerradas  : Integer;
    aprobadoresCerrados   : Integer;
    contratosDesactivados : Integer;
  }
  type PerfilUsuario {
    usuario                     : String(255);
    puedeVerTarifas             : Boolean;
    puedeReactivarAsignaciones  : Boolean;
  }
  type AsignacionSinTarifa {
    assignmentID : UUID;
    projectID    : UUID;
    projectName  : String(255);
    employeeName : String(255);
    desde        : Date;
    hasta        : Date;
    horas        : Decimal(9, 2);
  }
  type ResultadoReglas {
    exito                  : Boolean;
    mensaje                : String(500);
    proyectosProcesados    : Integer;
    reglasCreadas          : Integer;
    tarifasHeredadas       : Integer;
    registrosReclasificados: Integer;
    registrosOmitidos      : Integer;
    horasFacturables       : Decimal(9, 2);
    horasPagables          : Decimal(9, 2);
  }
  type ResultadoCorreccion {
    exito                : Boolean;
    mensaje              : String(500);
    registrosActualizados: Integer;
    registrosOmitidos    : Integer;
    horasFacturables     : Decimal(9, 2);
    horasPagables        : Decimal(9, 2);
    // Horas que se le reconocen al recurso y no se le cobran al cliente.
    // Es lo que a Sabnez le toca compensar de su bolsillo.
    horasPorCompensar    : Decimal(9, 2);
  }
  type ArchivoContrato {
    filename       : String(255);
    mimeType       : String(100);
    contenidoBase64: LargeString;
  }
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
  @readonly entity Calendarios as select from calendars.WorkCalendars {
    key ID, name, countryCode, hoursPerDay, active
  } where active = true;
  entity CiclosReporte  as projection on times.ReportingCycles;
  entity Asignaciones   as projection on times.ProjectAssignments;
  entity Aprobadores    as projection on times.ProjectApprovers;

  // Qué se le puede cobrar al cliente en cada proyecto, por tipo de tiempo.
  entity ReglasFacturacion as projection on times.ProjectBillingRules;

  @restrict: [{ grant: '*', to: 'TimeFinance' }]
  entity Tarifas        as projection on times.AssignmentRates;

  function miPerfil() returns PerfilUsuario;

  @requires: 'TimeFinance'
  function obtenerAsignacionesSinTarifa() returns many AsignacionSinTarifa;

  // Bajas explícitas. Sustituyen al borrado, que el servicio bloquea
  // en cuanto la entidad tiene dependencias.
  action desactivarCliente(clienteID: UUID)                      returns ResultadoCicloVida;
  action reactivarCliente(clienteID: UUID)                       returns ResultadoCicloVida;
  action cerrarProyecto(proyectoID: UUID, fechaCierre: Date)     returns ResultadoCicloVida;
  action reabrirProyecto(proyectoID: UUID, fechaApertura: Date)  returns ResultadoCicloVida;
  action finalizarAsignacion(asignacionID: UUID, fechaFin: Date) returns ResultadoCicloVida;
  @requires: 'TimeAssignmentReactivate'
  action reactivarAsignacion(asignacionID: UUID, fechaApertura: Date) returns ResultadoCicloVida;
  action finalizarAprobador(aprobadorID: UUID, fechaFin: Date)   returns ResultadoCicloVida;
  action finalizarTarifa(tarifaID: UUID, fechaFin: Date)         returns ResultadoCicloVida;
  action finalizarContrato(contratoID: UUID, fechaFin: Date)     returns ResultadoCicloVida;

  // Siembra la matriz de facturabilidad de un proyecto con los valores
  // que corresponden a su modalidad. No pisa lo que ya esté configurado.
  action sembrarReglasFacturacion(proyectoID: UUID) returns ResultadoReglas;

  // Completa matrices y reclasifica el histórico pendiente de todos los
  // proyectos. Las correcciones manuales y los registros cerrados se respetan.
  @requires: 'TimeFinance'
  action completarClasificacionComercial() returns ResultadoReglas;

  // Corrección manual de la facturabilidad. El caso típico: el cliente no
  // aprobó un sábado que el recurso sí trabajó. Las horas dejan de
  // cobrarse pero se le siguen reconociendo a la persona.
  @requires: 'TimeFinance'
  action corregirFacturacion(
    registroIDs: many UUID,
    tratamiento: String(25),
    motivo: String(1000)
  ) returns ResultadoCorreccion;

  // Devuelve los registros a lo que diga la regla del proyecto.
  @requires: 'TimeFinance'
  action quitarCorreccionFacturacion(registroIDs: many UUID) returns ResultadoCorreccion;

  function obtenerDocumentosContrato() returns many DocumentoContrato;

  action cargarDocumentoContrato(
    contratoID: UUID,
    nombreArchivo: String(255),
    mimeType: String(100),
    contenido: LargeBinary
  ) returns ResultadoDocumento;
  action descargarDocumentoContrato(contratoID: UUID, documentoID: UUID) returns ArchivoContrato;
}
