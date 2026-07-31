sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/core/Fragment",
    "sap/ui/core/ValueState",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sabnez/com/ausenciasui/model/serviceContract",
  ],
  function (
    Controller,
    JSONModel,
    Fragment,
    ValueState,
    MessageBox,
    MessageToast,
    ServiceContract,
  ) {
    "use strict";

    var IN_PROGRESS_STATES = new Set(["BORRADOR", "SOLICITADA"]);
    var APPROVED_STATES = new Set(["APROBADA", "FINALIZADA"]);
    var REJECTED_STATES = new Set(["RECHAZADA"]);
    var ATTACHMENT_VALIDATION_ATTEMPTS = 20;
    var ATTACHMENT_VALIDATION_INTERVAL_MS = 1000;

    return Controller.extend("sabnez.com.ausenciasui.controller.Absences", {
      onInit: function () {
        this._requestDialog = null;
        this._detailDialog = null;

        this.getView().setModel(
          new JSONModel({
            busy: false,
            actionBusy: false,
            error: null,
            summary: this._emptySummary(),
            allRequests: [],
            filteredRequests: [],
            filteredCountLabel: "0 solicitudes",
            absenceTypes: [],
            typeFilters: [{ key: "TODOS", text: this._text("allTypes") }],
            selectedStateFilter: "TODAS",
            selectedTypeFilter: "TODOS",
            searchQuery: "",
            selectedRequest: null,
            selectedRequestAttachments: [],
          }),
          "view",
        );

        this._loadAll();
      },

      onExit: function () {
        if (this._requestDialog) {
          this._requestDialog.destroy();
          this._requestDialog = null;
        }
        if (this._detailDialog) {
          this._detailDialog.destroy();
          this._detailDialog = null;
        }
      },

      onRefresh: function () {
        this._loadAll(true);
      },

      onSearch: function (oEvent) {
        this.getView()
          .getModel("view")
          .setProperty("/searchQuery", oEvent.getParameter("newValue") || "");
        this._applyFilters();
      },

      onStateFilterChange: function (oEvent) {
        var sKey = oEvent.getParameter("item")?.getKey() || "TODAS";
        this.getView()
          .getModel("view")
          .setProperty("/selectedStateFilter", sKey);
        this._applyFilters();
      },

      onTypeFilterChange: function (oEvent) {
        var sKey = oEvent.getSource().getSelectedKey() || "TODOS";
        this.getView()
          .getModel("view")
          .setProperty("/selectedTypeFilter", sKey);
        this._applyFilters();
      },

      onOpenCreate: async function () {
        await this._openRequestForm(null);
      },

      onOpenDetail: async function (oEvent) {
        var oRequest = this._requestFromEvent(oEvent);
        if (!oRequest) {
          return;
        }

        this.getView()
          .getModel("view")
          .setProperty("/selectedRequest", oRequest);
        try {
          this.getView()
            .getModel("view")
            .setProperty(
              "/selectedRequestAttachments",
              await this._loadAttachments(oRequest.ID),
            );
        } catch (oError) {
          this.getView()
            .getModel("view")
            .setProperty("/selectedRequestAttachments", []);
        }

        if (!this._detailDialog) {
          this._detailDialog = await Fragment.load({
            id: this.getView().getId(),
            name: "sabnez.com.ausenciasui.fragment.RequestDetail",
            controller: this,
          });
          this.getView().addDependent(this._detailDialog);
        }

        this._detailDialog.open();
      },

      onCloseDetail: function () {
        this._detailDialog?.close();
      },

      onDetailDialogAfterClose: function () {
        var oViewModel = this.getView().getModel("view");
        oViewModel.setProperty("/selectedRequest", null);
        oViewModel.setProperty("/selectedRequestAttachments", []);
      },

      onEditSelectedRequest: async function () {
        var oRequest = this.getView()
          .getModel("view")
          .getProperty("/selectedRequest");
        if (this._detailDialog?.isOpen()) {
          await new Promise(
            function (resolve) {
              this._detailDialog.attachEventOnce("afterClose", resolve);
              this._detailDialog.close();
            }.bind(this),
          );
        }
        await this._openRequestForm(oRequest);
      },

      onSubmitSelectedRequest: async function () {
        var oRequest = this.getView()
          .getModel("view")
          .getProperty("/selectedRequest");
        if (!oRequest || !(await this._confirm("confirmSubmit", "submit"))) {
          return;
        }
        await this._runSelectedAction(
          ServiceContract.actions.submit,
          oRequest.ID,
          "requestSubmitted",
        );
      },

      onCancelSelectedRequest: async function () {
        var oRequest = this.getView()
          .getModel("view")
          .getProperty("/selectedRequest");
        if (
          !oRequest ||
          !(await this._confirm("confirmCancel", "cancelRequest"))
        ) {
          return;
        }
        await this._runSelectedAction(
          ServiceContract.actions.cancel,
          oRequest.ID,
          "requestCancelled",
        );
      },

      onDeleteSelectedDraft: async function () {
        var oRequest = this.getView()
          .getModel("view")
          .getProperty("/selectedRequest");
        if (
          !oRequest ||
          !(await this._confirm("confirmDelete", "deleteDraft"))
        ) {
          return;
        }
        await this._runSelectedAction(
          ServiceContract.actions.deleteDraft,
          oRequest.ID,
          "draftDeleted",
        );
      },

      onAbsenceTypeChange: function (oEvent) {
        var sCode = oEvent.getSource().getSelectedKey();
        this._applySelectedTypeToForm(sCode);
      },

      onStartDateChange: function () {
        var oFormModel = this.getView().getModel("form");
        if (oFormModel?.getProperty("/isHours")) {
          oFormModel.setProperty(
            "/fechaFin",
            oFormModel.getProperty("/fechaInicio"),
          );
        }
      },

      onCloseRequestDialog: function () {
        this._requestDialog?.close();
      },

      onRequestDialogAfterClose: function () {
        this.getView().setModel(null, "form");
      },

      onSaveDraft: async function () {
        if (!this._validateForm(false)) {
          MessageBox.warning(
            this._validationMessage || this._text("requiredFields"),
          );
          return;
        }
        await this._saveForm(false);
      },

      onSaveAndSubmit: async function () {
        if (!this._validateForm(true)) {
          MessageBox.warning(
            this._validationMessage || this._text("requiredFields"),
          );
          return;
        }

        if (!(await this._confirm("confirmSubmit", "submit"))) {
          return;
        }

        await this._saveForm(true);
      },

      onFilesSelected: function (oEvent) {
        var aFiles = Array.from(oEvent.getParameter("files") || []);
        var oFormModel = this.getView().getModel("form");

        var aPending = (
          oFormModel.getProperty("/pendingAttachments") || []
        ).slice();

        var aExisting = oFormModel.getProperty("/existingAttachments") || [];

        var iAvailable =
          ServiceContract.attachments.maximumFiles -
          aPending.length -
          aExisting.length;

        var sError = "";
        var iAdded = 0;

        aFiles.slice(0, Math.max(iAvailable, 0)).forEach(
          function (oFile, iIndex) {
            var sExtension = (oFile.name.split(".").pop() || "").toLowerCase();

            var bAllowedType =
              ServiceContract.attachments.allowedExtensions.includes(
                sExtension,
              ) &&
              (!oFile.type ||
                ServiceContract.attachments.allowedMimeTypes.includes(
                  oFile.type,
                ));

            var bDuplicate = aPending
              .concat(aExisting)
              .some(function (oAttachment) {
                return (
                  String(oAttachment.filename || "").toLowerCase() ===
                  String(oFile.name || "").toLowerCase()
                );
              });

            if (!bAllowedType) {
              sError = this._text("fileTypeInvalid");
              return;
            }

            if (oFile.size > ServiceContract.attachments.maximumFileSizeBytes) {
              sError = this._text("fileTooLarge");
              return;
            }

            if (bDuplicate) {
              sError = this._text("duplicateFile");
              return;
            }

            aPending.push({
              localId:
                Date.now().toString(36) +
                "-" +
                iIndex +
                "-" +
                Math.random().toString(36).slice(2),

              filename: oFile.name,
              mimeType: oFile.type || this._mimeTypeFromExtension(sExtension),

              size: oFile.size,
              sizeText: this._formatFileSize(oFile.size),
              icon: this._attachmentIcon(oFile.type, sExtension),
              file: oFile,
            });

            iAdded += 1;
          }.bind(this),
        );

        if (aFiles.length > iAvailable) {
          sError = this._text("fileLimit");
        }

        oFormModel.setProperty("/pendingAttachments", aPending);

        oFormModel.setProperty("/hasPendingAttachments", aPending.length > 0);

        oFormModel.setProperty("/attachmentError", sError);

        oFormModel.refresh(true);

        if (iAdded === 1) {
          MessageToast.show(
            "Archivo seleccionado. Se cargará al guardar la solicitud.",
          );
        } else if (iAdded > 1) {
          MessageToast.show(
            iAdded +
              " archivos seleccionados. Se cargarán al guardar la solicitud.",
          );
        }

        oEvent.getSource().clear();
      },

      onFileSizeExceed: function () {
        this.getView()
          .getModel("form")
          .setProperty("/attachmentError", this._text("fileTooLarge"));
      },

      onFileTypeMismatch: function () {
        this.getView()
          .getModel("form")
          .setProperty("/attachmentError", this._text("fileTypeInvalid"));
      },

      onRemovePendingAttachment: function (oEvent) {
        var oContext = oEvent.getSource().getBindingContext("form");

        var iIndex = Number(oContext.getPath().split("/").pop());

        var oFormModel = this.getView().getModel("form");

        var aPending = (
          oFormModel.getProperty("/pendingAttachments") || []
        ).slice();

        aPending.splice(iIndex, 1);

        oFormModel.setProperty("/pendingAttachments", aPending);

        oFormModel.setProperty("/hasPendingAttachments", aPending.length > 0);

        oFormModel.setProperty("/attachmentError", "");

        oFormModel.refresh(true);
      },

      onDownloadAttachment: async function (oEvent) {
        var oAttachment = oEvent
          .getSource()
          .getBindingContext("view")
          ?.getObject();

        if (!oAttachment) {
          return;
        }

        try {
          var oResult = await this._invokeAction("descargarSoporte", {
            solicitudID: this.getView()
              .getModel("view")
              .getProperty("/selectedRequest/ID"),

            soporteID: oAttachment.ID,
          });

          var oFile = this._unwrapObject(oResult);

          if (!oFile.contenidoBase64) {
            throw new Error(
              "El servicio no devolvió el contenido del archivo.",
            );
          }

          var aBytes = this._base64ToBytes(oFile.contenidoBase64);

          var oBlob = new Blob([aBytes], {
            type: oFile.mimeType || "application/octet-stream",
          });

          var sObjectUrl = URL.createObjectURL(oBlob);
          var oLink = document.createElement("a");

          oLink.href = sObjectUrl;
          oLink.download = oFile.filename || "soporte";
          document.body.appendChild(oLink);
          oLink.click();
          document.body.removeChild(oLink);

          window.setTimeout(function () {
            URL.revokeObjectURL(sObjectUrl);
          }, 1000);
        } catch (oError) {
          MessageBox.error(this._extractErrorMessage(oError));
        }
      },

      onDeleteExistingAttachment: async function (oEvent) {
        var oAttachment = oEvent
          .getSource()
          .getBindingContext("form")
          .getObject();
        if (!(await this._confirm("confirmRemoveSupport", "removeFile"))) {
          return;
        }

        var oFormModel = this.getView().getModel("form");
        oFormModel.setProperty("/busy", true);
        try {
          await this._deleteAttachment(
            oAttachment.ID,
            oFormModel.getProperty("/ID"),
          );
          var aExisting = (
            oFormModel.getProperty("/existingAttachments") || []
          ).filter(function (oItem) {
            return oItem.ID !== oAttachment.ID;
          });
          oFormModel.setProperty("/existingAttachments", aExisting);
          this._updateExistingAttachmentLabel();
          MessageToast.show(this._text("supportRemoved"));
        } catch (oError) {
          MessageBox.error(this._extractErrorMessage(oError));
        } finally {
          oFormModel.setProperty("/busy", false);
        }
      },

      _loadAll: async function (bShowToast) {
        var oViewModel = this.getView().getModel("view");
        oViewModel.setProperty("/busy", true);
        oViewModel.setProperty("/error", null);

        var aResults = await Promise.allSettled([
          this._loadSummary(),
          this._loadRequests(),
          this._loadAbsenceTypes(),
        ]);
        var aErrors = aResults
          .filter(function (oResult) {
            return oResult.status === "rejected";
          })
          .map(
            function (oResult) {
              return this._extractErrorMessage(oResult.reason);
            }.bind(this),
          );

        if (aErrors.length > 0) {
          oViewModel.setProperty("/error", aErrors.join(" "));
        } else if (bShowToast) {
          MessageToast.show(this._text("dataUpdated"));
        }

        oViewModel.setProperty("/busy", false);
      },

      _loadSummary: async function () {
        var oRaw = await this._invokeAction(ServiceContract.actions.getSummary);
        var oSummary = this._unwrapObject(oRaw);
        this.getView()
          .getModel("view")
          .setProperty("/summary", this._prepareSummary(oSummary));
      },

      _loadRequests: async function () {
        var oRaw = await this._invokeAction(
          ServiceContract.actions.getRequests,
        );
        var aRequests = this._unwrapArray(oRaw)
          .map(this._prepareRequest.bind(this))
          .sort(function (a, b) {
            return (
              new Date(b.modifiedAt || b.createdAt || 0).getTime() -
              new Date(a.modifiedAt || a.createdAt || 0).getTime()
            );
          });
        this.getView().getModel("view").setProperty("/allRequests", aRequests);
        this._applyFilters();
      },

      _loadAbsenceTypes: async function () {
        var oODataModel = this.getOwnerComponent().getModel();
        var oBinding = oODataModel.bindList(
          "/" + ServiceContract.entities.absenceTypes,
          null,
          null,
          null,
          {
            $select:
              "codigo,descripcion,unidadConsumo,requiereSoporte,remunerada,descuentaSaldo,controlaSaldoHoras,horasAnuales,diasAnticipacion,tipoDiasAnticipacion,minimoHorasSolicitud,maximoHorasDia,maximoHorasSemana,maximoSolicitudesSemana,requiereMismoDia,permiteCruzarAnio,politicaFecha",
          },
        );
        var aContexts = await oBinding.requestContexts(0, 200);
        var aTypes = aContexts
          .map(function (oContext) {
            return oContext.getObject();
          })
          .sort(function (a, b) {
            return a.descripcion.localeCompare(b.descripcion, "es");
          });
        var aFilters = [{ key: "TODOS", text: this._text("allTypes") }].concat(
          aTypes.map(function (oType) {
            return { key: oType.codigo, text: oType.descripcion };
          }),
        );
        var oViewModel = this.getView().getModel("view");
        oViewModel.setProperty("/absenceTypes", aTypes);
        oViewModel.setProperty("/typeFilters", aFilters);
      },

      _openRequestForm: async function (oRequest) {
        var oFormData = {
          busy: false,
          dialogTitle: this._text(
            oRequest ? "editRequestDialogTitle" : "requestDialogTitle",
          ),
          ID: oRequest?.ID || null,
          tipoAusenciaCodigo: oRequest?.tipoAusenciaCodigo || "",
          unidadConsumo: oRequest?.unidadConsumo || "DIAS",
          isHours: oRequest?.unidadConsumo === "HORAS",
          fechaInicio: oRequest?.fechaInicio || "",
          fechaFin: oRequest?.fechaFin || "",
          horaInicio: oRequest?.horaInicio || "",
          horaFin: oRequest?.horaFin || "",
          motivo: oRequest?.motivo || "",
          requiereSoporte: Boolean(oRequest?.requiereSoporte),
          supportRequirementText: "",
          ruleText: "",
          pendingAttachments: [],
          existingAttachments: [],
          existingAttachmentLabel: "",
          attachmentError: "",
          hasPendingAttachments: false,
        };
        var oFormModel = new JSONModel(oFormData);
        oFormModel.setSizeLimit(ServiceContract.attachments.maximumFiles);
        this.getView().setModel(oFormModel, "form");
        this._applySelectedTypeToForm(oFormData.tipoAusenciaCodigo);

        if (oRequest?.ID) {
          oFormModel.setProperty("/busy", true);
          try {
            oFormModel.setProperty(
              "/existingAttachments",
              await this._loadAttachments(oRequest.ID),
            );
            this._updateExistingAttachmentLabel();
          } catch (oError) {
            oFormModel.setProperty(
              "/attachmentError",
              this._extractErrorMessage(oError),
            );
          } finally {
            oFormModel.setProperty("/busy", false);
          }
        }

        if (!this._requestDialog) {
          this._requestDialog = await Fragment.load({
            id: this.getView().getId(),
            name: "sabnez.com.ausenciasui.fragment.RequestDialog",
            controller: this,
          });
          this.getView().addDependent(this._requestDialog);
        }
        this._resetRequestDialogControls();
        this._requestDialog.open();
      },

      _applySelectedTypeToForm: function (sCode) {
        var oFormModel = this.getView().getModel("form");
        if (!oFormModel) {
          return;
        }
        var aTypes =
          this.getView().getModel("view").getProperty("/absenceTypes") || [];
        var oType = aTypes.find(function (oItem) {
          return oItem.codigo === sCode;
        });
        var bIsHours = oType?.unidadConsumo === "HORAS";
        var bRequiresSupport = Boolean(oType?.requiereSoporte);

        oFormModel.setProperty("/tipoAusenciaCodigo", sCode || "");
        oFormModel.setProperty("/unidadConsumo", bIsHours ? "HORAS" : "DIAS");
        oFormModel.setProperty("/isHours", bIsHours);
        oFormModel.setProperty("/requiereSoporte", bRequiresSupport);
        oFormModel.setProperty(
          "/supportRequirementText",
          this._text(bRequiresSupport ? "supportRequired" : "supportOptional"),
        );
        oFormModel.setProperty(
          "/ruleText",
          oType ? this._buildRuleText(oType) : "",
        );

        if (bIsHours) {
          oFormModel.setProperty(
            "/fechaFin",
            oFormModel.getProperty("/fechaInicio"),
          );
        } else {
          oFormModel.setProperty("/horaInicio", "");
          oFormModel.setProperty("/horaFin", "");
        }
      },

      _buildRuleText: function (oType) {
        var aRules = [
          oType.unidadConsumo === "HORAS"
            ? this._text("ruleHours")
            : this._text("ruleDays"),
        ];
        if (oType.politicaFecha === "SEMANA_CUMPLEANOS") {
          aRules.push(this._text("ruleBirthdayWeek"));
        }
        var iAdvance = Number(oType.diasAnticipacion || 0);
        if (iAdvance > 0) {
          aRules.push(
            this._text("ruleAdvance", [
              iAdvance,
              oType.tipoDiasAnticipacion === "HABILES"
                ? "hábiles"
                : "calendario",
            ]),
          );
        }
        var nMinimumHours = Number(oType.minimoHorasSolicitud || 0);
        var nMaximumHours = Number(oType.maximoHorasDia || 0);
        if (nMinimumHours > 0 && nMinimumHours === nMaximumHours) {
          aRules.push(
            this._text("ruleExactHours", [this._number(nMinimumHours)]),
          );
        } else {
          if (nMinimumHours > 0) {
            aRules.push(
              this._text("ruleMinimumHours", [this._number(nMinimumHours)]),
            );
          }
          if (nMaximumHours > 0) {
            aRules.push(
              this._text("ruleDailyHours", [this._number(nMaximumHours)]),
            );
          }
        }
        if (Number(oType.maximoHorasSemana || 0) > 0) {
          aRules.push(
            this._text("ruleWeeklyHours", [
              this._number(oType.maximoHorasSemana),
            ]),
          );
        }
        if (Number(oType.maximoSolicitudesSemana || 0) > 0) {
          aRules.push(
            this._text("ruleWeeklyRequests", [
              this._number(oType.maximoSolicitudesSemana),
            ]),
          );
        }
        return aRules.join(" ");
      },

      _saveForm: async function (bSubmit) {
        var oFormModel = this.getView().getModel("form");
        oFormModel.setProperty("/busy", true);
        oFormModel.setProperty("/attachmentError", "");

        try {
          var oSaveResult = await this._invokeAction(
            ServiceContract.actions.saveDraft,
            this._saveParameters(oFormModel.getData()),
          );
          var oNormalized = this._unwrapObject(oSaveResult);
          var oSavedRequest = oNormalized.solicitud || oNormalized;
          var sRequestId = oSavedRequest.ID || oFormModel.getProperty("/ID");
          if (!sRequestId) {
            throw new Error(this._text("missingRequestId"));
          }
          oFormModel.setProperty("/ID", sRequestId);

          await this._uploadPendingAttachments(sRequestId);

          if (bSubmit) {
            await this._waitForAttachmentValidation(sRequestId);
            var oSubmitResult = await this._invokeAction(
              ServiceContract.actions.submit,
              { ID: sRequestId },
            );
            MessageToast.show(
              this._resultMessage(oSubmitResult, "requestSubmitted"),
            );
          } else {
            MessageToast.show(this._resultMessage(oSaveResult, "draftSaved"));
          }

          this._requestDialog?.close();
          await this._loadAll();
        } catch (oError) {
          MessageBox.error(this._extractErrorMessage(oError));
        } finally {
          oFormModel.setProperty("/busy", false);
        }
      },

      _validateForm: function (bRequireSupport) {
        var oFormModel = this.getView().getModel("form");
        var oData = oFormModel.getData();
        var bTypeValid = Boolean(oData.tipoAusenciaCodigo);
        var bStartValid = Boolean(oData.fechaInicio);
        var bEndValid = oData.isHours || Boolean(oData.fechaFin);
        var bStartTimeValid = !oData.isHours || Boolean(oData.horaInicio);
        var bEndTimeValid = !oData.isHours || Boolean(oData.horaFin);
        var bDateOrderValid =
          oData.isHours ||
          !oData.fechaInicio ||
          !oData.fechaFin ||
          oData.fechaFin >= oData.fechaInicio;
        var bTimeOrderValid =
          !oData.isHours ||
          !oData.horaInicio ||
          !oData.horaFin ||
          oData.horaFin > oData.horaInicio;
        var bSupportValid =
          !bRequireSupport ||
          !oData.requiereSoporte ||
          oData.pendingAttachments.length + oData.existingAttachments.length >
            0;
        var bSupportStatusesValid = oData.existingAttachments.every(
          function (oAttachment) {
            return (
              oAttachment.status !== "Infected" &&
              oAttachment.status !== "Failed"
            );
          },
        );

        this._setValueState("absenceTypeSelect", bTypeValid);
        this._setValueState("startDatePicker", bStartValid);
        this._setValueState("endDatePicker", bEndValid && bDateOrderValid);
        this._setValueState("startTimePicker", bStartTimeValid);
        this._setValueState("endTimePicker", bEndTimeValid && bTimeOrderValid);

        this._validationMessage = this._text("requiredFields");
        if (!bDateOrderValid) {
          this._validationMessage = this._text("invalidDateRange");
        } else if (!bTimeOrderValid) {
          this._validationMessage = this._text("invalidTimeRange");
        } else if (!bSupportValid) {
          oFormModel.setProperty(
            "/attachmentError",
            this._text("supportRequired"),
          );
          this._validationMessage = this._text("supportRequired");
        } else if (!bSupportStatusesValid) {
          oFormModel.setProperty(
            "/attachmentError",
            this._text("supportNotValidated"),
          );
          this._validationMessage = this._text("supportNotValidated");
        }

        return (
          bTypeValid &&
          bStartValid &&
          bEndValid &&
          bStartTimeValid &&
          bEndTimeValid &&
          bDateOrderValid &&
          bTimeOrderValid &&
          bSupportValid &&
          bSupportStatusesValid
        );
      },

      _waitForAttachmentValidation: async function (sRequestId) {
        var oFormModel = this.getView().getModel("form");

        for (
          var iAttempt = 0;
          iAttempt < ATTACHMENT_VALIDATION_ATTEMPTS;
          iAttempt += 1
        ) {
          var aAttachments = await this._loadAttachments(sRequestId);
          oFormModel.setProperty("/existingAttachments", aAttachments);
          this._updateExistingAttachmentLabel();

          if (
            aAttachments.some(function (oAttachment) {
              return (
                oAttachment.status === "Infected" ||
                oAttachment.status === "Failed"
              );
            })
          ) {
            oFormModel.setProperty(
              "/attachmentError",
              this._text("supportNotValidated"),
            );
            throw new Error(this._text("supportNotValidated"));
          }

          if (
            aAttachments.every(function (oAttachment) {
              return oAttachment.status === "Clean";
            })
          ) {
            return;
          }

          if (iAttempt < ATTACHMENT_VALIDATION_ATTEMPTS - 1) {
            await this._delay(ATTACHMENT_VALIDATION_INTERVAL_MS);
          }
        }

        oFormModel.setProperty(
          "/attachmentError",
          this._text("supportValidationPendingRetry"),
        );
        throw new Error(this._text("supportValidationPendingRetry"));
      },

      _delay: function (iMilliseconds) {
        return new Promise(function (resolve) {
          window.setTimeout(resolve, iMilliseconds);
        });
      },

      _saveParameters: function (oData) {
        return {
          ID: oData.ID || null,
          tipoAusenciaCodigo: oData.tipoAusenciaCodigo || null,
          fechaInicio: oData.fechaInicio || null,
          fechaFin:
            (oData.isHours ? oData.fechaInicio : oData.fechaFin) || null,
          horaInicio: oData.isHours ? oData.horaInicio || null : null,
          horaFin: oData.isHours ? oData.horaFin || null : null,
          motivo: (oData.motivo || "").trim() || null,
        };
      },

      _runSelectedAction: async function (sAction, sId, sSuccessKey) {
        var oViewModel = this.getView().getModel("view");
        oViewModel.setProperty("/actionBusy", true);
        try {
          var oResult = await this._invokeAction(sAction, { ID: sId });
          MessageToast.show(this._resultMessage(oResult, sSuccessKey));
          this._detailDialog?.close();
          await this._loadAll();
        } catch (oError) {
          MessageBox.error(this._extractErrorMessage(oError));
        } finally {
          oViewModel.setProperty("/actionBusy", false);
        }
      },

      _invokeAction: async function (sActionName, mParameters = {}) {
        var oODataModel = this.getOwnerComponent().getModel();
        var oBinding = oODataModel.bindContext("/" + sActionName + "(...)");
        Object.entries(mParameters || {}).forEach(function (aEntry) {
          oBinding.setParameter(aEntry[0], aEntry[1]);
        });
        await oBinding.execute("$direct");
        return oBinding.getBoundContext()?.getObject() || {};
      },

      _applyFilters: function () {
        var oViewModel = this.getView().getModel("view");
        var sQuery = (oViewModel.getProperty("/searchQuery") || "")
          .trim()
          .toLocaleLowerCase("es");
        var sStateFilter = oViewModel.getProperty("/selectedStateFilter");
        var sTypeFilter = oViewModel.getProperty("/selectedTypeFilter");
        var aFiltered = (oViewModel.getProperty("/allRequests") || []).filter(
          function (oRequest) {
            var bStateMatch =
              sStateFilter === "TODAS" ||
              (sStateFilter === "EN_CURSO" &&
                IN_PROGRESS_STATES.has(oRequest.estado)) ||
              (sStateFilter === "APROBADAS" &&
                APPROVED_STATES.has(oRequest.estado)) ||
              (sStateFilter === "RECHAZADAS" &&
                REJECTED_STATES.has(oRequest.estado));
            var bTypeMatch =
              sTypeFilter === "TODOS" ||
              oRequest.tipoAusenciaCodigo === sTypeFilter;
            var sHaystack = [
              oRequest.tipoAusenciaDescripcion,
              oRequest.tipoAusenciaCodigo,
              oRequest.estadoDescripcion,
              oRequest.motivo,
              oRequest.fechaInicio,
              oRequest.fechaFin,
            ]
              .filter(Boolean)
              .join(" ")
              .toLocaleLowerCase("es");
            return (
              bStateMatch &&
              bTypeMatch &&
              (!sQuery || sHaystack.includes(sQuery))
            );
          },
        );
        oViewModel.setProperty("/filteredRequests", aFiltered);
        oViewModel.setProperty(
          "/filteredCountLabel",
          this._text("requestCount", [aFiltered.length]),
        );
      },

      _prepareSummary: function (oSummary) {
        var oPrepared = Object.assign(this._emptySummary(), oSummary || {});
        [
          "solicitudesEnCurso",
          "solicitudesAprobadas",
          "solicitudesRechazadas",
          "diasVacacionesCausados",
          "diasVacacionesReservados",
          "diasVacacionesDisponibles",
          "horasValeraAsignadas",
          "horasValeraUtilizadas",
          "horasValeraReservadas",
          "horasValeraDisponibles",
          "horasCumpleaniosAsignadas",
          "horasCumpleaniosUtilizadas",
          "horasCumpleaniosReservadas",
          "horasCumpleaniosDisponibles",
        ].forEach(
          function (sProperty) {
            oPrepared[sProperty] = this._number(oPrepared[sProperty]);
          }.bind(this),
        );
        oPrepared.vacationDetail = this._text("vacationDetail", [
          oPrepared.diasVacacionesCausados,
          oPrepared.diasVacacionesReservados,
        ]);
        oPrepared.valeraDetail = this._text("valeraDetail", [
          oPrepared.horasValeraAsignadas,
          oPrepared.horasValeraUtilizadas,
          oPrepared.horasValeraReservadas,
        ]);
        oPrepared.birthdayDetail = this._text("birthdayDetail", [
          oPrepared.horasCumpleaniosAsignadas,
          oPrepared.horasCumpleaniosUtilizadas,
          oPrepared.horasCumpleaniosReservadas,
        ]);
        if (
          oPrepared.semanaCumpleaniosInicio &&
          oPrepared.semanaCumpleaniosFin
        ) {
          oPrepared.birthdayWeekLabel = oPrepared.proximoCumpleanios
            ? this._text("birthdayDateAndWeek", [
                this._formatDate(oPrepared.proximoCumpleanios),
                this._formatDate(oPrepared.semanaCumpleaniosInicio),
                this._formatDate(oPrepared.semanaCumpleaniosFin),
              ])
            : this._text("birthdayWeek", [
                this._formatDate(oPrepared.semanaCumpleaniosInicio),
                this._formatDate(oPrepared.semanaCumpleaniosFin),
              ]);
        } else {
          oPrepared.birthdayWeekLabel = oPrepared.proximoCumpleanios
            ? this._text("birthdayDate", [
                this._formatDate(oPrepared.proximoCumpleanios),
              ])
            : "";
        }
        return oPrepared;
      },

      _prepareRequest: function (oRequest) {
        var sState = String(oRequest.estado || "BORRADOR").toUpperCase();
        var bHours = oRequest.unidadConsumo === "HORAS";
        var iSupportCount = Number(oRequest.cantidadSoportes || 0);
        var sDecisionBy = oRequest.decididaPorNombre || "";
        if (sDecisionBy && oRequest.decisionActuandoPorNombre) {
          sDecisionBy = this._text("decisionActingFor", [
            sDecisionBy,
            oRequest.decisionActuandoPorNombre,
          ]);
        }
        return Object.assign({}, oRequest, {
          estado: sState,
          estadoDescripcion:
            oRequest.estadoDescripcion || this._stateText(sState),
          statusState: this._stateValue(sState),
          statusIcon: this._stateIcon(sState),
          periodText: this._periodText(oRequest),
          quantityNumber: this._number(
            bHours ? oRequest.horasSolicitadas : oRequest.diasHabiles,
          ),
          quantityUnit: this._text(bHours ? "hoursUnit" : "daysUnit"),
          cantidadSoportes: iSupportCount,
          supportCountLabel: this._text(
            iSupportCount === 1 ? "oneSupport" : "manySupports",
            [iSupportCount],
          ),
          motivoDisplay: oRequest.motivo || "—",
          hasDecision: Boolean(oRequest.decisionResultado),
          decisionCommentDisplay: oRequest.decisionComentario || "—",
          decisionByDisplay: sDecisionBy || "—",
          decisionDateText: this._formatDateTime(oRequest.fechaDecision),
          createdText: this._formatDateTime(oRequest.createdAt),
          modifiedText: this._formatDateTime(oRequest.modifiedAt),
          puedeEditar:
            typeof oRequest.puedeEditar === "boolean"
              ? oRequest.puedeEditar
              : sState === "BORRADOR",
          puedeEnviar:
            typeof oRequest.puedeEnviar === "boolean"
              ? oRequest.puedeEnviar
              : sState === "BORRADOR",
          puedeCancelar:
            typeof oRequest.puedeCancelar === "boolean"
              ? oRequest.puedeCancelar
              : sState === "SOLICITADA",
          puedeEliminar:
            typeof oRequest.puedeEliminar === "boolean"
              ? oRequest.puedeEliminar
              : sState === "BORRADOR",
        });
      },

      _periodText: function (oRequest) {
        var sStart = this._formatDate(oRequest.fechaInicio);
        if (oRequest.unidadConsumo === "HORAS") {
          return (
            sStart +
            " · " +
            this._shortTime(oRequest.horaInicio) +
            "–" +
            this._shortTime(oRequest.horaFin)
          );
        }
        if (!oRequest.fechaFin || oRequest.fechaInicio === oRequest.fechaFin) {
          return sStart;
        }
        return sStart + " – " + this._formatDate(oRequest.fechaFin);
      },

      _loadAttachments: async function (sRequestId) {
        var oConfig = ServiceContract.attachments;
        var oODataModel = this.getOwnerComponent().getModel();

        var sCollectionPath = "/" + this._attachmentCollectionPath(sRequestId);

        var oBinding = oODataModel.bindList(sCollectionPath, null, null, null, {
          $select: "ID,filename,mimeType,status",
          $$groupId: "$direct",
        });

        var aContexts = await oBinding.requestContexts(
          0,
          ServiceContract.attachments.maximumFiles,
        );

        return aContexts.map(
          function (oContext) {
            var oAttachment = oContext.getObject();

            return Object.assign({}, oAttachment, {
              icon: this._attachmentIcon(
                oAttachment.mimeType,
                (oAttachment.filename || "").split(".").pop(),
              ),
              statusText: this._attachmentStatusText(oAttachment.status),
              statusState: this._attachmentStatusState(oAttachment.status),
            });
          }.bind(this),
        );
      },

      _uploadPendingAttachments: async function (sRequestId) {
        var oFormModel = this.getView().getModel("form");
        var aPending = (
          oFormModel.getProperty("/pendingAttachments") || []
        ).slice();
        var oConfig = ServiceContract.attachments;

        for (var i = 0; i < aPending.length; i += 1) {
          var oPending = aPending[i];
          var oMetadata = {};

          oMetadata[oConfig.parentForeignKey] = sRequestId;
          oMetadata.filename = oPending.filename;
          oMetadata.mimeType = oPending.mimeType;

          var oODataModel = this.getOwnerComponent().getModel();

          var sAttachmentCollectionPath =
            "/" + this._attachmentCollectionPath(sRequestId);

          var oAttachmentBinding = oODataModel.bindList(
            sAttachmentCollectionPath,
            null,
            null,
            null,
            {
              $$updateGroupId: "$direct",
            },
          );

          var oCreatedContext = oAttachmentBinding.create(oMetadata);

          await oCreatedContext.created();

          var oCreated = oCreatedContext.getObject();

          var sAttachmentId =
            oCreated.ID || this._idFromODataId(oCreated["@odata.id"]);

          if (!sAttachmentId) {
            throw new Error(this._text("missingAttachmentId"));
          }

          try {
            var sBase64Content = await this._fileToBase64(oPending.file);

            await this._invokeAction("cargarSoporte", {
              solicitudID: sRequestId,
              soporteID: sAttachmentId,
              contenido: sBase64Content,
              mimeType: oPending.mimeType,
            });

            oFormModel.setProperty(
              "/existingAttachments",
              await this._loadAttachments(sRequestId),
            );
            this._updateExistingAttachmentLabel();
          } catch (oError) {
            try {
              await this._deleteAttachment(sAttachmentId, sRequestId);
            } catch (oCleanupError) {
              console.warn(
                "No fue posible retirar el soporte incompleto.",
                oCleanupError,
              );
            }
            throw oError;
          }

          var aCurrent = oFormModel.getProperty("/pendingAttachments") || [];
          oFormModel.setProperty(
            "/pendingAttachments",
            aCurrent.filter(function (oItem) {
              return oItem.localId !== oPending.localId;
            }),
          );
        }

        var aRemaining = oFormModel.getProperty("/pendingAttachments") || [];

        oFormModel.setProperty("/hasPendingAttachments", aRemaining.length > 0);
      },

      _deleteAttachment: function (sAttachmentId, sRequestId) {
        return this._invokeAction("eliminarSoporte", {
          solicitudID: sRequestId,
          soporteID: sAttachmentId,
        });
      },

      _attachmentPath: function (sAttachmentId, sRequestId) {
        return (
          this._attachmentCollectionPath(sRequestId) +
          "(up__ID=" +
          encodeURIComponent(sRequestId) +
          ",ID=" +
          encodeURIComponent(sAttachmentId) +
          ")"
        );
      },

      _attachmentCollectionPath: function (sRequestId) {
        var oConfig = ServiceContract.attachments;
        return (
          oConfig.parentEntitySet +
          "(ID=" +
          encodeURIComponent(sRequestId) +
          ")/" +
          oConfig.navigationProperty
        );
      },

      _serviceRoot: function () {
        var sUri =
          this.getOwnerComponent().getManifestEntry("sap.app").dataSources
            .mainService.uri;
        return sUri.endsWith("/") ? sUri : sUri + "/";
      },

      _responseErrorMessage: async function (oResponse) {
        try {
          var oBody = await oResponse.json();
          return (
            oBody.error?.message?.value ||
            oBody.error?.message ||
            oBody.message ||
            this._text("httpError", [oResponse.status])
          );
        } catch (oError) {
          return this._text("httpError", [oResponse.status]);
        }
      },

      _requestFromEvent: function (oEvent) {
        return (
          oEvent.getSource().getBindingContext("view")?.getObject() || null
        );
      },

      _setValueState: function (sLocalId, bValid) {
        var oControl = Fragment.byId(this.getView().getId(), sLocalId);
        if (oControl?.setValueState) {
          oControl.setValueState(bValid ? ValueState.None : ValueState.Error);
        }
      },

      _resetRequestDialogControls: function () {
        [
          "absenceTypeSelect",
          "startDatePicker",
          "endDatePicker",
          "startTimePicker",
          "endTimePicker",
        ].forEach(
          function (sControlId) {
            this._setValueState(sControlId, true);
          }.bind(this),
        );

        var oFileUploader = Fragment.byId(
          this.getView().getId(),
          "supportFileUploader",
        );
        if (oFileUploader?.clear) {
          oFileUploader.clear();
        }
      },

      _confirm: function (sMessageKey, sTitleKey) {
        return new Promise(
          function (resolve) {
            MessageBox.confirm(this._text(sMessageKey), {
              title: this._text(sTitleKey),
              emphasizedAction: MessageBox.Action.OK,
              actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
              onClose: function (sAction) {
                resolve(sAction === MessageBox.Action.OK);
              },
            });
          }.bind(this),
        );
      },

      _unwrapArray: function (vResult) {
        if (Array.isArray(vResult)) {
          return vResult;
        }
        if (Array.isArray(vResult?.value)) {
          return vResult.value;
        }
        if (Array.isArray(vResult?.solicitudes)) {
          return vResult.solicitudes;
        }
        return [];
      },

      _unwrapObject: function (vResult) {
        if (
          vResult?.value &&
          !Array.isArray(vResult.value) &&
          typeof vResult.value === "object"
        ) {
          return vResult.value;
        }
        return vResult || {};
      },

      _resultMessage: function (oResult, sFallbackKey) {
        var oNormalized = this._unwrapObject(oResult);
        return oNormalized.mensaje || this._text(sFallbackKey);
      },

      _extractErrorMessage: function (oError) {
        var sMessage = oError?.message || "";
        try {
          var oParsed = JSON.parse(sMessage);
          return (
            oParsed.error?.message?.value || oParsed.error?.message || sMessage
          );
        } catch (oParseError) {
          return sMessage || this._text("unexpectedError");
        }
      },

      _emptySummary: function () {
        return {
          nombreEmpleado: "",
          solicitudesEnCurso: 0,
          solicitudesAprobadas: 0,
          solicitudesRechazadas: 0,
          diasVacacionesCausados: 0,
          diasVacacionesReservados: 0,
          diasVacacionesDisponibles: 0,
          horasValeraAsignadas: 0,
          horasValeraUtilizadas: 0,
          horasValeraReservadas: 0,
          horasValeraDisponibles: 0,
          horasCumpleaniosAsignadas: 0,
          horasCumpleaniosUtilizadas: 0,
          horasCumpleaniosReservadas: 0,
          horasCumpleaniosDisponibles: 0,
          proximoCumpleanios: null,
          semanaCumpleaniosInicio: null,
          semanaCumpleaniosFin: null,
          birthdayWeekLabel: "",
          vacationDetail: "",
          valeraDetail: "",
          birthdayDetail: "",
        };
      },

      _stateText: function (sState) {
        var mTexts = {
          BORRADOR: "Borrador",
          SOLICITADA: "Solicitada",
          PENDIENTE: "Pendiente",
          APROBADA: "Aprobada",
          RECHAZADA: "Rechazada",
          CANCELADA: "Cancelada",
          FINALIZADA: "Finalizada",
        };
        return mTexts[sState] || sState;
      },

      _stateValue: function (sState) {
        if (APPROVED_STATES.has(sState)) {
          return "Success";
        }
        if (REJECTED_STATES.has(sState)) {
          return "Error";
        }
        if (sState === "SOLICITADA" || sState === "PENDIENTE") {
          return "Warning";
        }
        if (sState === "CANCELADA") {
          return "Information";
        }
        return "None";
      },

      _stateIcon: function (sState) {
        if (APPROVED_STATES.has(sState)) {
          return "sap-icon://accept";
        }
        if (REJECTED_STATES.has(sState)) {
          return "sap-icon://decline";
        }
        if (sState === "SOLICITADA" || sState === "PENDIENTE") {
          return "sap-icon://pending";
        }
        if (sState === "CANCELADA") {
          return "sap-icon://sys-cancel";
        }
        return "sap-icon://document";
      },

      _formatDate: function (sValue) {
        if (!sValue) {
          return "—";
        }
        var aParts = String(sValue).slice(0, 10).split("-").map(Number);
        if (aParts.length !== 3 || aParts.some(Number.isNaN)) {
          return String(sValue);
        }
        var oDate = new Date(Date.UTC(aParts[0], aParts[1] - 1, aParts[2]));
        return new Intl.DateTimeFormat("es-CO", {
          day: "numeric",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }).format(oDate);
      },

      _formatDateTime: function (sValue) {
        if (!sValue) {
          return "—";
        }
        var oDate = new Date(sValue);
        if (Number.isNaN(oDate.getTime())) {
          return String(sValue);
        }
        return new Intl.DateTimeFormat("es-CO", {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(oDate);
      },

      _shortTime: function (sValue) {
        return sValue ? String(sValue).slice(0, 5) : "—";
      },

      _number: function (vValue) {
        var nValue = Number(vValue || 0);
        return Number.isInteger(nValue) ? nValue : Number(nValue.toFixed(2));
      },

      _formatFileSize: function (iBytes) {
        if (iBytes < 1024 * 1024) {
          return (iBytes / 1024).toFixed(1) + " KB";
        }
        return (iBytes / (1024 * 1024)).toFixed(1) + " MB";
      },

      _mimeTypeFromExtension: function (sExtension) {
        if (sExtension === "pdf") {
          return "application/pdf";
        }
        if (sExtension === "png") {
          return "image/png";
        }
        return "image/jpeg";
      },

      _attachmentIcon: function (sMimeType, sExtension) {
        return sMimeType === "application/pdf" ||
          String(sExtension).toLowerCase() === "pdf"
          ? "sap-icon://pdf-attachment"
          : "sap-icon://attachment-photo";
      },

      _attachmentStatusText: function (sStatus) {
        var mStatusTexts = {
          Clean: this._text("supportValidated"),
          Scanning: this._text("supportScanning"),
          Unscanned: this._text("supportPendingValidation"),
          Infected: this._text("supportRejected"),
          Failed: this._text("supportValidationFailed"),
        };
        return mStatusTexts[sStatus] || this._text("supportPendingValidation");
      },

      _attachmentStatusState: function (sStatus) {
        if (sStatus === "Clean") {
          return "Success";
        }
        if (sStatus === "Infected" || sStatus === "Failed") {
          return "Error";
        }
        return "Warning";
      },

      _idFromODataId: function (sODataId) {
        var aMatch = String(sODataId || "").match(/(?:\(|,)ID=([0-9a-f-]+)/i);
        return aMatch ? aMatch[1] : null;
      },

      _updateExistingAttachmentLabel: function () {
        var oFormModel = this.getView().getModel("form");
        var iCount = (oFormModel.getProperty("/existingAttachments") || [])
          .length;
        oFormModel.setProperty(
          "/existingAttachmentLabel",
          this._text("existingFiles", [iCount]),
        );
      },

      _text: function (sKey, aArguments = []) {
        return this.getOwnerComponent()
          .getModel("i18n")
          .getResourceBundle()
          .getText(sKey, aArguments || []);
      },

      _fileToBase64: function (oFile) {
        return new Promise(function (resolve, reject) {
          var oReader = new FileReader();

          oReader.onload = function () {
            var sResult = String(oReader.result || "");
            var iComma = sResult.indexOf(",");

            resolve(iComma >= 0 ? sResult.substring(iComma + 1) : sResult);
          };

          oReader.onerror = function () {
            reject(
              oReader.error || new Error("No fue posible leer el archivo."),
            );
          };

          oReader.readAsDataURL(oFile);
        });
      },

      _base64ToBytes: function (sBase64) {
        var sNormalized = String(sBase64 || "")
          .replace(/^data:[^;]+;base64,/, "")
          .replace(/\s/g, "");

        var sBinary = window.atob(sNormalized);
        var aBytes = new Uint8Array(sBinary.length);

        for (var i = 0; i < sBinary.length; i += 1) {
          aBytes[i] = sBinary.charCodeAt(i);
        }

        return aBytes;
      },
    });
  },
);
