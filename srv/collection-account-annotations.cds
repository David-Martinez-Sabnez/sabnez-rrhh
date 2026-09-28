using CollectionAccountService as service from './collection-account-service';

// ---------------------------------------------------------------- documentos
// Marcar los binarios como media hace que OData los sirva en su propia ruta
// (/CuentasCobro(ID)/documento) y que Fiori Elements los muestre como descarga.
annotate service.CuentasCobro with {
  generatedMimeType      @Core.IsMediaType;
  socialSecurityMimeType @Core.IsMediaType;

  documento              @Core.MediaType                 : generatedMimeType
                         @Core.ContentDisposition.Filename: generatedFileName
                         @Core.ContentDisposition.Type   : 'attachment'
                         @title                          : 'Cuenta de cobro';

  soporte                @Core.MediaType                 : socialSecurityMimeType
                         @Core.ContentDisposition.Filename: socialSecurityFileName
                         @Core.ContentDisposition.Type   : 'attachment'
                         @title                          : 'Soporte seguridad social';
}

// ------------------------------------------------------------------ etiquetas
annotate service.CuentasCobro with {
  numero              @title: 'Cuenta de cobro';
  prestador           @title: 'Prestador';
  tipoDocumento       @title: 'Tipo de documento';
  numeroDocumento     @title: 'Documento';
  periodStart         @title: 'Periodo desde';
  periodEnd           @title: 'Periodo hasta';
  grossAmount         @title: 'Valor bruto'  @Measures.ISOCurrency: currency;
  currency            @title: 'Moneda';
  status              @title: 'Estado';
  statusText          @title: 'Estado';
  originText          @title: 'Origen';
  preparedByUserID    @title: 'Elaborada por';
  signatureMethod     @title: 'Método de firma';
  socialSecurityRequirement @title: 'Soporte requerido';
  listaParaEnviar     @title: 'Lista para enviar';
  expedienteTexto     @title: 'Expediente';
  banco               @title: 'Banco';
  tipoCuenta          @title: 'Tipo de cuenta';
  numeroCuenta        @title: 'Número de cuenta';
  titularCuenta       @title: 'Titular';
  firmadaPor          @title: 'Firmada por';
  signedAt            @title: 'Fecha de firma';
  submittedAt         @title: 'Enviada a revisión';
  hrComment           @title: 'Comentario de RR. HH.';
  hrReviewedAt        @title: 'Aprobada el';
  hrReviewedBy        @title: 'Aprobada por';
  accountingSentAt    @title: 'Enviada a contabilidad';
  accountingSentBy    @title: 'Enviada por';
  accountingRecipient @title: 'Destinatario';
  accountingBatchID   @title: 'Lote';
}

// --------------------------------------------------------- valores de estado
annotate service.CuentasCobro with {
  status @Common.ValueListWithFixedValues @Common.Text: statusText @Common.TextArrangement: #TextOnly;
}

// ------------------------------------------------------------- List Report
annotate service.CuentasCobro with @(
  UI.HeaderInfo    : {
    TypeName      : 'Cuenta de cobro',
    TypeNamePlural: 'Cuentas de cobro',
    Title         : {Value: prestador},
    Description   : {Value: numero}
  },

  // Filtros de la barra estándar. El periodo y el estado son los dos ejes con
  // los que RR. HH. arma cada lote.
  UI.SelectionFields: [
    periodEnd,
    status,
    prestador,
    accountingSentAt
  ],

  UI.LineItem      : [
    {Value: prestador,        ![@UI.Importance]: #High},
    {Value: numero,           ![@UI.Importance]: #High},
    {Value: originText,       ![@UI.Importance]: #Medium},
    {Value: periodStart,      ![@UI.Importance]: #Medium},
    {Value: periodEnd,        ![@UI.Importance]: #Medium},
    {Value: grossAmount,      ![@UI.Importance]: #High},
    {
      Value            : statusText,
      Criticality      : criticidad,
      Label            : 'Estado',
      ![@UI.Importance]: #High
    },
    {
      Value            : expedienteTexto,
      Criticality      : criticidadExpediente,
      Label            : 'Expediente',
      ![@UI.Importance]: #High
    },
    {Value: documento,        Label: 'Cuenta de cobro',  ![@UI.Importance]: #Medium},
    {Value: soporte,          Label: 'Soporte',          ![@UI.Importance]: #Medium},
    {Value: accountingSentAt, ![@UI.Importance]: #Low},
    {Value: accountingBatchID,![@UI.Importance]: #Low}
  ],

  // ------------------------------------------------------------ Object Page
  UI.Facets        : [
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'Resumen',
      Label : 'Resumen',
      Target: '@UI.FieldGroup#Resumen'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'Documentos',
      Label : 'Documentos',
      Target: '@UI.FieldGroup#Documentos'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'Pago',
      Label : 'Datos para el pago',
      Target: '@UI.FieldGroup#Pago'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'Conceptos',
      Label : 'Conceptos facturados',
      Target: 'conceptos/@UI.LineItem'
    },
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'Trazabilidad',
      Label : 'Trazabilidad',
      Target: 'trazabilidad/@UI.LineItem'
    }
  ],

  UI.FieldGroup #Resumen   : {Data: [
    {Value: prestador},
    {Value: numeroDocumento},
    {Value: periodStart},
    {Value: periodEnd},
    {Value: grossAmount},
    {Value: statusText, Criticality: criticidad, Label: 'Estado'},
    {Value: originText},
    {Value: preparedByUserID},
    {Value: signatureMethod},
    {Value: firmadaPor},
    {Value: signedAt},
    {Value: submittedAt},
    {Value: hrReviewedBy},
    {Value: hrReviewedAt},
    {Value: hrComment}
  ]},

  UI.FieldGroup #Documentos: {Data: [
    {Value: documento, Label: 'Cuenta de cobro firmada'},
    {Value: soporte,   Label: 'Soporte de seguridad social'},
    {Value: socialSecurityRequirement},
    {Value: expedienteTexto, Criticality: criticidadExpediente, Label: 'Estado del expediente'}
  ]},

  UI.FieldGroup #Pago      : {Data: [
    {Value: banco},
    {Value: tipoCuenta},
    {Value: numeroCuenta},
    {Value: titularCuenta},
    {Value: accountingSentAt},
    {Value: accountingSentBy},
    {Value: accountingRecipient},
    {Value: accountingBatchID}
  ]}
);

// ------------------------------------------------- tablas del Object Page
annotate service.CuentasCobroConceptos with @(
  UI.LineItem: [
    {Value: projectName,   Label: 'Proyecto'},
    {Value: clientName,    Label: 'Cliente'},
    {Value: concept,       Label: 'Concepto'},
    {Value: serviceStart,  Label: 'Desde'},
    {Value: serviceEnd,    Label: 'Hasta'},
    {Value: approvedHours, Label: 'Horas aprobadas'},
    {Value: amount,        Label: 'Valor'}
  ]
);

annotate service.CuentasCobroEventos with @(
  UI.LineItem: [
    {Value: occurredAt,  Label: 'Fecha'},
    {Value: type,        Label: 'Evento'},
    {Value: actorUserID, Label: 'Usuario'},
    {Value: detail,      Label: 'Detalle'}
  ],
  UI.PresentationVariant: {SortOrder: [{Property: occurredAt, Descending: true}]}
);
