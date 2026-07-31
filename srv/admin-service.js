const cds = require("@sap/cds");
const absenceRules = require("./lib/absence-rules");

const { SELECT } = cds.ql;

module.exports = cds.service.impl(function () {
  const {
    Empleados: EmpleadosSrv,
    Contratos: ContratosSrv,
    Ausencias: AusenciasSrv,
    SaldosValeraEmocional: SaldosValeraSrv,
  } = this.entities;

  const SoportesAusenciaSrv = this.entities["Ausencias.soportes"];

  const {
    Empleados,
    Contratos,
    ContactosEmergencia,
    Ausencias,
    TiposAusencia,
    TiposContrato,
    Cargos,
    EPS,
    ARL,
    FondosPension,
    FondosCesantias,
    CajasCompensacion,
    SaldosValeraEmocional,
    CiudadesColombia,
  } = cds.entities("sabnez.rrhh");

  const SoportesAusencia =
    cds.entities("sabnez.rrhh")["Ausencias.soportes"];

  const {
    ESTADOS_CONSUMO_AUSENCIA,
    ESTADOS_RESERVA_AUSENCIA,
    ESTADOS_RESERVA_CUMPLEANIOS,
    ESTADOS_UTILIZACION_AUSENCIA,
    ESTADOS_UTILIZACION_CUMPLEANIOS,
  } = absenceRules;
  const POLITICA_SEMANA_CUMPLEANOS = "SEMANA_CUMPLEANOS";
  const ORIGEN_AUTOSERVICIO = "AUTOSERVICIO";
  const ORIGEN_LEGADO_RRHH = "LEGADO_RRHH";
  const ESTADOS_TERMINALES_LEGADO = new Set([
    "FINALIZADA",
    "RECHAZADA",
    "CANCELADA",
  ]);

  const today = () => absenceRules.todayInColombia();

  const keyFrom = (req) => {
    if (req.data.ID) return req.data.ID;
    const params = [...(req.params || [])].reverse();
    return params.find((param) => param?.ID)?.ID;
  };

  async function currentRow(entity, req) {
    const ID = keyFrom(req);
    if (!ID) return {};
    return (await SELECT.one.from(entity).where({ ID })) || {};
  }

  function error(req, code, message, target) {
    req.error({ code, message, target, status: 400 });
  }

  function warning(req, code, message, target) {
    req.warn({ code, message, target });
  }

  function normalizeText(data, fields) {
    for (const field of fields) {
      if (typeof data[field] === "string") {
        const normalized = data[field].trim();
        data[field] = normalized || null;
      }
    }
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function hasOwn(data, property) {
    return Object.prototype.hasOwnProperty.call(data, property);
  }

  function esRegistroLegado(data) {
    return data?.origenRegistro === ORIGEN_LEGADO_RRHH;
  }

  const CAMPOS_TECNICOS_AUSENCIA = new Set([
    "createdAt",
    "createdBy",
    "modifiedAt",
    "modifiedBy",
    "IsActiveEntity",
    "HasActiveEntity",
    "HasDraftEntity",
    "DraftAdministrativeData_DraftUUID",
  ]);
  const TIPOS_NUMERICOS_CDS = new Set([
    "cds.Decimal",
    "cds.DecimalFloat",
    "cds.Double",
    "cds.Integer",
    "cds.Integer64",
    "cds.UInt8",
  ]);
  const CAMPOS_SOPORTE_AUTOSERVICIO = [
    "ID",
    "up__ID",
    "filename",
    "mimeType",
    "hash",
    "note",
  ];

  function rechazarMutacionAutoservicioAdmin(req, target = "ausencias") {
    req.error({
      code: "AUSENCIA_AUTOSERVICIO_SOLO_WORKFLOW",
      message:
        "Las solicitudes de autoservicio son de solo lectura en Administración. Sus cambios y decisiones deben realizarse exclusivamente mediante el flujo de aprobaciones.",
      target,
      status: 403,
    });
  }

  function camposPersistidosAusencia() {
    return Object.entries(AusenciasSrv?.elements || {}).filter(
      ([nombre, elemento]) =>
        !CAMPOS_TECNICOS_AUSENCIA.has(nombre) &&
        !elemento.virtual &&
        !elemento.target &&
        elemento.type !== "cds.Association" &&
        elemento.type !== "cds.Composition",
    );
  }

  function valorPersistidoComparable(valor, elemento = {}) {
    if (valor === undefined || valor === null) return null;
    if (Buffer.isBuffer(valor)) return valor.toString("base64");
    if (valor instanceof Date) return valor.toISOString();

    if (TIPOS_NUMERICOS_CDS.has(elemento.type)) {
      const numero = Number(valor);
      return Number.isNaN(numero) ? String(valor) : numero;
    }

    return valor;
  }

  function camposAusenciaModificados(actual = {}, candidato = {}) {
    return camposPersistidosAusencia()
      .filter(([nombre, elemento]) => {
        const anterior = valorPersistidoComparable(actual[nombre], elemento);
        const siguiente = valorPersistidoComparable(
          candidato[nombre],
          elemento,
        );
        return !Object.is(anterior, siguiente);
      })
      .map(([nombre]) => nombre);
  }

  function soportesAutoservicioIguales(activos = [], borradores = []) {
    if (activos.length !== borradores.length) return false;

    const borradorPorID = new Map(
      borradores.map((soporte) => [soporte.ID, soporte]),
    );

    return activos.every((soporteActivo) => {
      const soporteBorrador = borradorPorID.get(soporteActivo.ID);
      if (!soporteBorrador) return false;

      return CAMPOS_SOPORTE_AUTOSERVICIO.every((campo) =>
        Object.is(
          valorPersistidoComparable(soporteActivo[campo]),
          valorPersistidoComparable(soporteBorrador[campo]),
        ),
      );
    });
  }

  async function validarAutoservicioSinCambiosEnBorrador(
    req,
    activas,
    borradores,
  ) {
    const activaPorID = new Map(
      activas.map((ausencia) => [ausencia.ID, ausencia]),
    );
    const borradorPorID = new Map(
      borradores.map((ausencia) => [ausencia.ID, ausencia]),
    );
    const payloadPorID = new Map(
      (Array.isArray(req.data?.ausencias) ? req.data.ausencias : [])
        .filter((ausencia) => ausencia?.ID)
        .map((ausencia) => [ausencia.ID, ausencia]),
    );
    const idsProtegidos = new Set([
      ...activas
        .filter(
          (ausencia) => ausencia.origenRegistro === ORIGEN_AUTOSERVICIO,
        )
        .map((ausencia) => ausencia.ID),
      ...borradores
        .filter(
          (ausencia) => ausencia.origenRegistro === ORIGEN_AUTOSERVICIO,
        )
        .map((ausencia) => ausencia.ID),
      ...[...payloadPorID.values()]
        .filter(
          (ausencia) => ausencia.origenRegistro === ORIGEN_AUTOSERVICIO,
        )
        .map((ausencia) => ausencia.ID),
    ]);

    for (const ausenciaID of idsProtegidos) {
      const activa = activaPorID.get(ausenciaID);
      const borradorBase = borradorPorID.get(ausenciaID);

      if (!activa || !borradorBase) {
        rechazarMutacionAutoservicioAdmin(req);
        return false;
      }

      const borrador = {
        ...borradorBase,
        ...(payloadPorID.get(ausenciaID) || {}),
      };
      if (camposAusenciaModificados(activa, borrador).length > 0) {
        rechazarMutacionAutoservicioAdmin(req);
        return false;
      }

      const [soportesActivos, soportesBorrador] = await Promise.all([
        SELECT.from(SoportesAusencia)
          .columns(...CAMPOS_SOPORTE_AUTOSERVICIO)
          .where({ up__ID: ausenciaID }),
        SELECT.from(SoportesAusenciaSrv.drafts)
          .columns(...CAMPOS_SOPORTE_AUTOSERVICIO)
          .where({ up__ID: ausenciaID }),
      ]);

      if (!soportesAutoservicioIguales(soportesActivos, soportesBorrador)) {
        rechazarMutacionAutoservicioAdmin(req, "ausencias/soportes");
        return false;
      }
    }

    return true;
  }

  function normalizeAfiliacionInput(req) {
    /*
     * Si se elimina la ARL, también se limpia el nivel
     * de riesgo.
     */
    if (hasOwn(req.data, "arl_ID") && !req.data.arl_ID) {
      req.data.nivelRiesgoArl = null;
    }

    if (typeof req.data.nivelRiesgoArl === "string") {
      const nivel = req.data.nivelRiesgoArl.trim().toUpperCase();

      req.data.nivelRiesgoArl = nivel || null;
    }
  }

  function validateAfiliaciones(req, data, finalValidation = false) {
    if (data.nivelRiesgoArl && !/^(I|II|III|IV|V)$/.test(data.nivelRiesgoArl)) {
      error(
        req,
        "NIVEL_RIESGO_INVALIDO",
        "El nivel de riesgo ARL debe ser I, II, III, IV o V.",
        "nivelRiesgoArl",
      );
    }

    if (finalValidation && data.nivelRiesgoArl && !data.arl_ID) {
      error(
        req,
        "ARL_REQUERIDA",
        "No puedes registrar un nivel de riesgo sin seleccionar una ARL.",
        "arl_ID",
      );
    }

    if (finalValidation && data.arl_ID && !data.nivelRiesgoArl) {
      error(
        req,
        "NIVEL_RIESGO_REQUERIDO",
        "Indica el nivel de riesgo cuando se registra una ARL.",
        "nivelRiesgoArl",
      );
    }

    if (data.fechaAfiliacion && data.fechaAfiliacion > today()) {
      error(
        req,
        "FECHA_AFILIACION_FUTURA",
        "La fecha de afiliación no puede estar en el futuro.",
        "fechaAfiliacion",
      );
    }
  }

  async function validateCiudadSeleccionada(req, data, previous = {}) {
    if (!hasOwn(req.data, "ciudad")) return;
    if (!data.ciudad || data.ciudad === previous.ciudad) return;

    const ciudadValida = await SELECT.one
      .from(CiudadesColombia)
      .columns("codigo")
      .where({ nombre: data.ciudad });

    if (!ciudadValida) {
      error(
        req,
        "CIUDAD_INVALIDA",
        "Selecciona una ciudad de la lista de municipios de Colombia.",
        "ciudad",
      );
    }
  }

  function obtenerIniciales(empleado) {
    const primera = Array.from(empleado.primerNombre || "")[0] || "";
    const apellido = Array.from(empleado.primerApellido || "")[0] || "";
    return `${primera}${apellido}`.toUpperCase() || null;
  }

  function construirAvatarIniciales(empleado) {
    const iniciales = (obtenerIniciales(empleado) || "?")
      .replace(/[^\p{L}\p{N}]/gu, "")
      .slice(0, 2) || "?";

    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">',
      '<rect width="128" height="128" rx="64" fill="#5b738b"/>',
      '<text x="64" y="68" text-anchor="middle" dominant-baseline="middle" ',
      'font-family="Arial, sans-serif" font-size="46" font-weight="600" fill="#ffffff">',
      iniciales,
      "</text></svg>",
    ].join("");

    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  }

  function construirFotoUrl(empleado, fotoMeta) {
    if (
      empleado.ID &&
      fotoMeta?.foto_url &&
      fotoMeta.foto_status === "Clean"
    ) {
      const isActive = empleado.IsActiveEntity === false ? "false" : "true";
      return `/admin/Empleados(ID=${empleado.ID},IsActiveEntity=${isActive})/foto_content`;
    }

    return construirAvatarIniciales(empleado);
  }

  const MIME_FOTO_POR_EXTENSION = new Map([
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["png", "image/png"],
    ["webp", "image/webp"],
  ]);

  const EXTENSION_POR_MIME_FOTO = new Map([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ]);

  function nombreArchivoDesdeContentDisposition(value) {
    if (typeof value !== "string") return null;

    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value);
    if (encoded?.[1]) {
      try {
        return decodeURIComponent(encoded[1]).split(/[\\/]/).pop() || null;
      } catch {
        // Si la codificación es inválida, se intenta con filename normal.
      }
    }

    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(value);
    return plain?.[1]?.trim().split(/[\\/]/).pop() || null;
  }

  function mimeFotoDesdeNombre(filename) {
    if (!filename) return null;
    const extension = filename.split(".").pop()?.toLowerCase();
    return MIME_FOTO_POR_EXTENSION.get(extension) || null;
  }

  function prepararCargaFoto(req) {
    const subjectRef = req.subject?.ref || [];
    const subjectTail = subjectRef.at(-1);
    const propertyName =
      typeof subjectTail === "string"
        ? subjectTail
        : subjectTail?.id || subjectTail?.ref?.at(-1);

    const requestUrl =
      req.req?.originalUrl ||
      req.req?.url ||
      req._?.req?.originalUrl ||
      req._?.req?.url ||
      "";

    const esCargaFoto =
      propertyName === "foto_content" ||
      /\/foto_content(?:\?|$)/i.test(requestUrl);

    if (!esCargaFoto) return;

    req.data ||= {};

    const headers = {
      ...(req._?.req?.headers || {}),
      ...(req.req?.headers || {}),
      ...(req.headers || {}),
    };
    const contentDisposition = headers["content-disposition"];
    const filename =
      req.data.foto_filename ||
      nombreArchivoDesdeContentDisposition(contentDisposition);

    const headerMimeType = headers["content-type"]
      ?.split(";", 1)[0]
      ?.trim()
      ?.toLowerCase();

    const mimeType =
      EXTENSION_POR_MIME_FOTO.has(headerMimeType)
        ? headerMimeType
        : mimeFotoDesdeNombre(filename);

    if (!mimeType) {
      return req.reject({
        status: 400,
        code: "FOTO_TIPO_INVALIDO",
        message: "La foto debe ser un archivo JPG, PNG o WebP válido.",
        target: "foto_content",
      });
    }

    const extension = EXTENSION_POR_MIME_FOTO.get(mimeType);

    // @cap-js/attachments 3.13.1 valida este campo antes de
    // inferirlo por el nombre. Debe estar presente en req.data
    // antes de entrar a su handler ON para el stream.
    req.data.foto_mimeType = mimeType;
    req.data.foto_filename =
      filename || `foto-${keyFrom(req) || "empleado"}.${extension}`;
  }

  async function currentEmployeeDraft(req) {
    const ID = keyFrom(req);
    if (!ID) return {};
    return (await SELECT.one.from(EmpleadosSrv.drafts).where({ ID })) || {};
  }

  async function currentAbsenceDraft(req) {
    const ID = keyFrom(req);
    if (!ID) return {};
    return (await SELECT.one.from(AusenciasSrv.drafts).where({ ID })) || {};
  }

  // ----------------------------------------------------------
  // EMPLEADOS
  // ----------------------------------------------------------
  // El PUT de una propiedad stream no siempre se despacha con el
  // target Empleados/Empleados.drafts esperado. Por eso este handler
  // debe ser global para el evento PUT y filtrar por /foto_content.
  // Todos los BEFORE se ejecutan antes del handler ON del plugin.
  this.before("PUT", (req) => {
    prepararCargaFoto(req);
  });

  this.before("CREATE", EmpleadosSrv, async (req) => {
    if (req.data.codigoInterno) return;

    const empleados = await SELECT.from(Empleados).columns("codigoInterno");

    let maxNumber = 0;

    for (const empleado of empleados) {
      const match = /^SAB-(\d+)$/.exec(empleado.codigoInterno || "");

      if (match) {
        maxNumber = Math.max(maxNumber, Number(match[1]));
      }
    }

    req.data.codigoInterno = `SAB-${String(maxNumber + 1).padStart(3, "0")}`;
  });

  // Se ejecuta cada vez que Fiori modifica un campo del borrador.
  this.before("PATCH", EmpleadosSrv.drafts, async (req) => {
    normalizeAfiliacionInput(req);

    const previous = await currentEmployeeDraft(req);

    const data = {
      ...previous,
      ...req.data,
    };

    // Valida formato del nivel y fecha futura inmediatamente.
    // No exige todavía el nivel porque el usuario puede estar
    // seleccionando primero la ARL.
    validateAfiliaciones(req, data, false);
    await validateCiudadSeleccionada(req, data, previous);
  });

  // Se ejecuta al presionar Guardar y activar el borrador.
  this.before("SAVE", EmpleadosSrv.drafts, async (req) => {
    normalizeAfiliacionInput(req);

    const previous = await currentEmployeeDraft(req);

    const data = {
      ...previous,
      ...req.data,
    };

    // Aquí sí se validan las dependencias obligatorias:
    // ARL requiere nivel y nivel requiere ARL.
    validateAfiliaciones(req, data, true);
    await validateCiudadSeleccionada(req, data, previous);

    // Serializa toda activación del árbol del empleado con los envíos de
    // ausencias, incluidos cambios profundos de contratos y saldos.
    const empleadoID = keyFrom(req);
    if (empleadoID) {
      await bloquearEmpleadoParaReglas(req, empleadoID, true);
    }

    // La activación del borrador se realiza sobre el root Empleados.
    // Por eso las reglas definitivas de las ausencias compuestas deben
    // validarse aquí y no depender únicamente del PATCH del detalle.
    await validarAusenciasBorradorEmpleado(req);
  });

  this.before(["CREATE", "UPDATE"], EmpleadosSrv, async (req) => {
    normalizeAfiliacionInput(req);

    normalizeText(req.data, [
      "numeroDocumento",
      "primerNombre",
      "segundoNombre",
      "primerApellido",
      "segundoApellido",
      "correoPersonal",
      "correoCorporativo",
      "telefono",
      "direccion",
      "ciudad",
      "barrio",
      "alergias",
    ]);

    if (req.data.correoPersonal) {
      req.data.correoPersonal = req.data.correoPersonal.toLowerCase();
    }
    if (req.data.correoCorporativo) {
      req.data.correoCorporativo = req.data.correoCorporativo.toLowerCase();
    }

    const previous =
      req.event === "UPDATE" ? await currentRow(Empleados, req) : {};
    const data = { ...previous, ...req.data };
    const ID = data.ID || keyFrom(req);

    validateAfiliaciones(req, data, true);
    await validateCiudadSeleccionada(req, data, previous);

    if (data.fechaNacimiento && data.fechaNacimiento > today()) {
      error(
        req,
        "FECHA_NACIMIENTO_FUTURA",
        "La fecha de nacimiento no puede estar en el futuro.",
        "fechaNacimiento",
      );
    }

    if (
      data.fechaIngreso &&
      data.fechaRetiro &&
      data.fechaRetiro < data.fechaIngreso
    ) {
      error(
        req,
        "FECHA_RETIRO_INVALIDA",
        "La fecha de retiro no puede ser anterior a la fecha de ingreso.",
        "fechaRetiro",
      );
    }

    if (data.jefeDirecto_ID && ID && data.jefeDirecto_ID === ID) {
      error(
        req,
        "JEFE_DIRECTO_INVALIDO",
        "Un empleado no puede ser su propio jefe directo.",
        "jefeDirecto_ID",
      );
    }

    for (const field of ["correoPersonal", "correoCorporativo"]) {
      if (data[field] && !isValidEmail(data[field])) {
        error(
          req,
          "CORREO_INVALIDO",
          "Ingresa una dirección de correo válida.",
          field,
        );
      }
    }

    if (data.numeroDocumento && data.tipoDocumento) {
      const duplicate = await SELECT.one.from(Empleados).where({
        numeroDocumento: data.numeroDocumento,
        tipoDocumento: data.tipoDocumento,
      });

      if (duplicate && duplicate.ID !== ID) {
        error(
          req,
          "DOCUMENTO_DUPLICADO",
          `Ya existe un empleado con el documento ${data.numeroDocumento}.`,
          "numeroDocumento",
        );
      }
    }

    if (data.correoCorporativo) {
      const duplicateEmail = await SELECT.one.from(Empleados).where({
        correoCorporativo: data.correoCorporativo,
      });

      if (duplicateEmail && duplicateEmail.ID !== ID) {
        error(
          req,
          "CORREO_CORPORATIVO_DUPLICADO",
          `El correo ${data.correoCorporativo} ya está asignado a otro empleado.`,
          "correoCorporativo",
        );
      }
    }
  });

  this.before("DELETE", EmpleadosSrv, (req) => {
    req.reject(
      405,
      "Los empleados no se eliminan físicamente. Registra la fecha de retiro y cambia su estado a Retirado.",
    );
  });

  // ----------------------------------------------------------
  // CONTRATOS
  // ----------------------------------------------------------
  this.before(["CREATE", "UPDATE"], ContratosSrv, async (req) => {
    normalizeText(req.data, ["moneda", "observaciones"]);
    if (req.data.moneda) req.data.moneda = req.data.moneda.toUpperCase();

    let previous =
      req.event === "UPDATE" ? await currentRow(Contratos, req) : {};
    let data = { ...previous, ...req.data };

    if (data.empleado_ID) {
      if (!(await bloquearEmpleadoParaReglas(req, data.empleado_ID))) return;
      if (req.event === "UPDATE") {
        previous = await currentRow(Contratos, req);
        data = { ...previous, ...req.data };
      }
    }

    const ID = data.ID || keyFrom(req);

    if (data.vigente === true) {
      req.data.fechaFin = null;
      data.fechaFin = null;
    }

    if (data.fechaInicio && data.fechaFin && data.fechaFin < data.fechaInicio) {
      error(
        req,
        "FECHA_FIN_CONTRATO_INVALIDA",
        "La fecha final no puede ser anterior a la fecha inicial.",
        "fechaFin",
      );
      return;
    }

    if (data.moneda && !/^[A-Z]{3}$/.test(data.moneda)) {
      error(
        req,
        "MONEDA_INVALIDA",
        "La moneda debe ser un código ISO de tres letras, por ejemplo COP.",
        "moneda",
      );
    }

    if (data.empleado_ID && data.fechaInicio) {
      const employeeContracts = await SELECT.from(Contratos).where({
        empleado_ID: data.empleado_ID,
      });
      const newStart = data.fechaInicio;
      const newEnd = data.fechaFin || "9999-12-31";
      const overlap = employeeContracts.find((contract) => {
        if (contract.ID === ID || !contract.fechaInicio) return false;
        const currentEnd = contract.fechaFin || "9999-12-31";
        return newStart <= currentEnd && newEnd >= contract.fechaInicio;
      });

      if (overlap) {
        error(
          req,
          "CONTRATO_SUPERPUESTO",
          "Las fechas se cruzan con otro contrato del empleado.",
          "fechaInicio",
        );
      }
    }

    if (data.vigente && data.empleado_ID) {
      const activeContracts = await SELECT.from(Contratos).where({
        empleado_ID: data.empleado_ID,
        vigente: true,
      });
      const anotherActive = activeContracts.find(
        (contract) => contract.ID !== ID,
      );

      if (anotherActive) {
        error(
          req,
          "CONTRATO_VIGENTE_EXISTENTE",
          "El empleado ya tiene otro contrato marcado como vigente.",
          "vigente",
        );
      }
    }
  });

  this.before("DELETE", ContratosSrv, async (req) => {
    const contrato = await currentRow(Contratos, req);
    if (contrato.empleado_ID) {
      await bloquearEmpleadoParaReglas(req, contrato.empleado_ID);
    }
  });

  // Si se marca nuevamente como vigente,
  // la fecha final se elimina del borrador.
  this.before("PATCH", ContratosSrv.drafts, (req) => {
    if (
      Object.prototype.hasOwnProperty.call(req.data, "vigente") &&
      req.data.vigente === true
    ) {
      req.data.fechaFin = null;
    }
  });

  // El saldo configurado y las solicitudes toman el mismo lock de empleado.
  // Así un ajuste administrativo no puede intercalarse con un envío que esté
  // calculando el saldo anual de Valera.
  this.before(
    ["CREATE", "UPDATE", "DELETE"],
    SaldosValeraSrv,
    async (req) => {
      const previous =
        req.event === "CREATE"
          ? {}
          : await currentRow(SaldosValeraEmocional, req);
      const empleadoID = req.data?.empleado_ID || previous.empleado_ID;

      if (empleadoID) {
        await bloquearEmpleadoParaReglas(req, empleadoID);
      }
    },
  );

  // ----------------------------------------------------------
  // CONTACTOS DE EMERGENCIA
  // ----------------------------------------------------------
  this.before(["CREATE", "UPDATE"], "ContactosEmergencia", async (req) => {
    normalizeText(req.data, [
      "nombre",
      "parentesco",
      "telefono",
      "telefonoAlt",
    ]);

    const previous =
      req.event === "UPDATE" ? await currentRow(ContactosEmergencia, req) : {};
    const data = { ...previous, ...req.data };
    const ID = data.ID || keyFrom(req);

    if (data.esPrincipal && data.empleado_ID) {
      const contacts = await SELECT.from(ContactosEmergencia).where({
        empleado_ID: data.empleado_ID,
        esPrincipal: true,
      });
      const anotherPrimary = contacts.find((contact) => contact.ID !== ID);

      if (anotherPrimary) {
        error(
          req,
          "CONTACTO_PRINCIPAL_EXISTENTE",
          "El empleado ya tiene otro contacto de emergencia principal.",
          "esPrincipal",
        );
      }
    }
  });

  // ----------------------------------------------------------
  // AUSENCIAS
  // ----------------------------------------------------------
  // Toda ausencia creada desde la ficha administrativa corresponde a una
  // carga histórica. El origen no depende de un valor enviado por la UI.
  this.before("NEW", AusenciasSrv.drafts, (req) => {
    req.data.origenRegistro = ORIGEN_LEGADO_RRHH;
    req.data.estadoa_codigo = "FINALIZADA";
  });

  // Protege también el entity set técnico de adjuntos. Los cambios sobre el
  // draft se validan al activar el árbol; los cambios activos solo son válidos
  // mientras la solicitud subyacente siga en BORRADOR. CAP normaliza PUT y
  // PATCH como UPDATE, por lo que este handler global también cubre /content.
  this.before(
    ["CREATE", "NEW", "UPDATE", "DELETE", "CANCEL"],
    async (req) => {
      if (!esPeticionDeSoporteAdmin(req)) return;
      await protegerMutacionSoporteAdmin(req);
    },
  );

  this.before(["NEW", "PATCH"], AusenciasSrv.drafts, async (req) => {
    const previous = await currentAbsenceDraft(req);
    const data = { ...previous, ...req.data };

    if (previous.origenRegistro === ORIGEN_AUTOSERVICIO) {
      if (camposAusenciaModificados(previous, data).length > 0) {
        rechazarMutacionAutoservicioAdmin(req);
      }

      // Una escritura sin cambios puede formar parte de la activación del
      // draft raíz. No se vuelven a calcular ni validar solicitudes que la
      // ficha administrativa solo está transportando sin modificarlas.
      return;
    }

    if (
      hasOwn(req.data, "origenRegistro") &&
      previous.origenRegistro &&
      req.data.origenRegistro !== previous.origenRegistro
    ) {
      error(
        req,
        "ORIGEN_AUSENCIA_INMUTABLE",
        "El origen de una ausencia no puede modificarse.",
        "origenRegistro",
      );
      return;
    }

    if (!data.origenRegistro) {
      req.data.origenRegistro = ORIGEN_LEGADO_RRHH;
      data.origenRegistro = ORIGEN_LEGADO_RRHH;
    }

    let absenceType;
    if (data.tipoAusencia_codigo) {
      absenceType = await SELECT.one
        .from(TiposAusencia)
        .where({ codigo: data.tipoAusencia_codigo });
    }

    if (!absenceType) return;

    const unidadConsumo = absenceType.unidadConsumo || "DIAS";
    req.data.unidadConsumo = unidadConsumo;
    data.unidadConsumo = unidadConsumo;

    if (unidadConsumo === "HORAS") {
      const nombreTipo = absenceType.descripcion || "el beneficio por horas";

      req.data.diasHabiles = 0;
      data.diasHabiles = 0;

      if (
        (hasOwn(req.data, "fechaInicio") ||
          hasOwn(req.data, "tipoAusencia_codigo")) &&
        data.fechaInicio
      ) {
        req.data.fechaFin = data.fechaInicio;
        data.fechaFin = data.fechaInicio;
      }

      if (
        absenceType.requiereMismoDia &&
        data.fechaInicio &&
        data.fechaFin &&
        data.fechaInicio !== data.fechaFin
      ) {
        error(
          req,
          "VALERA_MISMO_DIA_REQUERIDO",
          "La valera emocional debe solicitarse para una sola fecha.",
          "fechaFin",
        );
        return;
      }

      if (tieneSegundos(data.horaInicio) || tieneSegundos(data.horaFin)) {
        error(
          req,
          "VALERA_SOLO_HORAS_MINUTOS",
          "La valera emocional solo permite seleccionar horas y minutos; los segundos deben ser 00.",
          tieneSegundos(data.horaInicio) ? "horaInicio" : "horaFin",
        );
        return;
      }

      const horas = calcularHorasSolicitadas(data.horaInicio, data.horaFin);

      if (horas < 0) {
        error(
          req,
          "HORA_FIN_INVALIDA",
          "La hora final debe ser posterior a la hora inicial.",
          "horaFin",
        );
        return;
      }

      if (!esRegistroLegado(data)) {
        const maximoHorasSolicitud = Number(absenceType.maximoHorasDia || 0);
        const excedeMaximoSolicitud =
          maximoHorasSolicitud > 0 && horas > maximoHorasSolicitud;

        if (excedeMaximoSolicitud) {
          // La advertencia operativa se conserva para solicitudes de
          // autoservicio editadas por RR. HH., pero no para datos legados.
          warning(
            req,
            "MAXIMO_HORAS_SOLICITUD_EXCEDIDO",
            `Cada solicitud de ${nombreTipo} puede ser de máximo ${maximoHorasSolicitud.toFixed(2)} horas.`,
            "horaFin",
          );
        }

        if (
          !excedeMaximoSolicitud &&
          ESTADOS_CONSUMO_AUSENCIA.has(data.estadoa_codigo || "SOLICITADA") &&
          data.empleado_ID &&
          data.fechaInicio &&
          horas > 0
        ) {
          const ausenciaID = data.ID || keyFrom(req);
          const ausenciasHoras = await obtenerAusenciasHoras(
            data.empleado_ID,
            ausenciaID,
            data.tipoAusencia_codigo,
            absenceType.politicaFecha === POLITICA_SEMANA_CUMPLEANOS
              ? POLITICA_SEMANA_CUMPLEANOS
              : null,
          );

          const horasMismoDia = round2(
            ausenciasHoras
              .filter((ausencia) => ausencia.fechaInicio === data.fechaInicio)
              .reduce(
                (total, ausencia) =>
                  total + Number(ausencia.horasSolicitadas || 0),
                0,
              ),
          );

          if (
            maximoHorasSolicitud > 0 &&
            round2(horasMismoDia + horas) > maximoHorasSolicitud
          ) {
            warning(
              req,
              "MAXIMO_HORAS_DIA_EXCEDIDO",
              `El máximo diario es ${maximoHorasSolicitud.toFixed(2)} horas. Para esa fecha ya hay ${horasMismoDia.toFixed(2)} horas reservadas.`,
              "horaFin",
            );
          }

          const maximoHorasSemana = Number(
            absenceType.maximoHorasSemana || 0,
          );

          if (maximoHorasSemana > 0) {
            const inicioSemana = obtenerInicioSemana(data.fechaInicio);
            const finSemana = formatISODate(
              addDays(parseISODate(inicioSemana), 6),
            );
            const horasSemana = round2(
              ausenciasHoras
                .filter(
                  (ausencia) =>
                    ausencia.fechaInicio >= inicioSemana &&
                    ausencia.fechaInicio <= finSemana,
                )
                .reduce(
                  (total, ausencia) =>
                    total + Number(ausencia.horasSolicitadas || 0),
                  0,
                ),
            );

            if (round2(horasSemana + horas) > maximoHorasSemana) {
              warning(
                req,
                "MAXIMO_HORAS_SEMANA_EXCEDIDO",
                `El máximo semanal es ${maximoHorasSemana.toFixed(2)} horas, de lunes a domingo. En esa semana ya hay ${horasSemana.toFixed(2)} horas reservadas.`,
                "horaFin",
              );
            }
          }
        }
      }

      req.data.horasSolicitadas = horas;
      return;
    }

    if (
      hasOwn(req.data, "tipoAusencia_codigo") ||
      previous.unidadConsumo === "HORAS"
    ) {
      req.data.horaInicio = null;
      req.data.horaFin = null;
      req.data.horasSolicitadas = 0;
    }

    if (data.fechaInicio && data.fechaFin && data.fechaFin < data.fechaInicio) {
      error(
        req,
        "FECHA_FIN_AUSENCIA_INVALIDA",
        "La fecha final no puede ser anterior a la fecha inicial.",
        "fechaFin",
      );
      return;
    }

    if (
      hasOwn(req.data, "fechaInicio") ||
      hasOwn(req.data, "fechaFin") ||
      hasOwn(req.data, "tipoAusencia_codigo")
    ) {
      req.data.diasHabiles =
        data.fechaInicio && data.fechaFin
          ? calcularDiasHabilesColombia(data.fechaInicio, data.fechaFin)
          : 0;
    }
  });

  this.before("DELETE", AusenciasSrv.drafts, async (req) => {
    // Descartar el draft completo no altera la solicitud activa y debe seguir
    // siendo posible desde la ficha del empleado.
    if (req._?.event === "draftCancel") return;

    const ausencia = await currentAbsenceDraft(req);
    if (ausencia.origenRegistro === ORIGEN_AUTOSERVICIO) {
      rechazarMutacionAutoservicioAdmin(req);
    }
  });

  this.before(["CREATE", "UPDATE"], AusenciasSrv, async (req) => {
    normalizeText(req.data, ["motivo"]);

    if (req.event === "CREATE") {
      if (req.data.origenRegistro === ORIGEN_AUTOSERVICIO) {
        rechazarMutacionAutoservicioAdmin(req);
        return;
      }
      req.data.origenRegistro = ORIGEN_LEGADO_RRHH;
    }

    let previous =
      req.event === "UPDATE" ? await currentRow(Ausencias, req) : {};
    let data = { ...previous, ...req.data };
    const ID = data.ID || keyFrom(req);

    if (
      req.event === "UPDATE" &&
      previous.origenRegistro === ORIGEN_AUTOSERVICIO
    ) {
      if (camposAusenciaModificados(previous, data).length > 0) {
        rechazarMutacionAutoservicioAdmin(req);
      }

      // CAP activa el árbol completo del empleado. Una copia idéntica de la
      // ausencia de autoservicio no debe impedir guardar otros datos.
      return;
    }

    if (
      req.event === "UPDATE" &&
      previous.origenRegistro &&
      data.origenRegistro !== previous.origenRegistro
    ) {
      error(
        req,
        "ORIGEN_AUSENCIA_INMUTABLE",
        "El origen de una ausencia no puede modificarse.",
        "origenRegistro",
      );
      return;
    }

    if (
      ![ORIGEN_AUTOSERVICIO, ORIGEN_LEGADO_RRHH].includes(
        data.origenRegistro,
      )
    ) {
      error(
        req,
        "ORIGEN_AUSENCIA_INVALIDO",
        "No fue posible determinar el origen de la ausencia.",
        "origenRegistro",
      );
      return;
    }

    let registroLegado = esRegistroLegado(data);

    if (data.empleado_ID) {
      if (!(await bloquearEmpleadoParaReglas(req, data.empleado_ID))) return;
      if (req.event === "UPDATE") {
        previous = await currentRow(Ausencias, req);
        data = { ...previous, ...req.data };
        registroLegado = esRegistroLegado(data);
      }
    }

    if (
      !registroLegado &&
      req.event === "UPDATE" &&
      previous.estadoa_codigo &&
      data.estadoa_codigo &&
      previous.estadoa_codigo !== data.estadoa_codigo &&
      !esTransicionEstadoAusenciaPermitida(
        previous.estadoa_codigo,
        data.estadoa_codigo,
      )
    ) {
      error(
        req,
        "TRANSICION_ESTADO_AUSENCIA_INVALIDA",
        `No se permite cambiar una ausencia de ${previous.estadoa_codigo} a ${data.estadoa_codigo}.`,
        "estadoa_codigo",
      );
      return;
    }

    let absenceType;
    if (data.tipoAusencia_codigo) {
      absenceType = await SELECT.one
        .from(TiposAusencia)
        .where({ codigo: data.tipoAusencia_codigo });
    }

    if (!absenceType) {
      error(
        req,
        "TIPO_AUSENCIA_INVALIDO",
        "Selecciona un tipo de ausencia válido.",
        "tipoAusencia_codigo",
      );
      return;
    }

    if (!esActivacionBorrador(req)) {
      if (
        !(await validarSoportesAusencia(
          req,
          absenceType,
          data.estadoa_codigo || "SOLICITADA",
          ID,
          "soportes",
          "active",
          !registroLegado,
        ))
      ) {
        return;
      }
    }

    const unidadConsumo = absenceType.unidadConsumo || "DIAS";
    req.data.unidadConsumo = unidadConsumo;
    data.unidadConsumo = unidadConsumo;

    if (data.fechaInicio && data.fechaFin && data.fechaFin < data.fechaInicio) {
      error(
        req,
        "FECHA_FIN_AUSENCIA_INVALIDA",
        "La fecha final no puede ser anterior a la fecha inicial.",
        "fechaFin",
      );
      return;
    }

    if (
      registroLegado &&
      !validarRegistroLegadoAdministrativo(req, data, "fechaFin")
    ) {
      return;
    }

    if (unidadConsumo === "HORAS") {
      const nombreTipo = absenceType.descripcion || "el beneficio por horas";

      req.data.diasHabiles = 0;
      data.diasHabiles = 0;

      if (!data.fechaInicio) {
        error(
          req,
          "FECHA_VALERA_REQUERIDA",
          `Indica la fecha en la que se utilizará ${nombreTipo}.`,
          "fechaInicio",
        );
      }

      if (absenceType.requiereMismoDia && data.fechaInicio) {
        req.data.fechaFin = data.fechaInicio;
        data.fechaFin = data.fechaInicio;
      }

      if (
        absenceType.requiereMismoDia &&
        data.fechaInicio &&
        data.fechaFin &&
        data.fechaInicio !== data.fechaFin
      ) {
        error(
          req,
          "VALERA_MISMO_DIA_REQUERIDO",
          `${nombreTipo} debe solicitarse para una sola fecha.`,
          "fechaFin",
        );
      }

      if (!data.horaInicio) {
        error(
          req,
          "HORA_INICIO_REQUERIDA",
          `Indica la hora inicial de ${nombreTipo}.`,
          "horaInicio",
        );
      }

      if (!data.horaFin) {
        error(
          req,
          "HORA_FIN_REQUERIDA",
          `Indica la hora final de ${nombreTipo}.`,
          "horaFin",
        );
      }

      if (tieneSegundos(data.horaInicio) || tieneSegundos(data.horaFin)) {
        error(
          req,
          "VALERA_SOLO_HORAS_MINUTOS",
          `${nombreTipo} solo permite seleccionar horas y minutos; los segundos deben ser 00.`,
          tieneSegundos(data.horaInicio) ? "horaInicio" : "horaFin",
        );
        return;
      }

      const horasSolicitadas = calcularHorasSolicitadas(
        data.horaInicio,
        data.horaFin,
      );

      if (horasSolicitadas <= 0) {
        error(
          req,
          "HORA_FIN_INVALIDA",
          "La hora final debe ser posterior a la hora inicial.",
          "horaFin",
        );
      }

      req.data.horasSolicitadas = Math.max(0, horasSolicitadas);
      data.horasSolicitadas = Math.max(0, horasSolicitadas);

      const minimoHorasSolicitud = Number(
        absenceType.minimoHorasSolicitud || 0,
      );

      if (
        minimoHorasSolicitud > 0 &&
        data.horasSolicitadas < minimoHorasSolicitud
      ) {
        error(
          req,
          "MINIMO_HORAS_SOLICITUD_NO_ALCANZADO",
          `${nombreTipo} debe solicitarse por ${minimoHorasSolicitud.toFixed(2)} horas.`,
          "horaFin",
        );
        return;
      }

      const maximoHorasSolicitud = Number(absenceType.maximoHorasDia || 0);
      if (
        maximoHorasSolicitud > 0 &&
        data.horasSolicitadas > maximoHorasSolicitud
      ) {
        error(
          req,
          "MAXIMO_HORAS_SOLICITUD_EXCEDIDO",
          `Cada solicitud de ${nombreTipo} puede ser de máximo ${maximoHorasSolicitud.toFixed(2)} horas.`,
          "horaFin",
        );
        return;
      }

      if (
        !registroLegado &&
        absenceType.permiteCruzarAnio === false &&
        data.fechaInicio &&
        data.fechaFin &&
        obtenerAnio(data.fechaInicio) !== obtenerAnio(data.fechaFin)
      ) {
        error(
          req,
          "VALERA_CRUCE_ANIO_NO_PERMITIDO",
          `${nombreTipo} no puede cruzar de un año a otro.`,
          "fechaFin",
        );
      }

      const fechasModificadas =
        req.event === "CREATE" ||
        previous.fechaInicio !== data.fechaInicio ||
        previous.tipoAusencia_codigo !== data.tipoAusencia_codigo;

      if (
        !registroLegado &&
        fechasModificadas &&
        data.fechaInicio &&
        Number(absenceType.diasAnticipacion || 0) > 0
      ) {
        const anticipacion = calcularDiasAnticipacion(
          today(),
          data.fechaInicio,
          absenceType.tipoDiasAnticipacion,
        );
        const minimo = Number(absenceType.diasAnticipacion);

        if (anticipacion < minimo) {
          error(
            req,
            "ANTICIPACION_VALERA_INSUFICIENTE",
            `${nombreTipo} debe solicitarse con mínimo ${minimo} días de anticipación.`,
            "fechaInicio",
          );
        }
      }

      const anioBeneficio = registroLegado
        ? obtenerAnio(data.fechaInicio)
        : await validarPoliticaFechaAusencia(req, data, absenceType);

      if (!anioBeneficio) return;

      if (
        !registroLegado &&
        ESTADOS_CONSUMO_AUSENCIA.has(data.estadoa_codigo) &&
        data.empleado_ID &&
        data.fechaInicio &&
        data.horasSolicitadas > 0
      ) {
        const ausenciasHoras = await obtenerAusenciasHoras(
          data.empleado_ID,
          ID,
          data.tipoAusencia_codigo,
          absenceType.politicaFecha === POLITICA_SEMANA_CUMPLEANOS
            ? POLITICA_SEMANA_CUMPLEANOS
            : null,
        );

        const horasMismoDia = round2(
          ausenciasHoras
            .filter((ausencia) => ausencia.fechaInicio === data.fechaInicio)
            .reduce(
              (total, ausencia) =>
                total + Number(ausencia.horasSolicitadas || 0),
              0,
            ),
        );

        if (
          maximoHorasSolicitud > 0 &&
          round2(horasMismoDia + data.horasSolicitadas) >
            maximoHorasSolicitud
        ) {
          error(
            req,
            "MAXIMO_HORAS_DIA_EXCEDIDO",
            `El máximo diario es ${maximoHorasSolicitud.toFixed(2)} horas. Para esa fecha ya hay ${horasMismoDia.toFixed(2)} horas reservadas.`,
            "horaFin",
          );
        }

        const inicioSemana = obtenerInicioSemana(data.fechaInicio);
        const finSemana = formatISODate(addDays(parseISODate(inicioSemana), 6));
        const ausenciasSemana = ausenciasHoras.filter(
          (ausencia) =>
            ausencia.fechaInicio >= inicioSemana &&
            ausencia.fechaInicio <= finSemana,
        );

        const maximoHorasSemana = Number(
          absenceType.maximoHorasSemana || 0,
        );
        if (maximoHorasSemana > 0) {
          const horasSemana = round2(
            ausenciasSemana.reduce(
              (total, ausencia) =>
                total + Number(ausencia.horasSolicitadas || 0),
              0,
            ),
          );

          if (
            round2(horasSemana + data.horasSolicitadas) > maximoHorasSemana
          ) {
            error(
              req,
              "MAXIMO_HORAS_SEMANA_EXCEDIDO",
              `El máximo semanal es ${maximoHorasSemana.toFixed(2)} horas, de lunes a domingo. En esa semana ya hay ${horasSemana.toFixed(2)} horas reservadas.`,
              "horaFin",
            );
          }
        }

        const maximoSolicitudesSemana = Number(
          absenceType.maximoSolicitudesSemana || 0,
        );
        if (
          maximoSolicitudesSemana > 0 &&
          ausenciasSemana.length + 1 > maximoSolicitudesSemana
        ) {
          error(
            req,
            "MAXIMO_SOLICITUDES_SEMANA_EXCEDIDO",
            `El máximo permitido es ${maximoSolicitudesSemana} solicitud(es) por semana.`,
            "fechaInicio",
          );
        }

        const saldo = await calcularSaldoBeneficioHoras(
          data.empleado_ID,
          data.tipoAusencia_codigo,
          anioBeneficio,
          ID,
        );

        if (data.horasSolicitadas > saldo.horasDisponibles) {
          error(
            req,
            "SALDO_HORAS_INSUFICIENTE",
            `La solicitud es de ${data.horasSolicitadas.toFixed(2)} horas y el saldo disponible para ${absenceType.descripcion} es ${saldo.horasDisponibles.toFixed(2)}.`,
            "horasSolicitadas",
          );
        }
      }
    } else {
      req.data.horaInicio = null;
      req.data.horaFin = null;
      req.data.horasSolicitadas = 0;
      data.horaInicio = null;
      data.horaFin = null;
      data.horasSolicitadas = 0;

      if (data.fechaInicio && data.fechaFin) {
        const diasCalculados = calcularDiasHabilesColombia(
          data.fechaInicio,
          data.fechaFin,
        );

        req.data.diasHabiles = diasCalculados;
        data.diasHabiles = diasCalculados;
      }

      if (
        !registroLegado &&
        absenceType.descuentaSaldo &&
        Number(data.diasHabiles) > 0 &&
        ["SOLICITADA", "APROBADA"].includes(data.estadoa_codigo)
      ) {
        const saldo = await calcularSaldoVacaciones(data.empleado_ID, ID);
        const available = Number(saldo.diasVacacionesDisponibles || 0);

        if (Number(data.diasHabiles) > available) {
          error(
            req,
            "SALDO_VACACIONES_INSUFICIENTE",
            `La solicitud es de ${data.diasHabiles} días y el saldo disponible es ${available.toFixed(2)}.`,
            "diasHabiles",
          );
        }
      }
    }

    if (
      !registroLegado &&
      ESTADOS_CONSUMO_AUSENCIA.has(data.estadoa_codigo) &&
      data.empleado_ID &&
      data.fechaInicio &&
      data.fechaFin
    ) {
      const overlap = await buscarAusenciaSuperpuesta(data, ID);

      if (overlap) {
        error(
          req,
          "AUSENCIA_SUPERPUESTA",
          "La solicitud se cruza con otra ausencia del empleado.",
          unidadConsumo === "HORAS" ? "horaInicio" : "fechaInicio",
        );
      }
    }

    if (!registroLegado && data.estadoa_codigo === "APROBADA") {
      if (!data.aprobadaPor_ID) {
        error(
          req,
          "APROBADOR_REQUERIDO",
          "Indica quién aprobó la ausencia.",
          "aprobadaPor_ID",
        );
      }
      if (!data.fechaAprobacion) req.data.fechaAprobacion = today();
    }

    if (data.estadoa_codigo === "RECHAZADA" && !data.motivo) {
      error(
        req,
        "MOTIVO_RECHAZO_REQUERIDO",
        "Indica el motivo del rechazo.",
        "motivo",
      );
    }
  });

  this.before("DELETE", AusenciasSrv, async (req) => {
    const ausencia = await currentRow(Ausencias, req);
    if (ausencia.origenRegistro === ORIGEN_AUTOSERVICIO) {
      rechazarMutacionAutoservicioAdmin(req);
    }
  });

  // ----------------------------------------------------------
  // CATÁLOGOS EDITABLES
  // ----------------------------------------------------------
  const editableCatalogs = {
    Cargos,
    EPS,
    ARL,
    FondosPension,
    FondosCesantias,
    CajasCompensacion,
  };

  for (const [serviceEntity, dbEntity] of Object.entries(editableCatalogs)) {
    this.before(["CREATE", "UPDATE"], serviceEntity, async (req) => {
      normalizeText(req.data, ["nombre", "descripcion"]);

      const previous =
        req.event === "UPDATE" ? await currentRow(dbEntity, req) : {};
      const data = { ...previous, ...req.data };
      const ID = data.ID || keyFrom(req);

      if (data.nombre) {
        const rows = await SELECT.from(dbEntity).columns("ID", "nombre");
        const normalizedName = data.nombre.toLocaleLowerCase("es-CO");
        const duplicate = rows.find(
          (row) =>
            row.ID !== ID &&
            typeof row.nombre === "string" &&
            row.nombre.trim().toLocaleLowerCase("es-CO") === normalizedName,
        );

        if (duplicate) {
          error(
            req,
            "NOMBRE_CATALOGO_DUPLICADO",
            `Ya existe un registro con el nombre ${data.nombre}.`,
            "nombre",
          );
        }
      }
    });

    this.before("DELETE", serviceEntity, (req) => {
      req.reject(
        405,
        "Los registros de catálogo no se eliminan físicamente. Usa el indicador Activo para inactivarlos.",
      );
    });
  }

  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  function esActivacionBorrador(req) {
    return req._?.event === "draftActivate";
  }

  function esPeticionDeSoporteAdmin(req) {
    if (
      req.target === SoportesAusenciaSrv ||
      req.target === SoportesAusenciaSrv?.drafts
    ) {
      return true;
    }

    const targetName = req.target?.name || "";
    if (
      targetName.includes(".Ausencias.soportes") ||
      targetName.includes(".Ausencias_soportes")
    ) {
      return true;
    }

    const url =
      req.req?.originalUrl ||
      req.req?.url ||
      req._?.req?.originalUrl ||
      req._?.req?.url ||
      "";

    return /\/(?:Ausencias(?:\([^)]*\))?\/soportes|Ausencias_soportes)(?:\([^)]*\))?(?:\/content)?(?:\?|$)/i.test(
      url,
    );
  }

  function esMutacionSoporteBorrador(req) {
    if (
      req.target?.isDraft ||
      req.target?.name?.endsWith(".drafts") ||
      req.event === "NEW" ||
      req.event === "CANCEL"
    ) {
      return true;
    }

    const parametroIsActive = [...(req.params || [])]
      .reverse()
      .find((param) => param?.IsActiveEntity !== undefined)?.IsActiveEntity;
    const valorIsActive =
      req.data?.IsActiveEntity !== undefined
        ? req.data.IsActiveEntity
        : parametroIsActive;

    if (
      valorIsActive === false ||
      String(valorIsActive).toLowerCase() === "false"
    ) {
      return true;
    }

    const url =
      req.req?.originalUrl ||
      req.req?.url ||
      req._?.req?.originalUrl ||
      req._?.req?.url ||
      "";
    return /IsActiveEntity(?:%20|\s)*=(?:%20|\s)*false/i.test(url);
  }

  async function obtenerAusenciaIDDeSoporteAdmin(req, esBorrador) {
    const params = req.params || [];
    const explicitParent = params.find((param) => param?.up__ID)?.up__ID;
    if (explicitParent) return explicitParent;
    if (req.data?.up__ID) return req.data.up__ID;
    if (req.data?.up_?.ID) return req.data.up_.ID;

    const attachmentID =
      req.data?.ID || [...params].reverse().find((param) => param?.ID)?.ID;

    if (attachmentID) {
      const fuentes = esBorrador
        ? [SoportesAusenciaSrv?.drafts, SoportesAusencia]
        : [SoportesAusencia, SoportesAusenciaSrv?.drafts];

      for (const fuente of fuentes.filter(Boolean)) {
        const soporte = await SELECT.one
          .from(fuente)
          .columns("up__ID")
          .where({ ID: attachmentID });
        if (soporte?.up__ID) return soporte.up__ID;
      }
    }

    const idsNavegacion = params
      .filter((param) => param?.ID)
      .map((param) => param.ID);
    if (["CREATE", "NEW"].includes(req.event)) {
      return idsNavegacion.at(-1) || null;
    }
    return idsNavegacion.length > 1
      ? idsNavegacion.at(-2)
      : null;
  }

  async function protegerMutacionSoporteAdmin(req) {
    if (esActivacionBorrador(req)) return;

    const esBorrador = esMutacionSoporteBorrador(req);
    const ausenciaID = await obtenerAusenciaIDDeSoporteAdmin(req, esBorrador);
    if (!ausenciaID) {
      error(
        req,
        "SOLICITUD_SOPORTE_NO_IDENTIFICADA",
        "No fue posible identificar la solicitud asociada al soporte.",
        "soportes",
      );
      return;
    }

    const fuenteAusencia = esBorrador ? AusenciasSrv.drafts : Ausencias;
    let ausencia = await SELECT.one
      .from(fuenteAusencia)
      .columns("ID", "empleado_ID", "estadoa_codigo", "origenRegistro")
      .where({ ID: ausenciaID });

    if (!ausencia) {
      error(
        req,
        "SOLICITUD_SOPORTE_NO_ENCONTRADA",
        "No existe la solicitud asociada al soporte.",
        "soportes",
      );
      return;
    }

    if (ausencia.origenRegistro === ORIGEN_AUTOSERVICIO) {
      rechazarMutacionAutoservicioAdmin(req, "soportes");
      return;
    }

    if (
      !(await bloquearEmpleadoParaReglas(
        req,
        ausencia.empleado_ID,
        esBorrador,
      ))
    ) {
      return;
    }

    if (!esBorrador) {
      const ausenciaActual = await SELECT.one
        .from(Ausencias)
        .columns("ID", "empleado_ID", "estadoa_codigo", "origenRegistro")
        .where({ ID: ausenciaID });

      if (
        !ausenciaActual ||
        ausenciaActual.empleado_ID !== ausencia.empleado_ID
      ) {
        error(
          req,
          "SOLICITUD_SOPORTE_MODIFICADA_CONCURRENTEMENTE",
          "La solicitud asociada al soporte cambió en otra sesión. Actualiza la información antes de continuar.",
          "soportes",
        );
        return;
      }
      ausencia = ausenciaActual;
    }

    if (!esBorrador && ausencia.estadoa_codigo !== "BORRADOR") {
      error(
        req,
        "SOPORTES_AUSENCIA_BLOQUEADOS",
        "Los soportes activos solo pueden modificarse mientras la solicitud está en borrador. Para otros estados, edita el draft administrativo.",
        "soportes",
      );
    }
  }

  function esTransicionEstadoAusenciaPermitida(origen, destino) {
    if (origen === destino) return true;

    const transiciones = {
      BORRADOR: new Set(["SOLICITADA", "CANCELADA"]),
      SOLICITADA: new Set(["APROBADA", "RECHAZADA", "CANCELADA"]),
      APROBADA: new Set(["FINALIZADA", "CANCELADA"]),
      RECHAZADA: new Set(),
      CANCELADA: new Set(),
      FINALIZADA: new Set(),
    };

    return transiciones[origen]?.has(destino) === true;
  }

  function validarRegistroLegadoAdministrativo(
    req,
    data,
    targetFecha = "fechaFin",
    targetEstado = "estadoa_codigo",
  ) {
    let valido = true;
    const estado = data.estadoa_codigo || "SOLICITADA";

    if (!ESTADOS_TERMINALES_LEGADO.has(estado)) {
      error(
        req,
        "ESTADO_REGISTRO_LEGADO_INVALIDO",
        "Una ausencia histórica debe registrarse como finalizada, rechazada o cancelada.",
        targetEstado,
      );
      valido = false;
    }

    const ultimaFecha = data.fechaFin || data.fechaInicio;
    if (ultimaFecha && ultimaFecha > today()) {
      error(
        req,
        "FECHA_REGISTRO_LEGADO_FUTURA",
        "Una ausencia histórica no puede finalizar en una fecha futura.",
        targetFecha,
      );
      valido = false;
    }

    return valido;
  }

  async function bloquearEmpleadoParaReglas(
    req,
    empleadoID,
    permitirInexistente = false,
  ) {
    const empleado = await SELECT.one
      .from(Empleados)
      .columns("ID")
      .where({ ID: empleadoID })
      .forUpdate({ wait: 10 });

    if (!empleado && !permitirInexistente) {
      error(
        req,
        "EMPLEADO_REGLAS_NO_ENCONTRADO",
        "No existe el empleado asociado al registro que se intenta modificar.",
        "empleado_ID",
      );
    }

    return Boolean(empleado) || permitirInexistente;
  }

  function parseISODate(value) {
    return new Date(`${value}T00:00:00.000Z`);
  }

  function formatISODate(value) {
    return value.toISOString().slice(0, 10);
  }

  function addDays(value, days) {
    const result = new Date(value);

    result.setUTCDate(result.getUTCDate() + days);

    return result;
  }

  function differenceInDays(start, end) {
    return Math.max(
      0,
      Math.floor((parseISODate(end) - parseISODate(start)) / MS_PER_DAY),
    );
  }

  /**
   * Algoritmo de Meeus/Jones/Butcher para obtener
   * el Domingo de Pascua del calendario gregoriano.
   */
  function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);

    const month = Math.floor((h + l - 7 * m + 114) / 31);

    const day = ((h + l - 7 * m + 114) % 31) + 1;

    return new Date(Date.UTC(year, month - 1, day));
  }

  /**
   * La fecha se mantiene si ya es lunes.
   * En cualquier otro caso se mueve al lunes siguiente.
   */
  function followingMonday(value) {
    const dayOfWeek = value.getUTCDay();

    const daysToMonday = (8 - dayOfWeek) % 7;

    return addDays(value, daysToMonday);
  }

  const colombianHolidaysCache = new Map();

  function colombianHolidays(year) {
    if (colombianHolidaysCache.has(year)) {
      return colombianHolidaysCache.get(year);
    }

    const holidays = new Set();

    const addHoliday = (date) => {
      holidays.add(formatISODate(date));
    };

    const fixedDate = (month, day) => new Date(Date.UTC(year, month - 1, day));

    // Festivos que permanecen en la fecha correspondiente.
    [
      [1, 1], // Año Nuevo
      [5, 1], // Día del Trabajo
      [7, 20], // Independencia
      [8, 7], // Batalla de Boyacá
      [12, 8], // Inmaculada Concepción
      [12, 25], // Navidad
    ].forEach(([month, day]) => {
      addHoliday(fixedDate(month, day));
    });

    // Festivos trasladados al lunes siguiente.
    // Festivos de fecha fija trasladados al lunes siguiente.
    const holidaysMovedToMonday = [
      [1, 6], // Reyes Magos
      [3, 19], // San José
      [6, 29], // San Pedro y San Pablo
      [8, 15], // Asunción de la Virgen
      [10, 12], // Día de la Raza
      [11, 1], // Todos los Santos
      [11, 11], // Independencia de Cartagena
    ];

    // Desde 2026: Nuestra Señora del Rosario de Chiquinquirá.
    // La celebración es el 9 de julio y el descanso se traslada
    // conforme a la Ley 51 de 1983.
    if (year >= 2026) {
      holidaysMovedToMonday.push([7, 9]);
    }

    holidaysMovedToMonday.forEach(([month, day]) => {
      addHoliday(followingMonday(fixedDate(month, day)));
    });

    const easter = easterSunday(year);

    // Semana Santa.
    addHoliday(addDays(easter, -3)); // Jueves Santo
    addHoliday(addDays(easter, -2)); // Viernes Santo

    // Festivos religiosos trasladados al lunes.
    addHoliday(followingMonday(addDays(easter, 39))); // Ascensión

    addHoliday(followingMonday(addDays(easter, 60))); // Corpus Christi

    addHoliday(followingMonday(addDays(easter, 68))); // Sagrado Corazón

    colombianHolidaysCache.set(year, holidays);

    return holidays;
  }

  function isColombianHoliday(value) {
    const year = value.getUTCFullYear();

    return colombianHolidays(year).has(formatISODate(value));
  }

  function calcularDiasHabilesColombia(fechaInicio, fechaFin) {
    return absenceRules.calcularDiasHabilesColombia(fechaInicio, fechaFin);
  }

  function round2(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }


  function obtenerAnio(fecha) {
    return fecha ? Number(fecha.slice(0, 4)) : null;
  }

  function esAnioBisiesto(anio) {
    return anio % 4 === 0 && (anio % 100 !== 0 || anio % 400 === 0);
  }

  function obtenerFechaCumpleanios(fechaNacimiento, anio) {
    if (!fechaNacimiento || !anio) return null;

    let mesDia = fechaNacimiento.slice(5, 10);
    if (mesDia === "02-29" && !esAnioBisiesto(anio)) {
      mesDia = "02-28";
    }

    return `${anio}-${mesDia}`;
  }

  function obtenerOcurrenciaCumpleanios(fechaSolicitud, fechaNacimiento) {
    if (!fechaSolicitud || !fechaNacimiento) return null;

    const anioSolicitud = obtenerAnio(fechaSolicitud);

    for (const anio of [anioSolicitud - 1, anioSolicitud, anioSolicitud + 1]) {
      const fechaCumpleanios = obtenerFechaCumpleanios(fechaNacimiento, anio);
      const semanaInicio = obtenerInicioSemana(fechaCumpleanios);
      const semanaFin = formatISODate(addDays(parseISODate(semanaInicio), 6));

      if (fechaSolicitud >= semanaInicio && fechaSolicitud <= semanaFin) {
        return { anio, fechaCumpleanios, semanaInicio, semanaFin };
      }
    }

    return null;
  }

  function obtenerAnioBeneficioDesdeFecha(
    tipoAusencia,
    fechaSolicitud,
    fechaNacimiento,
  ) {
    if (tipoAusencia?.politicaFecha !== POLITICA_SEMANA_CUMPLEANOS) {
      return obtenerAnio(fechaSolicitud);
    }

    return (
      obtenerOcurrenciaCumpleanios(fechaSolicitud, fechaNacimiento)?.anio ??
      obtenerAnio(fechaSolicitud)
    );
  }

  async function validarPoliticaFechaAusencia(req, data, tipoAusencia) {
    if (!data.fechaInicio) return null;

    if (tipoAusencia.politicaFecha !== POLITICA_SEMANA_CUMPLEANOS) {
      return obtenerAnio(data.fechaInicio);
    }

    const empleado = await SELECT.one
      .from(Empleados)
      .columns(
        "ID",
        "fechaNacimiento",
        "fechaIngreso",
        "fechaRetiro",
        "estado_codigo",
      )
      .where({ ID: data.empleado_ID });

    if (!empleado?.fechaNacimiento) {
      error(
        req,
        "FECHA_NACIMIENTO_REQUERIDA",
        "El empleado debe tener registrada su fecha de nacimiento para solicitar el beneficio de cumpleaños.",
        "fechaInicio",
      );
      return null;
    }

    const ocurrencia = obtenerOcurrenciaCumpleanios(
      data.fechaInicio,
      empleado.fechaNacimiento,
    );

    if (!ocurrencia) {
      error(
        req,
        "FECHA_FUERA_SEMANA_CUMPLEANOS",
        "El beneficio de cumpleaños solo puede solicitarse de lunes a domingo en la misma semana del cumpleaños del empleado.",
        "fechaInicio",
      );
      return null;
    }

    if (
      empleado.estado_codigo !== "AC" ||
      !empleado.fechaIngreso ||
      empleado.fechaIngreso > data.fechaInicio ||
      (empleado.fechaRetiro && empleado.fechaRetiro < data.fechaInicio)
    ) {
      error(
        req,
        "EMPLEADO_NO_ACTIVO_EN_FECHA",
        "El beneficio de cumpleaños requiere que la relación laboral esté activa en la fecha seleccionada.",
        "fechaInicio",
      );
    }

    if (tipoAusencia.requiereContratoVigente) {
      const contratos = await SELECT.from(Contratos)
        .columns("ID", "fechaInicio", "fechaFin")
        .where({
          empleado_ID: data.empleado_ID,
          vigente: true,
        });

      const contrato = contratos.find(
        (actual) =>
          actual.fechaInicio <= data.fechaInicio &&
          (!actual.fechaFin || actual.fechaFin >= data.fechaInicio),
      );

      if (!contrato) {
        error(
          req,
          "CONTRATO_VIGENTE_REQUERIDO",
          "El beneficio de cumpleaños requiere un contrato vigente.",
          "fechaInicio",
        );
      }
    }

    return ocurrencia.anio;
  }

  function tieneSegundos(value) {
    if (!value || typeof value !== "string") return false;

    const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (!match) return false;

    return Number(match[3] || 0) !== 0;
  }

  function minutosDesdeMedianoche(value) {
    if (!value || typeof value !== "string") return null;

    const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (!match) return null;

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3] || 0);

    if (hours > 23 || minutes > 59 || seconds > 59) return null;

    return hours * 60 + minutes + seconds / 60;
  }

  function calcularHorasSolicitadas(horaInicio, horaFin) {
    return absenceRules.calcularHorasSolicitadas(horaInicio, horaFin);
  }

  function calcularDiasAnticipacion(
    fechaSolicitud,
    fechaInicio,
    tipoDias = "CALENDARIO",
  ) {
    return absenceRules.calcularDiasAnticipacion(
      fechaSolicitud,
      fechaInicio,
      tipoDias,
    );
  }

  function obtenerInicioSemana(fecha) {
    return absenceRules.obtenerInicioSemanaISO(fecha);
  }

  function fechasSeCruzan(inicio1, fin1, inicio2, fin2) {
    return absenceRules.fechasSeCruzan(inicio1, fin1, inicio2, fin2);
  }

  function horasSeCruzan(inicio1, fin1, inicio2, fin2) {
    return absenceRules.horasSeCruzan(inicio1, fin1, inicio2, fin2);
  }

  /**
   * Valida el árbol completo de ausencias justo antes de activar el draft
   * del empleado. En una composición draft, el botón Aplicar activa el root
   * Empleados; por eso un SAVE registrado únicamente sobre Ausencias.drafts
   * no es suficiente para garantizar el bloqueo.
   */
  async function validarAusenciasBorradorEmpleado(req) {
    const empleadoID = keyFrom(req);
    if (!empleadoID) return;

    const columnasAusencia = camposPersistidosAusencia().map(
      ([nombre]) => nombre,
    );

    const borradores = await SELECT.from(AusenciasSrv.drafts)
      .columns(...columnasAusencia)
      .where({ empleado_ID: empleadoID });

    const tipos = await SELECT.from(TiposAusencia).columns(
      "codigo",
      "descripcion",
      "unidadConsumo",
      "descuentaSaldo",
      "controlaSaldoHoras",
      "horasAnuales",
      "diasAnticipacion",
      "tipoDiasAnticipacion",
      "minimoHorasSolicitud",
      "maximoHorasDia",
      "maximoHorasSemana",
      "maximoSolicitudesSemana",
      "requiereMismoDia",
      "permiteCruzarAnio",
      "politicaFecha",
      "requiereContratoVigente",
      "requiereSoporte",
    );

    const tipoPorCodigo = new Map(tipos.map((tipo) => [tipo.codigo, tipo]));
    const codigosBeneficiosHoras = new Set(
      tipos
        .filter((tipo) => tipo.controlaSaldoHoras)
        .map((tipo) => tipo.codigo),
    );

    const activas = await SELECT.from(Ausencias)
      .columns(...columnasAusencia)
      .where({ empleado_ID: empleadoID });

    if (
      !(await validarAutoservicioSinCambiosEnBorrador(
        req,
        activas,
        borradores,
      ))
    ) {
      return;
    }

    // Las solicitudes de autoservicio ya fueron comparadas byte a byte en
    // sus campos persistidos y en la composición de soportes. Al estar sin
    // cambios, no se revalidan con reglas dependientes del tiempo o del saldo:
    // eso permitiría que bloquearan la edición de otros datos del empleado.
    const borradoresAdministrativos = borradores.filter(esRegistroLegado);
    if (borradoresAdministrativos.length === 0) return;

    const empleado = await SELECT.one
      .from(Empleados)
      .columns("fechaNacimiento", "fechaIngreso", "fechaRetiro")
      .where({ ID: empleadoID });

    const activasPorID = new Map(
      activas.map((ausencia) => [ausencia.ID, ausencia]),
    );
    const borradoresPayloadPorID = new Map(
      (Array.isArray(req.data?.ausencias) ? req.data.ausencias : [])
        .filter((ausencia) => ausencia?.ID)
        .map((ausencia) => [ausencia.ID, ausencia]),
    );
    const idsBorrador = new Set(borradores.map((ausencia) => ausencia.ID));

    // El borrador sustituye a la versión activa con el mismo ID. Así las
    // validaciones comunes usan exactamente el árbol que se va a activar.
    const ausenciasEfectivas = [
      ...activas.filter((ausencia) => !idsBorrador.has(ausencia.ID)),
      ...borradores,
    ];
    const ausenciasQueConsumen = ausenciasEfectivas.filter((ausencia) =>
      ESTADOS_CONSUMO_AUSENCIA.has(
        ausencia.estadoa_codigo || "SOLICITADA",
      ),
    );

    for (const ausencia of borradoresAdministrativos) {
      const tipo = tipoPorCodigo.get(ausencia.tipoAusencia_codigo);
      const estado = ausencia.estadoa_codigo || "SOLICITADA";
      const registroLegado = esRegistroLegado(ausencia);

      if (!tipo) {
        error(
          req,
          "TIPO_AUSENCIA_INVALIDO",
          "Selecciona un tipo de ausencia válido.",
          "ausencias",
        );
        return;
      }

      if (
        ![ORIGEN_AUTOSERVICIO, ORIGEN_LEGADO_RRHH].includes(
          ausencia.origenRegistro,
        )
      ) {
        error(
          req,
          "ORIGEN_AUSENCIA_INVALIDO",
          "No fue posible determinar el origen de la ausencia.",
          "ausencias",
        );
        return;
      }

      if (
        ausencia.origenRegistro === ORIGEN_AUTOSERVICIO &&
        !activasPorID.has(ausencia.ID)
      ) {
        error(
          req,
          "ORIGEN_AUTOSERVICIO_NO_PERMITIDO",
          "Las solicitudes de autoservicio solo pueden crearse desde la aplicación de ausencias del empleado.",
          "ausencias",
        );
        return;
      }

      if (
        ausencia.fechaInicio &&
        ausencia.fechaFin &&
        ausencia.fechaFin < ausencia.fechaInicio
      ) {
        error(
          req,
          "FECHA_FIN_AUSENCIA_INVALIDA",
          "La fecha final no puede ser anterior a la fecha inicial.",
          "ausencias",
        );
        return;
      }

      if (
        registroLegado &&
        !validarRegistroLegadoAdministrativo(
          req,
          ausencia,
          "ausencias",
          "ausencias",
        )
      ) {
        return;
      }

      if (!registroLegado) {
        const versionActiva = activasPorID.get(ausencia.ID);

        if (
          versionActiva?.estadoa_codigo &&
          versionActiva.estadoa_codigo !== estado &&
          !esTransicionEstadoAusenciaPermitida(
            versionActiva.estadoa_codigo,
            estado,
          )
        ) {
          error(
            req,
            "TRANSICION_ESTADO_AUSENCIA_INVALIDA",
            `No se permite cambiar una ausencia de ${versionActiva.estadoa_codigo} a ${estado}.`,
            "ausencias",
          );
          return;
        }

        if (estado === "APROBADA" && !ausencia.aprobadaPor_ID) {
          error(
            req,
            "APROBADOR_REQUERIDO",
            "Indica quién aprobó la ausencia.",
            "ausencias",
          );
          return;
        }

        if (estado === "APROBADA" && !ausencia.fechaAprobacion) {
          const fechaAprobacion = today();
          ausencia.fechaAprobacion = fechaAprobacion;
          const ausenciaPayload = borradoresPayloadPorID.get(ausencia.ID);
          if (ausenciaPayload) ausenciaPayload.fechaAprobacion = fechaAprobacion;
        }

        if (
          estado === "RECHAZADA" &&
          !String(ausencia.motivo || "").trim()
        ) {
          error(
            req,
            "MOTIVO_RECHAZO_REQUERIDO",
            "Indica el motivo del rechazo.",
            "ausencias",
          );
          return;
        }
      }

      if (registroLegado && tipo.unidadConsumo === "HORAS") {
        if (!ausencia.fechaInicio || !ausencia.horaInicio || !ausencia.horaFin) {
          error(
            req,
            "HORARIO_AUSENCIA_REQUERIDO",
            "Indica la fecha, la hora inicial y la hora final de la ausencia histórica.",
            "ausencias",
          );
          return;
        }

        if (
          tipo.requiereMismoDia &&
          ausencia.fechaFin &&
          ausencia.fechaInicio !== ausencia.fechaFin
        ) {
          error(
            req,
            "AUSENCIA_MISMO_DIA_REQUERIDA",
            "Una ausencia expresada en horas debe corresponder a una sola fecha.",
            "ausencias",
          );
          return;
        }

        if (
          tieneSegundos(ausencia.horaInicio) ||
          tieneSegundos(ausencia.horaFin) ||
          calcularHorasSolicitadas(ausencia.horaInicio, ausencia.horaFin) <= 0
        ) {
          error(
            req,
            "HORARIO_AUSENCIA_INVALIDO",
            "La hora final debe ser posterior a la inicial y las horas deben expresarse con precisión de minutos.",
            "ausencias",
          );
          return;
        }
      }

      if (
        !(await validarSoportesAusencia(
          req,
          tipo,
          estado,
          ausencia.ID,
          "ausencias",
          "draft",
          !registroLegado,
        ))
      ) {
        return;
      }
    }

    const borradoresAutoservicioQueConsumen = borradoresAdministrativos.filter(
      (ausencia) =>
        !esRegistroLegado(ausencia) &&
        ESTADOS_CONSUMO_AUSENCIA.has(
          ausencia.estadoa_codigo || "SOLICITADA",
        ),
      );

    for (const ausencia of borradoresAutoservicioQueConsumen) {
      if (!ausencia.fechaInicio || !ausencia.fechaFin) continue;

      const unidad =
        tipoPorCodigo.get(ausencia.tipoAusencia_codigo)?.unidadConsumo ||
        ausencia.unidadConsumo ||
        "DIAS";

      for (const otra of ausenciasQueConsumen) {
        if (
          otra.ID === ausencia.ID ||
          !otra.fechaInicio ||
          !otra.fechaFin ||
          !fechasSeCruzan(
            ausencia.fechaInicio,
            ausencia.fechaFin,
            otra.fechaInicio,
            otra.fechaFin,
          )
        ) {
          continue;
        }

        const unidadOtra =
          tipoPorCodigo.get(otra.tipoAusencia_codigo)?.unidadConsumo ||
          otra.unidadConsumo ||
          "DIAS";

        if (
          unidad === "HORAS" &&
          unidadOtra === "HORAS" &&
          ausencia.fechaInicio === otra.fechaInicio &&
          !horasSeCruzan(
            ausencia.horaInicio,
            ausencia.horaFin,
            otra.horaInicio,
            otra.horaFin,
          )
        ) {
          continue;
        }

        error(
          req,
          "AUSENCIA_SUPERPUESTA",
          "No se puede guardar: la ausencia se superpone con otra ausencia del empleado.",
          "ausencias",
        );
        return;
      }
    }

    const borradoresVacacionesAutoservicio =
      borradoresAdministrativos.filter((ausencia) => {
        const tipo = tipoPorCodigo.get(ausencia.tipoAusencia_codigo);
        return (
          !esRegistroLegado(ausencia) &&
          tipo?.descuentaSaldo === true &&
          ["SOLICITADA", "APROBADA"].includes(
            ausencia.estadoa_codigo || "SOLICITADA",
          )
        );
      });

    if (borradoresVacacionesAutoservicio.length > 0) {
      const saldoVacaciones = await calcularSaldoVacaciones(empleadoID);
      const totalVacacionesConsumidas = round2(
        ausenciasEfectivas
          .filter((ausencia) => {
            const tipo = tipoPorCodigo.get(ausencia.tipoAusencia_codigo);
            return (
              tipo?.descuentaSaldo === true &&
              ["SOLICITADA", "APROBADA", "FINALIZADA"].includes(
                ausencia.estadoa_codigo || "SOLICITADA",
              )
            );
          })
          .reduce((total, ausencia) => {
            const dias = idsBorrador.has(ausencia.ID)
              ? calcularDiasHabilesColombia(
                  ausencia.fechaInicio,
                  ausencia.fechaFin,
                )
              : Number(ausencia.diasHabiles || 0);
            return total + Number(dias || 0);
          }, 0),
      );

      if (
        totalVacacionesConsumidas >
        Number(saldoVacaciones.diasVacacionesCausados || 0)
      ) {
        error(
          req,
          "SALDO_VACACIONES_INSUFICIENTE",
          `No se puede guardar: el total de vacaciones disfrutadas o reservadas sería ${totalVacacionesConsumidas.toFixed(2)} días y el empleado solo ha causado ${Number(saldoVacaciones.diasVacacionesCausados || 0).toFixed(2)} días.`,
          "ausencias",
        );
        return;
      }
    }

    if (codigosBeneficiosHoras.size === 0) return;

    const beneficiosHorasQueConsumen = ausenciasQueConsumen
      .filter((ausencia) =>
        codigosBeneficiosHoras.has(ausencia.tipoAusencia_codigo),
      )
      .map((ausencia) => {
        const horasCalculadas = calcularHorasSolicitadas(
          ausencia.horaInicio,
          ausencia.horaFin,
        );

        return {
          ...ausencia,
          _horas:
            horasCalculadas > 0
              ? horasCalculadas
              : Number(ausencia.horasSolicitadas || 0),
        };
      });

    const borradoresBeneficiosHoras = borradoresAdministrativos.filter(
      (ausencia) =>
        !esRegistroLegado(ausencia) &&
        codigosBeneficiosHoras.has(ausencia.tipoAusencia_codigo),
    );
    const perteneceMismaBolsa = (otra, ausencia, tipo) =>
      tipo.politicaFecha === POLITICA_SEMANA_CUMPLEANOS
        ? tipoPorCodigo.get(otra.tipoAusencia_codigo)?.politicaFecha ===
          POLITICA_SEMANA_CUMPLEANOS
        : otra.tipoAusencia_codigo === ausencia.tipoAusencia_codigo;

    for (const ausencia of borradoresBeneficiosHoras) {
      const tipo = tipoPorCodigo.get(ausencia.tipoAusencia_codigo);
      const estado = ausencia.estadoa_codigo || "SOLICITADA";
      const nombreTipo = tipo.descripcion || "el beneficio por horas";

      if (!ausencia.fechaInicio) {
        error(
          req,
          "FECHA_VALERA_REQUERIDA",
          `Indica la fecha en la que se utilizará ${nombreTipo}.`,
          "ausencias",
        );
        return;
      }

      if (
        tipo.requiereMismoDia &&
        ausencia.fechaFin &&
        ausencia.fechaInicio !== ausencia.fechaFin
      ) {
        error(
          req,
          "VALERA_MISMO_DIA_REQUERIDO",
          `${nombreTipo} debe solicitarse para una sola fecha.`,
          "ausencias",
        );
        return;
      }

      if (!ausencia.horaInicio || !ausencia.horaFin) {
        error(
          req,
          "HORARIO_VALERA_REQUERIDO",
          `Indica la hora inicial y la hora final de ${nombreTipo}.`,
          "ausencias",
        );
        return;
      }

      if (
        tieneSegundos(ausencia.horaInicio) ||
        tieneSegundos(ausencia.horaFin)
      ) {
        error(
          req,
          "VALERA_SOLO_HORAS_MINUTOS",
          `${nombreTipo} solo permite seleccionar horas y minutos.`,
          "ausencias",
        );
        return;
      }

      const horas = calcularHorasSolicitadas(
        ausencia.horaInicio,
        ausencia.horaFin,
      );

      if (horas <= 0) {
        error(
          req,
          "HORA_FIN_INVALIDA",
          "La hora final debe ser posterior a la hora inicial.",
          "ausencias",
        );
        return;
      }

      const minimoHorasSolicitud = Number(tipo.minimoHorasSolicitud || 0);
      if (minimoHorasSolicitud > 0 && horas < minimoHorasSolicitud) {
        error(
          req,
          "MINIMO_HORAS_SOLICITUD_NO_ALCANZADO",
          `No se puede guardar: ${nombreTipo} debe solicitarse por ${minimoHorasSolicitud.toFixed(2)} horas.`,
          "ausencias",
        );
        return;
      }

      const maximoHorasSolicitud = Number(tipo.maximoHorasDia || 0);
      if (maximoHorasSolicitud > 0 && horas > maximoHorasSolicitud) {
        error(
          req,
          "MAXIMO_HORAS_SOLICITUD_EXCEDIDO",
          `No se puede guardar: cada solicitud de ${nombreTipo} puede ser de máximo ${maximoHorasSolicitud.toFixed(2)} horas. La solicitud actual corresponde a ${horas.toFixed(2)} horas.`,
          "ausencias",
        );
        return;
      }

      if (
        tipo.permiteCruzarAnio === false &&
        ausencia.fechaFin &&
        obtenerAnio(ausencia.fechaInicio) !== obtenerAnio(ausencia.fechaFin)
      ) {
        error(
          req,
          "VALERA_CRUCE_ANIO_NO_PERMITIDO",
          `${nombreTipo} no puede cruzar de un año a otro.`,
          "ausencias",
        );
        return;
      }

      // Solo se vuelve a exigir anticipación cuando se crea la ausencia o
      // cuando cambia su fecha/tipo respecto de la versión activa.
      const versionActiva = activasPorID.get(ausencia.ID);
      const fechaOTipoModificado =
        !versionActiva ||
        versionActiva.fechaInicio !== ausencia.fechaInicio ||
        versionActiva.tipoAusencia_codigo !== ausencia.tipoAusencia_codigo;

      const diasAnticipacion = Number(tipo.diasAnticipacion || 0);
      if (fechaOTipoModificado && diasAnticipacion > 0) {
        const anticipacion = calcularDiasAnticipacion(
          today(),
          ausencia.fechaInicio,
          tipo.tipoDiasAnticipacion,
        );

        if (anticipacion < diasAnticipacion) {
          error(
            req,
            "ANTICIPACION_VALERA_INSUFICIENTE",
            `No se puede guardar: ${nombreTipo} debe solicitarse con mínimo ${diasAnticipacion} días de anticipación.`,
            "ausencias",
          );
          return;
        }
      }

      const anioBeneficio = await validarPoliticaFechaAusencia(
        req,
        { ...ausencia, empleado_ID: empleadoID },
        tipo,
      );

      if (!anioBeneficio) return;

      // Los límites de consumo aplican solo a estados que reservan o consumen.
      if (!ESTADOS_CONSUMO_AUSENCIA.has(estado)) continue;

      const totalDia = round2(
        beneficiosHorasQueConsumen
          .filter(
            (otra) =>
              perteneceMismaBolsa(otra, ausencia, tipo) &&
              otra.fechaInicio === ausencia.fechaInicio,
          )
          .reduce((total, otra) => total + Number(otra._horas || 0), 0),
      );

      if (maximoHorasSolicitud > 0 && totalDia > maximoHorasSolicitud) {
        error(
          req,
          "MAXIMO_HORAS_DIA_EXCEDIDO",
          `No se puede guardar: el máximo diario de ${nombreTipo} es ${maximoHorasSolicitud.toFixed(2)} horas. Para ${ausencia.fechaInicio} el total sería ${totalDia.toFixed(2)} horas.`,
          "ausencias",
        );
        return;
      }

      const maximoHorasSemana = Number(tipo.maximoHorasSemana || 0);
      const inicioSemana = obtenerInicioSemana(ausencia.fechaInicio);
      const finSemana = formatISODate(
        addDays(parseISODate(inicioSemana), 6),
      );

      if (maximoHorasSemana > 0) {
        const totalSemana = round2(
          beneficiosHorasQueConsumen
            .filter(
              (otra) =>
                perteneceMismaBolsa(otra, ausencia, tipo) &&
                otra.fechaInicio >= inicioSemana &&
                otra.fechaInicio <= finSemana,
            )
            .reduce((total, otra) => total + Number(otra._horas || 0), 0),
        );

        if (totalSemana > maximoHorasSemana) {
          error(
            req,
            "MAXIMO_HORAS_SEMANA_EXCEDIDO",
            `No se puede guardar: el máximo semanal de ${nombreTipo} es ${maximoHorasSemana.toFixed(2)} horas, de lunes a domingo. En la semana ${inicioSemana} a ${finSemana} el total sería ${totalSemana.toFixed(2)} horas.`,
            "ausencias",
          );
          return;
        }
      }

      const maximoSolicitudesSemana = Number(
        tipo.maximoSolicitudesSemana || 0,
      );
      const solicitudesSemana = beneficiosHorasQueConsumen.filter(
        (otra) =>
          perteneceMismaBolsa(otra, ausencia, tipo) &&
          otra.fechaInicio >= inicioSemana &&
          otra.fechaInicio <= finSemana,
      ).length;

      if (
        maximoSolicitudesSemana > 0 &&
        solicitudesSemana > maximoSolicitudesSemana
      ) {
        error(
          req,
          "MAXIMO_SOLICITUDES_SEMANA_EXCEDIDO",
          `No se puede guardar: ${nombreTipo} permite máximo ${maximoSolicitudesSemana} solicitud(es) por semana.`,
          "ausencias",
        );
        return;
      }

      // Saldo anual efectivo: activas no reemplazadas + todas las del draft.
      const anio = anioBeneficio;
      const saldoConfigurado =
        ausencia.tipoAusencia_codigo === "VE"
          ? await SELECT.one
              .from(SaldosValeraEmocional)
              .where({ empleado_ID: empleadoID, anio })
          : null;

      const horasAsignadas = round2(
        Number(saldoConfigurado?.horasBase ?? tipo.horasAnuales ?? 0) +
          Number(saldoConfigurado?.horasAjuste || 0),
      );

      const totalAnio = round2(
        beneficiosHorasQueConsumen
          .filter(
            (otra) =>
              perteneceMismaBolsa(otra, ausencia, tipo) &&
              obtenerAnioBeneficioDesdeFecha(
                tipo,
                otra.fechaInicio,
                empleado?.fechaNacimiento,
              ) === anio,
          )
          .reduce((total, otra) => total + Number(otra._horas || 0), 0),
      );

      if (totalAnio > horasAsignadas) {
        error(
          req,
          "SALDO_HORAS_INSUFICIENTE",
          `No se puede guardar: para ${nombreTipo} en ${anio} hay ${horasAsignadas.toFixed(2)} horas asignadas y el total solicitado/reservado sería ${totalAnio.toFixed(2)} horas.`,
          "ausencias",
        );
        return;
      }
    }
  }

  async function validarSoportesAusencia(
    req,
    tipoAusencia,
    estado,
    ausenciaID,
    target = "soportes",
    fuente = "active",
    exigirSoporteRequerido = true,
  ) {
    const soportes = await obtenerSoportesAusencia(ausenciaID, fuente);
    if (
      ESTADOS_CONSUMO_AUSENCIA.has(estado) &&
      exigirSoporteRequerido &&
      tipoAusencia.requiereSoporte &&
      soportes.length === 0
    ) {
      error(
        req,
        "SOPORTE_AUSENCIA_REQUERIDO",
        `${tipoAusencia.descripcion} requiere al menos un soporte antes de guardar.`,
        target,
      );
      return false;
    }

    if (soportes.some((soporte) => soporte.status !== "Clean")) {
      error(
        req,
        "SOPORTE_AUSENCIA_NO_VALIDADO",
        "Todos los soportes deben terminar de cargarse y superar la validación de seguridad antes de guardar.",
        target,
      );
      return false;
    }

    return true;
  }

  async function obtenerSoportesAusencia(ausenciaID, fuente = "active") {
    if (!ausenciaID) return [];

    const entidad =
      fuente === "draft" ? SoportesAusenciaSrv?.drafts : SoportesAusencia;
    if (!entidad) return [];

    return SELECT.from(entidad).columns("ID", "status").where({
      up__ID: ausenciaID,
    });
  }

  async function obtenerAusenciasHoras(
    empleadoID,
    ausenciaExcluirID = null,
    tipoAusenciaCodigo = null,
    politicaFecha = null,
  ) {
    if (!empleadoID) return [];

    const tiposHoras = await SELECT.from(TiposAusencia)
      .columns("codigo", "politicaFecha")
      .where({ controlaSaldoHoras: true });

    const codigos = new Set(tiposHoras.map((tipo) => tipo.codigo));
    if (codigos.size === 0) return [];
    const codigosFiltrados = politicaFecha
      ? new Set(
          tiposHoras
            .filter((tipo) => tipo.politicaFecha === politicaFecha)
            .map((tipo) => tipo.codigo),
        )
      : tipoAusenciaCodigo
        ? new Set([tipoAusenciaCodigo])
        : codigos;

    const ausencias = await SELECT.from(Ausencias)
      .columns(
        "ID",
        "tipoAusencia_codigo",
        "estadoa_codigo",
        "fechaInicio",
        "fechaFin",
        "horaInicio",
        "horaFin",
        "horasSolicitadas",
        "unidadConsumo",
      )
      .where({ empleado_ID: empleadoID });

    return ausencias.filter(
      (ausencia) =>
        ausencia.ID !== ausenciaExcluirID &&
        codigos.has(ausencia.tipoAusencia_codigo) &&
        codigosFiltrados.has(ausencia.tipoAusencia_codigo) &&
        ESTADOS_CONSUMO_AUSENCIA.has(ausencia.estadoa_codigo),
    );
  }

  async function buscarAusenciaSuperpuesta(data, ausenciaExcluirID = null) {
    const tipos = await SELECT.from(TiposAusencia).columns(
      "codigo",
      "unidadConsumo",
    );
    const unidadPorTipo = new Map(
      tipos.map((tipo) => [tipo.codigo, tipo.unidadConsumo || "DIAS"]),
    );

    const ausencias = await SELECT.from(Ausencias)
      .columns(
        "ID",
        "tipoAusencia_codigo",
        "estadoa_codigo",
        "fechaInicio",
        "fechaFin",
        "horaInicio",
        "horaFin",
        "unidadConsumo",
      )
      .where({ empleado_ID: data.empleado_ID });

    for (const ausencia of ausencias) {
      if (
        ausencia.ID === ausenciaExcluirID ||
        !ESTADOS_CONSUMO_AUSENCIA.has(ausencia.estadoa_codigo) ||
        !fechasSeCruzan(
          data.fechaInicio,
          data.fechaFin,
          ausencia.fechaInicio,
          ausencia.fechaFin,
        )
      ) {
        continue;
      }

      const unidadExistente =
        ausencia.unidadConsumo ||
        unidadPorTipo.get(ausencia.tipoAusencia_codigo) ||
        "DIAS";

      if (
        data.unidadConsumo === "HORAS" &&
        unidadExistente === "HORAS" &&
        data.fechaInicio === data.fechaFin &&
        ausencia.fechaInicio === ausencia.fechaFin &&
        data.fechaInicio === ausencia.fechaInicio
      ) {
        if (
          !horasSeCruzan(
            data.horaInicio,
            data.horaFin,
            ausencia.horaInicio,
            ausencia.horaFin,
          )
        ) {
          continue;
        }
      }

      return ausencia;
    }

    return null;
  }

  async function calcularSaldoBeneficioHoras(
    empleadoID,
    tipoAusenciaCodigo,
    anio = obtenerAnio(today()),
    ausenciaExcluirID = null,
  ) {
    const resultadoVacio = {
      anio,
      horasAsignadas: 0,
      horasUtilizadas: 0,
      horasReservadas: 0,
      horasDisponibles: 0,
    };

    if (!empleadoID || !tipoAusenciaCodigo || !anio) return resultadoVacio;

    const tipoAusencia = await SELECT.one
      .from(TiposAusencia)
      .columns("codigo", "horasAnuales", "politicaFecha")
      .where({
        codigo: tipoAusenciaCodigo,
        controlaSaldoHoras: true,
      });

    if (!tipoAusencia) return resultadoVacio;

    const saldoConfigurado =
      tipoAusenciaCodigo === "VE"
        ? await SELECT.one
            .from(SaldosValeraEmocional)
            .where({ empleado_ID: empleadoID, anio })
        : null;

    const horasBase = Number(
      saldoConfigurado?.horasBase ?? tipoAusencia.horasAnuales ?? 0,
    );
    const horasAjuste = Number(saldoConfigurado?.horasAjuste || 0);
    const horasAsignadas = round2(horasBase + horasAjuste);

    const ausencias = await obtenerAusenciasHoras(
      empleadoID,
      ausenciaExcluirID,
      tipoAusenciaCodigo,
      tipoAusencia.politicaFecha === POLITICA_SEMANA_CUMPLEANOS
        ? POLITICA_SEMANA_CUMPLEANOS
        : null,
    );

    const empleado =
      tipoAusencia.politicaFecha === POLITICA_SEMANA_CUMPLEANOS
        ? await SELECT.one
            .from(Empleados)
            .columns("fechaNacimiento")
            .where({ ID: empleadoID })
        : null;

    const ausenciasDelAnio = ausencias.filter(
      (ausencia) =>
        obtenerAnioBeneficioDesdeFecha(
          tipoAusencia,
          ausencia.fechaInicio,
          empleado?.fechaNacimiento,
        ) === anio,
    );

    const esBeneficioCumpleanios =
      tipoAusencia.politicaFecha === POLITICA_SEMANA_CUMPLEANOS;
    const estadosUtilizacion = esBeneficioCumpleanios
      ? ESTADOS_UTILIZACION_CUMPLEANIOS
      : ESTADOS_UTILIZACION_AUSENCIA;
    const estadosReserva = esBeneficioCumpleanios
      ? ESTADOS_RESERVA_CUMPLEANIOS
      : ESTADOS_RESERVA_AUSENCIA;

    const horasUtilizadas = round2(
      ausenciasDelAnio
        .filter((ausencia) => estadosUtilizacion.has(ausencia.estadoa_codigo))
        .reduce(
          (total, ausencia) =>
            total + Number(ausencia.horasSolicitadas || 0),
          0,
        ),
    );

    const horasReservadas = round2(
      ausenciasDelAnio
        .filter((ausencia) => estadosReserva.has(ausencia.estadoa_codigo))
        .reduce(
          (total, ausencia) =>
            total + Number(ausencia.horasSolicitadas || 0),
          0,
        ),
    );

    return {
      anio,
      horasAsignadas,
      horasUtilizadas,
      horasReservadas,
      horasDisponibles: round2(
        horasAsignadas - horasUtilizadas - horasReservadas,
      ),
    };
  }

  async function calcularSaldoValera(
    empleadoID,
    anio = obtenerAnio(today()),
    ausenciaExcluirID = null,
  ) {
    const saldo = await calcularSaldoBeneficioHoras(
      empleadoID,
      "VE",
      anio,
      ausenciaExcluirID,
    );

    return {
      valeraAnioActual: anio,
      horasValeraAsignadas: saldo.horasAsignadas,
      horasValeraUtilizadas: saldo.horasUtilizadas,
      horasValeraReservadas: saldo.horasReservadas,
      horasValeraDisponibles: saldo.horasDisponibles,
      vencimientoValera: `${anio}-12-31`,
      proximaRecargaValera: `${anio + 1}-01-01`,
    };
  }

  async function calcularSaldoCumpleanios(
    empleadoID,
    anio = null,
  ) {
    const resultadoVacio = (anioOcurrencia = null) => ({
      cumpleaniosAnioBeneficio: anioOcurrencia,
      horasCumpleaniosAsignadas: 0,
      horasCumpleaniosUtilizadas: 0,
      horasCumpleaniosReservadas: 0,
      horasCumpleaniosDisponibles: 0,
    });

    let anioBeneficio = anio;
    let ventana = null;
    let empleado = null;
    if (!anioBeneficio) {
      empleado = await SELECT.one
        .from(Empleados)
        .columns(
          "fechaNacimiento",
          "fechaIngreso",
          "fechaRetiro",
          "estado_codigo",
        )
        .where({ ID: empleadoID });
      ventana = absenceRules.obtenerProximaVentanaCumpleanios(
        empleado?.fechaNacimiento,
        today(),
      );
      anioBeneficio = ventana?.anioOcurrencia ?? null;
    }

    if (!anioBeneficio) return resultadoVacio();

    const tipoCumpleanios = await SELECT.one
      .from(TiposAusencia)
      .columns("codigo")
      .where({
        politicaFecha: POLITICA_SEMANA_CUMPLEANOS,
        controlaSaldoHoras: true,
      });
    if (!tipoCumpleanios) return resultadoVacio(anioBeneficio);

    if (ventana) {
      const inicioRelacion =
        empleado?.fechaIngreso > ventana.semanaInicio
          ? empleado.fechaIngreso
          : ventana.semanaInicio;
      const finRelacion =
        empleado?.fechaRetiro && empleado.fechaRetiro < ventana.semanaFin
          ? empleado.fechaRetiro
          : ventana.semanaFin;
      if (
        empleado?.estado_codigo !== "AC" ||
        !empleado?.fechaIngreso ||
        inicioRelacion > finRelacion
      ) {
        return resultadoVacio(anioBeneficio);
      }

      const contratos = await SELECT.from(Contratos)
        .columns("fechaInicio", "fechaFin")
        .where({ empleado_ID: empleadoID, vigente: true });
      const contratoCubreAlgunDia = contratos.some(
        (contrato) =>
          contrato.fechaInicio <= finRelacion &&
          (!contrato.fechaFin || contrato.fechaFin >= inicioRelacion),
      );
      if (!contratoCubreAlgunDia) return resultadoVacio(anioBeneficio);
    }

    const saldo = await calcularSaldoBeneficioHoras(
      empleadoID,
      tipoCumpleanios.codigo,
      anioBeneficio,
    );

    return {
      cumpleaniosAnioBeneficio: anioBeneficio,
      horasCumpleaniosAsignadas: saldo.horasAsignadas,
      horasCumpleaniosUtilizadas: saldo.horasUtilizadas,
      horasCumpleaniosReservadas: saldo.horasReservadas,
      horasCumpleaniosDisponibles: saldo.horasDisponibles,
    };
  }

  async function calcularCompensacion(empleadoID) {
    const contratosVigentes = await SELECT.from(Contratos)
      .columns("salario", "auxilioTransporte", "auxilioConectividad", "moneda")
      .where({
        empleado_ID: empleadoID,
        vigente: true,
      });

    const monedas = [
      ...new Set(
        contratosVigentes.map((contrato) => contrato.moneda).filter(Boolean),
      ),
    ];

    return {
      salarioBase: round2(
        contratosVigentes.reduce(
          (total, contrato) => total + Number(contrato.salario || 0),
          0,
        ),
      ),

      auxilioTransporte: round2(
        contratosVigentes.reduce(
          (total, contrato) => total + Number(contrato.auxilioTransporte || 0),
          0,
        ),
      ),

      auxilioConectividad: round2(
        contratosVigentes.reduce(
          (total, contrato) =>
            total + Number(contrato.auxilioConectividad || 0),
          0,
        ),
      ),

      // Con la regla actual solo puede existir un contrato vigente.
      moneda:
        monedas.length === 1
          ? monedas[0]
          : contratosVigentes.length === 0
            ? "COP"
            : null,
    };
  }

  async function calcularSaldoVacaciones(empleadoID, ausenciaExcluirID = null) {
    const resultadoVacio = {
      diasVacacionesCausados: 0,
      diasVacacionesDisfrutados: 0,
      diasVacacionesReservados: 0,
      diasVacacionesDisponibles: 0,
    };

    if (!empleadoID) {
      return resultadoVacio;
    }

    const fechaActual = today();

    /*
     * Solo se consideran contratos marcados como vigentes.
     * Además, posteriormente se valida que la modalidad
     * contractual tenga habilitada la causación.
     */
    const contratosVigentes = await SELECT.from(Contratos)
      .columns(
        "ID",
        "tipoContrato_codigo",
        "fechaInicio",
        "fechaFin",
        "vigente",
      )
      .where({
        empleado_ID: empleadoID,
        vigente: true,
      });

    /*
     * Sin contrato vigente no existe causación de vacaciones,
     * aunque el empleado tenga fecha de ingreso administrativa.
     */
    if (contratosVigentes.length === 0) {
      return resultadoVacio;
    }

    const tiposContrato = await SELECT.from(TiposContrato).columns(
      "codigo",
      "causaVacaciones",
    );

    const tiposQueCausanVacaciones = new Set(
      tiposContrato
        .filter((tipo) => tipo.causaVacaciones === true)
        .map((tipo) => tipo.codigo),
    );

    const contratosValidos = contratosVigentes.filter((contrato) => {
      if (!contrato.fechaInicio || contrato.fechaInicio > fechaActual) {
        return false;
      }

      return tiposQueCausanVacaciones.has(contrato.tipoContrato_codigo);
    });

    /*
     * Puede existir contrato vigente, pero ser prestación
     * de servicios u otra modalidad que no cause vacaciones.
     */
    if (contratosValidos.length === 0) {
      return resultadoVacio;
    }

    const diasTrabajados = contratosValidos.reduce((total, contrato) => {
      /*
       * Para un contrato vigente normalmente fechaFin será nula.
       * Si excepcionalmente existe, no calculamos después de ella.
       */
      const fechaCorte =
        contrato.fechaFin && contrato.fechaFin < fechaActual
          ? contrato.fechaFin
          : fechaActual;

      if (fechaCorte < contrato.fechaInicio) {
        return total;
      }

      return total + differenceInDays(contrato.fechaInicio, fechaCorte);
    }, 0);

    // 15 días de vacaciones por cada 360 días trabajados.
    const diasCausados = round2((diasTrabajados * 15) / 360);

    const tiposVacaciones = await SELECT.from(TiposAusencia)
      .columns("codigo")
      .where({
        descuentaSaldo: true,
      });

    const codigosTiposVacaciones = new Set(
      tiposVacaciones.map((tipo) => tipo.codigo),
    );

    const ausencias = await SELECT.from(Ausencias)
      .columns("ID", "tipoAusencia_codigo", "estadoa_codigo", "diasHabiles")
      .where({
        empleado_ID: empleadoID,
      });

    const vacaciones = ausencias.filter(
      (ausencia) =>
        ausencia.ID !== ausenciaExcluirID &&
        codigosTiposVacaciones.has(ausencia.tipoAusencia_codigo),
    );

    const diasDisfrutados = round2(
      vacaciones
        .filter((ausencia) =>
          ESTADOS_UTILIZACION_AUSENCIA.has(ausencia.estadoa_codigo),
        )
        .reduce(
          (total, ausencia) => total + Number(ausencia.diasHabiles || 0),
          0,
        ),
    );

    const diasReservados = round2(
      vacaciones
        .filter((ausencia) =>
          ESTADOS_RESERVA_AUSENCIA.has(ausencia.estadoa_codigo),
        )
        .reduce(
          (total, ausencia) => total + Number(ausencia.diasHabiles || 0),
          0,
        ),
    );

    return {
      diasVacacionesCausados: diasCausados,
      diasVacacionesDisfrutados: diasDisfrutados,
      diasVacacionesReservados: diasReservados,
      diasVacacionesDisponibles: round2(
        diasCausados - diasDisfrutados - diasReservados,
      ),
    };
  }

  this.after("READ", EmpleadosSrv, async (result, req) => {
    if (!result) return;

    const empleados = Array.isArray(result) ? result : [result];
    const requestedEmployeeID = keyFrom(req);
    const requestedIsActiveEntity = [...(req.params || [])]
      .reverse()
      .find((param) => param?.IsActiveEntity !== undefined)?.IsActiveEntity;

    await Promise.all(
      empleados.map(async (empleado) => {
        const empleadoID = empleado.ID || requestedEmployeeID;
        if (!empleadoID) return;

        const empleadoBase = await SELECT.one
          .from(Empleados)
          .columns(
            "ID",
            "primerNombre",
            "primerApellido",
            "foto_url",
            "foto_status",
          )
          .where({ ID: empleadoID });

        if (!empleadoBase) return;

        const empleadoCompleto = {
          ...empleadoBase,
          ...empleado,
          ID: empleadoID,
          IsActiveEntity:
            empleado.IsActiveEntity ?? requestedIsActiveEntity ?? true,
        };

        const [
          saldoVacaciones,
          compensacion,
          saldoValera,
          saldoCumpleanios,
        ] = await Promise.all([
          calcularSaldoVacaciones(empleadoID),
          calcularCompensacion(empleadoID),
          calcularSaldoValera(empleadoID),
          calcularSaldoCumpleanios(empleadoID),
        ]);

        Object.assign(
          empleado,
          saldoVacaciones,
          compensacion,
          saldoValera,
          saldoCumpleanios,
          {
            fotoUrl: construirFotoUrl(empleadoCompleto, empleadoBase),
          },
        );
      }),
    );
  });
});
