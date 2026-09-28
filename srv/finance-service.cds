using { sabnez.finance as fin } from '../db/finance';
using { sabnez.times as times } from '../db/time-management';

/**
 * Control financiero: lo que se va a facturar, lo que se facturó y lo
 * que realmente va a entrar a la cuenta, mes a mes.
 *
 * No es contabilidad y no reemplaza a Siigo, que es donde vive la
 * factura electrónica ante la DIAN. Acá la factura es un espejo para
 * proyectar caja y medir margen.
 */
service FinanceService @(
  path    : '/finanzas',
  requires: 'TimeFinance'
) {
  type ResultadoFactura {
    exito       : Boolean;
    mensaje     : String(500);
    facturaID   : UUID;
    numero      : String(40);
    total       : Decimal(19, 2);
    netoEsperado: Decimal(19, 2);
    lineas      : Integer;
    registros   : Integer;
  }

  type ConceptoFacturable {
    clave          : String(500);
    registroIDs    : many UUID;
    assignmentID   : UUID;
    projectID      : UUID;
    proyecto       : String(220);
    recurso        : String(240);
    concepto       : String(500);
    periodoDesde   : Date;
    periodoHasta   : Date;
    horas          : Decimal(11, 2);
    valorEstimado  : Decimal(19, 2);
    moneda         : String(3);
    registros      : Integer;
    seleccionable  : Boolean;
    validacion     : String(500);
  }

  type ResultadoTRM {
    exito         : Boolean;
    mensaje       : String(500);
    tasasCargadas : Integer;
    ultimaFecha   : Date;
    ultimoValor   : Decimal(19, 6);
  }

  type TasaVigente {
    moneda   : String(3);
    fecha    : Date;
    valor    : Decimal(19, 6);
    exacta   : Boolean;
    origen   : String(10);
    vigenciaDesde : Date;
  }

  type MesFinanciero {
    mes                : String(7);
    devengadoCOP       : Decimal(19, 2);
    costoCOP           : Decimal(19, 2);
    margenCOP          : Decimal(19, 2);
    facturadoCOP       : Decimal(19, 2);
    cajaEsperadaCOP    : Decimal(19, 2);
    cajaRecibidaCOP    : Decimal(19, 2);
    ivaCOP             : Decimal(19, 2);
    anticiposCOP       : Decimal(19, 2);
    vencidoCOP         : Decimal(19, 2);
    horasFacturables   : Decimal(11, 2);
    horasPorCompensar  : Decimal(11, 2);
  }

  type SaldoCompensatorio {
    empleadoID       : UUID;
    nombre           : String(200);
    ganadas          : Decimal(9, 2);
    tomadas          : Decimal(9, 2);
    saldo            : Decimal(9, 2);
    ultimoMovimiento : Date;
    // Lo que costaría pagarlas si en vez de tiempo se compensara en plata.
    costoEstimadoCOP : Decimal(19, 2);
  }

  type ResultadoCompensatorios {
    exito             : Boolean;
    mensaje           : String(500);
    movimientosNuevos : Integer;
    horasPorPagar     : Decimal(9, 2);
    personas          : Integer;
  }

  type TramoCartera {
    clave    : String(20);
    etiqueta : String(40);
    montoCOP : Decimal(19, 2);
    facturas : Integer;
  }

  type AvisoTablero {
    tipo    : String(20);
    mensaje : String(500);
  }

  type TableroFinanciero {
    desde                  : Date;
    hasta                  : Date;
    meses                  : many MesFinanciero;
    cartera                : many TramoCartera;
    carteraTotalCOP        : Decimal(19, 2);
    // Lo cobrado menos el IVA que hay que girarle a la DIAN. Es el número
    // que de verdad se puede gastar.
    disponibleCOP          : Decimal(19, 2);
    cajaRecibidaCOP        : Decimal(19, 2);
    ivaPorDeclararCOP      : Decimal(19, 2);
    // Retefuente y reteICA acumulados: no son gasto, son anticipo de
    // renta y se descuentan en la declaración del año siguiente.
    anticiposRentaCOP      : Decimal(19, 2);
    diferenciaCambioCOP    : Decimal(19, 2);
    // Horas que el equipo trabajó, no se le cobraron al cliente y siguen
    // debiéndosele. Es costo sin ingreso y tiene que verse.
    compensatorioHoras     : Decimal(9, 2);
    compensatorioCostoCOP  : Decimal(19, 2);
    avisos                 : many AvisoTablero;
  }

  entity Facturas            as projection on fin.Invoices;
  entity LineasFactura       as projection on fin.InvoiceLines;
  entity RetencionesFactura  as projection on fin.InvoiceWithholdings;
  entity Recaudos            as projection on fin.InvoicePayments;
  entity PerfilRetenciones   as projection on fin.ClientWithholdings;
  entity TasasCambio         as projection on fin.ExchangeRates;

  @readonly
  entity LibroCompensatorios as projection on times.CompensatoryLedger;

  @readonly
  entity Clientes as select from times.Clients {
    key ID, legalName, tradeName, taxIdentification, countryCode,
        defaultCurrency, paymentTermDays, status
  };

  @readonly
  entity Proyectos as select from times.Projects {
    key ID, client, code, name, modality, currency, status
  };

  // Arma el borrador con las horas aprobadas que todavía no han entrado
  // en ninguna factura. No emite nada: eso se hace en Siigo.
  action generarFacturaBorrador(
    clienteID    : UUID,
    periodoDesde : Date,
    periodoHasta : Date,
    proyectoIDs  : many UUID,
    registroIDs  : many UUID,
    moneda       : String(3)
  ) returns ResultadoFactura;

  // Permite revisar y escoger los conceptos antes de reservar las horas
  // dentro de un borrador de factura.
  action obtenerConceptosFacturables(
    clienteID    : UUID,
    periodoDesde : Date,
    periodoHasta : Date,
    moneda       : String(3)
  ) returns many ConceptoFacturable;

  // Se emitió en Siigo y vuelve con su número. Acá se congela el plazo,
  // la TRM del día y la fecha esperada de recaudo.
  action emitirFactura(
    facturaID         : UUID,
    numero            : String(40),
    fechaEmision      : Date,
    referenciaExterna : String(120)
  ) returns ResultadoFactura;

  action registrarRecaudo(
    facturaID  : UUID,
    fecha      : Date,
    monto      : Decimal(19, 2),
    tasaCambio : Decimal(19, 6),
    referencia : String(80),
    notas      : String(500)
  ) returns ResultadoFactura;

  action anularFactura(facturaID: UUID, motivo: String(500)) returns ResultadoFactura;

  // Un borrador todavía no es una factura emitida y puede retirarse sin
  // dejar ruido en el histórico. Al eliminarlo se liberan sus tiempos.
  action eliminarFacturaBorrador(facturaID: UUID) returns ResultadoFactura;
  action recalcularFactura(facturaID: UUID) returns ResultadoFactura;

  action sincronizarTRM(desde: Date) returns ResultadoTRM;
  action registrarTRMManual(fecha: Date, valor: Decimal(19, 6), moneda: String(3)) returns ResultadoTRM;
  action obtenerTRM(fecha: Date, moneda: String(3)) returns TasaVigente;

  // Rehace el libro de compensatorios a partir de los registros de
  // tiempo y de las ausencias ya aprobadas. Es idempotente: correrlo dos
  // veces no le duplica el saldo a nadie.
  action recalcularCompensatorios(desde: Date, hasta: Date) returns ResultadoCompensatorios;

  action obtenerSaldosCompensatorios() returns many SaldoCompensatorio;

  action obtenerTableroFinanciero(desde: Date, hasta: Date) returns TableroFinanciero;
}
