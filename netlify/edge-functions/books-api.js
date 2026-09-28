// Gotham Library - Netlify Edge Function
// Sin imports externos: fetch directo a la API REST de Netlify Blobs.
//
// - El token NO está en el código: se lee de la variable de entorno BLOBS_TOKEN
//   (Netlify > Project configuration > Environment variables).
// - Los datos se guardan en el store "gotham-library" de ESTE sitio
//   (gothamlibrary-emefreak-new), visible en Data & storage > Blobs.
// - La primera vez que se lee algo que aún no existe aquí, se copia desde el
//   sitio antiguo (gothamlibrary-old). El sitio antiguo NO se modifica nunca.
// - Protecciones: no se acepta una lista vacía ni una que borre muchos libros de
//   golpe, y antes de cada guardado se conserva la versión anterior (books-prev).

const BOOKS_KEY  = "books-v1";
const COVERS_KEY = "covers-v1";
const WALLET_KEY = "wallet-v1";
const FUNKOS_KEY = "funkos-v1";

const SITE_ID     = "8049dab7-42eb-410b-b1a8-d96822f0850f"; // gothamlibrary-emefreak-new
const OLD_SITE_ID = "cc7277d9-b462-412f-b844-12837810a0cc"; // gothamlibrary-old (solo lectura)

const NEW_BASE = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${encodeURIComponent("site:gotham-library")}`;
const OLD_BASE = `https://api.netlify.com/api/v1/blobs/${OLD_SITE_ID}/gotham-library`;

const MAX_DROP = 10; // máximo de libros que se pueden eliminar en un solo guardado

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function token() {
  const t = Netlify.env.get("BLOBS_TOKEN");
  if (!t) throw new Error("Falta la variable de entorno BLOBS_TOKEN");
  return t;
}

async function rawGet(base, key) {
  const r = await fetch(`${base}/${key}`, { headers: { Authorization: `Bearer ${token()}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${key} failed: ${r.status}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function blobSet(key, value) {
  const r = await fetch(`${NEW_BASE}/${key}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`PUT ${key} failed: ${r.status}`);
}

// Lee de este sitio; si aún no existe, lo copia una vez desde el sitio antiguo.
async function blobGet(key) {
  const current = await rawGet(NEW_BASE, key);
  if (current !== null) return current;
  const old = await rawGet(OLD_BASE, key);
  if (old !== null) await blobSet(key, old);
  return old;
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

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: CORS });

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const path = new URL(request.url).pathname;

  try {
    // ── LIBROS ────────────────────────────────────────────────
    if (path === "/api/books" && request.method === "GET") {
      return json((await blobGet(BOOKS_KEY)) ?? []);
    }

    if (path === "/api/books" && request.method === "POST") {
      const body = await request.json();
      if (!Array.isArray(body)) return json({ error: "Expected array" }, 400);

      const existing = (await blobGet(BOOKS_KEY)) ?? [];
      if (body.length === 0 && existing.length > 0) {
        return json({ error: "Guardado bloqueado: la lista llegó vacía", existing: existing.length }, 409);
      }
      if (existing.length - body.length > MAX_DROP) {
        return json({ error: "Guardado bloqueado: faltarían demasiados libros", existing: existing.length, received: body.length }, 409);
      }

      if (existing.length) await blobSet("books-prev", existing);
      await blobSet(BOOKS_KEY, body);
      return json({ ok: true, count: body.length });
    }

    // ── PORTADAS ──────────────────────────────────────────────
    if (path === "/api/covers" && request.method === "GET") {
      return json((await blobGet(COVERS_KEY)) ?? {});
    }

    if (path === "/api/covers" && request.method === "POST") {
      const body = await request.json();
      const existing = (await blobGet(COVERS_KEY)) ?? {};
      await blobSet(COVERS_KEY, { ...existing, ...body });
      return json({ ok: true });
    }

    // ── FUNKOS ────────────────────────────────────────────────
    // GET devuelve null si todavía no existe (la app carga entonces la colección inicial)
    if (path === "/api/funkos" && request.method === "GET") {
      return json(await rawGet(NEW_BASE, FUNKOS_KEY));
    }

    if (path === "/api/funkos" && request.method === "POST") {
      const body = await request.json();
      if (!Array.isArray(body)) return json({ error: "Expected array" }, 400);
      const existing = (await rawGet(NEW_BASE, FUNKOS_KEY)) ?? [];
      if (existing.length - body.length > MAX_DROP) {
        return json({ error: "Guardado bloqueado: faltarían demasiados Funkos", existing: existing.length, received: body.length }, 409);
      }
      if (existing.length) await blobSet("funkos-prev", existing);
      await blobSet(FUNKOS_KEY, body);
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
      return json((await blobGet(WALLET_KEY)) ?? { balance: 0, txs: [] });
    }

    if (path === "/api/wallet" && request.method === "POST") {
      const body = await request.json();
      await blobSet(WALLET_KEY, body);
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
