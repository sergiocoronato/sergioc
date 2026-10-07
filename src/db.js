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

  // Config clave/valor (ej: datos de pago editables desde el panel).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS config (
      clave TEXT PRIMARY KEY,
      valor TEXT
    )
  `);

  // Columnas para guardar el comprobante DENTRO de la base (permanente).
  // comprobante_data = archivo en base64, comprobante_mime = tipo (image/png, application/pdf, etc.)
  await agregarColumnaSiFalta("reservas", "comprobante_data", "TEXT");
  await agregarColumnaSiFalta("reservas", "comprobante_mime", "TEXT");
  // Cantidad de lugares que ocupa la reserva (titular + acompañantes). Por defecto 1.
  await agregarColumnaSiFalta("reservas", "cantidad", "INTEGER NOT NULL DEFAULT 1");
  // Marca si el partido efectivamente se jugo (para la tabla de asistencias). 0 = no, 1 = si.
  await agregarColumnaSiFalta("partidos", "jugado", "INTEGER NOT NULL DEFAULT 0");

  // Ajustes manuales de asistencia por jugador (identificado por telefono normalizado).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS asistencias_manual (
      telefono TEXT PRIMARY KEY,
      nombre   TEXT,
      ajuste   INTEGER NOT NULL DEFAULT 0
    )
  `);
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
  // Suma la cantidad de lugares (no la cantidad de reservas), porque cada reserva puede ocupar varios.
  const r = await get(
    `SELECT COALESCE(SUM(COALESCE(cantidad, 1)), 0) AS n FROM reservas WHERE partido_id = ? AND estado IN ('pendiente','confirmado')`,
    [partido_id]
  );
  return Number(r.n);
}

async function contarConfirmados(partido_id) {
  const r = await get(
    `SELECT COALESCE(SUM(COALESCE(cantidad, 1)), 0) AS n FROM reservas WHERE partido_id = ? AND estado = 'confirmado'`,
    [partido_id]
  );
  return Number(r.n);
}

// Duracion del partido en minutos: se considera "finalizado" pasado este tiempo desde el inicio.
const DURACION_MIN = 60;
// Argentina es UTC-3. El servidor puede estar en UTC, asi que comparamos contra la hora local AR.
const AHORA_AR = "datetime('now', '-3 hours')";

// Devuelve true si el partido ya termino (paso su inicio + DURACION_MIN), en hora Argentina.
function partidoFinalizado(p) {
  if (!p?.fecha || !p?.hora) return false;
  // Interpretamos fecha/hora como hora local de Argentina (UTC-3).
  const inicio = new Date(`${p.fecha}T${p.hora}:00-03:00`);
  if (isNaN(inicio)) return false;
  const fin = new Date(inicio.getTime() + DURACION_MIN * 60 * 1000);
  return Date.now() > fin.getTime();
}

export async function listarPartidos({ soloAbiertos = false } = {}) {
  await expirarReservasVencidas();

  let where = "";
  if (soloAbiertos) {
    // Vista publica: solo partidos abiertos y que TODAVIA no terminaron.
    // Fin del partido = fecha + hora + DURACION_MIN. Si ya paso, no se muestra.
    where = `WHERE estado = 'abierto'
             AND datetime(fecha || ' ' || hora, '+${DURACION_MIN} minutes') > ${AHORA_AR}`;
  }
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

export async function editarPartido(id, data) {
  await run(
    `UPDATE partidos
     SET tipo = ?, titulo = ?, lugar = ?, fecha = ?, hora = ?, cupos = ?, precio = ?
     WHERE id = ?`,
    [data.tipo, data.titulo, data.lugar, data.fecha, data.hora, data.cupos, data.precio, id]
  );
  return obtenerPartido(id);
}

export async function actualizarEstadoPartido(id, estado) {
  await run(`UPDATE partidos SET estado = ? WHERE id = ?`, [estado, id]);
  return obtenerPartido(id);
}

export async function eliminarPartido(id) {
  return run(`DELETE FROM partidos WHERE id = ?`, [id]);
}

// Crea una reserva validando el cupo dentro de una transaccion (atomico).
export async function crearReserva({ partido_id, nombre, apellido, telefono, cantidad = 1, minutosReserva }) {
  // Minimo 1 lugar. El maximo real lo limita el cupo disponible del partido (validado abajo).
  const lugares = Math.max(1, Number(cantidad) || 1);

  const tx = await db.transaction("write");
  try {
    const partidoRes = await tx.execute({
      sql: `SELECT * FROM partidos WHERE id = ?`,
      args: [partido_id],
    });
    const partido = partidoRes.rows[0];
    if (!partido) throw new Error("PARTIDO_NO_EXISTE");
    if (partido.estado !== "abierto") throw new Error("PARTIDO_CERRADO");
    if (partidoFinalizado(partido)) throw new Error("PARTIDO_CERRADO");

    const cntRes = await tx.execute({
      sql: `SELECT COALESCE(SUM(COALESCE(cantidad, 1)), 0) AS n FROM reservas WHERE partido_id = ? AND estado IN ('pendiente','confirmado')`,
      args: [partido_id],
    });
    const ocupados = Number(cntRes.rows[0].n);
    const disponibles = Number(partido.cupos) - ocupados;
    if (disponibles <= 0) throw new Error("SIN_CUPO");
    if (lugares > disponibles) throw new Error("SIN_CUPO_SUFICIENTE");

    const info = await tx.execute({
      sql: `INSERT INTO reservas (partido_id, nombre, apellido, telefono, cantidad, estado, expira_en)
            VALUES (?, ?, ?, ?, ?, 'pendiente', datetime('now', ?))`,
      args: [partido_id, nombre, apellido, telefono, lugares, `+${minutosReserva} minutes`],
    });

    await tx.commit();
    return obtenerReserva(Number(info.lastInsertRowid));
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

// Columnas "livianas" de una reserva (sin el contenido pesado del comprobante).
const COLS_RESERVA = "id, partido_id, nombre, apellido, telefono, cantidad, estado, comprobante, comprobante_mime, creado_en, expira_en";

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

// ---- Config clave/valor ----
export async function getConfig(clave) {
  const r = await get(`SELECT valor FROM config WHERE clave = ?`, [clave]);
  return r ? r.valor : null;
}

export async function getConfigVarias(claves) {
  const out = {};
  for (const c of claves) out[c] = await getConfig(c);
  return out;
}

export async function setConfig(clave, valor) {
  await run(
    `INSERT INTO config (clave, valor) VALUES (?, ?)
     ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`,
    [clave, valor ?? ""]
  );
}

// Suma 1 al contador de visitas y devuelve el total.
export async function incrementarVisitas() {
  await run(
    `INSERT INTO config (clave, valor) VALUES ('visitas', '1')
     ON CONFLICT(clave) DO UPDATE SET valor = CAST(valor AS INTEGER) + 1`
  );
  const r = await get(`SELECT valor FROM config WHERE clave = 'visitas'`);
  return Number(r?.valor || 0);
}

export async function obtenerVisitas() {
  const r = await get(`SELECT valor FROM config WHERE clave = 'visitas'`);
  return Number(r?.valor || 0);
}

// ---- Partido jugado (para asistencias) ----
export async function marcarJugado(id, jugado) {
  await run(`UPDATE partidos SET jugado = ? WHERE id = ?`, [jugado ? 1 : 0, id]);
  return obtenerPartido(id);
}

// Clave para agrupar un jugador: por telefono (solo digitos). Si no hay, por nombre+apellido normalizado.
function claveJugador(nombre, apellido, telefono) {
  const tel = String(telefono || "").replace(/\D/g, "");
  if (tel) return "tel:" + tel;
  return "nom:" + `${nombre || ""} ${apellido || ""}`.trim().toLowerCase().replace(/\s+/g, " ");
}

// Calcula la tabla de asistencias: confirmados de partidos marcados como jugados,
// agrupados por telefono, mas los ajustes manuales. Devuelve ranking ordenado desc.
export async function calcularAsistencias() {
  // Reservas confirmadas de partidos jugados.
  const filas = await all(`
    SELECT r.nombre, r.apellido, r.telefono, r.cantidad, r.creado_en
    FROM reservas r
    JOIN partidos p ON p.id = r.partido_id
    WHERE r.estado = 'confirmado' AND p.jugado = 1
  `);

  const mapa = new Map(); // clave -> { nombre, telefono, auto }
  for (const r of filas) {
    const clave = claveJugador(r.nombre, r.apellido, r.telefono);
    const prev = mapa.get(clave) || { nombre: "", telefono: r.telefono || "", auto: 0 };
    // cada reserva confirmada cuenta como 1 asistencia (no multiplicamos por cantidad: la tabla es de personas)
    prev.auto += 1;
    prev.nombre = `${r.nombre || ""} ${r.apellido || ""}`.trim(); // ultimo nombre usado
    if (r.telefono) prev.telefono = r.telefono;
    mapa.set(clave, prev);
  }

  // Sumar ajustes manuales.
  const manuales = await all(`SELECT telefono, nombre, ajuste FROM asistencias_manual`);
  for (const m of manuales) {
    const clave = claveJugador(m.nombre, "", m.telefono);
    const prev = mapa.get(clave) || { nombre: m.nombre || "", telefono: m.telefono || "", auto: 0 };
    prev.manual = (prev.manual || 0) + Number(m.ajuste || 0);
    prev.claveManual = m.telefono; // clave de la fila manual (para poder borrarla)
    if (!prev.nombre && m.nombre) prev.nombre = m.nombre;
    mapa.set(clave, prev);
  }

  const ranking = [...mapa.values()].map((v) => ({
    nombre: v.nombre || "(sin nombre)",
    telefono: v.telefono || "",
    auto: v.auto || 0,
    manual: v.manual || 0,
    total: (v.auto || 0) + (v.manual || 0),
    claveManual: v.claveManual || null, // presente solo si tiene ajuste manual
  }));
  ranking.sort((a, b) => b.total - a.total || a.nombre.localeCompare(b.nombre));
  return ranking;
}

// Borra el ajuste manual de un jugador (por la clave guardada: telefono en digitos o 'nombre:...').
export async function borrarAsistenciaManual(claveFila) {
  await run(`DELETE FROM asistencias_manual WHERE telefono = ?`, [claveFila]);
  return calcularAsistencias();
}

// Suma (o resta) un ajuste manual de asistencias a un jugador.
// Guardamos en la columna 'telefono' el telefono en crudo (solo digitos); si no hay, el nombre normalizado.
// Asi claveJugador() lo agrupa igual que las reservas.
export async function ajustarAsistenciaManual({ nombre, telefono, delta }) {
  const tel = String(telefono || "").replace(/\D/g, "");
  const guardarTel = tel || "";
  const guardarNombre = nombre || "";
  // Clave unica de la fila manual (para el ON CONFLICT): telefono si hay, si no el nombre.
  const claveFila = tel || `nombre:${guardarNombre.trim().toLowerCase()}`;
  await run(
    `INSERT INTO asistencias_manual (telefono, nombre, ajuste) VALUES (?, ?, ?)
     ON CONFLICT(telefono) DO UPDATE SET ajuste = ajuste + excluded.ajuste, nombre = excluded.nombre`,
    [claveFila, guardarNombre, Number(delta) || 0]
  );
  return calcularAsistencias();
}

// Elimina una reserva (libera el cupo). Usado por el admin.
export async function eliminarReserva(id) {
  return run(`DELETE FROM reservas WHERE id = ?`, [id]);
}

// Crea una reserva cargada por el admin: entra directo como 'confirmado', sin expiracion.
// Valida el cupo dentro de la transaccion, igual que crearReserva.
export async function crearReservaManual({ partido_id, nombre, apellido, telefono, cantidad = 1 }) {
  const lugares = Math.max(1, Number(cantidad) || 1);
  const tx = await db.transaction("write");
  try {
    const partidoRes = await tx.execute({ sql: `SELECT * FROM partidos WHERE id = ?`, args: [partido_id] });
    const partido = partidoRes.rows[0];
    if (!partido) throw new Error("PARTIDO_NO_EXISTE");

    const cntRes = await tx.execute({
      sql: `SELECT COALESCE(SUM(COALESCE(cantidad, 1)), 0) AS n FROM reservas WHERE partido_id = ? AND estado IN ('pendiente','confirmado')`,
      args: [partido_id],
    });
    const ocupados = Number(cntRes.rows[0].n);
    const disponibles = Number(partido.cupos) - ocupados;
    if (disponibles <= 0) throw new Error("SIN_CUPO");
    if (lugares > disponibles) throw new Error("SIN_CUPO_SUFICIENTE");

    const info = await tx.execute({
      sql: `INSERT INTO reservas (partido_id, nombre, apellido, telefono, cantidad, estado, expira_en)
            VALUES (?, ?, ?, ?, ?, 'confirmado', NULL)`,
      args: [partido_id, nombre, apellido, telefono, lugares],
    });

    await tx.commit();
    return obtenerReserva(Number(info.lastInsertRowid));
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export default db;
