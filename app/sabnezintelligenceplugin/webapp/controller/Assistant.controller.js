sap.ui.define(
  [
    "sap/ui/base/ManagedObject",
    "sap/ui/core/Fragment",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
  ],
  function (ManagedObject, Fragment, MessageToast, MessageBox) {
    "use strict";

    return ManagedObject.extend(
      "sabnez.intelligence.plugin.controller.Assistant",
      {
        constructor: function (oComponent) {
          ManagedObject.call(this);

          this._component = oComponent;
          this._panel = null;
          this._inputKeydownHandler = null;
          this._inputDelegate = null;
        },

        open: async function () {
          var oModel = this._component.getModel("assistant");

          if (!this._panel) {
            this._panel = await Fragment.load({
              id: this._component.getId(),
              name: "sabnez.intelligence.plugin.fragment.Assistant",
              controller: this,
            });

            this._panel.setModel(oModel, "assistant");
            this._panel.setModel(this._component.getModel("i18n"), "i18n");

            this._panel.placeAt(document.body);
            sap.ui.getCore().applyChanges();
            this._attachInputKeyboardHandler();
          }

          oModel.setProperty("/panelOpen", true);

          setTimeout(
            function () {
              var oInput = sap.ui
                .getCore()
                .byId(this._component.createId("messageInput"));

              if (oInput) {
                oInput.focus();
              }

              this._scrollToBottom();
            }.bind(this),
            0,
          );

          if (this._component._floatingButton) {
            this._component._floatingButton.addStyleClass(
              "sabnezAssistantFloatingButtonOpen",
            );
          }
        },

        onCloseAssistant: function () {
          this._component
            .getModel("assistant")
            .setProperty("/panelOpen", false);

          if (this._component._floatingButton) {
            this._component._floatingButton.removeStyleClass(
              "sabnezAssistantFloatingButtonOpen",
            );
          }
        },

        onSendMessage: async function () {
          var oModel = this._component.getModel("assistant");
          var sMessage = String(oModel.getProperty("/draft") || "").trim();

          if (!sMessage || oModel.getProperty("/busy")) {
            return;
          }

          this._appendMessage({
            role: "user",
            html: this._escapeHtml(sMessage),
          });

          oModel.setProperty("/draft", "");
          oModel.setProperty("/busy", true);

          try {
            var oResponse = await this._sendToBackend(sMessage);

            if (oResponse.conversationId) {
              oModel.setProperty("/conversationId", oResponse.conversationId);
            }

            this._appendMessage({
              role: "assistant",
              html: this._formatAssistantResponse(oResponse),
            });

            this._scrollToBottom();

            if (oResponse.responseType === "NAVIGATION") {
              await this._executeNavigation(oResponse);
            }
          } catch (oError) {
            console.error(
              "[Sabnez Intelligence] Error enviando mensaje.",
              oError,
            );

            this._appendMessage({
              role: "assistant",
              html:
                "No pude procesar tu solicitud en este momento. " +
                "Inténtalo nuevamente.",
            });

            MessageBox.error(
              oError.message ||
                "No fue posible comunicarse con Sabnez Intelligence.",
            );
          } finally {
            oModel.setProperty("/busy", false);

            setTimeout(
              function () {
                this._scrollToBottom();

                var oInput = sap.ui
                  .getCore()
                  .byId(this._component.createId("messageInput"));

                if (oInput) {
                  oInput.focus();
                }
              }.bind(this),
              0,
            );
          }
        },

        onQuickAction: function (oEvent) {
          var sPrompt = oEvent.getSource().data("prompt");

          if (!sPrompt) {
            return;
          }

          var oModel = this._component.getModel("assistant");

          oModel.setProperty("/draft", sPrompt);
          this.onSendMessage();
        },

        onToggleFullScreen: function () {
          if (!this._panel) {
            return;
          }

          this._panel.toggleStyleClass("sabnezAssistantPanelFullScreen");
        },

        _sendToBackend: async function (sMessage) {
          var oModel = this._component.getModel("assistant");

          var oPayload = {
            message: sMessage,
            conversationId: oModel.getProperty("/conversationId") || null,
            context: this._buildContext(),
          };

          var bLocal =
            window.location.hostname === "localhost" ||
            window.location.hostname === "127.0.0.1";

          var oHeaders = {
            "Content-Type": "application/json",
            Accept: "application/json",
          };

          if (bLocal) {
            oHeaders.Authorization =
              "Basic " + window.btoa("david.martinez@sabnez.com:homeoffice");
          }

          var oHttpResponse = await fetch("/intelligence/sendMessage", {
            method: "POST",
            credentials: "include",
            headers: oHeaders,
            body: JSON.stringify(oPayload),
          });

          var oBody;

          try {
            oBody = await oHttpResponse.json();
          } catch (oParseError) {
            throw new Error("El backend devolvió una respuesta inválida.");
          }

          if (!oHttpResponse.ok) {
            var oRequestError = new Error(
              oBody?.error?.message ||
                oBody?.message ||
                "La solicitud no pudo procesarse.",
            );

            oRequestError.status = oHttpResponse.status;
            oRequestError.code = oBody?.error?.code || oBody?.code || null;

            oRequestError.isBusinessError =
              oHttpResponse.status === 400 ||
              oHttpResponse.status === 403 ||
              oHttpResponse.status === 409;

            throw oRequestError;
          }

          var oStructuredPayload = {};

          if (oBody.payload) {
            try {
              oStructuredPayload = JSON.parse(oBody.payload);
            } catch (oError) {
              console.warn(
                "[Sabnez Intelligence] No fue posible interpretar payload.",
                oError,
              );
            }
          }

          return Object.assign({}, oStructuredPayload, {
            message: oStructuredPayload.message || oBody.message || "",
            conversationId:
              oStructuredPayload.conversationId || oBody.conversationId || null,
            responseType:
              oStructuredPayload.responseType ||
              oBody.responseType ||
              "UNKNOWN",
          });
        },

        _buildContext: function () {
          var oUser =
            this._component.getModel("assistant").getProperty("/user") || {};

          var oContext = {
            source: "workzone-shell-plugin",
            userDisplayName: oUser.firstName || oUser.fullName || null,
            appId: null,
            appName: null,
            semanticObject: null,
            action: null,
            route: window.location.hash || null,
            entity: null,
            recordId: null,
          };

          try {
            if (
              sap.ushell &&
              sap.ushell.Container &&
              sap.ushell.Container.getServiceAsync
            ) {
              var oHash = sap.ushell.Container.getService(
                "URLParsing",
              )?.parseShellHash(window.location.hash.replace(/^#/, ""));

              if (oHash) {
                oContext.semanticObject = oHash.semanticObject || null;
                oContext.action = oHash.action || null;
              }
            }
          } catch (oError) {
            console.warn(
              "[Sabnez Intelligence] No fue posible determinar el contexto de navegación.",
              oError,
            );
          }

          return oContext;
        },

        _executeNavigation: async function (oResponse) {
          var oNavigation = oResponse.navigation;

          if (
            !oNavigation ||
            !oNavigation.semanticObject ||
            !oNavigation.action
          ) {
            return;
          }

          try {
            var oCrossAppNavigation =
              await sap.ushell.Container.getServiceAsync(
                "CrossApplicationNavigation",
              );

            oCrossAppNavigation.toExternal({
              target: {
                semanticObject: oNavigation.semanticObject,
                action: oNavigation.action,
              },
            });
          } catch (oError) {
            console.error(
              "[Sabnez Intelligence] No fue posible navegar.",
              oError,
            );

            MessageToast.show("No fue posible abrir la aplicación solicitada.");
          }
        },

        _formatAssistantResponse: function (oResponse) {
          var sMessage = this._escapeHtml(oResponse.message || "").replace(
            /\n/g,
            "<br>",
          );

          if (
            oResponse.responseType === "TOOL_RESULT" &&
            oResponse.execution?.result
          ) {
            return this._formatToolResult(sMessage, oResponse.execution);
          }

          if (
            oResponse.responseType === "SKILL_DISCOVERY" &&
            oResponse.discovery
          ) {
            return this._formatDiscovery(sMessage, oResponse.discovery);
          }

          return sMessage;
        },

        _formatToolResult: function (sMessage, oExecution) {
          var oResult = oExecution.result || {};
          var aLines = [sMessage];

          if (
            oExecution.toolName === "searchEmployees" &&
            Array.isArray(oResult.employees)
          ) {
            aLines.push("<br><br>");

            oResult.employees.forEach(
              function (oEmployee) {
                aLines.push(
                  "<strong>" +
                    this._escapeHtml(oEmployee.fullName || "") +
                    "</strong>",
                );

                if (oEmployee.internalCode) {
                  aLines.push(" · " + this._escapeHtml(oEmployee.internalCode));
                }

                if (oEmployee.corporateEmail) {
                  aLines.push(
                    "<br>" + this._escapeHtml(oEmployee.corporateEmail),
                  );
                }

                aLines.push("<br><br>");
              }.bind(this),
            );
          }

          if (
            oExecution.toolName === "expiringContracts" &&
            Array.isArray(oResult.contracts)
          ) {
            aLines.push("<br><br>");

            oResult.contracts.forEach(
              function (oContract) {
                aLines.push(
                  "<strong>" +
                    this._escapeHtml(
                      oContract.employeeName ||
                        oContract.employeeCode ||
                        "Empleado",
                    ) +
                    "</strong>",
                );

                if (oContract.endDate) {
                  aLines.push(
                    "<br>Vence: " + this._escapeHtml(oContract.endDate),
                  );
                }

                aLines.push("<br><br>");
              }.bind(this),
            );
          }

          return aLines.join("");
        },

        _formatDiscovery: function (sMessage, oDiscovery) {
          var aLines = [sMessage];

          var aSkills =
            oDiscovery.skills || (oDiscovery.skill ? [oDiscovery.skill] : []);

          aSkills.forEach(
            function (oSkill) {
              aLines.push(
                "<br><br><strong>" +
                  this._escapeHtml(oSkill.name || "") +
                  "</strong>",
              );

              (oSkill.capabilities || []).forEach(
                function (oCapability) {
                  aLines.push(
                    "<br>• " + this._escapeHtml(oCapability.name || ""),
                  );
                }.bind(this),
              );
            }.bind(this),
          );

          return aLines.join("");
        },

        _appendMessage: function (oMessage) {
          var oModel = this._component.getModel("assistant");
          var aMessages = oModel.getProperty("/messages") || [];

          aMessages.push(oMessage);

          oModel.setProperty("/messages", aMessages.slice());

          setTimeout(this._scrollToBottom.bind(this), 0);
        },

        _scrollToBottom: function () {
          var oScrollContainer = sap.ui
            .getCore()
            .byId(this._component.createId("messagesScroll"));

          if (!oScrollContainer) {
            return;
          }

          var scroll = function () {
            var oDomRef = oScrollContainer.getDomRef();

            if (!oDomRef) {
              return;
            }

            oDomRef.scrollTop = oDomRef.scrollHeight;
          };

          requestAnimationFrame(function () {
            scroll();

            setTimeout(scroll, 50);
            setTimeout(scroll, 200);
          });
        },

        destroy: function () {
          var oInput = sap.ui
            .getCore()
            .byId(this._component.createId("messageInput"));

          if (oInput) {
            var oDomRef = oInput.getFocusDomRef();

            if (oDomRef && this._inputKeydownHandler) {
              oDomRef.removeEventListener("keydown", this._inputKeydownHandler);
            }

            if (this._inputDelegate) {
              oInput.removeEventDelegate(this._inputDelegate);
            }
          }

          this._inputKeydownHandler = null;
          this._inputDelegate = null;

          if (this._panel) {
            this._panel.destroy();
            this._panel = null;
          }

          this._component = null;

          ManagedObject.prototype.destroy.apply(this, arguments);
        },

        _escapeHtml: function (sValue) {
          return String(sValue || "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
        },

        _attachInputKeyboardHandler: function () {
          var oInput = sap.ui
            .getCore()
            .byId(this._component.createId("messageInput"));

          if (!oInput || this._inputDelegate) {
            return;
          }

          this._inputKeydownHandler = function (oEvent) {
            if (
              oEvent.key === "Enter" &&
              !oEvent.shiftKey &&
              !oEvent.isComposing
            ) {
              oEvent.preventDefault();
              oEvent.stopImmediatePropagation();

              var oModel = this._component.getModel("assistant");

              var sDraft = String(oModel.getProperty("/draft") || "").trim();

              if (sDraft && !oModel.getProperty("/busy")) {
                this.onSendMessage();
              }
            }
          }.bind(this);

          this._inputDelegate = {
            onAfterRendering: function () {
              this._bindInputDomEvent();
            }.bind(this),
          };

          oInput.addEventDelegate(this._inputDelegate);

          this._bindInputDomEvent();
        },

        _bindInputDomEvent: function () {
          var oInput = sap.ui
            .getCore()
            .byId(this._component.createId("messageInput"));

          if (!oInput || !this._inputKeydownHandler) {
            return;
          }

          var oDomRef = oInput.getFocusDomRef();

          if (!oDomRef) {
            return;
          }

          oDomRef.removeEventListener("keydown", this._inputKeydownHandler);

          oDomRef.addEventListener("keydown", this._inputKeydownHandler);
        },
      },
    );
  },
);
