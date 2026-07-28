using HomeOfficeAdminService as service from './home-office-admin-service';

annotate service.ReporteHomeOffice with @(
    UI.HeaderInfo                  : {
        TypeName      : 'Selección Home Office',
        TypeNamePlural: 'Selecciones Home Office',
        Title         : {
            $Type: 'UI.DataField',
            Value: nombreCompleto
        },
        Description   : {
            $Type: 'UI.DataField',
            Value: semanaDescripcion
        }
    },

    UI.SelectionFields             : [
        anio,
        numeroSemana,
        empleado_ID,
        estadoSemana
    ],

    UI.LineItem                    : [
        {
            $Type   : 'UI.DataField',
            Value   : anio,
            Label   : 'Año',
            Position: 10
        },
        {
            $Type   : 'UI.DataField',
            Value   : numeroSemana,
            Label   : 'Semana',
            Position: 20
        },
        {
            $Type   : 'UI.DataField',
            Value   : codigoInterno,
            Label   : 'Código',
            Position: 40
        },
        {
            $Type   : 'UI.DataField',
            Value   : nombreCompleto,
            Label   : 'Empleado',
            Position: 50
        },
        {
            $Type   : 'UI.DataField',
            Value   : lunes,
            Label   : 'Lunes',
            Position: 60
        },
        {
            $Type   : 'UI.DataField',
            Value   : martes,
            Label   : 'Martes',
            Position: 70
        },
        {
            $Type   : 'UI.DataField',
            Value   : miercoles,
            Label   : 'Miércoles',
            Position: 80
        },
        {
            $Type   : 'UI.DataField',
            Value   : jueves,
            Label   : 'Jueves',
            Position: 90
        },
        {
            $Type   : 'UI.DataField',
            Value   : viernes,
            Label   : 'Viernes',
            Position: 100
        },
        {
            $Type   : 'UI.DataField',
            Value   : diasSeleccionados,
            Label   : 'Total días',
            Position: 110
        },
        {
            $Type      : 'UI.DataField',
            Value      : estadoSemana,
            Label      : 'Estado',
            Criticality: estadoSemanaCriticality,
            Position   : 120
        }
    ],

    Capabilities.FilterRestrictions: {
        RequiredProperties          : [
            anio,
            numeroSemana
        ],
        FilterExpressionRestrictions: [
            {
                Property          : anio,
                AllowedExpressions: #SingleValue
            },
            {
                Property          : numeroSemana,
                AllowedExpressions: #MultiValue
            }
        ]
    }
);

annotate service.ReporteHomeOffice with {
    anio              @(
        title                          : 'Año',
        Common.ValueListWithFixedValues: true,
        Common.ValueList               : {
            CollectionPath: 'Anios',
            Parameters    : [{
                $Type            : 'Common.ValueListParameterInOut',
                LocalDataProperty: anio,
                ValueListProperty: 'anio'
            }]
        }
    );

    numeroSemana      @(
        title                 : 'Semana',
        Common.Text           : semanaDescripcion,
        Common.TextArrangement: #TextOnly,
        Common.ValueList      : {
            CollectionPath: 'Semanas',
            Parameters    : [
                {
                    $Type            : 'Common.ValueListParameterIn',
                    LocalDataProperty: anio,
                    ValueListProperty: 'anio'
                },
                {
                    $Type            : 'Common.ValueListParameterInOut',
                    LocalDataProperty: numeroSemana,
                    ValueListProperty: 'numeroSemana'
                },
                {
                    $Type            : 'Common.ValueListParameterDisplayOnly',
                    ValueListProperty: 'descripcion'
                },
                {
                    $Type            : 'Common.ValueListParameterDisplayOnly',
                    ValueListProperty: 'fechaInicio'
                },
                {
                    $Type            : 'Common.ValueListParameterDisplayOnly',
                    ValueListProperty: 'fechaFin'
                }
            ]
        }
    );

    empleado_ID       @title: 'Empleado';
    estadoSemana      @title: 'Estado';
    correoCorporativo @title: 'Correo corporativo';
}

annotate service.Semanas with {
    numeroSemana @title: 'N.º de semana';
    descripcion  @title: 'Semana y rango';
    fechaInicio  @title: 'Fecha inicial';
    fechaFin     @title: 'Fecha final';
};

annotate service.ReporteHomeOffice with {
    ID                       @UI.Hidden: true;
    empleado_ID              @UI.Hidden: true;
    diasSeleccionadosTexto   @UI.Hidden: true;
    estadoSemanaCriticality  @UI.Hidden: true;
    semanaInicio             @UI.Hidden: true;
    semanaFin                @UI.Hidden: true;
};
