using CalendarService as service from './calendar-service';

annotate service.Calendarios with {
  code              @UI.Hidden;
  name              @title: 'Calendario' @Core.Computed;
  countryCode       @title: 'País' @Common.Text: country.name @Common.TextArrangement: #TextOnly @Common.ValueList: {
    $Type: 'Common.ValueListType', CollectionPath: 'Paises',
    Parameters: [
      {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: countryCode, ValueListProperty: 'code'},
      {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name'}
    ]
  };
  subdivisionCode   @UI.Hidden;
  hoursPerDay       @title: 'Horas por jornada';
  active            @title: 'Activo';
  lastSyncedYear    @title: 'Último año' @Core.Computed;
  lastSyncedAt      @title: 'Última sincronización' @Core.Computed;
  lastSyncCount     @title: 'Festivos cargados' @Core.Computed;
}

annotate service.Calendarios with @(
  UI.HeaderInfo: {
    TypeName: 'Calendario laboral', TypeNamePlural: 'Calendarios laborales',
    Title: {Value: countryCode}
  },
  UI.SelectionFields: [countryCode, active, lastSyncedYear],
  UI.LineItem: [
    {Value: countryCode, ![@UI.Importance]: #High},
    {Value: hoursPerDay},
    {Value: lastSyncedYear},
    {Value: lastSyncCount},
    {Value: active},
    {$Type: 'UI.DataFieldForAction', Label: 'Sincronizar festivos', Action: 'CalendarService.sincronizarFestivos'}
  ],
  UI.Identification: [
    {$Type: 'UI.DataFieldForAction', Label: 'Sincronizar festivos', Action: 'CalendarService.sincronizarFestivos'}
  ],
  UI.Facets: [
    {$Type: 'UI.ReferenceFacet', ID: 'General', Label: 'Configuración', Target: '@UI.FieldGroup#General'},
    {$Type: 'UI.ReferenceFacet', ID: 'Festivos', Label: 'Festivos', Target: 'holidays/@UI.PresentationVariant'}
  ],
  UI.FieldGroup #General: {Data: [
    {Value: countryCode}, {Value: hoursPerDay}, {Value: active}, {Value: lastSyncedYear},
    {Value: lastSyncedAt}, {Value: lastSyncCount}
  ]}
);

annotate service.Calendarios actions {
  sincronizarFestivos @Common.SideEffects: {
    TargetProperties: ['lastSyncedYear', 'lastSyncedAt', 'lastSyncCount'],
    TargetEntities: [holidays]
  };
};

annotate service.Paises with {
  code @title: 'ISO';
  name @title: 'País';
};

annotate service.Festivos with {
  date              @title: 'Fecha';
  year              @title: 'Año';
  name              @title: 'Festivo';
  countryCode       @title: 'País';
  subdivisionCodes  @title: 'Regiones';
  nationalHoliday   @title: 'Nacional';
  holidayType       @title: 'Tipo';
  source            @title: 'Fuente';
  manualOverride    @title: 'Conservar ajuste manual';
  active            @title: 'Activo';
}

annotate service.Festivos with @(
  UI.SelectionFields: [year],
  UI.LineItem: [
    {Value: year, ![@UI.Importance]: #High},
    {Value: date, ![@UI.Importance]: #High},
    {Value: name, ![@UI.Importance]: #High},
    {Value: holidayType}, {Value: nationalHoliday}, {Value: subdivisionCodes},
    {Value: source}, {Value: manualOverride}, {Value: active}
  ],
  UI.PresentationVariant: {
    GroupBy: [year],
    SortOrder: [
      {Property: year, Descending: true},
      {Property: date, Descending: false}
    ],
    Visualizations: ['@UI.LineItem']
  }
);
