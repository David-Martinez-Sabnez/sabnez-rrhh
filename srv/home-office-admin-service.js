const cds = require("@sap/cds");

const { SELECT } = cds.ql;

module.exports = class HomeOfficeAdminService extends cds.ApplicationService {
  async init() {
    const db = await cds.connect.to("db");

    const { Empleados, SeleccionesHomeOffice } = cds.entities("sabnez.rrhh");

    const { Anios, Semanas, ReporteHomeOffice } = this.entities;

    this.on("READ", Anios, (req) => {
      const iCurrentYear = new Date().getUTCFullYear();
      const iStartYear = 2026;
      const aRows = [];

      for (let iYear = iStartYear; iYear <= iCurrentYear + 3; iYear += 1) {
        aRows.push({
          anio: String(iYear),
        });
      }

      return this._applyQueryOptions(aRows, req.query.SELECT);
    });

    this.on("READ", Semanas, (req) => {
      const aYears = this._extractFilterValues(req.query.SELECT.where, "anio")
        .map(Number)
        .filter(Number.isInteger);

      const iYear = aYears[0] || new Date().getUTCFullYear();

      const iWeeks = this._getWeeksInIsoYear(iYear);

      const aRows = Array.from({ length: iWeeks }, (_, iIndex) => {
        const iWeek = iIndex + 1;
        const oWeek = this._buildWeek(iYear, iWeek);

        return {
          anio: String(iYear),
          numeroSemana: iWeek,
          fechaInicio: oWeek.fechaInicio,
          fechaFin: oWeek.fechaFin,
          descripcion: oWeek.descripcion,
        };
      });

      return this._applyQueryOptions(aRows, req.query.SELECT);
    });

    this.on("READ", ReporteHomeOffice, async (req) => {
      const aYears = this._extractFilterValues(req.query.SELECT.where, "anio")
        .map(Number)
        .filter(Number.isInteger);

      const aWeekNumbers = this._extractFilterValues(
        req.query.SELECT.where,
        "numeroSemana",
      )
        .map(Number)
        .filter(Number.isInteger);

      /*
       * El reporte no carga datos hasta que el usuario
       * seleccione año y al menos una semana.
       */
      if (aYears.length !== 1 || aWeekNumbers.length === 0) {
        const aEmptyResult = [];

        if (req.query.SELECT.count) {
          aEmptyResult.$count = 0;
        }

        return aEmptyResult;
      }

      const iYear = aYears[0];

      const aWeeks = [...new Set(aWeekNumbers)]
        .sort((a, b) => a - b)
        .map((iWeek) => this._buildWeek(iYear, iWeek));

      const sMinimumStart = aWeeks[0].fechaInicio;

      const sMaximumStart = aWeeks[aWeeks.length - 1].fechaInicio;

      const sMaximumEnd = aWeeks[aWeeks.length - 1].fechaFin;

      const aEmployees = await db.run(
        SELECT.from(Empleados).columns(
          "ID",
          "codigoInterno",
          "primerNombre",
          "segundoNombre",
          "primerApellido",
          "segundoApellido",
          "correoCorporativo",
          "fechaIngreso",
          "fechaRetiro",
        ).where`
            fechaIngreso <= ${sMaximumEnd}
            and (
              fechaRetiro is null
              or fechaRetiro >= ${sMinimumStart}
            )
          `,
      );

      const aSelections = await db.run(
        SELECT.from(SeleccionesHomeOffice).columns(
          "empleado_ID",
          "semanaInicio",
          "fecha",
          "diaSemana",
          "estado",
        ).where`
            estado = 'CONFIRMADA'
            and semanaInicio >= ${sMinimumStart}
            and semanaInicio <= ${sMaximumStart}
          `,
      );

      const mSelections = new Map();

      aSelections.forEach((oSelection) => {
        const sWeekStart = this._dateKey(oSelection.semanaInicio);

        const sKey = `${oSelection.empleado_ID}|${sWeekStart}`;

        if (!mSelections.has(sKey)) {
          mSelections.set(sKey, []);
        }

        mSelections.get(sKey).push({
          ...oSelection,
          fecha: this._dateKey(oSelection.fecha),
        });
      });

      const aRows = [];

      aWeeks.forEach((oWeek) => {
        aEmployees
          .filter((oEmployee) => this._isEmployeeActiveInWeek(oEmployee, oWeek))
          .forEach((oEmployee) => {
            const sKey = `${oEmployee.ID}|${oWeek.fechaInicio}`;

            const aEmployeeSelections = mSelections.get(sKey) || [];

            const oSelectedDays = {
              lunes: null,
              martes: null,
              miercoles: null,
              jueves: null,
              viernes: null,
            };

            const aDayNames = [];

            aEmployeeSelections.forEach((oSelection) => {
              switch (Number(oSelection.diaSemana)) {
                case 1:
                  oSelectedDays.lunes = oSelection.fecha;
                  aDayNames.push("Lunes");
                  break;

                case 2:
                  oSelectedDays.martes = oSelection.fecha;
                  aDayNames.push("Martes");
                  break;

                case 3:
                  oSelectedDays.miercoles = oSelection.fecha;
                  aDayNames.push("Miércoles");
                  break;

                case 4:
                  oSelectedDays.jueves = oSelection.fecha;
                  aDayNames.push("Jueves");
                  break;

                case 5:
                  oSelectedDays.viernes = oSelection.fecha;
                  aDayNames.push("Viernes");
                  break;

                default:
                  break;
              }
            });

            const iSelectedDays = aEmployeeSelections.length;

            /*
             * El reporte solo muestra empleados que tengan al
             * menos un día confirmado para la semana.
             */
            if (iSelectedDays === 0) {
              return;
            }

            const sWeekStatus = iSelectedDays >= 2 ? "Completa" : "Incompleta";

            const iCriticality = iSelectedDays >= 2 ? 3 : 2;

            aRows.push({
              ID: `${iYear}-${oWeek.numeroSemana}-` + `${oEmployee.ID}`,

              anio: String(iYear),
              numeroSemana: oWeek.numeroSemana,
              semanaInicio: oWeek.fechaInicio,
              semanaFin: oWeek.fechaFin,
              semanaDescripcion: oWeek.descripcion,

              empleado_ID: oEmployee.ID,
              codigoInterno: oEmployee.codigoInterno,
              nombreCompleto: this._buildEmployeeName(oEmployee),
              correoCorporativo: oEmployee.correoCorporativo,

              ...oSelectedDays,

              diasSeleccionados: iSelectedDays,

              diasSeleccionadosTexto: aDayNames.join(", "),

              estadoSemana: sWeekStatus,

              estadoSemanaCriticality: iCriticality,
            });
          });
      });

      aRows.sort((oLeft, oRight) => {
        if (oLeft.numeroSemana !== oRight.numeroSemana) {
          return oLeft.numeroSemana - oRight.numeroSemana;
        }

        return oLeft.nombreCompleto.localeCompare(oRight.nombreCompleto, "es");
      });

      return this._applyQueryOptions(aRows, req.query.SELECT);
    });

    await super.init();
  }

  _buildWeek(iYear, iWeek) {
    const oJanuaryFourth = new Date(Date.UTC(iYear, 0, 4));

    const iJanuaryFourthDay = oJanuaryFourth.getUTCDay() || 7;

    const oFirstMonday = new Date(oJanuaryFourth);

    oFirstMonday.setUTCDate(
      oJanuaryFourth.getUTCDate() - iJanuaryFourthDay + 1,
    );

    const oStart = new Date(oFirstMonday);

    oStart.setUTCDate(oFirstMonday.getUTCDate() + (iWeek - 1) * 7);

    const oEnd = new Date(oStart);

    oEnd.setUTCDate(oStart.getUTCDate() + 4);

    const sStart = this._dateKey(oStart);

    const sEnd = this._dateKey(oEnd);

    return {
      numeroSemana: iWeek,
      fechaInicio: sStart,
      fechaFin: sEnd,
      descripcion:
        `Semana ${iWeek} ` +
        `(del ${this._formatShortDate(oStart)} ` +
        `al ${this._formatShortDate(oEnd)})`,
    };
  }

  _getWeeksInIsoYear(iYear) {
    const oDecemberTwentyEighth = new Date(Date.UTC(iYear, 11, 28));

    return this._getIsoWeekNumber(oDecemberTwentyEighth);
  }

  _getIsoWeekNumber(oDate) {
    const oUtcDate = new Date(
      Date.UTC(oDate.getUTCFullYear(), oDate.getUTCMonth(), oDate.getUTCDate()),
    );

    const iDay = oUtcDate.getUTCDay() || 7;

    oUtcDate.setUTCDate(oUtcDate.getUTCDate() + 4 - iDay);

    const oYearStart = new Date(Date.UTC(oUtcDate.getUTCFullYear(), 0, 1));

    return Math.ceil(((oUtcDate - oYearStart) / 86400000 + 1) / 7);
  }

  _formatShortDate(oDate) {
    return new Intl.DateTimeFormat("es-CO", {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(oDate);
  }

  _dateKey(vDate) {
    if (!vDate) {
      return null;
    }

    if (typeof vDate === "string") {
      return vDate.slice(0, 10);
    }

    return new Date(vDate).toISOString().slice(0, 10);
  }

  _buildEmployeeName(oEmployee) {
    return [
      oEmployee.primerNombre,
      oEmployee.segundoNombre,
      oEmployee.primerApellido,
      oEmployee.segundoApellido,
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  _isEmployeeActiveInWeek(oEmployee, oWeek) {
    const sEntryDate = this._dateKey(oEmployee.fechaIngreso);

    const sRetirementDate = this._dateKey(oEmployee.fechaRetiro);

    return (
      sEntryDate <= oWeek.fechaFin &&
      (!sRetirementDate || sRetirementDate >= oWeek.fechaInicio)
    );
  }

  _extractFilterValues(aWhere, sField) {
    const oValues = new Set();

    const fnVisit = (vNode) => {
      if (Array.isArray(vNode)) {
        for (let iIndex = 0; iIndex < vNode.length; iIndex += 1) {
          const oToken = vNode[iIndex];

          if (oToken?.ref?.[oToken.ref.length - 1] === sField) {
            const sOperator = vNode[iIndex + 1];

            const oRight = vNode[iIndex + 2];

            if (
              sOperator === "=" &&
              Object.prototype.hasOwnProperty.call(oRight || {}, "val")
            ) {
              oValues.add(oRight.val);
            }

            if (sOperator === "in" && Array.isArray(oRight?.list)) {
              oRight.list.forEach((oItem) => {
                if (Object.prototype.hasOwnProperty.call(oItem || {}, "val")) {
                  oValues.add(oItem.val);
                }
              });
            }
          }

          fnVisit(oToken);
        }

        return;
      }

      if (vNode && typeof vNode === "object") {
        if (vNode.xpr) {
          fnVisit(vNode.xpr);
        }
      }
    };

    fnVisit(aWhere);

    return [...oValues];
  }

  _applyQueryOptions(aRows, oSelect = {}) {
    const aResult = [...aRows];

    if (Array.isArray(oSelect.orderBy)) {
      aResult.sort((oLeft, oRight) => {
        for (const oOrder of oSelect.orderBy) {
          const sField = oOrder.ref?.[oOrder.ref.length - 1];

          if (!sField) {
            continue;
          }

          const vLeft = oLeft[sField];
          const vRight = oRight[sField];

          if (vLeft === vRight) {
            continue;
          }

          const iDirection = oOrder.sort === "desc" ? -1 : 1;

          return vLeft > vRight ? iDirection : -iDirection;
        }

        return 0;
      });
    }

    const iTotal = aResult.length;

    const iOffset = Number(oSelect.limit?.offset?.val) || 0;

    const iRows = Number(oSelect.limit?.rows?.val) || iTotal;

    const aPage = aResult.slice(iOffset, iOffset + iRows);

    if (oSelect.count) {
      aPage.$count = iTotal;
    }

    return aPage;
  }
};
