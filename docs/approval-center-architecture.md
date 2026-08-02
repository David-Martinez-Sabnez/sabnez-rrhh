# Centro de aprobaciones

## Decisión de arquitectura

La empresa tendrá una sola aplicación visible para tomar decisiones: `aprobacionesui`, presentada como **Centro de aprobaciones**. Las reglas y persistencia de cada proceso permanecen en servicios de dominio separados.

```text
Centro de aprobaciones (UI5)
  ├─ ApprovalService          Ausencias, delegaciones y tareas genéricas
  ├─ TimeApprovalService      Hojas, registros, soportes y reportes de tiempos
  └─ futuros adaptadores      Otros procesos administrativos
```

El centro normaliza la información necesaria para la bandeja, pero no replica ni reemplaza las validaciones del servicio propietario.

## Capacidades que deben conservarse

- Cards de pendientes, vencidas, backups, delegaciones e historial.
- Backups y sustituciones con vigencia.
- Reenvío de tareas y trazabilidad de decisiones.
- Descarga autorizada de soportes.
- Enlaces profundos desde correo.
- Búsqueda, filtros por proceso, estado y fecha.
- Navegación lista–detalle adaptable a teléfono, tablet y escritorio.

## Contrato normalizado de bandeja

Cada adaptador debe poder entregar, como mínimo:

- `taskID` y `processCode`.
- Título, resumen y solicitante.
- Estado, prioridad, fecha de solicitud y vencimiento.
- Rol del usuario: titular, backup, sustituto o integrante de bandeja común.
- Acciones disponibles calculadas por el servidor.
- Referencia opaca al objeto de negocio.

El cliente no debe inferir permisos a partir del tipo o estado; únicamente presenta las acciones autorizadas por el servicio.

## Detalles por proceso

### Ausencias

Conserva el detalle actual, hechos, soportes, historial, aprobación, rechazo, reenvío y reglas de delegación administradas por `ApprovalService`.

### Tiempos

El detalle debe consultar `TimeApprovalService` y presentar composición semanal, proyectos, horas regulares y especiales, alertas, soportes, reportes y decisiones de aprobar o devolver.

## Migración

1. Modernizar la navegación de `aprobacionesui` sin retirar funciones.
2. Validar nuevamente el flujo real de ausencias.
3. Crear el adaptador de tiempos para la bandeja común.
4. Incorporar el detalle de tiempos y sus acciones específicas.
5. Unificar enlaces de correo y accesos del Launchpad.
6. Mantener las aplicaciones específicas como contingencia durante un ciclo real.
7. Retirar los accesos duplicados solo después de validar autorizaciones, trazabilidad y reportes.

## Principio de seguridad

Centralizar la interfaz no concede permisos adicionales. Cada lectura, descarga y decisión debe volver a ser autorizada por el servicio de dominio correspondiente.
