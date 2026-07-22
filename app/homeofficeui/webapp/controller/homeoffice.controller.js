sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
  ],
  function (Controller, JSONModel, MessageBox, MessageToast) {
    "use strict";

    return Controller.extend("sabnez.com.homeofficeui.controller.homeoffice", {
      onInit: function () {
        this._reservationTimer = null;
        this._refreshingAfterExpiry = false;

        const oViewModel = new JSONModel({
          busy: false,
          error: null,
          days: [],
          weekLabel: "Cargando semana...",
          deadlineLabel: "",
          selectedCount: 0,
          maxDays: 2,
          reservedCount: 0,
          hasPendingReservations: false,
          reservationBannerText: "",
          windowOpen: false,
        });

        this.getView().setModel(oViewModel, "view");

        this._loadWeek();
      },

      onRefreshButtonPress: function () {
        this._loadWeek();
      },

      onDayActionButtonPress: function (oEvent) {
        const oDay = oEvent.getSource().getBindingContext("view").getObject();

        if (oDay.estadoSeleccion === "RESERVADA") {
          this._executeAction("liberarReserva", {
            tokenReserva: oDay.tokenReserva,
          });

          return;
        }

        if (oDay.estadoSeleccion === "CONFIRMADA") {
          MessageBox.confirm(
            `¿Deseas cancelar ${oDay.nombreDia.toLowerCase()} ${oDay.dateLabel}?`,
            {
              title: "Cancelar día confirmado",

              emphasizedAction: MessageBox.Action.OK,

              actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],

              onClose: (sAction) => {
                if (sAction === MessageBox.Action.OK) {
                  this._executeAction("cancelarDia", {
                    fecha: oDay.fecha,
                  });
                }
              },
            },
          );

          return;
        }

        if (!oDay.habilitado) {
          MessageToast.show(
            oDay.motivoNoDisponible || "Este día no está disponible.",
          );

          return;
        }

        this._executeAction("reservarDia", {
          fecha: oDay.fecha,
        });
      },

      onConfirmSelectionButtonPress: function () {
        const oViewModel = this.getView().getModel("view");

        const iReservedCount = Number(oViewModel.getProperty("/reservedCount"));

        MessageBox.confirm(
          iReservedCount === 1
            ? "¿Deseas confirmar el día reservado?"
            : `¿Deseas confirmar los ${iReservedCount} días reservados?`,
          {
            title: "Confirmar selección",

            emphasizedAction: MessageBox.Action.OK,

            actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],

            onClose: (sAction) => {
              if (sAction === MessageBox.Action.OK) {
                this._executeAction("confirmarSemana", {});
              }
            },
          },
        );
      },

      _executeAction: async function (sActionName, mParameters) {
        const oViewModel = this.getView().getModel("view");

        oViewModel.setProperty("/busy", true);

        try {
          const oResult = await this._invokeAction(sActionName, mParameters);

          if (oResult?.mensaje) {
            MessageToast.show(oResult.mensaje, {
              duration: 4000,
            });
          }

          await this._loadWeek();
        } catch (oError) {
          MessageBox.error(this._extractErrorMessage(oError));
        } finally {
          oViewModel.setProperty("/busy", false);
        }
      },

      _invokeAction: async function (sActionName, mParameters = {}) {
        const oODataModel = this.getOwnerComponent().getModel();

        const oBinding = oODataModel.bindContext(`/${sActionName}(...)`);

        Object.entries(mParameters).forEach(([sParameter, vValue]) => {
          oBinding.setParameter(sParameter, vValue);
        });

        await oBinding.execute("$direct");

        return oBinding.getBoundContext()?.getObject() ?? {};
      },

      _loadWeek: async function () {
        const oViewModel = this.getView().getModel("view");

        this._stopReservationCountdown();

        const oODataModel = this.getOwnerComponent().getModel();

        oViewModel.setProperty("/busy", true);
        oViewModel.setProperty("/error", null);

        try {
          const oBinding = oODataModel.bindContext("/obtenerMiSemana(...)");

          await oBinding.execute("$direct");

          const oContext = oBinding.getBoundContext();

          const oResult = oContext?.getObject() ?? {};

          const aRawDays = Array.isArray(oResult)
            ? oResult
            : Array.isArray(oResult.value)
              ? oResult.value
              : [];

          if (aRawDays.length === 0) {
            throw new Error("El servicio no devolvió días para la semana.");
          }

          const aDays = aRawDays.map((oDay) => this._prepareDay(oDay));

          const iReservedCount = aDays.filter(
            (oDay) => oDay.estadoSeleccion === "RESERVADA",
          ).length;

          const oFirstDay = aDays[0];
          const oLastDay = aDays[aDays.length - 1];

          oViewModel.setProperty("/days", aDays);

          oViewModel.setProperty(
            "/weekLabel",
            this._buildWeekLabel(oFirstDay.fecha, oLastDay.fecha),
          );

          oViewModel.setProperty(
            "/deadlineLabel",
            this._buildDeadlineLabel(oFirstDay.fechaHoraCierre),
          );

          oViewModel.setProperty(
            "/selectedCount",
            Number(oFirstDay.diasSeleccionados),
          );

          oViewModel.setProperty(
            "/maxDays",
            Number(oFirstDay.maxDiasPermitidos),
          );

          oViewModel.setProperty("/reservedCount", iReservedCount);

          oViewModel.setProperty("/hasPendingReservations", iReservedCount > 0);

          oViewModel.setProperty(
            "/windowOpen",
            Boolean(oFirstDay.ventanaAbierta),
          );

          this._startReservationCountdown();
        } catch (oError) {
          this._stopReservationCountdown();

          oViewModel.setProperty("/reservationBannerText", "");

          const sMessage = this._extractErrorMessage(oError);

          oViewModel.setProperty("/error", sMessage);

          oViewModel.setProperty("/days", []);

          MessageBox.error(sMessage);
        } finally {
          oViewModel.setProperty("/busy", false);
        }
      },

      _prepareDay: function (oDay) {
        const iTotal = Number(oDay.cuposTotales) || 0;

        const iOccupied = Number(oDay.cuposOcupados) || 0;

        const bHasReservation =
          oDay.estadoSeleccion === "RESERVADA" && Boolean(oDay.reservaExpiraEn);

        const iRemainingSeconds = bHasReservation
          ? Math.max(
              Math.ceil(
                (new Date(oDay.reservaExpiraEn).getTime() - Date.now()) / 1000,
              ),
              0,
            )
          : 0;

        return {
          ...oDay,

          dateLabel: this._formatDayDate(oDay.fecha),

          occupationPercent:
            iTotal > 0 ? Math.round((iOccupied / iTotal) * 100) : 0,

          statusText: this._getStatusText(oDay),

          statusState: this._getStatusState(oDay),

          statusIcon: this._getStatusIcon(oDay),

          actionText: this._getActionText(oDay),

          actionType: this._getActionType(oDay),

          actionIcon: this._getActionIcon(oDay),

          actionVisible: Boolean(oDay.ventanaAbierta),

          reservationCountdownVisible: bHasReservation,

          reservationRemainingSeconds: iRemainingSeconds,

          reservationRemainingText:
            this._formatRemainingTime(iRemainingSeconds),

          reservationCountdownState: this._getCountdownState(iRemainingSeconds),
        };
      },

      _getStatusText: function (oDay) {
        if (oDay.estadoSeleccion === "CONFIRMADA") {
          return "Confirmado";
        }

        if (oDay.estadoSeleccion === "RESERVADA") {
          return "Reservado temporalmente";
        }

        if (oDay.bloqueadoSemanaAnterior) {
          return "Usado la semana anterior";
        }

        if (oDay.cupoCompleto) {
          return "Sin cupos";
        }

        if (!oDay.ventanaAbierta) {
          return "Ventana cerrada";
        }

        return "Disponible";
      },

      _getStatusState: function (oDay) {
        if (oDay.estadoSeleccion === "CONFIRMADA") {
          return "Success";
        }

        if (oDay.estadoSeleccion === "RESERVADA") {
          return "Warning";
        }

        if (oDay.cupoCompleto) {
          return "Error";
        }

        if (oDay.bloqueadoSemanaAnterior || !oDay.ventanaAbierta) {
          return "None";
        }

        return "Success";
      },

      _getStatusIcon: function (oDay) {
        if (oDay.estadoSeleccion === "CONFIRMADA") {
          return "sap-icon://accept";
        }

        if (oDay.estadoSeleccion === "RESERVADA") {
          return "sap-icon://pending";
        }

        if (oDay.cupoCompleto) {
          return "sap-icon://decline";
        }

        if (oDay.bloqueadoSemanaAnterior) {
          return "sap-icon://locked";
        }

        return "sap-icon://available";
      },

      _getActionText: function (oDay) {
        if (oDay.estadoSeleccion === "CONFIRMADA") {
          return "Cancelar día";
        }

        if (oDay.estadoSeleccion === "RESERVADA") {
          return "Liberar reserva";
        }

        if (!oDay.habilitado) {
          return "No disponible";
        }

        return "Seleccionar";
      },

      _getActionType: function (oDay) {
        if (oDay.estadoSeleccion === "CONFIRMADA") {
          return "Reject";
        }

        if (oDay.estadoSeleccion === "RESERVADA") {
          return "Attention";
        }

        if (!oDay.habilitado) {
          return "Transparent";
        }

        return "Emphasized";
      },

      _getActionIcon: function (oDay) {
        if (oDay.estadoSeleccion === "CONFIRMADA") {
          return "sap-icon://decline";
        }

        if (oDay.estadoSeleccion === "RESERVADA") {
          return "sap-icon://undo";
        }

        if (!oDay.habilitado) {
          return "sap-icon://locked";
        }

        return "sap-icon://add";
      },

      _startReservationCountdown: function () {
        this._stopReservationCountdown();

        const oViewModel = this.getView().getModel("view");
        const aDays = oViewModel.getProperty("/days") || [];

        const bHasReservations = aDays.some(
          (oDay) =>
            oDay.estadoSeleccion === "RESERVADA" &&
            Boolean(oDay.reservaExpiraEn),
        );

        if (!bHasReservations) {
          oViewModel.setProperty("/reservationBannerText", "");
          return;
        }

        const fnTick = () => {
          const aCurrentDays = oViewModel.getProperty("/days") || [];

          let iNearestRemaining = Number.POSITIVE_INFINITY;
          let bReservationExpired = false;

          aCurrentDays.forEach((oDay, iIndex) => {
            if (oDay.estadoSeleccion !== "RESERVADA" || !oDay.reservaExpiraEn) {
              return;
            }

            const iRemainingSeconds = Math.max(
              Math.ceil(
                (new Date(oDay.reservaExpiraEn).getTime() - Date.now()) / 1000,
              ),
              0,
            );

            oViewModel.setProperty(
              `/days/${iIndex}/reservationRemainingSeconds`,
              iRemainingSeconds,
            );

            oViewModel.setProperty(
              `/days/${iIndex}/reservationRemainingText`,
              this._formatRemainingTime(iRemainingSeconds),
            );

            oViewModel.setProperty(
              `/days/${iIndex}/reservationCountdownState`,
              this._getCountdownState(iRemainingSeconds),
            );

            if (iRemainingSeconds > 0) {
              iNearestRemaining = Math.min(
                iNearestRemaining,
                iRemainingSeconds,
              );
            } else {
              bReservationExpired = true;
            }
          });

          if (Number.isFinite(iNearestRemaining)) {
            const iReservedCount =
              Number(oViewModel.getProperty("/reservedCount")) || 0;

            const sRemaining = this._formatRemainingTime(iNearestRemaining);

            const sMessage =
              iReservedCount === 1
                ? `Tu reserva vence en ${sRemaining}. Confírmala antes de que se libere el cupo.`
                : `La reserva más próxima vence en ${sRemaining}. Confirma tus días antes de que se liberen los cupos.`;

            oViewModel.setProperty("/reservationBannerText", sMessage);
          }

          if (bReservationExpired && !this._refreshingAfterExpiry) {
            this._refreshingAfterExpiry = true;

            this._stopReservationCountdown();

            MessageToast.show(
              "Una reserva temporal venció y el cupo fue liberado.",
            );

            this._loadWeek().finally(() => {
              this._refreshingAfterExpiry = false;
            });
          }
        };

        this._reservationTimer = window.setInterval(fnTick, 1000);

        fnTick();
      },

      _stopReservationCountdown: function () {
        if (this._reservationTimer) {
          window.clearInterval(this._reservationTimer);
          this._reservationTimer = null;
        }
      },

      _formatRemainingTime: function (iSeconds) {
        const iSafeSeconds = Math.max(Number(iSeconds) || 0, 0);

        const iMinutes = Math.floor(iSafeSeconds / 60);
        const iRemainingSeconds = iSafeSeconds % 60;

        return (
          `${String(iMinutes).padStart(2, "0")}:` +
          `${String(iRemainingSeconds).padStart(2, "0")}`
        );
      },

      _getCountdownState: function (iSeconds) {
        if (iSeconds <= 60) {
          return "Error";
        }

        if (iSeconds <= 120) {
          return "Warning";
        }

        return "Information";
      },

      _formatDayDate: function (sDate) {
        const oDate = new Date(`${sDate}T00:00:00.000Z`);

        return new Intl.DateTimeFormat("es-CO", {
          day: "numeric",
          month: "long",
          timeZone: "UTC",
        }).format(oDate);
      },

      _buildWeekLabel: function (sStartDate, sEndDate) {
        const oStart = new Date(`${sStartDate}T00:00:00.000Z`);

        const oEnd = new Date(`${sEndDate}T00:00:00.000Z`);

        const oDayFormatter = new Intl.DateTimeFormat("es-CO", {
          day: "numeric",
          month: "long",
          timeZone: "UTC",
        });

        const oYearFormatter = new Intl.DateTimeFormat("es-CO", {
          year: "numeric",
          timeZone: "UTC",
        });

        return (
          `Semana del ` +
          `${oDayFormatter.format(oStart)} ` +
          `al ${oDayFormatter.format(oEnd)} ` +
          `de ${oYearFormatter.format(oEnd)}`
        );
      },

      _buildDeadlineLabel: function (sDeadline) {
        if (!sDeadline) {
          return "";
        }

        const oDate = new Date(sDeadline);

        const sFormatted = new Intl.DateTimeFormat("es-CO", {
          weekday: "long",
          day: "numeric",
          month: "long",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: "America/Bogota",
        }).format(oDate);

        return `Puedes modificar tu selección ` + `hasta el ${sFormatted}.`;
      },

      _extractErrorMessage: function (oError) {
        if (!oError) {
          return "No fue posible consultar " + "la semana de Home Office.";
        }

        const sResponseText = oError.cause?.responseText || oError.responseText;

        if (sResponseText) {
          try {
            const oResponse = JSON.parse(sResponseText);

            return oResponse?.error?.message || oError.message;
          } catch (oParseError) {
            // Continúa con el mensaje estándar.
          }
        }

        return (
          oError.message || "No fue posible consultar la semana de Home Office."
        );
      },
      onExit: function () {
        this._stopReservationCountdown();
      },
    });
  },
);
