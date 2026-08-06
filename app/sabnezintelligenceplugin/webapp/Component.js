sap.ui.define(
  [
    "sap/ui/core/UIComponent",
    "sap/ui/model/json/JSONModel",
    "sap/m/Button",
    "sabnez/intelligence/plugin/controller/Assistant.controller",
  ],
  function (UIComponent, JSONModel, Button, AssistantController) {
    "use strict";

    return UIComponent.extend("sabnez.intelligence.plugin.Component", {
      metadata: {
        manifest: "json",
      },

      init: function () {
        UIComponent.prototype.init.apply(this, arguments);

        this.setModel(
          new JSONModel({
            panelOpen: false,
            busy: false,
            draft: "",
            conversationId: null,

            logoUrl: sap.ui.require.toUrl(
              "sabnez/intelligence/plugin/assets/sabnez-logo.png",
            ),

            user: {
              id: null,
              fullName: null,
              firstName: null,
              email: null,
            },

            messages: [],
          }),
          "assistant",
        );

        this._assistantController = new AssistantController(this);

        this._initializeUser();
        this._createFloatingButton();
      },

      _initializeUser: async function () {
        var oUserData = await this._loadShellUser();
        var oModel = this.getModel("assistant");

        oModel.setProperty("/user", oUserData);

        var sName = oUserData.firstName || oUserData.fullName || "";

        var sGreeting = sName
          ? "Hola, <strong>" +
            this._escapeHtml(sName) +
            "</strong>. ¿Cómo estás? ¿En qué puedo ayudarte hoy?"
          : "Hola. ¿Cómo puedo ayudarte hoy con Sabnez Cloud ERP?";
      },

      _loadShellUser: async function () {
        try {
          if (
            sap.ushell &&
            sap.ushell.Container &&
            sap.ushell.Container.getServiceAsync
          ) {
            var oUserInfoService =
              await sap.ushell.Container.getServiceAsync("UserInfo");

            var oUser =
              oUserInfoService && oUserInfoService.getUser
                ? oUserInfoService.getUser()
                : null;

            if (oUser) {
              var sFullName =
                typeof oUser.getFullName === "function"
                  ? oUser.getFullName()
                  : null;

              var sFirstName =
                typeof oUser.getFirstName === "function"
                  ? oUser.getFirstName()
                  : null;

              var sEmail =
                typeof oUser.getEmail === "function" ? oUser.getEmail() : null;

              var sId =
                typeof oUser.getId === "function" ? oUser.getId() : null;

              return {
                id: sId || sEmail || null,
                fullName: sFullName || null,
                firstName:
                  sFirstName ||
                  this._firstNameFromFullName(sFullName) ||
                  this._firstNameFromEmail(sEmail),
                email: sEmail || null,
              };
            }
          }
        } catch (oError) {
          console.warn(
            "[Sabnez Intelligence] No fue posible obtener el usuario del shell.",
            oError,
          );
        }

        return {
          id: null,
          fullName: null,
          firstName: null,
          email: null,
        };
      },

      _createFloatingButton: function () {
        this._floatingButton = new Button({
          type: "Emphasized",
          tooltip: this.getModel("i18n")
            .getResourceBundle()
            .getText("openAssistant"),
          press: function () {
            this._assistantController.open();
          }.bind(this),
        }).addStyleClass("sabnezAssistantFloatingButton");

        this._floatingButton.placeAt(document.body);
      },

      _firstNameFromFullName: function (sFullName) {
        if (!sFullName) {
          return null;
        }

        return String(sFullName).trim().split(/\s+/)[0] || null;
      },

      _firstNameFromEmail: function (sEmail) {
        if (!sEmail || !String(sEmail).includes("@")) {
          return null;
        }

        var sLocalPart = String(sEmail).split("@")[0];
        var sFirstPart = sLocalPart.split(/[._-]/)[0];

        if (!sFirstPart) {
          return null;
        }

        return (
          sFirstPart.charAt(0).toUpperCase() + sFirstPart.slice(1).toLowerCase()
        );
      },

      _escapeHtml: function (sValue) {
        return String(sValue || "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");
      },

      destroy: function () {
        if (this._assistantController) {
          this._assistantController.destroy();
          this._assistantController = null;
        }

        if (this._floatingButton) {
          this._floatingButton.destroy();
          this._floatingButton = null;
        }

        UIComponent.prototype.destroy.apply(this, arguments);
      },
    });
  },
);
