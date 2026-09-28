namespace sabnez.config;

using {managed} from '@sap/cds/common';

/**
 * Parámetros de configuración de la plataforma.
 *
 * Semilla del futuro centro de parametrizaciones: en vez de repartir correos,
 * plazos y umbrales entre variables de entorno y constantes en el código, cada
 * valor vive aquí con su descripción y queda editable sin desplegar.
 *
 * La clave es el identificador estable que usa el código; el grupo solo sirve
 * para agrupar en pantalla.
 */
type TipoParametro : String(15) enum {
  TEXT   = 'TEXT';
  EMAIL  = 'EMAIL';
  NUMBER = 'NUMBER';
  BOOLEAN = 'BOOLEAN';
  DATE   = 'DATE';
};

@assert.unique: {clave: [clave]}
entity Parametros : managed {
      // La clave es la llave primaria: es lo que el código referencia.
  key clave       : String(60);
      grupo       : String(60)  @mandatory;
      nombre      : String(120) @mandatory;
      descripcion : String(500);
      tipo        : TipoParametro default 'TEXT';
      valor       : String(500);
      // Un parámetro de sistema no se puede borrar desde la UI: el código
      // cuenta con que exista.
      sistema     : Boolean default false;
}
