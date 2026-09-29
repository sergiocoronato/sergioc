// Configuracion central de la app.
// Podes sobreescribir estos valores con variables de entorno.

// Deja el numero de WhatsApp en formato que espera wa.me (solo digitos).
// Para celulares argentinos (54) que no tengan el 9 despues del pais, se lo agrega.
function normalizarWhatsapp(valor) {
  let n = String(valor).replace(/\D/g, "");
  if (!n) return "";
  if (n.startsWith("54") && !n.startsWith("549")) {
    n = "549" + n.slice(2);
  }
  return n;
}

export const config = {
  port: process.env.PORT || 3100,

  // Carpeta donde se guardan los comprobantes (y la DB local si no se usa Turso).
  dataDir: process.env.DATA_DIR || null,

  // Base de datos Turso (SQLite en la nube, gratis y persistente).
  // Si no se setean, la app usa un archivo SQLite local (para desarrollo).
  turso: {
    url: process.env.TURSO_DATABASE_URL || null,
    authToken: process.env.TURSO_AUTH_TOKEN || null,
  },

  // Contrasena para entrar al panel de admin.
  // CAMBIALA en produccion (por variable de entorno ADMIN_PASSWORD).
  adminPassword: process.env.ADMIN_PASSWORD || "admin1234",

  // Datos que se le muestran al jugador para que transfiera.
  pago: {
    titular: process.env.PAGO_TITULAR || "Nombre del organizador",
    alias: process.env.PAGO_ALIAS || "futbol.reservas.mp",
    cbu: process.env.PAGO_CBU || "",
    banco: process.env.PAGO_BANCO || "Mercado Pago",
    // WhatsApp del organizador para enviar el comprobante (formato internacional, solo digitos).
    // Ej Bariloche: 54 9 2944 789951 -> 5492944789951
    // Si es argentino (empieza con 54) y falta el 9 de celular, se agrega automaticamente.
    whatsapp: normalizarWhatsapp(process.env.WHATSAPP_ADMIN || "+54 294 4789951"),
  },

  // Minutos que se reserva el cupo antes de que expire si no suben comprobante.
  minutosReserva: Number(process.env.MINUTOS_RESERVA || 30),
};
