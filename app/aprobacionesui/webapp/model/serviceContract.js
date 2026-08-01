sap.ui.define([], function () {
  "use strict";

  // Mantener los nombres del servicio en un único lugar permite sustituir
  // el motor de workflow sin acoplar las vistas ni el controlador.
  return Object.freeze({
    operations: Object.freeze({
      getSummary: "obtenerMiResumen",
      getTasks: "obtenerMisTareas",
      getTaskDetail: "obtenerDetalleTarea",
      getDelegations: "obtenerMisDelegaciones",
      approve: "aprobar",
      reject: "rechazar",
      forward: "reenviar",
      saveDelegation: "guardarDelegacion",
      revokeDelegation: "revocarDelegacion",
      downloadAbsenceAttachment: "descargarSoporteAusencia",
    }),
    taskRoles: Object.freeze({
      owner: "PRIMARY",
      backup: "BACKUP",
      substitute: "DELEGATE",
    }),
    entities: Object.freeze({
      eligibleEmployees: "EmpleadosElegibles",
    }),
    delegationTypes: Object.freeze(["BACKUP", "SUBSTITUTE"]),
    pendingStates: Object.freeze(["WAITING", "OPEN", "PROCESSING"]),
  });
});
