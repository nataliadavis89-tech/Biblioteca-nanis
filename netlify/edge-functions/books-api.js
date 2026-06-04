// Gotham Library - Netlify Edge Function
// No external imports - pure fetch to Netlify Blobs REST API

const BOOKS_KEY  = "books-v1";
const COVERS_KEY = "covers-v1";
const WALLET_KEY = "wallet-v1";
const STORE_NAME = "gotham-library";
const SITE_ID    = "cc7277d9-b462-412f-b844-12837810a0cc";
const TOKEN      = "nfp_1SpaWCmbNW2sDJFgjEpRc1o7uNqQFhPU9459";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const BLOB_BASE = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE_NAME}`;

async function blobGet(key) {
  const r = await fetch(`${BLOB_BASE}/${key}`, {
    headers: { "Authorization": `Bearer ${TOKEN}` }
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${key} failed: ${r.status}`);
  const text = await r.text();
  if (!text) return null;
  return JSON.parse(text);
}

async function blobSet(key, value) {
  const r = await fetch(`${BLOB_BASE}/${key}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(value)
  });
  if (!r.ok) throw new Error(`PUT ${key} failed: ${r.status}`);
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const path = new URL(request.url).pathname;

  try {
    // GET /api/books
    if (path === "/api/books" && request.method === "GET") {
      const data = await blobGet(BOOKS_KEY);
      return new Response(JSON.stringify(data ?? []), { headers: CORS });
    }

    // POST /api/books
    if (path === "/api/books" && request.method === "POST") {
      const body = await request.json();
      if (!Array.isArray(body))
        return new Response(JSON.stringify({ error: "Expected array" }), { status: 400, headers: CORS });
      await blobSet(BOOKS_KEY, body);
      return new Response(JSON.stringify({ ok: true, count: body.length }), { headers: CORS });
    }

    // GET /api/covers
    if (path === "/api/covers" && request.method === "GET") {
      const data = await blobGet(COVERS_KEY);
      return new Response(JSON.stringify(data ?? {}), { headers: CORS });
    }

    // POST /api/covers
    if (path === "/api/covers" && request.method === "POST") {
      const body = await request.json();
      const existing = await blobGet(COVERS_KEY) ?? {};
      await blobSet(COVERS_KEY, { ...existing, ...body });
      return new Response(JSON.stringify({ ok: true }), { headers: CORS });
    }

    // GET /api/wallet
    if (path === "/api/wallet" && request.method === "GET") {
      const data = await blobGet(WALLET_KEY);
      return new Response(JSON.stringify(data ?? { balance: 0, txs: [] }), { headers: CORS });
    }

    // POST /api/wallet
    if (path === "/api/wallet" && request.method === "POST") {
      const body = await request.json();
      await blobSet(WALLET_KEY, body);
      return new Response(JSON.stringify({ ok: true }), { headers: CORS });
    }

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: CORS });
  }

  return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: CORS });
};

export const config = {
  path: ["/api/books", "/api/covers", "/api/wallet"],
};
