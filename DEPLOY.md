# 🚀 Publicar gratis (sin tarjeta y sin que caduque)

Esta guía deja la web online usando:
- **Render** para el hosting (plan free: sin tarjeta, no caduca).
- **Turso** para la base de datos (SQLite en la nube: gratis, sin tarjeta, **datos permanentes**).

Con esta combinación los partidos y reservas **no se borran nunca**.

> ⚠️ Un detalle: los **comprobantes** (las imágenes que sube la gente) se guardan en el disco del hosting, y en el plan free de Render ese disco se reinicia cada tanto. Los datos de las reservas quedan siempre (en Turso), pero las imágenes de comprobantes viejos pueden desaparecer. Para la mayoría de los casos alcanza, porque confirmás el pago en el momento. Si querés que las imágenes también sean permanentes, avisame y lo configuramos con un almacenamiento aparte (también gratis).

---

## PARTE A — Crear la base de datos en Turso (5 min)

1. Entrá a https://turso.tech y registrate (podés usar tu cuenta de GitHub o email). **No pide tarjeta.**
2. Creá una base de datos nueva (botón "Create Database"). Ponele un nombre, por ejemplo `reservas-futbol`.
3. Cuando esté creada, necesitás dos datos:
   - **Database URL**: algo como `libsql://reservas-futbol-tuusuario.turso.io`
   - **Auth Token**: lo generás con el botón "Create Token" (o "Generate Token").
4. Copiá esos dos valores, los vas a pegar en Render (Parte C).

---

## PARTE B — Subir el proyecto a GitHub (5 min)

Render necesita el código en un repositorio. La forma más simple sin instalar nada:

1. Entrá a https://github.com y creá una cuenta si no tenés (gratis, sin tarjeta).
2. Creá un repositorio nuevo (botón "New"), ponele `reserva-futbol-bariloche`, dejalo **público** o privado (da igual), y crealo **sin** README.
3. En la página del repo vacío, hacé clic en **"uploading an existing file"**.
4. Arrastrá **todo el contenido de la carpeta `reservas-futbol`** (los archivos y carpetas: `src`, `public`, `package.json`, `render.yaml`, etc.).
   - ❌ **No** subas la carpeta `node_modules` ni `data` (son pesadas y no hacen falta; Render las genera solo).
5. Confirmá con "Commit changes".

> Si preferís usar Git por terminal y lo tenés instalado, es lo mismo: `git init`, `git add`, `git commit`, `git remote add`, `git push`.

---

## PARTE C — Publicar en Render (5 min)

1. Entrá a https://render.com y registrate con tu cuenta de GitHub. **No pide tarjeta** para el plan free.
2. Clic en **"New +" → "Web Service"**.
3. Conectá el repositorio `reserva-futbol-bariloche` que subiste.
4. Render detecta la config del archivo `render.yaml`. Confirmá:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node --no-warnings src/server.js`
   - **Plan**: Free
5. En **"Environment Variables"** (o "Environment"), agregá estas variables con tus valores reales:

   | Variable | Valor |
   |---|---|
   | `TURSO_DATABASE_URL` | la Database URL de Turso (Parte A) |
   | `TURSO_AUTH_TOKEN` | el Auth Token de Turso (Parte A) |
   | `ADMIN_PASSWORD` | tu contraseña de admin (ej. `BarilocheFutbol2026!!`) |
   | `PAGO_TITULAR` | `Jose Maidana` |
   | `PAGO_ALIAS` | `Barilochefutbol` |
   | `PAGO_BANCO` | `Mercado Pago` |

   (No hace falta `PAGO_CBU`: si no lo ponés, no se muestra.)

6. Clic en **"Create Web Service"**. Render construye y publica. En un par de minutos te da la URL, algo como:
   `https://reserva-futbol-bariloche.onrender.com`

---

## ✅ Listo

- **Link para los jugadores**: la URL `.onrender.com` que te dio Render.
- **Panel del organizador**: esa misma URL + `/admin.html`

## Cómo actualizar después
Cada vez que cambies algo del código, subís los archivos nuevos a GitHub (mismo paso B) y Render **redespliega solo**. Para cambiar la contraseña o los datos de pago, editás las Environment Variables en el panel de Render y se reinicia solo.

## Notas
- En el plan free de Render, la app "se duerme" tras 15 min sin uso y la primera visita después puede tardar ~30 segundos en despertar. Es normal.
- Los partidos y reservas viven en Turso, así que persisten aunque la app se duerma o se reinicie.
