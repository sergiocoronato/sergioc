import express from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { config } from "./config.js";
import {
  initDb,
  listarPartidos,
  obtenerPartido,
  crearPartido,
  editarPartido,
  actualizarEstadoPartido,
  eliminarPartido,
  crearReserva,
  obtenerReserva,
  adjuntarComprobante,
  obtenerComprobante,
  listarReservasPorPartido,
  cambiarEstadoReserva,
  eliminarReserva,
  crearReservaManual,
  getConfigVarias,
  setConfig,
  incrementarVisitas,
  obtenerVisitas,
  marcarJugado,
  calcularAsistencias,
  ajustarAsistenciaManual,
  borrarAsistenciaManual,
} from "./db.js";

// Normaliza un numero de WhatsApp (igual que config.js): solo digitos, agrega 9 a celulares AR.
function normalizarWhatsapp(valor) {
  let n = String(valor || "").replace(/\D/g, "");
  if (!n) return "";
  if (n.startsWith("54") && !n.startsWith("549")) n = "549" + n.slice(2);
  return n;
}

// Arma los datos de pago combinando lo guardado en Turso (prioridad) y las env (fallback).
async function obtenerDatosPago() {
  const guardado = await getConfigVarias(["pago_titular", "pago_alias", "pago_cbu", "pago_banco", "pago_whatsapp"]);
  const usar = (g, def) => (g !== null && g !== undefined ? g : def);
  return {
    titular: usar(guardado.pago_titular, config.pago.titular),
    alias: usar(guardado.pago_alias, config.pago.alias),
    cbu: usar(guardado.pago_cbu, config.pago.cbu),
    banco: usar(guardado.pago_banco, config.pago.banco),
    whatsapp: guardado.pago_whatsapp !== null && guardado.pago_whatsapp !== undefined
      ? normalizarWhatsapp(guardado.pago_whatsapp)
      : config.pago.whatsapp,
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

const app = express();
app.set("trust proxy", 1); // detras del proxy del hosting (HTTPS)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ---- Subida de comprobantes ----
// En memoria: el archivo se guarda DENTRO de la base (Turso), no en disco.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpe?g|png|webp|gif)|application\/pdf/.test(file.mimetype);
    cb(ok ? null : new Error("FORMATO_INVALIDO"), ok);
  },
});

// ---- Sesiones de admin (token en cookie, en memoria) ----
const sesionesAdmin = new Set();

function crearSesionAdmin(res) {
  const token = crypto.randomBytes(24).toString("hex");
  sesionesAdmin.add(token);
  res.cookie("admin_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 8, // 8 horas
  });
}

function requireAdmin(req, res, next) {
  const token = req.cookies?.admin_token;
  if (token && sesionesAdmin.has(token)) return next();
  return res.status(401).json({ error: "No autorizado" });
}

// Envuelve handlers async para que los errores lleguen al manejador de errores.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// =========================================================
//  API PUBLICA
// =========================================================

// Datos de pago que ve el jugador
app.get("/api/pago", wrap(async (req, res) => {
  res.json(await obtenerDatosPago());
}));

// Registrar una visita a la pagina (lo llama el front publico al cargar)
app.post("/api/visita", wrap(async (req, res) => {
  await incrementarVisitas();
  res.json({ ok: true });
}));

// Listar partidos abiertos (con cupos)
app.get("/api/partidos", wrap(async (req, res) => {
  const soloAbiertos = req.query.todos !== "1";
  res.json(await listarPartidos({ soloAbiertos }));
}));

app.get("/api/partidos/:id", wrap(async (req, res) => {
  const p = await obtenerPartido(Number(req.params.id));
  if (!p) return res.status(404).json({ error: "Partido no encontrado" });
  res.json(p);
}));

// Crear una reserva (reserva el cupo por X minutos)
app.post("/api/partidos/:id/reservar", async (req, res) => {
  const partido_id = Number(req.params.id);
  const nombre = String(req.body.nombre || "").trim();
  const apellido = String(req.body.apellido || "").trim();
  const telefono = String(req.body.telefono || "").trim();
  const cantidad = Number(req.body.cantidad) || 1;

  if (!nombre || !apellido || !telefono) {
    return res.status(400).json({ error: "Completá nombre, apellido y teléfono." });
  }

  try {
    const reserva = await crearReserva({
      partido_id,
      nombre,
      apellido,
      telefono,
      cantidad,
      minutosReserva: config.minutosReserva,
    });
    res.status(201).json({
      reserva,
      pago: config.pago,
      minutosReserva: config.minutosReserva,
    });
  } catch (err) {
    const map = {
      PARTIDO_NO_EXISTE: [404, "El partido no existe."],
      PARTIDO_CERRADO: [409, "El partido ya no admite reservas."],
      SIN_CUPO: [409, "Se agotaron los cupos para este partido."],
      SIN_CUPO_SUFICIENTE: [409, "No quedan tantos lugares disponibles. Probá con menos."],
    };
    const [code, msg] = map[err.message] || [500, "Error al reservar."];
    res.status(code).json({ error: msg });
  }
});

// Subir comprobante de transferencia para una reserva
app.post("/api/reservas/:id/comprobante", upload.single("comprobante"), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const reserva = await obtenerReserva(id);
  if (!reserva) return res.status(404).json({ error: "Reserva no encontrada." });
  if (reserva.estado === "expirado") {
    return res.status(409).json({ error: "La reserva expiró. Volvé a anotarte." });
  }
  if (!req.file) return res.status(400).json({ error: "Subí un archivo (imagen o PDF)." });

  // Guardamos el archivo dentro de la base (base64) para que sea permanente.
  const actualizada = await adjuntarComprobante(id, {
    nombre: req.file.originalname || `comprobante-${id}`,
    data: req.file.buffer.toString("base64"),
    mime: req.file.mimetype,
  });
  res.json({ reserva: actualizada, mensaje: "Comprobante recibido. Queda pendiente de confirmación." });
}));

// =========================================================
//  API ADMIN
// =========================================================

app.post("/api/admin/login", (req, res) => {
  const pass = String(req.body.password || "");
  if (pass !== config.adminPassword) {
    return res.status(401).json({ error: "Contraseña incorrecta." });
  }
  crearSesionAdmin(res);
  res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  const token = req.cookies?.admin_token;
  if (token) sesionesAdmin.delete(token);
  res.clearCookie("admin_token");
  res.json({ ok: true });
});

app.get("/api/admin/estado", (req, res) => {
  const token = req.cookies?.admin_token;
  res.json({ autenticado: Boolean(token && sesionesAdmin.has(token)) });
});

// Listar todos los partidos (incluye cerrados)
app.get("/api/admin/partidos", requireAdmin, wrap(async (req, res) => {
  const partidos = await listarPartidos({ soloAbiertos: false });
  const conReservas = [];
  for (const p of partidos) {
    conReservas.push({ ...p, reservas: await listarReservasPorPartido(p.id) });
  }
  res.json(conReservas);
}));

app.post("/api/admin/partidos", requireAdmin, wrap(async (req, res) => {
  const tipo = req.body.tipo === "9v9" ? "9v9" : "5v5";
  const cuposPorDefecto = tipo === "9v9" ? 18 : 10;

  const data = {
    tipo,
    titulo: String(req.body.titulo || "").trim() || (tipo === "9v9" ? "Partido 9 vs 9" : "Partido 5 vs 5"),
    lugar: String(req.body.lugar || "").trim(),
    fecha: String(req.body.fecha || "").trim(),
    hora: String(req.body.hora || "").trim(),
    cupos: Number(req.body.cupos) || cuposPorDefecto,
    precio: Number(req.body.precio) || 0,
  };

  if (!data.lugar || !data.fecha || !data.hora) {
    return res.status(400).json({ error: "Completá lugar, fecha y hora." });
  }

  res.status(201).json(await crearPartido(data));
}));

// Editar un partido existente
app.put("/api/admin/partidos/:id", requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const existente = await obtenerPartido(id);
  if (!existente) return res.status(404).json({ error: "El partido no existe." });

  const tipo = req.body.tipo === "9v9" ? "9v9" : "5v5";
  const data = {
    tipo,
    titulo: String(req.body.titulo || "").trim() || (tipo === "9v9" ? "Partido 9 vs 9" : "Partido 5 vs 5"),
    lugar: String(req.body.lugar || "").trim(),
    fecha: String(req.body.fecha || "").trim(),
    hora: String(req.body.hora || "").trim(),
    cupos: Number(req.body.cupos) || (tipo === "9v9" ? 18 : 10),
    precio: Number(req.body.precio) || 0,
  };

  if (!data.lugar || !data.fecha || !data.hora) {
    return res.status(400).json({ error: "Completá lugar, fecha y hora." });
  }

  res.json(await editarPartido(id, data));
}));

app.patch("/api/admin/partidos/:id/estado", requireAdmin, wrap(async (req, res) => {
  const estado = req.body.estado;
  if (!["abierto", "cerrado", "cancelado"].includes(estado)) {
    return res.status(400).json({ error: "Estado inválido." });
  }
  res.json(await actualizarEstadoPartido(Number(req.params.id), estado));
}));

app.delete("/api/admin/partidos/:id", requireAdmin, wrap(async (req, res) => {
  await eliminarPartido(Number(req.params.id));
  res.json({ ok: true });
}));

// Confirmar / rechazar una reserva (pago)
app.patch("/api/admin/reservas/:id/estado", requireAdmin, wrap(async (req, res) => {
  const estado = req.body.estado;
  if (!["pendiente", "confirmado", "rechazado", "expirado"].includes(estado)) {
    return res.status(400).json({ error: "Estado inválido." });
  }
  res.json(await cambiarEstadoReserva(Number(req.params.id), estado));
}));

// Eliminar una reserva (libera el cupo)
app.delete("/api/admin/reservas/:id", requireAdmin, wrap(async (req, res) => {
  await eliminarReserva(Number(req.params.id));
  res.json({ ok: true });
}));

// Agregar un jugador manualmente (entra confirmado, para reservas por fuera de la web)
app.post("/api/admin/partidos/:id/reserva-manual", requireAdmin, wrap(async (req, res) => {
  const partido_id = Number(req.params.id);
  const nombre = String(req.body.nombre || "").trim();
  const apellido = String(req.body.apellido || "").trim();
  const telefono = String(req.body.telefono || "").trim();
  const cantidad = Number(req.body.cantidad) || 1;

  if (!nombre) {
    return res.status(400).json({ error: "Completá al menos el nombre." });
  }

  try {
    const reserva = await crearReservaManual({ partido_id, nombre, apellido, telefono, cantidad });
    res.status(201).json(reserva);
  } catch (err) {
    const map = {
      PARTIDO_NO_EXISTE: [404, "El partido no existe."],
      SIN_CUPO: [409, "No hay cupos disponibles."],
      SIN_CUPO_SUFICIENTE: [409, "No quedan tantos lugares. Probá con menos."],
    };
    const [code, msg] = map[err.message] || [500, "Error al agregar."];
    res.status(code).json({ error: msg });
  }
}));

// Total de visitas (solo admin)
app.get("/api/admin/visitas", requireAdmin, wrap(async (req, res) => {
  res.json({ visitas: await obtenerVisitas() });
}));

// Marcar / desmarcar un partido como jugado (cuenta para asistencias)
app.patch("/api/admin/partidos/:id/jugado", requireAdmin, wrap(async (req, res) => {
  const jugado = req.body.jugado ? 1 : 0;
  res.json(await marcarJugado(Number(req.params.id), jugado));
}));

// Tabla de asistencias (ranking)
app.get("/api/admin/asistencias", requireAdmin, wrap(async (req, res) => {
  res.json(await calcularAsistencias());
}));

// Ajuste manual de asistencias (+/- a un jugador)
app.post("/api/admin/asistencias/ajuste", requireAdmin, wrap(async (req, res) => {
  const nombre = String(req.body.nombre || "").trim();
  const telefono = String(req.body.telefono || "").trim();
  const delta = Number(req.body.delta);
  if (!nombre && !telefono) {
    return res.status(400).json({ error: "Indicá al menos un nombre o teléfono." });
  }
  if (!Number.isFinite(delta) || delta === 0) {
    return res.status(400).json({ error: "El ajuste debe ser un número distinto de 0." });
  }
  res.json(await ajustarAsistenciaManual({ nombre, telefono, delta }));
}));

// Borrar el ajuste manual de un jugador
app.post("/api/admin/asistencias/borrar", requireAdmin, wrap(async (req, res) => {
  const clave = String(req.body.clave || "").trim();
  if (!clave) return res.status(400).json({ error: "Falta la clave." });
  res.json(await borrarAsistenciaManual(clave));
}));

// Ver / editar datos de pago desde el panel
app.get("/api/admin/pago", requireAdmin, wrap(async (req, res) => {
  res.json(await obtenerDatosPago());
}));

app.put("/api/admin/pago", requireAdmin, wrap(async (req, res) => {
  await setConfig("pago_titular", String(req.body.titular || "").trim());
  await setConfig("pago_alias", String(req.body.alias || "").trim());
  await setConfig("pago_cbu", String(req.body.cbu || "").trim());
  await setConfig("pago_banco", String(req.body.banco || "").trim());
  await setConfig("pago_whatsapp", String(req.body.whatsapp || "").trim());
  res.json(await obtenerDatosPago());
}));

// Ver comprobante (solo admin) — se sirve desde la base por id de reserva.
app.get("/api/admin/comprobante/:reservaId", requireAdmin, wrap(async (req, res) => {
  const c = await obtenerComprobante(Number(req.params.reservaId));
  if (!c || !c.comprobante_data) {
    return res.status(404).json({ error: "Sin comprobante." });
  }
  const buffer = Buffer.from(c.comprobante_data, "base64");
  res.setHeader("Content-Type", c.comprobante_mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${(c.comprobante || "comprobante").replace(/"/g, "")}"`);
  res.send(buffer);
}));

// =========================================================
//  ESTATICOS
// =========================================================
app.use(express.static(publicDir));

// Manejo de errores de multer / formato
app.use((err, req, res, next) => {
  if (err && err.message === "FORMATO_INVALIDO") {
    return res.status(400).json({ error: "Formato no permitido. Subí imagen o PDF." });
  }
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "El archivo supera los 8 MB." });
  }
  console.error(err);
  res.status(500).json({ error: "Error interno." });
});

// Arranque: primero inicializa la base (crea tablas si no existen), luego escucha.
initDb()
  .then(() => {
    app.listen(config.port, "0.0.0.0", () => {
      console.log(`\n⚽ Reservas de fútbol corriendo en el puerto ${config.port}`);
      console.log(`   Local: http://localhost:${config.port}`);
      console.log(`   Panel de admin: /admin.html\n`);
    });
  })
  .catch((err) => {
    console.error("No se pudo inicializar la base de datos:", err);
    process.exit(1);
  });
