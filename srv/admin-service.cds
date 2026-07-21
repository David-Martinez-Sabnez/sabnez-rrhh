using {sabnez.rrhh as db} from '../db/schema';
using {sabnez.rrhh as cat} from '../db/catalogos';

// Servicio administrativo protegido con roles:
//   - Editor: crear/leer/editar (Camila, Jessica, David)
//   - Admin:  además puede borrar (solo David)
service AdminService @(
  path    : '/admin',
  requires: 'Editor'
) {

  @cds.redirection.target
  @odata.draft.enabled
  @(restrict: [
    {
      grant: [
        'READ',
        'CREATE',
        'UPDATE'
      ],
      to   : 'Editor'
    },
    {
      grant: 'DELETE',
      to   : 'Admin'
    }
  ])
  entity Empleados             as
    projection on db.Empleados {
      *,
      virtual salarioBase               : Decimal(15, 2),
      virtual auxilioTransporte         : Decimal(15, 2),
      virtual auxilioConectividad       : Decimal(15, 2),
      virtual moneda                    : String(3),
      virtual diasVacacionesCausados    : Decimal(9, 2),
      virtual diasVacacionesDisfrutados : Decimal(9, 2),
      virtual diasVacacionesReservados  : Decimal(9, 2),
      virtual diasVacacionesDisponibles : Decimal(9, 2),
      virtual valeraAnioActual          : Integer,
      virtual horasValeraAsignadas      : Decimal(7, 2),
      virtual horasValeraUtilizadas     : Decimal(7, 2),
      virtual horasValeraReservadas     : Decimal(7, 2),
      virtual horasValeraDisponibles    : Decimal(7, 2),
      virtual vencimientoValera         : Date,
      virtual proximaRecargaValera      : Date,
      virtual fotoUrl                   : String(1024)
    };

  @(restrict: [
    {
      grant: [
        'READ',
        'CREATE',
        'UPDATE'
      ],
      to   : 'Editor'
    },
    {
      grant: 'DELETE',
      to   : 'Admin'
    }
  ])
  entity SaldosValeraEmocional as projection on db.SaldosValeraEmocional;

  @(restrict: [
    {
      grant: [
        'READ',
        'CREATE',
        'UPDATE'
      ],
      to   : 'Editor'
    },
    {
      grant: 'DELETE',
      to   : 'Admin'
    }
  ])
  entity Contratos             as projection on db.Contratos;

  @(restrict: [
    {
      grant: [
        'READ',
        'CREATE',
        'UPDATE'
      ],
      to   : 'Editor'
    },
    {
      grant: 'DELETE',
      to   : 'Admin'
    }
  ])
  entity ContactosEmergencia   as projection on db.ContactosEmergencia;

  @(restrict: [
    {
      grant: [
        'READ',
        'CREATE',
        'UPDATE'
      ],
      to   : 'Editor'
    },
    {
      grant: 'DELETE',
      to   : 'Admin'
    }
  ])
  entity Ausencias             as projection on db.Ausencias;

  // Catálogos editables: Editor mantiene, solo Admin borra
  @cds.redirection.target
  @odata.draft.enabled
  @(restrict: [
    {
      grant: [
        'READ',
        'CREATE',
        'UPDATE'
      ],
      to   : 'Editor'
    },
    {
      grant: 'DELETE',
      to   : 'Admin'
    }
  ])
  entity Cargos                as projection on cat.Cargos;

  @odata.draft.enabled
  @(restrict: [
    {
      grant: [
        'READ',
        'CREATE',
        'UPDATE'
      ],
      to   : 'Editor'
    },
    {
      grant: 'DELETE',
      to   : 'Admin'
    }
  ])
  entity EPS                   as projection on cat.EPS;

  @odata.draft.enabled
  @(restrict: [
    {
      grant: [
        'READ',
        'CREATE',
        'UPDATE'
      ],
      to   : 'Editor'
    },
    {
      grant: 'DELETE',
      to   : 'Admin'
    }
  ])
  entity ARL                   as projection on cat.ARL;

  @odata.draft.enabled
  @(restrict: [
    {
      grant: [
        'READ',
        'CREATE',
        'UPDATE'
      ],
      to   : 'Editor'
    },
    {
      grant: 'DELETE',
      to   : 'Admin'
    }
  ])
  entity FondosPension         as projection on cat.FondosPension;

  @odata.draft.enabled
  @(restrict: [
    {
      grant: [
        'READ',
        'CREATE',
        'UPDATE'
      ],
      to   : 'Editor'
    },
    {
      grant: 'DELETE',
      to   : 'Admin'
    }
  ])
  entity FondosCesantias       as projection on cat.FondosCesantias;

  @odata.draft.enabled
  @(restrict: [
    {
      grant: [
        'READ',
        'CREATE',
        'UPDATE'
      ],
      to   : 'Editor'
    },
    {
      grant: 'DELETE',
      to   : 'Admin'
    }
  ])

  entity CajasCompensacion     as projection on cat.CajasCompensacion;

  // Catálogos fijos de solo lectura (cualquier usuario autenticado)
  @readonly
  entity Estados               as projection on cat.Estados;

  @readonly
  entity TiposContrato         as projection on cat.TiposContrato;

  @readonly
  entity TiposAusencia         as projection on cat.TiposAusencia;

  @readonly
  entity EstadosAusencia       as projection on cat.EstadosAusencia;

  @readonly
  entity TiposDocumento        as projection on cat.TiposDocumento;

  @readonly
  entity Generos               as projection on cat.Generos;

  @readonly
  entity EstadosCiviles        as projection on cat.EstadosCiviles;

  @readonly
  entity CiudadesColombia      as projection on cat.CiudadesColombia;

  @readonly
  entity EmpleadosVH           as
    projection on db.Empleados {
      key ID,
          nombreCompleto,
          codigoInterno
    };

  @cds.redirection.exclude
  @readonly
  entity CargosVH              as
    projection on db.Cargos {
      key ID,
          nombre,
          descripcion
    };

  @readonly
  entity Parentescos           as projection on cat.Parentescos;
}
