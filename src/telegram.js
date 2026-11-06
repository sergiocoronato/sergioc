import { config } from "./config.js";

// Envia un mensaje a Telegram. Es "fire and forget": si falla, no rompe la reserva.
// Si no hay token/chatId configurados, no hace nada.
export async function avisarTelegram(texto) {
  const { token, chatId } = config.telegram;
  if (!token || !chatId) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: texto,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("Telegram respondió error:", res.status, body);
    }
  } catch (err) {
    console.error("No se pudo enviar aviso a Telegram:", err.message);
  }
}

// Escapa caracteres especiales de HTML para el mensaje.
function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// Arma y envia el aviso de una nueva reserva.
export async function avisarNuevaReserva({ reserva, partido }) {
  const tipo = partido.tipo === "9v9" ? "9 vs 9" : "5 vs 5";
  const cant = Number(reserva.cantidad) || 1;
  const extra = cant > 1 ? ` (+${cant - 1})` : "";
  const tel = reserva.telefono ? esc(reserva.telefono) : "—";

  const texto =
    `🟢 <b>Nueva reserva</b> — Bariloche Fútbol\n\n` +
    `⚽ <b>${esc(partido.titulo)}</b> (${tipo})\n` +
    `📅 ${esc(partido.fecha)} · ${esc(partido.hora)} hs\n` +
    `📍 ${esc(partido.lugar)}\n\n` +
    `👤 ${esc(reserva.nombre)} ${esc(reserva.apellido)}${extra}\n` +
    `📞 ${tel}\n` +
    `🎟️ ${partido.ocupados}/${partido.cupos} cupos ocupados`;

  await avisarTelegram(texto);
}
