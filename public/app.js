const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let partidoActual = null;
let reservaActual = null;
let datosPago = null;

const meses = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];

function formatFecha(fechaISO, hora) {
  const [y, m, d] = fechaISO.split("-").map(Number);
  const fecha = new Date(y, m - 1, d);
  const dias = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
  return `${dias[fecha.getDay()]} ${d} ${meses[m - 1]} · ${hora} hs`;
}

function money(n) {
  if (!n) return "Gratis";
  return "$" + Number(n).toLocaleString("es-AR");
}

// A partir de cuantas reservas se muestra el cartel "quedan 2 lugares", segun el tamano del partido.
// 10 cupos -> desde 5 reservas (urgencia) | otros (ej 18) -> cuando quedan 2 lugares reales.
function umbralAviso(cupos) {
  if (cupos === 10) return 5;
  return Math.max(1, cupos - 2);
}

function debeAvisarPocos(p) {
  return p.ocupados >= umbralAviso(Number(p.cupos));
}

function toast(msg) {
  let t = $(".toast");
  if (!t) {
    t = document.createElement("div");
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => t.classList.remove("show"), 2200);
}

async function cargarPartidos() {
  const cont = $("#lista-partidos");
  try {
    const res = await fetch("/api/partidos");
    const partidos = await res.json();

    if (!partidos.length) {
      cont.innerHTML = "";
      $("#vacio").classList.remove("hidden");
      return;
    }
    $("#vacio").classList.add("hidden");

    cont.innerHTML = partidos.map((p) => {
      const esNueve = p.tipo === "9v9";
      const lleno = p.lleno;
      const mostrarAviso = !lleno && debeAvisarPocos(p);
      return `
        <article class="card">
          <div class="card-top">
            <span class="badge-tipo ${esNueve ? "nueve" : ""}">${p.tipo === "9v9" ? "9 vs 9" : "5 vs 5"}</span>
            <span class="precio">${money(p.precio)}</span>
          </div>
          <h3>${escapeHtml(p.titulo)}</h3>
          <div class="card-meta">
            <div class="row"><span class="icon">📅</span> ${formatFecha(p.fecha, p.hora)}</div>
            <div class="row"><span class="icon">📍</span> ${escapeHtml(p.lugar)}</div>
          </div>
          ${mostrarAviso
            ? `<div class="aviso-pocos">🔥 ¡Quedan 2 lugares disponibles!</div>`
            : ""}
          <div class="card-cta">
            ${lleno
              ? `<div class="btn-lleno">Completo 🙌</div>`
              : `<button class="primary-btn full" data-id="${p.id}">Reservar mi lugar</button>`}
          </div>
        </article>`;
    }).join("");

    $$("#lista-partidos .primary-btn").forEach((btn) => {
      btn.addEventListener("click", () => abrirModal(partidos.find((x) => x.id === Number(btn.dataset.id))));
    });
  } catch (e) {
    cont.innerHTML = `<p class="empty">No se pudieron cargar los partidos.</p>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- Modal ----
function abrirModal(partido) {
  partidoActual = partido;
  reservaActual = null;
  $("#modal").classList.remove("hidden");
  mostrarPaso("datos");
  $("#modal-detalle").textContent =
    `${partido.tipo === "9v9" ? "9 vs 9" : "5 vs 5"} · ${formatFecha(partido.fecha, partido.hora)} · ${partido.lugar}`;
  $("#form-reserva").reset();
  $("#reserva-error").classList.add("hidden");

  // Opciones de cantidad: desde 1 hasta los lugares que queden libres en este partido.
  const sel = $("#cantidad-select");
  const max = Math.max(1, Number(partido.disponibles) || 1);
  sel.innerHTML = "";
  for (let i = 1; i <= max; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = i === 1 ? "1 lugar (solo yo)" : `${i} lugares`;
    sel.appendChild(opt);
  }

  // Disponibilidad "motivadora" dentro del modal. Solo para 5v5 (10 cupos).
  mostrarDisponibilidadModal(partido);
}

// Muestra una disponibilidad pensada para incentivar a sumarse (solo 5v5):
// - "8/10" mientras queden 2 o mas lugares reales
// - "9/10" cuando queda 1 lugar real
// - "Completo" si esta lleno
// En el 9v9 (u otros tamanos) no se muestra este contador.
function mostrarDisponibilidadModal(partido) {
  const el = $("#modal-disponibilidad");
  if (Number(partido.cupos) !== 10) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  const disponiblesReales = Number(partido.disponibles) || 0;
  let texto;
  if (disponiblesReales <= 0) texto = "⚽ Cupos: Completo";
  else if (disponiblesReales === 1) texto = "⚽ Lugares ocupados: 9/10";
  else texto = "⚽ Lugares ocupados: 8/10";

  el.textContent = texto;
  el.classList.remove("hidden");
}

function cerrarModal() {
  $("#modal").classList.add("hidden");
  cargarPartidos();
}

function mostrarPaso(paso) {
  $("#paso-datos").classList.toggle("hidden", paso !== "datos");
  $("#paso-pago").classList.toggle("hidden", paso !== "pago");
  $("#paso-listo").classList.toggle("hidden", paso !== "listo");
}

$("#modal-close").addEventListener("click", cerrarModal);
$("#btn-cerrar-final").addEventListener("click", cerrarModal);
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") cerrarModal(); });

// ---- Reserva ----
$("#form-reserva").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#reserva-error");
  err.classList.add("hidden");
  const btn = $("#btn-reservar");
  btn.disabled = true;
  btn.textContent = "Reservando...";

  const fd = new FormData(e.target);
  const body = {
    nombre: fd.get("nombre"),
    apellido: fd.get("apellido"),
    telefono: fd.get("telefono"),
    cantidad: Number(fd.get("cantidad")) || 1,
  };

  try {
    const res = await fetch(`/api/partidos/${partidoActual.id}/reservar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudo reservar.");

    reservaActual = data.reserva;
    datosPago = data.pago;
    mostrarPasoPago(data.pago, data.minutosReserva);
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Reservar mi lugar";
  }
});

function mostrarPasoPago(pago, minutos) {
  mostrarPaso("pago");
  $("#pago-minutos").textContent = minutos;
  const rows = [
    ["Titular", pago.titular],
    ["Alias", pago.alias],
    ["CBU/CVU", pago.cbu],
    ["Banco", pago.banco],
  ];
  const lugares = Number(reservaActual?.cantidad) || 1;
  if (partidoActual.precio) {
    const total = partidoActual.precio * lugares;
    const detalle = lugares > 1 ? `${money(total)} (${lugares} lugares)` : money(total);
    rows.unshift(["Importe", detalle]);
  }

  // No mostrar filas cuyo valor este vacio (ej: CBU si no se cargo).
  const rowsVisibles = rows.filter(([, v]) => v && String(v).trim() !== "");

  $("#pago-box").innerHTML = rowsVisibles.map(([k, v]) => `
    <div class="pago-row">
      <span class="k">${k}</span>
      <span class="v">${escapeHtml(v)}</span>
      <button class="copy-btn" data-copy="${escapeHtml(v)}">Copiar</button>
    </div>
  `).join("");

  $$("#pago-box .copy-btn").forEach((b) => {
    b.addEventListener("click", () => {
      navigator.clipboard.writeText(b.dataset.copy);
      toast("Copiado ✓");
    });
  });

}

// ---- Boton "Listo, ya transferí": lleva al mensaje final ----
$("#btn-listo-pago").addEventListener("click", () => {
  mostrarPaso("listo");
});

$("#btn-refrescar").addEventListener("click", cargarPartidos);

cargarPartidos();
setInterval(cargarPartidos, 30000); // refresco automatico
