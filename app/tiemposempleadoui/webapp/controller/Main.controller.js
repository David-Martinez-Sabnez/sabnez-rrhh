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
      var monday = this._startOfWeek(new Date());
      this.getView().setModel(new JSONModel({
        busy: false, error: null, success: null, weekStart: this._iso(monday), weekLabel: "",
        assignments: [], entries: [], weekDays: [], totalHours: "0.0",
        copySource: null, copyDays: [], form: this._emptyForm(this._iso(new Date()))
      }), "view");
      this._loadWeek();
    },

    onExit: function () {
      if (this._copyDialog) {
        this._copyDialog.destroy();
        this._copyDialog = null;
      }
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
    onAssignmentChange: function () { this._applyRules(); },
    onTypeChange: function () { this._applyRules(); },
    onFileSelected: function (event) { this._selectedFile = event.getParameter("files")?.[0] || null; },

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
          info: isSource ? "Día de origen" : "",
          infoState: isSource ? "Information" : "None"
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
    onSelectBusinessDays: function () { this._setCopyDaySelection(function (date) { var day=new Date(date+"T12:00:00").getDay(); return day>=1&&day<=5; }); },
    onSelectAllCopyDays: function () { this._setCopyDaySelection(function () { return true; }); },
    onClearCopyDays: function () { this._setCopyDaySelection(function () { return false; }); },
    onCopyDialogAfterClose: function () {
      var model = this.getView().getModel("view");
      model.setProperty("/copySource", null);
      model.setProperty("/copyDays", []);
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
      MessageBox.confirm("Después de enviar la semana no podrás editar sus registros hasta que sean devueltos. ¿Deseas continuar?", {
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

    _loadWeek: async function (showBusy) {
      var model = this.getView().getModel("view");
      if (showBusy !== false) model.setProperty("/busy", true);
      model.setProperty("/error", null); this._setWeekLabel();
      try {
        var start = model.getProperty("/weekStart");
        var data = await Promise.all([this._get("obtenerMisAsignaciones(fecha=" + start + ")"), this._get("obtenerMisRegistros(semanaInicio=" + start + ")")]);
        model.setProperty("/assignments", data[0].value || data[0] || []);
        var entries = (data[1].value || data[1] || []).map(this._decorateEntry.bind(this));
        entries.sort(function (a,b) { return a.fecha.localeCompare(b.fecha) || a.proyectoNombre.localeCompare(b.proyectoNombre); });
        model.setProperty("/entries", entries);
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
    _setCopyDaySelection: function (predicate) { this.byId("copyDaysList").getItems().forEach(function(item){var day=item.getBindingContext("view").getObject();item.setSelected(Boolean(day.enabled&&predicate(day.date)));}); },
    _copyEntryToDate: function (source, date) { return this._post("guardarBorrador", { ID:null, asignacionID:source.asignacionID, fecha:date, duracionHoras:Number(source.duracionHoras), tipoSolicitado:source.tipoSolicitado, descripcion:source.descripcion||null, horaInicioAproximada:source.horaInicioAproximada||null, horaFinAproximada:source.horaFinAproximada||null, zonaHoraria:source.zonaHoraria||"America/Bogota", autorizacionPrevia:Boolean(source.autorizacionPrevia), motivoExcepcional:source.motivoExcepcional||null }); },
    _buildWeekDays: function () { var model=this.getView().getModel("view"),start=model.getProperty("/weekStart"),selected=model.getProperty("/form/fecha"),today=this._iso(new Date()),entries=model.getProperty("/entries")||[],days=[]; for(var i=0;i<7;i+=1){var date=this._addDays(start,i),dayEntries=entries.filter(function(entry){return entry.fecha===date;}),hours=dayEntries.reduce(function(sum,entry){return sum+Number(entry.duracionHoras||0);},0),state=date===selected?"selected":date===today?"today":dayEntries.length?"filled":"empty"; days.push({date:date,weekdayLabel:new Intl.DateTimeFormat("es-CO",{weekday:"short"}).format(new Date(date+"T12:00:00")).replace(".",""),dayNumber:String(Number(date.slice(8,10))),monthLabel:new Intl.DateTimeFormat("es-CO",{month:"short"}).format(new Date(date+"T12:00:00")).replace(".",""),fullLabel:this._fullDate(date),hours:hours.toFixed(1),entryCount:dayEntries.length,entryLabel:dayEntries.length?dayEntries.length+" registro(s)":"Sin registros",state:state});} model.setProperty("/weekDays",days); model.setProperty("/form/dayFullLabel",this._fullDate(selected)); },
    _moveWeek: function (days) { var model=this.getView().getModel("view"),newStart=this._addDays(model.getProperty("/weekStart"),days); model.setProperty("/weekStart",newStart); model.setProperty("/form",this._emptyForm(newStart)); this._selectedFile=null; this.byId("supportUploader").clear(); this._loadWeek(); },
    _setWeekLabel: function () { var model=this.getView().getModel("view"),start=model.getProperty("/weekStart"),end=this._addDays(start,6); model.setProperty("/weekLabel",this._prettyDate(start)+" – "+this._prettyDate(end)); },
    _setFormFromEntry: function (row,date,copy) { var model=this.getView().getModel("view"); model.setProperty("/form",Object.assign(this._emptyForm(date),{ ID:copy?null:row.ID, asignacionID:row.asignacionID, duracionHoras:Number(row.duracionHoras), tipoSolicitado:row.tipoSolicitado, descripcion:row.descripcion||"", horaInicioAproximada:row.horaInicioAproximada||"", horaFinAproximada:row.horaFinAproximada||"", autorizacionPrevia:Boolean(row.autorizacionPrevia), motivoExcepcional:row.motivoExcepcional||"" })); this._selectedFile=null; this.byId("supportUploader").clear(); this._applyRules(); },
    _decorateEntry: function (entry) { var labels={REGULAR:"Regular",OVERTIME:"Extra",NIGHT:"Nocturna",SUNDAY:"Dominical",HOLIDAY:"Festiva",COMPENSATORY:"Compensatoria"}, states={DRAFT:["Borrador","Information"],RETURNED:["Devuelto","Error"],SUBMITTED:["Enviado","Success"],LEADER_APPROVED:["Aprobado por líder","Success"],INTERNALLY_APPROVED:["Aprobado","Success"]},state=states[entry.estado]||[entry.estado,"None"]; return Object.assign({},entry,{dateLabel:this._weekday(entry.fecha),typeLabel:labels[entry.tipoSolicitado]||entry.tipoSolicitado,statusLabel:state[0],statusState:state[1]}); },
    _emptyForm: function (date) { return { ID:null,fecha:date,dayFullLabel:this._fullDate(date),asignacionID:"",duracionHoras:8,tipoSolicitado:"REGULAR",descripcion:"",horaInicioAproximada:"",horaFinAproximada:"",zonaHoraria:"America/Bogota",autorizacionPrevia:false,motivoExcepcional:"",isSpecial:false,descriptionRequired:false,supportRequired:false,rulesText:"" }; },
    _startOfWeek: function (date) { var d=new Date(date.getFullYear(),date.getMonth(),date.getDate()),day=d.getDay()||7; d.setDate(d.getDate()-day+1); return d; },
    _iso: function (date) { var y=date.getFullYear(),m=String(date.getMonth()+1).padStart(2,"0"),d=String(date.getDate()).padStart(2,"0"); return y+"-"+m+"-"+d; },
    _addDays: function (iso,days) { var p=iso.split("-").map(Number),d=new Date(p[0],p[1]-1,p[2]); d.setDate(d.getDate()+days); return this._iso(d); },
    _prettyDate: function (iso) { return new Intl.DateTimeFormat("es-CO",{day:"numeric",month:"short"}).format(new Date(iso+"T12:00:00")); },
    _fullDate: function (iso) { if(!iso)return ""; var value=new Intl.DateTimeFormat("es-CO",{weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(new Date(iso+"T12:00:00")); return value.charAt(0).toUpperCase()+value.slice(1); },
    _weekday: function (iso) { return new Intl.DateTimeFormat("es-CO",{weekday:"long"}).format(new Date(iso+"T12:00:00")); }
  });
});
