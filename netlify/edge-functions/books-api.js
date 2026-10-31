// Gotham Library - Netlify Edge Function
// Sin imports externos: fetch directo a la API REST de Netlify Blobs.
//
// - El token NO está en el código: se lee de la variable de entorno BLOBS_TOKEN.
// - Los datos se guardan en el store "gotham-library" de ESTE sitio
//   (gothamlibrary-emefreak-new). Si algo aún no existe aquí, se copia una vez
//   desde el sitio antiguo (gothamlibrary-old), que nunca se modifica.
// - Portadas de libros y fotos de Funkos se guardan cada una aparte
//   ("cover-<id>"); las listas solo llevan su dirección (/api/cover/<id>?v=...).
//   Así las listas pesan pocos KB y caben de sobra en el límite de CPU (~50 ms).
// - GUARDADO POR CAMBIOS (dos personas a la vez): la app envía solo lo que ha
//   cambiado { upserts: [...], deletes: [ids] } y el servidor lo MEZCLA con lo
//   que ya hay, elemento a elemento, usando "updatedAt". Nadie pisa los cambios
//   del otro. La respuesta es la lista completa ya mezclada.
// - Protecciones: no se borran más de MAX_DELETES elementos en un guardado, no se
//   acepta dejar la lista vacía, y una vez al día se guarda una copia del estado
//   anterior ("books-v1-prev" / "funkos-v1-prev").

const BOOKS_KEY  = "books-v1";
const FUNKOS_KEY = "funkos-v1";
const COVERS_KEY = "covers-v1";
const WALLET_KEY = "wallet-v1";

const SITE_ID     = "8049dab7-42eb-410b-b1a8-d96822f0850f"; // gothamlibrary-emefreak-new
const OLD_SITE_ID = "cc7277d9-b462-412f-b844-12837810a0cc"; // gothamlibrary-old (solo lectura)

const NEW_BASE = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${encodeURIComponent("site:gotham-library")}`;
const OLD_BASE = `https://api.netlify.com/api/v1/blobs/${OLD_SITE_ID}/gotham-library`;

const MAX_DELETES = 25;                 // borrados permitidos en un solo guardado
const MAX_LIST_BYTES = 3_000_000;       // una lista ligera pesa KB; más de esto = app antigua
const TOMBSTONE_DAYS = 60;              // cuánto se recuerda un borrado

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Count",
  "Content-Type": "application/json",
};

function token() {
  const t = Netlify.env.get("BLOBS_TOKEN");
  if (!t) throw new Error("Falta la variable de entorno BLOBS_TOKEN");
  return t;
}

// ── Acceso a Blobs ───────────────────────────────────────────────
async function getText(base, key) {
  const r = await fetch(`${base}/${key}`, { headers: { Authorization: `Bearer ${token()}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${key} failed: ${r.status}`);
  const text = await r.text();
  return text ? text : null;
}

async function putText(key, body) {
  const r = await fetch(`${NEW_BASE}/${key}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body,
  });
  if (!r.ok) throw new Error(`PUT ${key} failed: ${r.status}`);
}

// Lee de este sitio; si aún no existe, lo copia una vez desde el sitio antiguo.
async function getTextMigrating(key) {
  const current = await getText(NEW_BASE, key);
  if (current !== null) return current;
  const old = await getText(OLD_BASE, key);
  if (old !== null) await putText(key, old);
  return old;
}

async function getJSON(key, migrate = true) {
  const t = migrate ? await getTextMigrating(key) : await getText(NEW_BASE, key);
  return t === null ? null : JSON.parse(t);
}
const putJSON = (key, value) => putText(key, JSON.stringify(value));

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: CORS });
const raw = (text, status = 200) => new Response(text, { status, headers: CORS });

// ── Mezcla de listas (libros o Funkos) ──────────────────────────
// body:
//   { upserts: [...], deletes: [ids] }  → mezcla por elemento (la app nueva)
//   { replace: [...] }                  → sustituye todo (restaurar un backup)
//   [ ... ]                              → app antigua: se mezcla como upserts, sin borrar
async function saveList(key, body) {
  const metaKey = key + "-meta";
  const curText = await getTextMigrating(key);
  const cur = curText ? JSON.parse(curText) : [];
  const meta = (await getJSON(metaKey, false)) || {};
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);

  // Tombstones: borrados recientes, para que un móvil desactualizado no los resucite
  const tomb = {};
  for (const [id, ts] of Object.entries(meta.deleted || {})) {
    if (now - ts < TOMBSTONE_DAYS * 86400000) tomb[id] = ts;
  }

  let out;
  if (body && Array.isArray(body.replace)) {
    out = body.replace.filter((x) => x && x.id);
    if (!out.length) return { error: "Restauración bloqueada: la lista llegó vacía", status: 409 };
  } else {
    const legacy = Array.isArray(body);
    const ups = legacy ? body : (Array.isArray(body && body.upserts) ? body.upserts : []);
    const dels = legacy ? [] : (Array.isArray(body && body.deletes) ? body.deletes : []);
    if (dels.length > MAX_DELETES) {
      return { error: `Guardado bloqueado: se intentaban borrar ${dels.length} elementos a la vez`, status: 409 };
    }

    const byId = new Map(cur.filter((x) => x && x.id).map((x) => [x.id, x]));
    const fresh = [];
    for (const u of ups) {
      if (!u || !u.id) continue;
      const uts = u.updatedAt || 0;
      if (tomb[u.id] && uts <= tomb[u.id]) continue;          // se borró después de esta edición
      const e = byId.get(u.id);
      if (!e) { fresh.push(u); byId.set(u.id, u); }
      else if (uts >= (e.updatedAt || 0)) byId.set(u.id, u);   // gana la edición más reciente
    }
    for (const id of dels) {
      if (typeof id !== "string") continue;
      byId.delete(id);
      tomb[id] = now;
    }

    const freshIds = new Set(fresh.map((x) => x.id));
    out = [
      ...fresh.filter((x) => byId.has(x.id)).map((x) => byId.get(x.id)),   // nuevos, primero
      ...cur.filter((x) => x && x.id && byId.has(x.id) && !freshIds.has(x.id)).map((x) => byId.get(x.id)),
    ];
    if (!out.length && cur.length > 3) {
      return { error: "Guardado bloqueado: la lista se quedaría vacía", status: 409 };
    }
  }

  if (meta.prevDate !== today && curText) {
    await putText(key + "-prev", curText);               // copia diaria del estado anterior
  }
  const outText = JSON.stringify(out);
  await putText(key, outText);
  await putJSON(metaKey, { ...meta, deleted: tomb, count: out.length, updatedAt: now, prevDate: today });
  return { text: outText };
}

async function handleListPost(request, key) {
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_LIST_BYTES) {
    return json({ error: "La app está desactualizada: ciérrala del todo y vuelve a abrirla" }, 413);
  }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(buf)); }
  catch { return json({ error: "Datos no válidos" }, 400); }
  const res = await saveList(key, body);
  if (res.error) return json({ error: res.error }, res.status);
  return raw(res.text);
}

// Convierte un producto del catálogo (popfigures.com) en datos de Funko
function parseFunko(p) {
  const t = String(p.title || "").replace(/\s*-\s*PREORDER\s*$/i, "").trim();
  let name = t, number = "", rest = "";
  const m = t.match(/^(.*?)\s*#\s*(\d+[A-Za-z]?)\s*(\([^)]*\))?\s*(.*)$/);
  if (m) { name = (m[1] + (m[3] ? " " + m[3] : "")).trim(); number = m[2]; rest = m[4]; }
  else { const k = t.search(/Funko/i); if (k > 0) { name = t.slice(0, k).trim(); rest = t.slice(k); } }
  const parts = rest.split(/\s+-\s+/).slice(1);
  let image = p.image || (p.featured_image && p.featured_image.url) || "";
  if (image.startsWith("//")) image = "https:" + image;
  if (image) image += (image.includes("?") ? "&" : "?") + "width=360";
  return { name, number, franchise: (parts[0] || "").trim(), extra: parts.slice(1).join(" · "), image, line: p.product_type || "" };
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const path = new URL(request.url).pathname;

  try {
    // ── LIBROS ────────────────────────────────────────────────
    if (path === "/api/books" && request.method === "GET") {
      const r = await fetch(`${NEW_BASE}/${BOOKS_KEY}`, { headers: { Authorization: `Bearer ${token()}` } });
      if (r.ok) return new Response(r.body, { headers: { ...CORS, "Cache-Control": "no-store" } });
      if (r.status !== 404) throw new Error(`GET ${BOOKS_KEY} failed: ${r.status}`);
      return raw((await getTextMigrating(BOOKS_KEY)) ?? "[]");
    }
    if (path === "/api/books" && request.method === "POST") {
      return await handleListPost(request, BOOKS_KEY);
    }

    // ── FUNKOS ────────────────────────────────────────────────
    // GET devuelve null si todavía no existe (la app carga entonces la colección inicial)
    if (path === "/api/funkos" && request.method === "GET") {
      const r = await fetch(`${NEW_BASE}/${FUNKOS_KEY}`, { headers: { Authorization: `Bearer ${token()}` } });
      if (r.ok) return new Response(r.body, { headers: { ...CORS, "Cache-Control": "no-store" } });
      if (r.status !== 404) throw new Error(`GET ${FUNKOS_KEY} failed: ${r.status}`);
      return raw("null");
    }
    if (path === "/api/funkos" && request.method === "POST") {
      return await handleListPost(request, FUNKOS_KEY);
    }

    // ── PORTADA / FOTO INDIVIDUAL: /api/cover/<id> ────────────
    const cm = path.match(/^\/api\/cover\/([A-Za-z0-9_-]{1,100})$/);
    if (cm && request.method === "GET") {
      const t = await getText(NEW_BASE, "cover-" + cm[1]);
      const m = t && t.match(/^data:([^;,]+);base64,(.*)$/s);
      if (!m) return new Response("", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
      const bin = atob(m[2]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(bytes, { headers: { "Access-Control-Allow-Origin": "*", "Content-Type": m[1], "Cache-Control": "public, max-age=31536000, immutable" } });
    }
    if (cm && request.method === "POST") {
      const t = (await request.text()).trim();
      if (!/^data:image\/[a-z0-9+.-]+;base64,/i.test(t) || t.length > 3000000) return json({ error: "Imagen no válida" }, 400);
      await putText("cover-" + cm[1], t);
      return json({ ok: true, url: `/api/cover/${cm[1]}?v=${Date.now()}` });
    }

    // ── PORTADAS (sistema antiguo, solo lectura) ──────────────
    if (path === "/api/covers" && request.method === "GET") {
      return raw((await getTextMigrating(COVERS_KEY)) ?? "{}");
    }
    if (path === "/api/covers" && request.method === "POST") {
      return json({ ok: true, ignored: true });   // obsoleto
    }

    // ── BUSCADOR DE FUNKOS (catálogo público de popfigures.com) ──
    if (path === "/api/funko-search" && request.method === "GET") {
      const q = (new URL(request.url).searchParams.get("q") || "").trim();
      if (q.length < 2) return json([]);
      const u = `https://www.popfigures.com/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=10`;
      const r = await fetch(u, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (GothamLibrary)" } });
      if (!r.ok) return json([]);
      const data = await r.json();
      const prods = (data && data.resources && data.resources.results && data.resources.results.products) || [];
      return json(prods.map(parseFunko).filter((x) => x.name));
    }

    // ── ALCANCÍA ──────────────────────────────────────────────
    if (path === "/api/wallet" && request.method === "GET") {
      return json((await getJSON(WALLET_KEY)) ?? { balance: 0, txs: [] });
    }
    if (path === "/api/wallet" && request.method === "POST") {
      const body = await request.json();
      await putJSON(WALLET_KEY, body);
      return json({ ok: true });
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }

  return json({ error: "Not found" }, 404);
};

export const config = {
  path: ["/api/books", "/api/covers", "/api/cover/*", "/api/wallet", "/api/funkos", "/api/funko-search"],
};
