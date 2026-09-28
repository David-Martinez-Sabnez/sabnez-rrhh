"use strict";

/**
 * Lo devengado: cuánto se ganó por el trabajo entregado, mes a mes,
 * independientemente de cuándo se facture y de cuándo lo paguen.
 *
 * Son tres cifras distintas y confundirlas es lo que hace que un
 * presupuesto en Excel deje de cuadrar:
 *
 *   devengado  el trabajo del mes, valorado a su tarifa
 *   facturado  lo que salió en un documento
 *   caja       lo que entró a la cuenta
 *
 * Un proyecto por horas devenga hora a hora. Uno de tiempo completo no:
 * el cliente paga una mensualidad por tener el recurso, así que devenga
 * esa mensualidad —prorrateada si la persona entró o salió a mitad de
 * mes— y no la suma de sus horas.
 */

const CONTINUOS = new Set(["INCLUDED_FULL_TIME"]);
const POR_HORA = new Set(["BILLABLE_REGULAR", "BILLABLE_OVERTIME", "SPECIAL_RATE"]);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  const n = num(value);
  const signo = n < 0 ? -1 : 1;
  return signo * Math.round(Math.abs(n) * 100 + Number.EPSILON * 100) / 100;
}

function iso(value) {
  return value ? String(value).slice(0, 10) : null;
}

function monthKey(value) {
  const d = iso(value);
  return d ? d.slice(0, 7) : null;
}

function monthStart(clave) {
  return `${clave}-01`;
}

function monthEnd(clave) {
  const [anio, mes] = clave.split("-").map(Number);
  return new Date(Date.UTC(anio, mes, 0)).toISOString().slice(0, 10);
}

function vigente(fila, fecha) {
  const desde = iso(fila && fila.validFrom);
  const hasta = iso(fila && fila.validTo);
  return (!desde || desde <= fecha) && (!hasta || hasta >= fecha);
}

/**
 * La tarifa que aplica a una asignación en una fecha. Se toma la vigente
 * más reciente: si alguien cargó dos tarifas solapadas, manda la que
 * empezó después, que es lo que se espera al renegociar.
 */
function rateFor({ rates, assignmentID, date }) {
  return (Array.isArray(rates) ? rates : [])
    .filter((r) => r.assignment_ID === assignmentID && vigente(r, date))
    .sort((a, b) => (iso(a.validFrom) < iso(b.validFrom) ? 1 : -1))[0] || null;
}

/**
 * Qué parte del mes estuvo viva la asignación. Quien entró el 20 no
 * devenga la mensualidad completa.
 */
function monthlyFraction({ assignment, mes, projectID, businessDaysBetween }) {
  if (typeof businessDaysBetween !== "function") return 1;
  const inicioMes = monthStart(mes);
  const finMes = monthEnd(mes);
  const desde = iso(assignment && assignment.validFrom);
  const hasta = iso(assignment && assignment.validTo);
  const inicio = desde && desde > inicioMes ? desde : inicioMes;
  const fin = hasta && hasta < finMes ? hasta : finMes;
  if (inicio > fin) return 0;
  const totales = num(businessDaysBetween(inicioMes, finMes, projectID));
  if (totales <= 0) return 1;
  return Math.min(1, num(businessDaysBetween(inicio, fin, projectID)) / totales);
}

function hourlySaleRate(rate, treatment) {
  if (!rate) return 0;
  if (treatment === "BILLABLE_OVERTIME")
    return num(rate.overtimeSaleHourlyRate) || num(rate.regularSaleHourlyRate);
  return num(rate.regularSaleHourlyRate);
}

/**
 * Devengado, costo y margen por mes.
 *
 * `resolveExchangeRate` recibe {currency, date} y devuelve {rate}. Las
 * tarifas pueden estar en dólares y el dashboard habla en pesos.
 */
function accruedRevenue({
  entries,
  assignments,
  rates,
  projects,
  from,
  to,
  resolveExchangeRate,
  businessDaysBetween,
}) {
  const asignaciones = new Map(
    (Array.isArray(assignments) ? assignments : []).map((a) => [a.ID, a]),
  );
  const proyectos = new Map(
    (Array.isArray(projects) ? projects : []).map((p) => [p.ID, p]),
  );
  const desde = monthKey(from);
  const hasta = monthKey(to);

  const meses = new Map();
  const mes = (clave) => {
    if (!meses.has(clave))
      meses.set(clave, {
        mes: clave,
        devengadoCOP: 0,
        costoCOP: 0,
        margenCOP: 0,
        horasFacturables: 0,
        horasPorCompensar: 0,
      });
    return meses.get(clave);
  };

  // Las mensualidades se acumulan por (asignación, mes) y se valoran una
  // sola vez al final: si se sumaran por registro, un recurso de tiempo
  // completo devengaría veinte mensualidades al mes.
  const mensualidades = new Map();
  // Asignaciones que entregaron horas facturables y no tienen tarifa
  // cargada. Sin esto valen cero y el dashboard miente en silencio.
  const sinTarifa = new Map();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const clave = monthKey(entry.workDate);
    if (!clave) continue;
    if (desde && clave < desde) continue;
    if (hasta && clave > hasta) continue;

    const asignacion = asignaciones.get(entry.assignment_ID) || null;
    const proyectoID = entry.project_ID || (asignacion && asignacion.project_ID);
    const proyecto = proyectos.get(proyectoID) || null;
    if (proyecto && proyecto.modality === "INTERNAL") continue;

    const m = mes(clave);
    const facturables = num(entry.billableHours);
    const pagables = num(entry.payableHours);
    m.horasFacturables = round2(m.horasFacturables + facturables);

    const tarifa = rateFor({
      rates,
      assignmentID: entry.assignment_ID,
      date: iso(entry.workDate),
    });
    const monedaVenta = (tarifa && (tarifa.saleCurrency || tarifa.currency)) || "COP";
    const monedaCosto = (tarifa && (tarifa.costCurrency || tarifa.currency)) || "COP";
    const trmVenta = resolveExchangeRate
      ? num((resolveExchangeRate({ currency: monedaVenta, date: iso(entry.workDate) }) || {}).rate)
      : 1;
    const trmCosto = resolveExchangeRate
      ? num((resolveExchangeRate({ currency: monedaCosto, date: iso(entry.workDate) }) || {}).rate)
      : 1;
    const ventaAPesos = trmVenta > 0 ? trmVenta : 1;
    const costoAPesos = trmCosto > 0 ? trmCosto : 1;

    if (CONTINUOS.has(entry.commercialTreatment)) {
      const llave = `${entry.assignment_ID}|${clave}`;
      if (!mensualidades.has(llave))
        mensualidades.set(llave, {
          mes: clave,
          assignment_ID: entry.assignment_ID,
          asignacion,
          projectID: proyectoID,
          tarifa,
          ventaAPesos,
          costoAPesos,
        });
    } else if (POR_HORA.has(entry.commercialTreatment)) {
      const porHora = hourlySaleRate(tarifa, entry.commercialTreatment);
      if (facturables > 0 && porHora <= 0 && entry.assignment_ID)
        sinTarifa.set(entry.assignment_ID, {
          assignment_ID: entry.assignment_ID,
          proyecto: proyecto ? proyecto.name : null,
          mes: clave,
          horas: round2(num((sinTarifa.get(entry.assignment_ID) || {}).horas) + facturables),
        });
      m.devengadoCOP = round2(m.devengadoCOP + facturables * porHora * ventaAPesos);
    }

    // El costo por hora aplica a lo que se le reconoce al recurso, se le
    // cobre o no al cliente. Un sábado no aprobado cuesta igual.
    if (!CONTINUOS.has(entry.commercialTreatment)) {
      const costoHora = num(tarifa && tarifa.internalHourlyCost);
      m.costoCOP = round2(m.costoCOP + pagables * costoHora * costoAPesos);
    }
    if (pagables > facturables)
      m.horasPorCompensar = round2(m.horasPorCompensar + (pagables - facturables));
  }

  for (const fila of mensualidades.values()) {
    const m = mes(fila.mes);
    const fraccion = monthlyFraction({
      assignment: fila.asignacion,
      mes: fila.mes,
      projectID: fila.projectID,
      businessDaysBetween,
    });
    const venta = num(fila.tarifa && fila.tarifa.monthlySaleRate);
    const costo = num(fila.tarifa && fila.tarifa.internalMonthlyCost);
    if (venta <= 0 && fila.assignment_ID && !sinTarifa.has(fila.assignment_ID))
      sinTarifa.set(fila.assignment_ID, {
        assignment_ID: fila.assignment_ID,
        proyecto: null,
        mes: fila.mes,
        horas: 0,
      });
    m.devengadoCOP = round2(m.devengadoCOP + venta * fraccion * fila.ventaAPesos);
    m.costoCOP = round2(m.costoCOP + costo * fraccion * fila.costoAPesos);
  }

  const resultado = [...meses.values()].sort((a, b) => (a.mes < b.mes ? -1 : 1));
  for (const m of resultado) m.margenCOP = round2(m.devengadoCOP - m.costoCOP);

  return { meses: resultado, sinTarifa: [...sinTarifa.values()] };
}

module.exports = {
  round2,
  monthKey,
  monthStart,
  monthEnd,
  rateFor,
  monthlyFraction,
  hourlySaleRate,
  accruedRevenue,
};
