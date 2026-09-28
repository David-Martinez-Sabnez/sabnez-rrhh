sap.ui.define([
  "sabnez/com/tiemposadminui/controller/BaseController",
], function (BaseController) {
  "use strict";

  function hoy() {
    return new Date().toISOString().slice(0, 10);
  }

  return BaseController.extend("sabnez.com.tiemposadminui.controller.ClientDetail", {
    onInit: function () {
      this.getRouter().getRoute("clientDetail").attachPatternMatched(this._onMatched, this);
      // Al entrar por URL directa los datos aún no están; el modelo
      // avisa cuando llegan.
      this.getViewModel().attachEvent("dataLoaded", this._bind, this);
    },

    _onMatched: function (event) {
      this._clientId = event.getParameter("arguments").clientId;
      this._bind();
    },


    _bind: function () {
      var data = this.getData();
      var cliente = data.client(this._clientId);
      if (!cliente) return;
      this.set("/currentClient", cliente);
      this.set("/currentProjects", data.projectsOfClient(this._clientId));
      this.set("/currentContracts", data.contractsOfClient(this._clientId));
    },

    onCloseDetail: function () {
      this.getRouter().navTo("clients");
    },

    onOpenProject: function (event) {
      var row = this.rowOf(event.getParameter("listItem"));
      if (row) this.getRouter().navTo("projectDetail", { projectId: row.ID });
    },

    // ---------------- cliente ----------------

    onEdit: async function () {
      var c = this.get("/currentClient");
      if (c.status === "INACTIVE") return this.fail(new Error("El cliente está inactivo. Reactívalo antes de editarlo."));
      this.set("/clientForm", {
        ID: c.ID, legalName: c.legalName, tradeName: c.tradeName || "",
        projectCodePrefix: c.projectCodePrefix || "",
        projectCodePrefixLocked: Boolean(c.projectCodePrefix && (this.get("/currentProjects") || []).length),
        taxIdentification: c.taxIdentification, countryCode: c.countryCode,
        defaultCurrency: c.defaultCurrency, timeZone: c.timeZone,
        taxExempt: c.taxExempt,
        paymentTermDays: c.paymentTermDays == null ? 30 : c.paymentTermDays,
        status: c.status,
      });
      await this.openDialog("ClientDialog");
    },

    onClientCancel: function () {
      this.closeDialog("ClientDialog");
    },

    onClientSave: async function () {
      var form = this.get("/clientForm");
      if (!form.legalName || !form.taxIdentification || !/^[A-Za-z]{3}$/.test(form.projectCodePrefix || "")) {
        return this.fail(new Error("Completa la razón social, la identificación tributaria y un prefijo de tres letras."));
      }
      try {
        await this.getData().save("Clientes", form.ID, {
          legalName: form.legalName, tradeName: form.tradeName || form.legalName,
          projectCodePrefix: form.projectCodePrefix.toUpperCase(),
          taxIdentification: form.taxIdentification, countryCode: form.countryCode,
          defaultCurrency: form.defaultCurrency, timeZone: form.timeZone,
          taxExempt: Boolean(form.taxExempt),
          paymentTermDays: form.paymentTermDays === "" || form.paymentTermDays == null
            ? null
            : Number(form.paymentTermDays),
        });
        this.closeDialog("ClientDialog");
        this.toast("Cliente actualizado.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    onDeactivate: async function () {
      var c = this.get("/currentClient");
      var contratos = (this.get("/currentContracts") || []).filter(function (row) {
        return row.status === "ACTIVE" || row.status === "DRAFT";
      }).length;
      var ok = await this.confirm(
        "Se desactivará «" + (c.tradeName || c.legalName) + "»"
          + (contratos ? " y sus " + contratos + " contrato(s) vigente(s)." : ".")
          + " Si le quedan proyectos abiertos, la operación se rechazará: ciérralos primero.",
        "Desactivar cliente",
        "Desactivar",
      );
      if (!ok) return;
      try {
        var res = await this.getData().action("desactivarCliente", { clienteID: c.ID });
        this.toast(res && res.mensaje ? res.mensaje : "Cliente desactivado.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    onReactivate: async function () {
      var c = this.get("/currentClient");
      try {
        var res = await this.getData().action("reactivarCliente", { clienteID: c.ID });
        this.toast(res && res.mensaje ? res.mensaje : "Cliente reactivado.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    // ---------------- contratos ----------------

    onAddContract: async function () {
      this.set("/contractForm", {
        ID: null, clientID: this._clientId, reference: "", description: "",
        validFrom: hoy(), validTo: "",
        currency: this.get("/currentClient/defaultCurrency") || "COP",
        totalValue: "", renewalNoticeDays: 30, status: "ACTIVE",
      });
      this._contractFile = null;
      await this.openDialog("ContractDialog");
    },

    onEditContract: async function (event) {
      var row = this.rowOf(event);
      if (row.status === "INACTIVE") return this.fail(new Error("Un contrato cerrado no se puede editar."));
      this.set("/contractForm", {
        ID: row.ID, clientID: row.client_ID, reference: row.reference,
        description: row.description || "", validFrom: row.validFrom,
        validTo: row.validTo || "", currency: row.currency,
        totalValue: row.totalValue || "", renewalNoticeDays: row.renewalNoticeDays || 30,
        status: row.status,
      });
      this._contractFile = null;
      await this.openDialog("ContractDialog");
    },

    onContractFileSelected: function (event) {
      this._contractFile = event.getParameter("files") && event.getParameter("files")[0];
    },

    onContractCancel: function () {
      this.closeDialog("ContractDialog");
    },

    onContractSave: async function () {
      var form = this.get("/contractForm");
      if (!form.reference || !form.validFrom) {
        return this.fail(new Error("La referencia y la fecha de inicio son obligatorias."));
      }
      try {
        var guardado = await this.getData().save("Contratos", form.ID, {
          client_ID: form.clientID, reference: form.reference,
          description: form.description || null, validFrom: form.validFrom,
          currency: form.currency,
          totalValue: form.totalValue === "" ? null : Number(form.totalValue),
          renewalNoticeDays: Number(form.renewalNoticeDays) || 30,
        });
        var contratoID = form.ID || (guardado && guardado.ID);
        if (this._contractFile && contratoID) await this._uploadContract(contratoID, this._contractFile);
        this.closeDialog("ContractDialog");
        this.toast(form.ID ? "Contrato actualizado." : "Contrato creado.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    onFinishContract: async function (event) {
      var row = this.rowOf(event);
      var fecha = await this.askDate({
        title: "Cerrar contrato", label: "Fecha final", acceptText: "Cerrar",
        message: "Indica el último día de vigencia del contrato " + row.reference + ".",
      });
      if (!fecha) return;
      try {
        var res = await this.getData().action("finalizarContrato", { contratoID: row.ID, fechaFin: fecha });
        this.toast(res && res.mensaje ? res.mensaje : "Contrato cerrado.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },

    _uploadContract: async function (contratoID, file) {
      var base64 = await new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result).split(",")[1]); };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      return this.getData().action("cargarDocumentoContrato", {
        contratoID: contratoID,
        nombreArchivo: file.name,
        mimeType: file.type || "application/octet-stream",
        contenido: base64,
      });
    },

    onDownloadContract: async function (event) {
      var row = this.rowOf(event);
      if (!row || !row.firstDocument) return;
      try {
        var archivo = await this.getData().request(
          "GET",
          "descargarDocumentoContrato(contratoID=" + row.ID + ",documentoID=" + row.firstDocument.ID + ")",
        );
        if (!archivo || !archivo.contenidoBase64) return this.fail(new Error("El documento no tiene contenido."));
        var binario = atob(archivo.contenidoBase64);
        var bytes = new Uint8Array(binario.length);
        for (var i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
        var url = URL.createObjectURL(new Blob([bytes], { type: archivo.mimeType }));
        var enlace = document.createElement("a");
        enlace.href = url;
        enlace.download = archivo.filename;
        enlace.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      } catch (error) {
        this.fail(error);
      }
    },

    onDeleteContract: async function (event) {
      var row = this.rowOf(event);
      var ok = await this.confirm("¿Eliminar el contrato " + row.reference + "?", "Eliminar contrato");
      if (!ok) return;
      try {
        await this.getData().remove("Contratos", row.ID);
        this.toast("Contrato eliminado.");
        await this.getData().refresh();
      } catch (error) {
        this.fail(error);
      }
    },
  });
});
