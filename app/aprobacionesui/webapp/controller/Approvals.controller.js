sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/core/Fragment",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/base/util/uid",
    "sabnez/com/aprobacionesui/model/serviceContract",
  ],
  function (
    Controller,
    JSONModel,
    Fragment,
    MessageBox,
    MessageToast,
    uid,
    ServiceContract,
  ) {
    "use strict";

    var PENDING_STATES = new Set(ServiceContract.pendingStates);

    return Controller.extend("sabnez.com.aprobacionesui.controller.Approvals", {
      onInit: function () {
        var oViewModel = new JSONModel(this._initialState());
        oViewModel.setSizeLimit(1000);
        this.getView().setModel(oViewModel, "view");

        var oRouter = this.getOwnerComponent().getRouter();
        oRouter
          .getRoute("Approvals")
          .attachPatternMatched(this._onRootRouteMatched, this);
        oRouter
          .getRoute("TaskDetail")
          .attachPatternMatched(this._onTaskRouteMatched, this);
      },

      onExit: function () {
        [
          this._reasonDialog,
          this._forwardDialog,
          this._delegationDialog,
        ]
          .filter(Boolean)
          .forEach(function (oDialog) {
            oDialog.destroy();
          });
      },

      _onRootRouteMatched: async function (oEvent) {
        var oQuery = oEvent.getParameter("arguments")?.["?query"] || {};
        if (oQuery.taskId) {
          this.getOwnerComponent()
            .getRouter()
            .navTo("TaskDetail", { id: oQuery.taskId }, true);
          return;
        }
        await this._loadData(false);
      },

      _onTaskRouteMatched: async function (oEvent) {
        var sTaskID = oEvent.getParameter("arguments")?.id;
        if (!sTaskID) {
          this.getOwnerComponent().getRouter().navTo("Approvals", {}, true);
          return;
        }

        await this._loadData(false);
        var aTasks =
          this.getView().getModel("view").getProperty("/tasks") || [];
        var oTask = aTasks.find(function (oEntry) {
          return oEntry.ID === sTaskID;
        });
        if (!oTask) {
          MessageBox.error(this._text("taskNotFound"));
          this.getOwnerComponent().getRouter().navTo("Approvals", {}, true);
          return;
        }
        await this._openTaskDetail(oTask);
      },

      onRefresh: async function () {
        await this._loadData(true);
        MessageToast.show(this._text("dataUpdated"));
      },

      onDismissError: function () {
        this.getView().getModel("view").setProperty("/error", "");
      },

      onTabSelect: function (oEvent) {
        var oModel = this.getView().getModel("view");
        var sKey = oEvent.getParameter("key");
        oModel.setProperty("/selectedTab", sKey);
        if (sKey !== "HISTORY") {
          oModel.setProperty("/filters/status", "");
        }
        this._applyFilters();
      },

      onSearch: function (oEvent) {
        this.getView()
          .getModel("view")
          .setProperty(
            "/filters/search",
            oEvent.getParameter("newValue") || "",
          );
        this._applyFilters();
      },

      onFilterChange: function () {
        this._applyFilters();
      },

      onDateFilterChange: function (oEvent) {
        var oSource = oEvent.getSource();
        var oModel = this.getView().getModel("view");
        oModel.setProperty(
          "/filters/dateFrom",
          this._dateToISO(oSource.getDateValue()),
        );
        oModel.setProperty(
          "/filters/dateTo",
          this._dateToISO(oSource.getSecondDateValue()),
        );
        this._applyFilters();
      },

      onClearFilters: function () {
        var oModel = this.getView().getModel("view");
        oModel.setProperty("/filters", {
          search: "",
          type: "",
          status: "",
          dateFrom: "",
          dateTo: "",
        });
        this.byId("taskSearch").setValue("");
        this.byId("dateFilter").setDateValue(null);
        this.byId("dateFilter").setSecondDateValue(null);
        this._applyFilters();
      },

      onOpenTask: function (oEvent) {
        var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
        var oTask = oItem.getBindingContext("view")?.getObject();
        if (!oTask?.ID) {
          return;
        }
        this.getOwnerComponent()
          .getRouter()
          .navTo("TaskDetail", { id: oTask.ID });
      },

      onCloseTaskDetail: function () {
        var oSplit = this.byId("approvalWorkSplit");
        oSplit.toMaster(this.byId("approvalInboxPage"));
        oSplit.showMaster();
        this.getView()
          .getModel("view")
          .setProperty("/selectedTask", this._emptyTask());
        this.getOwnerComponent().getRouter().navTo("Approvals", {}, true);
      },

      onApprove: async function (oEvent) {
        await this._confirmApproval(
          oEvent.getSource().getBindingContext("view")?.getObject(),
        );
      },

      onApproveSelected: async function () {
        await this._confirmApproval(
          this.getView().getModel("view").getProperty("/selectedTask"),
        );
      },

      onReject: async function (oEvent) {
        await this._openReasonDialog(
          "REJECT",
          oEvent.getSource().getBindingContext("view")?.getObject(),
        );
      },

      onRejectSelected: async function () {
        var oTask = this.getView()
          .getModel("view")
          .getProperty("/selectedTask");
        await this._openReasonDialog(
          oTask.source === "TIME" ? "RETURN_TIME" : "REJECT",
          oTask,
        );
      },

      onReasonChange: function (oEvent) {
        this.getView()
          .getModel("view")
          .setProperty(
            "/reasonForm/comment",
            oEvent.getParameter("value") || "",
          );
      },

      onConfirmReason: async function () {
        var oForm = this.getView().getModel("view").getProperty("/reasonForm");
        var sComment = (oForm.comment || "").trim();
        if (!sComment) {
          MessageBox.warning(this._text("reasonRequired"));
          return;
        }

        if (oForm.mode === "REJECT") {
          await this._executeOperation({
            name: ServiceContract.operations.reject,
            parameters: {
              ID: oForm.targetID,
              expectedVersion: oForm.expectedVersion,
              idempotencyKey: this._idempotencyKey(),
              comentario: sComment,
            },
            successKey: "taskRejected",
            closeTask: true,
          });
        } else if (oForm.mode === "RETURN_TIME") {
          try {
            var oTimeResult = await this._timePost("devolverHoja", {
              hojaID: oForm.targetID,
              comentario: sComment,
            });
            MessageToast.show(oTimeResult.mensaje || this._text("timeReturned"));
            this._reasonDialog?.close();
            this.onCloseTaskDetail();
            await this._loadData(true);
          } catch (oError) {
            MessageBox.error(this._extractErrorMessage(oError));
          }
        } else if (oForm.mode === "REVOKE") {
          await this._executeOperation({
            name: ServiceContract.operations.revokeDelegation,
            parameters: {
              ID: oForm.targetID,
              expectedVersion: oForm.expectedVersion,
              idempotencyKey: this._idempotencyKey(),
              motivo: sComment,
            },
            successKey: "delegationRevoked",
            closeTask: false,
          });
        }
      },

      onCloseReasonDialog: function () {
        this._reasonDialog?.close();
      },

      onReasonDialogAfterClose: function () {
        this.getView()
          .getModel("view")
          .setProperty("/reasonForm", this._emptyReasonForm());
      },

      onForward: async function (oEvent) {
        await this._openForwardDialog(
          oEvent.getSource().getBindingContext("view")?.getObject(),
        );
      },

      onForwardSelected: async function () {
        await this._openForwardDialog(
          this.getView().getModel("view").getProperty("/selectedTask"),
        );
      },

      onConfirmForward: async function () {
        var oForm = this.getView().getModel("view").getProperty("/forwardForm");
        var sReason = (oForm.reason || "").trim();
        if (!oForm.recipientID || !sReason) {
          MessageBox.warning(this._text("forwardRequired"));
          return;
        }
        await this._executeOperation({
          name: ServiceContract.operations.forward,
          parameters: {
            ID: oForm.taskID,
            delegadoID: oForm.recipientID,
            expectedVersion: oForm.expectedVersion,
            idempotencyKey: this._idempotencyKey(),
            comentario: sReason,
          },
          successKey: "taskForwarded",
          closeTask: true,
        });
      },

      onCloseForwardDialog: function () {
        this._forwardDialog?.close();
      },

      onForwardDialogAfterClose: function () {
        this.getView()
          .getModel("view")
          .setProperty("/forwardForm", this._emptyForwardForm());
      },

      onOpenDelegation: async function () {
        var aCandidates =
          this.getView().getModel("view").getProperty("/eligibleEmployees") ||
          [];
        if (aCandidates.length === 0) {
          MessageBox.information(this._text("noEligibleEmployees"));
          return;
        }

        var oStart = new Date();
        var oEnd = new Date();
        oEnd.setDate(oEnd.getDate() + 14);
        this.getView()
          .getModel("view")
          .setProperty("/delegationForm", {
            type: "BACKUP",
            recipientID: "",
            startDate: this._dateToISO(oStart),
            endDate: this._dateToISO(oEnd),
            reason: "",
          });

        if (!this._delegationDialog) {
          this._delegationDialog = await Fragment.load({
            id: this.getView().getId(),
            name: "sabnez.com.aprobacionesui.fragment.DelegationDialog",
            controller: this,
          });
          this.getView().addDependent(this._delegationDialog);
        }
        this._delegationDialog.open();
      },

      onSaveDelegation: async function () {
        var oForm = this.getView()
          .getModel("view")
          .getProperty("/delegationForm");
        if (!oForm.recipientID || !oForm.startDate || !oForm.endDate) {
          MessageBox.warning(this._text("delegationRequired"));
          return;
        }
        if (oForm.endDate < oForm.startDate) {
          MessageBox.warning(this._text("invalidDelegationRange"));
          return;
        }

        await this._executeOperation({
          name: ServiceContract.operations.saveDelegation,
          parameters: {
            ID: null,
            expectedVersion: 0,
            delegadoID: oForm.recipientID,
            modo: oForm.type,
            fechaInicio: oForm.startDate,
            fechaFin: oForm.endDate,
            alcance: "ALL",
            processCode: null,
            incluirPendientes: true,
            idempotencyKey: this._idempotencyKey(),
            motivo: (oForm.reason || "").trim() || null,
          },
          successKey: "delegationSaved",
          closeTask: false,
        });
      },

      onCloseDelegationDialog: function () {
        this._delegationDialog?.close();
      },

      onDelegationDialogAfterClose: function () {
        this.getView()
          .getModel("view")
          .setProperty("/delegationForm", this._emptyDelegationForm());
      },

      onRevokeDelegation: async function (oEvent) {
        var oDelegation = oEvent
          .getSource()
          .getBindingContext("view")
          ?.getObject();
        await this._openReasonDialog("REVOKE", oDelegation);
      },

      _loadData: async function (bForce) {
        if (this._loadPromise && !bForce) {
          return this._loadPromise;
        }

        var oModel = this.getView().getModel("view");
        oModel.setProperty("/busy", true);
        oModel.setProperty("/error", "");

        this._loadPromise = async function () {
          try {
            var aResults = await Promise.all([
              this._callOperation(ServiceContract.operations.getSummary),
              this._callOperation(ServiceContract.operations.getTasks),
              this._callOperation(ServiceContract.operations.getDelegations),
              this._loadEligibleEmployees(),
              this._loadTimeTasks(),
            ]);

            var aApprovalTasks = this._unwrapArray(aResults[1], "tareas").map(
              this._normalizeTask.bind(this),
            );
            var aTimeTasks = aResults[4] || [];
            var aTasks = aApprovalTasks.concat(aTimeTasks).sort(function (a, b) {
              return String(b.submittedAtRaw || "").localeCompare(
                String(a.submittedAtRaw || ""),
              );
            });
            var aDelegations = this._unwrapArray(
              aResults[2],
              "delegaciones",
            ).map(this._normalizeDelegation.bind(this));
            var aEligible = aResults[3] || [];
            var oSummary = this._normalizeSummary(
              this._unwrapObject(aResults[0]),
            );
            oSummary.porDecidir += aTimeTasks.filter(function (oTask) {
              return oTask.scope === "PENDING";
            }).length;

            oModel.setProperty("/tasks", aTasks);
            oModel.setProperty("/delegations", aDelegations);
            oModel.setProperty("/eligibleEmployees", aEligible);
            oModel.setProperty("/summary", oSummary);
            oModel.setProperty(
              "/snappedSummary",
              this._text("snappedSummary", [
                oSummary.porDecidir,
                oSummary.comoBackup,
              ]),
            );
            oModel.setProperty(
              "/delegationCountLabel",
              this._text("delegationCount", [aDelegations.length]),
            );
            oModel.setProperty("/typeFilters", this._buildTypeFilters(aTasks));
            oModel.setProperty("/tabCounts", this._tabCounts(aTasks));
            this._applyFilters();
            this._loaded = true;
          } catch (oError) {
            oModel.setProperty("/error", this._extractErrorMessage(oError));
          } finally {
            oModel.setProperty("/busy", false);
            this._loadPromise = null;
          }
        }.bind(this)();

        return this._loadPromise;
      },

      onDownloadAttachment: async function (oEvent) {
        var oFact = oEvent.getSource().getBindingContext("view")?.getObject();

        if (!oFact) {
          return;
        }

        var sAttachmentId = oFact.ID || null;
        var sRequestId = this._absenceRequestIdFromLink(oFact.link);

        if (!sRequestId || !sAttachmentId) {
          MessageBox.error("No fue posible identificar el soporte asociado.");
          return;
        }

        try {
          var oResult = await this._callOperation(
            ServiceContract.operations.downloadAbsenceAttachment,
            {
              solicitudID: sRequestId,
              soporteID: sAttachmentId,
            },
          );

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
          oLink.download = oFile.filename || oFact.value || "soporte";

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
      onDownloadAbsenceAttachment: async function (oEvent) {
        var oAttachment = oEvent
          .getSource()
          .getBindingContext("view")
          ?.getObject();

        if (!oAttachment) {
          return;
        }

        var oSelectedTask = this.getView()
          .getModel("view")
          .getProperty("/selectedTask");

        var sRequestId =
          oAttachment.up__ID ||
          oAttachment.solicitudID ||
          oSelectedTask?.businessObjectID ||
          oSelectedTask?.solicitudID;

        if (!sRequestId || !oAttachment.ID) {
          MessageBox.error(
            "No fue posible identificar la solicitud o el soporte asociado.",
          );
          return;
        }

        var sAttachmentId = oAttachment.ID;

        try {
          var oResult = await this._callOperation(
            ServiceContract.operations.downloadAbsenceAttachment,
            {
              solicitudID: sRequestId,
              soporteID: sAttachmentId,
            },
          );

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
          oLink.download = oFile.filename || oAttachment.filename || "soporte";

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

      _loadTimeTasks: async function () {
        try {
          var oResponse = await this._timeGet(
            "obtenerBandeja(estado='PENDING')",
          );
          return (oResponse.value || oResponse || []).map(
            this._normalizeTimeTask.bind(this),
          );
        } catch (oError) {
          return [];
        }
      },

      _normalizeTimeTask: function (oRaw) {
        var sEmployee = oRaw.empleadoNombre || this._text("unknownEmployee");
        var sSummary = [
          oRaw.clienteNombre,
          oRaw.proyectoNombre,
          [oRaw.semanaInicio, oRaw.semanaFin].filter(Boolean).join(" — "),
        ]
          .filter(Boolean)
          .join(" · ");
        var sSearch = this._normalizeText(
          [sEmployee, sSummary, "tiempos", "horas"].join(" "),
        );
        return {
          ID: oRaw.ID,
          source: "TIME",
          version: Number(oRaw.version || 0),
          employeeName: sEmployee,
          employeeEmail: oRaw.empleadoCorreo || "",
          employeePosition: "",
          employeeInitials: this._initials(sEmployee),
          processFilterCode: "TIME",
          requestTitle: this._text("timeApprovalTitle"),
          requestSummary: sSummary,
          processCode: this._text("timeProcess"),
          businessObjectText: oRaw.proyectoNombre || "—",
          state: oRaw.estado || "SUBMITTED",
          statusText: this._text("statusPending"),
          statusState: "Warning",
          statusIcon: "sap-icon://pending",
          role: "PRIMARY",
          roleText: this._text("directManagerRole"),
          roleState: "Information",
          isBackup: false,
          scope: "PENDING",
          submittedText: this._formatDateTime(oRaw.enviadoEn),
          submittedAtRaw: oRaw.enviadoEn,
          filterDate: String(oRaw.enviadoEn || "").slice(0, 10),
          priorityText: oRaw.registrosConAlerta > 0 ? this._text("priorityHigh") : this._text("priorityMedium"),
          priorityState: oRaw.registrosConAlerta > 0 ? "Warning" : "Information",
          priorityIcon: oRaw.registrosConAlerta > 0 ? "sap-icon://alert" : "sap-icon://flag",
          canApprove: oRaw.puedeAprobar === true,
          canReject: oRaw.puedeDevolver === true,
          canForward: false,
          secondaryActionText: this._text("returnForCorrection"),
          secondaryActionIcon: "sap-icon://undo",
          searchText: sSearch,
          timeSummary: oRaw,
        };
      },

      _loadTimeDetail: async function (oTask) {
        var oResponse = await this._timeGet(
          "obtenerDetalle(hojaID=" + oTask.ID + ")",
        );
        var oDetail = oResponse.value || oResponse;
        var oSummary = oDetail.resumen || oTask.timeSummary || {};
        var aFacts = [];
        (oDetail.registros || []).forEach(function (oEntry, iIndex) {
          aFacts.push({
            ID: oEntry.ID,
            section: [oEntry.proyectoNombre, oEntry.fecha || "Registro"]
              .filter(Boolean)
              .join(" · "),
            label: [oEntry.tipo, Number(oEntry.horas || 0) + " h"].filter(Boolean).join(" · "),
            value: [oEntry.descripcion, oEntry.soporteNombre ? "Soporte: " + oEntry.soporteNombre : null]
              .filter(Boolean)
              .join(" · ") || "Sin descripción",
            isLink: false,
            isStatus: false,
            state: oEntry.alerta ? "Warning" : "None",
            order: iIndex,
          });
        });
        var oDetailedTask = Object.assign({}, oTask, {
          requestSummary: [
            oSummary.clienteNombre,
            oSummary.proyectoNombre,
            [oSummary.semanaInicio, oSummary.semanaFin].filter(Boolean).join(" — "),
          ].filter(Boolean).join(" · "),
          facts: aFacts,
          events: [],
          canApprove: oSummary.puedeAprobar === true,
          canReject: oSummary.puedeDevolver === true,
        });
        this.getView().getModel("view").setProperty("/selectedTask", oDetailedTask);
      },

      _loadEligibleEmployees: async function () {
        try {
          var oListBinding = this.getView()
            .getModel()
            .bindList(
              "/" + ServiceContract.entities.eligibleEmployees,
              null,
              null,
              null,
              { $select: "ID,nombreCompleto,correoCorporativo" },
            );
          var aContexts = await oListBinding.requestContexts(0, 500);
          return aContexts
            .map(function (oContext) {
              var oEmployee = oContext.getObject();
              return {
                ID: oEmployee.ID,
                name:
                  oEmployee.nombreCompleto || oEmployee.nombre || oEmployee.ID,
                email: oEmployee.correoCorporativo || oEmployee.correo || "",
              };
            })
            .sort(function (a, b) {
              return a.name.localeCompare(b.name, "es");
            });
        } catch (oError) {
          return [];
        }
      },

      _callOperation: async function (sName, mParameters) {
        var oBinding = this.getView()
          .getModel()
          .bindContext("/" + sName + "(...)");
        Object.entries(mParameters || {}).forEach(function (aEntry) {
          if (aEntry[1] !== undefined) {
            oBinding.setParameter(aEntry[0], aEntry[1]);
          }
        });
        await oBinding.execute("$direct");
        return oBinding.getBoundContext()?.getObject() || {};
      },

      _timeGet: async function (sPath) {
        var oResponse = await fetch("/tiempos-aprobacion/" + sPath, {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (!oResponse.ok) {
          throw await this._timeError(oResponse);
        }
        return oResponse.json();
      },

      _timePost: async function (sPath, oPayload) {
        var oResponse = await fetch("/tiempos-aprobacion/" + sPath, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-CSRF-Token": await this._timeCsrfToken(),
          },
          body: JSON.stringify(oPayload || {}),
        });
        if (!oResponse.ok) {
          throw await this._timeError(oResponse);
        }
        return oResponse.json();
      },

      _timeCsrfToken: async function () {
        if (this._timeCsrf) {
          return this._timeCsrf;
        }
        var oResponse = await fetch("/tiempos-aprobacion/", {
          credentials: "same-origin",
          headers: { "X-CSRF-Token": "Fetch" },
        });
        if (!oResponse.ok) {
          throw await this._timeError(oResponse);
        }
        this._timeCsrf = oResponse.headers.get("X-CSRF-Token");
        return this._timeCsrf;
      },

      _timeError: async function (oResponse) {
        var oData = await oResponse.json().catch(function () {
          return {};
        });
        return new Error(
          oData.error?.message || this._text("unexpectedError"),
        );
      },

      _executeOperation: async function (mOptions) {
        var oModel = this.getView().getModel("view");
        if (oModel.getProperty("/actionBusy")) {
          return;
        }
        oModel.setProperty("/actionBusy", true);
        try {
          var oResult = await this._callOperation(
            mOptions.name,
            mOptions.parameters,
          );
          MessageToast.show(this._resultMessage(oResult, mOptions.successKey));

          this._reasonDialog?.close();
          this._forwardDialog?.close();
          this._delegationDialog?.close();
          if (mOptions.closeTask) {
            this.onCloseTaskDetail();
          }
          await this._loadData(true);
        } catch (oError) {
          MessageBox.error(this._extractErrorMessage(oError));
        } finally {
          oModel.setProperty("/actionBusy", false);
        }
      },

      _confirmApproval: async function (oTask) {
        if (!oTask?.ID || !oTask.canApprove) {
          return;
        }
        var bConfirmed = await this._confirm(
          this._text("confirmApprove", [
            oTask.employeeName,
            oTask.requestTitle,
          ]),
          this._text("approve"),
        );
        if (!bConfirmed) {
          return;
        }

        if (oTask.source === "TIME") {
          try {
            var oTimeResult = await this._timePost("aprobarHoja", {
              hojaID: oTask.ID,
              comentario: null,
            });
            MessageToast.show(oTimeResult.mensaje || this._text("taskApproved"));
            this.onCloseTaskDetail();
            await this._loadData(true);
          } catch (oError) {
            MessageBox.error(this._extractErrorMessage(oError));
          }
          return;
        }

        await this._executeOperation({
          name: ServiceContract.operations.approve,
          parameters: {
            ID: oTask.ID,
            expectedVersion: oTask.version,
            idempotencyKey: this._idempotencyKey(),
            comentario: null,
          },
          successKey: "taskApproved",
          closeTask: true,
        });
      },

      _openTaskDetail: async function (oTask) {
        var oModel = this.getView().getModel("view");
        oModel.setProperty(
          "/selectedTask",
          Object.assign({}, oTask, { facts: [], events: [] }),
        );
        oModel.setProperty("/actionBusy", true);
        try {
          if (oTask.source === "TIME") {
            await this._loadTimeDetail(oTask);
            this._showTaskDetail();
            return;
          }
          var oRawDetail = this._unwrapObject(
            await this._callOperation(
              ServiceContract.operations.getTaskDetail,
              { ID: oTask.ID },
            ),
          );
          var oDetailedTask = this._normalizeTask(
            Object.assign({}, oTask, oRawDetail.tarea || {}),
          );
          oDetailedTask.facts = this._normalizeFacts(oRawDetail.hechos);
          oDetailedTask.events = this._normalizeEvents(oRawDetail.eventos);
          oDetailedTask.hasFacts = oDetailedTask.facts.length > 0;
          oDetailedTask.hasEvents = oDetailedTask.events.length > 0;
          oModel.setProperty("/selectedTask", oDetailedTask);
        } catch (oError) {
          MessageBox.error(this._extractErrorMessage(oError));
          return;
        } finally {
          oModel.setProperty("/actionBusy", false);
        }
        this._showTaskDetail();
      },

      _showTaskDetail: function () {
        var oSplit = this.byId("approvalWorkSplit");
        oSplit.toDetail(this.byId("inlineTaskDetailPage"));
        if (window.matchMedia("(max-width: 600px)").matches) {
          oSplit.hideMaster();
        }
      },

      _normalizeFacts: function (aFacts) {
        if (!Array.isArray(aFacts)) {
          return [];
        }
        return aFacts
          .slice()
          .sort(function (a, b) {
            return Number(a.orden || 0) - Number(b.orden || 0);
          })
          .map(
            function (oFact) {
              var sType = String(oFact.tipoDato || "TEXT").toUpperCase();
              var sColor = String(oFact.semanticColor || "").toUpperCase();
              return {
                ID: oFact.ID,
                section: oFact.seccion || this._text("generalSection"),
                label: oFact.etiqueta || oFact.clave || "—",
                value: oFact.valor || "—",
                link: oFact.enlace || oFact.valor || "",
                isLink: ["LINK", "URL"].includes(sType),
                isStatus: ["STATUS", "SEMANTIC"].includes(sType),
                state:
                  {
                    SUCCESS: "Success",
                    POSITIVE: "Success",
                    WARNING: "Warning",
                    CRITICAL: "Warning",
                    ERROR: "Error",
                    NEGATIVE: "Error",
                    INFORMATION: "Information",
                  }[sColor] || "None",
              };
            }.bind(this),
          );
      },

      _normalizeEvents: function (aEvents) {
        if (!Array.isArray(aEvents)) {
          return [];
        }
        return aEvents
          .slice()
          .sort(function (a, b) {
            return String(b.fecha || "").localeCompare(String(a.fecha || ""));
          })
          .map(
            function (oEvent) {
              var sActor = oEvent.actorNombre || this._text("systemActor");
              if (oEvent.actuandoPorNombre) {
                sActor = this._text("actingFor", [
                  sActor,
                  oEvent.actuandoPorNombre,
                ]);
              }
              return {
                ID: oEvent.ID,
                type: this._eventText(oEvent.tipo),
                actor: sActor,
                detail: oEvent.detalle || "",
                dateText: this._formatDateTime(oEvent.fecha),
                icon: this._eventIcon(oEvent.tipo),
              };
            }.bind(this),
          );
      },

      _eventText: function (sType) {
        var sKey = String(sType || "").toUpperCase();
        if (sKey.endsWith("CREATED")) {
          return this._text("eventCreated");
        }
        if (sKey.endsWith("ASSIGNED")) {
          return this._text("eventAssigned");
        }
        if (sKey.endsWith("APPROVED")) {
          return this._text("eventApproved");
        }
        if (sKey.endsWith("REJECTED")) {
          return this._text("eventRejected");
        }
        if (sKey.endsWith("FORWARDED")) {
          return this._text("eventForwarded");
        }
        if (sKey.endsWith("CANCELLED")) {
          return this._text("eventCancelled");
        }
        if (sKey.endsWith("REVOKED")) {
          return this._text("eventRevoked");
        }
        if (sKey.endsWith("EXPIRED")) {
          return this._text("eventExpired");
        }
        return sType || this._text("eventUpdated");
      },

      _eventIcon: function (sType) {
        var sKey = String(sType || "").toUpperCase();
        if (sKey.endsWith("APPROVED")) {
          return "sap-icon://accept";
        }
        if (sKey.endsWith("REJECTED") || sKey.endsWith("REVOKED")) {
          return "sap-icon://decline";
        }
        if (sKey.endsWith("FORWARDED")) {
          return "sap-icon://forward";
        }
        if (sKey.endsWith("ASSIGNED")) {
          return "sap-icon://employee";
        }
        if (sKey.endsWith("CREATED")) {
          return "sap-icon://create";
        }
        if (sKey.endsWith("EXPIRED")) {
          return "sap-icon://lateness";
        }
        return "sap-icon://history";
      },

      _openReasonDialog: async function (sMode, oTarget) {
        if (!oTarget?.ID) {
          return;
        }
        var bReject = sMode === "REJECT";
        var bReturnTime = sMode === "RETURN_TIME";
        this.getView()
          .getModel("view")
          .setProperty("/reasonForm", {
            mode: sMode,
            targetID: oTarget.ID,
            expectedVersion: Number(oTarget.version || 0),
            title: this._text(bReturnTime ? "returnTimeTask" : bReject ? "rejectTask" : "revokeDelegation"),
            label: this._text(bReturnTime ? "returnReason" : bReject ? "rejectionReason" : "revocationReason"),
            placeholder: this._text(
              bReturnTime ? "returnPlaceholder" : bReject ? "rejectionPlaceholder" : "revocationPlaceholder",
            ),
            actionText: this._text(bReturnTime ? "returnForCorrection" : bReject ? "reject" : "revoke"),
            actionType: bReject || bReturnTime ? "Reject" : "Emphasized",
            comment: "",
          });
        if (!this._reasonDialog) {
          this._reasonDialog = await Fragment.load({
            id: this.getView().getId(),
            name: "sabnez.com.aprobacionesui.fragment.ReasonDialog",
            controller: this,
          });
          this.getView().addDependent(this._reasonDialog);
        }
        this._reasonDialog.open();
      },

      _openForwardDialog: async function (oTask) {
        if (!oTask?.ID || !oTask.canForward) {
          return;
        }
        var aCandidates =
          this.getView().getModel("view").getProperty("/eligibleEmployees") ||
          [];
        if (aCandidates.length === 0) {
          MessageBox.information(this._text("noEligibleEmployees"));
          return;
        }
        this.getView()
          .getModel("view")
          .setProperty("/forwardForm", {
            taskID: oTask.ID,
            expectedVersion: Number(oTask.version || 0),
            recipientID: "",
            reason: "",
            candidates: aCandidates,
          });
        if (!this._forwardDialog) {
          this._forwardDialog = await Fragment.load({
            id: this.getView().getId(),
            name: "sabnez.com.aprobacionesui.fragment.ForwardDialog",
            controller: this,
          });
          this.getView().addDependent(this._forwardDialog);
        }
        this._forwardDialog.open();
      },

      _applyFilters: function () {
        var oModel = this.getView().getModel("view");
        var aTasks = oModel.getProperty("/tasks") || [];
        var oFilters = oModel.getProperty("/filters");
        var sTab = oModel.getProperty("/selectedTab");
        var sSearch = this._normalizeText(oFilters.search);

        var aFiltered = aTasks.filter(function (oTask) {
          if (oTask.scope !== sTab) {
            return false;
          }
          if (oFilters.type && oTask.processFilterCode !== oFilters.type) {
            return false;
          }
          if (oFilters.status && oTask.state !== oFilters.status) {
            return false;
          }
          if (
            oFilters.dateFrom &&
            (!oTask.filterDate || oTask.filterDate < oFilters.dateFrom)
          ) {
            return false;
          }
          if (
            oFilters.dateTo &&
            (!oTask.filterDate || oTask.filterDate > oFilters.dateTo)
          ) {
            return false;
          }
          return !sSearch || oTask.searchText.includes(sSearch);
        });

        oModel.setProperty("/filteredTasks", aFiltered);
        oModel.setProperty(
          "/resultCountLabel",
          this._text("resultCount", [aFiltered.length]),
        );
        oModel.setProperty(
          "/worklistTitle",
          this._text(
            {
              PENDING: "pendingTitle",
              BACKUP: "backupTitle",
              HISTORY: "historyTitle",
            }[sTab],
          ),
        );
        oModel.setProperty(
          "/noDataTitle",
          this._text(
            { PENDING: "noPending", BACKUP: "noBackup", HISTORY: "noHistory" }[
              sTab
            ],
          ),
        );
        oModel.setProperty(
          "/noDataDescription",
          this._text(
            {
              PENDING: "noPendingDescription",
              BACKUP: "noBackupDescription",
              HISTORY: "noHistoryDescription",
            }[sTab],
          ),
        );
      },

      _normalizeTask: function (oRaw) {
        var sState = String(oRaw.estado || "OPEN").toUpperCase();
        var sRole = String(oRaw.tipoAsignacion || "PRIMARY").toUpperCase();
        var bBackup = sRole === "BACKUP" || sRole === "DELEGATE";
        var bPending = PENDING_STATES.has(sState);
        var sEmployeeName =
          oRaw.solicitanteNombre || this._text("unknownEmployee");
        var sTitle = oRaw.titulo || oRaw.processCode || this._text("request");
        var sRawProcessCode = String(oRaw.processCode || "");
        var bAbsenceProcess = sRawProcessCode.toUpperCase() === "ABSENCE";
        var sProcessFilterCode = bAbsenceProcess
          ? [sRawProcessCode, sTitle].join("::")
          : sRawProcessCode;
        var sSummary = oRaw.resumen || oRaw.businessObjectID || "—";
        var sSubmittedAt = oRaw.fechaSolicitud;
        var oDue = this._duePresentation(oRaw.fechaVencimiento, bPending);
        var oStatus = this._statusPresentation(sState);
        var oRole = this._rolePresentation(sRole);
        var oPriority = this._priorityPresentation(oRaw.prioridad);
        var bCanApprove = bPending && oRaw.puedeAprobar === true;
        var bCanReject = bPending && oRaw.puedeRechazar === true;
        var bCanForward = bPending && oRaw.puedeReenviar === true;
        var sSearchText = this._normalizeText(
          [
            sEmployeeName,
            sTitle,
            sSummary,
            oRaw.processCode,
            oRaw.businessObjectID,
            oStatus.text,
            oRole.text,
            oRaw.actuandoPorNombre,
          ]
            .filter(Boolean)
            .join(" "),
        );

        return Object.assign({}, oRaw, {
          source: "APPROVAL",
          ID: oRaw.ID,
          version: Number(oRaw.version || 0),
          employeeName: sEmployeeName,
          employeeEmail: "",
          employeePosition: oRaw.actuandoPorNombre
            ? this._text("actingForShort", [oRaw.actuandoPorNombre])
            : "",
          employeeInitials: this._initials(sEmployeeName),
          processFilterCode: sProcessFilterCode,
          requestTitle: sTitle,
          requestSummary: sSummary,
          processCode: bAbsenceProcess
            ? this._text("absenceProcess")
            : sRawProcessCode || this._text("unspecifiedProcess"),
          businessObjectText:
            [oRaw.businessObjectType, oRaw.businessObjectID]
              .filter(Boolean)
              .join(" · ") || "—",
          state: sState,
          statusText: oStatus.text,
          statusState: oStatus.state,
          statusIcon: oStatus.icon,
          role: sRole,
          roleText: oRole.text,
          roleState: oRole.state,
          isBackup: bBackup,
          scope: bPending ? (bBackup ? "BACKUP" : "PENDING") : "HISTORY",
          submittedText: this._formatDateTime(sSubmittedAt),
          submittedAtRaw: sSubmittedAt,
          modifiedText: oRaw.modifiedAt
            ? this._formatDateTime(oRaw.modifiedAt)
            : "",
          dueText: oDue.text,
          dueState: oDue.state,
          dueIcon: oDue.icon,
          filterDate: String(sSubmittedAt || "").slice(0, 10),
          reasonDisplay: sSummary,
          priorityText: oPriority.text,
          priorityState: oPriority.state,
          priorityIcon: oPriority.icon,
          canApprove: bCanApprove,
          canReject: bCanReject,
          canForward: bCanForward,
          secondaryActionText: this._text("reject"),
          secondaryActionIcon: "sap-icon://decline",
          searchText: sSearchText,
        });
      },

      _normalizeDelegation: function (oRaw) {
        var sType = String(oRaw.modo || "BACKUP").toUpperCase();
        var sStatus = String(oRaw.estado || "ACTIVE").toUpperCase();
        var sName = oRaw.delegadoNombre || this._text("unknownEmployee");
        var bActive = sStatus === "ACTIVE";
        return Object.assign({}, oRaw, {
          ID: oRaw.ID,
          version: Number(oRaw.version || 0),
          delegateName: sName,
          delegateEmail: oRaw.delegadoCorreo || "",
          delegateInitials: this._initials(sName),
          type: sType,
          typeText: this._text(
            sType === "SUBSTITUTE" ? "substituteType" : "backupType",
          ),
          typeState: sType === "SUBSTITUTE" ? "Warning" : "Information",
          typeIcon:
            sType === "SUBSTITUTE"
              ? "sap-icon://employee-rejections"
              : "sap-icon://group",
          periodText: this._formatDateRange(oRaw.fechaInicio, oRaw.fechaFin),
          statusText: this._text(
            "delegationStatus" + this._capitalize(sStatus),
          ),
          statusState:
            sStatus === "REVOKED" || sStatus === "EXPIRED" ? "None" : "Success",
          canRevoke: bActive,
        });
      },

      _normalizeSummary: function (oRaw) {
        return {
          porDecidir: Number(oRaw.pendientes || 0),
          vencidas: Number(oRaw.vencidas || 0),
          comoBackup: Number(oRaw.comoBackup || 0),
          delegadasPorMi: Number(oRaw.delegadasPorMi || 0),
          aprobadas: Number(oRaw.aprobadas || 0),
          rechazadas: Number(oRaw.rechazadas || 0),
        };
      },

      _statusPresentation: function (sState) {
        if (sState === "APPROVED") {
          return {
            text: this._text("statusApproved"),
            state: "Success",
            icon: "sap-icon://accept",
          };
        }
        if (sState === "REJECTED") {
          return {
            text: this._text("statusRejected"),
            state: "Error",
            icon: "sap-icon://decline",
          };
        }
        if (sState === "CANCELLED") {
          return {
            text: this._text("statusCancelled"),
            state: "Information",
            icon: "sap-icon://sys-cancel",
          };
        }
        if (sState === "EXPIRED") {
          return {
            text: this._text("statusExpired"),
            state: "Error",
            icon: "sap-icon://lateness",
          };
        }
        if (sState === "PROCESSING") {
          return {
            text: this._text("statusProcessing"),
            state: "Information",
            icon: "sap-icon://process",
          };
        }
        return {
          text: this._text("statusPending"),
          state: "Warning",
          icon: "sap-icon://pending",
        };
      },

      _rolePresentation: function (sRole) {
        if (sRole === "DELEGATE") {
          return { text: this._text("actingAsSubstitute"), state: "Warning" };
        }
        if (sRole === "BACKUP") {
          return { text: this._text("actingAsBackup"), state: "Information" };
        }
        if (sRole === "POOL") {
          return { text: this._text("actingFromPool"), state: "Information" };
        }
        return { text: "", state: "None" };
      },

      _priorityPresentation: function (sPriority) {
        var sValue = String(sPriority || "MEDIUM").toUpperCase();
        if (sValue === "VERY_HIGH" || sValue === "HIGH") {
          return {
            text: this._text(
              sValue === "VERY_HIGH" ? "priorityVeryHigh" : "priorityHigh",
            ),
            state: "Error",
            icon: "sap-icon://high-priority",
          };
        }
        if (sValue === "LOW") {
          return {
            text: this._text("priorityLow"),
            state: "None",
            icon: "sap-icon://low-priority",
          };
        }
        return {
          text: this._text("priorityMedium"),
          state: "Information",
          icon: "sap-icon://flag",
        };
      },

      _duePresentation: function (sValue, bPending) {
        if (!sValue || !bPending) {
          return { text: "", state: "None", icon: "" };
        }
        var sDate = String(sValue).slice(0, 10);
        var sToday = this._dateToISO(new Date());
        var iDays = Math.ceil(
          (this._parseISODate(sDate) - this._parseISODate(sToday)) / 86400000,
        );
        if (iDays < 0) {
          return {
            text: this._text("overdueBy", [Math.abs(iDays)]),
            state: "Error",
            icon: "sap-icon://lateness",
          };
        }
        if (iDays === 0) {
          return {
            text: this._text("dueToday"),
            state: "Error",
            icon: "sap-icon://lateness",
          };
        }
        if (iDays <= 2) {
          return {
            text: this._text("dueIn", [iDays]),
            state: "Warning",
            icon: "sap-icon://alert",
          };
        }
        return {
          text: this._text("dueDate", [this._formatDate(sDate)]),
          state: "None",
          icon: "sap-icon://calendar",
        };
      },

      _tabCounts: function (aTasks) {
        return aTasks.reduce(
          function (oCounts, oTask) {
            if (oTask.scope === "PENDING") {
              oCounts.pending += 1;
            }
            if (oTask.scope === "BACKUP") {
              oCounts.backup += 1;
            }
            if (oTask.scope === "HISTORY") {
              oCounts.history += 1;
            }
            return oCounts;
          },
          { pending: 0, backup: 0, history: 0 },
        );
      },

      _buildTypeFilters: function (aTasks) {
        var mTypes = new Map();
        aTasks.forEach(function (oTask) {
          if (oTask.processFilterCode) {
            mTypes.set(oTask.processFilterCode, oTask.requestTitle);
          }
        });
        return [{ key: "", text: this._text("allTypes") }].concat(
          Array.from(mTypes.entries())
            .sort(function (a, b) {
              return a[1].localeCompare(b[1], "es");
            })
            .map(function (aEntry) {
              return { key: aEntry[0], text: aEntry[1] };
            }),
        );
      },

      _initialState: function () {
        return {
          busy: false,
          actionBusy: false,
          error: "",
          summary: {
            porDecidir: 0,
            vencidas: 0,
            comoBackup: 0,
            delegadasPorMi: 0,
            aprobadas: 0,
            rechazadas: 0,
          },
          snappedSummary: "",
          tasks: [],
          filteredTasks: [],
          selectedTask: this._emptyTask(),
          delegations: [],
          eligibleEmployees: [],
          selectedTab: "PENDING",
          tabCounts: { pending: 0, backup: 0, history: 0 },
          filters: {
            search: "",
            type: "",
            status: "",
            dateFrom: "",
            dateTo: "",
          },
          typeFilters: [{ key: "", text: this._text("allTypes") }],
          statusFilters: [
            { key: "", text: this._text("allStatuses") },
            { key: "APPROVED", text: this._text("statusApproved") },
            { key: "REJECTED", text: this._text("statusRejected") },
            { key: "CANCELLED", text: this._text("statusCancelled") },
            { key: "EXPIRED", text: this._text("statusExpired") },
          ],
          resultCountLabel: this._text("resultCount", [0]),
          worklistTitle: this._text("pendingTitle"),
          noDataTitle: this._text("noPending"),
          noDataDescription: this._text("noPendingDescription"),
          delegationCountLabel: this._text("delegationCount", [0]),
          reasonForm: this._emptyReasonForm(),
          forwardForm: this._emptyForwardForm(),
          delegationForm: this._emptyDelegationForm(),
        };
      },

      _emptyTask: function () {
        return {
          ID: "",
          facts: [],
          events: [],
          canApprove: false,
          canReject: false,
          canForward: false,
          isBackup: false,
        };
      },

      _emptyReasonForm: function () {
        return {
          mode: "",
          targetID: "",
          expectedVersion: 0,
          title: "",
          label: "",
          placeholder: "",
          actionText: "",
          actionType: "Emphasized",
          comment: "",
        };
      },

      _emptyForwardForm: function () {
        return {
          taskID: "",
          expectedVersion: 0,
          recipientID: "",
          reason: "",
          candidates: [],
        };
      },

      _emptyDelegationForm: function () {
        return {
          type: "BACKUP",
          recipientID: "",
          startDate: "",
          endDate: "",
          reason: "",
        };
      },

      _confirm: function (sMessage, sTitle) {
        return new Promise(function (resolve) {
          MessageBox.confirm(sMessage, {
            title: sTitle,
            emphasizedAction: MessageBox.Action.OK,
            actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
            onClose: function (sAction) {
              resolve(sAction === MessageBox.Action.OK);
            },
          });
        });
      },

      _unwrapArray: function (vResult, sProperty) {
        if (Array.isArray(vResult)) {
          return vResult;
        }
        if (Array.isArray(vResult?.value)) {
          return vResult.value;
        }
        if (Array.isArray(vResult?.[sProperty])) {
          return vResult[sProperty];
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
        return this._unwrapObject(oResult).mensaje || this._text(sFallbackKey);
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

      _text: function (sKey, aArguments) {
        return this.getOwnerComponent()
          .getModel("i18n")
          .getResourceBundle()
          .getText(sKey, aArguments);
      },

      _formatDateRange: function (sStart, sEnd) {
        if (!sStart && !sEnd) {
          return "—";
        }
        if (!sEnd || sStart === sEnd) {
          return this._formatDate(sStart || sEnd);
        }
        return this._formatDate(sStart) + " – " + this._formatDate(sEnd);
      },

      _formatDate: function (sValue) {
        if (!sValue) {
          return "—";
        }
        var oDate = this._parseISODate(String(sValue).slice(0, 10));
        if (Number.isNaN(oDate.getTime())) {
          return String(sValue);
        }
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
          return this._formatDate(sValue);
        }
        return new Intl.DateTimeFormat("es-CO", {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(oDate);
      },

      _dateToISO: function (oDate) {
        if (!(oDate instanceof Date) || Number.isNaN(oDate.getTime())) {
          return "";
        }
        return [
          oDate.getFullYear(),
          String(oDate.getMonth() + 1).padStart(2, "0"),
          String(oDate.getDate()).padStart(2, "0"),
        ].join("-");
      },

      _parseISODate: function (sValue) {
        var aParts = String(sValue || "")
          .slice(0, 10)
          .split("-")
          .map(Number);
        return aParts.length === 3
          ? new Date(Date.UTC(aParts[0], aParts[1] - 1, aParts[2]))
          : new Date(NaN);
      },

      _shortTime: function (sValue) {
        return sValue ? String(sValue).slice(0, 5) : "—";
      },

      _number: function (vValue) {
        var nValue = Number(vValue || 0);
        return Number.isInteger(nValue) ? nValue : Number(nValue.toFixed(2));
      },

      _initials: function (sName) {
        return (
          String(sName || "")
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map(function (sPart) {
              return sPart.charAt(0).toUpperCase();
            })
            .join("") || "?"
        );
      },

      _normalizeText: function (sValue) {
        return String(sValue || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLocaleLowerCase("es-CO")
          .trim();
      },

      _formatFileSize: function (iBytes) {
        return iBytes < 1024 * 1024
          ? (iBytes / 1024).toFixed(1) + " KB"
          : (iBytes / (1024 * 1024)).toFixed(1) + " MB";
      },

      _capitalize: function (sValue) {
        var sNormalized = String(sValue || "").toLocaleLowerCase("es-CO");
        return sNormalized.charAt(0).toUpperCase() + sNormalized.slice(1);
      },

      _idempotencyKey: function () {
        return "approval-ui-" + uid();
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

      _absenceRequestIdFromLink: function (sLink) {
        var sValue = String(sLink || "");

        var aParentMatch = sValue.match(
          /AusenciasAprobables\(ID=([0-9a-f-]+)\)/i,
        );

        if (aParentMatch?.[1]) {
          return aParentMatch[1];
        }

        var aForeignKeyMatch = sValue.match(/up__ID=([0-9a-f-]+)/i);

        return aForeignKeyMatch?.[1] || null;
      },
    });
  },
);
