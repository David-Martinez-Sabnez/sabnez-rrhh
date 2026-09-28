using {sabnez.config as config} from '../db/configuracion';

/**
 * Centro de configuración.
 *
 * Reúne los valores que hoy estaban repartidos entre variables de entorno y
 * constantes en el código. Cada parámetro se edita sin volver a desplegar.
 *
 * Arranca con los parámetros de cuentas de cobro; a medida que se muevan aquí
 * las URL de las aplicaciones, los plazos de vencimiento y los umbrales, este
 * servicio es el único punto que hay que tocar.
 */
service ConfiguracionService @(
  path    : '/configuracion',
  requires: 'Admin'
) {
  // Con draft habilitado el Object Page trae el ciclo editar/guardar/descartar
  // estándar de Fiori, sin código propio.
  @odata.draft.enabled
  entity Parametros as projection on config.Parametros;
}
