namespace sabnez.rrhh;

using {
  managed,
  cuid
} from '@sap/cds/common';

// ============================================================
// CATÁLOGOS / LISTAS DE VALORES
// ============================================================

@assert.unique: {nombre: [nombre]}
entity Cargos : cuid, managed {
  nombre      : String(80) @mandatory;
  descripcion : String(200);
  activo      : Boolean default true;
}

@assert.unique: {nombre: [nombre]}
entity EPS : cuid, managed {
  nombre : String(100) @mandatory;
  activa : Boolean default true;
}

@assert.unique: {nombre: [nombre]}
entity ARL : cuid, managed {
  nombre : String(100) @mandatory;
  activa : Boolean default true;
}

@assert.unique: {nombre: [nombre]}
entity FondosPension : cuid, managed {
  nombre : String(100) @mandatory;
  activo : Boolean default true;
}

@assert.unique: {nombre: [nombre]}
entity FondosCesantias : cuid, managed {
  nombre : String(100) @mandatory;
  activo : Boolean default true;
}

@assert.unique: {nombre: [nombre]}
entity CajasCompensacion : cuid, managed {
  nombre : String(100) @mandatory;
  activa : Boolean default true;
}

// Catálogo oficial de municipios/ciudades de Colombia (códigos DANE)
entity CiudadesColombia {
  key codigo       : String(5);
      nombre       : String(100) @mandatory;
      departamento : String(100) @mandatory;
}

// ============================================================
// CATÁLOGOS FIJOS DE DATOS PERSONALES
// ============================================================

entity TiposDocumento {
  key codigo      : String(10);
      descripcion : String(80) @mandatory;
}

entity Generos {
  key codigo      : String(20);
      descripcion : String(80) @mandatory;
}

entity EstadosCiviles {
  key codigo      : String(20);
      descripcion : String(80) @mandatory;
}

entity Estados {
  key codigo      : String(20) @mandatory;
      descripcion : String(60) @mandatory;
}

entity TiposContrato {
  key codigo           : String(30) @mandatory;
      descripcion      : String(80) @mandatory;
      causaVacaciones  : Boolean default false;
}

entity TiposAusencia {
  key codigo                  : String(30) @mandatory;
      descripcion             : String(80) @mandatory;

      remunerada              : Boolean default true;
      descuentaSaldo          : Boolean default false;
      requiereSoporte         : Boolean default false;

      unidadConsumo           : UnidadConsumo default 'DIAS';
      controlaSaldoHoras      : Boolean default false;

      horasAnuales            : Decimal(7, 2);
      diasAnticipacion        : Integer default 0;
      tipoDiasAnticipacion    : TipoDiasAnticipacion default 'CALENDARIO';

      minimoHorasSolicitud    : Decimal(5, 2);
      maximoHorasDia          : Decimal(5, 2);
      maximoHorasSemana       : Decimal(5, 2);
      maximoSolicitudesSemana : Integer;

      requiereMismoDia        : Boolean default false;
      permiteCruzarAnio       : Boolean default true;

      politicaFecha           : PoliticaFechaAusencia default 'LIBRE';
      requiereContratoVigente : Boolean default false;
}

entity Parentescos {
  key codigo      : String(40);
      descripcion : String(80) @mandatory;
}

entity EstadosAusencia {
  key codigo      : String(20);
      descripcion : String(80) @mandatory;
}

type UnidadConsumo : String(10) enum {
  DIAS  = 'DIAS';
  HORAS = 'HORAS';
};

type TipoDiasAnticipacion : String(12) enum {
  CALENDARIO = 'CALENDARIO';
  HABILES    = 'HABILES';
};

type PoliticaFechaAusencia : String(25) enum {
  LIBRE              = 'LIBRE';
  SEMANA_CUMPLEANOS  = 'SEMANA_CUMPLEANOS';
};
