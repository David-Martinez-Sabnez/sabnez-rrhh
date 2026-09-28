using {sabnez.calendars as calendars} from '../db/calendars';

service CalendarService @(
  path    : '/calendarios',
  requires: 'Admin'
) {
  @odata.draft.enabled
  entity Calendarios as projection on calendars.WorkCalendars actions {
    action sincronizarFestivos(anio: Integer not null @title: 'Año') returns ResultadoSincronizacion;
  };

  entity Festivos as projection on calendars.Holidays;
  @readonly entity Paises as projection on calendars.Countries;

  type ResultadoSincronizacion {
    exito       : Boolean;
    pais        : String(2);
    anio        : Integer;
    recibidos   : Integer;
    creados     : Integer;
    actualizados: Integer;
    desactivados: Integer;
    mensaje     : String(500);
  };
}
