sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/m/Token",
    "sap/m/Dialog",
    "sap/m/List",
    "sap/m/SearchField",
    "sap/m/StandardListItem",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/model/Sorter",
    "sap/m/Toolbar",
    "sap/m/ToolbarSpacer",
    "sap/m/Title",
    "sap/m/Button",
    "sap/m/ViewSettingsDialog",
    "sap/m/ViewSettingsItem",
    "sap/m/ViewSettingsFilterItem",
    "sap/ui/export/Spreadsheet",
    "sap/ui/core/Fragment",
  ],
  function (
    Controller,
    JSONModel,
    MessageToast,
    MessageBox,
    Token,
    Dialog,
    List,
    SearchField,
    StandardListItem,
    Filter,
    FilterOperator,
    Sorter,
    Toolbar,
    ToolbarSpacer,
    Title,
    Button,
    ViewSettingsDialog,
    ViewSettingsItem,
    ViewSettingsFilterItem,
    Spreadsheet,
    Fragment,
  ) {
    "use strict";

    return Controller.extend(
      "sabnez.com.reportestiemposui.ext.main.Dashboard",
      {
        onInit: function () {
          this.getView().setModel(
            new JSONModel({
              totalHours: "—",
              billableHours: "—",
              approvedHours: "—",
              pendingHours: "—",
              employeeCount: "—",
              projectCount: "—",
              clientCount: "—",
              entryCount: "—",
            }),
            "dashboard",
          );

          this.getView().setModel(
            new JSONModel({
              summary: {
                totalHours: 0,
                billableHours: 0,
                billablePercentage: 0,
              },
              byClient: [],
              byProject: [],
              byEmployee: [],
              byStatus: [],
              byDay: [],
            }),
            "analytics",
          );

          this.getView().setModel(
            new JSONModel({
              periodText: "Periodo seleccionado",
              billablePercentage: 0,
              billableHours: 0,
              pendingEntryCount: 0,
              unclassifiedEntryCount: 0,
              unclassifiedHours: 0,
              weeklyHours: [],
              projectHours: [],
              employeeHours: [],
              clientLegend: [],
              monthlyTargetHours: 0,
              monthlyTargetPercentage: 0,
              monthlyTargetText: "Sin objetivo calculado",
              pendingApprovals: [],
            }),
            "executive",
          );

          this.getView().setModel(
            new JSONModel({
              title: "",
              subtitle: "",
              contextLabel: "Cliente",
              contextValue: "",
              totalHoursText: "0 h",
              billableHoursText: "0 h",
              pendingHoursText: "0 h",
              entryCount: 0,
              hasPending: false,
              items: [],
            }),
            "breakdown",
          );

          this.getView().setModel(
            new JSONModel({
              employees: [],
              projects: [],
              clients: [],
              compliance: [],
              employeeCount: 0,
              projectCount: 0,
              clientCount: 0,
              complianceCount: 0,
            }),
            "consolidated",
          );

          this.getView().setModel(
            new JSONModel({
              periodText: "Periodo seleccionado",
              clients: [],
              selectedClientID: "",
              availableProjects: [],
              selectedProjectIDs: [],
              projectAvailabilityText:
                "Seleccione un cliente para consultar sus proyectos vigentes.",
              projectSelectionButtonText: "Seleccionar todos",
              projectSelectionButtonIcon: "sap-icon://multi-select",
              formatType: "SUMMARY",
              formatIndex: 0,
              showEvidenceOption: false,
              includeEvidence: false,
            }),
            "deliverables",
          );

          this.getView().setModel(
            new JSONModel({
              clients: [],
              projects: [],
              filteredProjects: [],
              employees: [],

              statuses: [
                {
                  key: "DRAFT",
                  text: "Borrador",
                },
                {
                  key: "SUBMITTED",
                  text: "Enviado",
                },
                {
                  key: "UNDER_REVIEW",
                  text: "En revisión",
                },
                {
                  key: "RETURNED",
                  text: "Devuelto",
                },
                {
                  key: "LEADER_APPROVED",
                  text: "Aprobado por líder",
                },
                {
                  key: "INTERNALLY_APPROVED",
                  text: "Aprobado internamente",
                },
                {
                  key: "CLIENT_OBJECTED",
                  text: "Objetado por cliente",
                },
                {
                  key: "CORRECTED",
                  text: "Corregido",
                },
                {
                  key: "CLOSED",
                  text: "Cerrado",
                },
                {
                  key: "INVOICED",
                  text: "Facturado",
                },
                {
                  key: "VOIDED",
                  text: "Anulado",
                },
              ],
            }),
            "lookups",
          );

          this.getView().setModel(
            new JSONModel({
              dailyDetails: [],
              loaded: false,
              count: 0,
              tableSettingsActive: false,
            }),
            "report",
          );

          this.getView().setModel(
            new JSONModel({
              canGenerateDeliverables: false,
            }),
            "auth",
          );

          this._defaultPeriodInitialized = false;
          this._lookupsLoaded = false;
          this._permissionsLoaded = false;
        },

        onAfterRendering: function () {
          if (!this._defaultPeriodInitialized) {
            this._setDefaultPeriod();
          }

          if (!this._lookupsLoaded) {
            this._lookupsLoaded = true;
            this._loadLookups();
          }

          if (!this._permissionsLoaded) {
            this._permissionsLoaded = true;
            this._loadPermissions();
          }
        },

        _setDefaultPeriod: function () {
          const periodControl = this.byId("reportPeriod");

          if (!periodControl) {
            return;
          }

          const currentDate = new Date();

          const firstDay = new Date(
            currentDate.getFullYear(),
            currentDate.getMonth(),
            1,
          );

          const lastDay = new Date(
            currentDate.getFullYear(),
            currentDate.getMonth() + 1,
            0,
          );

          periodControl.setDateValue(firstDay);
          periodControl.setSecondDateValue(lastDay);

          this._defaultPeriodInitialized = true;
          this._syncDeliverablePeriod();
        },

        _loadLookups: async function () {
          const model = this.getView().getModel();
          const lookupModel = this.getView().getModel("lookups");

          try {
            const [clients, projects, employees] = await Promise.all([
              this._requestCollection(
                model,
                "/Clients",
                "ID,legalName,tradeName,status",
              ),
              this._requestCollection(
                model,
                "/Projects",
                "ID,code,name,client_ID,clientName,status",
              ),
              this._requestCollection(
                model,
                "/Employees",
                "ID,employeeCode,employeeName",
              ),
            ]);

            clients.sort((a, b) =>
              String(a.legalName || "").localeCompare(
                String(b.legalName || ""),
                "es",
              ),
            );

            projects.sort((a, b) =>
              String(a.name || "").localeCompare(String(b.name || ""), "es"),
            );

            employees.sort((a, b) =>
              String(a.employeeName || "").localeCompare(
                String(b.employeeName || ""),
                "es",
              ),
            );

            lookupModel.setProperty("/clients", clients);
            lookupModel.setProperty("/projects", projects);
            lookupModel.setProperty("/filteredProjects", projects);
            lookupModel.setProperty("/employees", employees);

            const deliverablesModel = this.getView().getModel("deliverables");
            deliverablesModel.setProperty(
              "/clients",
              clients.filter((client) => client.status === "ACTIVE"),
            );
            this._prepareDeliverables();
          } catch (error) {
            console.error("No fue posible cargar los filtros:", error);

            MessageBox.error(
              "No fue posible cargar los clientes, proyectos y empleados.",
            );
          }
        },

        onClientValueHelp: function () {
          if (!this._clientValueHelpDialog) {
            this._clientValueHelpList = new List({
              mode: "MultiSelect",
              includeItemInSelection: true,
              growing: true,
              growingThreshold: 100,
            });

            this._clientValueHelpList.setModel(
              this.getView().getModel("lookups"),
              "lookups",
            );

            this._clientValueHelpList.bindItems({
              path: "lookups>/clients",
              template: new StandardListItem({
                title: "{lookups>legalName}",
                description: "{lookups>tradeName}",
                type: "Active",
              }),
            });

            const searchField = new SearchField({
              width: "100%",
              placeholder: "Buscar cliente",
              liveChange: this.onClientValueHelpSearch.bind(this),
            });

            this._clientValueHelpDialog = new Dialog({
              title: "Seleccionar clientes",
              contentWidth: "34rem",
              contentHeight: "34rem",
              resizable: true,
              draggable: true,

              customHeader: new Toolbar({
                content: [
                  new Title({
                    text: "Seleccionar clientes",
                  }),

                  new ToolbarSpacer(),

                  new Button({
                    text: "Marcar todos",
                    icon: "sap-icon://multiselect-all",
                    type: "Transparent",
                    press: this.onSelectAllClients.bind(this),
                  }),

                  new Button({
                    text: "Desmarcar todos",
                    icon: "sap-icon://multiselect-none",
                    type: "Transparent",
                    press: this.onClearAllClients.bind(this),
                  }),
                ],
              }),

              content: [searchField, this._clientValueHelpList],

              beginButton: new Button({
                text: "Seleccionar",
                type: "Emphasized",
                press: this.onClientValueHelpConfirm.bind(this),
              }),

              endButton: new Button({
                text: "Cancelar",
                press: function () {
                  this._clientValueHelpDialog.close();
                }.bind(this),
              }),
            });

            this.getView().addDependent(this._clientValueHelpDialog);
          }

          this._synchronizeClientDialogSelection();
          this._clientValueHelpDialog.open();
        },

        onClientValueHelpSearch: function (event) {
          const searchValue = event.getParameter("newValue") || "";

          const binding = this._clientValueHelpList.getBinding("items");

          if (!searchValue.trim()) {
            binding.filter([]);
            return;
          }

          binding.filter(
            new Filter({
              filters: [
                new Filter({
                  path: "legalName",
                  operator: FilterOperator.Contains,
                  value1: searchValue,
                  caseSensitive: false,
                }),
                new Filter({
                  path: "tradeName",
                  operator: FilterOperator.Contains,
                  value1: searchValue,
                  caseSensitive: false,
                }),
              ],
              and: false,
            }),
          );
        },

        onClientValueHelpConfirm: function () {
          const selectedItems = this._clientValueHelpList.getSelectedItems();

          const multiInput = this.byId("clientFilter");

          multiInput.removeAllTokens();

          selectedItems.forEach((item) => {
            const context = item.getBindingContext("lookups");

            if (!context) {
              return;
            }

            const client = context.getObject();

            multiInput.addToken(
              new Token({
                key: client.ID,
                text: client.legalName,
              }),
            );
          });

          this._clientValueHelpDialog.close();
          this._filterProjectsBySelectedClients();
        },

        onClientTokenUpdate: function () {
          setTimeout(
            function () {
              this._filterProjectsBySelectedClients();
            }.bind(this),
            0,
          );
        },

        onProjectValueHelp: function () {
          if (!this._projectValueHelpDialog) {
            this._projectValueHelpList = new List({
              mode: "MultiSelect",
              includeItemInSelection: true,
              growing: true,
              growingThreshold: 100,
            });

            this._projectValueHelpList.setModel(
              this.getView().getModel("lookups"),
              "lookups",
            );

            this._projectValueHelpList.bindItems({
              path: "lookups>/filteredProjects",
              template: new StandardListItem({
                title: "{lookups>name}",
                description: {
                  parts: [
                    { path: "lookups>code" },
                    { path: "lookups>clientName" },
                  ],
                  formatter: function (code, clientName) {
                    return [code, clientName].filter(Boolean).join(" · ");
                  },
                },
                type: "Active",
              }),
            });

            const searchField = new SearchField({
              width: "100%",
              placeholder: "Buscar proyecto",
              liveChange: this.onProjectValueHelpSearch.bind(this),
            });

            this._projectValueHelpDialog = new Dialog({
              title: "Seleccionar proyectos",
              contentWidth: "36rem",
              contentHeight: "34rem",
              resizable: true,
              draggable: true,

              customHeader: new Toolbar({
                content: [
                  new Title({
                    text: "Seleccionar proyectos",
                  }),

                  new ToolbarSpacer(),

                  new Button({
                    text: "Marcar todos",
                    icon: "sap-icon://multi-select",
                    type: "Transparent",
                    press: this.onSelectAllProjects.bind(this),
                  }),

                  new Button({
                    text: "Desmarcar todos",
                    icon: "sap-icon://multiselect-none",
                    type: "Transparent",
                    press: this.onClearAllProjects.bind(this),
                  }),
                ],
              }),

              content: [searchField, this._projectValueHelpList],

              beginButton: new Button({
                text: "Seleccionar",
                type: "Emphasized",
                press: this.onProjectValueHelpConfirm.bind(this),
              }),

              endButton: new Button({
                text: "Cancelar",
                press: function () {
                  this._projectValueHelpDialog.close();
                }.bind(this),
              }),
            });

            this.getView().addDependent(this._projectValueHelpDialog);
          }

          this._synchronizeProjectDialogSelection();
          this._projectValueHelpDialog.open();
        },

        onProjectValueHelpSearch: function (event) {
          const searchValue = event.getParameter("newValue") || "";

          const binding = this._projectValueHelpList.getBinding("items");

          if (!searchValue.trim()) {
            binding.filter([]);
            return;
          }

          binding.filter(
            new Filter({
              filters: [
                new Filter({
                  path: "name",
                  operator: FilterOperator.Contains,
                  value1: searchValue,
                  caseSensitive: false,
                }),
                new Filter({
                  path: "code",
                  operator: FilterOperator.Contains,
                  value1: searchValue,
                  caseSensitive: false,
                }),
                new Filter({
                  path: "clientName",
                  operator: FilterOperator.Contains,
                  value1: searchValue,
                  caseSensitive: false,
                }),
              ],
              and: false,
            }),
          );
        },

        onProjectValueHelpConfirm: function () {
          const selectedItems = this._projectValueHelpList.getSelectedItems();

          const multiInput = this.byId("projectFilter");

          multiInput.removeAllTokens();

          selectedItems.forEach((item) => {
            const context = item.getBindingContext("lookups");

            if (!context) {
              return;
            }

            const project = context.getObject();

            multiInput.addToken(
              new Token({
                key: project.ID,
                text: project.name,
              }),
            );
          });

          this._projectValueHelpDialog.close();
        },

        onSelectAllProjects: function () {
          if (!this._projectValueHelpList) {
            return;
          }

          this._projectValueHelpList.getItems().forEach((item) => {
            item.setSelected(true);
          });
        },

        onClearAllProjects: function () {
          if (!this._projectValueHelpList) {
            return;
          }

          this._projectValueHelpList.removeSelections(true);
        },

        onProjectTokenUpdate: function () {
          setTimeout(
            function () {
              this._synchronizeProjectDialogSelection();
            }.bind(this),
            0,
          );
        },

        _getTokenKeys: function (controlID) {
          const control = this.byId(controlID);

          if (!control || !control.getTokens) {
            return [];
          }

          return control
            .getTokens()
            .map((token) => token.getKey())
            .filter(Boolean);
        },

        _synchronizeProjectDialogSelection: function () {
          if (!this._projectValueHelpList) {
            return;
          }

          const selectedKeys = new Set(this._getTokenKeys("projectFilter"));

          this._projectValueHelpList.getItems().forEach((item) => {
            const context = item.getBindingContext("lookups");

            const projectID = context?.getProperty("ID");

            item.setSelected(selectedKeys.has(projectID));
          });
        },

        _synchronizeClientDialogSelection: function () {
          if (!this._clientValueHelpList) {
            return;
          }

          const selectedKeys = new Set(this._getTokenKeys("clientFilter"));

          this._clientValueHelpList.getItems().forEach((item) => {
            const context = item.getBindingContext("lookups");

            const clientID = context?.getProperty("ID");

            item.setSelected(selectedKeys.has(clientID));
          });
        },

        _requestCollection: async function (model, path, select) {
          const listBinding = model.bindList(path, null, null, null, {
            $select: select,
          });

          const contexts = await listBinding.requestContexts(0, 5000);

          return contexts.map((context) => context.getObject());
        },

        _filterProjectsBySelectedClients: function () {
          const selectedClientIDs = this._getTokenKeys("clientFilter");

          const lookupModel = this.getView().getModel("lookups");

          const projects = lookupModel.getProperty("/projects") || [];

          const filteredProjects =
            selectedClientIDs.length > 0
              ? projects.filter((project) =>
                  selectedClientIDs.includes(project.client_ID),
                )
              : projects;

          lookupModel.setProperty("/filteredProjects", filteredProjects);

          const projectFilter = this.byId("projectFilter");

          if (projectFilter) {
            const validProjectIDs = new Set(
              filteredProjects.map((project) => project.ID),
            );

            const validTokens = projectFilter
              .getTokens()
              .filter((token) => validProjectIDs.has(token.getKey()));

            projectFilter.removeAllTokens();

            validTokens.forEach((token) => {
              projectFilter.addToken(token);
            });
          }

          if (this._projectValueHelpList) {
            this._projectValueHelpList.getBinding("items")?.refresh();
          }
        },

        onPeriodChange: function (event) {
          const valid = event.getParameter("valid");

          event.getSource().setValueState(valid ? "None" : "Error");

          event
            .getSource()
            .setValueStateText(valid ? "" : "Ingrese un periodo válido.");

          if (valid) {
            this._syncDeliverablePeriod();
            this._refreshDeliverableProjects();
          }
        },

        onReportTabSelect: function (event) {
          if (event.getParameter("key") === "deliverables") {
            this._prepareDeliverables();
          }
        },

        _prepareDeliverables: function () {
          this._syncDeliverablePeriod();

          const deliverablesModel = this.getView().getModel("deliverables");
          const lookupModel = this.getView().getModel("lookups");
          if (!deliverablesModel || !lookupModel) return;

          const clients = (lookupModel.getProperty("/clients") || []).filter(
            (client) => client.status === "ACTIVE",
          );
          deliverablesModel.setProperty("/clients", clients);

          if (!deliverablesModel.getProperty("/selectedClientID")) {
            const clientTokens = this.byId("clientFilter")?.getTokens() || [];
            if (clientTokens.length === 1) {
              const clientID = clientTokens[0].getKey();
              if (clients.some((client) => client.ID === clientID)) {
                deliverablesModel.setProperty("/selectedClientID", clientID);
              }
            }
          }

          this._refreshDeliverableProjects();

          if (
            !(deliverablesModel.getProperty("/selectedProjectIDs") || []).length
          ) {
            const available = new Set(
              (deliverablesModel.getProperty("/availableProjects") || []).map(
                (project) => project.ID,
              ),
            );
            const projectIDs = (this.byId("projectFilter")?.getTokens() || [])
              .map((token) => token.getKey())
              .filter((ID) => available.has(ID));

            if (projectIDs.length) {
              deliverablesModel.setProperty("/selectedProjectIDs", projectIDs);
            }
          }
        },

        _syncDeliverablePeriod: function () {
          const model = this.getView().getModel("deliverables");
          const period = this.byId("reportPeriod");
          if (!model || !period) return;

          const from = period.getDateValue();
          const to = period.getSecondDateValue();

          if (!from || !to) {
            model.setProperty("/periodText", "Periodo no definido");
            return;
          }

          const formatter = new Intl.DateTimeFormat("es-CO", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          });

          model.setProperty(
            "/periodText",
            `${formatter.format(from)} – ${formatter.format(to)}`,
          );
        },

        _updateDeliverableProjectSelectionAction: function () {
          const model = this.getView().getModel("deliverables");
          if (!model) return;

          const available = model.getProperty("/availableProjects") || [];
          const selected = model.getProperty("/selectedProjectIDs") || [];
          const allSelected =
            available.length > 0 && selected.length === available.length;

          model.setProperty(
            "/projectSelectionButtonText",
            allSelected ? "Desmarcar todos" : "Seleccionar todos",
          );
          model.setProperty(
            "/projectSelectionButtonIcon",
            allSelected ? "sap-icon://clear-all" : "sap-icon://multi-select",
          );
        },

        _refreshDeliverableProjects: function () {
          const deliverablesModel = this.getView().getModel("deliverables");
          const lookupModel = this.getView().getModel("lookups");
          const period = this.byId("reportPeriod");
          if (!deliverablesModel || !lookupModel || !period) return;

          const clientID = deliverablesModel.getProperty("/selectedClientID");
          const from = period.getDateValue();
          const to = period.getSecondDateValue();

          if (!clientID) {
            deliverablesModel.setProperty("/availableProjects", []);
            deliverablesModel.setProperty("/selectedProjectIDs", []);
            deliverablesModel.setProperty(
              "/projectAvailabilityText",
              "Seleccione un cliente para consultar sus proyectos vigentes.",
            );
            this._updateDeliverableProjectSelectionAction();
            return;
          }

          const projects = (lookupModel.getProperty("/projects") || []).filter(
            (project) => {
              return (
                project.client_ID === clientID && project.status === "ACTIVE"
              );
            },
          );

          deliverablesModel.setProperty("/availableProjects", projects);

          const validIDs = new Set(projects.map((project) => project.ID));
          const selected = (
            deliverablesModel.getProperty("/selectedProjectIDs") || []
          ).filter((ID) => validIDs.has(ID));
          deliverablesModel.setProperty("/selectedProjectIDs", selected);

          deliverablesModel.setProperty(
            "/projectAvailabilityText",
            projects.length
              ? `${projects.length} proyecto(s) activo(s) disponibles para el cliente seleccionado.`
              : "El cliente no tiene proyectos activos disponibles.",
          );

          this._updateDeliverableProjectSelectionAction();
        },

        onDeliverableClientChange: function (event) {
          const model = this.getView().getModel("deliverables");
          model.setProperty(
            "/selectedClientID",
            event.getSource().getSelectedKey(),
          );
          model.setProperty("/selectedProjectIDs", []);
          this._refreshDeliverableProjects();
        },

        onDeliverableProjectsChange: function (event) {
          this.getView()
            .getModel("deliverables")
            .setProperty(
              "/selectedProjectIDs",
              event
                .getSource()
                .getSelectedItems()
                .map((item) => item.getKey()),
            );

          this._updateDeliverableProjectSelectionAction();
        },

        onToggleAllDeliverableProjects: function () {
          const model = this.getView().getModel("deliverables");
          const control = this.byId("deliverableProjects");
          if (!model || !control) return;

          const available = model.getProperty("/availableProjects") || [];
          if (!available.length) return;

          const selected = model.getProperty("/selectedProjectIDs") || [];
          const allSelected = selected.length === available.length;

          const nextSelection = allSelected
            ? []
            : available.map((project) => project.ID);

          model.setProperty("/selectedProjectIDs", nextSelection);
          control.setSelectedKeys(nextSelection);

          this._updateDeliverableProjectSelectionAction();
        },

        onDeliverableTypeSelect: function (event) {
          const model = this.getView().getModel("deliverables");
          const index = event.getParameter("selectedIndex");
          const detailed = index === 1;

          model.setProperty("/formatIndex", index);
          model.setProperty("/formatType", detailed ? "DETAILED" : "SUMMARY");
          model.setProperty("/showEvidenceOption", detailed);

          if (!detailed) model.setProperty("/includeEvidence", false);
        },

        onDeliverableEvidenceChange: function (event) {
          this.getView()
            .getModel("deliverables")
            .setProperty("/includeEvidence", event.getParameter("state"));
        },

        onGenerateDeliverable: async function () {
          const deliverablesModel = this.getView().getModel("deliverables");
          const clientID = deliverablesModel.getProperty("/selectedClientID");
          const projectIDs =
            deliverablesModel.getProperty("/selectedProjectIDs") || [];
          const formatType =
            deliverablesModel.getProperty("/formatType") || "SUMMARY";
          const includeEvidence = Boolean(
            deliverablesModel.getProperty("/includeEvidence"),
          );
          const periodControl = this.byId("reportPeriod");
          const dateFrom = periodControl?.getDateValue();
          const dateTo = periodControl?.getSecondDateValue();

          if (!dateFrom || !dateTo) {
            MessageBox.warning(
              "Seleccione primero el periodo del entregable en los criterios superiores.",
            );
            return;
          }
          if (!clientID) {
            MessageBox.warning("Seleccione el cliente del entregable.");
            return;
          }
          if (!projectIDs.length) {
            MessageBox.warning(
              "Seleccione al menos un proyecto para el entregable.",
            );
            return;
          }

          const button = this.byId("generateDeliverableButton");
          if (button) button.setBusy(true);

          try {
            const model = this.getView().getModel();
            const operation = model.bindContext("/generateDeliverable(...)");
            operation.setParameter("dateFrom", this._formatDate(dateFrom));
            operation.setParameter("dateTo", this._formatDate(dateTo));
            operation.setParameter("clientID", clientID);
            operation.setParameter(
              "projectIDsJson",
              JSON.stringify(projectIDs),
            );
            operation.setParameter("formatType", formatType);
            operation.setParameter("includeEvidence", includeEvidence);

            await operation.execute();
            const result = operation.getBoundContext()?.getObject();

            if (!result?.contentBase64 || !result?.fileName) {
              throw new Error("El servicio no devolvió el archivo generado.");
            }

            this._downloadBase64File(
              result.contentBase64,
              result.mimeType || "application/octet-stream",
              result.fileName,
            );

            const pieces = [
              `${Number(result.entryCount || 0)} registro(s) incluidos`,
            ];
            if (Number(result.evidenceCount || 0) > 0) {
              pieces.push(`${Number(result.evidenceCount)} evidencia(s)`);
            }

            MessageToast.show(`Entregable generado: ${pieces.join(" · ")}.`);

            if (result.warningText) {
              MessageBox.warning(result.warningText, {
                title: "Entregable generado con advertencias",
              });
            }
          } catch (error) {
            console.error("No fue posible generar el entregable:", error);
            MessageBox.error(
              error?.message ||
                "No fue posible generar el entregable solicitado.",
            );
          } finally {
            if (button) button.setBusy(false);
          }
        },

        _downloadBase64File: function (base64, mimeType, fileName) {
          const binary = window.atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
          }

          const blob = new Blob([bytes], {
            type: mimeType || "application/octet-stream",
          });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = fileName || "entregable";
          anchor.style.display = "none";
          document.body.appendChild(anchor);
          anchor.click();
          document.body.removeChild(anchor);
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        },

        onApplyFilters: async function () {
          const periodControl = this.byId("reportPeriod");
          const dateFrom = periodControl.getDateValue();
          const dateTo = periodControl.getSecondDateValue();

          if (!dateFrom || !dateTo) {
            periodControl.setValueState("Error");
            periodControl.setValueStateText("El periodo es obligatorio.");

            MessageBox.warning(
              "Seleccione la fecha inicial y final del reporte.",
            );

            return;
          }

          periodControl.setValueState("None");

          const button = this.byId("applyDashboardFilters");

          button.setBusy(true);

          try {
            const filters = {
              dateFrom: this._formatDate(dateFrom),
              dateTo: this._formatDate(dateTo),

              clientIDs: this._getTokenKeys("clientFilter"),

              projectIDs: this._getTokenKeys("projectFilter"),

              employeeIDs: this._getTokenKeys("employeeFilter"),

              statusIDs: this._getTokenKeys("statusFilter"),
            };

            const [result, analytics, dailyDetails] = await Promise.all([
              this._requestDashboardSummary(filters),
              this._requestDashboardAnalytics(filters),
              this._requestDailyDetails(filters),
            ]);

            this.getView()
              .getModel("dashboard")
              .setData({
                totalHours: this._formatNumber(result.totalHours),
                billableHours: this._formatNumber(result.billableHours),
                approvedHours: this._formatNumber(result.approvedHours),
                pendingHours: this._formatNumber(result.pendingHours),
                employeeCount: Number(result.employeeCount || 0),
                projectCount: Number(result.projectCount || 0),
                clientCount: Number(result.clientCount || 0),
                entryCount: Number(result.entryCount || 0),
              });

            this.getView().getModel("analytics").setData(analytics);

            this.getView().getModel("report").setData({
              dailyDetails: dailyDetails,
              loaded: true,
              count: dailyDetails.length,
              tableSettingsActive: false,
            });

            this._buildConsolidatedReports(dailyDetails);
            this._buildExecutiveDashboard(dailyDetails, result, filters);

            this._dailyTableSettings = null;
            this._applyDailyTableSettings();

            MessageToast.show("Reporte actualizado correctamente.");
          } catch (error) {
            console.error("Error consultando el resumen:", error);

            MessageBox.error(
              error?.message ||
                "No fue posible consultar el resumen de tiempos.",
            );
          } finally {
            button.setBusy(false);
          }
        },

        onSelectAllClients: function () {
          if (!this._clientValueHelpList) {
            return;
          }

          this._clientValueHelpList.getItems().forEach((item) => {
            item.setSelected(true);
          });
        },

        onClearAllClients: function () {
          if (!this._clientValueHelpList) {
            return;
          }

          this._clientValueHelpList.removeSelections(true);
        },

        _requestDashboardSummary: async function (parameters) {
          const model = this.getView().getModel();

          const operation = model.bindContext("/getDashboardSummary(...)");

          operation.setParameter("dateFrom", parameters.dateFrom);

          operation.setParameter("dateTo", parameters.dateTo);

          operation.setParameter(
            "clientIDsJson",
            JSON.stringify(parameters.clientIDs || []),
          );

          operation.setParameter(
            "projectIDsJson",
            JSON.stringify(parameters.projectIDs || []),
          );

          operation.setParameter(
            "employeeIDsJson",
            JSON.stringify(parameters.employeeIDs || []),
          );

          operation.setParameter(
            "statusIDsJson",
            JSON.stringify(parameters.statusIDs || []),
          );

          await operation.execute();

          return operation.getBoundContext().getObject();
        },

        _requestDashboardAnalytics: async function (parameters) {
          const model = this.getView().getModel();

          const operation = model.bindContext("/getDashboardAnalytics(...)");

          operation.setParameter("dateFrom", parameters.dateFrom);

          operation.setParameter("dateTo", parameters.dateTo);

          operation.setParameter(
            "clientIDsJson",
            JSON.stringify(parameters.clientIDs || []),
          );

          operation.setParameter(
            "projectIDsJson",
            JSON.stringify(parameters.projectIDs || []),
          );

          operation.setParameter(
            "employeeIDsJson",
            JSON.stringify(parameters.employeeIDs || []),
          );

          operation.setParameter(
            "statusIDsJson",
            JSON.stringify(parameters.statusIDs || []),
          );

          await operation.execute();

          const response = operation.getBoundContext().getObject();

          if (!response?.dataJson) {
            return {
              summary: {},
              byClient: [],
              byProject: [],
              byEmployee: [],
              byStatus: [],
              byDay: [],
            };
          }

          try {
            const analytics = JSON.parse(response.dataJson);

            analytics.byClient = (analytics.byClient || []).slice(0, 10);

            analytics.byDay = (analytics.byDay || []).slice(-31);

            return analytics;
          } catch (error) {
            console.error("No fue posible interpretar la analítica:", error);

            throw new Error(
              "El servicio devolvió una respuesta analítica inválida.",
            );
          }
        },

        _requestDailyDetails: async function (parameters) {
          const model = this.getView().getModel();

          const filters = [
            new Filter(
              "workDate",
              FilterOperator.BT,
              parameters.dateFrom,
              parameters.dateTo,
            ),
          ];

          const addMultiFilter = function (path, values) {
            if (!Array.isArray(values) || values.length === 0) {
              return;
            }

            filters.push(
              new Filter({
                filters: values.map(
                  (value) => new Filter(path, FilterOperator.EQ, value),
                ),
                and: false,
              }),
            );
          };

          addMultiFilter("client_ID", parameters.clientIDs);

          addMultiFilter("project_ID", parameters.projectIDs);

          addMultiFilter("employee_ID", parameters.employeeIDs);

          addMultiFilter("entryStatus", parameters.statusIDs);

          const binding = model.bindList(
            "/TimeDetails",
            null,
            [new Sorter("workDate", true), new Sorter("employeeName", false)],
            filters,
            {
              $select: [
                "ID",
                "workDate",
                "employeeName",
                "clientName",
                "projectName",
                "approximateStartTime",
                "approximateEndTime",
                "description",
                "requestedTypeText",
                "registeredHours",
                "billableHours",
                "entryStatus",
                "entryStatusText",
                "entryStatusCriticality",
                "commercialTreatmentText",
                "dailyHoursWarning",
                "evidenceRequired",
              ].join(","),
            },
          );

          const contexts = await binding.requestContexts(0, 5000);

          return contexts.map((context) => context.getObject());
        },
        _buildExecutiveDashboard: function (dailyDetails, summary, filters) {
          const rows = Array.isArray(dailyDetails) ? dailyDetails : [];
          const approvedStatuses = new Set([
            "LEADER_APPROVED",
            "INTERNALLY_APPROVED",
            "CLOSED",
            "INVOICED",
          ]);

          const toNumber = function (value) {
            const number = Number(value || 0);
            return Number.isFinite(number) ? number : 0;
          };

          const totalHours = toNumber(summary?.totalHours);
          const billableHours = toNumber(summary?.billableHours);
          const billablePercentage =
            totalHours > 0
              ? Math.min(100, (billableHours / totalHours) * 100)
              : 0;

          const parseIsoDate = function (value) {
            const text = String(value || "").slice(0, 10);
            const parts = text.split("-");
            if (parts.length !== 3) {
              return null;
            }
            return new Date(
              Number(parts[0]),
              Number(parts[1]) - 1,
              Number(parts[2]),
            );
          };

          const startDate = parseIsoDate(filters?.dateFrom);
          const endDate = parseIsoDate(filters?.dateTo);

          const formatShortDate = function (date) {
            if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
              return "";
            }
            return date.toLocaleDateString("es-CO", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            });
          };

          const periodText =
            startDate && endDate
              ? `${formatShortDate(startDate)} – ${formatShortDate(endDate)}`
              : "Periodo seleccionado";

          const weekMap = new Map();
          const projectMap = new Map();
          const employeeMap = new Map();
          const pendingMap = new Map();

          let pendingEntryCount = 0;
          let unclassifiedEntryCount = 0;
          let unclassifiedHours = 0;

          rows.forEach(function (row) {
            const hours = toNumber(row.registeredHours);
            const status = String(row.entryStatus || "");
            const isVoided = status === "VOIDED";
            const isApproved = approvedStatuses.has(status);
            const isPending = !isVoided && !isApproved;

            if (isPending) {
              pendingEntryCount += 1;
            }

            const commercialText = String(row.commercialTreatmentText || "")
              .trim()
              .toLowerCase();

            const isUnclassified =
              !commercialText ||
              commercialText.includes("pendiente") ||
              commercialText.includes("sin clas");

            if (!isVoided && isUnclassified) {
              unclassifiedEntryCount += 1;
              unclassifiedHours += hours;
            }

            const projectName = row.projectName || "Sin proyecto";
            projectMap.set(
              projectName,
              (projectMap.get(projectName) || 0) + hours,
            );

            const employeeName = row.employeeName || "Sin empleado";
            employeeMap.set(
              employeeName,
              (employeeMap.get(employeeName) || 0) + hours,
            );

            if (isPending) {
              const pendingKey = `${employeeName}||${projectName}`;
              if (!pendingMap.has(pendingKey)) {
                pendingMap.set(pendingKey, {
                  employeeName: employeeName,
                  projectName: projectName,
                  hours: 0,
                  entryCount: 0,
                });
              }
              const pending = pendingMap.get(pendingKey);
              pending.hours += hours;
              pending.entryCount += 1;
            }

            const workDate = parseIsoDate(row.workDate);
            if (workDate && startDate) {
              const dayDiff = Math.floor(
                (new Date(
                  workDate.getFullYear(),
                  workDate.getMonth(),
                  workDate.getDate(),
                ) -
                  new Date(
                    startDate.getFullYear(),
                    startDate.getMonth(),
                    startDate.getDate(),
                  )) /
                  86400000,
              );

              const weekIndex = Math.floor(Math.max(0, dayDiff) / 7) + 1;
              const key = `S${weekIndex}`;
              weekMap.set(key, (weekMap.get(key) || 0) + hours);
            }
          });

          const weeklyHours = Array.from(weekMap.entries())
            .map(function ([week, hours]) {
              return {
                week: week,
                hours: hours,
              };
            })
            .sort(function (a, b) {
              return Number(a.week.slice(1)) - Number(b.week.slice(1));
            });

          const projectHoursRaw = Array.from(projectMap.entries())
            .map(function ([name, hours]) {
              return { name: name, hours: hours };
            })
            .sort(function (a, b) {
              return b.hours - a.hours;
            })
            .slice(0, 8);

          const maxProjectHours = Math.max(
            1,
            ...projectHoursRaw.map(function (row) {
              return row.hours;
            }),
          );

          const formatShare = function (hours) {
            if (!(totalHours > 0)) {
              return "0%";
            }
            return `${((hours / totalHours) * 100).toLocaleString("es-CO", {
              minimumFractionDigits: 0,
              maximumFractionDigits: 1,
            })}%`;
          };

          const projectHours = projectHoursRaw.map(function (row) {
            return Object.assign({}, row, {
              relativePercentage: Math.min(
                100,
                (row.hours / maxProjectHours) * 100,
              ),
              shareText: formatShare(row.hours),
            });
          });

          const employeeHoursRaw = Array.from(employeeMap.entries())
            .map(function ([name, hours]) {
              return { name: name, hours: hours };
            })
            .sort(function (a, b) {
              return b.hours - a.hours;
            })
            .slice(0, 8);

          const maxEmployeeHours = Math.max(
            1,
            ...employeeHoursRaw.map(function (row) {
              return row.hours;
            }),
          );

          const avatarColors = [
            "Accent6",
            "Accent8",
            "Accent1",
            "Accent10",
            "Accent4",
            "Accent2",
            "Accent7",
            "Accent3",
          ];

          const buildInitials = function (name) {
            return String(name || "")
              .trim()
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map(function (part) {
                return part.charAt(0).toUpperCase();
              })
              .join("");
          };

          const employeeHours = employeeHoursRaw.map(function (row, index) {
            return Object.assign({}, row, {
              relativePercentage: Math.min(
                100,
                (row.hours / maxEmployeeHours) * 100,
              ),
              shareText: formatShare(row.hours),
              initials: buildInitials(row.name),
              avatarColor: avatarColors[index % avatarColors.length],
            });
          });

          const legendColors = [
            "#1B90FF",
            "#E76500",
            "#36A41D",
            "#7858FF",
            "#FA4F96",
            "#0F828F",
          ];

          const clientRows =
            this.getView().getModel("analytics").getProperty("/byClient") || [];

          const clientLegend = clientRows
            .slice(0, legendColors.length)
            .map(function (row, index) {
              const hours = toNumber(row.registeredHours);
              return {
                name: row.name,
                hours: hours,
                color: legendColors[index],
                shareText: `${formatShare(hours)} (${hours.toLocaleString(
                  "es-CO",
                  { minimumFractionDigits: 0, maximumFractionDigits: 2 },
                )} h)`,
              };
            });

          const monthlyTargetHours = this._getMonthlyTargetHours(
            startDate,
            endDate,
          );

          const monthlyTargetPercentage =
            monthlyTargetHours > 0
              ? Math.min(100, (totalHours / monthlyTargetHours) * 100)
              : 0;

          const monthlyTargetText = `${monthlyTargetPercentage.toLocaleString(
            "es-CO",
            { minimumFractionDigits: 0, maximumFractionDigits: 0 },
          )}% del objetivo mensual (${monthlyTargetHours.toLocaleString(
            "es-CO",
            { minimumFractionDigits: 0, maximumFractionDigits: 0 },
          )} h)`;

          const pendingApprovals = Array.from(pendingMap.values())
            .sort(function (a, b) {
              return b.hours - a.hours;
            })
            .slice(0, 6);

          this.getView().getModel("executive").setData({
            periodText: periodText,
            billablePercentage: billablePercentage,
            billableHours: billableHours,
            pendingEntryCount: pendingEntryCount,
            unclassifiedEntryCount: unclassifiedEntryCount,
            unclassifiedHours: unclassifiedHours,
            weeklyHours: weeklyHours,
            projectHours: projectHours,
            employeeHours: employeeHours,
            clientLegend: clientLegend,
            monthlyTargetHours: monthlyTargetHours,
            monthlyTargetPercentage: monthlyTargetPercentage,
            monthlyTargetText: monthlyTargetText,
            pendingApprovals: pendingApprovals,
          });
        },

        /**
         * Objetivo de horas del periodo: días hábiles (lun-vie) x 8 h x número
         * de empleados con registros. Sirve de referencia para el avance del KPI.
         */
        _getMonthlyTargetHours: function (startDate, endDate) {
          const HOURS_PER_DAY = 8;
          const employeeCount = Math.max(
            1,
            Number(
              this.getView()
                .getModel("dashboard")
                .getProperty("/employeeCount"),
            ) || 1,
          );

          if (
            !(startDate instanceof Date) ||
            !(endDate instanceof Date) ||
            Number.isNaN(startDate.getTime()) ||
            Number.isNaN(endDate.getTime()) ||
            endDate < startDate
          ) {
            return 0;
          }

          let businessDays = 0;
          const cursor = new Date(startDate.getTime());

          while (cursor <= endDate) {
            const day = cursor.getDay();
            if (day !== 0 && day !== 6) {
              businessDays += 1;
            }
            cursor.setDate(cursor.getDate() + 1);
          }

          return businessDays * HOURS_PER_DAY * employeeCount;
        },

        onProjectBarPress: function (event) {
          this._openBreakdownPopover(event, "project");
        },

        onEmployeeBarPress: function (event) {
          this._openBreakdownPopover(event, "employee");
        },

        /**
         * Abre un popover con el desglose de la barra pulsada. Todo se calcula
         * en cliente a partir de los registros ya cargados en el modelo
         * "report" (/dailyDetails), sin llamadas adicionales al backend.
         *
         * @param {sap.ui.base.Event} event evento press del CustomListItem
         * @param {string} mode "project" (desglosa por empleado) o
         *                      "employee" (desglosa por proyecto)
         */
        _openBreakdownPopover: function (event, mode) {
          const source = event.getSource();
          const context = source.getBindingContext("executive");

          if (!context) {
            return;
          }

          const name = context.getProperty("name");
          const data = this._buildBreakdown(name, mode);

          if (!data) {
            return;
          }

          this.getView().getModel("breakdown").setData(data);

          const openPopover = function (popover) {
            popover.openBy(source);
          };

          if (this._breakdownPopover) {
            openPopover(this._breakdownPopover);
            return;
          }

          Fragment.load({
            id: this.getView().getId(),
            name: "sabnez.com.reportestiemposui.ext.main.BreakdownPopover",
            controller: this,
          }).then(
            function (popover) {
              this._breakdownPopover = popover;
              this.getView().addDependent(popover);
              openPopover(popover);
            }.bind(this),
          );
        },

        onCloseBreakdown: function () {
          if (this._breakdownPopover) {
            this._breakdownPopover.close();
          }
        },

        _buildBreakdown: function (name, mode) {
          const rows =
            this.getView().getModel("report").getProperty("/dailyDetails") ||
            [];

          const isProject = mode === "project";
          const matchField = isProject ? "projectName" : "employeeName";
          const groupField = isProject ? "employeeName" : "projectName";

          const toNumber = function (value) {
            const number = Number(value || 0);
            return Number.isFinite(number) ? number : 0;
          };

          const approvedStatuses = new Set([
            "LEADER_APPROVED",
            "INTERNALLY_APPROVED",
            "CLOSED",
            "INVOICED",
          ]);

          const matching = rows.filter(function (row) {
            return String(row[matchField] || "Sin información") === name;
          });

          const groups = new Map();
          const clients = new Set();

          let totalHours = 0;
          let billableHours = 0;
          let pendingHours = 0;

          matching.forEach(function (row) {
            const hours = toNumber(row.registeredHours);
            const status = String(row.entryStatus || "");

            totalHours += hours;
            billableHours += toNumber(row.billableHours);

            if (status !== "VOIDED" && !approvedStatuses.has(status)) {
              pendingHours += hours;
            }

            if (row.clientName) {
              clients.add(row.clientName);
            }

            const key = String(row[groupField] || "Sin información");
            if (!groups.has(key)) {
              groups.set(key, { name: key, hours: 0, entryCount: 0 });
            }
            const group = groups.get(key);
            group.hours += hours;
            group.entryCount += 1;
          });

          const formatHours = function (value) {
            return `${value.toLocaleString("es-CO", {
              minimumFractionDigits: 0,
              maximumFractionDigits: 2,
            })} h`;
          };

          const items = Array.from(groups.values())
            .sort(function (a, b) {
              return b.hours - a.hours;
            })
            .map(function (group) {
              return Object.assign({}, group, {
                hoursText: formatHours(group.hours),
                sharePercentage:
                  totalHours > 0
                    ? Math.min(100, (group.hours / totalHours) * 100)
                    : 0,
                shareText:
                  totalHours > 0
                    ? `${((group.hours / totalHours) * 100).toLocaleString(
                        "es-CO",
                        { minimumFractionDigits: 0, maximumFractionDigits: 1 },
                      )}%`
                    : "0%",
              });
            });

          const clientList = Array.from(clients);

          return {
            title: name,
            subtitle: isProject
              ? "Desglose por empleado"
              : "Desglose por proyecto",
            contextLabel: isProject ? "Cliente" : "Clientes",
            contextValue: clientList.length
              ? clientList.slice(0, 3).join(", ") +
                (clientList.length > 3 ? ` +${clientList.length - 3}` : "")
              : "Sin cliente",
            totalHoursText: formatHours(totalHours),
            billableHoursText: formatHours(billableHours),
            pendingHoursText: formatHours(pendingHours),
            entryCount: matching.length,
            hasPending: pendingHours > 0,
            items: items,
          };
        },

        onGoToDailyDetail: function () {
          const tabs = this.byId("reportTabs");
          if (tabs) {
            tabs.setSelectedKey("daily");
          }
        },

        _buildConsolidatedReports: function (dailyDetails) {
          const rows = Array.isArray(dailyDetails) ? dailyDetails : [];
          const approvedStatuses = new Set([
            "LEADER_APPROVED",
            "INTERNALLY_APPROVED",
            "CLOSED",
            "INVOICED",
          ]);

          const toNumber = function (value) {
            const number = Number(value || 0);
            return Number.isFinite(number) ? number : 0;
          };

          const ensureBucket = function (map, key, seed) {
            const safeKey = String(key || "Sin información");
            if (!map.has(safeKey)) {
              map.set(
                safeKey,
                Object.assign(
                  {
                    name: safeKey,
                    registeredHours: 0,
                    billableHours: 0,
                    approvedHours: 0,
                    pendingHours: 0,
                    entryCount: 0,
                    employees: new Set(),
                    projects: new Set(),
                    clients: new Set(),
                  },
                  seed || {},
                ),
              );
            }
            return map.get(safeKey);
          };

          const employees = new Map();
          const projects = new Map();
          const clients = new Map();

          rows.forEach(function (row) {
            const registeredHours = toNumber(row.registeredHours);
            const billableHours = toNumber(row.billableHours);
            const status = String(row.entryStatus || "");
            const isVoided = status === "VOIDED";
            const isApproved = approvedStatuses.has(status);
            const approvedHours = !isVoided && isApproved ? registeredHours : 0;
            const pendingHours = !isVoided && !isApproved ? registeredHours : 0;

            const employee = ensureBucket(
              employees,
              row.employeeName || "Sin empleado",
            );
            employee.registeredHours += registeredHours;
            employee.billableHours += billableHours;
            employee.approvedHours += approvedHours;
            employee.pendingHours += pendingHours;
            employee.entryCount += 1;
            if (row.clientName) employee.clients.add(row.clientName);
            if (row.projectName) employee.projects.add(row.projectName);

            const project = ensureBucket(
              projects,
              row.projectName || "Sin proyecto",
            );
            project.registeredHours += registeredHours;
            project.billableHours += billableHours;
            project.approvedHours += approvedHours;
            project.pendingHours += pendingHours;
            project.entryCount += 1;
            if (row.employeeName) project.employees.add(row.employeeName);
            if (row.clientName) project.clients.add(row.clientName);

            const client = ensureBucket(
              clients,
              row.clientName || "Sin cliente",
            );
            client.registeredHours += registeredHours;
            client.billableHours += billableHours;
            client.approvedHours += approvedHours;
            client.pendingHours += pendingHours;
            client.entryCount += 1;
            if (row.employeeName) client.employees.add(row.employeeName);
            if (row.projectName) client.projects.add(row.projectName);
          });

          const finalize = function (bucket) {
            const total = toNumber(bucket.registeredHours);
            const approved = toNumber(bucket.approvedHours);
            const billable = toNumber(bucket.billableHours);
            return {
              name: bucket.name,
              registeredHours: total,
              billableHours: billable,
              approvedHours: approved,
              pendingHours: toNumber(bucket.pendingHours),
              entryCount: bucket.entryCount,
              employeeCount: bucket.employees.size,
              projectCount: bucket.projects.size,
              clientCount: bucket.clients.size,
              employeeNames: Array.from(bucket.employees).join(", "),
              projectNames: Array.from(bucket.projects).join(", "),
              clientNames: Array.from(bucket.clients).join(", "),
              approvalPercentage:
                total > 0 ? Math.min(100, (approved / total) * 100) : 0,
              billablePercentage:
                total > 0 ? Math.min(100, (billable / total) * 100) : 0,
            };
          };

          const employeeRows = Array.from(employees.values())
            .map(finalize)
            .sort((a, b) => b.registeredHours - a.registeredHours);

          const projectRows = Array.from(projects.values())
            .map(finalize)
            .sort((a, b) => b.registeredHours - a.registeredHours);

          const clientRows = Array.from(clients.values())
            .map(finalize)
            .sort((a, b) => b.registeredHours - a.registeredHours);

          const complianceRows = employeeRows.map(function (row) {
            return Object.assign({}, row, {
              complianceText:
                row.pendingHours > 0 ? "Requiere gestión" : "Al día",
              complianceState: row.pendingHours > 0 ? "Warning" : "Success",
            });
          });

          this.getView().getModel("consolidated").setData({
            employees: employeeRows,
            projects: projectRows,
            clients: clientRows,
            compliance: complianceRows,
            employeeCount: employeeRows.length,
            projectCount: projectRows.length,
            clientCount: clientRows.length,
            complianceCount: complianceRows.length,
          });
        },

        formatPercentage: function (value) {
          return `${Number(value || 0).toLocaleString("es-CO", {
            minimumFractionDigits: 0,
            maximumFractionDigits: 1,
          })} %`;
        },

        onExportConsolidated: function (event) {
          const source = event.getSource();
          const reportType = source.data("reportType");
          const model = this.getView().getModel("consolidated");

          const definitions = {
            employee: {
              path: "/employees",
              fileName: "Tiempos_por_empleado.xlsx",
              columns: [
                { label: "Empleado", property: "name", type: "string" },
                {
                  label: "Horas registradas",
                  property: "registeredHours",
                  type: "number",
                  scale: 2,
                },
                {
                  label: "Horas facturables",
                  property: "billableHours",
                  type: "number",
                  scale: 2,
                },
                {
                  label: "Horas aprobadas",
                  property: "approvedHours",
                  type: "number",
                  scale: 2,
                },
                {
                  label: "Horas pendientes",
                  property: "pendingHours",
                  type: "number",
                  scale: 2,
                },
                { label: "Clientes", property: "clientCount", type: "number" },
                {
                  label: "Proyectos",
                  property: "projectCount",
                  type: "number",
                },
                { label: "Registros", property: "entryCount", type: "number" },
                {
                  label: "% aprobación",
                  property: "approvalPercentage",
                  type: "number",
                  scale: 1,
                },
              ],
            },
            project: {
              path: "/projects",
              fileName: "Tiempos_por_proyecto.xlsx",
              columns: [
                { label: "Proyecto", property: "name", type: "string" },
                { label: "Cliente", property: "clientNames", type: "string" },
                {
                  label: "Empleados",
                  property: "employeeCount",
                  type: "number",
                },
                {
                  label: "Horas registradas",
                  property: "registeredHours",
                  type: "number",
                  scale: 2,
                },
                {
                  label: "Horas facturables",
                  property: "billableHours",
                  type: "number",
                  scale: 2,
                },
                {
                  label: "Horas aprobadas",
                  property: "approvedHours",
                  type: "number",
                  scale: 2,
                },
                {
                  label: "Horas pendientes",
                  property: "pendingHours",
                  type: "number",
                  scale: 2,
                },
                { label: "Registros", property: "entryCount", type: "number" },
              ],
            },
            client: {
              path: "/clients",
              fileName: "Tiempos_por_cliente.xlsx",
              columns: [
                { label: "Cliente", property: "name", type: "string" },
                {
                  label: "Proyectos",
                  property: "projectCount",
                  type: "number",
                },
                {
                  label: "Empleados",
                  property: "employeeCount",
                  type: "number",
                },
                {
                  label: "Horas registradas",
                  property: "registeredHours",
                  type: "number",
                  scale: 2,
                },
                {
                  label: "Horas facturables",
                  property: "billableHours",
                  type: "number",
                  scale: 2,
                },
                {
                  label: "Horas aprobadas",
                  property: "approvedHours",
                  type: "number",
                  scale: 2,
                },
                {
                  label: "Horas pendientes",
                  property: "pendingHours",
                  type: "number",
                  scale: 2,
                },
                { label: "Registros", property: "entryCount", type: "number" },
              ],
            },
            compliance: {
              path: "/compliance",
              fileName: "Cumplimiento_tiempos.xlsx",
              columns: [
                { label: "Empleado", property: "name", type: "string" },
                {
                  label: "Horas registradas",
                  property: "registeredHours",
                  type: "number",
                  scale: 2,
                },
                {
                  label: "Horas aprobadas",
                  property: "approvedHours",
                  type: "number",
                  scale: 2,
                },
                {
                  label: "Horas pendientes",
                  property: "pendingHours",
                  type: "number",
                  scale: 2,
                },
                {
                  label: "Horas facturables",
                  property: "billableHours",
                  type: "number",
                  scale: 2,
                },
                {
                  label: "% aprobación",
                  property: "approvalPercentage",
                  type: "number",
                  scale: 1,
                },
                {
                  label: "% facturable",
                  property: "billablePercentage",
                  type: "number",
                  scale: 1,
                },
                { label: "Estado", property: "complianceText", type: "string" },
              ],
            },
          };

          const definition = definitions[reportType];
          if (!definition) {
            MessageToast.show("Tipo de reporte no reconocido.");
            return;
          }

          const rows = model.getProperty(definition.path) || [];
          if (!rows.length) {
            MessageToast.show("No hay datos para exportar.");
            return;
          }

          const spreadsheet = new Spreadsheet({
            workbook: { columns: definition.columns },
            dataSource: rows,
            fileName: definition.fileName,
            worker: false,
          });

          spreadsheet.build().finally(function () {
            spreadsheet.destroy();
          });
        },

        _formatDate: function (date) {
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, "0");
          const day = String(date.getDate()).padStart(2, "0");

          return `${year}-${month}-${day}`;
        },

        _formatNumber: function (value) {
          return Number(value || 0).toLocaleString("es-CO", {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2,
          });
        },

        onClearFilters: function () {
          const clientFilter = this.byId("clientFilter");
          const projectFilter = this.byId("projectFilter");
          const employeeFilter = this.byId("employeeFilter");
          const statusFilter = this.byId("statusFilter");

          if (clientFilter) {
            clientFilter.removeAllTokens();
            clientFilter.setValue("");
          }

          if (projectFilter) {
            projectFilter.removeAllTokens();
            projectFilter.setValue("");
          }

          if (employeeFilter) {
            employeeFilter.removeAllTokens();
            employeeFilter.setValue("");
          }

          if (statusFilter) {
            statusFilter.removeAllTokens();
            statusFilter.setValue("");
          }

          const lookupModel = this.getView().getModel("lookups");

          lookupModel.setProperty(
            "/filteredProjects",
            lookupModel.getProperty("/projects") || [],
          );

          if (this._clientValueHelpList) {
            this._clientValueHelpList.removeSelections(true);
          }

          if (this._projectValueHelpList) {
            this._projectValueHelpList.removeSelections(true);
          }

          if (this._employeeValueHelpList) {
            this._employeeValueHelpList.removeSelections(true);
          }

          if (this._statusValueHelpList) {
            this._statusValueHelpList.removeSelections(true);
          }

          this._setDefaultPeriod();

          this.getView().getModel("dashboard").setData({
            totalHours: "—",
            billableHours: "—",
            approvedHours: "—",
            pendingHours: "—",
            employeeCount: "—",
            projectCount: "—",
            clientCount: "—",
            entryCount: "—",
          });

          this.getView()
            .getModel("analytics")
            .setData({
              summary: {
                totalHours: 0,
                billableHours: 0,
                billablePercentage: 0,
              },
              byClient: [],
              byProject: [],
              byEmployee: [],
              byStatus: [],
              byDay: [],
            });

          this.getView().getModel("executive").setData({
            periodText: "Periodo seleccionado",
            billablePercentage: 0,
            billableHours: 0,
            pendingEntryCount: 0,
            unclassifiedEntryCount: 0,
            unclassifiedHours: 0,
            weeklyHours: [],
            projectHours: [],
            employeeHours: [],
            clientLegend: [],
            monthlyTargetHours: 0,
            monthlyTargetPercentage: 0,
            monthlyTargetText: "Sin objetivo calculado",
            pendingApprovals: [],
          });

          this.getView().getModel("report").setData({
            dailyDetails: [],
            loaded: false,
            count: 0,
          });
        },

        onEmployeeValueHelp: function () {
          if (!this._employeeValueHelpDialog) {
            this._employeeValueHelpList = new List({
              mode: "MultiSelect",
              includeItemInSelection: true,
              growing: true,
              growingThreshold: 100,
            });

            this._employeeValueHelpList.setModel(
              this.getView().getModel("lookups"),
              "lookups",
            );

            this._employeeValueHelpList.bindItems({
              path: "lookups>/employees",
              template: new StandardListItem({
                title: "{lookups>employeeName}",
                description: "{lookups>employeeCode}",
                type: "Active",
              }),
            });

            const searchField = new SearchField({
              width: "100%",
              placeholder: "Buscar empleado",
              liveChange: this.onEmployeeValueHelpSearch.bind(this),
            });

            this._employeeValueHelpDialog = new Dialog({
              title: "Seleccionar empleados",
              contentWidth: "36rem",
              contentHeight: "34rem",
              resizable: true,
              draggable: true,

              customHeader: new Toolbar({
                content: [
                  new Title({
                    text: "Seleccionar empleados",
                  }),

                  new ToolbarSpacer(),

                  new Button({
                    text: "Marcar todos",
                    icon: "sap-icon://multi-select",
                    type: "Transparent",
                    press: this.onSelectAllEmployees.bind(this),
                  }),

                  new Button({
                    text: "Desmarcar todos",
                    icon: "sap-icon://multiselect-none",
                    type: "Transparent",
                    press: this.onClearAllEmployees.bind(this),
                  }),
                ],
              }),

              content: [searchField, this._employeeValueHelpList],

              beginButton: new Button({
                text: "Seleccionar",
                type: "Emphasized",
                press: this.onEmployeeValueHelpConfirm.bind(this),
              }),

              endButton: new Button({
                text: "Cancelar",
                press: function () {
                  this._employeeValueHelpDialog.close();
                }.bind(this),
              }),
            });

            this.getView().addDependent(this._employeeValueHelpDialog);
          }

          this._synchronizeEmployeeDialogSelection();
          this._employeeValueHelpDialog.open();
        },

        onEmployeeValueHelpSearch: function (event) {
          const searchValue = event.getParameter("newValue") || "";

          const binding = this._employeeValueHelpList.getBinding("items");

          if (!searchValue.trim()) {
            binding.filter([]);
            return;
          }

          binding.filter(
            new Filter({
              filters: [
                new Filter({
                  path: "employeeName",
                  operator: FilterOperator.Contains,
                  value1: searchValue,
                  caseSensitive: false,
                }),
                new Filter({
                  path: "employeeCode",
                  operator: FilterOperator.Contains,
                  value1: searchValue,
                  caseSensitive: false,
                }),
              ],
              and: false,
            }),
          );
        },

        onEmployeeValueHelpConfirm: function () {
          const selectedItems = this._employeeValueHelpList.getSelectedItems();

          const multiInput = this.byId("employeeFilter");

          multiInput.removeAllTokens();

          selectedItems.forEach((item) => {
            const context = item.getBindingContext("lookups");

            if (!context) {
              return;
            }

            const employee = context.getObject();

            multiInput.addToken(
              new Token({
                key: employee.ID,
                text: employee.employeeName,
              }),
            );
          });

          this._employeeValueHelpDialog.close();
        },

        _synchronizeEmployeeDialogSelection: function () {
          if (!this._employeeValueHelpList) {
            return;
          }

          const selectedKeys = new Set(this._getTokenKeys("employeeFilter"));

          this._employeeValueHelpList.getItems().forEach((item) => {
            const context = item.getBindingContext("lookups");

            const employeeID = context?.getProperty("ID");

            item.setSelected(selectedKeys.has(employeeID));
          });
        },

        onSelectAllEmployees: function () {
          if (!this._employeeValueHelpList) {
            return;
          }

          this._employeeValueHelpList.getItems().forEach((item) => {
            item.setSelected(true);
          });
        },

        onClearAllEmployees: function () {
          if (!this._employeeValueHelpList) {
            return;
          }

          this._employeeValueHelpList.removeSelections(true);
        },

        onEmployeeTokenUpdate: function () {
          setTimeout(
            function () {
              this._synchronizeEmployeeDialogSelection();
            }.bind(this),
            0,
          );
        },

        onStatusValueHelp: function () {
          if (!this._statusValueHelpDialog) {
            this._statusValueHelpList = new List({
              mode: "MultiSelect",
              includeItemInSelection: true,
              growing: true,
              growingThreshold: 100,
            });

            this._statusValueHelpList.setModel(
              this.getView().getModel("lookups"),
              "lookups",
            );

            this._statusValueHelpList.bindItems({
              path: "lookups>/statuses",
              template: new StandardListItem({
                title: "{lookups>text}",
                description: "{lookups>key}",
                type: "Active",
              }),
            });

            const searchField = new SearchField({
              width: "100%",
              placeholder: "Buscar estado",
              liveChange: this.onStatusValueHelpSearch.bind(this),
            });

            this._statusValueHelpDialog = new Dialog({
              title: "Seleccionar estados",
              contentWidth: "34rem",
              contentHeight: "34rem",
              resizable: true,
              draggable: true,

              customHeader: new Toolbar({
                content: [
                  new Title({
                    text: "Seleccionar estados",
                  }),

                  new ToolbarSpacer(),

                  new Button({
                    text: "Marcar todos",
                    icon: "sap-icon://multi-select",
                    type: "Transparent",
                    press: this.onSelectAllStatuses.bind(this),
                  }),

                  new Button({
                    text: "Desmarcar todos",
                    icon: "sap-icon://multiselect-none",
                    type: "Transparent",
                    press: this.onClearAllStatuses.bind(this),
                  }),
                ],
              }),

              content: [searchField, this._statusValueHelpList],

              beginButton: new Button({
                text: "Seleccionar",
                type: "Emphasized",
                press: this.onStatusValueHelpConfirm.bind(this),
              }),

              endButton: new Button({
                text: "Cancelar",
                press: function () {
                  this._statusValueHelpDialog.close();
                }.bind(this),
              }),
            });

            this.getView().addDependent(this._statusValueHelpDialog);
          }

          this._synchronizeStatusDialogSelection();
          this._statusValueHelpDialog.open();
        },

        onStatusValueHelpSearch: function (event) {
          const searchValue = event.getParameter("newValue") || "";

          const binding = this._statusValueHelpList.getBinding("items");

          if (!searchValue.trim()) {
            binding.filter([]);
            return;
          }

          binding.filter(
            new Filter({
              filters: [
                new Filter({
                  path: "text",
                  operator: FilterOperator.Contains,
                  value1: searchValue,
                  caseSensitive: false,
                }),
                new Filter({
                  path: "key",
                  operator: FilterOperator.Contains,
                  value1: searchValue,
                  caseSensitive: false,
                }),
              ],
              and: false,
            }),
          );
        },

        onStatusValueHelpConfirm: function () {
          const selectedItems = this._statusValueHelpList.getSelectedItems();

          const multiInput = this.byId("statusFilter");

          multiInput.removeAllTokens();

          selectedItems.forEach((item) => {
            const context = item.getBindingContext("lookups");

            if (!context) {
              return;
            }

            const status = context.getObject();

            multiInput.addToken(
              new Token({
                key: status.key,
                text: status.text,
              }),
            );
          });

          this._statusValueHelpDialog.close();
        },

        _synchronizeStatusDialogSelection: function () {
          if (!this._statusValueHelpList) {
            return;
          }

          const selectedKeys = new Set(this._getTokenKeys("statusFilter"));

          this._statusValueHelpList.getItems().forEach((item) => {
            const context = item.getBindingContext("lookups");

            const statusKey = context?.getProperty("key");

            item.setSelected(selectedKeys.has(statusKey));
          });
        },

        onSelectAllStatuses: function () {
          if (!this._statusValueHelpList) {
            return;
          }

          this._statusValueHelpList.getItems().forEach((item) => {
            item.setSelected(true);
          });
        },

        onClearAllStatuses: function () {
          if (!this._statusValueHelpList) {
            return;
          }

          this._statusValueHelpList.removeSelections(true);
        },

        onStatusTokenUpdate: function () {
          setTimeout(
            function () {
              this._synchronizeStatusDialogSelection();
            }.bind(this),
            0,
          );
        },

        formatHours: function (value) {
          const hours = Number(value || 0);

          return `${hours.toLocaleString("es-CO", {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2,
          })} h`;
        },

        formatHoursWithoutUnit: function (value) {
          return Number(value || 0).toLocaleString("es-CO", {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2,
          });
        },

        formatClientPercentage: function (value) {
          const rows =
            this.getView().getModel("analytics").getProperty("/byClient") || [];

          const maximum = Math.max(
            ...rows.map((row) => Number(row.registeredHours || 0)),
            0,
          );

          if (maximum <= 0) {
            return 0;
          }

          return Math.min(100, (Number(value || 0) / maximum) * 100);
        },

        formatDayPercentage: function (value) {
          const rows =
            this.getView().getModel("analytics").getProperty("/byDay") || [];

          const maximum = Math.max(
            ...rows.map((row) => Number(row.registeredHours || 0)),
            0,
          );

          if (maximum <= 0) {
            return 0;
          }

          return Math.min(100, (Number(value || 0) / maximum) * 100);
        },

        formatChartDate: function (value) {
          if (!value) {
            return "";
          }

          const parts = String(value).split("-");

          if (parts.length !== 3) {
            return value;
          }

          const [year, month, day] = parts;

          return `${day}/${month}/${year}`;
        },

        isEmptyCollection: function (collection) {
          return !Array.isArray(collection) || collection.length === 0;
        },

        hasCollectionData: function (collection) {
          return Array.isArray(collection) && collection.length > 0;
        },

        formatRecordCount: function (value) {
          const count = Number(value || 0);

          return count === 1 ? "1 registro" : `${count} registros`;
        },

        formatTime: function (value) {
          if (!value) {
            return "";
          }

          const text = String(value);

          if (/^\d{2}:\d{2}/.test(text)) {
            return text.substring(0, 5);
          }

          return text;
        },

        formatNumberForTable: function (value) {
          return Number(value || 0).toLocaleString("es-CO", {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2,
          });
        },

        formatCriticalityState: function (criticality) {
          switch (Number(criticality)) {
            case 3:
              return "Success";
            case 2:
              return "Warning";
            case 1:
              return "Error";
            default:
              return "None";
          }
        },

        formatStatusHighlight: function (criticality) {
          switch (Number(criticality)) {
            case 3:
              return "Success";
            case 2:
              return "Warning";
            case 1:
              return "Error";
            default:
              return "None";
          }
        },

        onOpenDailyViewSettings: function (event) {
          const sourceId = event.getSource().getId();
          const initialTab = sourceId.includes("Group")
            ? "group"
            : sourceId.includes("Filter")
              ? "filter"
              : "sort";

          if (this._dailyViewSettingsDialog) {
            this._dailyViewSettingsDialog.destroy();
          }

          this._dailyViewSettingsDialog = this._buildDailyViewSettingsDialog();
          this.getView().addDependent(this._dailyViewSettingsDialog);
          this._dailyViewSettingsDialog.open(initialTab);
        },

        _buildDailyViewSettingsDialog: function () {
          const settings = this._dailyTableSettings || {};
          const rows =
            this.getView().getModel("report").getProperty("/dailyDetails") ||
            [];

          const dialog = new ViewSettingsDialog({
            title: "Configurar detalle diario",
            confirm: this.onConfirmDailyViewSettings.bind(this),
            reset: this.onResetDailyViewSettings.bind(this),
          });

          [
            ["workDate", "Fecha"],
            ["employeeName", "Empleado"],
            ["clientName", "Cliente"],
            ["projectName", "Proyecto"],
            ["registeredHours", "Horas"],
            ["entryStatusText", "Estado"],
          ].forEach(([key, text]) =>
            dialog.addSortItem(new ViewSettingsItem({ key: key, text: text })),
          );

          [
            ["workDate", "Fecha"],
            ["employeeName", "Empleado"],
            ["clientName", "Cliente"],
            ["projectName", "Proyecto"],
            ["entryStatusText", "Estado"],
          ].forEach(([key, text]) =>
            dialog.addGroupItem(new ViewSettingsItem({ key: key, text: text })),
          );

          [
            ["employeeName", "Empleado"],
            ["clientName", "Cliente"],
            ["projectName", "Proyecto"],
            ["requestedTypeText", "Tipo de tiempo"],
            ["entryStatusText", "Estado"],
          ].forEach(([path, text]) => {
            const filterItem = new ViewSettingsFilterItem({
              key: path,
              text: text,
              multiSelect: true,
            });

            [...new Set(rows.map((row) => row[path]).filter(Boolean))]
              .sort((a, b) => String(a).localeCompare(String(b), "es"))
              .forEach((value) =>
                filterItem.addItem(
                  new ViewSettingsItem({
                    key: String(value),
                    text: String(value),
                  }),
                ),
              );

            dialog.addFilterItem(filterItem);
          });

          if (settings.sortPath) {
            dialog.setSelectedSortItem(settings.sortPath);
            dialog.setSortDescending(!!settings.sortDescending);
          }
          if (settings.groupPath) {
            dialog.setSelectedGroupItem(settings.groupPath);
            dialog.setGroupDescending(!!settings.groupDescending);
          }
          if (settings.filterKeys?.length) {
            dialog.setSelectedFilterKeys(settings.filterKeys);
          }

          return dialog;
        },

        onConfirmDailyViewSettings: function (event) {
          const parameters = event.getParameters();
          const filterKeys = [];
          const filterCompoundKeys = parameters.filterCompoundKeys || {};

          Object.keys(filterCompoundKeys).forEach((path) => {
            Object.keys(filterCompoundKeys[path] || {}).forEach((value) => {
              if (filterCompoundKeys[path][value]) {
                filterKeys.push(`${path}::${value}`);
              }
            });
          });

          this._dailyTableSettings = {
            sortPath: parameters.sortItem?.getKey() || "",
            sortDescending: !!parameters.sortDescending,
            groupPath: parameters.groupItem?.getKey() || "",
            groupDescending: !!parameters.groupDescending,
            filterKeys: filterKeys,
          };

          this._applyDailyTableSettings();
        },

        _applyDailyTableSettings: function () {
          const table = this.byId("dailyDetailsTable");
          const binding = table?.getBinding("items");
          if (!binding) {
            return;
          }

          const settings = this._dailyTableSettings || {};
          const sorters = [];

          if (settings.groupPath) {
            sorters.push(
              new Sorter(settings.groupPath, !!settings.groupDescending, true),
            );
          }

          if (settings.sortPath && settings.sortPath !== settings.groupPath) {
            sorters.push(
              new Sorter(settings.sortPath, !!settings.sortDescending),
            );
          }

          if (!sorters.length) {
            sorters.push(new Sorter("workDate", true));
            sorters.push(new Sorter("employeeName", false));
          }

          const filtersByPath = {};
          (settings.filterKeys || []).forEach((compoundKey) => {
            const separator = compoundKey.indexOf("::");
            if (separator < 0) return;
            const path = compoundKey.substring(0, separator);
            const value = compoundKey.substring(separator + 2);
            (filtersByPath[path] ||= []).push(value);
          });

          const filters = Object.keys(filtersByPath).map(
            (path) =>
              new Filter({
                filters: filtersByPath[path].map(
                  (value) => new Filter(path, FilterOperator.EQ, value),
                ),
                and: false,
              }),
          );

          binding.sort(sorters);
          binding.filter(filters, "Application");

          const active = Boolean(
            settings.sortPath ||
            settings.groupPath ||
            (settings.filterKeys && settings.filterKeys.length),
          );
          this.getView()
            .getModel("report")
            .setProperty("/tableSettingsActive", active);
        },

        _loadPermissions: async function () {
          try {
            const oModel = this.getView().getModel();

            if (!oModel) {
              console.warn("Modelo OData principal todavía no disponible.");
              this._permissionsLoaded = false;
              return;
            }

            const oOperation = oModel.bindContext(
              "/getCurrentUserPermissions(...)",
            );

            await oOperation.execute();

            const oContext = oOperation.getBoundContext();
            const oResult = oContext ? oContext.getObject() : null;

            const canGenerate = Boolean(
              oResult && oResult.canGenerateDeliverables,
            );

            this.getView()
              .getModel("auth")
              .setProperty("/canGenerateDeliverables", canGenerate);

            console.log("Permiso TimeDeliverables:", canGenerate);
          } catch (error) {
            console.error("No fue posible cargar permisos:", error);

            this.getView()
              .getModel("auth")
              .setProperty("/canGenerateDeliverables", false);
          }
        },

        onResetDailyViewSettings: function () {
          this._dailyTableSettings = null;
          this._applyDailyTableSettings();
        },

        onClearDailyViewSettings: function () {
          this._dailyTableSettings = null;
          this._applyDailyTableSettings();
          MessageToast.show("Orden, agrupación y filtros restablecidos.");
        },

        onExportDailyDetails: function () {
          const rows =
            this.getView().getModel("report").getProperty("/dailyDetails") ||
            [];

          if (!rows.length) {
            MessageToast.show("No hay registros para exportar.");
            return;
          }

          const columns = [
            {
              label: "Fecha",
              property: "workDate",
              type: "string",
            },
            {
              label: "Empleado",
              property: "employeeName",
              type: "string",
            },
            {
              label: "Cliente",
              property: "clientName",
              type: "string",
            },
            {
              label: "Proyecto",
              property: "projectName",
              type: "string",
            },
            {
              label: "Hora inicio",
              property: "approximateStartTime",
              type: "string",
            },
            {
              label: "Hora fin",
              property: "approximateEndTime",
              type: "string",
            },
            {
              label: "Actividad / descripción",
              property: "description",
              type: "string",
            },
            {
              label: "Tipo de tiempo",
              property: "requestedTypeText",
              type: "string",
            },
            {
              label: "Horas registradas",
              property: "registeredHours",
              type: "number",
              scale: 2,
            },
            {
              label: "Horas facturables",
              property: "billableHours",
              type: "number",
              scale: 2,
            },
            {
              label: "Estado",
              property: "entryStatusText",
              type: "string",
            },
            {
              label: "Tratamiento comercial",
              property: "commercialTreatmentText",
              type: "string",
            },
          ];

          const spreadsheet = new Spreadsheet({
            workbook: {
              columns: columns,
            },
            dataSource: rows,
            fileName: "Detalle_diario_tiempos.xlsx",
            worker: false,
          });

          spreadsheet.build().finally(function () {
            spreadsheet.destroy();
          });
        },
      },
    );
  },
);
