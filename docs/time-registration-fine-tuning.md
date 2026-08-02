# Fase: Fine tuning de registro de tiempos

Esta fase comienza después de estabilizar el Centro de aprobaciones para tiempos y ausencias. Su objetivo es cerrar el módulo de tiempos con controles funcionales, de autorización, seguridad, auditoría y operación suficientes para utilizarlo como fuente de cobro y de costos internos.

## Condición de entrada

- El empleado puede registrar, copiar, editar, eliminar y enviar sus tiempos.
- La navegación semanal y mensual funciona en escritorio y móvil.
- La administración comercial permite gestionar clientes, contratos, proyectos, asignaciones, tarifas y aprobadores.
- El Centro de aprobaciones permite revisar, aprobar o devolver las hojas de tiempo.

## Validaciones funcionales

- Validar vigencia del cliente, proyecto, contrato y asignación en la fecha registrada.
- Mostrar al usuario únicamente proyectos para los que tenga una asignación vigente.
- Permitir acumulados diarios superiores a 24 horas cuando existan acuerdos simultáneos, sin confundirlos con duración cronológica.
- Aplicar el umbral diario configurable por proyecto; el valor inicial es 16 horas y genera alerta, no bloqueo.
- Mantener incrementos de media hora y validar el formato decimal en cliente y servidor.
- Exigir descripción y soporte cuando el proyecto lo configure.
- Exigir siempre descripción, franja y soporte para horas extra, nocturnas, dominicales o festivas según corresponda.
- Excluir festivos colombianos de selecciones rápidas y copias masivas, salvo selección explícita del empleado.
- Detectar posibles duplicados sin bloquear automáticamente acuerdos full time simultáneos.
- Respetar la ventana semanal, las fechas de corte de facturación y el cierre mensual configurable.

## Estados y concurrencia

- Formalizar las transiciones: borrador, enviada, en revisión, aprobada por líder, aprobada internamente y devuelta.
- Bloquear la edición de registros enviados hasta que sean devueltos.
- Evitar doble envío, doble aprobación y duplicación por reintentos mediante claves de idempotencia.
- Detectar actualizaciones concurrentes con versión esperada y devolver un conflicto comprensible.
- Registrar quién, cuándo y por qué ejecutó cada transición.

## Autorización y privacidad

- Un empleado solo puede leer y modificar sus propios registros y soportes.
- Un invitado solo puede acceder a proyectos compartidos con su organización y nunca a salarios, costos o proyectos ajenos.
- Un cliente o socio solo puede consultar reportes y soportes de los proyectos expresamente autorizados.
- Los líderes solo pueden decidir hojas de proyectos donde tengan una asignación de aprobación vigente.
- Los costos, salarios, márgenes y tarifas internas quedan restringidos a roles administrativos configurables.
- Las autorizaciones deben validarse en CAP; ocultar botones en UI5 no cuenta como control de seguridad.

## Soportes y archivos

- Validar tamaño, tipo declarado, firma real del archivo y nombre seguro.
- Analizar los archivos con el servicio de seguridad antes de habilitar su descarga.
- Impedir referencias directas que permitan descargar soportes de otro empleado, cliente o proyecto.
- Registrar carga, consulta, descarga y eliminación de soportes confidenciales.
- Aplicar conservación de seis meses mediante un proceso programado, con excepción por retención legal o administrativa.
- Definir qué ocurre con un reporte ya aprobado cuando un soporte alcanza su fecha de eliminación.

## Aprobaciones y notificaciones

- Verificar esquemas de líder, administración, líder seguido de administración y bandeja común.
- Probar backups, sustituciones, reenvíos, vencimientos y ausencia temporal del aprobador.
- Enviar correos sin revelar costos internos ni información de otros proyectos.
- Generar enlaces profundos que abran la tarea correcta en el Centro de aprobaciones.
- Evitar notificaciones duplicadas en reintentos y conservar evidencia de envío o fallo.

## Reportes y cálculo económico

- Conciliar cada reporte con los registros aprobados que lo originaron.
- Separar horas regulares, extras, nocturnas, dominicales y festivas.
- Aplicar modalidad full time, tarifa por empleado, tarifa por proyecto, moneda y vigencia correctas.
- Distinguir valor facturable, costo interno, impuestos internos y conceptos no facturables.
- No mostrar salarios, costos, margen, impuestos internos o retenciones en entregables para clientes.
- Versionar los reportes emitidos y conservar la trazabilidad de correcciones posteriores.
- Validar cierres mensuales y ciclos especiales, incluidos periodos del día 15 al día 15.

## Seguridad y operación

- Mantener secretos fuera de Git y rotar cualquier credencial expuesta.
- Revisar roles XSUAA, rutas de approuter y acceso directo a servicios CAP.
- Validar límites de payload, inyección en textos, fórmulas peligrosas en CSV y nombres de descarga.
- Definir alertas operativas para fallos de correo, análisis de archivos, generación de reportes y tareas atascadas.
- Probar recuperación ante fallos parciales y documentar procedimientos administrativos seguros.

## Pruebas obligatorias

- Pruebas unitarias de reglas de horas, festivos, vigencias, tarifas y estados.
- Pruebas de integración CAP para cada acción y cada rol.
- Matriz negativa de autorización entre empleados, invitados, clientes, líderes y administrativos.
- Pruebas de concurrencia, reintentos e idempotencia.
- Pruebas de archivos inválidos, infectados, demasiado grandes y no autorizados.
- Pruebas responsive en teléfono, tablet y escritorio.
- Recorrido completo: registro, envío, notificación, decisión, corrección, aprobación y reporte.

## Criterio de salida

La fase termina únicamente cuando los controles anteriores estén implementados, automatizados en pruebas cuando sea viable y validados con al menos un ciclo real de tiempos y aprobación. La apariencia visual por sí sola no permite considerar terminado el módulo.
