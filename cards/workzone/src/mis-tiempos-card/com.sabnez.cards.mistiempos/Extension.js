sap.ui.define(["sap/ui/integration/Extension"], function (Extension) {
	"use strict";

	var PATH_DEFECTO = "/tiempos-empleado/obtenerMiResumenMes()";

	/**
	 * Arma el array "desglose" que necesita el donut a partir de los escalares
	 * que devuelve obtenerMiResumenMes(). Tres casos:
	 *   - siempre:        "Objetivo cumplido" = min(registradas, objetivo)
	 *   - si te pasaste:  "Excedente"
	 *   - si vas corto:   "Pendiente"
	 * Asi el donut se ve bien tanto a mitad de mes como cuando ya rebasaste,
	 * y sigue funcionando si el objetivo pasa a ser relativo al dia de hoy.
	 *
	 * Cuando el CAP empiece a devolver "desglose" por su cuenta, esta extension
	 * sobra: se borra el bloque "extension" del manifest y se vuelve a
	 * "data": { "request": { ... } }.
	 */
	return Extension.extend("com.sabnez.cards.mistiempos.Extension", {

		getData: function () {
			var oCard = this.getCard();

			// OJO: oCard.getParameters() devuelve null aqui dentro.
			// Los parametros del manifest se leen con getCombinedParameters().
			var mParams = (oCard.getCombinedParameters && oCard.getCombinedParameters()) || {};

			// urlResumen solo se usa para pruebas (apuntar a un JSON de mentira).
			// En el portal va vacio y se arma con el destination.
			var sUrl = mParams.urlResumen ||
				("{{destinations.sabnezApi}}" + (mParams.pathResumen || PATH_DEFECTO));

			// Card#request pasa por processDestinations(), asi que el
			// {{destinations.sabnezApi}} de arriba se resuelve solo.
			return oCard.request({
				url: sUrl,
				method: "GET",
				parameters: { "$format": "json" }
			}).then(function (oData) {
				var reg = Number(oData.horasRegistradas) || 0;
				var obj = Number(oData.horasObjetivo) || 0;

				var cumplido  = Math.min(reg, obj);
				var excedente = Math.max(reg - obj, 0);
				var pendiente = Math.max(obj - reg, 0);

				oData.desglose = [{ concepto: "Objetivo cumplido", horas: cumplido }];
				if (excedente > 0) {
					oData.desglose.push({ concepto: "Excedente", horas: excedente });
				}
				if (pendiente > 0) {
					oData.desglose.push({ concepto: "Pendiente", horas: pendiente });
				}

				// red de seguridad por si el backend deja de mandar el porcentaje
				if (oData.porcentaje === undefined || oData.porcentaje === null) {
					oData.porcentaje = obj > 0 ? (reg / obj) * 100 : 0;
				}
				return oData;
			});
		}
	});
});
