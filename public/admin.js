const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const meses = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const abiertos = new Set(); // partidos con detalle expandido

function formatFecha(fechaISO, hora) {
  const [y, m, d] = fechaISO.split("-").map(Number);
  const fecha = new Date(y, m - 1, d);
  const dias = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
  return `${dias[fecha.getDay()]} ${d} ${meses[m - 1]} · ${hora} hs`;
}
function money(n) { return n ? "$" + Number(n).toLocaleString("es-AR") : "Gratis"; }
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- Auth ----
async function checkAuth() {
  const res = await fetch("/api/admin/estado");
  const { autenticado } = await res.json();
  if (autenticado) mostrarPanel();
  else mostrarLogin();
}
function mostrarLogin() {
  $("#login-view").classList.remove("hidden");
  $("#panel-view").classList.add("hidden");
}
function mostrarPanel() {
  $("#login-view").classList.add("hidden");
  $("#panel-view").classList.remove("hidden");
  cargarAdmin();
}

$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  err.classList.add("hidden");
  const password = new FormData(e.target).get("password");
  const res = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.ok) { mostrarPanel(); }
  else {
    const d = await res.json();
    err.textContent = d.error || "Error";
    err.classList.remove("hidden");
  }
});

$("#btn-logout").addEventListener("click", async () => {
  await fetch("/api/admin/logout", { method: "POST" });
  mostrarLogin();
});

// ---- Ajuste de cupos por tipo ----
$("#tipo-select").addEventListener("change", (e) => {
  $("#cupos-input").value = e.target.value === "9v9" ? 18 : 10;
});

// ---- Crear partido ----
$("#form-partido").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#partido-error");
  err.classList.add("hidden");
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());

  const res = await fetch("/api/admin/partidos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    err.textContent = data.error || "Error al crear.";
    err.classList.remove("hidden");
    return;
  }
  e.target.reset();
  $("#cupos-input").value = 10;
  cargarAdmin();
});

// ---- Cargar lista ----
async function cargarAdmin() {
  const res = await fetch("/api/admin/partidos");
  if (res.status === 401) { mostrarLogin(); return; }
  const partidos = await res.json();
  const cont = $("#admin-lista");

  if (!partidos.length) {
    cont.innerHTML = `<p class="sin-reservas">Todavía no creaste ningún partido.</p>`;
    return;
  }

  cont.innerHTML = partidos.map((p) => renderPartido(p)).join("");
  wireEventos(partidos);
}

function renderPartido(p) {
  const esNueve = p.tipo === "9v9";
  const expandido = abiertos.has(p.id);
  return `
    <div class="admin-partido" data-id="${p.id}">
      <div class="ap-head" data-toggle="${p.id}">
        <div class="ap-info">
          <div class="ap-title">
            <span class="mini-badge ${esNueve ? "nueve" : ""}">${esNueve ? "9v9" : "5v5"}</span>
            ${escapeHtml(p.titulo)}
            <span class="estado-chip ${p.estado}">${p.estado}</span>
          </div>
          <div class="ap-sub">${formatFecha(p.fecha, p.hora)} · ${escapeHtml(p.lugar)} · ${money(p.precio)}</div>
        </div>
        <div class="ap-right">
          <span class="ocupacion"><strong>${p.confirmados}</strong> pagos · ${p.ocupados}/${p.cupos} cupos</span>
          <span>${expandido ? "▲" : "▼"}</span>
        </div>
      </div>
      <div class="ap-body ${expandido ? "" : "hidden"}">
        <div class="ap-controls">
          ${p.estado !== "abierto" ? `<button class="chip-btn" data-estado-partido="${p.id}" data-val="abierto">Reabrir</button>` : ""}
          ${p.estado !== "cerrado" ? `<button class="chip-btn" data-estado-partido="${p.id}" data-val="cerrado">Cerrar</button>` : ""}
          ${p.estado !== "cancelado" ? `<button class="chip-btn" data-estado-partido="${p.id}" data-val="cancelado">Cancelar</button>` : ""}
          <button class="chip-btn danger" data-eliminar="${p.id}">Eliminar</button>
        </div>
        ${renderReservas(p.reservas)}
      </div>
    </div>`;
}

function renderReservas(reservas) {
  if (!reservas || !reservas.length) {
    return `<p class="sin-reservas">Sin reservas todavía.</p>`;
  }
  const filas = reservas.map((r) => `
    <tr>
      <td>${escapeHtml(r.nombre)} ${escapeHtml(r.apellido)}</td>
      <td><a class="tel-link" href="https://wa.me/${r.telefono.replace(/\D/g, "")}" target="_blank">${escapeHtml(r.telefono)}</a></td>
      <td><span class="r-estado ${r.estado}">${r.estado}</span></td>
      <td>
        <div class="row-actions">
          ${r.comprobante ? `<button class="icon-btn view" data-ver="${r.id}" data-mime="${escapeHtml(r.comprobante_mime || "")}">Ver</button>` : `<span class="ap-sub">sin comp.</span>`}
          ${r.estado !== "confirmado" ? `<button class="icon-btn ok" data-reserva="${r.id}" data-val="confirmado">✓</button>` : ""}
          ${r.estado !== "rechazado" ? `<button class="icon-btn no" data-reserva="${r.id}" data-val="rechazado">✕</button>` : ""}
        </div>
      </td>
    </tr>`).join("");

  return `
    <table class="reservas-tabla">
      <thead><tr><th>Jugador</th><th>Teléfono</th><th>Estado</th><th>Acciones</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>`;
}

function wireEventos(partidos) {
  $$("[data-toggle]").forEach((el) => el.addEventListener("click", () => {
    const id = Number(el.dataset.toggle);
    if (abiertos.has(id)) abiertos.delete(id); else abiertos.add(id);
    cargarAdmin();
  }));

  $$("[data-estado-partido]").forEach((btn) => btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await fetch(`/api/admin/partidos/${btn.dataset.estadoPartido}/estado`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estado: btn.dataset.val }),
    });
    cargarAdmin();
  }));

  $$("[data-eliminar]").forEach((btn) => btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("¿Eliminar este partido y todas sus reservas?")) return;
    await fetch(`/api/admin/partidos/${btn.dataset.eliminar}`, { method: "DELETE" });
    abiertos.delete(Number(btn.dataset.eliminar));
    cargarAdmin();
  }));

  $$("[data-reserva]").forEach((btn) => btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await fetch(`/api/admin/reservas/${btn.dataset.reserva}/estado`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estado: btn.dataset.val }),
    });
    cargarAdmin();
  }));

  $$("[data-ver]").forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    verComprobante(btn.dataset.ver, btn.dataset.mime);
  }));
}

// ---- Modal comprobante ----
function verComprobante(reservaId, mime) {
  const url = `/api/admin/comprobante/${reservaId}`;
  const esPdf = (mime || "").includes("pdf");
  $("#comp-body").innerHTML = esPdf
    ? `<iframe src="${url}"></iframe>`
    : `<img src="${url}" alt="comprobante" />`;
  $("#modal-comp").classList.remove("hidden");
}
$("#comp-close").addEventListener("click", () => $("#modal-comp").classList.add("hidden"));
$("#modal-comp").addEventListener("click", (e) => { if (e.target.id === "modal-comp") $("#modal-comp").classList.add("hidden"); });

$("#btn-refrescar-admin").addEventListener("click", cargarAdmin);

checkAuth();
