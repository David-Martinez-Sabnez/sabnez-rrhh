sap.ui.define([
  "sabnez/com/tiemposadminui/controller/BaseController",
], function (BaseController) {
  "use strict";

  function hoy() {
    return new Date().toISOString().slice(0, 10);
  }

  return BaseController.extend("sabnez.com.tiemposadminui.controller.ProjectDetail", {
    onInit: function () {
      this.getRouter().getRoute("projectDetail").attachPatternMatched(this._onMatched, this);
      // Al entrar por URL directa los datos aún no están; el modelo
      // avisa cuando llegan.
      this.getViewModel().attachEvent("dataLoaded", this._bind, this);
    },

    _onMatched: function (event) {
      this._projectId = event.getParameter("arguments").projectId;
      this._bind();
    },


    _bind: function () {
      var data = this.getData();
      var proyecto = data.project(this._projectId);
      if (!proyecto) return;
      this.set("/current", proyecto);
      this.set("/currentAssignments", this._conCuota(data.byProject("/assignments", this._projectId), proyecto));
      this.set("/currentApprovers", data.byProject("/approvers", this._projectId));
      this.set("/currentRates", data.ratesOfProject(this._projectId));
      this.set("/currentMissingRates", data.byProject("/missingRates", this._projectId));
      this.set("/currentBillingRules", data.billingRulesOfProject(this._projectId));
      this.set("/currentCycles", data.byProject("/cycles", this._projectId).filter(function (cycle) {
        return cycle.active !== false;
      }));
    },

    // ---------------- facturabilidad ----------------

    // Completa la matriz con lo que corresponda a la modalidad. Sólo
    // agrega lo que falte: una regla que alguien ya corrigió a mano no
    // se toca, porque probablemente refleja lo que dice el contrato.
    onSeedRules: async function () {
      var p = this.get("/current");
      try {
        var res = await this.getData().action("sembrarReglasFacturacion", {
          proyectoID: p.ID,
        });
        this.toast(res && res.mensaje ? res.mensaje : "Reglas completadas.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    onEditRule: function (event) {
      var regla = this.rowOf(event);
      if (!regla) return;
      this.set("/ruleForm", {
        ID: regla.ID,
        requestedType: regla.requestedType,
        treatment: regla.treatment,
        billableFactor: regla.billableFactor == null ? 1 : Number(regla.billableFactor),
        payableToEmployee: regla.payableToEmployee !== false,
        notes: regla.notes || "",
      });
      return this.openDialog("BillingRuleDialog");
    },

    // Un tratamiento que no se factura no tiene factor que multiplicar.
    // Dejarlo en otro valor sólo sirve para confundir al siguiente que lo lea.
    onRuleTreatmentChange: function () {
      if (this.get("/ruleForm/treatment") === "NON_BILLABLE") {
        this.set("/ruleForm/billableFactor", 0);
      } else if (!Number(this.get("/ruleForm/billableFactor"))) {
        this.set("/ruleForm/billableFactor", 1);
      }
    },

    onRuleCancel: function () {
      this.closeDialog("BillingRuleDialog");
    },

    onRuleSave: async function () {
      var form = this.get("/ruleForm");
      var factor = Number(form.billableFactor);
      if (!isFinite(factor) || factor < 0) {
        return this.fail(new Error("El factor debe ser un número positivo."));
      }
      try {
        await this.getData().save("ReglasFacturacion", form.ID, {
          treatment: form.treatment,
          billableFactor: form.treatment === "NON_BILLABLE" ? 0 : factor,
          payableToEmployee: Boolean(form.payableToEmployee),
          notes: form.notes || null,
        });
        this.closeDialog("BillingRuleDialog");
        this.toast("Regla actualizada. Aplica a los registros que se guarden desde ahora.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    // Vista previa del reparto del umbral entre el equipo. La cifra que
    // manda es la que calcula srv/lib/billing-targets.js; esto sólo sirve
    // para ver el efecto al configurar, con la misma regla: proporcional
    // a la dedicación, o a partes iguales si nadie la tiene puesta.
    _conCuota: function (asignaciones, proyecto) {
      var umbral = Number(proyecto && proyecto.monthlyBillableTarget) || 0;
      var activas = (asignaciones || []).filter(function (a) { return a.status !== "INACTIVE"; });
      var suma = activas.reduce(function (acc, a) { return acc + (Number(a.commercialAllocation) || 0); }, 0);
      return (asignaciones || []).map(function (a) {
        var cuota = null;
        if (umbral > 0 && a.status !== "INACTIVE" && activas.length) {
          var parte = suma > 0 ? (Number(a.commercialAllocation) || 0) / suma : 1 / activas.length;
          cuota = Math.round(umbral * parte * 100) / 100;
        }
        return Object.assign({}, a, { targetHours: cuota });
      });
    },

    onCloseDetail: function () {
      this.getRouter().navTo("projects");
    },

    onOpenClient: function () {
      var proyecto = this.get("/current");
      if (proyecto) this.getRouter().navTo("clientDetail", { clientId: proyecto.client_ID });
    },

    // ---------------- proyecto ----------------

    onEdit: async function () {
      var p = this.get("/current");
      if (p.status === "CLOSED") return this.fail(new Error("El proyecto está cerrado. Reábrelo antes de editarlo."));
      this.set("/projectForm", {
        ID: p.ID, clientID: p.client_ID, contractID: p.contract_ID || "",
        code: p.code, name: p.name, description: p.description || "",
        validFrom: p.validFrom, validTo: p.validTo || "", modality: p.modality,
        currency: p.currency, timeZone: p.timeZone,
        workCalendarID: p.workCalendar_ID || "",
        requiresDescription: p.requiresDescription, requiresEvidence: p.requiresEvidence,
        requiresClientApproval: p.requiresClientApproval, approvalScheme: p.approvalScheme,
        dailyWarningHours: p.dailyWarningHours,
        timeEntryCutoffDay: p.timeEntryCutoffDay || 31,
        monthlyBillableTarget: p.monthlyBillableTarget || 0, status: p.status,
      });
      this.set("/contractsForProject", this.getData().contractsOfClient(p.client_ID));
      await this.openDialog("ProjectDialog");
    },

    onDialogClientChange: function () {
      this.set("/projectForm/contractID", "");
      var clientID = this.get("/projectForm/clientID");
      this.set("/contractsForProject", this.getData().contractsOfClient(clientID));
    },

    onDialogModalityChange: function () {
      if (this.get("/projectForm/modality") !== "INTERNAL") return;
      this.set("/projectForm/contractID", "");
      this.set("/projectForm/requiresClientApproval", false);
      this.set("/projectForm/monthlyBillableTarget", 0);
    },

    onDialogCancel: function () {
      this.closeDialog("ProjectDialog");
    },

    onDialogSave: async function () {
      var form = this.get("/projectForm");
      if (!form.clientID || !form.name || !form.validFrom || !form.workCalendarID) {
        return this.fail(new Error("Completa cliente, nombre, fecha de inicio y calendario laboral."));
      }
      try {
        await this.getData().save("Proyectos", form.ID, {
          client_ID: form.clientID,
          contract_ID: form.modality === "INTERNAL" ? null : (form.contractID || null),
          name: form.name, description: form.description || null,
          validFrom: form.validFrom,
          modality: form.modality, currency: form.currency, timeZone: form.timeZone,
          workCalendar_ID: form.workCalendarID,
          requiresDescription: Boolean(form.requiresDescription),
          requiresEvidence: Boolean(form.requiresEvidence),
          requiresClientApproval: form.modality === "INTERNAL" ? false : Boolean(form.requiresClientApproval),
          approvalScheme: form.approvalScheme,
          dailyWarningHours: Number(form.dailyWarningHours) || 16,
          timeEntryCutoffDay: Number(form.timeEntryCutoffDay) || 31,
          monthlyBillableTarget: form.modality === "INTERNAL" ? null : (Number(form.monthlyBillableTarget) || null),
        });
        this.closeDialog("ProjectDialog");
        this.toast("Proyecto actualizado.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    // Cerrar arrastra asignaciones y aprobadores. El usuario debe saberlo
    // antes de confirmar, no descubrirlo después.
    onClose: async function () {
      var p = this.get("/current");
      var equipo = (this.get("/currentAssignments") || []).filter(function (row) {
        return row.status === "ACTIVE";
      }).length;
      var aprobadores = (this.get("/currentApprovers") || []).filter(function (row) {
        return row.active;
      }).length;
      var fecha = await this.askDate({
        title: "Cerrar proyecto",
        label: "Fecha de cierre",
        acceptText: "Cerrar proyecto",
        message: "Se cerrará «" + p.name + "» junto con " + equipo
          + " asignación(es), " + aprobadores + " aprobador(es) y sus tarifas activas.",
      });
      if (!fecha) return;
      try {
        var res = await this.getData().action("cerrarProyecto", {
          proyectoID: p.ID, fechaCierre: fecha,
        });
        this.toast(res && res.mensaje ? res.mensaje : "Proyecto cerrado.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    onReopen: async function () {
      var p = this.get("/current");
      var fecha = await this.askDate({
        title: "Reabrir proyecto",
        label: "Fecha de apertura",
        acceptText: "Reabrir",
        message: "«" + p.name + "» volverá a estar activo desde la fecha indicada. Los registros históricos no se reabren.",
      });
      if (!fecha) return;
      try {
        var res = await this.getData().action("reabrirProyecto", { proyectoID: p.ID, fechaApertura: fecha });
        this.toast(res && res.mensaje ? res.mensaje : "Proyecto reabierto.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    // ---------------- equipo ----------------

    onAddAssignment: async function () {
      var ciclos = this.get("/currentCycles") || [];
      this.set("/assignmentForm", {
        ID: null, projectID: this._projectId, employeeID: "", role: "",
        reportingCycleID: ciclos.length === 1 ? ciclos[0].ID : "",
        validFrom: this.get("/current/lastReopenedOn") || this.get("/current/validFrom") || hoy(), validTo: "",
        commercialAllocation: 100, isPrimary: true, status: "ACTIVE",
      });
      await this.openDialog("AssignmentDialog");
    },

    onEditAssignment: async function (event) {
      var row = this.rowOf(event);
      if (row.status !== "ACTIVE") return this.fail(new Error("Una asignación cerrada no se puede editar."));
      this.set("/assignmentForm", {
        ID: row.ID, projectID: row.project_ID, employeeID: row.employee_ID,
        reportingCycleID: row.reportingCycle_ID || "",
        role: row.role || "", validFrom: row.validFrom, validTo: row.validTo || "",
        commercialAllocation: row.commercialAllocation || 0,
        isPrimary: row.isPrimary, status: row.status,
      });
      await this.openDialog("AssignmentDialog");
    },

    onAssignmentCancel: function () {
      this.closeDialog("AssignmentDialog");
    },

    onAssignmentSave: async function () {
      var form = this.get("/assignmentForm");
      if (!form.employeeID || !form.validFrom) {
        return this.fail(new Error("Elige la persona y la fecha de inicio."));
      }
      try {
        await this.getData().save("Asignaciones", form.ID, {
          project_ID: form.projectID, employee_ID: form.employeeID,
          reportingCycle_ID: this.get("/current/modality") === "INTERNAL" ? null : (form.reportingCycleID || null),
          role: form.role || null, validFrom: form.validFrom,
          commercialAllocation: Number(form.commercialAllocation) || 0,
          isPrimary: Boolean(form.isPrimary),
        });
        this.closeDialog("AssignmentDialog");
        this.toast(form.ID ? "Asignación actualizada." : "Persona asignada.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    onFinishAssignment: async function (event) {
      var row = this.rowOf(event);
      var fecha = await this.askDate({
        title: "Finalizar asignación",
        label: "Fecha final",
        acceptText: "Finalizar",
        message: "Indica el último día de la asignación de " + row.employeeName + ". Si hay tiempo posterior, el cierre será rechazado.",
      });
      if (!fecha) return;
      try {
        var res = await this.getData().action("finalizarAsignacion", {
          asignacionID: row.ID, fechaFin: fecha,
        });
        this.toast(res && res.mensaje ? res.mensaje : "Asignación finalizada.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    onReactivateAssignment: async function (event) {
      var row = this.rowOf(event);
      var fecha = await this.askDate({
        title: "Reactivar asignación",
        label: "Nueva fecha de inicio",
        acceptText: "Reactivar",
        message: "Se creará una nueva vigencia para " + row.employeeName + ". La asignación anterior permanecerá cerrada como histórico.",
      });
      if (!fecha) return;
      try {
        var res = await this.getData().action("reactivarAsignacion", {
          asignacionID: row.ID, fechaApertura: fecha,
        });
        this.toast(res && res.mensaje ? res.mensaje : "Asignación reactivada.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    // ---------------- aprobadores ----------------

    onAddApprover: async function () {
      this.set("/approverForm", {
        ID: null, projectID: this._projectId, employeeID: "", approverType: "ADMIN",
        validFrom: this.get("/current/lastReopenedOn") || hoy(), validTo: "", active: true,
      });
      await this.openDialog("ApproverDialog");
    },

    onEditApprover: async function (event) {
      var row = this.rowOf(event);
      if (!row.active) return this.fail(new Error("Un aprobador cerrado no se puede editar."));
      this.set("/approverForm", {
        ID: row.ID, projectID: row.project_ID, employeeID: row.employee_ID,
        approverType: row.approverType, validFrom: row.validFrom,
        validTo: row.validTo || "", active: row.active,
      });
      await this.openDialog("ApproverDialog");
    },

    onApproverCancel: function () {
      this.closeDialog("ApproverDialog");
    },

    onApproverSave: async function () {
      var form = this.get("/approverForm");
      if (!form.employeeID || !form.validFrom) {
        return this.fail(new Error("Elige el responsable y la fecha de inicio."));
      }
      try {
        await this.getData().save("Aprobadores", form.ID, {
          project_ID: form.projectID, employee_ID: form.employeeID,
          approverType: form.approverType, validFrom: form.validFrom,
        });
        this.closeDialog("ApproverDialog");
        this.toast(form.ID ? "Aprobador actualizado." : "Aprobador añadido.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    onFinishApprover: async function (event) {
      var row = this.rowOf(event);
      var fecha = await this.askDate({
        title: "Cerrar aprobador", label: "Fecha final", acceptText: "Cerrar",
        message: "Indica el último día en que " + row.employeeName + " actuará como aprobador.",
      });
      if (!fecha) return;
      try {
        var res = await this.getData().action("finalizarAprobador", { aprobadorID: row.ID, fechaFin: fecha });
        this.toast(res && res.mensaje ? res.mensaje : "Aprobador cerrado.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    // ---------------- tarifas ----------------

    onAddRate: async function () {
      this.set("/rateForm", {
        ID: null, assignmentID: "", validFrom: "", validTo: "",
        saleCurrency: this.get("/current/currency") || "COP",
        costCurrency: "COP",
        monthlySaleRate: "", regularSaleHourlyRate: "", overtimeSaleHourlyRate: "",
        internalMonthlyCost: "", internalHourlyCost: "",
      });
      this.set("/assignmentsForRate", (this.get("/currentAssignments") || []).map(function (row) {
        return Object.assign({}, row, {
          assignmentLabel: row.employeeName + " · " + row.validFrom + " — " + (row.validTo || "vigente"),
        });
      }));
      await this.openDialog("RateDialog");
    },

    onRateAssignmentChange: function () {
      var assignmentID = this.get("/rateForm/assignmentID");
      var assignment = (this.get("/assignmentsForRate") || []).find(function (row) {
        return row.ID === assignmentID;
      });
      if (assignment) this.set("/rateForm/validFrom", assignment.validFrom);
    },

    onEditRate: async function (event) {
      var row = this.rowOf(event);
      if (row.validTo) return this.fail(new Error("Una tarifa cerrada no se puede editar."));
      this.set("/rateForm", {
        ID: row.ID, assignmentID: row.assignment_ID, validFrom: row.validFrom,
        validTo: row.validTo || "",
        saleCurrency: row.saleCurrency || row.currency || "COP",
        costCurrency: row.costCurrency || row.currency || "COP",
        monthlySaleRate: row.monthlySaleRate, regularSaleHourlyRate: row.regularSaleHourlyRate,
        overtimeSaleHourlyRate: row.overtimeSaleHourlyRate,
        internalMonthlyCost: row.internalMonthlyCost, internalHourlyCost: row.internalHourlyCost,
      });
      this.set("/assignmentsForRate", (this.get("/currentAssignments") || []).filter(function (item) {
        return item.status === "ACTIVE" || item.ID === row.assignment_ID;
      }).map(function (item) {
        return Object.assign({}, item, {
          assignmentLabel: item.employeeName + " · " + item.validFrom + " — " + (item.validTo || "vigente"),
        });
      }));
      await this.openDialog("RateDialog");
    },

    onRateCancel: function () {
      this.closeDialog("RateDialog");
    },

    onRateSave: async function () {
      var form = this.get("/rateForm");
      var internalProject = this.get("/current/modality") === "INTERNAL";
      if (!form.assignmentID || !form.validFrom || !form.costCurrency || (!internalProject && !form.saleCurrency)) {
        return this.fail(new Error(internalProject
          ? "Elige la asignación, la fecha de inicio y la moneda de costo."
          : "Elige la asignación, la fecha de inicio y las monedas de venta y costo."));
      }
      var num = function (value) {
        return value === "" || value === null || value === undefined ? null : Number(value);
      };
      try {
        await this.getData().save("Tarifas", form.ID, {
          assignment_ID: form.assignmentID, validFrom: form.validFrom,
          // Campo legado: sigue la moneda de venta para consumidores antiguos.
          currency: internalProject ? form.costCurrency : form.saleCurrency,
          saleCurrency: internalProject ? form.costCurrency : form.saleCurrency,
          costCurrency: form.costCurrency,
          monthlySaleRate: internalProject ? null : num(form.monthlySaleRate),
          regularSaleHourlyRate: internalProject ? null : num(form.regularSaleHourlyRate),
          overtimeSaleHourlyRate: internalProject ? null : num(form.overtimeSaleHourlyRate),
          internalMonthlyCost: num(form.internalMonthlyCost),
          internalHourlyCost: num(form.internalHourlyCost),
        });
        this.closeDialog("RateDialog");
        this.toast(form.ID ? "Tarifa actualizada." : "Tarifa creada.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    onFinishRate: async function (event) {
      var row = this.rowOf(event);
      var fecha = await this.askDate({
        title: "Cerrar tarifa", label: "Fecha final", acceptText: "Cerrar",
        message: "Indica el último día de esta tarifa de " + row.employeeName + ". El histórico no se eliminará.",
      });
      if (!fecha) return;
      try {
        var res = await this.getData().action("finalizarTarifa", { tarifaID: row.ID, fechaFin: fecha });
        this.toast(res && res.mensaje ? res.mensaje : "Tarifa cerrada.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },
  });
});
