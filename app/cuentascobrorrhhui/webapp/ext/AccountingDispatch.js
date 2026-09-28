sap.ui.define(["sap/m/MessageBox", "sap/m/MessageToast"], function (MessageBox, MessageToast) {
  "use strict";

  /**
   * Único punto de código propio de esta aplicación.
   *
   * Fiori Elements invoca una acción bound una vez por fila seleccionada, lo
   * que produciría un correo por prestador. Como el requisito es un solo correo
   * con un ZIP, la selección se recoge aquí y se llama a la acción unbound
   * enviarCuentasAContabilidad, que agrupa el lote.
   */

  function cuentasSeleccionadas(contexts) {
    return contexts.map(function (context) {
      var objeto = context.getObject();
      return {
        ID: objeto.ID,
        numero: objeto.numero,
        prestador: objeto.prestador,
        listaParaEnviar: objeto.listaParaEnviar,
        expedienteTexto: objeto.expedienteTexto
      };
    });
  }

  function confirmar(texto) {
    return new Promise(function (resolve) {
      MessageBox.confirm(texto, {
        actions: ["Enviar", "Cancelar"],
        emphasizedAction: "Enviar",
        onClose: function (accion) { resolve(accion === "Enviar"); }
      });
    });
  }

  function mensajeDeError(error) {
    return (error && (error.message || (error.error && error.error.message))) ||
      "No fue posible enviar las cuentas de cobro.";
  }

  return {
    enviar: async function (pageContext, selectedContexts) {
      var contexts = selectedContexts || [];
      if (!contexts.length) {
        return MessageBox.warning("Selecciona al menos una cuenta de cobro.");
      }

      var seleccionadas = cuentasSeleccionadas(contexts);
      var enviables = seleccionadas.filter(function (row) { return row.listaParaEnviar; });
      var descartadas = seleccionadas.filter(function (row) { return !row.listaParaEnviar; });

      if (!enviables.length) {
        return MessageBox.warning(
          "Ninguna de las cuentas seleccionadas se puede enviar:\n\n" +
          descartadas.map(function (row) { return row.numero + ": " + row.expedienteTexto; }).join("\n")
        );
      }

      var texto = "Se enviarán " + enviables.length + " cuenta(s) de cobro con su soporte a contabilidad, " +
        "en un solo correo con un archivo comprimido.\n\nUna vez enviadas quedan marcadas y no se pueden reenviar.";
      if (descartadas.length) {
        texto += "\n\nQuedan fuera " + descartadas.length + " cuenta(s):\n" +
          descartadas.map(function (row) { return row.numero + ": " + row.expedienteTexto; }).join("\n");
      }

      var confirmado = await confirmar(texto);
      if (!confirmado) return;

      var model = this.getModel ? this.getModel() : this.getView().getModel();
      var operacion = model.bindContext("/enviarCuentasAContabilidad(...)");
      operacion.setParameter("accountIDs", enviables.map(function (row) { return row.ID; }));

      try {
        await operacion.execute();
        var resultado = operacion.getBoundContext().getObject();
        MessageToast.show(resultado.message);

        if (resultado.skippedCount) {
          MessageBox.warning(
            resultado.skipped.map(function (row) { return row.number + ": " + row.reason; }).join("\n"),
            { title: "Cuentas que quedaron fuera del envío" }
          );
        }

        // La tabla debe reflejar los estados nuevos: lo que se envió pasa a
        // "Enviada a contabilidad" y deja de estar disponible.
        model.refresh();
      } catch (error) {
        MessageBox.error(mensajeDeError(error));
      }
    }
  };
});
