"use strict";

/**
 * Objetivo mensual de horas por empleado.
 *
 * Antes el objetivo era siempre "días hábiles x 8", igual para todo el
 * mundo. Eso no dice nada en un proyecto por horas, donde lo que importa
 * es cuántas horas se espera poder facturar.
 *
 * Ahora un proyecto puede llevar un umbral mensual de horas facturables
 * (`monthlyBillableTarget`). Cuando lo tiene, ese umbral se reparte entre
 * su equipo en proporción a la asignación comercial de cada persona. Los
 * proyectos sin umbral siguen aportando calendario, prorrateado por la
 * dedicación de esa persona.
 *
 * Las dos cosas se suman: alguien con un proyecto completo y tres por
 * horas obtiene la parte de calendario del primero más su cuota de los
 * otros tres.
 */

const HOURS_PER_DAY = 8;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value) {
  return Math.round(num(value) * 100) / 100;
}

function hasTarget(project) {
  return num(project && project.monthlyBillableTarget) > 0;
}

/**
 * Reparte el umbral de un proyecto entre sus asignaciones activas.
 * Devuelve un Map asignacionID -> horas.
 *
 * El reparto es proporcional a `commercialAllocation`. Si nadie tiene
 * dedicación registrada, se reparte a partes iguales: es preferible a
 * devolver cero y dejar al equipo sin objetivo.
 */
function splitProjectTarget(project, assignments) {
  const shares = new Map();
  const activas = (assignments || []).filter(
    (a) => a && a.project_ID === project.ID && a.status !== "INACTIVE",
  );
  if (!activas.length || !hasTarget(project)) return shares;

  const total = num(project.monthlyBillableTarget);
  const suma = activas.reduce((acc, a) => acc + num(a.commercialAllocation), 0);

  activas.forEach((a) => {
    const cuota = suma > 0 ? num(a.commercialAllocation) / suma : 1 / activas.length;
    shares.set(a.ID, round(total * cuota));
  });
  return shares;
}

/**
 * Objetivo de un empleado para el periodo.
 *
 * @param {object}  opciones
 * @param {string}  opciones.employeeID
 * @param {Array}   opciones.assignments  asignaciones (todas, se filtran aquí)
 * @param {Array}   opciones.projects     proyectos referenciados
 * @param {number}  opciones.businessDays días hábiles del periodo
 * @returns {{ horasObjetivo, horasUmbral, horasCalendario, tieneUmbral, detalle }}
 */
function employeeTarget({
  employeeID,
  assignments,
  projects,
  businessDays,
  periodBusinessDays,
}) {
  const dias = Math.max(0, num(businessDays));
  // Quien sólo estuvo parte del periodo tampoco puede entregar el umbral
  // mensual completo: su cuota se prorratea por los días que tuvo.
  const periodo = Math.max(0, num(periodBusinessDays)) || dias;
  const presencia = periodo > 0 ? Math.min(1, dias / periodo) : 1;
  const porID = new Map((projects || []).map((p) => [p.ID, p]));
  const propias = (assignments || []).filter(
    (a) => a && a.employee_ID === employeeID && a.status !== "INACTIVE",
  );

  let horasUmbral = 0;
  let dedicacionCalendario = 0;
  let asignacionesCalendario = 0;
  const detalle = [];

  propias.forEach((a) => {
    const proyecto = porID.get(a.project_ID);
    if (!proyecto) return;

    if (hasTarget(proyecto)) {
      const cuota = (splitProjectTarget(proyecto, assignments).get(a.ID) || 0) * presencia;
      horasUmbral += cuota;
      detalle.push({
        project_ID: proyecto.ID,
        origen: "UMBRAL",
        horas: round(cuota),
      });
      return;
    }

    asignacionesCalendario += 1;
    dedicacionCalendario += num(a.commercialAllocation) / 100;
    detalle.push({
      project_ID: proyecto.ID,
      origen: "CALENDARIO",
      horas: null, // se resuelve abajo, depende del total de dedicación
    });
  });

  // Sin dedicación registrada en los proyectos de calendario se asume
  // jornada completa: es como se comportaba antes de existir el umbral.
  if (asignacionesCalendario > 0 && dedicacionCalendario === 0) {
    dedicacionCalendario = 1;
  }
  const horasCalendario = round(dias * HOURS_PER_DAY * Math.min(dedicacionCalendario, 1));

  let horasObjetivo = round(horasUmbral + horasCalendario);

  // Un empleado sin asignaciones utilizables conserva el objetivo de
  // siempre, para no mostrar 0 h y un porcentaje sin sentido.
  if (horasObjetivo === 0) {
    horasObjetivo = round(dias * HOURS_PER_DAY);
  }

  return {
    horasObjetivo,
    horasUmbral: round(horasUmbral),
    horasCalendario,
    tieneUmbral: horasUmbral > 0,
    detalle,
  };
}

/**
 * Días hábiles que esta persona tiene realmente dentro del periodo.
 *
 * Quien entra o sale a mitad de mes no aporta —ni se le puede exigir—
 * un mes completo. El rango se recorta contra su fecha de ingreso y su
 * fecha de retiro, y los días se cuentan con el calendario que se le
 * pase, para que la librería siga sin depender de festivos.
 */
function employeeBusinessDays({ employee, dateFrom, dateTo, businessDaysBetween }) {
  if (typeof businessDaysBetween !== "function" || !dateFrom || !dateTo) return 0;
  const e = employee || {};
  const desde = e.fechaIngreso && e.fechaIngreso > dateFrom ? e.fechaIngreso : dateFrom;
  const hasta = e.fechaRetiro && e.fechaRetiro < dateTo ? e.fechaRetiro : dateTo;
  if (desde > hasta) return 0; // entró después del periodo, o salió antes
  return Math.max(0, num(businessDaysBetween(desde, hasta)));
}

/** ¿Su vínculo laboral se cruza con el periodo? */
function worksInPeriod(employee, dateFrom, dateTo) {
  const e = employee || {};
  if (e.fechaIngreso && e.fechaIngreso > dateTo) return false;
  if (e.fechaRetiro && e.fechaRetiro < dateFrom) return false;
  return true;
}

/**
 * ¿El tiempo de esta persona se espera que genere ingreso?
 *
 * La marca del empleado manda; si está sin definir se hereda del cargo.
 * El mismo cargo puede facturarse en una cuenta y ser estructura interna
 * en otra, así que el puesto sólo sirve como punto de partida.
 */
function isBillableResource(employee, cargo) {
  if (employee && employee.facturable != null) return Boolean(employee.facturable);
  if (cargo && cargo.facturablePorDefecto != null) {
    return Boolean(cargo.facturablePorDefecto);
  }
  return true;
}

/**
 * Objetivo de la empresa: capacidad vendible del periodo.
 *
 * Responde a una pregunta distinta que la card del empleado. Aquí no
 * importa qué umbral tenga cada proyecto: lo que se mide es cuánta de la
 * gente colocable está efectivamente colocada. Por eso el objetivo de
 * cada recurso es un mes completo, y el hueco frente a lo registrado en
 * proyectos facturables es capacidad sin vender.
 *
 * Que el resultado viva por debajo del 100% es lo normal: es el margen
 * de crecimiento, no una nota que aprobar.
 */
function companyTarget({ employees, cargos, dateFrom, dateTo, businessDaysBetween }) {
  const porCargo = new Map((cargos || []).map((c) => [c.ID, c]));
  const recursos = (employees || [])
    .filter((e) => isBillableResource(e, porCargo.get(e.cargo_ID)))
    .filter((e) => worksInPeriod(e, dateFrom, dateTo))
    .map((e) => ({
      ID: e.ID,
      diasHabiles: employeeBusinessDays({
        employee: e, dateFrom, dateTo, businessDaysBetween,
      }),
    }))
    .filter((e) => e.diasHabiles > 0);

  const horasObjetivo = round(
    recursos.reduce((acc, r) => acc + r.diasHabiles * HOURS_PER_DAY, 0),
  );

  return {
    recursos: recursos.length,
    recursosIDs: recursos.map((r) => r.ID),
    // Ya no hay una cifra única por recurso: quien entró a mitad de mes
    // aporta menos. Se informa el promedio para poder leer la tarjeta.
    horasPorRecurso: recursos.length
      ? round(horasObjetivo / recursos.length)
      : 0,
    horasObjetivo,
    detalle: recursos,
  };
}

/**
 * Horas que cuentan para el objetivo de empresa: las registradas en
 * proyectos que se facturan. El trabajo interno es costo, no ingreso;
 * si contara, alguien volcado en coordinación daría el 100% de un
 * indicador que existe para medir facturación.
 */
function billableRegisteredHours({ entries, projects }) {
  const internos = new Set(
    (projects || [])
      .filter((p) => p && p.modality === "INTERNAL")
      .map((p) => p.ID),
  );
  return round(
    (entries || [])
      .filter((e) => e && !internos.has(e.project_ID))
      .reduce((acc, e) => acc + num(e.registeredHours != null ? e.registeredHours : e.durationHours), 0),
  );
}

/** Objetivos de varios empleados de una vez. */
function employeeTargets({ employeeIDs, assignments, projects, businessDays }) {
  return (employeeIDs || []).map((employeeID) => ({
    employeeID,
    ...employeeTarget({ employeeID, assignments, projects, businessDays }),
  }));
}

module.exports = {
  HOURS_PER_DAY,
  billableRegisteredHours,
  companyTarget,
  employeeBusinessDays,
  worksInPeriod,
  employeeTarget,
  employeeTargets,
  isBillableResource,
  splitProjectTarget,
};
