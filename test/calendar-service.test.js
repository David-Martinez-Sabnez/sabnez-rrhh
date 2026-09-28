"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const cds = require("@sap/cds");

const ROOT = require("node:path").join(__dirname, "..");
const { SELECT } = cds.ql;
let service;

test.before(async () => {
  cds.root = ROOT;
  const model = await cds.load(["db", "srv/calendar-service.cds"], { root: ROOT });
  await cds.deploy(model).to("sqlite::memory:");
  cds.model = cds.linked(cds.compile.for.nodejs(model));
  service = await cds.serve("CalendarService").from(cds.model);
});

test("sincroniza el calendario seleccionado y persiste los festivos", async () => {
  const ID = "2c3d8bf1-8b28-4a7b-83dd-64db8d640002";
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => [{
      date: "2026-08-15", name: "Asunción de la Virgen", countryCode: "CL",
      global: true, counties: null, types: ["Public"],
    }],
  });

  try {
    const result = await service.tx({ user: new cds.User.Privileged() }, (tx) => tx.send({
      event: "sincronizarFestivos",
      entity: "Calendarios",
      params: [{ ID }],
      data: { anio: 2026 },
    }));
    assert.equal(result.exito, true);
    assert.equal(result.creados, 1);
    const holidays = await SELECT.from("sabnez.calendars.Holidays").where({ calendar_ID: ID });
    assert.equal(holidays.length, 1);
    assert.equal(holidays[0].date, "2026-08-15");
    assert.equal(holidays[0].year, "2026");

    const second = await service.tx({ user: new cds.User.Privileged() }, (tx) => tx.send({
      event: "sincronizarFestivos",
      entity: "Calendarios",
      params: [{ ID }],
      data: { anio: 2026 },
    }));
    assert.equal(second.creados, 0);
    assert.equal(second.actualizados, 1);
    const afterSecondSync = await SELECT.from("sabnez.calendars.Holidays").where({ calendar_ID: ID });
    assert.equal(afterSecondSync.length, 1, "sincronizar dos veces no duplica festivos");
  } finally {
    global.fetch = originalFetch;
  }
});

test("conserva dos festivos distintos que coinciden en la misma fecha", async () => {
  const ID = "2c3d8bf1-8b28-4a7b-83dd-64db8d640001";
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => [
      { date: "2026-05-10", localName: "Día de las Madres", countryCode: "CO", global: true, types: ["Public"] },
      { date: "2026-05-10", localName: "Día del Padre", countryCode: "CO", global: true, types: ["Public"] },
    ],
  });

  try {
    const result = await service.tx({ user: new cds.User.Privileged() }, (tx) => tx.send({
      event: "sincronizarFestivos",
      entity: "Calendarios",
      params: [{ ID }],
      data: { anio: 2026 },
    }));
    assert.equal(result.creados, 2);
    const holidays = await SELECT.from("sabnez.calendars.Holidays").where({ calendar_ID: ID });
    assert.equal(holidays.length, 2);
    assert.deepEqual(holidays.map((row) => row.name).sort(), ["Día de las Madres", "Día del Padre"].sort());
  } finally {
    global.fetch = originalFetch;
  }
});
