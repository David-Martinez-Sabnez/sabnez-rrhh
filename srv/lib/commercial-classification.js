"use strict";

/**
 * Clasificación comercial de una hora registrada.
 *
 * Antes esto no existía: cada registro nacía con tratamiento `PENDING` y
 * cero horas facturables, y nadie lo volvía a tocar nunca. El campo estaba
 * pero estaba muerto.
 *
 * La regla vive en el proyecto y no en la aprobación, porque lo que define
 * si una hora se puede cobrar es el contrato. El aprobador confirma que se
 * trabajó, que es otra pregunta.
 *
 * Cada registro termina con dos números que casi siempre son iguales y que
 * por eso mismo conviene separar:
 *
 *   billableHours  lo que se le cobra al cliente
 *   payableHours   lo que se le reconoce al recurso
 *
 * Se separan porque existe el sábado que el cliente no aprobó y que Sabnez
 * igual compensa. Con un solo número esa hora desaparece; con dos queda
 * como lo que es, costo sin ingreso.
 */

const TRATAMIENTOS = [
  "INCLUDED_FULL_TIME",
  "BILLABLE_REGULAR",
  "BILLABLE_OVERTIME",
  "SPECIAL_RATE",
  "NON_BILLABLE",
  "PENDING",
];

const TIPOS_TIEMPO = [
  "REGULAR",
  "OVERTIME",
  "NIGHT",
  "SUNDAY",
  "HOLIDAY",
  "COMPENSATORY",
  "FLEX_INCLUDED",
];

/**
 * Tratamientos que generan ingreso.
 *
 * `INCLUDED_FULL_TIME` cuenta como facturable aunque no se cobre por hora:
 * el cliente paga una mensualidad por tener el recurso, así que esas horas
 * sí están entregando algo que se cobra. Ponerlas en cero haría que un
 * consultor de tiempo completo apareciera con 0 % de facturación en el
 * dashboard, que es justo lo contrario de la realidad.
 */
const TRATAMIENTOS_FACTURABLES = new Set([
  "INCLUDED_FULL_TIME",
  "BILLABLE_REGULAR",
  "BILLABLE_OVERTIME",
  "SPECIAL_RATE",
]);

const EXTRAS = ["OVERTIME", "NIGHT", "SUNDAY", "HOLIDAY"];

/**
 * Tipos de tiempo que están por encima de la jornada ordinaria.
 *
 * Importa para saber cuándo una hora no facturable es una deuda con el
 * recurso. Ocho horas regulares en un proyecto interno no se le cobran a
 * nadie, pero tampoco se le deben a nadie: la persona está en nómina.
 * Ocho horas de domingo que el cliente no aprobó sí hay que responderlas.
 */
const TIPOS_EXTRA = new Set([...EXTRAS, "COMPENSATORY"]);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value) {
  return Math.round(num(value) * 100) / 100;
}

function regla(requestedType, treatment, extra) {
  return Object.assign(
    {
      requestedType,
      treatment,
      billableFactor: TRATAMIENTOS_FACTURABLES.has(treatment) ? 1 : 0,
      payableToEmployee: true,
      active: true,
    },
    extra || {},
  );
}

/**
 * La matriz con la que nace un proyecto según su modalidad.
 *
 * Son valores de arranque, no dogma: la idea es que el 90 % de los
 * proyectos queden bien sin que nadie toque nada, y que el 10 % restante
 * se corrija en la pantalla del proyecto.
 *
 * Las horas extra en un proyecto de tiempo completo nacen NO facturables
 * a propósito. Que el recurso haya trabajado de más no significa que el
 * contrato lo cubra; si lo cubre, se marca en el proyecto. Pero el recurso
 * las conserva como pagables, porque a él sí hay que responderle.
 */
function defaultRulesForModality(modality) {
  const m = String(modality || "").toUpperCase();

  if (m === "INTERNAL") {
    return TIPOS_TIEMPO.map((t) => regla(t, "NON_BILLABLE"));
  }

  if (m === "HOURLY") {
    return [
      regla("REGULAR", "BILLABLE_REGULAR"),
      regla("FLEX_INCLUDED", "BILLABLE_REGULAR"),
      ...EXTRAS.map((t) => regla(t, "BILLABLE_OVERTIME")),
      regla("COMPENSATORY", "NON_BILLABLE"),
    ];
  }

  if (m === "MIXED") {
    return [
      regla("REGULAR", "INCLUDED_FULL_TIME"),
      regla("FLEX_INCLUDED", "INCLUDED_FULL_TIME"),
      ...EXTRAS.map((t) => regla(t, "BILLABLE_OVERTIME")),
      regla("COMPENSATORY", "NON_BILLABLE"),
    ];
  }

  // FULL_TIME y cualquier modalidad desconocida: lo contratado va incluido
  // y todo lo demás hay que negociarlo antes de cobrarlo.
  return [
    regla("REGULAR", "INCLUDED_FULL_TIME"),
    regla("FLEX_INCLUDED", "INCLUDED_FULL_TIME"),
    ...EXTRAS.map((t) => regla(t, "NON_BILLABLE")),
    regla("COMPENSATORY", "NON_BILLABLE"),
  ];
}

/**
 * Filas listas para insertar cuando se crea un proyecto o cuando uno viejo
 * todavía no tiene matriz.
 */
function seedRulesForProject(project) {
  const p = project || {};
  return defaultRulesForModality(p.modality).map((r) => ({
    project_ID: p.ID,
    requestedType: r.requestedType,
    treatment: r.treatment,
    billableFactor: r.billableFactor,
    payableToEmployee: r.payableToEmployee,
    active: true,
  }));
}

/**
 * Busca la regla que aplica. Si el proyecto no tiene matriz configurada
 * cae en la de su modalidad, para que un proyecto viejo nunca deje un
 * registro sin clasificar.
 */
function findRule({ requestedType, project, rules }) {
  const tipo = String(requestedType || "REGULAR").toUpperCase();
  const configuradas = Array.isArray(rules) ? rules : [];

  const propia = configuradas.find(
    (r) =>
      r &&
      r.active !== false &&
      String(r.requestedType || "").toUpperCase() === tipo &&
      (!r.project_ID || !project || !project.ID || r.project_ID === project.ID),
  );
  if (propia) return propia;

  const porDefecto = defaultRulesForModality(project && project.modality);
  return (
    porDefecto.find((r) => r.requestedType === tipo) ||
    regla(tipo, "NON_BILLABLE")
  );
}

function esFacturable(treatment) {
  return TRATAMIENTOS_FACTURABLES.has(String(treatment || "").toUpperCase());
}

/**
 * Si una hora no facturable le queda debiendo algo al recurso.
 *
 * Lo es cuando fue tiempo por encima de la jornada, o cuando alguien
 * corrigió a mano la facturabilidad: ahí la hora se trabajó esperando
 * cobrarla y el cliente la rechazó después.
 */
function esDeuda(requestedType, manual) {
  return Boolean(manual) || TIPOS_EXTRA.has(String(requestedType || "").toUpperCase());
}

/**
 * El cálculo de un registro.
 *
 * La corrección manual le gana a todo y el recálculo no la pisa nunca: si
 * alguien marcó a mano que el cliente no aprobó ese sábado, esa decisión
 * sobrevive a cualquier reproceso posterior.
 */
function classifyEntry({ entry, project, rules }) {
  const e = entry || {};
  const horas = Math.max(0, num(e.durationHours));
  const rule = findRule({
    requestedType: e.requestedType,
    project,
    rules,
  });

  const override = e.treatmentOverride
    ? String(e.treatmentOverride).toUpperCase()
    : null;
  const manual = Boolean(override) && TRATAMIENTOS.includes(override);
  const treatment = manual ? override : String(rule.treatment).toUpperCase();

  // El factor sólo tiene sentido cuando la regla del proyecto es la que
  // manda. Una corrección manual dice "esto se cobra" o "esto no", sin
  // recargos inventados.
  const factor = manual
    ? 1
    : rule.billableFactor == null
      ? 1
      : num(rule.billableFactor);

  const billableHours = esFacturable(treatment) ? round(horas * factor) : 0;

  // Acá está el punto: el recurso conserva sus horas aunque el cliente no
  // las pague. Sólo se le quitan si la regla del proyecto dice que ese
  // tipo de tiempo no se le reconoce a nadie.
  const payableHours = rule.payableToEmployee === false ? 0 : round(horas);

  return {
    commercialTreatment: treatment,
    billableHours,
    payableHours,
    // Horas que salen del bolsillo de Sabnez sin entrar por el del cliente.
    compensationGap: esDeuda(e.requestedType, manual)
      ? round(Math.max(0, payableHours - billableHours))
      : 0,
    manualOverride: manual,
    appliedRule: rule.requestedType,
  };
}

/**
 * Agrupa las reglas por proyecto para no consultar la base una vez por
 * registro cuando se reprocesa un periodo entero.
 */
function indexRulesByProject(rules) {
  const index = new Map();
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r || !r.project_ID) continue;
    if (!index.has(r.project_ID)) index.set(r.project_ID, []);
    index.get(r.project_ID).push(r);
  }
  return index;
}

/**
 * Clasifica un lote. Cada registro tiene que traer su `project_ID` para
 * saber qué matriz le toca.
 */
function classifyEntries({ entries, projects, rules }) {
  const porProyecto = new Map(
    (Array.isArray(projects) ? projects : []).map((p) => [p.ID, p]),
  );
  const reglas = indexRulesByProject(rules);

  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const projectID = entry && (entry.project_ID || entry.projectID);
    const project = porProyecto.get(projectID) || null;
    return Object.assign(
      { ID: entry && entry.ID },
      classifyEntry({
        entry,
        project,
        rules: reglas.get(projectID) || [],
      }),
    );
  });
}

module.exports = {
  TRATAMIENTOS,
  TIPOS_TIEMPO,
  TIPOS_EXTRA,
  esDeuda,
  TRATAMIENTOS_FACTURABLES,
  defaultRulesForModality,
  seedRulesForProject,
  findRule,
  esFacturable,
  classifyEntry,
  classifyEntries,
  indexRulesByProject,
};
