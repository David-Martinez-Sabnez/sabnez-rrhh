using TimeReportingService as service from './time-reporting-service';

annotate service.TimeDetails with @(
  UI.HeaderInfo         : {
    TypeName      : 'Registro de tiempo',
    TypeNamePlural: 'Reporte de tiempos',
    Title         : {Value: employeeName},
    Description   : {Value: projectName}
  },

  UI.SelectionFields    : [
    workDate,
    client_ID,
    project_ID,
    employee_ID,
    entryStatus,
    requestedType,
    commercialTreatment
  ],

  UI.LineItem           : [
    {
      Value            : workDate,
      Label            : 'Fecha',
      ![@UI.Importance]: #High
    },
    {
      Value            : employeeName,
      Label            : 'Empleado',
      ![@UI.Importance]: #High
    },
    {
      Value            : clientName,
      Label            : 'Cliente',
      ![@UI.Importance]: #High
    },
    {
      Value            : projectName,
      Label            : 'Proyecto',
      ![@UI.Importance]: #High
    },
    {
      Value: approximateStartTime,
      Label: 'Hora inicio'
    },
    {
      Value: approximateEndTime,
      Label: 'Hora fin'
    },
    {
      Value            : description,
      Label            : 'Actividad / descripción',
      ![@UI.Importance]: #High
    },
    {
      Value: requestedTypeText,
      Label: 'Tipo de tiempo'
    },
    {
      Value            : registeredHours,
      Label            : 'Horas registradas',
      ![@UI.Importance]: #High
    },
    {
      Value            : billableHours,
      Label            : 'Horas facturables',
      ![@UI.Importance]: #High
    },
    {
      $Type: 'UI.DataField',
      Value: commercialTreatmentText,
      Label: 'Tratamiento comercial'
    },
    {
      $Type            : 'UI.DataField',
      Value            : entryStatusText,
      Label            : 'Estado',
      Criticality      : entryStatusCriticality,
      ![@UI.Importance]: #High
    },
    {
      Value: dailyHoursWarning,
      Label: 'Alerta diaria'
    },
    {
      Value: evidenceRequired,
      Label: 'Evidencia requerida'
    }
  ],

  UI.PresentationVariant: {
    SortOrder     : [
      {
        Property  : workDate,
        Descending: true
      },
      {
        Property  : employeeName,
        Descending: false
      }
    ],
    Visualizations: ['@UI.LineItem']
  }
);

annotate service.TimeDetails with {
  workDate        @(
    title       : 'Periodo',
    Common.Label: 'Periodo'
  );

  client_ID       @(
    title           : 'Cliente',
    Common.Label    : 'Cliente',
    Common.ValueList: {
      CollectionPath: 'Clients',
      Parameters    : [
        {
          $Type            : 'Common.ValueListParameterInOut',
          LocalDataProperty: client_ID,
          ValueListProperty: 'ID'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'legalName'
        }
      ]
    }
  );

  project_ID      @(
    title           : 'Proyecto',
    Common.Label    : 'Proyecto',
    Common.ValueList: {
      CollectionPath: 'Projects',
      Parameters    : [
        {
          $Type            : 'Common.ValueListParameterInOut',
          LocalDataProperty: project_ID,
          ValueListProperty: 'ID'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'code'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'name'
        }
      ]
    }
  );

  employee_ID     @(
    title           : 'Empleado',
    Common.Label    : 'Empleado',
    Common.ValueList: {
      CollectionPath: 'Employees',
      Parameters    : [
        {
          $Type            : 'Common.ValueListParameterInOut',
          LocalDataProperty: employee_ID,
          ValueListProperty: 'ID'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'employeeCode'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'employeeName'
        }
      ]
    }
  );

  registeredHours @Measures.Unit: 'h';
  billableHours   @Measures.Unit: 'h';
};

annotate service.DailySummary with @(
  UI.HeaderInfo     : {
    TypeName      : 'Resumen diario',
    TypeNamePlural: 'Resumen diario de tiempos'
  },

  UI.SelectionFields: [
    workDate,
    client_ID,
    project_ID,
    employee_ID
  ],

  UI.LineItem       : [
    {
      Value            : workDate,
      Label            : 'Fecha',
      ![@UI.Importance]: #High
    },
    {
      Value            : employeeName,
      Label            : 'Empleado',
      ![@UI.Importance]: #High
    },
    {
      Value            : clientName,
      Label            : 'Cliente',
      ![@UI.Importance]: #High
    },
    {
      Value            : projectName,
      Label            : 'Proyecto',
      ![@UI.Importance]: #High
    },
    {
      Value            : registeredHours,
      Label            : 'Horas registradas',
      ![@UI.Importance]: #High
    },
    {
      Value            : billableHours,
      Label            : 'Horas facturables',
      ![@UI.Importance]: #High
    }
  ]
);

annotate service.DailySummary with {
  registeredHours @Measures.Unit: 'h';
  billableHours   @Measures.Unit: 'h';
};

annotate service.TimeDetails with {
  workDate            @(
    title       : 'Periodo',
    Common.Label: 'Periodo'
  );

  client_ID           @(
    title       : 'Cliente',
    Common.Label: 'Cliente'
  );

  project_ID          @(
    title       : 'Proyecto',
    Common.Label: 'Proyecto'
  );

  employee_ID         @(
    title       : 'Empleado',
    Common.Label: 'Empleado'
  );

  entryStatus         @(
    title       : 'Estado',
    Common.Label: 'Estado'
  );

  requestedType       @(
    title       : 'Tipo de tiempo',
    Common.Label: 'Tipo de tiempo'
  );

  commercialTreatment @(
    title       : 'Tratamiento comercial',
    Common.Label: 'Tratamiento comercial'
  );

  registeredHours     @(
    title        : 'Horas registradas',
    Measures.Unit: 'h'
  );

  billableHours       @(
    title        : 'Horas facturables',
    Measures.Unit: 'h'
  );
};
