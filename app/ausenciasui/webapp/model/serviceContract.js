sap.ui.define([], function () {
  "use strict";

  return Object.freeze({
    actions: Object.freeze({
      getSummary: "obtenerMiResumen",
      getRequests: "obtenerMisSolicitudes",
      saveDraft: "guardarBorrador",
      submit: "enviarSolicitud",
      cancel: "cancelarSolicitud",
      deleteDraft: "eliminarBorrador"
    }),
    entities: Object.freeze({
      absenceTypes: "TiposAusencia"
    }),
    attachments: Object.freeze({
      parentEntitySet: "MisAusencias",
      navigationProperty: "soportes",
      parentForeignKey: "up__ID",
      contentProperty: "content",
      maximumFiles: 5,
      maximumFileSizeBytes: 10 * 1024 * 1024,
      allowedExtensions: Object.freeze(["pdf", "png", "jpg", "jpeg"]),
      allowedMimeTypes: Object.freeze([
        "application/pdf",
        "image/png",
        "image/jpeg"
      ])
    })
  });
});
