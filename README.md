# ⚽ Reservas de Fútbol

App web para que la gente entre por un link, vea los partidos disponibles (5 vs 5 y 9 vs 9), reserve su lugar y lo asegure transfiriendo y subiendo el comprobante. Incluye un panel de organizador para crear partidos y confirmar pagos.

## Stack
- Node.js + Express (backend/API)
- SQLite vía @libsql/client — usa **Turso** (nube) en producción o un archivo local en desarrollo
- HTML/CSS/JS puro en el frontend (sin frameworks)
- Multer para subir comprobantes

## Cómo funciona

**Para el jugador:**
1. Entra al sitio y ve las tarjetas de partidos con cupos en tiempo real.
2. Toca "Reservar mi lugar" y completa nombre, apellido y teléfono.
3. Se le muestran los datos de la transferencia (alias/CBU) con botones para copiar.
4. Transfiere y sube el comprobante (imagen o PDF).
5. Su lugar queda **pendiente** hasta que el organizador confirma el pago.

El cupo se sostiene por un tiempo limitado (30 min por defecto). Si no sube el comprobante a tiempo, la reserva expira y libera el lugar.

**Para el organizador (`/admin.html`):**
1. Entra con contraseña.
2. Crea partidos (tipo 5v5/9v9, lugar, fecha, hora, cupos, precio). Los cupos se autocompletan: 10 para 5v5, 18 para 9v9.
3. Ve las reservas de cada partido, abre los comprobantes y confirma o rechaza cada pago.
4. Puede cerrar, reabrir, cancelar o eliminar partidos. El teléfono de cada jugador es un link directo a WhatsApp.

## Instalación

```bash
cd reservas-futbol
npm install
npm start
```

Luego abrí:
- Sitio público: http://localhost:3100
- Panel organizador: http://localhost:3100/admin.html

> El puerto por defecto es **3100** para no chocar con la app de finanzas (que usa el 3000). Podés cambiarlo con la variable `PORT`.

## Configuración

Todo se configura con variables de entorno (o editando `src/config.js`):

| Variable | Descripción | Default |
|---|---|---|
| `PORT` | Puerto del servidor | `3100` |
| `ADMIN_PASSWORD` | Contraseña del panel | `admin1234` |
| `TURSO_DATABASE_URL` | URL de la base Turso (producción). Si falta, usa archivo local | — |
| `TURSO_AUTH_TOKEN` | Token de Turso (producción) | — |
| `PAGO_TITULAR` | Nombre del titular de la cuenta | — |
| `PAGO_ALIAS` | Alias para transferir | — |
| `PAGO_CBU` | CBU/CVU (si se deja vacío, no se muestra) | — |
| `PAGO_BANCO` | Banco/billetera | — |
| `MINUTOS_RESERVA` | Minutos que se sostiene el cupo sin comprobante | `30` |

Para publicar la app gratis (Render + Turso, sin tarjeta), seguí **[DEPLOY.md](DEPLOY.md)**.

> **Importante:** cambiá `ADMIN_PASSWORD` y cargá tus datos reales de transferencia antes de compartir el link.

Ejemplo en PowerShell:

```powershell
$env:ADMIN_PASSWORD="miClaveSegura"
$env:PAGO_ALIAS="mi.alias.mp"
$env:PAGO_TITULAR="Sergio Coronato"
npm start
```

## Notas técnicas
- En producción los datos se guardan en **Turso** (persistentes). En desarrollo, si no hay credenciales Turso, se crea un archivo local `data/reservas.db` automáticamente.
- Los comprobantes se guardan en `uploads/` (solo accesibles desde el panel de admin).
- Las sesiones de admin se guardan en memoria: reiniciar el server cierra la sesión (no afecta partidos ni reservas).
- La creación de reservas es transaccional: no se puede sobrepasar el cupo aunque dos personas reserven a la vez.

## Ideas para más adelante
- Integrar Mercado Pago para confirmar pagos automáticamente.
- Notificación por WhatsApp/email al confirmar.
- Lista de espera cuando el partido está completo.
