"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  round2,
  addDays,
  sumLines,
  buildInvoiceTotals,
  computePayment,
  settleInvoice,
  daysOverdue,
  receivablesAging,
  cashProjection,
} = require("../srv/lib/invoice-math");

// Perfil típico de un cliente nacional en Bogotá, servicios, declarante.
const PERFIL_NACIONAL = [
  { type: "RETEFUENTE", label: "Retefuente servicios", rate: 4, base: "SUBTOTAL", validFrom: "2026-01-01", active: true },
  { type: "RETEICA", label: "ReteICA Bogotá", rate: 0.966, base: "SUBTOTAL", validFrom: "2026-01-01", active: true },
  { type: "RETEIVA", label: "ReteIVA", rate: 15, base: "TAX", validFrom: "2026-01-01", active: true },
];

const LINEA = { description: "Servicio profesional", quantity: 160, unitPrice: 190000, taxable: true };

// --- lo básico -----------------------------------------------------------

test("el redondeo no se come el centavo por culpa del binario", () => {
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(-1.005), -1.01);
  assert.equal(round2(2.675), 2.68);
});

test("sumar líneas calcula el importe cuando sólo viene cantidad y precio", () => {
  const r = sumLines({ lines: [LINEA], exportOfServices: false });
  assert.equal(r.subtotal, 30400000);
  assert.equal(r.taxableBase, 30400000);
});

test("una línea no gravada suma al subtotal pero no a la base de IVA", () => {
  const r = sumLines({
    lines: [LINEA, { description: "Reembolso de viáticos", amount: 500000, taxable: false }],
    exportOfServices: false,
  });
  assert.equal(r.subtotal, 30900000);
  assert.equal(r.taxableBase, 30400000);
});

test("sumar el plazo de pago cruza meses sin equivocarse", () => {
  assert.equal(addDays("2026-08-29", 30), "2026-09-28");
  assert.equal(addDays("2026-01-31", 30), "2026-03-02"); // 2026 no es bisiesto
  assert.equal(addDays("2026-12-15", 45), "2027-01-29");
});

// --- el peso que se encoge ------------------------------------------------

test("de una factura nacional de 36 millones, sólo 28,9 son plata tuya", () => {
  const r = buildInvoiceTotals({
    lines: [LINEA],
    taxRate: 19,
    withholdingProfile: PERFIL_NACIONAL,
    issueDate: "2026-08-31",
    paymentTermDays: 30,
  });

  assert.equal(r.subtotal, 30400000);
  assert.equal(r.taxAmount, 5776000, "IVA del 19 %");
  assert.equal(r.total, 36176000);

  const porTipo = Object.fromEntries(r.withholdings.map((w) => [w.type, w.amount]));
  assert.equal(porTipo.RETEFUENTE, 1216000, "4 % sobre el servicio");
  assert.equal(porTipo.RETEICA, 293664, "9,66 por mil sobre el servicio");
  assert.equal(porTipo.RETEIVA, 866400, "15 % del IVA, no del servicio");

  assert.equal(r.withheldAmount, 2376064);
  assert.equal(r.netExpected, 33799936, "esto es lo que consignan");
  assert.equal(r.vatPayable, 4909600, "IVA a declarar, ya descontado el reteIVA");

  // Lo realmente disponible: lo consignado menos el IVA que hay que girar.
  assert.equal(round2(r.netExpected - r.vatPayable), 28890336);
  assert.equal(r.expectedPaymentDate, "2026-09-30");
});

test("el reteIVA no es anticipo de renta y no puede sumarse como si lo fuera", () => {
  const r = buildInvoiceTotals({
    lines: [LINEA],
    withholdingProfile: PERFIL_NACIONAL,
    issueDate: "2026-08-31",
  });
  // Sólo retefuente + reteICA: 1.216.000 + 293.664.
  assert.equal(r.taxPrepayment, 1509664);
  assert.notEqual(r.taxPrepayment, r.withheldAmount);
});

test("una retención por debajo de su cuantía mínima no se practica", () => {
  const r = buildInvoiceTotals({
    lines: [{ description: "Soporte puntual", amount: 80000, taxable: true }],
    withholdingProfile: [
      { type: "RETEFUENTE", rate: 4, base: "SUBTOTAL", minimumBase: 104748, validFrom: "2026-01-01", active: true },
    ],
    issueDate: "2026-08-31",
  });
  assert.equal(r.withholdings.length, 0);
  assert.equal(r.netExpected, r.total);
});

test("una retención con vigencia vencida no se aplica a facturas nuevas", () => {
  const r = buildInvoiceTotals({
    lines: [LINEA],
    withholdingProfile: [
      { type: "RETEFUENTE", rate: 6, base: "SUBTOTAL", validFrom: "2024-01-01", validTo: "2025-12-31", active: true },
      { type: "RETEFUENTE", rate: 4, base: "SUBTOTAL", validFrom: "2026-01-01", active: true },
    ],
    issueDate: "2026-08-31",
  });
  assert.equal(r.withholdings.length, 1);
  assert.equal(r.withholdings[0].rate, 4, "la tarifa vieja no puede reaparecer");
});

// --- exportación de servicios ---------------------------------------------

test("exportar servicios no lleva IVA ni retenciones colombianas", () => {
  const r = buildInvoiceTotals({
    lines: [{ description: "Consultoría SAP", quantity: 1, unitPrice: 18000, taxable: true }],
    taxRate: 19,
    exportOfServices: true,
    withholdingProfile: PERFIL_NACIONAL,
    issueDate: "2026-08-15",
    paymentTermDays: 30,
    exchangeRate: 4020,
  });
  assert.equal(r.taxAmount, 0, "la operación no está gravada");
  assert.equal(r.withheldAmount, 0, "quien paga está fuera del país");
  assert.equal(r.total, 18000);
  assert.equal(r.netExpected, 18000);
  assert.equal(r.totalCOP, 72360000, "18.000 dólares a 4.020");
  assert.equal(r.expectedPaymentDate, "2026-09-14");
});

// --- el dólar que se cae ---------------------------------------------------

test("cobrar en dólares con la TRM más baja deja una pérdida real", () => {
  const factura = { currency: "USD", exchangeRate: 4020, netExpected: 18000, status: "ISSUED" };
  const pago = computePayment({
    invoice: factura,
    payment: { amount: 18000, exchangeRate: 3890, paymentDate: "2026-09-15" },
  });
  assert.equal(pago.amountCOP, 70020000, "lo que realmente entró");
  assert.equal(pago.fxDifferenceCOP, -2340000, "no facturaste de menos: la TRM cayó");
});

test("si el dólar sube, la diferencia en cambio es a favor", () => {
  const pago = computePayment({
    invoice: { currency: "USD", exchangeRate: 3900 },
    payment: { amount: 10000, exchangeRate: 4050 },
  });
  assert.equal(pago.fxDifferenceCOP, 1500000);
});

test("una factura en pesos no tiene diferencia en cambio que inventar", () => {
  const pago = computePayment({
    invoice: { currency: "COP", exchangeRate: null },
    payment: { amount: 33799936, exchangeRate: null },
  });
  assert.equal(pago.amountCOP, 33799936);
  assert.equal(pago.fxDifferenceCOP, 0);
});

test("sin la TRM del pago no se inventa una diferencia", () => {
  const pago = computePayment({
    invoice: { currency: "USD", exchangeRate: 4020 },
    payment: { amount: 5000, exchangeRate: null },
  });
  assert.equal(pago.fxDifferenceCOP, 0, "cero es más honesto que un número inventado");
});

// --- saldar la factura ------------------------------------------------------

test("la factura se salda contra lo que consignan, no contra el total", () => {
  // Si se exigiera el total, ninguna factura con retención quedaría paga.
  const factura = { status: "ISSUED", total: 36176000, netExpected: 33799936, currency: "COP" };
  const r = settleInvoice({
    invoice: factura,
    payments: [{ amount: 33799936, amountCOP: 33799936, fxDifferenceCOP: 0 }],
  });
  assert.equal(r.status, "PAID");
  assert.equal(r.outstanding, 0);
});

test("un abono parcial deja la factura a medio pagar con su saldo", () => {
  const r = settleInvoice({
    invoice: { status: "ISSUED", netExpected: 10000000, currency: "COP" },
    payments: [{ amount: 4000000, amountCOP: 4000000 }],
  });
  assert.equal(r.status, "PARTIALLY_PAID");
  assert.equal(r.outstanding, 6000000);
});

test("un centavo de diferencia por redondeo no deja la factura sin saldar", () => {
  const r = settleInvoice({
    invoice: { status: "ISSUED", netExpected: 33799936, currency: "COP" },
    payments: [{ amount: 33799935.99, amountCOP: 33799935.99 }],
  });
  assert.equal(r.status, "PAID");
});

test("una factura anulada no cambia de estado por recibir plata", () => {
  const r = settleInvoice({
    invoice: { status: "VOID", netExpected: 1000, currency: "COP" },
    payments: [{ amount: 1000, amountCOP: 1000 }],
  });
  assert.equal(r.status, "VOID");
});

test("varios abonos acumulan su diferencia en cambio", () => {
  const factura = { status: "ISSUED", currency: "USD", exchangeRate: 4000, netExpected: 20000 };
  const r = settleInvoice({
    invoice: factura,
    payments: [
      { amount: 10000, exchangeRate: 3900 },
      { amount: 10000, exchangeRate: 4100 },
    ],
  });
  assert.equal(r.paidAmount, 20000);
  assert.equal(r.paidAmountCOP, 80000000);
  assert.equal(r.fxDifferenceCOP, 0, "una caída y una subida iguales se cancelan");
  assert.equal(r.status, "PAID");
});

// --- cartera -----------------------------------------------------------------

test("los días de mora se cuentan desde la fecha esperada de pago", () => {
  assert.equal(daysOverdue({ expectedPaymentDate: "2026-08-01" }, "2026-08-29"), 28);
  assert.equal(daysOverdue({ expectedPaymentDate: "2026-09-30" }, "2026-08-29"), -32);
});

test("la cartera se reparte por antigüedad y sólo cuenta lo pendiente", () => {
  const r = receivablesAging({
    today: "2026-08-29",
    invoices: [
      { status: "ISSUED", netExpected: 1000000, paidAmount: 0, expectedPaymentDate: "2026-09-30" },
      { status: "SENT", netExpected: 2000000, paidAmount: 0, expectedPaymentDate: "2026-08-20" },
      { status: "PARTIALLY_PAID", netExpected: 5000000, paidAmount: 1000000, expectedPaymentDate: "2026-05-01" },
      { status: "PAID", netExpected: 9000000, paidAmount: 9000000, expectedPaymentDate: "2026-01-01" },
      { status: "DRAFT", netExpected: 7000000, paidAmount: 0, expectedPaymentDate: "2026-06-01" },
    ],
  });
  const t = Object.fromEntries(r.tramos.map((x) => [x.clave, x.montoCOP]));
  assert.equal(t.corriente, 1000000, "aún no vence");
  assert.equal(t.d1_30, 2000000, "nueve días de mora");
  assert.equal(t.d90_mas, 4000000, "sólo el saldo, no el total");
  assert.equal(r.totalCOP, 7000000, "ni la pagada ni el borrador cuentan");
});

// --- proyección de caja --------------------------------------------------------

test("el trabajo de agosto entra en caja en octubre, y el dashboard lo dice", () => {
  const meses = cashProjection({
    today: "2026-09-01",
    from: "2026-08-01",
    to: "2027-01-31",
    invoices: [
      {
        status: "ISSUED", issueDate: "2026-09-01", expectedPaymentDate: "2026-10-01",
        currency: "COP", exchangeRate: null, total: 36176000, taxAmount: 5776000,
        withheldAmount: 2376064, netExpected: 33799936, paidAmount: 0, payments: [],
      },
    ],
  });
  const septiembre = meses.find((m) => m.mes === "2026-09");
  const octubre = meses.find((m) => m.mes === "2026-10");
  assert.equal(septiembre.facturadoCOP, 36176000, "se factura en septiembre");
  assert.equal(septiembre.cajaEsperadaCOP, 0, "pero no entra plata todavía");
  assert.equal(octubre.cajaEsperadaCOP, 33799936, "la plata llega en octubre");
  assert.equal(septiembre.ivaCOP, 5776000);
  assert.equal(septiembre.anticiposCOP, 2376064);
});

test("una factura vencida se espera este mes, no en el pasado", () => {
  const meses = cashProjection({
    today: "2026-08-29",
    from: "2026-06-01",
    to: "2026-12-31",
    invoices: [
      {
        status: "SENT", issueDate: "2026-06-01", expectedPaymentDate: "2026-07-01",
        currency: "COP", total: 5000000, taxAmount: 0, withheldAmount: 0,
        netExpected: 5000000, paidAmount: 0, payments: [],
      },
    ],
  });
  assert.equal(meses.find((m) => m.mes === "2026-07"), undefined, "no se proyecta hacia atrás");
  const agosto = meses.find((m) => m.mes === "2026-08");
  assert.equal(agosto.cajaEsperadaCOP, 5000000);
  assert.equal(agosto.vencidoCOP, 5000000, "y se marca que ya está vencida");
});

test("lo ya cobrado va al mes en que entró, con la TRM de ese día", () => {
  const meses = cashProjection({
    today: "2026-09-20",
    from: "2026-08-01", to: "2026-12-31",
    invoices: [
      {
        status: "PAID", issueDate: "2026-08-15", expectedPaymentDate: "2026-09-14",
        currency: "USD", exchangeRate: 4020, total: 18000, taxAmount: 0,
        withheldAmount: 0, netExpected: 18000, paidAmount: 18000,
        payments: [{ paymentDate: "2026-09-15", amount: 18000, amountCOP: 70020000 }],
      },
    ],
  });
  const septiembre = meses.find((m) => m.mes === "2026-09");
  assert.equal(septiembre.cajaRecibidaCOP, 70020000);
  assert.equal(septiembre.cajaEsperadaCOP, 0, "ya no se espera: ya entró");
});

test("borradores y anuladas no ensucian la proyección", () => {
  const meses = cashProjection({
    today: "2026-08-29", from: "2026-08-01", to: "2026-12-31",
    invoices: [
      { status: "DRAFT", issueDate: "2026-08-10", expectedPaymentDate: "2026-09-10", currency: "COP", total: 99, netExpected: 99, paidAmount: 0 },
      { status: "VOID", issueDate: "2026-08-10", expectedPaymentDate: "2026-09-10", currency: "COP", total: 99, netExpected: 99, paidAmount: 0 },
    ],
  });
  assert.equal(meses.length, 0);
});

// --- de dónde sale el plazo de pago -------------------------------------

test("el plazo del contrato le gana al del cliente", () => {
  const { resolvePaymentTerm } = require("../srv/lib/invoice-math");
  const r = resolvePaymentTerm({
    client: { paymentTermDays: 30 },
    contracts: [{ ID: "c1", paymentTermDays: 60 }],
  });
  assert.equal(r.days, 60);
  assert.equal(r.source, "CONTRACT");
  assert.equal(r.contractID, "c1");
});

test("un contrato sin plazo hereda el del cliente, no cae a contado", () => {
  const { resolvePaymentTerm } = require("../srv/lib/invoice-math");
  const r = resolvePaymentTerm({
    client: { paymentTermDays: 45 },
    contracts: [{ ID: "c1", paymentTermDays: null }],
  });
  assert.equal(r.days, 45);
  assert.equal(r.source, "CLIENT");
});

test("un contrato de contado sí significa cero días", () => {
  const { resolvePaymentTerm } = require("../srv/lib/invoice-math");
  const r = resolvePaymentTerm({
    client: { paymentTermDays: 30 },
    contracts: [{ ID: "c1", paymentTermDays: 0 }],
  });
  assert.equal(r.days, 0, "cero es un plazo, no un campo vacío");
  assert.equal(r.source, "CONTRACT");
});

test("si la factura mezcla contratos se usa el del cliente y se avisa", () => {
  const { resolvePaymentTerm } = require("../srv/lib/invoice-math");
  const r = resolvePaymentTerm({
    client: { paymentTermDays: 30 },
    contracts: [{ ID: "c1", paymentTermDays: 60 }, { ID: "c2", paymentTermDays: 90 }],
  });
  assert.equal(r.days, 30);
  assert.equal(r.mixed, true);
  assert.equal(r.contractID, null, "no se puede atribuir a un contrato");
});

test("sin cliente ni contrato el plazo por defecto son 30 días", () => {
  const { resolvePaymentTerm } = require("../srv/lib/invoice-math");
  const r = resolvePaymentTerm({ client: null, contracts: [] });
  assert.equal(r.days, 30);
  assert.equal(r.source, "DEFAULT");
});

test("si unos proyectos traen contrato y otros no, manda el plazo del cliente", () => {
  const { resolvePaymentTerm } = require("../srv/lib/invoice-math");
  const r = resolvePaymentTerm({
    client: { paymentTermDays: 30 },
    contracts: [{ ID: "c1", paymentTermDays: 60 }],
    mixed: true,
  });
  assert.equal(r.days, 30, "no se le puede aplicar a toda la factura el plazo de uno solo");
  assert.equal(r.mixed, true);
  assert.equal(r.contractID, null);
});
