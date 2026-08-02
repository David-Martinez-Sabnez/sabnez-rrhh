sap.ui.define(["sap/ui/core/mvc/Controller", "sap/ui/model/json/JSONModel", "sap/m/MessageBox", "sap/m/MessageToast"], function (Controller, JSONModel, MessageBox, MessageToast) {
  "use strict";
  var ROOT = "/tiempos-aprobacion/";
  return Controller.extend("sabnez.com.tiemposaprobacionui.controller.App", {
    onInit: function () {
      this._csrfToken = null;
      this.getView().setModel(new JSONModel({ busy:false,detailBusy:false,error:null,statusFilter:"PENDING",search:"",sheets:[],filteredSheets:[],detail:{resumen:{},registros:[]},comment:"" }), "view");
      this._loadInbox().then(this._openFromUrl.bind(this));
    },
    onRefresh:function(){this._loadInbox();},
    onSearch:function(event){this._model().setProperty("/search",event.getParameter("newValue")||"");this._applyFilter();},
    onStatusChange:function(){this._loadInbox();},
    onOpenSheet:function(event){var row=event.getParameter("listItem").getBindingContext("view").getObject();this._loadDetail(row.ID);},
    onBack:function(){this.byId("approvalSplit").backMaster();},
    onApprove:function(){var detail=this._model().getProperty("/detail/resumen");MessageBox.confirm("¿Deseas aprobar la hoja de "+detail.empleadoNombre+" por "+detail.totalHoras+" horas?",{title:"Aprobar tiempos",emphasizedAction:MessageBox.Action.OK,onClose:function(action){if(action===MessageBox.Action.OK)this._decide("aprobarHoja");}.bind(this)});},
    onReturn:function(){var comment=String(this._model().getProperty("/comment")||"").trim();if(comment.length<5)return MessageBox.warning("Escribe qué debe corregir el empleado antes de devolver la hoja.");MessageBox.confirm("La hoja volverá a estar editable para el empleado. ¿Deseas continuar?",{title:"Devolver para corrección",emphasizedAction:MessageBox.Action.OK,onClose:function(action){if(action===MessageBox.Action.OK)this._decide("devolverHoja");}.bind(this)});},
    onDownloadEvidence:function(event){var row=event.getSource().getBindingContext("view").getObject();this._downloadAction("descargarSoporte",{registroID:row.ID,soporteID:row.soporteID});},
    onDownloadReport:function(){this._downloadAction("generarReporteCSV",{hojaID:this._model().getProperty("/detail/resumen/ID")});},
    _loadInbox:async function(){var model=this._model();model.setProperty("/busy",true);model.setProperty("/error",null);try{var status=model.getProperty("/statusFilter"),data=await this._get("obtenerBandeja(estado='"+encodeURIComponent(status)+"')");model.setProperty("/sheets",(data.value||data||[]).map(this._decorateSheet));this._applyFilter();}catch(error){model.setProperty("/error",error.message);}finally{model.setProperty("/busy",false);}},
    _loadDetail:async function(ID){var model=this._model();model.setProperty("/detailBusy",true);try{var data=await this._get("obtenerDetalle(hojaID="+ID+")");data=data.value||data;data.resumen=this._decorateSheet(data.resumen);data.registros=(data.registros||[]).map(function(row){return Object.assign(row,{typeLabel:{REGULAR:"Regular",OVERTIME:"Extra",NIGHT:"Nocturna",SUNDAY:"Dominical",HOLIDAY:"Festiva"}[row.tipo]||row.tipo});});model.setProperty("/detail",data);model.setProperty("/comment","");this.byId("approvalSplit").toDetail(this.byId("detailPage"));history.replaceState(null,"",location.pathname+"?sheetId="+ID);}catch(error){model.setProperty("/error",error.message);}finally{model.setProperty("/detailBusy",false);}},
    _decide:async function(action){var model=this._model(),ID=model.getProperty("/detail/resumen/ID");model.setProperty("/detailBusy",true);try{var result=await this._post(action,{hojaID:ID,comentario:model.getProperty("/comment")||null});MessageToast.show(result.mensaje);await this._loadInbox();this.byId("approvalSplit").backMaster();}catch(error){MessageBox.error(error.message);}finally{model.setProperty("/detailBusy",false);}},
    _downloadAction:async function(action,payload){try{var file=await this._post(action,payload),bytes=atob(file.contenidoBase64),array=new Uint8Array(bytes.length);for(var i=0;i<bytes.length;i+=1)array[i]=bytes.charCodeAt(i);var url=URL.createObjectURL(new Blob([array],{type:file.mimeType})),link=document.createElement("a");link.href=url;link.download=file.nombre;link.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);}catch(error){MessageBox.error(error.message);}},
    _applyFilter:function(){var model=this._model(),term=String(model.getProperty("/search")||"").trim().toLowerCase(),rows=model.getProperty("/sheets")||[];model.setProperty("/filteredSheets",term?rows.filter(function(row){return [row.empleadoNombre,row.clienteNombre,row.proyectoNombre].some(function(value){return String(value||"").toLowerCase().includes(term);});}):rows);},
    _openFromUrl:function(){var ID=new URLSearchParams(location.search).get("sheetId");if(ID)this._loadDetail(ID);},
    _decorateSheet:function(row){var states={SUBMITTED:["Enviada","Information"],UNDER_REVIEW:["En revisión","Warning"],LEADER_APPROVED:["Aprobada por líder","Success"],INTERNALLY_APPROVED:["Aprobada","Success"],RETURNED:["Devuelta","Error"]},state=states[row.estado]||[row.estado,"None"];return Object.assign({},row,{statusLabel:state[0],statusState:state[1]});},
    _model:function(){return this.getView().getModel("view");},
    _get:async function(path){var response=await fetch(ROOT+path,{credentials:"same-origin",headers:{Accept:"application/json"}});if(!response.ok)throw await this._error(response);return response.json();},
    _post:async function(path,payload){var response=await fetch(ROOT+path,{method:"POST",credentials:"same-origin",headers:{Accept:"application/json","Content-Type":"application/json","X-CSRF-Token":await this._csrf()},body:JSON.stringify(payload)});if(!response.ok)throw await this._error(response);return response.json();},
    _csrf:async function(){if(this._csrfToken)return this._csrfToken;var response=await fetch(ROOT,{credentials:"same-origin",headers:{"X-CSRF-Token":"Fetch"}});if(!response.ok)throw await this._error(response);this._csrfToken=response.headers.get("X-CSRF-Token");return this._csrfToken;},
    _error:async function(response){var data=await response.json().catch(function(){return {};});return new Error(data.error?.message||"No fue posible completar la operación.");}
  });
});
