sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
  ],
  function (Controller, JSONModel, MessageToast, MessageBox) {
    "use strict";

    return Controller.extend("sabnez.com.tiemposadminui.controller.Admin", {
      onInit: function () {
        this._csrfToken = null;
        this._contractFile = null;
        this.getView().setModel(
          new JSONModel({
            busy: false,
            error: "",
            canSeeRates: true,
            clients: [],
            contracts: [],
            projects: [],
            employees: [],
            assignments: [],
            approvers: [],
            rates: [],
            documents: [],
            contractsForProject: [],
            clientForm: this._emptyClient(),
            contractForm: this._emptyContract(),
            projectForm: this._emptyProject(),
            assignmentForm: this._emptyAssignment(),
            approverForm: this._emptyApprover(),
            rateForm: this._emptyRate(),
          }),
          "view",
        );
        this._loadAll();
      },
      onRefresh: function () {
        this._loadAll(true);
      },
      onDismissError: function () {
        this.getView().getModel("view").setProperty("/error", "");
      },
      onContractFileSelected: function (event) {
        this._contractFile = event.getParameter("files")?.[0] || null;
      },
      onProjectClientChange: function () {
        this._filterContracts();
      },

      onSaveClient: async function () {
        var model = this._model(),
          form = Object.assign({}, model.getProperty("/clientForm"));

        if (
          !String(form.legalName || "").trim() ||
          !String(form.taxIdentification || "").trim()
        ) {
          return MessageBox.warning(
            "Completa la razón social y la identificación tributaria.",
          );
        }

        var ID = form.ID;
        delete form.ID;

        try {
          await this._saveEntity(
            "Clientes",
            ID,
            Object.assign(form, {
              status: form.status || "ACTIVE",
              taxExempt: Boolean(form.taxExempt),
            }),
            ID ? "Cliente actualizado." : "Cliente creado.",
          );

          model.setProperty("/clientForm", this._emptyClient());
        } catch (error) {
          MessageBox.error(
            error.message || "No fue posible guardar el cliente.",
            {
              title: ID
                ? "Error al actualizar cliente"
                : "Error al crear cliente",
            },
          );
        }
      },
      onEditClient: function (event) {
        var row = this._row(event);
        this._model().setProperty(
          "/clientForm",
          Object.assign(this._emptyClient(), row),
        );
      },
      onCancelClientEdit: function () {
        this._model().setProperty("/clientForm", this._emptyClient());
      },
      onDeleteClient: function (event) {
        this._confirmDelete("Clientes", this._row(event), "cliente");
      },

      onSaveContract: async function () {
        var model = this._model(),
          form = Object.assign({}, model.getProperty("/contractForm"));
        if (
          !form.clientID ||
          !String(form.reference || "").trim() ||
          !form.validFrom
        )
          return MessageBox.warning(
            "Completa cliente, referencia y fecha inicial.",
          );
        var ID = form.ID;
        delete form.ID;
        delete form.documentCount;
        delete form.firstDocument;
        var saved = await this._saveEntity(
          "Contratos",
          ID,
          {
            client_ID: form.clientID,
            reference: form.reference,
            description: form.description || null,
            validFrom: form.validFrom,
            validTo: form.validTo || null,
            currency: form.currency || "COP",
            totalValue: form.totalValue === "" ? null : Number(form.totalValue),
            renewalNoticeDays: Number(form.renewalNoticeDays || 30),
            status: form.status || "ACTIVE",
          },
          ID ? "Contrato actualizado." : "Contrato creado.",
        );
        var contractID = ID || saved?.ID;
        if (this._contractFile && contractID)
          await this._uploadContract(contractID, this._contractFile);
        this._contractFile = null;
        this.byId("contractUploader").clear();
        model.setProperty("/contractForm", this._emptyContract());
        await this._loadAll();
      },
      onEditContract: function (event) {
        var row = this._row(event);
        this._model().setProperty(
          "/contractForm",
          Object.assign(this._emptyContract(), row, {
            clientID: row.client_ID,
          }),
        );
      },
      onCancelContractEdit: function () {
        this._contractFile = null;
        this.byId("contractUploader").clear();
        this._model().setProperty("/contractForm", this._emptyContract());
      },
      onDeleteContract: function (event) {
        this._confirmDelete("Contratos", this._row(event), "contrato");
      },
      onDownloadContract: async function (event) {
        var doc = this._row(event).firstDocument;
        if (!doc) return;
        try {
          var file = await this._request("POST", "descargarDocumentoContrato", {
              contratoID: doc.contratoID,
              documentoID: doc.ID,
            }),
            binary = atob(file.contenidoBase64),
            bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i += 1)
            bytes[i] = binary.charCodeAt(i);
          var url = URL.createObjectURL(
              new Blob([bytes], {
                type: file.mimeType || "application/octet-stream",
              }),
            ),
            link = document.createElement("a");
          link.href = url;
          link.download = file.filename || "contrato";
          link.click();
          setTimeout(function () {
            URL.revokeObjectURL(url);
          }, 1000);
        } catch (error) {
          this._model().setProperty("/error", error.message);
        }
      },

      onSaveProject: async function () {
        var model = this._model(),
          form = Object.assign({}, model.getProperty("/projectForm"));
        if (
          !form.clientID ||
          !String(form.code || "").trim() ||
          !String(form.name || "").trim() ||
          !form.validFrom
        )
          return MessageBox.warning(
            "Completa cliente, código, nombre y fecha inicial.",
          );
        var ID = form.ID;
        delete form.ID;
        await this._saveEntity(
          "Proyectos",
          ID,
          {
            client_ID: form.clientID,
            contract_ID: form.contractID || null,
            code: form.code,
            name: form.name,
            description: form.description || null,
            validFrom: form.validFrom,
            validTo: form.validTo || null,
            modality: form.modality,
            currency: form.currency,
            timeZone: form.timeZone,
            requiresDescription: Boolean(form.requiresDescription),
            requiresEvidence: Boolean(form.requiresEvidence),
            requiresClientApproval: Boolean(form.requiresClientApproval),
            approvalScheme: form.approvalScheme || "LEADER_THEN_ADMIN",
            dailyWarningHours: Number(form.dailyWarningHours || 16),
            status: form.status || "ACTIVE",
          },
          ID ? "Proyecto actualizado." : "Proyecto creado.",
        );
        model.setProperty("/projectForm", this._emptyProject());
        this._filterContracts();
      },
      onEditProject: function (event) {
        var row = this._row(event);
        this._model().setProperty(
          "/projectForm",
          Object.assign(this._emptyProject(), row, {
            clientID: row.client_ID,
            contractID: row.contract_ID || "",
          }),
        );
        this._filterContracts();
      },
      onCancelProjectEdit: function () {
        this._model().setProperty("/projectForm", this._emptyProject());
        this._filterContracts();
      },
      onDeleteProject: function (event) {
        this._confirmDelete("Proyectos", this._row(event), "proyecto");
      },

      onSaveAssignment: async function () {
        var model = this._model(),
          form = Object.assign({}, model.getProperty("/assignmentForm"));
        if (!form.projectID || !form.employeeID || !form.validFrom)
          return MessageBox.warning(
            "Completa proyecto, empleado y fecha inicial.",
          );
        var ID = form.ID;
        delete form.ID;
        await this._saveEntity(
          "Asignaciones",
          ID,
          {
            project_ID: form.projectID,
            employee_ID: form.employeeID,
            validFrom: form.validFrom,
            validTo: form.validTo || null,
            role: form.role || null,
            commercialAllocation: Number(form.commercialAllocation || 0),
            isPrimary: Boolean(form.isPrimary),
            isBackup: Boolean(form.isBackup),
            status: form.status || "ACTIVE",
          },
          ID ? "Asignación actualizada." : "Empleado asignado.",
        );
        model.setProperty("/assignmentForm", this._emptyAssignment());
      },
      onEditAssignment: function (event) {
        var row = this._row(event);
        this._model().setProperty(
          "/assignmentForm",
          Object.assign(this._emptyAssignment(), row, {
            projectID: row.project_ID,
            employeeID: row.employee_ID,
          }),
        );
      },
      onCancelAssignmentEdit: function () {
        this._model().setProperty("/assignmentForm", this._emptyAssignment());
      },
      onDeleteAssignment: function (event) {
        this._confirmDelete("Asignaciones", this._row(event), "asignación");
      },

      onSaveApprover: async function () {
        var model = this._model(),
          form = Object.assign({}, model.getProperty("/approverForm"));
        if (!form.projectID || !form.employeeID || !form.validFrom)
          return MessageBox.warning(
            "Completa proyecto, responsable y fecha inicial.",
          );
        var ID = form.ID;
        delete form.ID;
        await this._saveEntity(
          "Aprobadores",
          ID,
          {
            project_ID: form.projectID,
            employee_ID: form.employeeID,
            approverType: form.approverType || "LEADER",
            validFrom: form.validFrom,
            validTo: form.validTo || null,
            active: Boolean(form.active),
          },
          ID ? "Aprobador actualizado." : "Aprobador asignado.",
        );
        model.setProperty("/approverForm", this._emptyApprover());
      },
      onEditApprover: function (event) {
        var row = this._row(event);
        this._model().setProperty(
          "/approverForm",
          Object.assign(this._emptyApprover(), row, {
            projectID: row.project_ID,
            employeeID: row.employee_ID,
          }),
        );
      },
      onCancelApproverEdit: function () {
        this._model().setProperty("/approverForm", this._emptyApprover());
      },
      onDeleteApprover: function (event) {
        this._confirmDelete("Aprobadores", this._row(event), "aprobador");
      },

      onSaveRate: async function () {
        var model = this._model(),
          form = Object.assign({}, model.getProperty("/rateForm"));
        if (!form.assignmentID || !form.validFrom)
          return MessageBox.warning(
            "Completa asignación y fecha inicial de la tarifa.",
          );
        var ID = form.ID;
        delete form.ID;
        await this._saveEntity(
          "Tarifas",
          ID,
          {
            assignment_ID: form.assignmentID,
            validFrom: form.validFrom,
            validTo: form.validTo || null,
            currency: form.currency || "COP",
            monthlySaleRate: this._numberOrNull(form.monthlySaleRate),
            regularSaleHourlyRate: this._numberOrNull(
              form.regularSaleHourlyRate,
            ),
            overtimeSaleHourlyRate: this._numberOrNull(
              form.overtimeSaleHourlyRate,
            ),
            internalMonthlyCost: this._numberOrNull(form.internalMonthlyCost),
            internalHourlyCost: this._numberOrNull(form.internalHourlyCost),
            confidential: true,
          },
          ID ? "Tarifa actualizada." : "Tarifa creada.",
        );
        model.setProperty("/rateForm", this._emptyRate());
      },
      onEditRate: function (event) {
        var row = this._row(event);
        this._model().setProperty(
          "/rateForm",
          Object.assign(this._emptyRate(), row, {
            assignmentID: row.assignment_ID,
          }),
        );
      },
      onCancelRateEdit: function () {
        this._model().setProperty("/rateForm", this._emptyRate());
      },
      onDeleteRate: function (event) {
        this._confirmDelete("Tarifas", this._row(event), "tarifa");
      },

      _loadAll: async function (notify) {
        var model = this._model();
        model.setProperty("/busy", true);
        model.setProperty("/error", "");
        try {
          var results = await Promise.all([
            this._get(
              "Clientes?$select=ID,legalName,tradeName,taxIdentification,countryCode,defaultCurrency,timeZone,taxExempt,status&$orderby=tradeName",
            ),
            this._get(
              "Contratos?$select=ID,client_ID,reference,description,validFrom,validTo,currency,totalValue,renewalNoticeDays,status&$expand=client($select=tradeName,legalName)&$orderby=validFrom desc",
            ),
            this._get(
              "Proyectos?$select=ID,client_ID,contract_ID,code,name,description,modality,validFrom,validTo,currency,timeZone,requiresDescription,requiresEvidence,requiresClientApproval,approvalScheme,dailyWarningHours,status&$expand=client($select=tradeName,legalName),contract($select=reference)&$orderby=name",
            ),
            this._get(
              "Empleados?$select=ID,nombreCompleto,correoCorporativo&$orderby=nombreCompleto",
            ),
            this._get(
              "Asignaciones?$select=ID,project_ID,employee_ID,role,validFrom,validTo,commercialAllocation,isPrimary,isBackup,status&$expand=project($select=name),employee($select=nombreCompleto)&$orderby=validFrom desc",
            ),
            this._get(
              "Aprobadores?$select=ID,project_ID,employee_ID,approverType,validFrom,validTo,active&$expand=project($select=name),employee($select=nombreCompleto,correoCorporativo)&$orderby=validFrom desc",
            ),
            this._get(
              "Tarifas?$select=ID,assignment_ID,validFrom,validTo,currency,monthlySaleRate,regularSaleHourlyRate,overtimeSaleHourlyRate,internalMonthlyCost,internalHourlyCost&$expand=assignment($expand=project($select=name),employee($select=nombreCompleto))&$orderby=validFrom desc",
            ).catch(function () {
              model.setProperty("/canSeeRates", false);
              return [];
            }),
            this._get("obtenerDocumentosContrato()"),
          ]);
          var documents = results[7];
          model.setProperty("/documents", documents);
          model.setProperty("/clients", results[0]);
          model.setProperty(
            "/contracts",
            results[1].map(function (row) {
              var docs = documents.filter(function (doc) {
                return doc.contratoID === row.ID;
              });
              return Object.assign(row, {
                clientName:
                  row.client?.tradeName || row.client?.legalName || "",
                documentCount: docs.length,
                firstDocument: docs[0] || null,
              });
            }),
          );
          model.setProperty(
            "/projects",
            results[2].map(function (row) {
              return Object.assign(row, {
                clientName:
                  row.client?.tradeName || row.client?.legalName || "",
                contractReference: row.contract?.reference || "",
              });
            }),
          );
          model.setProperty("/employees", results[3]);
          model.setProperty(
            "/assignments",
            results[4].map(function (row) {
              return Object.assign(row, {
                projectName: row.project?.name || "",
                employeeName: row.employee?.nombreCompleto || "",
              });
            }),
          );
          model.setProperty(
            "/approvers",
            results[5].map(function (row) {
              return Object.assign(row, {
                projectName: row.project?.name || "",
                employeeName: row.employee?.nombreCompleto || "",
                employeeEmail: row.employee?.correoCorporativo || "",
              });
            }),
          );
          model.setProperty(
            "/rates",
            results[6].map(function (row) {
              return Object.assign(row, {
                projectName: row.assignment?.project?.name || "",
                employeeName: row.assignment?.employee?.nombreCompleto || "",
                assignmentLabel:
                  (row.assignment?.employee?.nombreCompleto || "") +
                  " · " +
                  (row.assignment?.project?.name || ""),
              });
            }),
          );
          this._filterContracts();
          if (notify) MessageToast.show("Información actualizada.");
        } catch (error) {
          model.setProperty("/error", error.message || String(error));
        } finally {
          model.setProperty("/busy", false);
        }
      },

      _saveEntity: async function (entity, ID, payload, message) {
        var result = await this._request(
          ID ? "PATCH" : "POST",
          entity + (ID ? "(" + encodeURIComponent(ID) + ")" : ""),
          payload,
        );
        MessageToast.show(message);
        await this._loadAll();
        return result;
      },
      _confirmDelete: function (entity, row, label) {
        MessageBox.confirm(
          "¿Deseas eliminar " +
            label +
            " “" +
            (row.tradeName ||
              row.name ||
              row.reference ||
              row.employeeName ||
              "") +
            "”?",
          {
            actions: [MessageBox.Action.DELETE, MessageBox.Action.CANCEL],
            emphasizedAction: MessageBox.Action.DELETE,
            onClose: async function (action) {
              if (action !== MessageBox.Action.DELETE) return;
              try {
                await this._request(
                  "DELETE",
                  entity + "(" + encodeURIComponent(row.ID) + ")",
                );
                MessageToast.show("Elemento eliminado.");
                await this._loadAll();
              } catch (error) {
                this._model().setProperty("/error", error.message);
              }
            }.bind(this),
          },
        );
      },
      _uploadContract: async function (contractID, file) {
        var base64 = await new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () {
            resolve(String(reader.result).split(",")[1]);
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        await this._request("POST", "cargarDocumentoContrato", {
          contratoID: contractID,
          nombreArchivo: file.name,
          mimeType: file.type || "application/octet-stream",
          contenido: base64,
        });
      },
      _request: async function (method, path, payload) {
        var token = method === "GET" ? null : await this._csrf(),
          response = await fetch(this._serviceRoot() + path, {
            method: method,
            credentials: "same-origin",
            headers: Object.assign(
              { Accept: "application/json" },
              payload ? { "Content-Type": "application/json" } : {},
              token ? { "X-CSRF-Token": token } : {},
            ),
            body: payload ? JSON.stringify(payload) : undefined,
          });
        if (!response.ok) throw await this._error(response);
        if (response.status === 204) return null;
        return response.json().catch(function () {
          return null;
        });
      },
      _get: async function (path) {
        var result = await this._request("GET", path);
        return result?.value || [];
      },
      _csrf: async function () {
        if (this._csrfToken) return this._csrfToken;
        var response = await fetch(this._serviceRoot(), {
          credentials: "same-origin",
          headers: { "X-CSRF-Token": "Fetch" },
        });
        if (!response.ok) throw await this._error(response);
        this._csrfToken = response.headers.get("X-CSRF-Token");
        return this._csrfToken;
      },
      _serviceRoot: function () {
        return /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
          ? "/tiempos-admin/"
          : this.getOwnerComponent()
              .getManifestObject()
              .resolveUri("tiempos-admin/");
      },
      _error: async function (response) {
        var payload = await response.json().catch(function () {
          return {};
        });
        return new Error(
          payload.error?.message || "No fue posible completar la operación.",
        );
      },
      _filterContracts: function () {
        var model = this._model(),
          clientID = model.getProperty("/projectForm/clientID"),
          rows = (model.getProperty("/contracts") || []).filter(function (row) {
            return !clientID || row.client_ID === clientID;
          });
        model.setProperty("/contractsForProject", rows);
        if (
          !rows.some(function (row) {
            return row.ID === model.getProperty("/projectForm/contractID");
          })
        )
          model.setProperty("/projectForm/contractID", "");
      },
      _row: function (event) {
        return event.getSource().getBindingContext("view").getObject();
      },
      _model: function () {
        return this.getView().getModel("view");
      },
      _numberOrNull: function (value) {
        return value === "" || value == null ? null : Number(value);
      },
      _emptyClient: function () {
        return {
          ID: null,
          legalName: "",
          tradeName: "",
          taxIdentification: "",
          countryCode: "CO",
          defaultCurrency: "COP",
          timeZone: "America/Bogota",
          taxExempt: false,
          status: "ACTIVE",
        };
      },
      _emptyContract: function () {
        return {
          ID: null,
          clientID: "",
          reference: "",
          description: "",
          validFrom: "",
          validTo: "",
          currency: "COP",
          totalValue: "",
          renewalNoticeDays: 30,
          status: "ACTIVE",
        };
      },
      _emptyProject: function () {
        return {
          ID: null,
          clientID: "",
          contractID: "",
          code: "",
          name: "",
          description: "",
          validFrom: "",
          validTo: "",
          modality: "FULL_TIME",
          currency: "COP",
          timeZone: "America/Bogota",
          requiresDescription: false,
          requiresEvidence: false,
          requiresClientApproval: false,
          approvalScheme: "LEADER_THEN_ADMIN",
          dailyWarningHours: 16,
          status: "ACTIVE",
        };
      },
      _emptyAssignment: function () {
        return {
          ID: null,
          projectID: "",
          employeeID: "",
          validFrom: "",
          validTo: "",
          role: "Consultor",
          commercialAllocation: 0,
          isPrimary: true,
          isBackup: false,
          status: "ACTIVE",
        };
      },
      _emptyApprover: function () {
        return {
          ID: null,
          projectID: "",
          employeeID: "",
          approverType: "ADMIN",
          validFrom: new Date().toISOString().slice(0, 10),
          validTo: "",
          active: true,
        };
      },
      _emptyRate: function () {
        return {
          ID: null,
          assignmentID: "",
          validFrom: "",
          validTo: "",
          currency: "COP",
          monthlySaleRate: "",
          regularSaleHourlyRate: "",
          overtimeSaleHourlyRate: "",
          internalMonthlyCost: "",
          internalHourlyCost: "",
        };
      },
    });
  },
);
