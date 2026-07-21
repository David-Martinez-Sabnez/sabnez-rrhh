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

  // --- Datos laborales ---
  codigoInterno         : String(20)               @readonly;
  fechaIngreso          : Date                     @mandatory;
  fechaRetiro           : Date;
  cargo                 : Association to Cargos    @mandatory  @assert.target;
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

  vigente             : Boolean default true;
  observaciones       : LargeString;

  @Validation.MinItems: 1
  @Validation.MaxItems: 1
  adjuntos            : Composition of many Attachments;
}

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
    'image/*',
    'application/pdf'
  ]
  @Validation.Maximum       : '10MB';
};
