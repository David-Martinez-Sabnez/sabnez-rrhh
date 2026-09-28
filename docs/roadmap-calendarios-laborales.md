# Hoja de ruta — Calendarios laborales

## Objetivo

Centralizar los días laborables, horas por jornada, festivos nacionales y
excepciones regionales que usan los módulos de tiempos, ausencias, capacidad y
Control Financiero.

## Etapa 1 — Aplicación de calendarios (actual)

- List Report Fiori Elements de calendarios laborales.
- Calendarios iniciales para Colombia y Chile.
- Configuración de país, región, horas diarias y días de la semana laborables.
- Object Page con el listado de festivos del calendario.
- Acción **Sincronizar festivos** con parámetro de año.
- Integración encapsulada con Nager.Holidays API v4.
- Persistencia local: las aplicaciones no consultan la API externa al calcular.
- Los registros manuales y los importados marcados como ajuste manual no se
  sobrescriben durante una sincronización.

### Criterios para aprobar la etapa

1. Sincronizar Colombia y Chile para 2026 desde la interfaz.
2. Confirmar que no se duplican festivos al sincronizar dos veces.
3. Crear un festivo manual y comprobar que se conserva.
4. Confirmar que Chile agosto de 2026 tiene 168 horas de lunes a viernes con
   jornada de ocho horas.
5. Validar acceso únicamente para administradores.

## Etapa 2 — Asociación con proyectos

- Agregar un calendario laboral a cada proyecto.
- Proponer por defecto el calendario del país del cliente.
- Permitir reemplazarlo en el proyecto cuando la operación use otro país.
- Alertar proyectos activos sin calendario confirmado.
- No modificar todavía documentos financieros históricos.

## Etapa 3 — Migración de cálculos

Orden sugerido:

1. Control Financiero: capacidad del periodo y prorrateo de facturas.
2. Registro y aprobación de tiempos: objetivos y validaciones mensuales.
3. Ausencias: conteo de días laborables.
4. Cuentas de cobro: periodos y capacidad cuando corresponda.
5. Reportes y tarjetas de Work Zone.

Cada migración debe reemplazar el calendario colombiano codificado por el
servicio central y tener pruebas separadas para Colombia, Chile y periodos con
festivos regionales.

## Etapa 4 — Operación y mantenimiento

- Sincronización anual manual desde la aplicación.
- Posible tarea programada para refrescar el año actual y el siguiente.
- Aviso cuando un calendario no se haya sincronizado o confirmado.
- Registro de fuente, fecha, usuario y resultado de cada sincronización.
- Posibilidad de sustituir Nager.Holidays por otro proveedor sin cambiar las
  aplicaciones consumidoras.
