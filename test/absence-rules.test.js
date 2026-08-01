"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const {
  ESTADOS_CONSUMO_AUSENCIA,
  ESTADOS_RESERVA_AUSENCIA,
  ESTADOS_RESERVA_CUMPLEANIOS,
  ESTADOS_UTILIZACION_AUSENCIA,
  ESTADOS_UTILIZACION_CUMPLEANIOS,
  calcularDiasAnticipacion,
  calcularDiasHabilesColombia,
  calcularHorasSolicitadas,
  fechasSeCruzan,
  horasSeCruzan,
  isValidISODate,
  normalizarHora,
  obtenerCumpleaniosEnAnio,
  obtenerFinSemanaISO,
  obtenerInicioSemanaISO,
  obtenerOcurrenciaCumpleaniosParaFecha,
  obtenerProximaVentanaCumpleanios,
  obtenerVentanaCumpleaniosAnioActual,
  obtenerVentanaCumpleanios,
  tieneSegundos,
} = require("../srv/lib/absence-rules");

function cargarTiposAusencia() {
  const csv = readFileSync(
    join(__dirname, "../db/data/sabnez.rrhh-TiposAusencia.csv"),
    "utf8",
  ).trim();
  const [header, ...rows] = csv.split(/\r?\n/).map((line) => line.split(";"));

  return rows.map((row) =>
    Object.fromEntries(header.map((column, index) => [column, row[index]])),
  );
}

test("calcula dias habiles excluyendo fines de semana y festivos colombianos", () => {
  // El 1 de mayo de 2025 fue jueves y es festivo fijo en Colombia.
  assert.equal(calcularDiasHabilesColombia("2025-04-30", "2025-05-04"), 2);
  assert.equal(calcularDiasHabilesColombia("2025-05-01", "2025-05-01"), 0);
  assert.equal(calcularDiasHabilesColombia("2025-05-03", "2025-05-04"), 0);
});

test("calcula horas validas y rechaza rangos invalidos", () => {
  assert.equal(calcularHorasSolicitadas("08:00", "12:00"), 4);
  assert.equal(calcularHorasSolicitadas("08:15:00", "12:45:00"), 4.5);
  assert.equal(calcularHorasSolicitadas("12:00", "08:00"), -1);
  assert.equal(calcularHorasSolicitadas("08:00", "08:00"), -1);
  assert.equal(calcularHorasSolicitadas("24:00", "25:00"), -1);
  assert.equal(calcularHorasSolicitadas("hora-invalida", "12:00"), -1);
});

test("distingue exactamente cuatro horas de duraciones inferiores o superiores", () => {
  assert.equal(calcularHorasSolicitadas("08:00", "12:00"), 4);
  assert.notEqual(calcularHorasSolicitadas("08:00", "11:59"), 4);
  assert.notEqual(calcularHorasSolicitadas("08:00", "12:01"), 4);
  assert.equal(calcularHorasSolicitadas("08:00", "11:59"), 3.98);
  assert.equal(calcularHorasSolicitadas("08:00", "12:01"), 4.02);
});

test("detecta segundos no nulos y solo normaliza horas con precision de minuto", () => {
  assert.equal(tieneSegundos("08:30:01"), true);
  assert.equal(tieneSegundos("08:30:00"), false);
  assert.equal(tieneSegundos("08:30"), false);
  assert.equal(normalizarHora("08:30"), "08:30:00");
  assert.equal(normalizarHora("08:30:00"), "08:30:00");
  assert.equal(normalizarHora("08:30:01"), null);
  assert.equal(normalizarHora("25:00:00"), null);
});

test("calcula anticipacion en dias calendario y habiles", () => {
  assert.equal(
    calcularDiasAnticipacion("2025-04-30", "2025-05-02", "CALENDARIO"),
    2,
  );
  assert.equal(
    calcularDiasAnticipacion("2025-04-30", "2025-05-02", "HABILES"),
    1,
  );
  assert.equal(
    calcularDiasAnticipacion("2025-05-02", "2025-05-05", "CALENDARIO"),
    3,
  );
  assert.equal(
    calcularDiasAnticipacion("2025-05-02", "2025-05-05", "HABILES"),
    1,
  );
  assert.equal(
    calcularDiasAnticipacion("2025-05-05", "2025-05-05", "HABILES"),
    0,
  );
});

test("distingue intervalos de fechas separados de intervalos cruzados", () => {
  assert.equal(
    fechasSeCruzan("2025-07-01", "2025-07-02", "2025-07-03", "2025-07-04"),
    false,
  );
  assert.equal(
    fechasSeCruzan("2025-07-01", "2025-07-03", "2025-07-03", "2025-07-04"),
    true,
  );
  assert.equal(
    fechasSeCruzan("2025-07-01", "2025-07-05", "2025-07-02", "2025-07-03"),
    true,
  );
});

test("permite rangos horarios contiguos y detecta rangos horarios cruzados", () => {
  assert.equal(horasSeCruzan("08:00", "10:00", "10:00", "12:00"), false);
  assert.equal(horasSeCruzan("08:00", "10:00", "09:59", "12:00"), true);
  assert.equal(horasSeCruzan("08:00", "12:00", "09:00", "10:00"), true);
  assert.equal(horasSeCruzan("hora-invalida", "12:00", "13:00", "14:00"), true);
});

test("obtiene la semana ISO completa de lunes a domingo", () => {
  assert.equal(obtenerInicioSemanaISO("2025-07-23"), "2025-07-21");
  assert.equal(obtenerFinSemanaISO("2025-07-23"), "2025-07-27");
  assert.equal(obtenerInicioSemanaISO("2025-12-31"), "2025-12-29");
  assert.equal(obtenerFinSemanaISO("2025-12-31"), "2026-01-04");
  assert.equal(obtenerInicioSemanaISO("fecha-invalida"), null);
  assert.equal(obtenerFinSemanaISO("fecha-invalida"), null);
});

test("rechaza fechas inexistentes antes de calcular rangos", () => {
  assert.equal(isValidISODate("2025-02-29"), false);
  assert.equal(isValidISODate("2024-02-29"), true);
  assert.equal(isValidISODate("2025-13-01"), false);
  assert.equal(isValidISODate("2025-01-32"), false);
  assert.equal(obtenerInicioSemanaISO("2025-02-29"), null);
  assert.equal(obtenerOcurrenciaCumpleaniosParaFecha("fecha-invalida", "2026-07-23"), null);
});

test("calcula una ventana de cumpleanios normal y reconoce sus limites", () => {
  assert.deepEqual(obtenerVentanaCumpleanios("1990-07-23", 2026), {
    anioOcurrencia: 2026,
    fechaCumpleanios: "2026-07-23",
    semanaInicio: "2026-07-20",
    semanaFin: "2026-07-26",
  });

  assert.equal(
    obtenerOcurrenciaCumpleaniosParaFecha("1990-07-23", "2026-07-20")
      .anioOcurrencia,
    2026,
  );
  assert.equal(
    obtenerOcurrenciaCumpleaniosParaFecha("1990-07-23", "2026-07-26")
      .anioOcurrencia,
    2026,
  );
  assert.equal(
    obtenerOcurrenciaCumpleaniosParaFecha("1990-07-23", "2026-07-27"),
    null,
  );
});

test("atribuye correctamente una semana de cumpleanios que cruza de anio", () => {
  const expectedWindow = {
    anioOcurrencia: 2025,
    fechaCumpleanios: "2025-12-31",
    semanaInicio: "2025-12-29",
    semanaFin: "2026-01-04",
  };

  assert.deepEqual(obtenerVentanaCumpleanios("1990-12-31", 2025), expectedWindow);
  assert.deepEqual(
    obtenerOcurrenciaCumpleaniosParaFecha("1990-12-31", "2026-01-03"),
    expectedWindow,
  );
});

test("atribuye al nuevo anio una semana de cumpleanios iniciada en diciembre", () => {
  const expectedWindow = {
    anioOcurrencia: 2026,
    fechaCumpleanios: "2026-01-01",
    semanaInicio: "2025-12-29",
    semanaFin: "2026-01-04",
  };

  assert.deepEqual(obtenerVentanaCumpleanios("1990-01-01", 2026), expectedWindow);
  assert.deepEqual(
    obtenerOcurrenciaCumpleaniosParaFecha("1990-01-01", "2025-12-29"),
    expectedWindow,
  );
  assert.deepEqual(
    obtenerOcurrenciaCumpleaniosParaFecha("1990-01-01", "2026-01-04"),
    expectedWindow,
  );
  assert.equal(
    obtenerOcurrenciaCumpleaniosParaFecha("1990-01-01", "2025-12-28"),
    null,
  );
  assert.equal(
    obtenerOcurrenciaCumpleaniosParaFecha("1990-01-01", "2026-01-05"),
    null,
  );
});

test("usa el 28 de febrero para nacidos el 29 en un anio no bisiesto", () => {
  assert.equal(obtenerCumpleaniosEnAnio("1992-02-29", 2025), "2025-02-28");
  assert.deepEqual(obtenerVentanaCumpleanios("1992-02-29", 2025), {
    anioOcurrencia: 2025,
    fechaCumpleanios: "2025-02-28",
    semanaInicio: "2025-02-24",
    semanaFin: "2025-03-02",
  });
  assert.equal(obtenerCumpleaniosEnAnio("1992-02-29", 2024), "2024-02-29");
});

test("obtiene la ventana de cumpleanios vigente o la siguiente", () => {
  assert.deepEqual(obtenerProximaVentanaCumpleanios("1990-07-23", "2026-07-01"), {
    anioOcurrencia: 2026,
    fechaCumpleanios: "2026-07-23",
    semanaInicio: "2026-07-20",
    semanaFin: "2026-07-26",
  });
  assert.deepEqual(obtenerProximaVentanaCumpleanios("1990-07-23", "2026-07-24"), {
    anioOcurrencia: 2026,
    fechaCumpleanios: "2026-07-23",
    semanaInicio: "2026-07-20",
    semanaFin: "2026-07-26",
  });
  assert.deepEqual(obtenerProximaVentanaCumpleanios("1990-07-23", "2026-07-27"), {
    anioOcurrencia: 2027,
    fechaCumpleanios: "2027-07-23",
    semanaInicio: "2027-07-19",
    semanaFin: "2027-07-25",
  });
});

test("mantiene el saldo de cumpleaños en el año actual aunque la semana ya haya pasado", () => {
  assert.deepEqual(
    obtenerVentanaCumpleaniosAnioActual("1990-01-12", "2026-07-31"),
    obtenerVentanaCumpleanios("1990-01-12", 2026),
  );
  assert.equal(
    obtenerProximaVentanaCumpleanios("1990-01-12", "2026-07-31")
      .anioOcurrencia,
    2027,
  );
});

test("considera vigente en enero una ventana iniciada en diciembre", () => {
  assert.deepEqual(obtenerProximaVentanaCumpleanios("1990-12-31", "2026-01-02"), {
    anioOcurrencia: 2025,
    fechaCumpleanios: "2025-12-31",
    semanaInicio: "2025-12-29",
    semanaFin: "2026-01-04",
  });
});

test("solo los estados vigentes reservan y solo los consumidos afectan el saldo", () => {
  assert.deepEqual(
    [...ESTADOS_RESERVA_AUSENCIA].sort(),
    ["APROBADA", "SOLICITADA"],
  );
  assert.deepEqual(
    [...ESTADOS_UTILIZACION_AUSENCIA].sort(),
    ["FINALIZADA"],
  );
  assert.deepEqual(
    [...ESTADOS_RESERVA_CUMPLEANIOS].sort(),
    ["SOLICITADA"],
  );
  assert.deepEqual(
    [...ESTADOS_UTILIZACION_CUMPLEANIOS].sort(),
    ["APROBADA", "FINALIZADA"],
  );
  assert.deepEqual(
    [...ESTADOS_CONSUMO_AUSENCIA].sort(),
    ["APROBADA", "FINALIZADA", "SOLICITADA"],
  );

  for (const estado of ["BORRADOR", "RECHAZADA", "CANCELADA"]) {
    assert.equal(ESTADOS_RESERVA_AUSENCIA.has(estado), false);
    assert.equal(ESTADOS_CONSUMO_AUSENCIA.has(estado), false);
  }
  assert.equal(ESTADOS_RESERVA_AUSENCIA.has("FINALIZADA"), false);
  assert.equal(ESTADOS_RESERVA_CUMPLEANIOS.has("APROBADA"), false);
});

test("configura cumpleaños como beneficio distinto de Valera y limitado a cuatro horas", () => {
  const tipos = cargarTiposAusencia();
  const cumpleanios = tipos.find(({ codigo }) => codigo === "CU");
  const valera = tipos.find(({ codigo }) => codigo === "VE");

  assert.ok(cumpleanios, "Debe existir el tipo de ausencia CU");
  assert.ok(valera, "Debe mantenerse el tipo de ausencia VE");
  assert.notEqual(cumpleanios.codigo, valera.codigo);
  assert.deepEqual(
    {
      unidadConsumo: cumpleanios.unidadConsumo,
      controlaSaldoHoras: cumpleanios.controlaSaldoHoras,
      horasAnuales: cumpleanios.horasAnuales,
      minimoHorasSolicitud: cumpleanios.minimoHorasSolicitud,
      maximoHorasDia: cumpleanios.maximoHorasDia,
      maximoHorasSemana: cumpleanios.maximoHorasSemana,
      maximoSolicitudesSemana: cumpleanios.maximoSolicitudesSemana,
      requiereMismoDia: cumpleanios.requiereMismoDia,
      permiteCruzarAnio: cumpleanios.permiteCruzarAnio,
      politicaFecha: cumpleanios.politicaFecha,
      requiereContratoVigente: cumpleanios.requiereContratoVigente,
    },
    {
      unidadConsumo: "HORAS",
      controlaSaldoHoras: "true",
      horasAnuales: "4",
      minimoHorasSolicitud: "4",
      maximoHorasDia: "4",
      maximoHorasSemana: "4",
      maximoSolicitudesSemana: "1",
      requiereMismoDia: "true",
      permiteCruzarAnio: "false",
      politicaFecha: "SEMANA_CUMPLEANOS",
      requiereContratoVigente: "true",
    },
  );
});

test("configura votación como permiso remunerado de exactamente cuatro horas", () => {
  const votacion = cargarTiposAusencia().find(({ codigo }) => codigo === "VO");

  assert.ok(votacion, "Debe existir el tipo de ausencia VO");
  assert.deepEqual(
    {
      remunerada: votacion.remunerada,
      unidadConsumo: votacion.unidadConsumo,
      controlaSaldoHoras: votacion.controlaSaldoHoras,
      minimoHorasSolicitud: votacion.minimoHorasSolicitud,
      maximoHorasDia: votacion.maximoHorasDia,
      requiereMismoDia: votacion.requiereMismoDia,
    },
    {
      remunerada: "true",
      unidadConsumo: "HORAS",
      controlaSaldoHoras: "false",
      minimoHorasSolicitud: "4",
      maximoHorasDia: "4",
      requiereMismoDia: "true",
    },
  );
});
