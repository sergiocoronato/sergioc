const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const meses = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const abiertos = new Set(); // partidos con detalle expandido

let partidosCache = [];      // ultimos partidos cargados del servidor
let filtroActual = "proximos"; // proximos | pasados | todos
let busquedaActual = "";

// Un partido se considera finalizado 60 min despues de su inicio (hora Argentina UTC-3).
function partidoFinalizado(p) {
  if (!p.fecha || !p.hora) return false;
  const inicio = new Date(`${p.fecha}T${p.hora}:00-03:00`);
  if (isNaN(inicio)) return false;
  const fin = new Date(inicio.getTime() + 60 * 60 * 1000);
  return Date.now() > fin.getTime();
}

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
  partidosCache = await res.json();
  renderLista();
}

// Aplica filtro (proximos/pasados/todos) y busqueda, y dibuja la lista.
function renderLista() {
  const cont = $("#admin-lista");
  const resBusq = $("#resultado-busqueda");
  resBusq.innerHTML = "";

  if (!partidosCache.length) {
    cont.innerHTML = `<p class="sin-reservas">Todavía no creaste ningún partido.</p>`;
    return;
  }

  // Busqueda de jugador: si hay texto, muestra coincidencias de todos los partidos.
  const q = busquedaActual.trim().toLowerCase();
  if (q) {
    renderBusqueda(q);
    cont.innerHTML = "";
    return;
  }

  let lista = partidosCache.slice();
  if (filtroActual === "proximos") lista = lista.filter((p) => !partidoFinalizado(p));
  else if (filtroActual === "pasados") lista = lista.filter((p) => partidoFinalizado(p));
  // "todos" no filtra

  // Orden: proximos por fecha ascendente; pasados por fecha descendente (lo mas reciente primero).
  lista.sort((a, b) => {
    const ka = `${a.fecha} ${a.hora}`, kb = `${b.fecha} ${b.hora}`;
    return filtroActual === "pasados" ? kb.localeCompare(ka) : ka.localeCompare(kb);
  });

  if (!lista.length) {
    const txt = filtroActual === "pasados" ? "No hay partidos finalizados todavía." : "No hay partidos próximos.";
    cont.innerHTML = `<p class="sin-reservas">${txt}</p>`;
    return;
  }

  cont.innerHTML = lista.map((p) => renderPartido(p)).join("");
  wireEventos(lista);
}

// Busca un jugador por nombre/apellido/telefono en TODAS las reservas.
function renderBusqueda(q) {
  const resBusq = $("#resultado-busqueda");
  const hits = [];
  for (const p of partidosCache) {
    for (const r of (p.reservas || [])) {
      const texto = `${r.nombre} ${r.apellido} ${r.telefono}`.toLowerCase();
      if (texto.includes(q)) hits.push({ p, r });
    }
  }
  if (!hits.length) {
    resBusq.innerHTML = `<p class="sin-reservas">Sin resultados para "${escapeHtml(q)}".</p>`;
    return;
  }
  const filas = hits.map(({ p, r }) => {
    const cant = Number(r.cantidad) || 1;
    const extra = cant > 1 ? ` (+${cant - 1})` : "";
    return `
      <tr>
        <td>${escapeHtml(r.nombre)} ${escapeHtml(r.apellido)}${extra}</td>
        <td><a class="tel-link" href="https://wa.me/${(r.telefono||'').replace(/\D/g, "")}" target="_blank">${escapeHtml(r.telefono)}</a></td>
        <td><span class="r-estado ${r.estado}">${r.estado}</span></td>
        <td>${escapeHtml(p.titulo)}<br><span class="ap-sub">${formatFecha(p.fecha, p.hora)}</span></td>
      </tr>`;
  }).join("");
  resBusq.innerHTML = `
    <p class="ap-sub" style="margin-bottom:8px;">${hits.length} resultado(s):</p>
    <table class="reservas-tabla">
      <thead><tr><th>Jugador</th><th>Teléfono</th><th>Estado</th><th>Partido</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>`;
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
          <button class="chip-btn wsp" data-copiar="${p.id}">📋 Copiar confirmados (WhatsApp)</button>
          <button class="chip-btn" data-editar="${p.id}">✏️ Editar</button>
          ${p.estado !== "abierto" ? `<button class="chip-btn" data-estado-partido="${p.id}" data-val="abierto">Reabrir</button>` : ""}
          ${p.estado !== "cerrado" ? `<button class="chip-btn" data-estado-partido="${p.id}" data-val="cerrado">Cerrar</button>` : ""}
          ${p.estado !== "cancelado" ? `<button class="chip-btn" data-estado-partido="${p.id}" data-val="cancelado">Cancelar</button>` : ""}
          <button class="chip-btn danger" data-eliminar="${p.id}">Eliminar</button>
        </div>
        ${renderReservas(p.reservas)}
        <div class="agregar-jugador">
          <button class="chip-btn" data-agregar="${p.id}">➕ Agregar jugador</button>
          <form class="form-agregar hidden" data-form-agregar="${p.id}">
            <input name="nombre" placeholder="Nombre" required />
            <input name="apellido" placeholder="Apellido" />
            <input name="telefono" placeholder="Teléfono" />
            <input name="cantidad" type="number" min="1" value="1" title="Cantidad de lugares" />
            <button class="chip-btn wsp" type="submit">Agregar</button>
            <button class="chip-btn" type="button" data-cancelar-agregar="${p.id}">Cancelar</button>
            <span class="agregar-error" data-agregar-error="${p.id}"></span>
          </form>
        </div>
      </div>
    </div>`;
}

function renderReservas(reservas) {
  if (!reservas || !reservas.length) {
    return `<p class="sin-reservas">Sin reservas todavía.</p>`;
  }
  const filas = reservas.map((r) => {
    const cant = Number(r.cantidad) || 1;
    const extra = cant > 1 ? ` <span class="acompanantes">(+${cant - 1})</span>` : "";
    return `
    <tr>
      <td>${escapeHtml(r.nombre)} ${escapeHtml(r.apellido)}${extra}</td>
      <td><a class="tel-link" href="https://wa.me/${r.telefono.replace(/\D/g, "")}" target="_blank">${escapeHtml(r.telefono)}</a></td>
      <td><span class="r-estado ${r.estado}">${r.estado}</span></td>
      <td>
        <div class="row-actions">
          ${r.comprobante ? `<button class="icon-btn view" data-ver="${r.id}" data-mime="${escapeHtml(r.comprobante_mime || "")}">Ver</button>` : `<span class="ap-sub">sin comp.</span>`}
          ${r.estado !== "confirmado" ? `<button class="icon-btn ok" data-reserva="${r.id}" data-val="confirmado">✓</button>` : ""}
          ${r.estado !== "rechazado" ? `<button class="icon-btn no" data-reserva="${r.id}" data-val="rechazado">✕</button>` : ""}
          <button class="icon-btn no" data-borrar-reserva="${r.id}" title="Borrar reserva">🗑</button>
        </div>
      </td>
    </tr>`;
  }).join("");

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

  $$("[data-copiar]").forEach((btn) => btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const partido = partidos.find((x) => x.id === Number(btn.dataset.copiar));
    if (partido) await copiarConfirmados(partido, btn);
  }));

  $$("[data-editar]").forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const partido = partidos.find((x) => x.id === Number(btn.dataset.editar));
    if (partido) abrirEditar(partido);
  }));

  // Borrar una reserva puntual (libera el cupo)
  $$("[data-borrar-reserva]").forEach((btn) => btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("¿Borrar esta reserva? Se libera el cupo.")) return;
    await fetch(`/api/admin/reservas/${btn.dataset.borrarReserva}`, { method: "DELETE" });
    cargarAdmin();
  }));

  // Mostrar el mini-form de agregar jugador
  $$("[data-agregar]").forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const form = document.querySelector(`[data-form-agregar="${btn.dataset.agregar}"]`);
    if (form) { form.classList.remove("hidden"); btn.classList.add("hidden"); form.querySelector('[name="nombre"]').focus(); }
  }));

  // Cancelar el mini-form
  $$("[data-cancelar-agregar]").forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = btn.dataset.cancelarAgregar;
    const form = document.querySelector(`[data-form-agregar="${id}"]`);
    const abrir = document.querySelector(`[data-agregar="${id}"]`);
    if (form) form.classList.add("hidden");
    if (abrir) abrir.classList.remove("hidden");
  }));

  // Enviar el mini-form: agrega jugador confirmado
  $$("[data-form-agregar]").forEach((form) => form.addEventListener("submit", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const id = form.dataset.formAgregar;
    const fd = new FormData(form);
    const errSpan = document.querySelector(`[data-agregar-error="${id}"]`);
    errSpan.textContent = "";
    const res = await fetch(`/api/admin/partidos/${id}/reserva-manual`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nombre: fd.get("nombre"),
        apellido: fd.get("apellido"),
        telefono: fd.get("telefono"),
        cantidad: Number(fd.get("cantidad")) || 1,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      errSpan.textContent = data.error || "No se pudo agregar.";
      return;
    }
    cargarAdmin();
  }));
}

// ---- Editar partido ----
function abrirEditar(p) {
  const f = $("#form-editar");
  f.id.value = p.id;
  f.tipo.value = p.tipo;
  f.titulo.value = p.titulo || "";
  f.lugar.value = p.lugar || "";
  f.fecha.value = p.fecha || "";
  f.hora.value = p.hora || "";
  f.cupos.value = p.cupos;
  f.precio.value = p.precio || 0;
  $("#editar-error").classList.add("hidden");
  $("#modal-editar").classList.remove("hidden");
}

$("#editar-close").addEventListener("click", () => $("#modal-editar").classList.add("hidden"));
$("#modal-editar").addEventListener("click", (e) => { if (e.target.id === "modal-editar") $("#modal-editar").classList.add("hidden"); });

// Al cambiar el tipo, sugerir los cupos por defecto (sin pisar si ya los editó a mano no es critico aca).
$("#editar-tipo").addEventListener("change", (e) => {
  $("#editar-cupos").value = e.target.value === "9v9" ? 18 : 10;
});

$("#form-editar").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#editar-error");
  err.classList.add("hidden");
  const fd = new FormData(e.target);
  const id = fd.get("id");
  const body = {
    tipo: fd.get("tipo"),
    titulo: fd.get("titulo"),
    lugar: fd.get("lugar"),
    fecha: fd.get("fecha"),
    hora: fd.get("hora"),
    cupos: Number(fd.get("cupos")),
    precio: Number(fd.get("precio")) || 0,
  };

  const res = await fetch(`/api/admin/partidos/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    err.textContent = data.error || "No se pudo guardar.";
    err.classList.remove("hidden");
    return;
  }
  $("#modal-editar").classList.add("hidden");
  cargarAdmin();
});

// Arma el texto de confirmados y lo copia al portapapeles (para pegar en WhatsApp).
async function copiarConfirmados(p, btn) {
  const confirmados = (p.reservas || []).filter((r) => r.estado === "confirmado");
  const tipo = p.tipo === "9v9" ? "9 vs 9" : "5 vs 5";

  let texto = `⚽ ${p.titulo} (${tipo})\n`;
  texto += `📅 ${formatFecha(p.fecha, p.hora)}\n`;
  texto += `📍 ${p.lugar}\n\n`;

  if (!confirmados.length) {
    texto += `Todavía no hay jugadores confirmados.`;
  } else {
    // El total cuenta lugares (sumando acompañantes), no cantidad de reservas.
    const totalLugares = confirmados.reduce((acc, r) => acc + (Number(r.cantidad) || 1), 0);
    texto += `✅ Confirmados (${totalLugares}/${p.cupos}):\n`;
    confirmados.forEach((r, i) => {
      const cant = Number(r.cantidad) || 1;
      const extra = cant > 1 ? ` (+${cant - 1})` : "";
      texto += `${i + 1}. ${r.nombre} ${r.apellido}${extra}\n`;
    });
  }

  try {
    await navigator.clipboard.writeText(texto);
    const original = btn.textContent;
    btn.textContent = "✓ ¡Copiado!";
    setTimeout(() => { btn.textContent = original; }, 1800);
  } catch (err) {
    // Fallback si el navegador bloquea el portapapeles: mostrar el texto para copiar a mano.
    window.prompt("Copiá la lista (Ctrl+C):", texto);
  }
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

// Buscador de jugador
$("#buscador").addEventListener("input", (e) => {
  busquedaActual = e.target.value;
  renderLista();
});

// Filtros proximos / historial / todos
$$(".chip-filtro").forEach((btn) => btn.addEventListener("click", () => {
  $$(".chip-filtro").forEach((b) => b.classList.remove("activo"));
  btn.classList.add("activo");
  filtroActual = btn.dataset.filtro;
  renderLista();
}));

checkAuth();
