sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sabnez/com/finanzasui/model/formatter",
], function (Controller, UIComponent, MessageToast, MessageBox, formatter) {
  "use strict";

  return Controller.extend("sabnez.com.finanzasui.controller.BaseController", {
    formatter: formatter,

    getRouter: function () {
      return UIComponent.getRouterFor(this);
    },

    getData: function () {
      return this.getOwnerComponent().getData();
    },

    getViewModel: function () {
      return this.getOwnerComponent().getModel("view");
    },

    get: function (path) {
      return this.getViewModel().getProperty(path);
    },

    set: function (path, value) {
      this.getViewModel().setProperty(path, value);
    },

    // Fila del modelo sobre la que se pulsó un botón o un item.
    rowOf: function (event) {
      // itemPress entrega la tabla como source y la fila pulsada como
      // listItem. Si se toma solamente el source no existe contexto y la
      // navegación parece no responder.
      var source = event.getParameter && event.getParameter("listItem");
      source = source || (event.getSource ? event.getSource() : event);
      var ctx = source.getBindingContext("view");
      return ctx ? ctx.getObject() : null;
    },

    toast: function (mensaje) {
      MessageToast.show(mensaje);
    },

    // Un fallo de servidor se muestra donde el usuario está mirando, con
    // el mensaje del servicio, que ya viene redactado para persona.
    fail: function (error) {
      MessageBox.error(error && error.message ? error.message : String(error));
    },

    // Los textos de los botones se fijan a mano: MessageBox los saca del
    // idioma del navegador, y el resto de la aplicación está en español.
    confirm: function (mensaje, titulo, textoAceptar) {
      var aceptar = textoAceptar || "Confirmar";
      return new Promise(function (resolve) {
        MessageBox.confirm(mensaje, {
          title: titulo || "Confirmar",
          actions: [aceptar, "Cancelar"],
          emphasizedAction: aceptar,
          onClose: function (accion) { resolve(accion === aceptar); },
        });
      });
    },

    // Abre un fragment de diálogo y lo cachea por nombre.
    openDialog: async function (nombre) {
      this._dialogs = this._dialogs || {};
      if (!this._dialogs[nombre]) {
        this._dialogs[nombre] = await this.loadFragment({
          name: "sabnez.com.finanzasui.fragment." + nombre,
        });
      }
      this._dialogs[nombre].open();
      return this._dialogs[nombre];
    },

    closeDialog: function (nombre) {
      if (this._dialogs && this._dialogs[nombre]) this._dialogs[nombre].close();
    },

    onNavBack: function () {
      this.getRouter().navTo("invoices");
    },

    onRefresh: async function () {
      await this.getData().refresh();
      this.toast("Información actualizada.");
    },

    onDismissError: function () {
      this.set("/error", "");
    },
  });
});
