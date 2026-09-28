sap.ui.define([
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/Input",
  "sap/m/Label",
  "sap/m/Select",
  "sap/m/DatePicker",
  "sap/m/TextArea",
  "sap/ui/core/Item",
  "sap/ui/layout/form/SimpleForm",
  "sap/ui/unified/FileUploader"
], function (MessageBox, MessageToast, Dialog, Button, Input, Label, Select, DatePicker, TextArea, Item, SimpleForm, FileUploader) {
  "use strict";

  function modelOf(controller) {
    return controller.getModel ? controller.getModel() : controller.getView().getModel();
  }

  function errorText(error) {
    try {
      var body = JSON.parse(error.cause && error.cause.error && error.cause.error.responseText);
      return body.error && body.error.message || error.message;
    } catch (ignore) {
      return error && (error.message || error.error && error.error.message) || "No fue posible completar la operación.";
    }
  }

  function option(key, text) {
    return new Item({ key: key, text: text });
  }

  function runAction(controller, name, parameters) {
    var operation = modelOf(controller).bindContext("/" + name + "(...)");
    Object.keys(parameters).forEach(function (key) { operation.setParameter(key, parameters[key]); });
    return operation.execute().then(function () { return operation.getBoundContext().getObject(); });
  }

  function download(file) {
    var binary = atob(file.contentBase64 || "");
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    var url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType || "application/octet-stream" }));
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.fileName || "documento";
    anchor.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function toBase64(file) {
    return file.arrayBuffer().then(function (buffer) {
      var bytes = new Uint8Array(buffer);
      var binary = "";
      var chunk = 0x8000;
      for (var index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
      }
      return btoa(binary);
    });
  }

  function selectedAccount(selectedContexts) {
    var contexts = selectedContexts || [];
    if (contexts.length !== 1) {
      MessageBox.warning("Selecciona exactamente una cuenta de cobro.");
      return null;
    }
    var account = contexts[0].getObject();
    if (account.origin !== "ASSISTED_FINANCE") {
      MessageBox.warning("Esta acción solo aplica a cuentas elaboradas por Finanzas.");
      return null;
    }
    return account;
  }

  function required(input) {
    input.setRequired(true);
    return input;
  }

  async function creationDialog(controller) {
    var employeeResult = await runAction(controller, "getAssistedEmployees", {});
    var employees = Array.isArray(employeeResult) ? employeeResult : employeeResult && employeeResult.value || [];
    var employeeByID = {};
    employees.forEach(function (employee) { employeeByID[employee.ID] = employee; });
    var fields = {
      employeeID: new Select({ width: "100%", items: [option("", "Selecciona una persona")].concat(employees.map(function (employee) {
        return option(employee.ID, employee.name + (employee.hasActiveBank ? "" : " · sin cuenta bancaria principal"));
      })) }),
      document: new Input({ editable: false }),
      documentCity: new Input({ editable: false }),
      taxAddress: new Input({ editable: false }),
      taxCity: new Input({ editable: false }),
      bank: new Input({ editable: false }),
      bankAccount: new Input({ editable: false }),
      periodStart: new DatePicker({ valueFormat: "yyyy-MM-dd", displayFormat: "dd/MM/yyyy", required: true }),
      periodEnd: new DatePicker({ valueFormat: "yyyy-MM-dd", displayFormat: "dd/MM/yyyy", required: true }),
      concept: new TextArea({ rows: 2, value: "Servicios generales por horas", required: true }),
      grossAmount: required(new Input({ type: "Number" })),
      currency: new Select({ selectedKey: "COP", items: [option("COP", "COP · Peso colombiano"), option("USD", "USD · Dólar estadounidense")] }),
      socialSecurityRequirement: new Select({ selectedKey: "NONE", items: [option("NONE", "No requerido para esta cuenta"), option("AFFILIATION", "Afiliación como independiente"), option("PILA", "Comprobante PILA")] })
    };
    fields.employeeID.attachChange(function () {
      var employee = employeeByID[fields.employeeID.getSelectedKey()] || {};
      fields.document.setValue([employee.documentType, employee.documentNumber].filter(Boolean).join(" "));
      fields.documentCity.setValue(employee.documentCity || "");
      fields.taxAddress.setValue(employee.taxAddress || "");
      fields.taxCity.setValue(employee.taxCity || "");
      fields.bank.setValue(employee.bankName || "Sin cuenta bancaria principal activa");
      fields.bankAccount.setValue([employee.bankAccountType, employee.bankAccountNumber, employee.bankHolder].filter(Boolean).join(" · "));
    });
    var form = new SimpleForm({
      editable: true,
      layout: "ResponsiveGridLayout",
      labelSpanXL: 3, labelSpanL: 3, labelSpanM: 4, labelSpanS: 12,
      columnsXL: 2, columnsL: 2, columnsM: 1,
      content: [
        new Label({ text: "Empleado", required: true }), fields.employeeID,
        new Label({ text: "Documento" }), fields.document,
        new Label({ text: "Lugar de expedición" }), fields.documentCity,
        new Label({ text: "Dirección tributaria" }), fields.taxAddress,
        new Label({ text: "Ciudad tributaria" }), fields.taxCity,
        new Label({ text: "Periodo desde", required: true }), fields.periodStart,
        new Label({ text: "Periodo hasta", required: true }), fields.periodEnd,
        new Label({ text: "Concepto", required: true }), fields.concept,
        new Label({ text: "Valor bruto", required: true }), fields.grossAmount,
        new Label({ text: "Moneda", required: true }), fields.currency,
        new Label({ text: "Banco" }), fields.bank,
        new Label({ text: "Cuenta y titular" }), fields.bankAccount,
        new Label({ text: "Soporte requerido", required: true }), fields.socialSecurityRequirement
      ]
    });
    var dialog = new Dialog({
      title: "Crear cuenta de cobro asistida",
      contentWidth: "70rem",
      contentHeight: "70vh",
      resizable: true,
      draggable: true,
      content: [form],
      beginButton: new Button({
        text: "Crear y descargar",
        type: "Emphasized",
        press: async function () {
          var selectedEmployee = employeeByID[fields.employeeID.getSelectedKey()];
          if (!selectedEmployee) return MessageBox.warning("Selecciona un empleado.");
          if (!selectedEmployee.hasActiveBank) return MessageBox.warning("La persona seleccionada debe tener una cuenta bancaria principal activa en Gestión de empleados.");
          var payload = {
            employeeID: selectedEmployee.ID,
            periodStart: fields.periodStart.getValue(),
            periodEnd: fields.periodEnd.getValue(),
            concept: fields.concept.getValue(),
            grossAmount: Number(fields.grossAmount.getValue()),
            currency: fields.currency.getSelectedKey(),
            socialSecurityRequirement: fields.socialSecurityRequirement.getSelectedKey()
          };
          try {
            dialog.setBusy(true);
            var result = await runAction(controller, "createAssistedAccount", payload);
            download(result);
            dialog.close();
            modelOf(controller).refresh();
            MessageToast.show(result.message);
          } catch (error) {
            MessageBox.error(errorText(error));
          } finally {
            dialog.setBusy(false);
          }
        }
      }),
      endButton: new Button({ text: "Cancelar", press: function () { dialog.close(); } }),
      afterClose: function () { dialog.destroy(); }
    });
    return dialog;
  }

  return {
    create: async function () {
      try {
        (await creationDialog(this)).open();
      } catch (error) {
        MessageBox.error(errorText(error));
      }
    },

    downloadDraft: async function (pageContext, selectedContexts) {
      var account = selectedAccount(selectedContexts);
      if (!account) return;
      try {
        download(await runAction(this, "downloadAssistedDraft", { accountID: account.ID }));
      } catch (error) {
        MessageBox.error(errorText(error));
      }
    },

    uploadSignedPackage: function (pageContext, selectedContexts) {
      var account = selectedAccount(selectedContexts);
      if (!account) return;
      if (["PENDING_SIGNATURE", "HR_REJECTED"].indexOf(account.status) < 0) {
        return MessageBox.warning("Esta cuenta ya no está pendiente de firma o corrección.");
      }
      var signedFile = null;
      var supportFile = null;
      var supportRequired = account.socialSecurityRequirement !== "NONE";
      var signedUploader = new FileUploader({ fileType: ["pdf"], change: function (event) { signedFile = event.getParameter("files")[0]; } });
      var supportUploader = new FileUploader({ fileType: ["pdf", "jpg", "jpeg", "png"], change: function (event) { supportFile = event.getParameter("files")[0]; } });
      var content = [
        new Label({ text: "Cuenta firmada (PDF)", required: true }), signedUploader
      ];
      if (supportRequired) {
        content.push(new Label({ text: "Soporte de seguridad social", required: true }), supportUploader);
      } else {
        content.push(new Label({ text: "Seguridad social" }), new Input({ value: "No requerida para esta cuenta", editable: false }));
      }
      var form = new SimpleForm({
        editable: true,
        layout: "ResponsiveGridLayout",
        content: content
      });
      var controller = this;
      var dialog = new Dialog({
        title: "Cargar expediente firmado",
        contentWidth: "38rem",
        content: [form],
        beginButton: new Button({
          text: "Cargar y enviar a revisión",
          type: "Emphasized",
          press: async function () {
            if (!signedFile || (supportRequired && !supportFile)) return MessageBox.warning(supportRequired ? "Selecciona la cuenta firmada y el soporte de seguridad social." : "Selecciona la cuenta firmada.");
            try {
              dialog.setBusy(true);
              var result = await runAction(controller, "uploadAssistedSignedPackage", {
                accountID: account.ID,
                signedFileName: signedFile.name,
                signedMimeType: signedFile.type || "application/pdf",
                signedContent: await toBase64(signedFile),
                supportFileName: supportFile ? supportFile.name : null,
                supportMimeType: supportFile ? supportFile.type || (/\.pdf$/i.test(supportFile.name) ? "application/pdf" : /\.png$/i.test(supportFile.name) ? "image/png" : "image/jpeg") : null,
                supportContent: supportFile ? await toBase64(supportFile) : null
              });
              dialog.close();
              modelOf(controller).refresh();
              MessageToast.show(result.message);
            } catch (error) {
              MessageBox.error(errorText(error));
            } finally {
              dialog.setBusy(false);
            }
          }
        }),
        endButton: new Button({ text: "Cancelar", press: function () { dialog.close(); } }),
        afterClose: function () { dialog.destroy(); }
      });
      dialog.open();
    }
  };
});
