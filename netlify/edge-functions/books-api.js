// Gotham Library - Netlify Edge Function
// Sin imports externos: fetch directo a la API REST de Netlify Blobs.
//
// - El token NO está en el código: se lee de la variable de entorno BLOBS_TOKEN.
// - Los datos se guardan en el store "gotham-library" de ESTE sitio
//   (gothamlibrary-emefreak-new). Si algo aún no existe aquí, se copia una vez
//   desde el sitio antiguo (gothamlibrary-old), que nunca se modifica.
// - IMPORTANTE (límite de CPU de Netlify, ~50 ms): la biblioteca pesa varios MB,
//   así que los libros pasan como BYTES: no se decodifican ni se convierten a objetos.
// - Protecciones: no se acepta una lista vacía ni una que borre muchos libros de
//   golpe (la app envía el número de libros en la cabecera X-Count), y una vez al
//   día se guarda una copia del estado anterior en "books-prev".

const BOOKS_KEY  = "books-v1";
const META_KEY   = "books-meta";
const COVERS_KEY = "covers-v1";
const WALLET_KEY = "wallet-v1";
const FUNKOS_KEY = "funkos-v1";

const SITE_ID     = "8049dab7-42eb-410b-b1a8-d96822f0850f"; // gothamlibrary-emefreak-new
const OLD_SITE_ID = "cc7277d9-b462-412f-b844-12837810a0cc"; // gothamlibrary-old (solo lectura)

const NEW_BASE = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${encodeURIComponent("site:gotham-library")}`;
const OLD_BASE = `https://api.netlify.com/api/v1/blobs/${OLD_SITE_ID}/gotham-library`;

const MAX_DROP = 10; // máximo de elementos que se pueden eliminar en un solo guardado

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

// ── Acceso a Blobs como texto (sin parsear) ─────────────────────
async function getText(base, key) {
  const r = await fetch(`${base}/${key}`, { headers: { Authorization: `Bearer ${token()}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${key} failed: ${r.status}`);
  const text = await r.text();
  return text ? text : null;
}

// Bytes tal cual (sin decodificar): para la biblioteca, que pesa varios MB
async function getBytes(base, key) {
  const r = await fetch(`${base}/${key}`, { headers: { Authorization: `Bearer ${token()}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${key} failed: ${r.status}`);
  const buf = await r.arrayBuffer();
  return buf.byteLength ? buf : null;
}

async function putText(key, text) {
  const r = await fetch(`${NEW_BASE}/${key}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: text,
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

// Para datos pequeños (alcancía, Funkos, portadas antiguas) sí se parsea.
async function getJSON(key, migrate = true) {
  const t = migrate ? await getTextMigrating(key) : await getText(NEW_BASE, key);
  return t === null ? null : JSON.parse(t);
}
const putJSON = (key, value) => putText(key, JSON.stringify(value));

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

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: CORS });
const raw = (text, status = 200) => new Response(text, { status, headers: CORS });

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const path = new URL(request.url).pathname;

  try {
    // ── LIBROS (como texto) ───────────────────────────────────
    if (path === "/api/books" && request.method === "GET") {
      const r = await fetch(`${NEW_BASE}/${BOOKS_KEY}`, { headers: { Authorization: `Bearer ${token()}` } });
      if (r.ok) return new Response(r.body, { headers: CORS });
      if (r.status !== 404) throw new Error(`GET ${BOOKS_KEY} failed: ${r.status}`);
      const old = await getBytes(OLD_BASE, BOOKS_KEY);      // primera vez: copiar del sitio antiguo
      if (!old) return raw("[]");
      await putText(BOOKS_KEY, old);
      return new Response(old, { headers: CORS });
    }

    if (path === "/api/books" && request.method === "POST") {
      const buf = new Uint8Array(await request.arrayBuffer());
      let i = 0; while (i < buf.length && (buf[i] === 32 || buf[i] === 10 || buf[i] === 13 || buf[i] === 9)) i++;
      if (buf[i] !== 0x5b) return json({ error: "Expected array" }, 400);   // debe empezar por "["

      // La app envía el número de libros en X-Count. Las versiones antiguas no lo envían:
      // contarlo leyendo 10 MB supera el límite de CPU, así que en ese caso solo se
      // comprueba que la lista no venga vacía.
      const header = parseInt(request.headers.get("x-count") || "", 10);
      const count = Number.isFinite(header) ? header : null;
      if (count === 0 || buf.length < 50) return json({ error: "Guardado bloqueado: la lista llegó vacía" }, 409);

      const meta = (await getJSON(META_KEY, false)) || {};
      if (count !== null && typeof meta.count === "number" && meta.count - count > MAX_DROP) {
        return json({ error: "Guardado bloqueado: faltarían demasiados libros", existing: meta.count, received: count }, 409);
      }

      // Copia del estado anterior, una vez al día (sin parsear: texto tal cual)
      const today = new Date().toISOString().slice(0, 10);
      if (meta.prevDate !== today) {
        const prev = await getBytes(NEW_BASE, BOOKS_KEY);
        if (prev) await putText("books-prev", prev);
        meta.prevDate = today;
      }

      await putText(BOOKS_KEY, buf);
      await putJSON(META_KEY, { ...meta, ...(count !== null ? { count } : {}), updatedAt: Date.now() });
      return json({ ok: true, count });
    }

    // ── PORTADAS (sistema antiguo) ────────────────────────────
    if (path === "/api/covers" && request.method === "GET") {
      return raw((await getTextMigrating(COVERS_KEY)) ?? "{}");
    }

    if (path === "/api/covers" && request.method === "POST") {
      const body = await request.json();
      const existing = (await getJSON(COVERS_KEY)) ?? {};
      await putJSON(COVERS_KEY, { ...existing, ...body });
      return json({ ok: true });
    }

    // ── FUNKOS ────────────────────────────────────────────────
    // GET devuelve null si todavía no existe (la app carga entonces la colección inicial)
    if (path === "/api/funkos" && request.method === "GET") {
      return raw((await getText(NEW_BASE, FUNKOS_KEY)) ?? "null");
    }

    if (path === "/api/funkos" && request.method === "POST") {
      const body = await request.json();
      if (!Array.isArray(body)) return json({ error: "Expected array" }, 400);
      const prevText = await getText(NEW_BASE, FUNKOS_KEY);
      const existing = prevText ? JSON.parse(prevText) : [];
      if (existing.length - body.length > MAX_DROP) {
        return json({ error: "Guardado bloqueado: faltarían demasiados Funkos", existing: existing.length, received: body.length }, 409);
      }
      if (prevText) await putText("funkos-prev", prevText);
      await putJSON(FUNKOS_KEY, body);
      return json({ ok: true, count: body.length });
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
  path: ["/api/books", "/api/covers", "/api/wallet", "/api/funkos", "/api/funko-search"],
};
