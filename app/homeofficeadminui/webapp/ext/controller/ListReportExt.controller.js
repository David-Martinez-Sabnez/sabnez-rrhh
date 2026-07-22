sap.ui.define(
  ["sap/ui/core/mvc/ControllerExtension", "sap/base/Log"],
  function (ControllerExtension, Log) {
    "use strict";

    return ControllerExtension.extend(
      "sabnez.com.homeofficeadminui.ext.controller.ListReportExt",
      {
        override: {
          onInit: function () {
            const oExtensionAPI = this.base.getExtensionAPI();

            this._applyDefaultPeriod(oExtensionAPI);
          },
        },

        /**
         * Establece como valores iniciales el año ISO
         * y la semana ISO siguiente.
         *
         * @param {sap.fe.templates.ListReport.ExtensionAPI}
         *   oExtensionAPI API pública del List Report.
         */
        _applyDefaultPeriod: async function (oExtensionAPI) {
          try {
            const oPeriod = this._getNextIsoWeek();

            /*
             * El año está expuesto en OData como String(4).
             */
            await oExtensionAPI.setFilterValues(
              "anio",
              "EQ",
              String(oPeriod.year),
            );

            /*
             * numeroSemana es Integer y permite
             * selección múltiple. Inicialmente se
             * establece solamente la semana siguiente.
             */
            await oExtensionAPI.setFilterValues(
              "numeroSemana",
              "EQ",
              oPeriod.week,
            );

            /*
             * Descomenta esta línea para ejecutar
             * automáticamente la consulta sin presionar Ir.
             */
            // await oExtensionAPI.refresh();
          } catch (oError) {
            Log.error(
              "No fue posible establecer el periodo " +
                "predeterminado del reporte Home Office.",
              oError?.message || String(oError),
              "sabnez.com.homeofficeadminui",
            );
          }
        },

        /**
         * Calcula el año y la semana ISO correspondientes
         * a siete días después de la fecha actual en Bogotá.
         */
        _getNextIsoWeek: function () {
          const oToday = this._getBogotaCurrentDate();

          const oNextWeekDate = new Date(oToday);

          oNextWeekDate.setUTCDate(oNextWeekDate.getUTCDate() + 7);

          return this._getIsoYearWeek(oNextWeekDate);
        },

        /**
         * Devuelve la fecha calendario actual de Bogotá
         * representada internamente en UTC para evitar
         * desplazamientos por zona horaria.
         */
        _getBogotaCurrentDate: function () {
          const aParts = new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Bogota",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).formatToParts(new Date());

          const mParts = {};

          aParts.forEach((oPart) => {
            if (oPart.type !== "literal") {
              mParts[oPart.type] = oPart.value;
            }
          });

          return new Date(
            Date.UTC(
              Number(mParts.year),
              Number(mParts.month) - 1,
              Number(mParts.day),
            ),
          );
        },

        /**
         * Obtiene el año ISO y el número de semana ISO.
         * También maneja correctamente el cambio de año.
         */
        _getIsoYearWeek: function (oDate) {
          const oThursday = new Date(
            Date.UTC(
              oDate.getUTCFullYear(),
              oDate.getUTCMonth(),
              oDate.getUTCDate(),
            ),
          );

          const iDay = oThursday.getUTCDay() || 7;

          /*
           * El año ISO se determina por el jueves
           * perteneciente a la semana.
           */
          oThursday.setUTCDate(oThursday.getUTCDate() + 4 - iDay);

          const iIsoYear = oThursday.getUTCFullYear();

          const oYearStart = new Date(Date.UTC(iIsoYear, 0, 1));

          const iIsoWeek = Math.ceil(
            ((oThursday - oYearStart) / 86400000 + 1) / 7,
          );

          return {
            year: iIsoYear,
            week: iIsoWeek,
          };
        },
      },
    );
  },
);
