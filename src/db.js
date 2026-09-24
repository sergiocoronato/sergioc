import { createClient } from "@libsql/client";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync } from "fs";
import { config } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Si hay credenciales de Turso, usa la base en la nube (persistente, gratis).
// Si no, usa un archivo SQLite local (para desarrollo).
let db;
if (config.turso.url) {
  db = createClient({
    url: config.turso.url,
    authToken: config.turso.authToken,
  });
  console.log("🗄️  Base de datos: Turso (nube)");
} else {
  const dataDir = config.dataDir || join(__dirname, "..", "data");
  mkdirSync(dataDir, { recursive: true });
  const localPath = join(dataDir, "reservas.db").replace(/\\/g, "/");
  db = createClient({ url: `file:${localPath}` });
  console.log("🗄️  Base de datos: SQLite local (" + localPath + ")");
}

// Helpers: la API de libsql es async y devuelve { rows, lastInsertRowid, ... }
const all = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const get = async (sql, args = []) => {
  const rows = (await db.execute({ sql, args })).rows;
  return rows.length ? rows[0] : null;
};
const run = async (sql, args = []) => db.execute({ sql, args });

// Inicializacion de tablas. Se llama una vez al arrancar.
export async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS partidos (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo          TEXT NOT NULL,
      titulo        TEXT NOT NULL,
      lugar         TEXT NOT NULL,
      fecha         TEXT NOT NULL,
      hora          TEXT NOT NULL,
      cupos         INTEGER NOT NULL,
      precio        INTEGER NOT NULL DEFAULT 0,
      estado        TEXT NOT NULL DEFAULT 'abierto',
      creado_en     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS reservas (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      partido_id        INTEGER NOT NULL,
      nombre            TEXT NOT NULL,
      apellido          TEXT NOT NULL,
      telefono          TEXT NOT NULL,
      estado            TEXT NOT NULL DEFAULT 'pendiente',
      comprobante       TEXT,
      creado_en         TEXT NOT NULL DEFAULT (datetime('now')),
      expira_en         TEXT,
      FOREIGN KEY (partido_id) REFERENCES partidos(id) ON DELETE CASCADE
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_reservas_partido ON reservas(partido_id)`);

  // Columnas para guardar el comprobante DENTRO de la base (permanente).
  // comprobante_data = archivo en base64, comprobante_mime = tipo (image/png, application/pdf, etc.)
  await agregarColumnaSiFalta("reservas", "comprobante_data", "TEXT");
  await agregarColumnaSiFalta("reservas", "comprobante_mime", "TEXT");
}

// Agrega una columna solo si todavia no existe (ALTER TABLE idempotente).
async function agregarColumnaSiFalta(tabla, columna, tipo) {
  const cols = (await db.execute(`PRAGMA table_info(${tabla})`)).rows;
  const existe = cols.some((c) => c.name === columna);
  if (!existe) {
    await db.execute(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${tipo}`);
  }
}

// Marca como expiradas las reservas pendientes sin comprobante que superaron su tiempo.
export async function expirarReservasVencidas() {
  await run(`
    UPDATE reservas
    SET estado = 'expirado'
    WHERE estado = 'pendiente'
      AND comprobante IS NULL
      AND expira_en IS NOT NULL
      AND expira_en < datetime('now')
  `);
}

async function contarOcupados(partido_id) {
  const r = await get(
    `SELECT COUNT(*) AS n FROM reservas WHERE partido_id = ? AND estado IN ('pendiente','confirmado')`,
    [partido_id]
  );
  return Number(r.n);
}

async function contarConfirmados(partido_id) {
  const r = await get(
    `SELECT COUNT(*) AS n FROM reservas WHERE partido_id = ? AND estado = 'confirmado'`,
    [partido_id]
  );
  return Number(r.n);
}

export async function listarPartidos({ soloAbiertos = false } = {}) {
  await expirarReservasVencidas();
  const where = soloAbiertos ? "WHERE estado = 'abierto'" : "";
  const partidos = await all(`SELECT * FROM partidos ${where} ORDER BY fecha ASC, hora ASC`);

  const out = [];
  for (const p of partidos) {
    const ocupados = await contarOcupados(p.id);
    const confirmados = await contarConfirmados(p.id);
    out.push({
      ...p,
      ocupados,
      confirmados,
      disponibles: Math.max(0, Number(p.cupos) - ocupados),
      lleno: ocupados >= Number(p.cupos),
    });
  }
  return out;
}

export async function obtenerPartido(id) {
  await expirarReservasVencidas();
  const p = await get(`SELECT * FROM partidos WHERE id = ?`, [id]);
  if (!p) return null;
  const ocupados = await contarOcupados(id);
  return {
    ...p,
    ocupados,
    confirmados: await contarConfirmados(id),
    disponibles: Math.max(0, Number(p.cupos) - ocupados),
    lleno: ocupados >= Number(p.cupos),
  };
}

export async function crearPartido(data) {
  const info = await run(
    `INSERT INTO partidos (tipo, titulo, lugar, fecha, hora, cupos, precio, estado)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'abierto')`,
    [data.tipo, data.titulo, data.lugar, data.fecha, data.hora, data.cupos, data.precio]
  );
  return obtenerPartido(Number(info.lastInsertRowid));
}

export async function actualizarEstadoPartido(id, estado) {
  await run(`UPDATE partidos SET estado = ? WHERE id = ?`, [estado, id]);
  return obtenerPartido(id);
}

export async function eliminarPartido(id) {
  return run(`DELETE FROM partidos WHERE id = ?`, [id]);
}

// Crea una reserva validando el cupo dentro de una transaccion (atomico).
export async function crearReserva({ partido_id, nombre, apellido, telefono, minutosReserva }) {
  const tx = await db.transaction("write");
  try {
    const partidoRes = await tx.execute({
      sql: `SELECT * FROM partidos WHERE id = ?`,
      args: [partido_id],
    });
    const partido = partidoRes.rows[0];
    if (!partido) throw new Error("PARTIDO_NO_EXISTE");
    if (partido.estado !== "abierto") throw new Error("PARTIDO_CERRADO");

    const cntRes = await tx.execute({
      sql: `SELECT COUNT(*) AS n FROM reservas WHERE partido_id = ? AND estado IN ('pendiente','confirmado')`,
      args: [partido_id],
    });
    const ocupados = Number(cntRes.rows[0].n);
    if (ocupados >= Number(partido.cupos)) throw new Error("SIN_CUPO");

    const info = await tx.execute({
      sql: `INSERT INTO reservas (partido_id, nombre, apellido, telefono, estado, expira_en)
            VALUES (?, ?, ?, ?, 'pendiente', datetime('now', ?))`,
      args: [partido_id, nombre, apellido, telefono, `+${minutosReserva} minutes`],
    });

    await tx.commit();
    return obtenerReserva(Number(info.lastInsertRowid));
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

// Columnas "livianas" de una reserva (sin el contenido pesado del comprobante).
const COLS_RESERVA = "id, partido_id, nombre, apellido, telefono, estado, comprobante, comprobante_mime, creado_en, expira_en";

export async function obtenerReserva(id) {
  return get(`SELECT ${COLS_RESERVA} FROM reservas WHERE id = ?`, [id]);
}

// Guarda el comprobante dentro de la base: contenido en base64 + su tipo.
// El campo "comprobante" guarda un nombre de referencia (para saber que hay archivo).
export async function adjuntarComprobante(id, { nombre, data, mime }) {
  await run(
    `UPDATE reservas SET comprobante = ?, comprobante_data = ?, comprobante_mime = ?, expira_en = NULL WHERE id = ?`,
    [nombre, data, mime, id]
  );
  return obtenerReserva(id);
}

// Lee el contenido del comprobante (base64 + mime) para servirlo al admin.
export async function obtenerComprobante(id) {
  return get(`SELECT comprobante_data, comprobante_mime, comprobante FROM reservas WHERE id = ?`, [id]);
}

export async function listarReservasPorPartido(partido_id) {
  return all(`SELECT ${COLS_RESERVA} FROM reservas WHERE partido_id = ? ORDER BY creado_en ASC`, [partido_id]);
}

export async function cambiarEstadoReserva(id, estado) {
  await run(`UPDATE reservas SET estado = ? WHERE id = ?`, [estado, id]);
  return obtenerReserva(id);
}

export default db;
