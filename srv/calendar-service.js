"use strict";

const cds = require("@sap/cds");
const { fetchPublicHolidays } = require("./lib/holiday-provider");

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

const normalizedRegions = (value) => String(value || "")
  .split(",")
  .map((region) => region.trim().toUpperCase())
  .filter(Boolean)
  .sort()
  .join(",");

module.exports = cds.service.impl(function () {
  const { Calendarios, Festivos, Paises } = this.entities;

  this.before(["CREATE", "UPDATE"], Calendarios, async (req) => {
    if (req.data.countryCode) req.data.countryCode = String(req.data.countryCode).trim().toUpperCase();
    if (req.data.countryCode) {
      const country = await SELECT.one.from(Paises).where({ code: req.data.countryCode });
      if (!country) return req.reject(400, "Selecciona un país válido.", "countryCode");
      req.data.code = `${country.code}-GENERAL`;
      req.data.name = `${country.name} - Jornada general`;
      req.data.subdivisionCode = null;
    }
    if (req.data.hoursPerDay != null && Number(req.data.hoursPerDay) <= 0)
      req.reject(400, "Las horas por jornada deben ser mayores que cero.", "hoursPerDay");
  });

  this.before(["CREATE", "UPDATE"], Festivos, (req) => {
    if (req.data.date) req.data.year = String(req.data.date).slice(0, 4);
  });

  this.on("sincronizarFestivos", Calendarios, async (req) => {
    const calendarID = req.params?.[0]?.ID;
    const year = Number(req.data?.anio);
    if (!calendarID) return req.reject(400, "Selecciona un calendario para sincronizar.");
    if (!Number.isInteger(year) || year < 2000 || year > 2100)
      return req.reject(400, "Indica un año entre 2000 y 2100.", "anio");

    const calendar = await SELECT.one.from(Calendarios).where({ ID: calendarID });
    if (!calendar) return req.reject(404, "El calendario no existe o todavía es un borrador.");

    let imported;
    try {
      imported = await fetchPublicHolidays({
        countryCode: calendar.countryCode,
        year,
        subdivisionCode: calendar.subdivisionCode,
      });
    } catch (error) {
      // CAP oculta por seguridad el detalle de los errores 5xx en producción.
      // Un 422 permite que Fiori muestre al administrador una causa accionable.
      return req.reject(422, `No fue posible sincronizar los festivos: ${error.message}`);
    }

    const existing = await SELECT.from(Festivos).where({ calendar_ID: calendarID });
    const importedForYear = existing.filter((row) =>
      row.source === "NAGER" && String(row.date || "").startsWith(`${year}-`));
    const receivedKeys = new Set();
    let created = 0;
    let updated = 0;
    let deactivated = 0;

    for (const holiday of imported) {
      receivedKeys.add(holiday.externalKey);
      const sameDateAndRegions = importedForYear.filter((row) =>
        row.date === holiday.date
        && normalizedRegions(row.subdivisionCodes) === normalizedRegions(holiday.subdivisionCodes));
      const legacyKey = [
        holiday.countryCode,
        holiday.date,
        normalizedRegions(holiday.subdivisionCodes),
      ].join("|");
      const exactCandidates = sameDateAndRegions.filter((row) =>
        row.externalKey === holiday.externalKey);
      const current = exactCandidates[0]
        || sameDateAndRegions.find((row) => row.externalKey === legacyKey);
      for (const duplicate of exactCandidates.slice(1)) {
        if (!duplicate.manualOverride)
          await DELETE.from(Festivos).where({ ID: duplicate.ID });
      }
      const values = {
        date: holiday.date,
        year: String(year),
        name: holiday.name,
        countryCode: holiday.countryCode,
        subdivisionCodes: holiday.subdivisionCodes.join(","),
        nationalHoliday: holiday.nationalHoliday,
        holidayType: holiday.holidayType,
        source: "NAGER",
        externalKey: holiday.externalKey,
        active: true,
      };
      if (!current) {
        const ID = cds.utils.uuid();
        await INSERT.into(Festivos).entries({ ID, calendar_ID: calendarID, ...values });
        importedForYear.push({ ID, calendar_ID: calendarID, manualOverride: false, ...values });
        created += 1;
      } else if (!current.manualOverride) {
        await UPDATE(Festivos).set(values).where({ ID: current.ID });
        Object.assign(current, values);
        updated += 1;
      }
    }

    for (const current of importedForYear) {
      if (!current.manualOverride && !receivedKeys.has(current.externalKey) && current.active) {
        await UPDATE(Festivos).set({ active: false }).where({ ID: current.ID });
        deactivated += 1;
      }
    }

    const syncedAt = new Date().toISOString();
    await UPDATE(Calendarios).set({
      lastSyncedYear: String(year),
      lastSyncedAt: syncedAt,
      lastSyncCount: imported.length,
    }).where({ ID: calendarID });

    const message = `${imported.length} festivo(s) públicos sincronizados para ${calendar.name} en ${year}.`;
    req.notify(message);

    return {
      exito: true,
      pais: calendar.countryCode,
      anio: year,
      recibidos: imported.length,
      creados: created,
      actualizados: updated,
      desactivados: deactivated,
      mensaje: message,
    };
  });
});
