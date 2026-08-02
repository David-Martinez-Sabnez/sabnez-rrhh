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
      this._monthPlanDialog = null;
      this._interactionHandler = function () {
        this.getView().getModel("view")?.setProperty("/success", null);
      }.bind(this);
      var monday = this._startOfWeek(new Date());
      this.getView().setModel(new JSONModel({
        busy: false, error: null, success: null, weekStart: this._iso(monday), weekLabel: "", weeklyVisible: true,
        assignments: [], entries: [], weekDays: [], nonWorkingDays: [], totalHours: "0.0", selectedCount: 0,
        copySource: null, copyDays: [], lastBulkCopy: [], monthStart: this._monthStart(this._iso(new Date())), monthLabel: "", monthEntries: [], monthDays: [], filteredMonthDays: [], monthFilter: "ALL", monthTotalHours: "0.0",
        monthCopy: { targetMonth: this._monthStart(this._iso(new Date())), mode: "BUSINESS", preview: "" },
        monthPlan: { sourceMonth: this._monthStart(this._iso(new Date())), targetMonth: this._monthStart(this._addMonths(this._iso(new Date()), 1)), mode: "BUSINESS", preview: "" },
        form: this._emptyForm(this._iso(new Date()))
      }), "view");
      this._loadWeek();
      this._loadMonth();
    },

    onExit: function () {
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
      if (this._monthPlanDialog) this._monthPlanDialog.destroy();
    },

    onAfterRendering: function () {
      var root = this.getView().getDomRef();
      root.removeEventListener("pointerdown", this._interactionHandler, true);
      root.removeEventListener("keydown", this._interactionHandler, true);
      root.addEventListener("pointerdown", this._interactionHandler, true);
      root.addEventListener("keydown", this._interactionHandler, true);
    },

    onRefresh: function () { this._loadWeek(); },
    onPreviousWeek: function () { this._moveWeek(-7); },
    onNextWeek: function () { this._moveWeek(7); },
    onCurrentWeek: function () {
      var model = this.getView().getModel("view");
      var today = this._iso(new Date());
      model.setProperty("/weekStart", this._iso(this._startOfWeek(new Date())));
      model.setProperty("/form", this._emptyForm(today));
      this._loadWeek();
    },
    onDaySelect: function (event) {
      var day = event.getSource().getBindingContext("view").getObject();
      var model = this.getView().getModel("view");
      model.setProperty("/form", this._emptyForm(day.date));
      this._selectedFile = null;
      this.byId("supportUploader").clear();
      this._buildWeekDays();
      this._loadAssignmentsForForm();
    },
    onMonthDaySelect: function (event) {
      var day = event.getSource().getBindingContext("view").getObject();
      if (!day.date) return;
      var model = this.getView().getModel("view");
      model.setProperty("/form", this._emptyForm(day.date));
      model.setProperty("/weekStart", this._iso(this._startOfWeek(new Date(day.date + "T12:00:00"))));
      model.setProperty("/weeklyVisible", true);
      this.byId("monthlyPanel").setExpanded(false);
      this._selectedFile = null;
      this.byId("supportUploader").clear();
      this._loadWeek();
    },
    onMonthlyToggle: function (event) {
      if (event.getParameter("expand")) this.getView().getModel("view").setProperty("/weeklyVisible", false);
    },
    onPreviousMonth: function () { this._moveMonth(-1); },
    onNextMonth: function () { this._moveMonth(1); },
    onCurrentMonth: function () { this.getView().getModel("view").setProperty("/monthStart", this._monthStart(this._iso(new Date()))); this._loadMonth(); },
    onMonthFilterChange: function (event) {
      this.getView().getModel("view").setProperty("/monthFilter", event.getParameter("item").getKey());
      this._applyMonthFilter();
    },
    onAssignmentChange: function () { this._applyRules(); },
    onTypeChange: function () { this._applyRules(); },
    onFileSelected: function (event) { this._selectedFile = event.getParameter("files")?.[0] || null; },
    onEntrySelectionChange: function (event) { this.getView().getModel("view").setProperty("/selectedCount", event.getSource().getSelectedItems().length); },

    onClearForm: function () {
      var model = this.getView().getModel("view");
      model.setProperty("/form", this._emptyForm(model.getProperty("/form/fecha") || model.getProperty("/weekStart")));
      this._selectedFile = null;
      this.byId("supportUploader").clear();
      this._ensureDefaultAssignment();
    },

    onEdit: function (event) {
      var row = event.getSource().getBindingContext("view").getObject();
      this._setFormFromEntry(row, row.fecha);
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
      MessageBox.confirm("Se crearán " + plan.dates.length + " borradores en " + this._monthName(config.targetMonth) + ". Se omitirán " + plan.omitted + " días y los soportes no se copiarán. ¿Deseas continuar?", { title:"Confirmar copia mensual", emphasizedAction:MessageBox.Action.OK, onClose:async function(action){if(action!==MessageBox.Action.OK)return;this._monthCopyDialog.close();await this._executeBulkCopies(plan.dates.map(function(date){return {source:source,date:date};}),"Copia mensual completada");}.bind(this) });
    },
    onOpenMonthPlan: async function () {
      var model=this.getView().getModel("view"), source=model.getProperty("/monthStart");
      model.setProperty("/monthPlan",{sourceMonth:source,targetMonth:this._monthStart(this._addMonths(source,1)),mode:"BUSINESS",preview:"Se copiarán únicamente horas regulares conservando su posición semanal."});
      if(!this._monthPlanDialog){this._monthPlanDialog=await Fragment.load({id:this.getView().getId(),name:"sabnez.com.tiemposempleadoui.fragment.MonthPlan",controller:this});this.getView().addDependent(this._monthPlanDialog);}
      this._monthPlanDialog.open();
    },
    onCancelMonthPlan: function(){this._monthPlanDialog?.close();},
    onUndoBulkCopy: function(){var rows=this.getView().getModel("view").getProperty("/lastBulkCopy")||[];if(!rows.length)return;MessageBox.confirm("Se eliminarán los "+rows.length+" borradores creados en la última copia masiva. ¿Deseas continuar?",{title:"Deshacer copia masiva",emphasizedAction:MessageBox.Action.DELETE,actions:[MessageBox.Action.DELETE,MessageBox.Action.CANCEL],onClose:async function(action){if(action!==MessageBox.Action.DELETE)return;try{await this._post("eliminarRegistros",{registros:rows});this.getView().getModel("view").setProperty("/lastBulkCopy",[]);this.getView().getModel("view").setProperty("/success","La última copia masiva se deshizo correctamente.");await Promise.all([this._loadWeek(false),this._loadMonth()]);}catch(error){this.getView().getModel("view").setProperty("/error",error.message);}}.bind(this)});},
    onConfirmMonthPlan: async function(){
      var config=this.getView().getModel("view").getProperty("/monthPlan");config.mode=["BUSINESS","WEEKDAYS","ALL"][this.byId("monthPlanMode").getSelectedIndex()];var plan=await this._prepareMonthPlan(config.sourceMonth,config.targetMonth,config.mode);
      if(!plan.copies.length)return MessageBox.information("No existen registros regulares disponibles para copiar o todos ya existen en el mes de destino.");
      MessageBox.confirm("Se crearán " + plan.copies.length + " borradores en " + this._monthName(config.targetMonth) + ". Se omitieron " + plan.omitted + " registros por calendario, vigencia o duplicidad. ¿Deseas continuar?",{title:"Repetir planificación mensual",emphasizedAction:MessageBox.Action.OK,onClose:async function(action){if(action!==MessageBox.Action.OK)return;this._monthPlanDialog.close();await this._executeBulkCopies(plan.copies,"Planificación mensual copiada");}.bind(this)});
    },

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
      model.setProperty("/busy", true);
      model.setProperty("/error", null);
      model.setProperty("/success", null);
      try {
        var results = await Promise.allSettled(dates.map(function (date) {
          return this._copyEntryToDate(source, date);
        }.bind(this)));
        var copied = results.filter(function (result) { return result.status === "fulfilled"; }).length;
        var failed = results.length - copied;
        await this._loadWeek(false);
        if (failed) {
          model.setProperty("/error", "Se copiaron " + copied + " registro(s), pero " + failed + " no pudieron crearse. Revisa los días y vuelve a intentarlo.");
        } else {
          model.setProperty("/success", "Registro copiado correctamente a " + copied + " día(s)." + (source.requiereSoporte ? " Recuerda adjuntar el soporte en cada copia." : ""));
        }
      } finally {
        model.setProperty("/busy", false);
      }
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
        model.setProperty("/success", this._selectedFile ? "Borrador y soporte guardados correctamente." : result.mensaje);
        this.onClearForm();
        await this._loadWeek(false);
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
            model.setProperty("/success", result.mensaje); await this._loadWeek(false);
          } catch (error) { model.setProperty("/error", error.message); }
          finally { model.setProperty("/busy", false); }
        }.bind(this)
      });
    },

    _loadMonth: async function () {
      var model=this.getView().getModel("view"),start=model.getProperty("/monthStart"),end=this._addDays(this._addMonths(start,1),-1);
      try{
        var data=await Promise.all([this._get("obtenerMisRegistrosMes(mesInicio="+start+")"),this._get("obtenerDiasNoHabiles(desde="+start+",hasta="+end+")")]);
        var entries=(data[0].value||data[0]||[]).map(this._decorateEntry.bind(this));
        model.setProperty("/monthEntries",entries);model.setProperty("/monthLabel",this._monthName(start));model.setProperty("/monthTotalHours",entries.reduce(function(sum,entry){return sum+Number(entry.duracionHoras||0);},0).toFixed(1));
        this._buildMonthDays(entries,data[1].value||data[1]||[]);
      }catch(error){model.setProperty("/error",error.message);}
    },
    _buildMonthDays:function(entries,nonWorking){
      var model=this.getView().getModel("view"),start=model.getProperty("/monthStart"),end=this._addDays(this._addMonths(start,1),-1),days=[],firstDay=new Date(start+"T12:00:00").getDay();
      for(var blank=1;blank<(firstDay||7);blank+=1)days.push({date:"",isBlank:true});
      for(var date=start;date<=end;date=this._addDays(date,1)){var rows=entries.filter(function(e){return e.fecha===date;}),hours=rows.reduce(function(s,e){return s+Number(e.duracionHoras||0);},0),exception=nonWorking.find(function(d){return d.fecha===date;}),needsReview=rows.some(function(e){return hours>Number(e.umbralAlertaDiaria||16);}),weekday=new Intl.DateTimeFormat("es-CO",{weekday:"long"}).format(new Date(date+"T12:00:00"));days.push({date:date,isBlank:false,dayNumber:String(Number(date.slice(8,10))),weekdayLabel:weekday.charAt(0).toUpperCase()+weekday.slice(1),dateLabel:this._prettyDate(date),hours:hours.toFixed(1),entryCount:rows.length,summary:rows.length?rows.length+" registro(s)":"Sin registros",dayKind:exception?.tipo||"WORKDAY",nonWorkingLabel:exception?.motivo||"",statusIcon:needsReview?"sap-icon://alert":rows.length?"sap-icon://accept":"",statusText:needsReview?"Revisar":rows.length?"Registrado":"Sin registro",statusState:needsReview?"Warning":rows.length?"Success":"None"});}
      model.setProperty("/monthDays",days);
      this._applyMonthFilter();
    },
    _applyMonthFilter:function(){var model=this.getView().getModel("view"),filter=model.getProperty("/monthFilter")||"ALL",days=(model.getProperty("/monthDays")||[]).filter(function(day){if(day.isBlank)return false;if(filter==="PENDING")return day.entryCount===0;if(filter==="REVIEW")return day.statusState==="Warning";return true;});model.setProperty("/filteredMonthDays",days);},
    _moveMonth:function(months){var model=this.getView().getModel("view");model.setProperty("/monthStart",this._monthStart(this._addMonths(model.getProperty("/monthStart"),months)));this._loadMonth();},
    _updateMonthCopyPreview:async function(){var model=this.getView().getModel("view"),source=model.getProperty("/copySource"),config=model.getProperty("/monthCopy");if(!source)return;var plan=await this._prepareSingleMonthCopy(source,config.targetMonth,config.mode);model.setProperty("/monthCopy/preview",plan.dates.length+" borradores por crear · "+plan.omitted+" días omitidos");},
    _prepareSingleMonthCopy:async function(source,targetMonth,mode){var existing=await this._fetchMonthEntries(targetMonth),dates=await this._eligibleMonthDates(targetMonth,mode),omitted=0;dates=dates.filter(function(date){var duplicate=existing.some(function(e){return this._sameEntry(e,source,date);}.bind(this));if(duplicate)omitted+=1;return !duplicate;}.bind(this));return {dates:dates,omitted:omitted};},
    _prepareMonthPlan:async function(sourceMonth,targetMonth,mode){var source=(await this._fetchMonthEntries(sourceMonth)).filter(function(e){return e.tipoSolicitado==="REGULAR";}),target=await this._fetchMonthEntries(targetMonth),eligible=new Set(await this._eligibleMonthDates(targetMonth,mode)),copies=[],omitted=0;source.forEach(function(entry){var date=this._mapWeekdayOccurrence(entry.fecha,targetMonth),alreadyPlanned=copies.some(function(copy){return this._sameEntry(copy.source,entry,date);}.bind(this));if(!date||!eligible.has(date)||alreadyPlanned||target.some(function(e){return this._sameEntry(e,entry,date);}.bind(this))){omitted+=1;return;}copies.push({source:entry,date:date});}.bind(this));return {copies:copies,omitted:omitted};},
    _fetchMonthEntries:async function(month){var data=await this._get("obtenerMisRegistrosMes(mesInicio="+this._monthStart(month)+")");return (data.value||data||[]).map(this._decorateEntry.bind(this));},
    _eligibleMonthDates:async function(month,mode){var start=this._monthStart(month),end=this._addDays(this._addMonths(start,1),-1),data=await this._get("obtenerDiasNoHabiles(desde="+start+",hasta="+end+")"),nonWorking=data.value||data||[],dates=[];for(var date=start;date<=end;date=this._addDays(date,1)){var day=new Date(date+"T12:00:00").getDay(),holiday=nonWorking.some(function(d){return d.fecha===date&&d.tipo==="HOLIDAY";});if(mode==="ALL"||(mode==="WEEKDAYS"&&day>=1&&day<=5)||(mode==="BUSINESS"&&day>=1&&day<=5&&!holiday))dates.push(date);}return dates;},
    _sameEntry:function(existing,source,date){return existing.fecha===date&&existing.asignacionID===source.asignacionID&&existing.tipoSolicitado===source.tipoSolicitado&&Number(existing.duracionHoras)===Number(source.duracionHoras)&&String(existing.descripcion||"").trim().toLowerCase()===String(source.descripcion||"").trim().toLowerCase();},
    _mapWeekdayOccurrence:function(sourceDate,targetMonth){var source=new Date(sourceDate+"T12:00:00"),weekday=source.getDay(),occurrence=Math.floor((source.getDate()-1)/7)+1,target=new Date(targetMonth+"T12:00:00"),delta=(weekday-target.getDay()+7)%7;target.setDate(1+delta+(occurrence-1)*7);return target.getMonth()===Number(targetMonth.slice(5,7))-1?this._iso(target):null;},
    _executeBulkCopies:async function(copies,label){var model=this.getView().getModel("view");model.setProperty("/busy",true);model.setProperty("/error",null);var results=await Promise.allSettled(copies.map(function(copy){return this._copyEntryToDate(copy.source,copy.date);}.bind(this))),successful=results.filter(function(r){return r.status==="fulfilled";}),created=successful.length,failed=results.length-created;model.setProperty("/lastBulkCopy",successful.map(function(r){return {ID:r.value?.registro?.ID};}).filter(function(r){return r.ID;}));model.setProperty("/busy",false);model.setProperty(failed?"/error":"/success",label+": "+created+" creados"+(failed?" y "+failed+" omitidos por validación.":"."));await Promise.all([this._loadWeek(false),this._loadMonth()]);},

    _loadWeek: async function (showBusy) {
      var model = this.getView().getModel("view");
      if (showBusy !== false) model.setProperty("/busy", true);
      model.setProperty("/error", null); this._setWeekLabel();
      try {
        var start = model.getProperty("/weekStart");
        var data = await Promise.all([this._get("obtenerMisAsignaciones(fecha=" + start + ")"), this._get("obtenerMisRegistros(semanaInicio=" + start + ")"), this._get("obtenerDiasNoHabiles(desde=" + start + ",hasta=" + this._addDays(start, 6) + ")")]);
        model.setProperty("/assignments", data[0].value || data[0] || []);
        var entries = (data[1].value || data[1] || []).map(this._decorateEntry.bind(this));
        entries.sort(function (a,b) { return a.fecha.localeCompare(b.fecha) || a.proyectoNombre.localeCompare(b.proyectoNombre); });
        this._analyzeWeekEntries(entries);
        model.setProperty("/entries", entries);
        model.setProperty("/nonWorkingDays", data[2].value || data[2] || []);
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
    _root: function () { return "/tiempos-empleado/"; },
    _confirmDeleteEntries: function (IDs, message) { if(!IDs.length)return; MessageBox.confirm(message,{emphasizedAction:MessageBox.Action.DELETE,actions:[MessageBox.Action.DELETE,MessageBox.Action.CANCEL],onClose:async function(action){if(action!==MessageBox.Action.DELETE)return;var model=this.getView().getModel("view");model.setProperty("/busy",true);model.setProperty("/error",null);try{await this._post("eliminarRegistros",{registros:IDs.map(function(ID){return {ID:ID};})});model.setProperty("/success",IDs.length===1?"Registro eliminado correctamente.":IDs.length+" registros eliminados correctamente.");await this._loadWeek(false);}catch(error){model.setProperty("/error",error.message);}finally{model.setProperty("/busy",false);}}.bind(this)}); },
    _setCopyDaySelection: function (predicate) { this.byId("copyDaysList").getItems().forEach(function(item){var day=item.getBindingContext("view").getObject();item.setSelected(Boolean(day.enabled&&predicate(day)));}); },
    _copyEntryToDate: function (source, date) { return this._post("guardarBorrador", { ID:null, asignacionID:source.asignacionID, fecha:date, duracionHoras:Number(source.duracionHoras), tipoSolicitado:source.tipoSolicitado, descripcion:source.descripcion||null, horaInicioAproximada:source.horaInicioAproximada||null, horaFinAproximada:source.horaFinAproximada||null, zonaHoraria:source.zonaHoraria||"America/Bogota", autorizacionPrevia:Boolean(source.autorizacionPrevia), motivoExcepcional:source.motivoExcepcional||null }); },
    _buildWeekDays: function () { var model=this.getView().getModel("view"),start=model.getProperty("/weekStart"),selected=model.getProperty("/form/fecha"),today=this._iso(new Date()),entries=model.getProperty("/entries")||[],nonWorking=model.getProperty("/nonWorkingDays")||[],days=[]; for(var i=0;i<7;i+=1){var date=this._addDays(start,i),dayEntries=entries.filter(function(entry){return entry.fecha===date;}),hours=dayEntries.reduce(function(sum,entry){return sum+Number(entry.duracionHoras||0);},0),exception=nonWorking.find(function(item){return item.fecha===date;}),state=date===selected?"selected":date===today?"today":dayEntries.length?"filled":"empty"; days.push({date:date,weekdayLabel:new Intl.DateTimeFormat("es-CO",{weekday:"short"}).format(new Date(date+"T12:00:00")).replace(".",""),dayNumber:String(Number(date.slice(8,10))),monthLabel:new Intl.DateTimeFormat("es-CO",{month:"short"}).format(new Date(date+"T12:00:00")).replace(".",""),fullLabel:this._fullDate(date),hours:hours.toFixed(1),entryCount:dayEntries.length,entryLabel:dayEntries.length?dayEntries.length+" registro(s)":"Sin registros",state:state,dayKind:exception?.tipo||"WORKDAY",nonWorkingLabel:exception?.motivo||""});} model.setProperty("/weekDays",days); model.setProperty("/form/dayFullLabel",this._fullDate(selected)); },
    _moveWeek: function (days) { var model=this.getView().getModel("view"),newStart=this._addDays(model.getProperty("/weekStart"),days); model.setProperty("/weekStart",newStart); model.setProperty("/form",this._emptyForm(newStart)); this._selectedFile=null; this.byId("supportUploader").clear(); this._loadWeek(); },
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
    _prettyDate: function (iso) { return new Intl.DateTimeFormat("es-CO",{day:"numeric",month:"short"}).format(new Date(iso+"T12:00:00")); },
    _fullDate: function (iso) { if(!iso)return ""; var value=new Intl.DateTimeFormat("es-CO",{weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(new Date(iso+"T12:00:00")); return value.charAt(0).toUpperCase()+value.slice(1); },
    _weekday: function (iso) { return new Intl.DateTimeFormat("es-CO",{weekday:"long"}).format(new Date(iso+"T12:00:00")); }
  });
});
