sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/core/Fragment",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Controller, JSONModel, Fragment, MessageBox, MessageToast) {
  "use strict";

  return Controller.extend("sabnez.com.tiemposempleadoui.controller.Main", {
    onInit: function () {
      this._csrfToken = null;
      this._selectedFile = null;
      this._copyDialog = null;
      this._monthCopyDialog = null;
      this._autosaveTimer = null;
      this._autosaveSuspended = false;
      this._draftStorageKey = null;
      this._interactionHandler = function () {
        this.getView().getModel("view")?.setProperty("/success", null);
      }.bind(this);
      var monday = this._startOfWeek(new Date());
      var viewModel = new JSONModel({
        busy: false, error: null, success: null, weekStart: this._iso(monday), weekLabel: "", weeklyVisible: true,
        assignments: [], entries: [], weekDays: [], nonWorkingDays: [], totalHours: "0.0", selectedCount: 0,
        canSubmitWeek: false, submitBlockedMessage: "",
        copySource: null, copyDays: [], copyHistory: [], draftRestoredMessage: "", monthStart: this._monthStart(this._iso(new Date())), monthLabel: "", monthEntries: [], monthDays: [], filteredMonthDays: [], monthFilter: "ALL", monthTotalHours: "0.0",
        monthCopy: { targetMonth: this._monthStart(this._iso(new Date())), mode: "BUSINESS", preview: "" },
        form: this._emptyForm(this._iso(new Date()))
      });
      viewModel.attachPropertyChange(this._onViewModelPropertyChange, this);
      this.getView().setModel(viewModel, "view");
      this._initialize();
    },

    onExit: function () {
      clearTimeout(this._autosaveTimer);
      this._persistCurrentFormImmediately();
      this.getView().getModel("view")?.detachPropertyChange(this._onViewModelPropertyChange, this);
      var root = this.getView().getDomRef();
      if (root) {
        root.removeEventListener("pointerdown", this._interactionHandler, true);
        root.removeEventListener("keydown", this._interactionHandler, true);
      }
      if (this._copyDialog) {
        this._copyDialog.destroy();
        this._copyDialog = null;
      }
      if (this._monthCopyDialog) this._monthCopyDialog.destroy();
    },

    onAfterRendering: function () {
      var root = this.getView().getDomRef();
      root.removeEventListener("pointerdown", this._interactionHandler, true);
      root.removeEventListener("keydown", this._interactionHandler, true);
      root.addEventListener("pointerdown", this._interactionHandler, true);
      root.addEventListener("keydown", this._interactionHandler, true);
    },

    onRefresh: function () { this._refreshTimeViews(); },
    onPreviousWeek: function () { this._moveWeek(-7); },
    onNextWeek: function () { this._moveWeek(7); },
    onCurrentWeek: function () {
      var model = this.getView().getModel("view");
      var today = this._iso(new Date());
      this._persistCurrentFormImmediately();
      model.setProperty("/weekStart", this._iso(this._startOfWeek(new Date())));
      model.setProperty("/form", this._restoreForm(today, null) || this._emptyForm(today));
      this._loadWeek();
    },
    onDaySelect: function (event) {
      var day = event.getSource().getBindingContext("view").getObject();
      var model = this.getView().getModel("view");
      this._persistCurrentFormImmediately();
      model.setProperty("/form", this._restoreForm(day.date, null) || this._emptyForm(day.date));
      this._selectedFile = null;
      this.byId("supportUploader").clear();
      this._buildWeekDays();
      this._loadAssignmentsForForm();
    },
    onMonthDaySelect: function (event) {
      var day = event.getSource().getBindingContext("view").getObject();
      if (!day.date) return;
      var model = this.getView().getModel("view");
      this._persistCurrentFormImmediately();
      model.setProperty("/form", this._restoreForm(day.date, null) || this._emptyForm(day.date));
      model.setProperty("/weekStart", this._iso(this._startOfWeek(new Date(day.date + "T12:00:00"))));
      model.setProperty("/weeklyVisible", true);
      this.byId("monthlyPanel").setExpanded(false);
      this._selectedFile = null;
      this.byId("supportUploader").clear();
      this._loadWeek();
    },
    onMonthlyToggle: function (event) {
      this.getView().getModel("view").setProperty("/weeklyVisible", !event.getParameter("expand"));
    },
    onPreviousMonth: function () { this._moveMonth(-1); },
    onNextMonth: function () { this._moveMonth(1); },
    onCurrentMonth: function () { this.getView().getModel("view").setProperty("/monthStart", this._monthStart(this._iso(new Date()))); this._loadMonth(); },
    onMonthFilterChange: function (event) {
      this.getView().getModel("view").setProperty("/monthFilter", event.getParameter("item").getKey());
      this._applyMonthFilter();
    },
    onAssignmentChange: function () { this._applyRules(); this._scheduleAutosave(); },
    onTypeChange: function () { this._applyRules(); this._scheduleAutosave(); },
    onFileSelected: function (event) { this._selectedFile = event.getParameter("files")?.[0] || null; this._scheduleAutosave(); },
    onEntrySelectionChange: function (event) { this.getView().getModel("view").setProperty("/selectedCount", event.getSource().getSelectedItems().length); },
    onDismissDraftMessage: function () { this.getView().getModel("view").setProperty("/draftRestoredMessage", ""); },

    onClearForm: function () {
      var model = this.getView().getModel("view");
      this._removeStoredForm(model.getProperty("/form"));
      model.setProperty("/form", this._emptyForm(model.getProperty("/form/fecha") || model.getProperty("/weekStart")));
      this._selectedFile = null;
      this.byId("supportUploader").clear();
      this._ensureDefaultAssignment();
    },

    onEdit: function (event) {
      var row = event.getSource().getBindingContext("view").getObject();
      this._persistCurrentFormImmediately();
      var restored = this._restoreForm(row.fecha, row.ID);
      if (restored) {
        this.getView().getModel("view").setProperty("/form", restored);
        this._applyRules();
      } else {
        this._setFormFromEntry(row, row.fecha);
      }
    },

    onDeleteEntry: function (event) {
      var row = event.getSource().getBindingContext("view").getObject();
      this._confirmDeleteEntries([row.ID], "¿Deseas eliminar este registro de " + row.duracionHoras + " horas?");
    },

    onDeleteSelected: function () {
      var IDs = this.byId("entriesTable").getSelectedItems().map(function (item) { return item.getBindingContext("view").getProperty("ID"); });
      this._confirmDeleteEntries(IDs, "¿Deseas eliminar los " + IDs.length + " registros seleccionados? Esta acción no se puede deshacer.");
    },

    onOpenCopy: async function (event) {
      var row = event.getSource().getBindingContext("view").getObject();
      var model = this.getView().getModel("view");
      model.setProperty("/copySource", row);
      model.setProperty("/copyDays", (model.getProperty("/weekDays") || []).map(function (day) {
        var isSource = day.date === row.fecha;
        return {
          date: day.date,
          fullLabel: day.fullLabel,
          currentSummary: day.entryCount ? day.hours + " h registradas en " + day.entryCount + " registro(s)" : "Sin registros todavía",
          selected: false,
          enabled: !isSource,
          dayKind: day.dayKind,
          info: isSource ? "Día de origen" : "",
          infoState: isSource ? "Information" : (day.dayKind !== "WORKDAY" ? "Warning" : "None"),
          highlight: day.dayKind !== "WORKDAY" ? "Warning" : "None"
        };
      }));
      if (!this._copyDialog) {
        this._copyDialog = await Fragment.load({
          id: this.getView().getId(),
          name: "sabnez.com.tiemposempleadoui.fragment.CopyEntry",
          controller: this
        });
        this.getView().addDependent(this._copyDialog);
      }
      this._copyDialog.open();
    },

    onCancelCopy: function () { this._copyDialog?.close(); },
    onSelectBusinessDays: function () { this._setCopyDaySelection(function (item) { var day=new Date(item.date+"T12:00:00").getDay(); return day>=1&&day<=5&&item.dayKind!=="HOLIDAY"; }); },
    onSelectAllCopyDays: function () { this._setCopyDaySelection(function (item) { return item.dayKind!=="HOLIDAY"; }); },
    onClearCopyDays: function () { this._setCopyDaySelection(function () { return false; }); },
    onCopyDialogAfterClose: function () {
      var model = this.getView().getModel("view");
      model.setProperty("/copySource", null);
      model.setProperty("/copyDays", []);
    },

    onOpenCopyMonth: async function (event) {
      var row = event.getSource().getBindingContext("view").getObject();
      if (row.tipoSolicitado !== "REGULAR") return MessageBox.warning("La copia mensual solo está disponible para horas regulares. Las horas especiales deben registrarse manualmente.");
      var model = this.getView().getModel("view"), target = this._monthStart(row.fecha);
      model.setProperty("/copySource", row);
      model.setProperty("/monthCopy", { targetMonth: target, mode: "BUSINESS", preview: "" });
      await this._updateMonthCopyPreview();
      if (!this._monthCopyDialog) {
        this._monthCopyDialog = await Fragment.load({ id:this.getView().getId(), name:"sabnez.com.tiemposempleadoui.fragment.MonthCopy", controller:this });
        this.getView().addDependent(this._monthCopyDialog);
      }
      this._monthCopyDialog.open();
    },
    onMonthCopyChange: function (event) { if(event?.getSource?.().isA("sap.m.RadioButtonGroup")){this.getView().getModel("view").setProperty("/monthCopy/mode",["BUSINESS","WEEKDAYS","ALL"][event.getSource().getSelectedIndex()]);} this._updateMonthCopyPreview(); },
    onCancelMonthCopy: function () { this._monthCopyDialog?.close(); },
    onConfirmMonthCopy: async function () {
      var model=this.getView().getModel("view"), source=model.getProperty("/copySource"), config=model.getProperty("/monthCopy");
      var plan=await this._prepareSingleMonthCopy(source,config.targetMonth,config.mode);
      if (!plan.dates.length) return MessageBox.information("No hay días disponibles para copiar después de aplicar las reglas y omitir duplicados.");
      MessageBox.confirm("Se crearán " + plan.dates.length + " borradores en " + this._monthName(config.targetMonth) + ". Se omitirán " + plan.omitted + " días y los soportes no se copiarán. ¿Deseas continuar?", { title:"Confirmar copia mensual", emphasizedAction:MessageBox.Action.OK, onClose:async function(action){if(action!==MessageBox.Action.OK)return;this._monthCopyDialog.close();await this._executePersistentCopy(source,plan.dates,"MONTH");}.bind(this) });
    },
    onUndoBulkCopy: function(event){var operation=event?.getSource?.().getBindingContext("view")?.getObject()||(this.getView().getModel("view").getProperty("/copyHistory")||[]).find(function(row){return row.puedeDeshacer;});if(!operation?.ID)return;MessageBox.confirm("Se eliminarán los "+operation.creados+" borradores creados por esta copia. Si alguno fue modificado o enviado, la operación se bloqueará completa. ¿Deseas continuar?",{title:"Deshacer copia masiva",emphasizedAction:MessageBox.Action.DELETE,actions:[MessageBox.Action.DELETE,MessageBox.Action.CANCEL],onClose:async function(action){if(action!==MessageBox.Action.DELETE)return;var model=this.getView().getModel("view");model.setProperty("/busy",true);try{var result=await this._post("deshacerCopiaMasiva",{operacionID:operation.ID});model.setProperty("/success",result.mensaje);await Promise.all([this._refreshTimeViews(false),this._loadCopyHistory()]);}catch(error){model.setProperty("/error",error.message);}finally{model.setProperty("/busy",false);}}.bind(this)});},

    onConfirmCopy: async function () {
      var list = this.byId("copyDaysList");
      var dates = list.getSelectedItems().map(function (item) {
        return item.getBindingContext("view").getProperty("date");
      });
      if (!dates.length) {
        MessageBox.warning("Selecciona al menos un día de destino.");
        return;
      }
      var model = this.getView().getModel("view");
      var source = model.getProperty("/copySource");
      this._copyDialog.close();
      await this._executePersistentCopy(source, dates, "WEEK");
    },

    onSave: async function () {
      var model = this.getView().getModel("view");
      var form = model.getProperty("/form");
      var message = this._validate(form);
      if (message) { MessageBox.warning(message); return; }
      model.setProperty("/busy", true); model.setProperty("/error", null); model.setProperty("/success", null);
      try {
        var result = await this._post("guardarBorrador", {
          ID: form.ID || null, asignacionID: form.asignacionID, fecha: form.fecha,
          duracionHoras: Number(form.duracionHoras), tipoSolicitado: form.tipoSolicitado,
          descripcion: form.descripcion || null, horaInicioAproximada: form.horaInicioAproximada || null,
          horaFinAproximada: form.horaFinAproximada || null, zonaHoraria: form.zonaHoraria || "America/Bogota",
          autorizacionPrevia: Boolean(form.autorizacionPrevia), motivoExcepcional: form.motivoExcepcional || null
        });
        if (this._selectedFile) await this._uploadSupport(result.registro.ID, this._selectedFile);
        this._removeStoredForm(form);
        model.setProperty("/success", this._selectedFile ? "Borrador y soporte guardados correctamente." : result.mensaje);
        this.onClearForm();
        await this._refreshTimeViews(false);
      } catch (error) { model.setProperty("/error", error.message); }
      finally { model.setProperty("/busy", false); }
    },

    onSubmitWeek: function () {
      var entries = this.getView().getModel("view").getProperty("/entries") || [];
      var missingEvidence = entries.filter(function (entry) { return entry.requiereSoporte && Number(entry.cantidadSoportes || 0) === 0; });
      if (missingEvidence.length) {
        MessageBox.error("No es posible enviar la semana: " + missingEvidence.length + " registro(s) requieren soporte. Revisa los proyectos y adjunta los archivos pendientes.", { title: "Semana incompleta" });
        return;
      }
      var warningDays = Array.from(new Set(entries.filter(function (entry) { return entry.alertaHorasDiarias; }).map(function (entry) { return entry.fecha; }))).length;
      var duplicateGroups = Array.from(new Set(entries.filter(function (entry) { return entry.posibleDuplicado; }).map(function (entry) { return entry.duplicateKey; }))).length;
      var projectSummaries = [];
      entries.forEach(function (entry) { if (!projectSummaries.includes(entry.projectGroupLabel)) projectSummaries.push(entry.projectGroupLabel); });
      var details = projectSummaries.join("\n");
      if (warningDays) details += "\n\n• " + warningDays + " día(s) superan el umbral configurado.";
      if (duplicateGroups) details += "\n• " + duplicateGroups + " posible(s) grupo(s) duplicado(s).";
      MessageBox.confirm("Revisa el resumen antes de enviar:\n\n" + details + "\n\nDespués del envío no podrás editar hasta que la semana sea devuelta. ¿Deseas continuar?", {
        title: warningDays || duplicateGroups ? "Revisar alertas de la semana" : "Confirmar envío semanal",
        emphasizedAction: MessageBox.Action.OK,
        onClose: async function (action) {
          if (action !== MessageBox.Action.OK) return;
          var model = this.getView().getModel("view"); model.setProperty("/busy", true);
          try {
            var result = await this._post("enviarSemana", { semanaInicio: model.getProperty("/weekStart") });
            model.setProperty("/success", result.mensaje); await this._refreshTimeViews(false);
          } catch (error) { model.setProperty("/error", error.message); }
          finally { model.setProperty("/busy", false); }
        }.bind(this)
      });
    },

    _initialize: async function () {
      var model = this.getView().getModel("view");
      try {
        var context = await this._get("obtenerMiContexto()");
        var employeeID = (context.value || context || {}).empleadoID;
        if (employeeID) {
          this._draftStorageKey = "sabnez.times.formDrafts.v1." + employeeID;
          var store = this._readDraftStore();
          var restored = store.lastKey && store.drafts?.[store.lastKey];
          if (restored?.form?.fecha) {
            this._autosaveSuspended = true;
            model.setProperty("/form", Object.assign(this._emptyForm(restored.form.fecha), restored.form));
            model.setProperty("/weekStart", this._iso(this._startOfWeek(new Date(restored.form.fecha + "T12:00:00"))));
            model.setProperty("/monthStart", this._monthStart(restored.form.fecha));
            model.setProperty("/draftRestoredMessage", "Recuperamos el formulario guardado automáticamente a las " + this._formatDateTime(restored.savedAt) + (restored.attachmentWasSelected ? ". Por seguridad, selecciona nuevamente el archivo adjunto." : "."));
            this._autosaveSuspended = false;
          }
        }
      } catch (error) {
        model.setProperty("/error", error.message);
      }
      await Promise.all([this._loadWeek(), this._loadMonth(), this._loadCopyHistory()]);
    },

    _onViewModelPropertyChange: function (event) {
      var path = event.getParameter("path") || "";
      if (!this._autosaveSuspended && (path === "/form" || path.indexOf("/form/") === 0)) this._scheduleAutosave();
    },

    _scheduleAutosave: function () {
      if (!this._draftStorageKey || this._autosaveSuspended) return;
      clearTimeout(this._autosaveTimer);
      this._autosaveTimer = setTimeout(this._persistCurrentFormImmediately.bind(this), 350);
    },

    _persistCurrentFormImmediately: function () {
      clearTimeout(this._autosaveTimer);
      if (!this._draftStorageKey) return;
      var form = this.getView().getModel("view")?.getProperty("/form");
      if (!form?.fecha || !this._isMeaningfulDraft(form)) return;
      var store = this._readDraftStore();
      var key = this._draftKey(form);
      store.drafts[key] = {
        form: this._draftSnapshot(form),
        savedAt: new Date().toISOString(),
        attachmentWasSelected: Boolean(this._selectedFile),
      };
      store.lastKey = key;
      this._writeDraftStore(store);
    },

    _restoreForm: function (date, entryID) {
      if (!this._draftStorageKey) return null;
      var store = this._readDraftStore();
      var saved = store.drafts[(entryID ? "entry:" + entryID : "new:" + date)];
      if (!saved?.form) return null;
      this.getView().getModel("view").setProperty("/draftRestoredMessage", "Recuperamos un formulario guardado automáticamente" + (saved.attachmentWasSelected ? ". Por seguridad, selecciona nuevamente el archivo adjunto." : "."));
      return Object.assign(this._emptyForm(date), saved.form, { fecha: date, ID: entryID || null });
    },

    _removeStoredForm: function (form) {
      if (!this._draftStorageKey || !form?.fecha) return;
      var store = this._readDraftStore();
      var key = this._draftKey(form);
      delete store.drafts[key];
      if (store.lastKey === key) store.lastKey = null;
      this._writeDraftStore(store);
    },

    _readDraftStore: function () {
      try {
        var parsed = JSON.parse(window.localStorage.getItem(this._draftStorageKey) || "{}");
        return { version: 1, lastKey: parsed.lastKey || null, drafts: parsed.drafts || {} };
      } catch (_) {
        return { version: 1, lastKey: null, drafts: {} };
      }
    },

    _writeDraftStore: function (store) {
      try { window.localStorage.setItem(this._draftStorageKey, JSON.stringify(store)); } catch (_) { /* El formulario sigue funcionando aunque el navegador bloquee almacenamiento local. */ }
    },

    _draftKey: function (form) { return form.ID ? "entry:" + form.ID : "new:" + form.fecha; },
    _isMeaningfulDraft: function (form) { return Boolean(form.ID || String(form.descripcion || "").trim() || String(form.motivoExcepcional || "").trim() || form.tipoSolicitado !== "REGULAR" || Number(form.duracionHoras) !== 8 || form.horaInicioAproximada || form.horaFinAproximada || form.autorizacionPrevia || this._selectedFile); },
    _draftSnapshot: function (form) { return { ID:form.ID||null,fecha:form.fecha,asignacionID:form.asignacionID||"",duracionHoras:Number(form.duracionHoras||8),tipoSolicitado:form.tipoSolicitado||"REGULAR",descripcion:form.descripcion||"",horaInicioAproximada:form.horaInicioAproximada||"",horaFinAproximada:form.horaFinAproximada||"",zonaHoraria:form.zonaHoraria||"America/Bogota",autorizacionPrevia:Boolean(form.autorizacionPrevia),motivoExcepcional:form.motivoExcepcional||""}; },

    _loadMonth: async function () {
      var model=this.getView().getModel("view"),start=model.getProperty("/monthStart"),end=this._addDays(this._addMonths(start,1),-1);
      try{
        var data=await Promise.all([this._get("obtenerMisRegistrosMes(mesInicio="+start+")"),this._get("obtenerDiasNoHabiles(desde="+start+",hasta="+end+")")]);
        var entries=(data[0].value||data[0]||[]).map(this._decorateEntry.bind(this));
        model.setProperty("/monthEntries",entries);model.setProperty("/monthLabel",this._monthName(start));model.setProperty("/monthTotalHours",entries.reduce(function(sum,entry){return sum+Number(entry.duracionHoras||0);},0).toFixed(1));
        this._buildMonthDays(entries,data[1].value||data[1]||[]);
      }catch(error){model.setProperty("/error",error.message);}
    },
    _refreshTimeViews: function (showBusy) {
      return Promise.all([this._loadWeek(showBusy), this._loadMonth()]);
    },
    _buildMonthDays:function(entries,nonWorking){
      var model=this.getView().getModel("view"),start=model.getProperty("/monthStart"),end=this._addDays(this._addMonths(start,1),-1),days=[],firstDay=new Date(start+"T12:00:00").getDay();
      for(var blank=1;blank<(firstDay||7);blank+=1)days.push({date:"",isBlank:true,blankDom:"true",dayKind:"BLANK"});
      for(var date=start;date<=end;date=this._addDays(date,1)){var rows=entries.filter(function(e){return e.fecha===date;}),hours=rows.reduce(function(s,e){return s+Number(e.duracionHoras||0);},0),exception=nonWorking.find(function(d){return d.fecha===date;}),needsReview=rows.some(function(e){return hours>Number(e.umbralAlertaDiaria||16);}),weekday=new Intl.DateTimeFormat("es-CO",{weekday:"long"}).format(new Date(date+"T12:00:00"));days.push({date:date,isBlank:false,blankDom:"false",dayNumber:String(Number(date.slice(8,10))),weekdayLabel:weekday.charAt(0).toUpperCase()+weekday.slice(1),dateLabel:this._prettyDate(date),hours:hours.toFixed(1),entryCount:rows.length,summary:rows.length?rows.length+" registro(s)":"Sin registros",dayKind:String(exception?.tipo||"WORKDAY"),nonWorkingLabel:exception?.motivo||"",statusIcon:needsReview?"sap-icon://alert":rows.length?"sap-icon://accept":"",statusText:needsReview?"Revisar":rows.length?"Registrado":"Sin registro",statusState:needsReview?"Warning":rows.length?"Success":"None"});}
      model.setProperty("/monthDays",days);
      this._applyMonthFilter();
    },
    _applyMonthFilter:function(){var model=this.getView().getModel("view"),filter=model.getProperty("/monthFilter")||"ALL",days=(model.getProperty("/monthDays")||[]).filter(function(day){if(day.isBlank)return false;if(filter==="PENDING")return day.entryCount===0;if(filter==="REVIEW")return day.statusState==="Warning";return true;});model.setProperty("/filteredMonthDays",days);},
    _moveMonth:function(months){var model=this.getView().getModel("view");model.setProperty("/monthStart",this._monthStart(this._addMonths(model.getProperty("/monthStart"),months)));this._loadMonth();},
    _updateMonthCopyPreview:async function(){var model=this.getView().getModel("view"),source=model.getProperty("/copySource"),config=model.getProperty("/monthCopy");if(!source)return;var plan=await this._prepareSingleMonthCopy(source,config.targetMonth,config.mode);model.setProperty("/monthCopy/preview",plan.dates.length+" borradores por crear · "+plan.omitted+" días omitidos");},
    _prepareSingleMonthCopy:async function(source,targetMonth,mode){var existing=await this._fetchMonthEntries(targetMonth),dates=await this._eligibleMonthDates(targetMonth,mode),omitted=0;dates=dates.filter(function(date){var duplicate=existing.some(function(e){return this._sameEntry(e,source,date);}.bind(this));if(duplicate)omitted+=1;return !duplicate;}.bind(this));return {dates:dates,omitted:omitted};},
    _fetchMonthEntries:async function(month){var data=await this._get("obtenerMisRegistrosMes(mesInicio="+this._monthStart(month)+")");return (data.value||data||[]).map(this._decorateEntry.bind(this));},
    _eligibleMonthDates:async function(month,mode){var start=this._monthStart(month),end=this._addDays(this._addMonths(start,1),-1),data=await this._get("obtenerDiasNoHabiles(desde="+start+",hasta="+end+")"),nonWorking=data.value||data||[],dates=[];for(var date=start;date<=end;date=this._addDays(date,1)){var day=new Date(date+"T12:00:00").getDay(),holiday=nonWorking.some(function(d){return d.fecha===date&&d.tipo==="HOLIDAY";});if(mode==="ALL"||(mode==="WEEKDAYS"&&day>=1&&day<=5)||(mode==="BUSINESS"&&day>=1&&day<=5&&!holiday))dates.push(date);}return dates;},
    _sameEntry:function(existing,source,date){return existing.fecha===date&&existing.asignacionID===source.asignacionID&&existing.tipoSolicitado===source.tipoSolicitado&&Number(existing.duracionHoras)===Number(source.duracionHoras)&&String(existing.descripcion||"").trim().toLowerCase()===String(source.descripcion||"").trim().toLowerCase();},
    _executePersistentCopy:async function(source,dates,scope){var model=this.getView().getModel("view");model.setProperty("/busy",true);model.setProperty("/error",null);model.setProperty("/success",null);try{var result=await this._post("ejecutarCopiaMasiva",{registroOrigenID:source.ID,fechas:dates.map(function(date){return {fecha:date};}),alcance:scope});model.setProperty(result.exito?"/success":"/error",result.mensaje+(source.requiereSoporte?" Recuerda adjuntar el soporte en cada copia.":""));await Promise.all([this._refreshTimeViews(false),this._loadCopyHistory()]);}catch(error){model.setProperty("/error",error.message);}finally{model.setProperty("/busy",false);}},

    _loadCopyHistory:async function(){var model=this.getView().getModel("view");try{var data=await this._get("obtenerMisCopias()");var rows=(data.value||data||[]).map(function(row){var statuses={ACTIVE:["Disponible para deshacer","Information"],UNDONE:["Deshecha","Success"],EMPTY:["Sin registros creados","Warning"]},status=statuses[row.estado]||[row.estado,"None"];return Object.assign({},row,{scopeLabel:row.alcance==="MONTH"?"Copia a días del mes":"Copia semanal",statusLabel:status[0],statusState:status[1],createdLabel:this._formatDateTime(row.creadoEn)});}.bind(this));model.setProperty("/copyHistory",rows);}catch(error){model.setProperty("/error",error.message);}},

    _loadWeek: async function (showBusy) {
      var model = this.getView().getModel("view");
      if (showBusy !== false) model.setProperty("/busy", true);
      model.setProperty("/error", null); this._setWeekLabel();
      try {
        var start = model.getProperty("/weekStart");
        var data = await Promise.all([this._get("obtenerMisAsignaciones(fecha=" + start + ")"), this._get("obtenerMisRegistros(semanaInicio=" + start + ")"), this._get("obtenerDiasNoHabiles(desde=" + start + ",hasta=" + this._addDays(start, 6) + ")"), this._get("obtenerEstadoEnvioSemana()")]);
        model.setProperty("/assignments", data[0].value || data[0] || []);
        var entries = (data[1].value || data[1] || []).map(this._decorateEntry.bind(this));
        entries.sort(function (a,b) { return a.fecha.localeCompare(b.fecha) || a.proyectoNombre.localeCompare(b.proyectoNombre); });
        this._analyzeWeekEntries(entries);
        model.setProperty("/entries", entries);
        model.setProperty("/nonWorkingDays", data[2].value || data[2] || []);
        var submissionState = data[3].value || data[3] || {};
        model.setProperty("/canSubmitWeek", submissionState.permitido === true);
        model.setProperty("/submitBlockedMessage", submissionState.mensaje || "");
        model.setProperty("/selectedCount", 0);
        model.setProperty("/totalHours", entries.reduce(function (sum,e) { return sum + Number(e.duracionHoras || 0); }, 0).toFixed(1));
        this._buildWeekDays();
        this._ensureDefaultAssignment();
      } catch (error) { model.setProperty("/error", error.message); }
      finally { model.setProperty("/busy", false); }
    },

    _loadAssignmentsForForm: async function () {
      var model = this.getView().getModel("view");
      try {
        var data = await this._get("obtenerMisAsignaciones(fecha=" + model.getProperty("/form/fecha") + ")");
        model.setProperty("/assignments", data.value || data || []); this._ensureDefaultAssignment();
      } catch (error) { model.setProperty("/error", error.message); }
    },

    _ensureDefaultAssignment: function () {
      var model = this.getView().getModel("view"), assignments = model.getProperty("/assignments") || [];
      if (!assignments.some(function (a) { return a.ID === model.getProperty("/form/asignacionID"); })) model.setProperty("/form/asignacionID", assignments[0]?.ID || "");
      this._applyRules();
    },

    _applyRules: function () {
      var model = this.getView().getModel("view"), form = model.getProperty("/form"), assignment = (model.getProperty("/assignments") || []).find(function (a) { return a.ID === form.asignacionID; });
      var special = form.tipoSolicitado !== "REGULAR";
      model.setProperty("/form/isSpecial", special);
      model.setProperty("/form/descriptionRequired", special || Boolean(assignment?.requiereDescripcion));
      model.setProperty("/form/supportRequired", special || Boolean(assignment?.requiereSoporte));
      model.setProperty("/form/zonaHoraria", assignment?.zonaHoraria || "America/Bogota");
      var rules = [];
      if (assignment?.requiereDescripcion) rules.push("Este proyecto exige descripción.");
      if (assignment?.requiereSoporte) rules.push("Este proyecto exige soporte.");
      if (special) rules.push("El tiempo extra o especial exige descripción, franja horaria, autorización y soporte.");
      model.setProperty("/form/rulesText", rules.join(" "));
    },

    _validate: function (form) {
      if (!form.fecha || !form.asignacionID || !(Number(form.duracionHoras) > 0)) return "Completa fecha, proyecto y horas.";
      if (Math.round(Number(form.duracionHoras) * 2) !== Number(form.duracionHoras) * 2) return "Las horas deben registrarse en incrementos de media hora.";
      if (form.descriptionRequired && !String(form.descripcion || "").trim()) return "La descripción es obligatoria para este registro.";
      if (form.isSpecial && (!form.horaInicioAproximada || !form.horaFinAproximada)) return "El tiempo extra exige una franja horaria aproximada.";
      if (form.isSpecial && !form.autorizacionPrevia && !String(form.motivoExcepcional || "").trim()) return "Indica la autorización previa o explica por qué el trabajo extra fue imprevisto.";
      if (form.supportRequired && !this._selectedFile && !form.ID) return "Debes seleccionar un soporte para este registro.";
      if (this._selectedFile && this._selectedFile.size > 10 * 1024 * 1024) return "El soporte no puede superar 10 MB.";
      return null;
    },

    _uploadSupport: async function (entryID, file) {
      var base64 = await this._fileToBase64(file);
      return this._post("cargarSoporte", { registroID: entryID, nombreArchivo: file.name, mimeType: file.type || "application/octet-stream", contenido: base64 });
    },
    _fileToBase64: function (file) { return new Promise(function (resolve,reject) { var reader=new FileReader(); reader.onload=function(){resolve(String(reader.result).split(",")[1]);}; reader.onerror=reject; reader.readAsDataURL(file); }); },
    _get: async function (path) { var response=await fetch(this._root()+path,{credentials:"same-origin",headers:{Accept:"application/json"}}); return this._json(response); },
    _post: async function (action, body) { var token=await this._token(); var response=await fetch(this._root()+action,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json",Accept:"application/json","X-CSRF-Token":token},body:JSON.stringify(body)}); return this._json(response); },
    _token: async function () { if (this._csrfToken) return this._csrfToken; var response=await fetch(this._root(),{headers:{"X-CSRF-Token":"Fetch"},credentials:"same-origin"}); this._csrfToken=response.headers.get("X-CSRF-Token"); return this._csrfToken; },
    _json: async function (response) { var payload={}; try { payload=await response.json(); } catch (_) {} if (!response.ok) throw new Error(payload?.error?.message || "No fue posible completar la operación."); return payload.value !== undefined && Object.keys(payload).length===1 ? payload.value : payload; },
    _root: function () { return /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname) ? "/tiempos-empleado/" : this.getOwnerComponent().getManifestObject().resolveUri("tiempos-empleado/"); },
    _confirmDeleteEntries: function (IDs, message) { if(!IDs.length)return; MessageBox.confirm(message,{emphasizedAction:MessageBox.Action.DELETE,actions:[MessageBox.Action.DELETE,MessageBox.Action.CANCEL],onClose:async function(action){if(action!==MessageBox.Action.DELETE)return;var model=this.getView().getModel("view");model.setProperty("/busy",true);model.setProperty("/error",null);try{await this._post("eliminarRegistros",{registros:IDs.map(function(ID){return {ID:ID};})});model.setProperty("/success",IDs.length===1?"Registro eliminado correctamente.":IDs.length+" registros eliminados correctamente.");await this._refreshTimeViews(false);}catch(error){model.setProperty("/error",error.message);}finally{model.setProperty("/busy",false);}}.bind(this)}); },
    _setCopyDaySelection: function (predicate) { this.byId("copyDaysList").getItems().forEach(function(item){var day=item.getBindingContext("view").getObject();item.setSelected(Boolean(day.enabled&&predicate(day)));}); },
    _buildWeekDays: function () { var model=this.getView().getModel("view"),start=model.getProperty("/weekStart"),selected=model.getProperty("/form/fecha"),today=this._iso(new Date()),entries=model.getProperty("/entries")||[],nonWorking=model.getProperty("/nonWorkingDays")||[],days=[]; for(var i=0;i<7;i+=1){var date=this._addDays(start,i),dayEntries=entries.filter(function(entry){return entry.fecha===date;}),hours=dayEntries.reduce(function(sum,entry){return sum+Number(entry.duracionHoras||0);},0),exception=nonWorking.find(function(item){return item.fecha===date;}),state=date===selected?"selected":date===today?"today":dayEntries.length?"filled":"empty"; days.push({date:date,weekdayLabel:new Intl.DateTimeFormat("es-CO",{weekday:"short"}).format(new Date(date+"T12:00:00")).replace(".",""),dayNumber:String(Number(date.slice(8,10))),monthLabel:new Intl.DateTimeFormat("es-CO",{month:"short"}).format(new Date(date+"T12:00:00")).replace(".",""),fullLabel:this._fullDate(date),hours:hours.toFixed(1),entryCount:dayEntries.length,entryLabel:dayEntries.length?dayEntries.length+" registro(s)":"Sin registros",state:state,dayKind:exception?.tipo||"WORKDAY",nonWorkingLabel:exception?.motivo||""});} model.setProperty("/weekDays",days); model.setProperty("/form/dayFullLabel",this._fullDate(selected)); },
    _moveWeek: function (days) { var model=this.getView().getModel("view"),newStart=this._addDays(model.getProperty("/weekStart"),days); this._persistCurrentFormImmediately(); model.setProperty("/weekStart",newStart); model.setProperty("/form",this._restoreForm(newStart,null)||this._emptyForm(newStart)); this._selectedFile=null; this.byId("supportUploader").clear(); this._loadWeek(); },
    _setWeekLabel: function () { var model=this.getView().getModel("view"),start=model.getProperty("/weekStart"),end=this._addDays(start,6); model.setProperty("/weekLabel",this._prettyDate(start)+" – "+this._prettyDate(end)); },
    _setFormFromEntry: function (row,date,copy) { var model=this.getView().getModel("view"); model.setProperty("/form",Object.assign(this._emptyForm(date),{ ID:copy?null:row.ID, asignacionID:row.asignacionID, duracionHoras:Number(row.duracionHoras), tipoSolicitado:row.tipoSolicitado, descripcion:row.descripcion||"", horaInicioAproximada:row.horaInicioAproximada||"", horaFinAproximada:row.horaFinAproximada||"", autorizacionPrevia:Boolean(row.autorizacionPrevia), motivoExcepcional:row.motivoExcepcional||"" })); this._selectedFile=null; this.byId("supportUploader").clear(); this._applyRules(); },
    _decorateEntry: function (entry) { var labels={REGULAR:"Regular",OVERTIME:"Extra",NIGHT:"Nocturna",SUNDAY:"Dominical",HOLIDAY:"Festiva",COMPENSATORY:"Compensatoria"}, states={DRAFT:["Borrador","Information"],RETURNED:["Devuelto","Error"],SUBMITTED:["Enviado","Success"],LEADER_APPROVED:["Aprobado por líder","Success"],INTERNALLY_APPROVED:["Aprobado","Success"]},state=states[entry.estado]||[entry.estado,"None"]; return Object.assign({},entry,{dateLabel:this._weekday(entry.fecha),typeLabel:labels[entry.tipoSolicitado]||entry.tipoSolicitado,statusLabel:state[0],statusState:state[1]}); },
    _analyzeWeekEntries: function (entries) {
      var dailyTotals = {}, duplicateCounts = {}, projectTotals = {};
      entries.forEach(function (entry) {
        dailyTotals[entry.fecha] = (dailyTotals[entry.fecha] || 0) + Number(entry.duracionHoras || 0);
        var normalizedDescription = String(entry.descripcion || "").trim().toLocaleLowerCase("es-CO").replace(/\s+/g, " ");
        entry.duplicateKey = [entry.asignacionID, entry.fecha, entry.tipoSolicitado, Number(entry.duracionHoras || 0).toFixed(2), normalizedDescription].join("|");
        duplicateCounts[entry.duplicateKey] = (duplicateCounts[entry.duplicateKey] || 0) + 1;
        var projectKey = entry.asignacionID || entry.proyectoNombre;
        if (!projectTotals[projectKey]) projectTotals[projectKey] = { name: entry.proyectoNombre, hours: 0, regular: 0, extra: 0, count: 0 };
        projectTotals[projectKey].hours += Number(entry.duracionHoras || 0);
        projectTotals[projectKey].count += 1;
        if (entry.tipoSolicitado === "REGULAR") projectTotals[projectKey].regular += Number(entry.duracionHoras || 0);
        else projectTotals[projectKey].extra += Number(entry.duracionHoras || 0);
      });
      entries.forEach(function (entry) {
        var project = projectTotals[entry.asignacionID || entry.proyectoNombre];
        entry.totalHorasDia = dailyTotals[entry.fecha].toFixed(1);
        entry.alertaHorasDiarias = dailyTotals[entry.fecha] > Number(entry.umbralAlertaDiaria || 16);
        entry.alertaHorasTexto = entry.alertaHorasDiarias ? "El total del día es " + entry.totalHorasDia + " horas y supera el umbral de " + Number(entry.umbralAlertaDiaria || 16) + "." : "";
        entry.posibleDuplicado = duplicateCounts[entry.duplicateKey] > 1;
        entry.projectGroupLabel = project.name + " · " + project.hours.toFixed(1) + " h · " + project.count + " registro(s) · " + project.regular.toFixed(1) + " h regulares" + (project.extra ? " · " + project.extra.toFixed(1) + " h extras" : "");
      });
    },
    _emptyForm: function (date) { return { ID:null,fecha:date,dayFullLabel:this._fullDate(date),asignacionID:"",duracionHoras:8,tipoSolicitado:"REGULAR",descripcion:"",horaInicioAproximada:"",horaFinAproximada:"",zonaHoraria:"America/Bogota",autorizacionPrevia:false,motivoExcepcional:"",isSpecial:false,descriptionRequired:false,supportRequired:false,rulesText:"" }; },
    _startOfWeek: function (date) { var d=new Date(date.getFullYear(),date.getMonth(),date.getDate()),day=d.getDay()||7; d.setDate(d.getDate()-day+1); return d; },
    _iso: function (date) { var y=date.getFullYear(),m=String(date.getMonth()+1).padStart(2,"0"),d=String(date.getDate()).padStart(2,"0"); return y+"-"+m+"-"+d; },
    _addDays: function (iso,days) { var p=iso.split("-").map(Number),d=new Date(p[0],p[1]-1,p[2]); d.setDate(d.getDate()+days); return this._iso(d); },
    _addMonths: function (iso,months) { var p=iso.split("-").map(Number),d=new Date(p[0],p[1]-1,1); d.setMonth(d.getMonth()+months); return this._iso(d); },
    _monthStart: function (iso) { return String(iso).slice(0,7)+"-01"; },
    _monthName: function (iso) { var value=new Intl.DateTimeFormat("es-CO",{month:"long",year:"numeric"}).format(new Date(this._monthStart(iso)+"T12:00:00"));return value.charAt(0).toUpperCase()+value.slice(1); },
    _formatDateTime: function (value) { if(!value)return "";return new Intl.DateTimeFormat("es-CO",{dateStyle:"medium",timeStyle:"short"}).format(new Date(value)); },
    _prettyDate: function (iso) { return new Intl.DateTimeFormat("es-CO",{day:"numeric",month:"short"}).format(new Date(iso+"T12:00:00")); },
    _fullDate: function (iso) { if(!iso)return ""; var value=new Intl.DateTimeFormat("es-CO",{weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(new Date(iso+"T12:00:00")); return value.charAt(0).toUpperCase()+value.slice(1); },
    _weekday: function (iso) { return new Intl.DateTimeFormat("es-CO",{weekday:"long"}).format(new Date(iso+"T12:00:00")); }
  });
});
