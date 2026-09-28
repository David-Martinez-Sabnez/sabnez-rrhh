namespace sabnez.finance;

using { cuid, managed } from '@sap/cds/common';
using { sabnez.times } from './time-management';

/**
 * Lo que se factura y lo que efectivamente entra a la cuenta.
 *
 * Son dos cifras distintas y el modelo las separa a propósito, porque
 * entre una y otra hay tres cosas que se comen la diferencia:
 *
 *   IVA          se cobra pero no es ingreso: se le custodia a la DIAN
 *                hasta la declaración del bimestre.
 *   Retenciones  las practica el cliente al pagar. No son un gasto, son
 *                anticipo del impuesto de renta: vuelven, pero el año
 *                siguiente.
 *   Cambio       una factura en dólares se contabiliza a la TRM del día
 *                de emisión y se cobra a la del día del pago. La resta
 *                es diferencia en cambio, no un descuadre.
 *
 * Esta capa NO es contabilidad y no reemplaza a Siigo, que es donde vive
 * la factura electrónica ante la DIAN. Acá se proyecta y se controla.
 */

type EstadoFactura : String(20) enum {
  DRAFT          = 'DRAFT';           // armada desde los tiempos, sin emitir
  ISSUED         = 'ISSUED';          // ya tiene número en Siigo
  SENT           = 'SENT';            // enviada al cliente
  PARTIALLY_PAID = 'PARTIALLY_PAID';
  PAID           = 'PAID';
  VOID           = 'VOID';
};

type TipoRetencion : String(20) enum {
  RETEFUENTE = 'RETEFUENTE';
  RETEICA    = 'RETEICA';
  RETEIVA    = 'RETEIVA';
  OTRA       = 'OTRA';
};

/**
 * Sobre qué se calcula la retención. Retefuente y reteICA van sobre la
 * base gravable; reteIVA va sobre el impuesto, no sobre el servicio.
 */
type BaseRetencion : String(10) enum {
  SUBTOTAL = 'SUBTOTAL';
  TAX      = 'TAX';
};

type OrigenTasa : String(10) enum {
  BANREP = 'BANREP';
  MANUAL = 'MANUAL';
};

/**
 * Qué retenciones practica cada cliente y a qué tarifa.
 *
 * Va por cliente y no en una tabla global porque depende de si el cliente
 * es autorretenedor o gran contribuyente, del municipio donde se preste
 * el servicio y del año. Nada de esto está quemado en el código: son
 * datos que se corrigen sin tocar una línea.
 */
@assert.unique: { clientTypeFrom: [client, type, validFrom] }
entity ClientWithholdings : cuid, managed {
  client        : Association to times.Clients @mandatory;
  type          : TipoRetencion @mandatory;
  label         : String(80);
  // Porcentaje. Un 4 % se guarda como 4; el 9,66 por mil de ICA en Bogotá
  // se guarda como 0,966. Cuatro decimales porque el ICA municipal los usa.
  rate          : Decimal(7, 4) @mandatory;
  base          : BaseRetencion @mandatory default 'SUBTOTAL';
  // Cuantía mínima por debajo de la cual no se practica (las 2 UVT de
  // retefuente por servicios, por ejemplo).
  minimumBase   : Decimal(19, 2) default 0;
  validFrom     : Date @mandatory;
  validTo       : Date;
  active        : Boolean default true;
  notes         : String(500);
}

/**
 * TRM diaria. La oficial la publica la Superintendencia Financiera y se
 * sincroniza sola; si el entorno no puede salir a internet se digita y
 * queda marcada como MANUAL para que se sepa de dónde salió el número.
 */
@assert.unique: { currencyFrom: [currency, validFrom] }
entity ExchangeRates : cuid, managed {
  currency   : String(3) @mandatory default 'USD';
  validFrom  : Date @mandatory;
  validTo    : Date;
  // Pesos por una unidad de la moneda.
  rate       : Decimal(19, 6) @mandatory;
  source     : OrigenTasa @mandatory default 'BANREP';
  capturedAt : Timestamp;
}

entity Invoices : cuid, managed {
  client              : Association to times.Clients @mandatory;
  contract            : Association to times.ClientContracts;
  // El número que le puso Siigo. Vacío mientras es borrador.
  number              : String(40);
  externalReference   : String(120);
  status              : EstadoFactura default 'DRAFT';
  currency            : String(3) @mandatory default 'COP';
  issueDate           : Date;
  periodStart         : Date;
  periodEnd           : Date;

  // El plazo se congela al emitir: si mañana se renegocia con el cliente,
  // las facturas viejas no pueden cambiar de fecha de cobro.
  paymentTermDays     : Integer;
  expectedPaymentDate : Date;

  // Exportación de servicios: excluida de IVA y sin retenciones
  // colombianas, porque quien paga está fuera del país.
  exportOfServices    : Boolean default false;

  // --- importes en la moneda de la factura ---
  subtotal            : Decimal(19, 2) default 0;
  taxRate             : Decimal(5, 2)  default 19;
  taxAmount           : Decimal(19, 2) default 0;
  total               : Decimal(19, 2) default 0;
  withheldAmount      : Decimal(19, 2) default 0;
  // Lo que se espera que consignen: total menos lo que retiene el cliente.
  netExpected         : Decimal(19, 2) default 0;

  // --- equivalente en pesos, a la TRM del día de emisión ---
  exchangeRate        : Decimal(19, 6);
  totalCOP            : Decimal(19, 2);
  netExpectedCOP      : Decimal(19, 2);

  // --- lo que realmente entró ---
  paidAmount          : Decimal(19, 2) default 0;
  paidAmountCOP       : Decimal(19, 2) default 0;
  // Positiva si el dólar subió entre emisión y cobro, negativa si cayó.
  fxDifferenceCOP     : Decimal(19, 2) default 0;

  notes               : String(1000);
  voidedAt            : Timestamp;
  voidReason          : String(500);

  lines               : Composition of many InvoiceLines        on lines.invoice = $self;
  withholdings        : Composition of many InvoiceWithholdings on withholdings.invoice = $self;
  payments            : Composition of many InvoicePayments     on payments.invoice = $self;
}

entity InvoiceLines : cuid, managed {
  invoice       : Association to Invoices @mandatory;
  project       : Association to times.Projects;
  billingPeriod : Association to times.BillingPeriods;
  position      : Integer default 10;
  description   : String(500) @mandatory;
  // Horas facturables del periodo, o 1 cuando es una mensualidad.
  quantity      : Decimal(11, 2) default 1;
  unitPrice     : Decimal(19, 2) default 0;
  amount        : Decimal(19, 2) default 0;
  taxable       : Boolean default true;
}

/**
 * Cada retención con su base y su tarifa, congeladas. El certificado de
 * retención que expide el cliente se cruza contra esto, y al cierre del
 * año la suma es el anticipo de renta que se puede descontar.
 */
entity InvoiceWithholdings : cuid, managed {
  invoice : Association to Invoices @mandatory;
  type    : TipoRetencion @mandatory;
  label   : String(80);
  base    : Decimal(19, 2) default 0;
  rate    : Decimal(7, 4)  default 0;
  amount  : Decimal(19, 2) default 0;
}

entity InvoicePayments : cuid, managed {
  invoice         : Association to Invoices @mandatory;
  paymentDate     : Date @mandatory;
  // En la moneda de la factura.
  amount          : Decimal(19, 2) @mandatory;
  exchangeRate    : Decimal(19, 6);
  amountCOP       : Decimal(19, 2);
  // Lo que se ganó o se perdió porque la TRM del cobro no es la de la
  // emisión. Es un gasto financiero real, no un error de digitación.
  fxDifferenceCOP : Decimal(19, 2) default 0;
  reference       : String(80);
  notes           : String(500);
}

/**
 * El puente con los tiempos.
 *
 * Un registro que ya entró en una factura no puede volver a entrar en
 * otra. Sin esta marca, generar dos veces el borrador del mismo periodo
 * duplicaría el ingreso sin que nada avisara.
 */
extend times.TimeEntries with {
  invoice : Association to Invoices;
}
