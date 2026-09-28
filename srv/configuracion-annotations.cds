using ConfiguracionService as service from './configuracion-service';

annotate service.Parametros with {
  clave       @title: 'Clave'        @readonly;
  grupo       @title: 'Grupo';
  nombre      @title: 'Parámetro';
  descripcion @title: 'Descripción'  @UI.MultiLineText;
  tipo        @title: 'Tipo';
  valor       @title: 'Valor';
  sistema     @title: 'De sistema'   @readonly;
}

annotate service.Parametros with @(
  UI.HeaderInfo     : {
    TypeName      : 'Parámetro',
    TypeNamePlural: 'Parámetros',
    Title         : {Value: nombre},
    Description   : {Value: grupo}
  },

  UI.SelectionFields: [
    grupo,
    tipo
  ],

  UI.LineItem       : [
    {Value: nombre,      ![@UI.Importance]: #High},
    {Value: grupo,       ![@UI.Importance]: #High},
    {Value: valor,       ![@UI.Importance]: #High},
    {Value: tipo,        ![@UI.Importance]: #Low},
    {Value: descripcion, ![@UI.Importance]: #Low}
  ],

  UI.Facets         : [{
    $Type : 'UI.ReferenceFacet',
    ID    : 'Parametro',
    Label : 'Configuración',
    Target: '@UI.FieldGroup#Parametro'
  }],

  UI.FieldGroup #Parametro: {Data: [
    {Value: clave},
    {Value: nombre},
    {Value: grupo},
    {Value: tipo},
    {Value: valor},
    {Value: descripcion},
    {Value: sistema}
  ]}
);

// Un parámetro de sistema lo necesita el código: se puede editar su valor,
// pero no borrarlo.
annotate service.Parametros with @(
  Capabilities.DeleteRestrictions: {Deletable: false},
  Capabilities.InsertRestrictions: {Insertable: false}
);
