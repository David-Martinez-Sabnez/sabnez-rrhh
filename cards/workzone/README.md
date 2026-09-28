# Cards de SAP Build Work Zone

Este directorio conserva las cards como parte del mismo proyecto CAP. El ZIP
de Work Zone deja de ser la única copia del desarrollo.

## Estructura

- `src/`: código fuente de cada card y su manifiesto de artefacto.
- `package/`: paquete base importado de la versión 1.4.9.
- `releases/`: paquetes terminados que se pueden importar en Work Zone.
- `build.js`: recompone los `data.zip`, actualiza la versión y genera el ZIP.

## Construcción

Desde la raíz del proyecto:

```sh
npm run cards:build
```

El resultado actual es `releases/Sabnez_Cards_WZ_v1.5.1.zip`.

La card **Mis cuentas de cobro** consulta el servicio CAP
`/cuentas-cobro`, muestra los periodos aprobados pendientes y navega al
inbound `CuentasCobro-display`.

El mismo ZIP declara dos roles de contenido separados:

- **General**: contiene únicamente las cards comunes.
- **Prestadores de servicios** (`sbz.wz.cards.prestadores.role`): contiene
  únicamente **Mis cuentas de cobro**.

La card no se añade al rol general. Después de importar el paquete, asigne el
rol de contenido de prestadores solamente a los usuarios o grupos externos que
deban generar cuentas de cobro.
