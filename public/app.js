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
      const pct = Math.min(100, Math.round((p.ocupados / p.cupos) * 100));
      const esNueve = p.tipo === "9v9";
      const lleno = p.lleno;
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
          <div class="cupos">
            <div class="cupos-head">
              <span>Cupos</span>
              <span><strong>${p.ocupados}</strong> / ${p.cupos}</span>
            </div>
            <div class="bar ${lleno ? "lleno" : ""}"><span style="width:${pct}%"></span></div>
          </div>
          <div class="card-cta">
            ${lleno
              ? `<div class="btn-lleno">Completo 🙌</div>`
              : `<button class="primary-btn full" data-id="${p.id}">Reservar mi lugar (${p.disponibles} libres)</button>`}
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
  if (partidoActual.precio) rows.unshift(["Importe", money(partidoActual.precio)]);

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

  $("#form-comprobante").reset();
  $("#comprobante-error").classList.add("hidden");
}

// ---- Comprobante ----
$("#form-comprobante").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#comprobante-error");
  err.classList.add("hidden");
  const btn = $("#btn-comprobante");
  btn.disabled = true;
  btn.textContent = "Enviando...";

  const fd = new FormData(e.target);

  try {
    const res = await fetch(`/api/reservas/${reservaActual.id}/comprobante`, {
      method: "POST",
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudo enviar el comprobante.");
    mostrarPaso("listo");
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Enviar comprobante";
  }
});

$("#btn-refrescar").addEventListener("click", cargarPartidos);

cargarPartidos();
setInterval(cargarPartidos, 30000); // refresco automatico
