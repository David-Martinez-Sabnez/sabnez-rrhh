// ============================================================
// SERVICIO DE AUTOGESTIÓN DE HOME OFFICE
//
// No expone las entidades de base de datos directamente.
// Todas las consultas y modificaciones se realizan mediante
// funciones y acciones controladas por el backend.
// ============================================================

service HomeOfficeService @(
    path    : '/home-office',
    requires: 'authenticated-user'
) {

    // ----------------------------------------------------------
    // Información de cada día mostrada en la aplicación
    // ----------------------------------------------------------
    type DiaHomeOffice {
        fecha                       : Date;
        semanaInicio                : Date;
        diaSemana                   : Integer;
        nombreDia                   : String(20);

        cuposTotales                : Integer;
        cuposOcupados               : Integer;
        cuposDisponibles            : Integer;

        seleccionadoPorMi           : Boolean;
        estadoSeleccion             : String(15);
        tokenReserva                : UUID;
        reservaExpiraEn             : Timestamp;

        esFeriado                   : Boolean;
        bloqueadoSemanaAnterior     : Boolean;
        bloqueadoPorConsecutivo     : Boolean;
        cupoCompleto                : Boolean;
        semanaConFeriado            : Boolean;
        reiniciaReglaSemanaAnterior : Boolean;

        habilitado                  : Boolean;
        motivoNoDisponible          : String(300);

        diasSeleccionados           : Integer;
        maxDiasPermitidos           : Integer;

        ventanaAbierta              : Boolean;
        fechaHoraCierre             : Timestamp;
    }

    // ----------------------------------------------------------
    // Respuesta de reservar, liberar, confirmar o cancelar
    // ----------------------------------------------------------
    type ResultadoOperacion {
        exito             : Boolean;
        mensaje           : String(500);

        fecha             : Date;
        estadoSeleccion   : String(15);

        tokenReserva      : UUID;
        reservaExpiraEn   : Timestamp;

        cuposDisponibles  : Integer;
        diasSeleccionados : Integer;
        maxDiasPermitidos : Integer;
    }

    // ----------------------------------------------------------
    // Devuelve lunes a viernes de la semana que actualmente
    // puede seleccionar el empleado.
    //
    // El backend determina automáticamente la semana objetivo.
    // El frontend no puede consultar arbitrariamente otra semana.
    // ----------------------------------------------------------
    function obtenerMiSemana()                  returns many DiaHomeOffice;

    // ----------------------------------------------------------
    // Reserva temporalmente un cupo.
    //
    // Validaciones:
    // - La fecha pertenece a la semana habilitada.
    // - La ventana continúa abierta.
    // - No supera dos días.
    // - No repite un día de la semana anterior.
    // - Todavía existe cupo.
    // ----------------------------------------------------------
    action   reservarDia(fecha: Date)           returns ResultadoOperacion;

    // ----------------------------------------------------------
    // Libera una reserva temporal del usuario autenticado.
    // ----------------------------------------------------------
    action   liberarReserva(tokenReserva: UUID) returns ResultadoOperacion;

    // ----------------------------------------------------------
    // Confirma todas las reservas vigentes del empleado para
    // la semana actualmente habilitada.
    // ----------------------------------------------------------
    action   confirmarSemana()                  returns ResultadoOperacion;

    // ----------------------------------------------------------
    // Cancela una selección ya confirmada mientras la ventana
    // semanal continúe abierta.
    // ----------------------------------------------------------
    action   cancelarDia(fecha: Date)           returns ResultadoOperacion;
}
