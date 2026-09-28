sap.ui.define(
  [
    "sap/ui/core/Fragment",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/Component",
  ],
  function (Fragment, JSONModel, MessageToast, MessageBox, Component) {
    "use strict";

    let oDialog;
    let oHistoryDialog;
    let oODataModel;

    function bogotaNextWeek() {
      const aParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Bogota",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());
      const mParts = Object.fromEntries(
        aParts.filter((oPart) => oPart.type !== "literal")
          .map((oPart) => [oPart.type, oPart.value]),
      );
      return new Date(
        Number(mParts.year),
        Number(mParts.month) - 1,
        Number(mParts.day) + 7,
      );
    }

    function formatDate(oDate) {
      return [
        oDate.getFullYear(),
        String(oDate.getMonth() + 1).padStart(2, "0"),
        String(oDate.getDate()).padStart(2, "0"),
      ].join("-");
    }

    function getApplicationModel() {
      const aComponents = Object.values(Component.registry.all());
      const oApplication = aComponents.find((oComponent) => {
        try {
          return oComponent.getManifestEntry("sap.app")?.id ===
            "sabnez.com.homeofficeadminui";
        } catch (oError) {
          return false;
        }
      });
      const oModel = oApplication?.getModel();
      if (!oModel) {
        throw new Error("No fue posible obtener el modelo de Home Office.");
      }
      return oModel;
    }

    const Actions = {
      onConfigurarCupos: async function () {
        oODataModel = getApplicationModel();
        if (!oDialog) {
          oDialog = await Fragment.load({
            name: "sabnez.com.homeofficeadminui.ext.fragment.QuotaDialog",
            controller: Actions,
          });
          oDialog.setModel(oODataModel);
        }
        oDialog.setModel(new JSONModel({
          scope: "VIGENCIA",
          date: bogotaNextWeek(),
          maxDays: 2,
          dailyCapacity: 5,
          mondayCapacity: 5,
          tuesdayCapacity: 5,
          wednesdayCapacity: 5,
          thursdayCapacity: 5,
          fridayCapacity: 5,
          reason: "",
          ongoing: true,
          busy: false,
        }), "cupos");
        oDialog.open();
      },

      onVerHistorial: async function () {
        oODataModel = getApplicationModel();
        if (!oHistoryDialog) {
          oHistoryDialog = await Fragment.load({
            name: "sabnez.com.homeofficeadminui.ext.fragment.QuotaHistoryDialog",
            controller: Actions,
          });
          oHistoryDialog.setModel(oODataModel);
        }
        oODataModel.refresh();
        oHistoryDialog.open();
      },

      onQuotaScopeChange: function (oEvent) {
        const sScope = oEvent.getSource().getSelectedKey();
        const oModel = oDialog.getModel("cupos");
        oModel.setProperty("/scope", sScope);
        oModel.setProperty("/ongoing", sScope === "VIGENCIA");
      },

      onSaveQuotas: async function () {
        const oData = oDialog.getModel("cupos");
        const oValues = oData.getData();
        if (!oValues.date || !String(oValues.reason || "").trim()) {
          MessageBox.warning("Indica la fecha y el motivo del cambio.");
          return;
        }

        oData.setProperty("/busy", true);
        try {
          const oOperation = oODataModel.bindContext("/configurarCupos(...)");
          oOperation.setParameter("alcance", oValues.scope);
          oOperation.setParameter("fecha", formatDate(oValues.date));
          oOperation.setParameter(
            "maxDiasPorSemana",
            oValues.scope === "VIGENCIA" ? Number(oValues.maxDays) : 0,
          );
          oOperation.setParameter("cuposPorDia", Number(oValues.dailyCapacity));
          oOperation.setParameter("cuposLunes", Number(oValues.mondayCapacity));
          oOperation.setParameter("cuposMartes", Number(oValues.tuesdayCapacity));
          oOperation.setParameter("cuposMiercoles", Number(oValues.wednesdayCapacity));
          oOperation.setParameter("cuposJueves", Number(oValues.thursdayCapacity));
          oOperation.setParameter("cuposViernes", Number(oValues.fridayCapacity));
          oOperation.setParameter("motivo", String(oValues.reason).trim());
          await oOperation.execute();
          const oResult = oOperation.getBoundContext()?.getObject();
          oDialog.close();
          MessageToast.show(oResult?.mensaje || "Los cupos quedaron actualizados.");
          oODataModel.refresh();
        } catch (oError) {
          MessageBox.error(oError?.message || "No fue posible guardar los cupos.");
        } finally {
          oData.setProperty("/busy", false);
        }
      },

      onCancelQuotas: function () {
        oDialog.close();
      },

      onCloseHistory: function () {
        oHistoryDialog.close();
      },

      formatScope: function (sScope) {
        return sScope === "DIA" ? "Día específico" : "Desde una fecha";
      },

      formatHistoryDate: function (vDate) {
        if (!vDate) {
          return "—";
        }
        return new Intl.DateTimeFormat("es-CO", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "America/Bogota",
        }).format(new Date(vDate));
      },

      formatCalendarDate: function (vDate) {
        if (!vDate) {
          return "—";
        }
        return new Intl.DateTimeFormat("es-CO", {
          dateStyle: "medium",
          timeZone: "UTC",
        }).format(new Date(`${String(vDate).slice(0, 10)}T00:00:00Z`));
      },

      formatEffectiveDate: function (sScope, vEffectiveFrom, vDate) {
        return Actions.formatCalendarDate(
          sScope === "DIA" ? vDate : vEffectiveFrom,
        );
      },

      formatChange: function (vPrevious, vNew) {
        const sPrevious = vPrevious === null || vPrevious === undefined
          ? "Sin valor"
          : String(vPrevious);
        const sNew = vNew === null || vNew === undefined ? "—" : String(vNew);
        return `${sPrevious} → ${sNew}`;
      },
    };

    return Actions;
  },
);
