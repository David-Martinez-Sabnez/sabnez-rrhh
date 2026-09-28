using AdminService from './admin-service';

// ============================================================
// EMPLEADOS — lista y página de detalle
// ============================================================
annotate AdminService.Empleados with @(
  Capabilities.DeleteRestrictions: {Deletable: false},
  UI                             : {
    HeaderInfo              : {
      TypeName      : 'Empleado',
      TypeNamePlural: 'Empleados',
      Title         : {Value: nombreCompleto},
      Description   : {Value: codigoInterno},
      ImageUrl       : fotoUrl
    },

    LineItem                : [
      {
        Value: codigoInterno,
        Label: 'Código'
      },
      {
        Value: nombreCompleto,
        Label: 'Nombre'
      },
      {
        Value: numeroDocumento,
        Label: 'Documento'
      },
      {
        Value: cargo_ID,
        Label: 'Cargo'
      },
      {
        Value: correoCorporativo,
        Label: 'Correo'
      },
      {
        Value: estado_codigo,
        Label: 'Estado'
      },
      {
        Value: fechaIngreso,
        Label: 'Ingreso'
      }
    ],

    SelectionFields         : [
      estado_codigo,
      cargo_ID,
      ciudad
    ],

    Facets                  : [
      {
        $Type : 'UI.ReferenceFacet',
        Label : 'Datos personales',
        Target: '@UI.FieldGroup#Personal'
      },
      {
        $Type : 'UI.ReferenceFacet',
        ID    : 'FotoEmpleado',
        Label : 'Foto del empleado',
        Target: '@UI.FieldGroup#foto',
        ![@UI.Hidden]: IsActiveEntity
      },
      {
        $Type : 'UI.ReferenceFacet',
        Label : 'Contacto',
        Target: '@UI.FieldGroup#Contacto'
      },
      {
        $Type : 'UI.ReferenceFacet',
        ID    : 'InformacionMedica',
        Label : 'Información médica',
        Target: '@UI.FieldGroup#InformacionMedica'
      },
      {
        $Type : 'UI.ReferenceFacet',
        Label : 'Datos laborales',
        Target: '@UI.FieldGroup#Laboral'
      },
      {
        $Type : 'UI.ReferenceFacet',
        Label : 'Compensación',
        Target: '@UI.FieldGroup#Compensacion'
      },
      {
        $Type : 'UI.ReferenceFacet',
        ID    : 'Afiliaciones',
        Label : 'Afiliaciones',
        Target: '@UI.FieldGroup#Afiliaciones'
      },
      {
        $Type : 'UI.ReferenceFacet',
        ID    : 'HistoricoAjustesValera',
        Label : 'Histórico y ajustes de valera',
        Target: 'saldosValeraEmocional/@UI.LineItem'
      },
      {
        $Type : 'UI.ReferenceFacet',
        Label : 'Contactos de emergencia',
        Target: 'contactosEmergencia/@UI.LineItem'
      },
      {
        $Type : 'UI.ReferenceFacet',
        Label : 'Contratos',
        Target: 'contratos/@UI.LineItem'
      },
      {
        $Type : 'UI.ReferenceFacet',
        Label : 'Datos para cuentas de cobro',
        Target: '@UI.FieldGroup#CuentaCobro'
      },
      {
        $Type : 'UI.ReferenceFacet',
        Label : 'Cuentas bancarias',
        Target: 'cuentasBancarias/@UI.LineItem'
      },
      {
        $Type : 'UI.ReferenceFacet',
        Label : 'Dependientes tributarios',
        Target: 'dependientesTributarios/@UI.LineItem'
      },
      {
        $Type : 'UI.ReferenceFacet',
        Label : 'Ausencias históricas',
        Target: 'ausencias/@UI.LineItem'
      }
    ],

    FieldGroup #Personal    : {Data: [
      {Value: tipoDocumento},
      {Value: numeroDocumento},
      {Value: lugarExpedicionDocumento},
      {Value: primerNombre},
      {Value: segundoNombre},
      {Value: primerApellido},
      {Value: segundoApellido},
      {Value: fechaNacimiento},
      {Value: genero},
      {Value: estadoCivil}
    ]},

    FieldGroup #foto        : {Data: [
      {Value: foto_content},
      {Value: foto_filename},
      {Value: foto_status}
    ]},

    FieldGroup #Contacto    : {Data: [
      {Value: correoPersonal},
      {Value: correoCorporativo},
      {Value: telefono},
      {Value: direccion},
      {Value: ciudad},
      {Value: barrio}
    ]},

    FieldGroup #InformacionMedica: {Data: [
      {Value: alergias}
    ]},

    FieldGroup #Laboral     : {Data: [
      {Value: codigoInterno},
      {Value: fechaIngreso},
      {Value: fechaRetiro},
      {Value: cargo_ID},
      {Value: facturable},
      {Value: estado_codigo},
      {Value: jefeDirecto_ID}
    ]},

    FieldGroup #Compensacion: {Data: [
      {Value: salarioBase},
      {Value: auxilioTransporte},
      {Value: auxilioConectividad}
    ]},

    FieldGroup #CuentaCobro: {Data: [
      {Value: generaCuentaCobro},
      {Value: direccionTributaria},
      {Value: ciudadTributaria},
      {Value: actividadEconomicaCiiu},
      {Value: responsableIVA},
      {Value: declaranteRenta},
      {Value: aplicaCostosDeducciones}
    ]},

    FieldGroup #Afiliaciones: {Data: [
      {Value: eps_ID},
      {Value: arl_ID},
      {Value: nivelRiesgoArl},
      {Value: fondoPension_ID},
      {Value: fondoCesantias_ID},
      {Value: cajaCompensacion_ID},
      {Value: fechaAfiliacion}
    ]},

    FieldGroup #Vacaciones  : {Data: [
      {Value: diasVacacionesCausados},
      {Value: diasVacacionesDisfrutados},
      {Value: diasVacacionesReservados},
      {Value: diasVacacionesDisponibles}
    ]},

    FieldGroup #ValeraEmocional: {Data: [
      {Value: valeraAnioActual},
      {Value: horasValeraAsignadas},
      {Value: horasValeraUtilizadas},
      {Value: horasValeraReservadas},
      {Value: horasValeraDisponibles},
      {Value: vencimientoValera},
      {Value: proximaRecargaValera}
    ]},

    FieldGroup #Cumpleanios: {Data: [
      {Value: cumpleaniosAnioBeneficio},
      {Value: horasCumpleaniosAsignadas},
      {Value: horasCumpleaniosUtilizadas},
      {Value: horasCumpleaniosReservadas},
      {Value: horasCumpleaniosDisponibles}
    ]}
  }
);

annotate AdminService.Empleados with {
  codigoInterno       @title: 'Código interno';
  numeroDocumento     @title: 'Número de documento';
  tipoDocumento       @title: 'Tipo de documento';
  primerNombre        @title: 'Primer nombre';
  segundoNombre       @title: 'Segundo nombre';
  primerApellido      @title: 'Primer apellido';
  segundoApellido     @title: 'Segundo apellido';
  nombreCompleto      @title: 'Nombre completo';
  fechaNacimiento     @title: 'Fecha de nacimiento';
  genero              @title: 'Género';
  estadoCivil         @title: 'Estado civil';
  correoPersonal      @title: 'Correo personal';
  correoCorporativo   @title: 'Correo corporativo';
  telefono            @title: 'Teléfono';
  direccion           @title: 'Dirección';
  ciudad              @title: 'Ciudad';
  barrio              @title: 'Barrio';
  alergias            @title: 'Alergias' @UI.MultiLineText;
  generaCuentaCobro   @title: '¿Es prestador y genera cuenta de cobro?'
                      @Common.QuickInfo: 'La cuenta se genera por el valor bruto de los honorarios. Las retenciones aplicables las determina Contabilidad al realizar el pago.';
  lugarExpedicionDocumento @(
    title: 'Ciudad de expedición de la identificación',
    Common.QuickInfo: 'Selecciona la ciudad que aparece como lugar de expedición en la cédula o documento del prestador.',
    Common.ValueList: {
      $Type: 'Common.ValueListType', Label: 'Ciudad de expedición', CollectionPath: 'CiudadesColombia',
      Parameters: [
        {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: lugarExpedicionDocumento, ValueListProperty: 'nombre'},
        {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'departamento'}
      ]
    }
  );
  direccionTributaria @title: 'Dirección registrada en el RUT'
                      @Common.QuickInfo: 'Copia la dirección exactamente como aparece en la sección de ubicación del RUT vigente.';
  ciudadTributaria    @(
    title: 'Ciudad registrada en el RUT',
    Common.QuickInfo: 'Selecciona el municipio que figura en el RUT vigente.',
    Common.ValueList: {
      $Type: 'Common.ValueListType', Label: 'Ciudad del RUT', CollectionPath: 'CiudadesColombia',
      Parameters: [
        {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: ciudadTributaria, ValueListProperty: 'nombre'},
        {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'departamento'}
      ]
    }
  );
  actividadEconomicaCiiu @title: 'Código CIIU principal del RUT'
                         @Common.QuickInfo: 'Copia el código numérico de la actividad económica principal que aparece en el RUT. Ejemplo: 6201.';
  responsableIVA      @title: '¿Es responsable de IVA? (consultar el RUT)'
                      @Common.QuickInfo: 'Marca Sí solamente si el RUT vigente identifica al prestador como responsable de IVA.';
  declaranteRenta     @title: '¿Declara renta? (preguntar al prestador)'
                      @Common.QuickInfo: 'Respuesta suministrada y certificada por el prestador.';
  aplicaCostosDeducciones @title: '¿Solicita costos y deducciones? (declaración del prestador)'
                          @Common.QuickInfo: 'Conserva la respuesta certificada por el prestador para una futura integración contable. No modifica el valor de la cuenta de cobro.';
  tratamientoRetencion @UI.Hidden;
  _tratamientoRetencion @UI.Hidden;
  fechaIngreso        @title: 'Fecha de ingreso';
  facturable          @title: 'Recurso facturable'
                      @Common.FieldControl: #Optional
                      @Common.QuickInfo   : 'Si su tiempo se espera que genere ingreso. Se hereda del cargo al dar de alta; desmárcalo en coordinaciones y estructura interna.';
  fechaRetiro         @title: 'Fecha de retiro';
  cargo               @title: 'Cargo';
  estado              @title: 'Estado';
  jefeDirecto         @title: 'Jefe directo';
  salarioBase         @title: 'Salario';
  auxilioTransporte   @title: 'Auxilio de transporte';
  auxilioConectividad       @title: 'Auxilio de conectividad';
  valeraAnioActual          @title: 'Año';
  horasValeraAsignadas      @title: 'Horas asignadas';
  horasValeraUtilizadas     @title: 'Horas utilizadas';
  horasValeraReservadas     @title: 'Horas reservadas';
  horasValeraDisponibles    @title: 'Horas disponibles';
  vencimientoValera         @title: 'Vencimiento';
  proximaRecargaValera      @title: 'Próxima recarga';
  cumpleaniosAnioBeneficio   @title: 'Año de la ocurrencia de cumpleaños';
  horasCumpleaniosAsignadas  @title: 'Horas de cumpleaños asignadas';
  horasCumpleaniosUtilizadas @title: 'Horas de cumpleaños utilizadas';
  horasCumpleaniosReservadas @title: 'Horas de cumpleaños reservadas';
  horasCumpleaniosDisponibles @title: 'Horas de cumpleaños disponibles';
};

// ============================================================
// DETALLES DEL EMPLEADO
// ============================================================
annotate AdminService.ContactosEmergencia with @(UI: {
  HeaderInfo         : {
    TypeName      : 'Contacto de emergencia',
    TypeNamePlural: 'Contactos de emergencia',
    Title         : {Value: nombre}
  },
  LineItem           : [
    {
      Value: nombre,
      Label: 'Nombre'
    },
    {
      Value: parentesco,
      Label: 'Parentesco'
    },
    {
      Value: telefono,
      Label: 'Teléfono'
    },
    {
      Value: esPrincipal,
      Label: 'Principal'
    }
  ],
  Facets             : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Datos',
    Target: '@UI.FieldGroup#General'
  }],
  FieldGroup #General: {Data: [
    {Value: parentesco},
    {Value: telefono},
    {Value: telefonoAlt},
    {Value: esPrincipal}
  ]}
});

annotate AdminService.ContactosEmergencia with {
  empleado    @UI.Hidden;
  nombre      @title: 'Nombre';
  parentesco  @title: 'Parentesco';
  telefono    @title: 'Teléfono';
  telefonoAlt @title: 'Teléfono alterno';
  esPrincipal @title: 'Contacto principal';
};

annotate AdminService.Contratos with @(UI: {
  HeaderInfo         : {
    TypeName      : 'Contrato',
    TypeNamePlural: 'Contratos',
    Title         : {Value: tipoContrato_codigo}
  },
  LineItem           : [
    {
      Value: tipoContrato_codigo,
      Label: 'Tipo de contrato'
    },
    {
      Value: cargo_ID,
      Label: 'Cargo'
    },
    {
      Value: fechaInicio,
      Label: 'Fecha de inicio'
    },
    {
      Value: fechaFin,
      Label: 'Fecha de finalización'
    },
    {
      Value: salario,
      Label: 'Salario'
    },
    {
      Value: vigente,
      Label: 'Vigente'
    }
  ],

  Facets             : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Datos del contrato',
    Target: '@UI.FieldGroup#General'
  }],

  FieldGroup #General: {Data: [
    {Value: cargo_ID},
    {Value: fechaInicio},
    {Value: fechaFin},
    {Value: salario},
    {Value: diaInicioCuentaCobro},
    {Value: fechaCorteCuentaCobro},
    {Value: auxilioTransporte},
    {Value: auxilioConectividad},
    {Value: vigente},
    {Value: observaciones}
  ]}
});

annotate AdminService.Contratos with {
  ID                  @UI.Hidden;
  createdAt           @UI.Hidden;
  createdBy           @UI.Hidden;
  modifiedAt          @UI.Hidden;
  modifiedBy          @UI.Hidden;

  tipoContrato_codigo @title: 'Tipo de contrato';
  cargo_ID            @title: 'Cargo';
  tipoContrato        @UI.Hidden;
  cargo               @UI.Hidden;
  fechaInicio         @title: 'Fecha de inicio';
  fechaFin            @title: 'Fecha de finalización';
  diaInicioCuentaCobro @title: 'Día inicial de cuenta de cobro'
                       @Common.FieldControl: #Mandatory;
  fechaCorteCuentaCobro @title: 'Cuentas de cobro desde'
                        @Common.FieldControl: #Optional;
  vigente             @title: 'Vigente';
  observaciones       @title: 'Observaciones'  @UI.MultiLineText;
};

annotate AdminService.CuentasBancarias with @(UI: {
  HeaderInfo: {
    TypeName: 'Cuenta bancaria', TypeNamePlural: 'Cuentas bancarias',
    Title: {Value: banco}, Description: {Value: numeroCuenta}
  },
  LineItem: [
    {Value: banco, Label: 'Banco'},
    {Value: tipoCuenta, Label: 'Tipo'},
    {Value: numeroCuenta, Label: 'Número'},
    {Value: titularNombre, Label: 'Titular'},
    {Value: principal, Label: 'Principal'},
    {Value: activa, Label: 'Activa'}
  ],
  Facets: [{$Type: 'UI.ReferenceFacet', Label: 'Datos para el pago', Target: '@UI.FieldGroup#General'}],
  FieldGroup #General: {Data: [
    {Value: banco}, {Value: tipoCuenta}, {Value: numeroCuenta},
    {Value: titularNombre}, {Value: titularTipoDocumento}, {Value: titularNumeroDocumento},
    {Value: moneda}, {Value: principal}, {Value: activa}, {Value: observaciones}
  ]}
});

annotate AdminService.CuentasBancarias with {
  empleado @UI.Hidden;
  _banco @UI.Hidden;
  _tipoCuenta @UI.Hidden;
  _moneda @UI.Hidden;
  _titularTipoDocumento @UI.Hidden;
  banco @(
    title: 'Banco o entidad financiera',
    Common.ValueListWithFixedValues: true,
    Common.ValueList: {
      $Type: 'Common.ValueListType', CollectionPath: 'EntidadesFinancieras',
      Parameters: [
        {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: banco, ValueListProperty: 'nombre'}
      ]
    }
  );
  tipoCuenta @(
    title: 'Tipo de cuenta',
    Common.ValueListWithFixedValues: true,
    Common.ValueList: {
      $Type: 'Common.ValueListType', CollectionPath: 'TiposCuentaBancaria',
      Parameters: [
        {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: tipoCuenta, ValueListProperty: 'codigo'},
        {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'descripcion'}
      ]
    },
    Common.Text: _tipoCuenta.descripcion,
    Common.TextArrangement: #TextOnly
  );
  numeroCuenta @title: 'Número de cuenta';
  titularNombre @title: 'Nombre del titular';
  titularTipoDocumento @(
    title: 'Tipo de documento del titular',
    Common.ValueListWithFixedValues: true,
    Common.ValueList: {
      $Type: 'Common.ValueListType', CollectionPath: 'TiposDocumento',
      Parameters: [
        {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: titularTipoDocumento, ValueListProperty: 'codigo'},
        {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'descripcion'}
      ]
    },
    Common.Text: _titularTipoDocumento.descripcion,
    Common.TextArrangement: #TextOnly
  );
  titularNumeroDocumento @title: 'Documento del titular';
  moneda @(
    title: 'Moneda', Semantics.currencyCode,
    Common.ValueListWithFixedValues: true,
    Common.ValueList: {
      $Type: 'Common.ValueListType', CollectionPath: 'Monedas',
      Parameters: [
        {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: moneda, ValueListProperty: 'codigo'},
        {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'descripcion'}
      ]
    }
  );
  principal @title: 'Cuenta principal';
  activa @title: 'Activa';
  observaciones @title: 'Observaciones' @UI.MultiLineText;
};

annotate AdminService.DependientesTributarios with @(UI: {
  HeaderInfo: {
    TypeName: 'Dependiente tributario', TypeNamePlural: 'Dependientes tributarios',
    Title: {Value: nombre}, Description: {Value: parentesco}
  },
  LineItem: [
    {Value: nombre, Label: 'Nombre'},
    {Value: numeroDocumento, Label: 'Documento'},
    {Value: parentesco, Label: 'Parentesco'},
    {Value: fechaNacimiento, Label: 'Nacimiento'},
    {Value: activo, Label: 'Activo'}
  ],
  Facets: [{$Type: 'UI.ReferenceFacet', Label: 'Datos del dependiente', Target: '@UI.FieldGroup#General'}],
  FieldGroup #General: {Data: [
    {Value: nombre}, {Value: tipoDocumento}, {Value: numeroDocumento}, {Value: parentesco},
    {Value: fechaNacimiento}, {Value: vigenteDesde}, {Value: vigenteHasta},
    {Value: activo}, {Value: observaciones}
  ]}
});

annotate AdminService.DependientesTributarios with {
  empleado @UI.Hidden;
  _tipoDocumento @UI.Hidden;
  _parentesco @UI.Hidden;
  nombre @title: 'Nombre completo';
  tipoDocumento @(
    title: 'Tipo de documento',
    Common.ValueListWithFixedValues: true,
    Common.ValueList: {
      $Type: 'Common.ValueListType', CollectionPath: 'TiposDocumento',
      Parameters: [
        {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: tipoDocumento, ValueListProperty: 'codigo'},
        {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'descripcion'}
      ]
    },
    Common.Text: _tipoDocumento.descripcion,
    Common.TextArrangement: #TextOnly
  );
  numeroDocumento @title: 'Número de documento';
  parentesco @(
    title: 'Parentesco',
    Common.ValueListWithFixedValues: true,
    Common.ValueList: {
      $Type: 'Common.ValueListType', CollectionPath: 'Parentescos',
      Parameters: [
        {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: parentesco, ValueListProperty: 'codigo'},
        {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'descripcion'}
      ]
    },
    Common.Text: _parentesco.descripcion,
    Common.TextArrangement: #TextOnly
  );
  fechaNacimiento @title: 'Fecha de nacimiento';
  vigenteDesde @title: 'Vigente desde';
  vigenteHasta @title: 'Vigente hasta';
  activo @title: 'Activo';
  observaciones @title: 'Observaciones' @UI.MultiLineText;
};

annotate AdminService.DocumentosEmpleado with @(
  Capabilities.DeleteRestrictions: {Deletable: false},
  UI: {
    HeaderInfo: {
      TypeName: 'Documento del expediente', TypeNamePlural: 'Expediente documental',
      Title: {Value: nombre}, Description: {Value: tipo_codigo}
    },
    LineItem: [
      {Value: tipo_codigo, Label: 'Clasificación'},
      {Value: nombre, Label: 'Documento'},
      {Value: fechaDocumento, Label: 'Fecha'},
      {Value: contrato, Label: 'Contrato relacionado'},
      {Value: estado, Label: 'Estado'},
      {Value: createdBy, Label: 'Cargado por'},
      {Value: createdAt, Label: 'Cargado el'}
    ],
    Facets: [
      {$Type: 'UI.ReferenceFacet', Label: 'Clasificación', Target: '@UI.FieldGroup#General'},
      {$Type: 'UI.ReferenceFacet', Label: 'Archivo', Target: '@UI.FieldGroup#Archivo'},
      {$Type: 'UI.ReferenceFacet', Label: 'Trazabilidad', Target: '@UI.FieldGroup#Auditoria'}
    ],
    FieldGroup #General: {Data: [
      {Value: tipo_codigo}, {Value: nombre}, {Value: fechaDocumento}, {Value: contrato},
      {Value: vigenteDesde}, {Value: vigenteHasta}, {Value: estado},
      {Value: confidencial}, {Value: observaciones}
    ]},
    FieldGroup #Archivo: {Data: [
      {Value: archivo_content}, {Value: archivo_filename}, {Value: archivo_status}
    ]},
    FieldGroup #Auditoria: {Data: [
      {Value: createdBy}, {Value: createdAt}, {Value: modifiedBy}, {Value: modifiedAt}
    ]}
  }
);

annotate AdminService.DocumentosEmpleado with {
  empleado @UI.Hidden;
  tipo @UI.Hidden;
  tipo_codigo @(
    title: 'Tipo de documento',
    Common.ValueListWithFixedValues: true,
    Common.ValueList: {
      $Type: 'Common.ValueListType', CollectionPath: 'TiposDocumentoEmpleado',
      Parameters: [
        {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: tipo_codigo, ValueListProperty: 'codigo'},
        {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'descripcion'},
        {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'categoria'}
      ]
    },
    Common.Text: tipo.descripcion,
    Common.TextArrangement: #TextOnly
  );
  nombre @title: 'Nombre descriptivo';
  fechaDocumento @title: 'Fecha del documento';
  contrato @title: 'Contrato relacionado';
  vigenteDesde @title: 'Vigente desde';
  vigenteHasta @title: 'Vigente hasta';
  estado @title: 'Estado';
  confidencial @title: 'Confidencial';
  observaciones @title: 'Observaciones' @UI.MultiLineText;
  createdBy @title: 'Cargado por' @Core.Immutable;
  createdAt @title: 'Cargado el' @Core.Immutable;
  modifiedBy @title: 'Última modificación por' @Core.Immutable;
  modifiedAt @title: 'Última modificación' @Core.Immutable;
};

annotate AdminService.TiposDocumentoEmpleado with {
  codigo @Common.Text: descripcion @Common.TextArrangement: #TextOnly;
  descripcion @title: 'Tipo de documento';
  categoria @title: 'Categoría';
};

annotate AdminService.Ausencias with @(UI: {
  HeaderInfo         : {
    TypeName      : 'Ausencia histórica',
    TypeNamePlural: 'Ausencias históricas',
    Title         : {Value: tipoAusencia_codigo}
  },
  LineItem           : [
    {
      Value: tipoAusencia_codigo,
      Label: 'Tipo de ausencia'
    },
    {
      Value: fechaInicio,
      Label: 'Desde'
    },
    {
      Value: fechaFin,
      Label: 'Hasta'
    },
    {
      Value: diasHabiles,
      Label: 'Días hábiles'
    },
    {
      Value: horasSolicitadas,
      Label: 'Horas'
    },
    {
      Value: estadoa_codigo,
      Label: 'Estado de la ausencia'
    }
  ],

  Facets             : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Datos de la ausencia',
      Target: '@UI.FieldGroup#General'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Soportes',
      Target: 'soportes/@UI.LineItem'
    }
  ],

  FieldGroup #General: {Data: [
    {Value: tipoAusencia_codigo},
    {Value: fechaInicio},
    {Value: fechaFin},
    {Value: diasHabiles},
    {Value: horaInicio},
    {Value: horaFin},
    {Value: horasSolicitadas},
    {Value: estadoa_codigo},
    {Value: motivo},
    {Value: aprobadaPor_ID},
    {Value: fechaAprobacion}
  ]}
});

annotate AdminService.Ausencias with {
  ID                  @UI.Hidden;
  empleado            @UI.Hidden;
  origenRegistro      @UI.Hidden @Core.Immutable;
  tipoAusencia        @UI.Hidden;
  estadoAusencia      @UI.Hidden;
  unidadConsumo       @UI.Hidden;
  createdAt           @UI.Hidden;
  createdBy           @UI.Hidden;
  modifiedAt          @UI.Hidden;
  modifiedBy          @UI.Hidden;

  tipoAusencia_codigo @title: 'Tipo de ausencia';
  fechaInicio         @title: 'Fecha de inicio';
  fechaFin            @title: 'Fecha de finalización'
                      @Common.FieldControl: (unidadConsumo = #HORAS ? #ReadOnly : #Mandatory);
  diasHabiles         @title: 'Días hábiles'
                      @Common.FieldControl: #ReadOnly;
  horaInicio          @title: 'Hora de inicio'
                      @UI.DateTimeStyle: 'short'
                      @Common.FieldControl: (unidadConsumo = #HORAS ? #Mandatory : #ReadOnly);
  horaFin             @title: 'Hora de finalización'
                      @UI.DateTimeStyle: 'short'
                      @Common.FieldControl: (unidadConsumo = #HORAS ? #Mandatory : #ReadOnly);
  horasSolicitadas    @title: 'Horas solicitadas'
                      @Common.FieldControl: #ReadOnly;
  estadoa_codigo      @title: 'Estado de la ausencia';
  motivo              @title: 'Motivo'  @UI.MultiLineText;
  aprobadaPor         @title: 'Aprobada por';
  fechaAprobacion     @title: 'Fecha de aprobación';
};

// ============================================================
// SALDO ANUAL DE VALERA EMOCIONAL
// ============================================================
annotate AdminService.SaldosValeraEmocional with @(UI: {
  HeaderInfo         : {
    TypeName      : 'Saldo de valera emocional',
    TypeNamePlural: 'Saldos de valera emocional',
    Title         : {Value: anio}
  },
  LineItem           : [
    {Value: anio,          Label: 'Año'},
    {Value: horasBase,     Label: 'Horas base'},
    {Value: horasAjuste,   Label: 'Ajuste'},
    {Value: observaciones, Label: 'Observaciones'}
  ],
  Facets             : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Datos del saldo',
    Target: '@UI.FieldGroup#General'
  }],
  FieldGroup #General: {Data: [
    {Value: anio},
    {Value: horasBase},
    {Value: horasAjuste},
    {Value: observaciones}
  ]}
});

annotate AdminService.SaldosValeraEmocional with {
  ID            @UI.Hidden;
  empleado      @UI.Hidden;
  createdAt     @UI.Hidden;
  createdBy     @UI.Hidden;
  modifiedAt    @UI.Hidden;
  modifiedBy    @UI.Hidden;
  anio          @title: 'Año';
  horasBase     @title: 'Horas base';
  horasAjuste   @title: 'Ajuste de horas';
  observaciones @title: 'Observaciones' @UI.MultiLineText;
};


// ============================================================
// VALUE HELPS Y TEXTOS
// ============================================================
annotate AdminService.Empleados {


  tipoDocumento @(
    Common.ValueListWithFixedValues: true,
    Common.ValueList               : {
      CollectionPath: 'TiposDocumento',
      Parameters    : [
        {
          $Type            : 'Common.ValueListParameterInOut',
          LocalDataProperty: tipoDocumento,
          ValueListProperty: 'codigo'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'descripcion'
        }
      ]
    },
    Common.Text                    : _tipoDocumento.descripcion,
    Common.TextArrangement         : #TextOnly
  );

  genero        @(
    Common.ValueListWithFixedValues: true,
    Common.ValueList               : {
      CollectionPath: 'Generos',
      Parameters    : [
        {
          $Type            : 'Common.ValueListParameterInOut',
          LocalDataProperty: genero,
          ValueListProperty: 'codigo'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'descripcion'
        }
      ]
    },
    Common.Text                    : _genero.descripcion,
    Common.TextArrangement         : #TextOnly
  );

  estadoCivil   @(
    Common.ValueListWithFixedValues: true,
    Common.ValueList               : {
      CollectionPath: 'EstadosCiviles',
      Parameters    : [
        {
          $Type            : 'Common.ValueListParameterInOut',
          LocalDataProperty: estadoCivil,
          ValueListProperty: 'codigo'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'descripcion'
        }
      ]
    },
    Common.Text                    : _estadoCivil.descripcion,
    Common.TextArrangement         : #TextOnly
  );

  ciudad        @(
    Common.ValueListWithFixedValues: true,
    Common.ValueList               : {
      $Type         : 'Common.ValueListType',
      Label         : 'Ciudad',
      CollectionPath: 'CiudadesColombia',
      Parameters    : [
        {
          $Type            : 'Common.ValueListParameterInOut',
          LocalDataProperty: ciudad,
          ValueListProperty: 'nombre'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'departamento'
        }
      ]
    }
  );

  cargo         @(
    Common.ValueList      : {
      entity: 'Cargos',
      type  : #fixed
    },
    Common.Text           : cargo.nombre,
    Common.TextArrangement: #TextOnly
  );
  estado        @(
    Common.ValueList      : {
      entity: 'Estados',
      type  : #fixed
    },
    Common.Text           : estado.descripcion,
    Common.TextArrangement: #TextOnly
  );
  jefeDirecto   @(
    Common.ValueList      : {
      CollectionPath: 'EmpleadosVH',
      Parameters    : [
        {
          $Type            : 'Common.ValueListParameterInOut',
          LocalDataProperty: jefeDirecto_ID,
          ValueListProperty: 'ID'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'nombreCompleto'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'codigoInterno'
        }
      ]
    },
    Common.Text           : jefeDirecto.nombreCompleto,
    Common.TextArrangement: #TextOnly
  );
};


annotate AdminService.Contratos with {
  tipoContrato_codigo @(
    Common.ValueListWithFixedValues: true,
    Common.ValueList               : {
      $Type         : 'Common.ValueListType',
      CollectionPath: 'TiposContrato',
      Parameters    : [
        {
          $Type            : 'Common.ValueListParameterInOut',
          LocalDataProperty: tipoContrato_codigo,
          ValueListProperty: 'codigo'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'descripcion'
        }
      ]
    },
    Common.Text                    : tipoContrato.descripcion,
    Common.TextArrangement         : #TextOnly
  );

  cargo_ID            @(
    Common.ValueList      : {
      $Type         : 'Common.ValueListType',
      CollectionPath: 'CargosVH',
      Parameters    : [
        {
          $Type            : 'Common.ValueListParameterInOut',
          LocalDataProperty: cargo_ID,
          ValueListProperty: 'ID'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'nombre'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'descripcion'
        }
      ]
    },
    Common.Text           : cargo.nombre,
    Common.TextArrangement: #TextOnly
  );
};

annotate AdminService.Ausencias {

  tipoAusencia_codigo @(
    Common.ValueListWithFixedValues: true,

    Common.ValueList               : {
      $Type         : 'Common.ValueListType',
      CollectionPath: 'TiposAusencia',

      Parameters    : [
        {
          $Type            : 'Common.ValueListParameterInOut',
          LocalDataProperty: tipoAusencia_codigo,
          ValueListProperty: 'codigo'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'descripcion'
        }
      ]
    },

    Common.Text                    : tipoAusencia.descripcion,
    Common.TextArrangement         : #TextOnly
  );

  estadoa_codigo       @(
    Common.ValueListWithFixedValues: true,

    Common.ValueList               : {
      $Type         : 'Common.ValueListType',
      CollectionPath: 'EstadosAusencia',

      Parameters    : [
        {
          $Type            : 'Common.ValueListParameterInOut',
          LocalDataProperty: estadoa_codigo,
          ValueListProperty: 'codigo'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'descripcion'
        }
      ]
    },

    Common.Text                    : estadoAusencia.descripcion,
    Common.TextArrangement         : #TextOnly
  );

  aprobadaPor         @(
    Common.ValueList      : {
      CollectionPath: 'EmpleadosVH',

      Parameters    : [
        {
          $Type            : 'Common.ValueListParameterInOut',
          LocalDataProperty: aprobadaPor_ID,
          ValueListProperty: 'ID'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'nombreCompleto'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'codigoInterno'
        }
      ]
    },

    Common.Text           : aprobadaPor.nombreCompleto,
    Common.TextArrangement: #TextOnly
  );
};

annotate AdminService.Cargos with {
  ID          @Common.Text: nombre  @Common.TextArrangement: #TextOnly;
  nombre      @title: 'Cargo';
  descripcion @title: 'Descripción';
  activo      @title: 'Activo';
};

annotate AdminService.Estados with {
  codigo  @title: 'Código'  @Common.Text: descripcion  @Common.TextArrangement: #TextOnly;
};

annotate AdminService.TiposContrato with {
  codigo
  @Common.Text           : descripcion
  @Common.TextArrangement: #TextOnly;

  descripcion
  @title: 'Tipo de contrato';
};

annotate AdminService.TiposAusencia with {
  codigo
  @title                 : 'Código'
  @Common.Text           : descripcion
  @Common.TextArrangement: #TextOnly;

  descripcion
  @title: 'Tipo de ausencia';
};

annotate AdminService.EstadosAusencia with {
  codigo
  @title                 : 'Código'
  @Common.Text           : descripcion
  @Common.TextArrangement: #TextOnly;

  descripcion
  @title: 'Estado';
};

annotate AdminService.EPS with {
  ID     @Common.Text: nombre  @Common.TextArrangement: #TextOnly;
  nombre @title: 'Nombre de la EPS';
  activa @title: 'Activa';
};

annotate AdminService.ARL with {
  ID     @Common.Text: nombre  @Common.TextArrangement: #TextOnly;
  nombre @title: 'Nombre de la ARL';
  activa @title: 'Activa';
};

annotate AdminService.FondosPension with {
  ID     @Common.Text: nombre  @Common.TextArrangement: #TextOnly;
  nombre @title: 'Nombre del fondo';
  activo @title: 'Activo';
};

annotate AdminService.FondosCesantias with {
  ID     @Common.Text: nombre  @Common.TextArrangement: #TextOnly;
  nombre @title: 'Nombre del fondo';
  activo @title: 'Activo';
};

annotate AdminService.CajasCompensacion with {
  ID     @Common.Text: nombre  @Common.TextArrangement: #TextOnly;
  nombre @title: 'Nombre de la caja';
  activa @title: 'Activa';
};

// Los catálogos editables no se borran físicamente: se inactivan.
annotate AdminService.Cargos with @Capabilities.DeleteRestrictions: {Deletable: false};
annotate AdminService.EPS with @Capabilities.DeleteRestrictions: {Deletable: false};
annotate AdminService.ARL with @Capabilities.DeleteRestrictions: {Deletable: false};
annotate AdminService.FondosPension with @Capabilities.DeleteRestrictions: {Deletable: false};
annotate AdminService.FondosCesantias with @Capabilities.DeleteRestrictions: {Deletable: false};
annotate AdminService.CajasCompensacion with @Capabilities.DeleteRestrictions: {Deletable: false};

// Catálogo de ciudades de solo lectura
annotate AdminService.CiudadesColombia with @(UI: {
  HeaderInfo     : {
    TypeName      : 'Ciudad',
    TypeNamePlural: 'Ciudades',
    Title         : {Value: nombre},
    Description   : {Value: departamento}
  },
  LineItem       : [
    {Value: nombre,       Label: 'Ciudad'},
    {Value: departamento, Label: 'Departamento'},
    {Value: codigo,       Label: 'Código DANE'}
  ],
  SelectionFields: [nombre, departamento]
});

annotate AdminService.CiudadesColombia with {
  codigo       @title: 'Código DANE';
  nombre       @title: 'Ciudad';
  departamento @title: 'Departamento';
};

// ============================================================
// PANTALLAS DE CATÁLOGOS EDITABLES
// ============================================================
annotate AdminService.Cargos with @(UI: {
  HeaderInfo   : {
    TypeName      : 'Cargo',
    TypeNamePlural: 'Cargos',
    Title         : {Value: nombre}
  },
  LineItem     : [
    {
      Value: nombre,
      Label: 'Nombre'
    },
    {
      Value: descripcion,
      Label: 'Descripción'
    },
    {
      Value: activo,
      Label: 'Activo'
    }
  ],
  Facets       : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Datos',
    Target: '@UI.FieldGroup#G'
  }],
  FieldGroup #G: {Data: [
    {Value: nombre},
    {Value: descripcion},
    {Value: activo}
  ]}
});

annotate AdminService.EPS with @(UI: {
  HeaderInfo   : {
    TypeName      : 'EPS',
    TypeNamePlural: 'EPS',
    Title         : {Value: nombre}
  },
  LineItem     : [
    {
      Value: nombre,
      Label: 'Nombre'
    },
    {
      Value: activa,
      Label: 'Activa'
    }
  ],
  Facets       : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Datos',
    Target: '@UI.FieldGroup#G'
  }],
  FieldGroup #G: {Data: [
    {Value: nombre},
    {Value: activa}
  ]}
});

annotate AdminService.ARL with @(UI: {
  HeaderInfo   : {
    TypeName      : 'ARL',
    TypeNamePlural: 'ARL',
    Title         : {
      Value: nombre,
      readonly
    }
  },
  LineItem     : [
    {
      Value: nombre,
      Label: 'Nombre'
    },
    {
      Value: activa,
      Label: 'Activa'
    }
  ],
  Facets       : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Datos',
    Target: '@UI.FieldGroup#G'
  }],
  FieldGroup #G: {Data: [
    {Value: nombre},
    {Value: activa}
  ]}
});

annotate AdminService.FondosPension with @(UI: {
  HeaderInfo   : {
    TypeName      : 'Fondo de pensión',
    TypeNamePlural: 'Fondos de pensión',
    Title         : {Value: nombre}
  },
  LineItem     : [
    {
      Value: nombre,
      Label: 'Nombre'
    },
    {
      Value: activo,
      Label: 'Activo'
    }
  ],
  Facets       : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Datos',
    Target: '@UI.FieldGroup#G'
  }],
  FieldGroup #G: {Data: [
    {Value: nombre},
    {Value: activo}
  ]}
});

annotate AdminService.FondosCesantias with @(UI: {
  HeaderInfo   : {
    TypeName      : 'Fondo de cesantías',
    TypeNamePlural: 'Fondos de cesantías',
    Title         : {Value: nombre}
  },
  LineItem     : [
    {
      Value: nombre,
      Label: 'Nombre'
    },
    {
      Value: activo,
      Label: 'Activo'
    }
  ],
  Facets       : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Datos',
    Target: '@UI.FieldGroup#G'
  }],
  FieldGroup #G: {Data: [
    {Value: nombre},
    {Value: activo}
  ]}
});

annotate AdminService.CajasCompensacion with @(UI: {
  HeaderInfo   : {
    TypeName      : 'Caja de compensación',
    TypeNamePlural: 'Cajas de compensación',
    Title         : {Value: nombre}
  },
  LineItem     : [
    {
      Value: nombre,
      Label: 'Nombre'
    },
    {
      Value: activa,
      Label: 'Activa'
    }
  ],
  Facets       : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Datos',
    Target: '@UI.FieldGroup#G'
  }],
  FieldGroup #G: {Data: [
    {Value: nombre},
    {Value: activa}
  ]}
});

annotate AdminService.Estados with @(UI: {
  LineItem       : [
    {
      Value: descripcion,
      Label: 'Estado'
    },
    {
      Value: codigo,
      Label: 'Código'
    }
  ],
  SelectionFields: [
    descripcion,
    codigo
  ]
});

annotate AdminService.Cargos with {
  ID         @UI.Hidden;
  createdAt  @UI.Hidden;
  createdBy  @UI.Hidden;
  modifiedAt @UI.Hidden;
  modifiedBy @UI.Hidden;
};

annotate AdminService.EPS with {
  ID         @UI.Hidden;
  createdAt  @UI.Hidden;
  createdBy  @UI.Hidden;
  modifiedAt @UI.Hidden;
  modifiedBy @UI.Hidden;
};

annotate AdminService.ARL with {
  ID         @UI.Hidden;
  createdAt  @UI.Hidden;
  createdBy  @UI.Hidden;
  modifiedAt @UI.Hidden;
  modifiedBy @UI.Hidden;
};

annotate AdminService.FondosPension with {
  ID         @UI.Hidden;
  createdAt  @UI.Hidden;
  createdBy  @UI.Hidden;
  modifiedAt @UI.Hidden;
  modifiedBy @UI.Hidden;
};

annotate AdminService.FondosCesantias with {
  ID         @UI.Hidden;
  createdAt  @UI.Hidden;
  createdBy  @UI.Hidden;
  modifiedAt @UI.Hidden;
  modifiedBy @UI.Hidden;
};

annotate AdminService.CajasCompensacion with {
  ID         @UI.Hidden;
  createdAt  @UI.Hidden;
  createdBy  @UI.Hidden;
  modifiedAt @UI.Hidden;
  modifiedBy @UI.Hidden;
};

annotate AdminService.EmpleadosVH with @(UI: {
  LineItem       : [
    {
      Value: nombreCompleto,
      Label: 'Nombre completo'
    },
    {
      Value: codigoInterno,
      Label: 'Código interno'
    }
  ],
  SelectionFields: [
    nombreCompleto,
    codigoInterno
  ]
});

annotate AdminService.EmpleadosVH with {
  ID             @UI.Hidden;
  nombreCompleto @title: 'Nombre completo';
  codigoInterno  @title: 'Código interno';
};

annotate AdminService.Empleados with {
  diasVacacionesCausados    @title: 'Días causados';
  diasVacacionesDisfrutados @title: 'Días disfrutados';
  diasVacacionesReservados  @title: 'Días reservados';
  diasVacacionesDisponibles @title: 'Días disponibles';
  eps                       @title: 'EPS';
  arl                       @title: 'ARL';
  nivelRiesgoArl            @title: 'Nivel de riesgo ARL';
  fondoPension              @title: 'Fondo de pensión';
  fondoCesantias            @title: 'Fondo de cesantías';
  cajaCompensacion          @title: 'Caja de compensación';
  fechaAfiliacion           @title: 'Fecha de afiliación';
};

annotate AdminService.Empleados {

  eps              @(
    Common.ValueList      : {
      entity: 'EPS',
      type  : #fixed
    },
    Common.Text           : eps.nombre,
    Common.TextArrangement: #TextOnly
  );

  arl              @(
    Common.ValueList      : {
      entity: 'ARL',
      type  : #fixed
    },
    Common.Text           : arl.nombre,
    Common.TextArrangement: #TextOnly
  );

  fondoPension     @(
    Common.ValueList      : {
      entity: 'FondosPension',
      type  : #fixed
    },
    Common.Text           : fondoPension.nombre,
    Common.TextArrangement: #TextOnly
  );

  fondoCesantias   @(
    Common.ValueList      : {
      entity: 'FondosCesantias',
      type  : #fixed
    },
    Common.Text           : fondoCesantias.nombre,
    Common.TextArrangement: #TextOnly
  );

  cajaCompensacion @(
    Common.ValueList      : {
      entity: 'CajasCompensacion',
      type  : #fixed
    },
    Common.Text           : cajaCompensacion.nombre,
    Common.TextArrangement: #TextOnly
  );
};

annotate AdminService.ContactosEmergencia {
  _parentesco @UI.Hidden;

  parentesco  @(
    Common.ValueListWithFixedValues: true,

    Common.ValueList               : {
      $Type         : 'Common.ValueListType',
      Label         : 'Parentesco',
      CollectionPath: 'Parentescos',

      Parameters    : [
        {
          $Type            : 'Common.ValueListParameterInOut',
          LocalDataProperty: parentesco,
          ValueListProperty: 'codigo'
        },
        {
          $Type            : 'Common.ValueListParameterDisplayOnly',
          ValueListProperty: 'descripcion'
        }
      ]
    },

    Common.Text                    : _parentesco.descripcion,
    Common.TextArrangement         : #TextOnly
  );
};

annotate AdminService.Parentescos with {
  codigo
  @Common.Text           : descripcion
  @Common.TextArrangement: #TextOnly;

  descripcion
  @title: 'Parentesco';
};

annotate AdminService.Contratos with {
  fechaFin
  @Common.FieldControl : (vigente = true ? #ReadOnly : #Optional);
};

annotate AdminService.Contratos with @(Common.SideEffects #CambioVigencia: {
  SourceProperties: [vigente],
  TargetProperties: ['fechaFin']
});

annotate AdminService.Contratos.adjuntos with @UI.LineItem: [
  {Value: content, Label: 'Anexo'},
  {Value: tipoDocumento_codigo, Label: 'Tipo de documento'},
  {Value: status, Label: 'Estado de escaneo', Criticality: statusNav.criticality},
  {Value: createdAt, Label: 'Fecha de creación'},
  {Value: createdBy, Label: 'Autor'},
  {Value: note, Label: 'Nota'}
];

annotate AdminService.Contratos.adjuntos with {
  tipoDocumento @UI.Hidden;
  tipoDocumento_codigo @(
    title: 'Tipo de documento',
    Common.ValueListWithFixedValues: true,
    Common.ValueList: {
      $Type: 'Common.ValueListType', CollectionPath: 'TiposDocumentoEmpleado',
      Parameters: [
        {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: tipoDocumento_codigo, ValueListProperty: 'codigo'},
        {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'descripcion'},
        {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'categoria'}
      ]
    },
    Common.Text: tipoDocumento.descripcion,
    Common.TextArrangement: #TextOnly
  );
  content
  @Core.AcceptableMediaTypes: ['application/pdf', 'image/jpeg', 'image/png']
  @Validation.Maximum       : '15MB';
};

annotate AdminService.EntidadesFinancieras with {
  codigo @UI.Hidden;
  nombre @title: 'Entidad financiera';
};

annotate AdminService.TiposCuentaBancaria with {
  codigo @Common.Text: descripcion @Common.TextArrangement: #TextOnly;
  descripcion @title: 'Tipo de cuenta';
};

annotate AdminService.Monedas with {
  codigo @Common.Text: descripcion @Common.TextArrangement: #TextOnly;
  descripcion @title: 'Moneda';
};

annotate AdminService.Contratos with {
  salario
  @Measures.ISOCurrency: moneda;

  auxilioTransporte
  @Measures.ISOCurrency: moneda;

  auxilioConectividad
  @Measures.ISOCurrency: moneda;

  moneda
  @Semantics.currencyCode;
};

annotate AdminService.Empleados with {
  salarioBase
  @Measures.ISOCurrency: moneda;

  auxilioTransporte
  @Measures.ISOCurrency: moneda;

  auxilioConectividad
  @Measures.ISOCurrency: moneda;

  moneda
  @Semantics.currencyCode
  @UI.Hidden;
};

annotate AdminService.Contratos with {
  salario
  @title: 'Salario';

  auxilioTransporte
  @title: 'Auxilio de transporte';

  auxilioConectividad
  @title: 'Auxilio de conectividad';

  moneda
  @title: 'Moneda';
};

annotate AdminService.CargosVH with @(UI: {
  LineItem       : [
    {
      Value: nombre,
      Label: 'Cargo'
    },
    {
      Value: descripcion,
      Label: 'Descripción'
    }
  ],

  SelectionFields: [
    nombre,
    descripcion
  ]
});

annotate AdminService.CargosVH with {
  ID
  @UI.Hidden;

  nombre
  @title: 'Cargo';

  descripcion
  @title: 'Descripción';
};

annotate AdminService.Ausencias with @(Common.SideEffects #CambioTipo: {
  SourceProperties: [tipoAusencia_codigo],
  TargetProperties: [
    'unidadConsumo',
    'fechaFin',
    'diasHabiles',
    'horaInicio',
    'horaFin',
    'horasSolicitadas'
  ]
});

annotate AdminService.Ausencias with @(Common.SideEffects #CambioFechaInicio: {
  SourceProperties: [fechaInicio],
  TargetProperties: [
    'fechaFin',
    'diasHabiles'
  ]
});

annotate AdminService.Ausencias with @(Common.SideEffects #CambioFechaFin: {
  SourceProperties: [fechaFin],
  TargetProperties: ['diasHabiles']
});

annotate AdminService.Ausencias with @(Common.SideEffects #RecalcularHoras: {
  SourceProperties: [
    horaInicio,
    horaFin
  ],
  TargetProperties: ['horasSolicitadas']
});
