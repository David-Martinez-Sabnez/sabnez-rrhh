sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/UIComponent",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/m/Dialog",
  "sap/m/VBox",
  "sap/m/Label",
  "sap/m/DatePicker",
  "sap/m/Text",
  "sap/m/Button",
  "sabnez/com/tiemposadminui/model/formatter",
], function (Controller, UIComponent, MessageToast, MessageBox, Dialog, VBox, Label, DatePicker, Text, Button, formatter) {
  "use strict";

  return Controller.extend("sabnez.com.tiemposadminui.controller.BaseController", {
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
      var source = event.getSource ? event.getSource() : event;
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

    // Las fechas de cierre y reapertura son decisiones de negocio. Este
    // diálogo reutilizable evita esconderlas detrás de la fecha del equipo.
    askDate: function (options) {
      options = options || {};
      return new Promise(function (resolve) {
        var now = new Date();
        var localToday = [
          now.getFullYear(),
          String(now.getMonth() + 1).padStart(2, "0"),
          String(now.getDate()).padStart(2, "0"),
        ].join("-");
        var picker = new DatePicker({
          value: options.value || localToday,
          valueFormat: "yyyy-MM-dd",
          displayFormat: "dd/MM/yyyy",
          width: "100%",
        });
        var settled = false;
        var finish = function (value) {
          if (settled) return;
          settled = true;
          dialog.close();
          resolve(value);
        };
        var dialog = new Dialog({
          title: options.title || "Seleccionar fecha",
          contentWidth: "28rem",
          content: new VBox({
            items: [
              new Text({ text: options.message || "Indica la fecha que deseas utilizar." }).addStyleClass("sapUiSmallMarginBottom"),
              new Label({ text: options.label || "Fecha", required: true }),
              picker,
            ],
          }).addStyleClass("sapUiSmallMargin"),
          beginButton: new Button({ text: "Cancelar", press: function () { finish(null); } }),
          endButton: new Button({
            text: options.acceptText || "Confirmar",
            type: "Emphasized",
            press: function () {
              var value = picker.getValue();
              if (!value || !picker.isValidValue()) {
                picker.setValueState("Error");
                picker.setValueStateText("Selecciona una fecha válida.");
                return;
              }
              finish(value);
            },
          }),
          afterClose: function () { dialog.destroy(); },
          escapeHandler: function (promise) { finish(null); promise.resolve(); },
        });
        dialog.open();
      });
    },

    // Abre un fragment de diálogo y lo cachea por nombre.
    openDialog: async function (nombre) {
      this._dialogs = this._dialogs || {};
      if (!this._dialogs[nombre]) {
        this._dialogs[nombre] = await this.loadFragment({
          name: "sabnez.com.tiemposadminui.fragment." + nombre,
        });
      }
      this._dialogs[nombre].open();
      return this._dialogs[nombre];
    },

    closeDialog: function (nombre) {
      if (this._dialogs && this._dialogs[nombre]) this._dialogs[nombre].close();
    },

    onNavBack: function () {
      this.getRouter().navTo("projects");
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
