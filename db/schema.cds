namespace sabnez.rrhh;

using {
  managed,
  cuid
} from '@sap/cds/common';

using {Attachments, Attachment} from '@cap-js/attachments';

using {
  sabnez.rrhh.Estados,
  sabnez.rrhh.TiposContrato,
  sabnez.rrhh.Cargos,
  sabnez.rrhh.EPS,
  sabnez.rrhh.ARL,
  sabnez.rrhh.FondosPension,
  sabnez.rrhh.FondosCesantias,
  sabnez.rrhh.CajasCompensacion,
  sabnez.rrhh.CiudadesColombia,
  sabnez.rrhh.TiposAusencia,
  sabnez.rrhh.EstadosAusencia,
  sabnez.rrhh.TiposDocumento,
  sabnez.rrhh.Generos,
  sabnez.rrhh.EstadosCiviles,
  sabnez.rrhh.Parentescos,
  sabnez.rrhh.TiposDocumentoEmpleado,
  sabnez.rrhh.TratamientosRetencionCuentaCobro,
  sabnez.rrhh.EntidadesFinancieras,
  sabnez.rrhh.TiposCuentaBancaria,
  sabnez.rrhh.Monedas,
  sabnez.rrhh.UnidadConsumo
} from './catalogos';

type TipoDocumento : String(10) enum {
  CC;
  CE;
  PA;
  PEP;
  PPT;
  TI;
};

type Genero        : String(20) enum {
  MA;
  FE;
  OT;
  ND;
};

type EstadoCivil   : String(20) enum {
  SO;
  CA;
  UL;
  SE;
  DI;
  VI;
  ND;
};

type Parentesco    : String(40) enum {
  MA;
  PA;
  CO;
  CP;
  HI;
  HE;
  AB;
  TI;
  PR;
  AM;
  OT;
};

type OrigenRegistroAusencia : String(20) enum {
  AUTOSERVICIO = 'AUTOSERVICIO';
  LEGADO_RRHH  = 'LEGADO_RRHH';
};

type TipoCuentaBancaria : String(20) enum {
  AHORROS;
  CORRIENTE;
  DEPOSITO_ELECTRONICO;
};

type EstadoDocumentoEmpleado : String(20) enum {
  VIGENTE;
  VENCIDO;
  REEMPLAZADO;
  ANULADO;
};

// La opción define qué tratamiento solicita el prestador en su
// certificación tributaria. RR. HH. elige una alternativa legible y el
// sistema conserva un código estable para generar el documento.
type TratamientoRetencionCuentaCobro : String(30) enum {
  @title: 'Pendiente de validar con contabilidad'
  PENDIENTE = 'PENDIENTE';
  @title: 'Tabla de retención del artículo 383'
  ARTICULO_383 = 'ARTICULO_383';
  @title: 'Retención por honorarios'
  HONORARIOS = 'HONORARIOS';
  @title: 'Retención por servicios'
  SERVICIOS = 'SERVICIOS';
  @title: 'No aplica retención'
  NO_APLICA = 'NO_APLICA';
};

// ============================================================
// EMPLEADO — entidad central
// ============================================================
@assert.unique: {
  documento        : [
    tipoDocumento,
    numeroDocumento
  ],
  codigoInterno    : [codigoInterno],
  correoCorporativo: [correoCorporativo]
}
entity Empleados : cuid, managed {
  // --- Identificación ---
  numeroDocumento       : String(30)               @mandatory;
  tipoDocumento         : TipoDocumento            @mandatory  @assert.range: true  default 'CC';
  primerNombre          : String(60)               @mandatory;
  segundoNombre         : String(60);
  primerApellido        : String(60)               @mandatory;
  segundoApellido       : String(60);
  nombreCompleto        : String(240) = trim(primerNombre  || ' ' || coalesce(
                                             segundoNombre || ' ', ''
  ) || primerApellido || coalesce(
                                             ' '           || segundoApellido, ''
  ));
  fechaNacimiento       : Date;
  genero                : Genero                   @assert.range: true;
  estadoCivil           : EstadoCivil              @assert.range: true;

  // --- Contacto ---
  correoPersonal        : String(120);
  correoCorporativo     : String(120);
  telefono              : String(30);
  direccion             : String(200);
  ciudad                : String(80);
  barrio                : String(100);

  // --- Perfil para pagos y cuentas de cobro ---
  generaCuentaCobro     : Boolean default false;
  lugarExpedicionDocumento : String(100);
  direccionTributaria   : String(200);
  ciudadTributaria      : String(100);
  actividadEconomicaCiiu: String(10);
  responsableIVA        : Boolean default false;
  declaranteRenta       : Boolean default false;
  aplicaCostosDeducciones: Boolean default false;
  tratamientoRetencion  : TratamientoRetencionCuentaCobro @assert.range: true default 'PENDIENTE';
  _tratamientoRetencion : Association to TratamientosRetencionCuentaCobro
                            on _tratamientoRetencion.codigo = tratamientoRetencion;

  // --- Datos laborales ---
  codigoInterno         : String(20)               @readonly;
  fechaIngreso          : Date                     @mandatory;
  fechaRetiro           : Date;
  cargo                 : Association to Cargos    @mandatory  @assert.target;
  // Si el tiempo de esta persona se espera que genere ingreso. Hereda
  // del cargo al dar de alta y se puede corregir: hay coordinaciones
  // que entran en un contrato y otras que son estructura interna.
  facturable            : Boolean;
  estado                : Association to Estados   @mandatory  @assert.target;
  jefeDirecto           : Association to Empleados @assert.target;

  // --- Afiliaciones actuales ---
  eps                   : Association to EPS
                                                   @assert.target;
  arl                   : Association to ARL
                                                   @assert.target;
  fondoPension          : Association to FondosPension
                                                   @assert.target;
  fondoCesantias        : Association to FondosCesantias
                                                   @assert.target;
  cajaCompensacion      : Association to CajasCompensacion
                                                   @assert.target;
  nivelRiesgoArl        : String(5);
  fechaAfiliacion       : Date;

  // --- Información de salud ---
  alergias              : String(1000);

  // --- Foto del empleado ---
  @title                : 'Foto del empleado'
  foto                  : Attachment;

  // --- Detalles del empleado ---
  contratos             : Composition of many Contratos
                            on contratos.empleado = $self;
  cuentasBancarias      : Composition of many CuentasBancarias
                            on cuentasBancarias.empleado = $self;
  dependientesTributarios: Composition of many DependientesTributarios
                            on dependientesTributarios.empleado = $self;
  contactosEmergencia   : Composition of many ContactosEmergencia
                            on contactosEmergencia.empleado = $self;
  ausencias             : Composition of many Ausencias
                            on ausencias.empleado = $self;
  saldosValeraEmocional : Composition of many SaldosValeraEmocional
                            on saldosValeraEmocional.empleado = $self;
  // Asociaciones utilizadas para obtener las descripciones
  _tipoDocumento        : Association to TiposDocumento
                            on _tipoDocumento.codigo = tipoDocumento;
  _genero               : Association to Generos
                            on _genero.codigo = genero;
  _estadoCivil          : Association to EstadosCiviles
                            on _estadoCivil.codigo = estadoCivil;
}

annotate sabnez.rrhh.Empleados with {
  foto {
    content
    @Core.AcceptableMediaTypes: [
      'image/jpeg',
      'image/png',
      'image/webp'
    ]
    @Validation.Maximum       : '2MB';
  };
};

// ============================================================
// CONTRATOS — histórico laboral
// ============================================================
aspect AdjuntosContrato : Attachments {
  tipoDocumento_codigo : String(30) default 'CONTRATO';
  tipoDocumento        : Association to TiposDocumentoEmpleado
                           on tipoDocumento.codigo = tipoDocumento_codigo;
}

entity Contratos : cuid, managed {
  empleado            : Association to Empleados @mandatory;

  tipoContrato_codigo : String(30)               @mandatory;
  tipoContrato        : Association to TiposContrato
                          on tipoContrato.codigo = tipoContrato_codigo;

  cargo_ID            : UUID                     @mandatory;
  cargo               : Association to Cargos
                          on cargo.ID = cargo_ID;

  fechaInicio         : Date                     @mandatory;
  fechaFin            : Date;

  salario             : Decimal(15, 2)
                                                 @mandatory
                                                 @assert.range: [
    0,
    _
  ];

  auxilioTransporte   : Decimal(15, 2)
                                                 @assert.range: [
    0,
    _
  ]
  default 0;

  auxilioConectividad : Decimal(15, 2)
                                                 @assert.range: [
    0,
    _
  ]
  default 0;

  moneda              : String(3)
                                                 @mandatory
  default 'COP';

  // Ciclo interno de pago al prestador. Es deliberadamente independiente
  // del ciclo de reporte/facturación configurado para cada cliente.
  diaInicioCuentaCobro: Integer default 1;

  // Desde cuándo este vínculo cobra por la plataforma. Vacío significa que
  // rige el parámetro global CUENTAS_COBRO_DESDE; se llena sólo para quien
  // deba arrancar antes, y nunca puede ser anterior a la fecha de inicio del
  // contrato. Existe porque los periodos previos a la entrada en vigor de la
  // aplicación ya se cobraron por fuera y no deben volver a ofrecerse.
  fechaCorteCuentaCobro: Date;

  vigente             : Boolean default true;
  observaciones       : LargeString;

  // Expediente del contrato: admite varios archivos y cada anexo conserva
  // su clasificación documental.
  adjuntos            : Composition of many AdjuntosContrato;
}

// ============================================================
// PAGOS, TRIBUTACIÓN Y EXPEDIENTE DOCUMENTAL
// ============================================================
@assert.unique: { empleadoCuenta: [empleado, numeroCuenta] }
entity CuentasBancarias : cuid, managed {
  empleado          : Association to Empleados @mandatory;
  banco             : String(120) @mandatory;
  tipoCuenta        : TipoCuentaBancaria @mandatory @assert.range: true;
  _tipoCuenta       : Association to TiposCuentaBancaria
                        on _tipoCuenta.codigo = tipoCuenta;
  _banco            : Association to EntidadesFinancieras
                        on _banco.nombre = banco;
  numeroCuenta      : String(60) @mandatory;
  titularNombre     : String(240) @mandatory;
  titularTipoDocumento: TipoDocumento @mandatory default 'CC';
  titularNumeroDocumento: String(30) @mandatory;
  moneda            : String(3) @mandatory default 'COP';
  _moneda           : Association to Monedas on _moneda.codigo = moneda;
  _titularTipoDocumento: Association to TiposDocumento
                           on _titularTipoDocumento.codigo = titularTipoDocumento;
  principal         : Boolean default false;
  activa            : Boolean default true;
  observaciones     : String(500);
}

entity DependientesTributarios : cuid, managed {
  empleado          : Association to Empleados @mandatory;
  nombre            : String(240) @mandatory;
  tipoDocumento     : TipoDocumento default 'CC';
  numeroDocumento   : String(30);
  parentesco        : Parentesco @assert.range: true;
  _tipoDocumento    : Association to TiposDocumento
                        on _tipoDocumento.codigo = tipoDocumento;
  _parentesco       : Association to Parentescos
                        on _parentesco.codigo = parentesco;
  fechaNacimiento   : Date;
  vigenteDesde      : Date;
  vigenteHasta      : Date;
  activo            : Boolean default true;
  observaciones     : String(500);
}

entity DocumentosEmpleado : cuid, managed {
  empleado          : Association to Empleados @mandatory;
  contrato          : Association to Contratos;
  tipo_codigo       : String(30) @mandatory;
  tipo              : Association to TiposDocumentoEmpleado
                        on tipo.codigo = tipo_codigo;
  nombre            : String(200) @mandatory;
  fechaDocumento    : Date @mandatory;
  vigenteDesde      : Date;
  vigenteHasta      : Date;
  observaciones     : String(1000);
  confidencial      : Boolean default true;
  estado            : EstadoDocumentoEmpleado @assert.range: true default 'VIGENTE';
  archivo           : Attachment;
}

annotate sabnez.rrhh.DocumentosEmpleado with {
  archivo {
    content
    @Core.AcceptableMediaTypes: [
      'application/pdf',
      'image/jpeg',
      'image/png'
    ]
    @Validation.Maximum: '15MB';
  };
};


// ============================================================
// CONTACTOS DE EMERGENCIA
// ============================================================
entity ContactosEmergencia : cuid, managed {
  empleado    : Association to Empleados @mandatory;
  nombre      : String(120)              @mandatory;
  parentesco  : Parentesco               @mandatory  @assert.range: true;
  telefono    : String(30)               @mandatory;
  telefonoAlt : String(30);
  esPrincipal : Boolean default false;

  _parentesco : Association to Parentescos
                  on _parentesco.codigo = parentesco;
}

// ============================================================
// AUSENCIAS — vacaciones, calamidades, licencias, etc.
// ============================================================
// ============================================================
// AUSENCIAS — vacaciones, calamidades, licencias, etc.
// ============================================================
entity Ausencias : cuid, managed {
  empleado            : Association to Empleados @mandatory;

  // El backend asigna el origen. Los registros previos a la app de
  // autoservicio provienen de la carga histórica realizada por RR. HH.
  origenRegistro      : OrigenRegistroAusencia default 'LEGADO_RRHH';

  tipoAusencia_codigo : String(30)               @mandatory;

  tipoAusencia        : Association to TiposAusencia
                          on tipoAusencia.codigo = tipoAusencia_codigo;

  fechaInicio         : Date                     @mandatory;
  fechaFin            : Date                     @mandatory;

  // Ausencias expresadas en días
  diasHabiles         : Decimal(6, 2) default 0
                                                 @assert.range: [
    0,
    _
  ];

  // Ausencias expresadas en horas
  horaInicio          : Time;
  horaFin             : Time;

  horasSolicitadas    : Decimal(7, 2) default 0
                                                 @assert.range: [
    0,
    _
  ];

  /*
   * Copia de la unidad configurada en TiposAusencia.
   * Facilita FieldControl, side effects y validaciones.
   */
  unidadConsumo       : UnidadConsumo default 'DIAS'
                                                 @readonly;

  estadoa_codigo      : String(20)
                                                 @mandatory
  default 'SOLICITADA';

  estadoAusencia      : Association to EstadosAusencia
                          on estadoAusencia.codigo = estadoa_codigo;

  motivo              : String(500);

  aprobadaPor         : Association to Empleados
                                                 @assert.target;

  fechaAprobacion     : Date
                                                 @readonly;

  @title              : 'Soportes'
  @Validation.MaxItems: 5
  soportes            : Composition of many Attachments;
}

@assert.unique: {empleadoAnio: [
  empleado,
  anio
]}
entity SaldosValeraEmocional : cuid, managed {
  empleado      : Association to Empleados @mandatory;
  anio          : Integer                  @mandatory;

  horasBase     : Decimal(7, 2) default 40
                                           @assert.range: [
    0,
    _
  ];

  horasAjuste   : Decimal(7, 2) default 0;

  observaciones : String(500);
}

annotate sabnez.rrhh.Ausencias.soportes with {
  content
  @Core.AcceptableMediaTypes: [
    'image/jpeg',
    'image/png',
    'application/pdf'
  ]
  @Validation.Maximum       : '10MB';
};
