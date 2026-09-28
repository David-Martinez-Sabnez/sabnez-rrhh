"use strict";

/**
 * La aritmética de una factura, sin base de datos de por medio.
 *
 * Lo que se factura y lo que entra a la cuenta no son el mismo número, y
 * el error clásico de la hoja de cálculo es sumarlos en una sola columna.
 * Acá van separados:
 *
 *   total         lo que dice la factura
 *   withheld      lo que el cliente retiene y le entrega a la DIAN por ti
 *   netExpected   lo que consignan
 *   taxAmount     de lo consignado, cuánto es IVA que hay que declarar
 *
 * De cada peso facturado a un cliente nacional, cerca del 80 % es plata
 * disponible. El resto está de paso.
 */

const DIA_MS = 24 * 60 * 60 * 1000;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  // El redondeo a la mitad se hace hacia arriba de forma estable: sin el
  // épsilon, 1.005 se guarda como 1.00 por cómo se representa en binario.
  const n = num(value);
  const signo = n < 0 ? -1 : 1;
  return signo * Math.round(Math.abs(n) * 100 + Number.EPSILON * 100) / 100;
}

function toISODate(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function addDays(isoDate, days) {
  const base = toISODate(isoDate);
  if (!base) return null;
  const d = new Date(`${base}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + num(days) * DIA_MS).toISOString().slice(0, 10);
}

function monthKey(isoDate) {
  const d = toISODate(isoDate);
  return d ? d.slice(0, 7) : null;
}

function vigente(fila, fecha) {
  if (!fila) return false;
  if (fila.active === false) return false;
  const f = toISODate(fecha);
  if (!f) return true;
  const desde = toISODate(fila.validFrom);
  const hasta = toISODate(fila.validTo);
  return (!desde || desde <= f) && (!hasta || hasta >= f);
}

/**
 * Suma de las líneas y cuánto de eso lleva IVA.
 *
 * Exportación de servicios: excluida de IVA. No es que la tarifa sea
 * cero, es que la operación no está gravada, y por eso tampoco genera
 * reteIVA.
 */
function sumLines({ lines, exportOfServices }) {
  const filas = Array.isArray(lines) ? lines : [];
  let subtotal = 0;
  let taxableBase = 0;
  for (const linea of filas) {
    const importe =
      linea.amount != null
        ? num(linea.amount)
        : round2(num(linea.quantity) * num(linea.unitPrice));
    subtotal += importe;
    if (!exportOfServices && linea.taxable !== false) taxableBase += importe;
  }
  return { subtotal: round2(subtotal), taxableBase: round2(taxableBase) };
}

/**
 * Las retenciones que le aplican a esta factura.
 *
 * Se calculan sobre su propia base: retefuente y reteICA sobre el valor
 * del servicio, reteIVA sobre el impuesto. Cada una lleva su cuantía
 * mínima, porque por debajo de cierto monto simplemente no se practica.
 */
function applicableWithholdings({
  profile,
  issueDate,
  subtotal,
  taxAmount,
  exportOfServices,
}) {
  // A un pagador del exterior no le aplica el régimen de retenciones
  // colombiano. Meterle una retefuente inventaría una plata que nadie
  // va a descontar en la declaración de renta.
  if (exportOfServices) return [];

  const filas = (Array.isArray(profile) ? profile : []).filter((f) =>
    vigente(f, issueDate),
  );

  const resultado = [];
  for (const fila of filas) {
    const base = fila.base === "TAX" ? num(taxAmount) : num(subtotal);
    const minimo = num(fila.minimumBase);
    const tarifa = num(fila.rate);
    if (base <= 0 || tarifa <= 0) continue;
    if (minimo > 0 && base < minimo) continue;
    resultado.push({
      type: fila.type,
      label: fila.label || fila.type,
      base: round2(base),
      rate: tarifa,
      amount: round2((base * tarifa) / 100),
    });
  }
  return resultado;
}

/**
 * Cuántos días se demora en pagar esta factura.
 *
 * El plazo vive en el cliente, pero un contrato puede haber negociado
 * otro y ése manda. Vacío en el contrato significa "lo que diga el
 * cliente", no "de contado": por eso se distingue el null del cero.
 *
 * Si la factura mezcla proyectos de contratos distintos no hay un plazo
 * del contrato que aplicar, y se cae al del cliente diciéndolo.
 */
function resolvePaymentTerm({ contract, client, contracts, mixed }) {
  const lista = Array.isArray(contracts) ? contracts.filter(Boolean) : [];
  // `mixed` lo pone quien llama cuando además hay proyectos sin contrato:
  // desde acá no se distingue un contrato ausente de una lista corta.
  const mezclados = Boolean(mixed) || lista.length > 1;
  const unico = contract || (!mezclados && lista.length === 1 ? lista[0] : null);

  if (!mezclados && unico && unico.paymentTermDays != null)
    return {
      days: num(unico.paymentTermDays),
      source: "CONTRACT",
      contractID: unico.ID || null,
      mixed: false,
    };

  const delCliente = client && client.paymentTermDays != null ? num(client.paymentTermDays) : 30;
  return {
    days: delCliente,
    source: client && client.paymentTermDays != null ? "CLIENT" : "DEFAULT",
    contractID: !mezclados && unico ? unico.ID || null : null,
    mixed: mezclados,
  };
}

/**
 * Todo lo que hay que saber de una factura antes de emitirla.
 *
 * `exchangeRate` es la TRM del día de emisión: es la que exige la DIAN
 * para contabilizar una factura en moneda extranjera, y la que después
 * sirve de referencia para medir la diferencia en cambio al cobrar.
 */
function buildInvoiceTotals({
  lines,
  taxRate = 19,
  exportOfServices = false,
  withholdingProfile,
  issueDate,
  paymentTermDays,
  exchangeRate,
}) {
  const { subtotal, taxableBase } = sumLines({ lines, exportOfServices });
  const tasaIVA = exportOfServices ? 0 : num(taxRate);
  const taxAmount = round2((taxableBase * tasaIVA) / 100);
  const total = round2(subtotal + taxAmount);

  const withholdings = applicableWithholdings({
    profile: withholdingProfile,
    issueDate,
    subtotal,
    taxAmount,
    exportOfServices,
  });
  const withheldAmount = round2(
    withholdings.reduce((suma, r) => suma + r.amount, 0),
  );
  const netExpected = round2(total - withheldAmount);

  // Sólo las retenciones sobre renta y sobre ICA son anticipo de impuesto
  // propio. El reteIVA no: ése baja lo que hay que declarar de IVA, no lo
  // que se paga de renta. Confundirlos infla el saldo a favor.
  const taxPrepayment = round2(
    withholdings
      .filter((r) => r.type !== "RETEIVA")
      .reduce((suma, r) => suma + r.amount, 0),
  );
  const vatWithheld = round2(
    withholdings
      .filter((r) => r.type === "RETEIVA")
      .reduce((suma, r) => suma + r.amount, 0),
  );

  const trm = num(exchangeRate) > 0 ? num(exchangeRate) : 1;

  return {
    subtotal,
    taxableBase,
    taxRate: tasaIVA,
    taxAmount,
    total,
    withholdings,
    withheldAmount,
    netExpected,
    taxPrepayment,
    // Lo que hay que girarle a la DIAN por este documento.
    vatPayable: round2(taxAmount - vatWithheld),
    expectedPaymentDate:
      issueDate && paymentTermDays != null
        ? addDays(issueDate, paymentTermDays)
        : null,
    exchangeRate: num(exchangeRate) > 0 ? num(exchangeRate) : null,
    totalCOP: round2(total * trm),
    netExpectedCOP: round2(netExpected * trm),
  };
}

/**
 * Un recaudo.
 *
 * La diferencia en cambio es la parte que suele perderse: el cliente pagó
 * los dólares completos, pero como la TRM cayó, en pesos entró menos de
 * lo que se contabilizó al emitir. Eso es un gasto financiero con nombre
 * propio, no un descuadre de caja.
 */
function computePayment({ invoice, payment }) {
  const inv = invoice || {};
  const pago = payment || {};
  const monto = round2(num(pago.amount));
  const trmPago = num(pago.exchangeRate) > 0 ? num(pago.exchangeRate) : null;
  const trmEmision =
    num(inv.exchangeRate) > 0 ? num(inv.exchangeRate) : trmPago;

  const esPesos = String(inv.currency || "COP").toUpperCase() === "COP";
  const tasa = esPesos ? 1 : trmPago || trmEmision || 1;
  const amountCOP = round2(monto * tasa);

  // Sin las dos tasas no hay diferencia que medir. Cero es más honesto
  // que un número inventado con una sola.
  const fxDifferenceCOP =
    !esPesos && trmPago && trmEmision ? round2(monto * (trmPago - trmEmision)) : 0;

  return { amount: monto, exchangeRate: esPesos ? null : tasa, amountCOP, fxDifferenceCOP };
}

/**
 * Estado y acumulados de una factura después de sus recaudos.
 *
 * Se compara contra lo que se espera recibir, no contra el total: el
 * cliente nunca va a consignar lo retenido, así que exigir el total
 * dejaría todas las facturas eternamente a medio pagar.
 */
function settleInvoice({ invoice, payments }) {
  const inv = invoice || {};
  const filas = Array.isArray(payments) ? payments : [];
  let paidAmount = 0;
  let paidAmountCOP = 0;
  let fxDifferenceCOP = 0;
  for (const p of filas) {
    const calculado = p.amountCOP != null ? p : computePayment({ invoice: inv, payment: p });
    paidAmount += num(p.amount);
    paidAmountCOP += num(calculado.amountCOP);
    fxDifferenceCOP += num(calculado.fxDifferenceCOP);
  }
  paidAmount = round2(paidAmount);
  const esperado = round2(num(inv.netExpected));

  let status = inv.status;
  if (inv.status !== "VOID" && inv.status !== "DRAFT") {
    // Un centavo de más no puede dejar una factura sin saldar, ni un
    // redondeo puede dejarla "parcial" para siempre.
    if (esperado > 0 && paidAmount >= esperado - 0.01) status = "PAID";
    else if (paidAmount > 0) status = "PARTIALLY_PAID";
    else status = inv.status === "PARTIALLY_PAID" || inv.status === "PAID"
      ? "ISSUED"
      : inv.status;
  }

  return {
    paidAmount,
    paidAmountCOP: round2(paidAmountCOP),
    fxDifferenceCOP: round2(fxDifferenceCOP),
    outstanding: round2(Math.max(0, esperado - paidAmount)),
    status,
  };
}

/**
 * Cuántos días lleva vencida una factura emitida y sin pagar.
 * Negativo significa que todavía no vence.
 */
function daysOverdue(invoice, today) {
  const inv = invoice || {};
  const vence = toISODate(inv.expectedPaymentDate);
  const hoy = toISODate(today);
  if (!vence || !hoy) return null;
  return Math.round(
    (new Date(`${hoy}T00:00:00Z`) - new Date(`${vence}T00:00:00Z`)) / DIA_MS,
  );
}

const TRAMOS = [
  { clave: "corriente", hasta: 0, etiqueta: "Aún no vence" },
  { clave: "d1_30", hasta: 30, etiqueta: "1 a 30 días" },
  { clave: "d31_60", hasta: 60, etiqueta: "31 a 60 días" },
  { clave: "d61_90", hasta: 90, etiqueta: "61 a 90 días" },
  { clave: "d90_mas", hasta: Infinity, etiqueta: "Más de 90 días" },
];

/**
 * Cartera por antigüedad. Lo que importa no es cuánto te deben sino desde
 * cuándo: una factura de hace cuatro meses ya no es cartera, es un
 * problema que hay que ir a resolver.
 */
function receivablesAging({ invoices, today }) {
  const tramos = TRAMOS.map((t) => ({
    clave: t.clave,
    etiqueta: t.etiqueta,
    montoCOP: 0,
    facturas: 0,
  }));
  let totalCOP = 0;

  for (const inv of Array.isArray(invoices) ? invoices : []) {
    if (!["ISSUED", "SENT", "PARTIALLY_PAID"].includes(inv.status)) continue;
    const trm = num(inv.exchangeRate) > 0 ? num(inv.exchangeRate) : 1;
    const pendiente = round2(
      Math.max(0, num(inv.netExpected) - num(inv.paidAmount)) * trm,
    );
    if (pendiente <= 0) continue;
    const dias = daysOverdue(inv, today);
    const indice =
      dias == null || dias <= 0
        ? 0
        : TRAMOS.findIndex((t) => dias <= t.hasta && t.hasta > 0);
    const destino = tramos[indice < 0 ? tramos.length - 1 : indice];
    destino.montoCOP = round2(destino.montoCOP + pendiente);
    destino.facturas += 1;
    totalCOP = round2(totalCOP + pendiente);
  }

  return { tramos, totalCOP };
}

/**
 * Caja esperada mes a mes.
 *
 * El desfase es el punto de todo esto: las horas de agosto se facturan a
 * principios de septiembre y, a 30 días, la plata entra en octubre. Cada
 * factura cae en el mes de su fecha esperada de pago, no en el mes en que
 * se trabajó ni en el que se emitió.
 */
function cashProjection({ invoices, from, to, today }) {
  const desde = monthKey(from);
  const hasta = monthKey(to);
  const meses = new Map();

  const mes = (clave) => {
    if (!meses.has(clave))
      meses.set(clave, {
        mes: clave,
        facturadoCOP: 0,
        cajaEsperadaCOP: 0,
        cajaRecibidaCOP: 0,
        ivaCOP: 0,
        anticiposCOP: 0,
        vencidoCOP: 0,
      });
    return meses.get(clave);
  };

  for (const inv of Array.isArray(invoices) ? invoices : []) {
    if (inv.status === "VOID" || inv.status === "DRAFT") continue;
    const trm = num(inv.exchangeRate) > 0 ? num(inv.exchangeRate) : 1;

    const mesEmision = monthKey(inv.issueDate);
    if (mesEmision && (!desde || mesEmision >= desde) && (!hasta || mesEmision <= hasta)) {
      const m = mes(mesEmision);
      m.facturadoCOP = round2(m.facturadoCOP + num(inv.total) * trm);
      m.ivaCOP = round2(m.ivaCOP + num(inv.taxAmount) * trm);
      m.anticiposCOP = round2(m.anticiposCOP + num(inv.withheldAmount) * trm);
    }

    const pendiente = Math.max(0, num(inv.netExpected) - num(inv.paidAmount));
    if (pendiente > 0) {
      // Una factura ya vencida no se proyecta en el pasado: se espera
      // este mes, que es cuando toca ir a cobrarla.
      const vence = toISODate(inv.expectedPaymentDate);
      const atrasada = vence && today && vence < toISODate(today);
      const clave = atrasada ? monthKey(today) : monthKey(vence);
      if (clave && (!desde || clave >= desde) && (!hasta || clave <= hasta)) {
        const m = mes(clave);
        m.cajaEsperadaCOP = round2(m.cajaEsperadaCOP + pendiente * trm);
        if (atrasada) m.vencidoCOP = round2(m.vencidoCOP + pendiente * trm);
      }
    }

    for (const pago of inv.payments || []) {
      const clave = monthKey(pago.paymentDate);
      if (!clave || (desde && clave < desde) || (hasta && clave > hasta)) continue;
      const m = mes(clave);
      m.cajaRecibidaCOP = round2(m.cajaRecibidaCOP + num(pago.amountCOP));
    }
  }

  return [...meses.values()].sort((a, b) => (a.mes < b.mes ? -1 : 1));
}

module.exports = {
  resolvePaymentTerm,
  round2,
  addDays,
  monthKey,
  toISODate,
  sumLines,
  applicableWithholdings,
  buildInvoiceTotals,
  computePayment,
  settleInvoice,
  daysOverdue,
  receivablesAging,
  cashProjection,
};
