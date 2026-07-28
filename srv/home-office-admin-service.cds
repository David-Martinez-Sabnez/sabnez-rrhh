using {sabnez.rrhh as db} from '../db/home-office';

@path    : '/home-office-admin'
@requires: 'Editor'
service HomeOfficeAdminService {

    @readonly
    @cds.persistence.skip
    entity Anios {
        key anio  : String(4);
            texto : String(20);
    }

    @readonly
    @cds.persistence.skip
    entity Semanas {
        key anio         : String(4);
        key numeroSemana : Integer;

            fechaInicio  : Date;
            fechaFin     : Date;
            descripcion  : String(120);
    }

    @readonly
    @cds.persistence.skip
    entity ReporteHomeOffice {
        key ID                      : String(100);

            anio                    : String(4);
            numeroSemana            : Integer;
            semanaInicio            : Date;
            semanaFin               : Date;
            semanaDescripcion       : String(120);

            empleado_ID             : UUID;
            codigoInterno           : String(20);
            nombreCompleto          : String(240);
            correoCorporativo       : String(120);

            lunes                   : Date;
            martes                  : Date;
            miercoles               : Date;
            jueves                  : Date;
            viernes                 : Date;

            diasSeleccionados       : Integer;
            diasSeleccionadosTexto  : String(150);
            estadoSemana            : String(20);

            estadoSemanaCriticality : Integer;
    }
}
