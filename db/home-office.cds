namespace sabnez.rrhh;

using {
  managed,
  cuid
} from '@sap/cds/common';

using {sabnez.rrhh.Empleados} from './schema';

// ============================================================
// TIPOS HOME OFFICE
// ============================================================

type EstadoSeleccionHomeOffice : String(15) enum {
  RESERVADA;
  CONFIRMADA;
  CANCELADA;
  VENCIDA;
};

type TipoNotificacionHomeOffice : String(30) enum {
  RECORDATORIO_INCOMPLETO;
};

type EstadoNotificacionHomeOffice : String(15) enum {
  PENDIENTE;
  ENVIADA;
  ERROR;
  OMITIDA;
};

// ============================================================
// CONFIGURACIÓN GENERAL
// ============================================================

entity ConfiguracionHomeOffice : managed {
  key ID                : String(20);

      maxDiasPorSemana  : Integer default 2
                                  @assert.range: [
                                    1,
                                    5
                                  ];

      cuposPorDia       : Integer default 5
                                  @assert.range: [
                                    1,
                                    _
                                  ];

      minutosReserva    : Integer default 5
                                  @assert.range: [
                                    1,
                                    _
                                  ];

      /*
       * La semana que se selecciona está una semana adelante
       * de la semana en la que se encuentra abierta la ventana.
       */
      semanasAnticipacion : Integer default 1
                                    @assert.range: [
                                      0,
                                      _
                                    ];

      /*
       * ISO:
       * 1 = lunes
       * 2 = martes
       * ...
       * 5 = viernes
       */
      diaRecordatorio   : Integer default 5
                                  @assert.range: [
                                    1,
                                    7
                                  ];

      horaRecordatorio  : Time default '15:00:00';

      diaCierre         : Integer default 5
                                  @assert.range: [
                                    1,
                                    7
                                  ];

      horaCierre        : Time default '17:00:00';

      zonaHoraria       : String(50)
                                  default 'America/Bogota';

      activa            : Boolean default true;
}

// ============================================================
// REGISTRO EMPLEADO + SEMANA
//
// Esta entidad se utilizará para bloquear la semana completa del
// empleado durante una selección y evitar que dos solicitudes
// simultáneas permitan registrar más de dos días.
// ============================================================

@assert.unique: {
  empleadoSemana: [
    empleado,
    semanaInicio
  ]
}
entity SemanasEmpleadoHomeOffice : cuid, managed {
  empleado          : Association to Empleados @mandatory
                                                @assert.target;

  /*
   * Lunes correspondiente a la semana seleccionada.
   */
  semanaInicio      : Date @mandatory;

  ultimaConfirmacionEn : Timestamp;
}

// ============================================================
// CONTROL DE CUPO POR FECHA
//
// Cada fecha tendrá una única fila. Esta fila será bloqueada
// transaccionalmente mientras se reserva uno de los cinco cupos.
// ============================================================

entity DiasHomeOffice : managed {
  key fecha       : Date;

      semanaInicio : Date    @mandatory;

      /*
       * ISO: lunes = 1, viernes = 5.
       */
      diaSemana    : Integer @mandatory
                            @assert.range: [
                              1,
                              5
                            ];

      capacidad    : Integer default 5
                            @assert.range: [
                              1,
                              _
                            ];
}

// ============================================================
// SELECCIONES Y RESERVAS
// ============================================================

@assert.unique: {
  empleadoFecha: [
    empleado,
    fecha
  ]
}
entity SeleccionesHomeOffice : cuid, managed {
  empleado        : Association to Empleados @mandatory
                                              @assert.target;

  /*
   * Lunes de la semana a la que pertenece la selección.
   */
  semanaInicio    : Date @mandatory;

  /*
   * Fecha concreta seleccionada para Home Office.
   */
  fecha           : Date @mandatory;

  diaSemana       : Integer @mandatory
                            @assert.range: [
                              1,
                              5
                            ];

  estado          : EstadoSeleccionHomeOffice
                      default 'RESERVADA'
                      @mandatory
                      @assert.range: true;

  /*
   * Identificador secreto de la reserva temporal.
   * La UI deberá devolverlo para confirmar o cancelar.
   */
  tokenReserva    : UUID;

  reservaExpiraEn : Timestamp;

  confirmadaEn    : Timestamp;

  canceladaEn     : Timestamp;
}

// ============================================================
// HISTÓRICO DE RECORDATORIOS
// ============================================================

@assert.unique: {
  empleadoSemanaTipo: [
    empleado,
    semanaInicio,
    tipo
  ]
}
entity NotificacionesHomeOffice : cuid, managed {
  empleado       : Association to Empleados @mandatory
                                             @assert.target;

  semanaInicio   : Date @mandatory;

  tipo           : TipoNotificacionHomeOffice
                     default 'RECORDATORIO_INCOMPLETO'
                     @mandatory
                     @assert.range: true;

  estado         : EstadoNotificacionHomeOffice
                     default 'PENDIENTE'
                     @mandatory
                     @assert.range: true;

  destinatario   : String(255);

  intentos       : Integer default 0;

  enviadaEn      : Timestamp;

  ultimoIntentoEn : Timestamp;

  mensajeError   : LargeString;
}