import { getStore } from "https://esm.sh/@netlify/blobs@8";

const STORE_NAME = "gotham-library";
const BOOKS_KEY  = "books-v1";
const COVERS_KEY = "covers-v1";
const WALLET_KEY = "wallet-v1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function store() {
  return getStore({
    name: STORE_NAME,
    siteID: "cc7277d9-b462-412f-b844-12837810a0cc",
    token: "nfp_1SpaWCmbNW2sDJFgjEpRc1o7uNqQFhPU9459",
  });
}

export default async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url  = new URL(request.url);
  const path = url.pathname;
  const s    = store();

  // ── GET /api/books ──────────────────────────────────────
  if (path === "/api/books" && request.method === "GET") {
    const data = await s.get(BOOKS_KEY, { type: "json" }).catch(() => null);
    return new Response(JSON.stringify(data ?? []), { headers: CORS });
  }

  // ── POST /api/books ─────────────────────────────────────
  if (path === "/api/books" && request.method === "POST") {
    const body = await request.json();
    if (!Array.isArray(body))
      return new Response(JSON.stringify({ error: "Expected array" }), { status: 400, headers: CORS });
    await s.setJSON(BOOKS_KEY, body);
    return new Response(JSON.stringify({ ok: true, count: body.length }), { headers: CORS });
  }

  // ── GET /api/covers ─────────────────────────────────────
  if (path === "/api/covers" && request.method === "GET") {
    const data = await s.get(COVERS_KEY, { type: "json" }).catch(() => null);
    return new Response(JSON.stringify(data ?? {}), { headers: CORS });
  }

  // ── POST /api/covers ────────────────────────────────────
  // Body: { bookId: "b123", cover: "data:image/jpeg;base64,..." }
  // Merges into existing covers map (doesn't overwrite all)
  if (path === "/api/covers" && request.method === "POST") {
    const body = await request.json();
    // Load existing covers
    const existing = await s.get(COVERS_KEY, { type: "json" }).catch(() => ({})) ?? {};
    const updated  = { ...existing, ...body };
    await s.setJSON(COVERS_KEY, updated);
    return new Response(JSON.stringify({ ok: true, total: Object.keys(updated).length }), { headers: CORS });
  }

  // ── GET /api/wallet ─────────────────────────────────────
  if (path === "/api/wallet" && request.method === "GET") {
    const data = await s.get(WALLET_KEY, { type: "json" }).catch(() => null);
    return new Response(JSON.stringify(data ?? { balance: 0, txs: [] }), { headers: CORS });
  }

  // ── POST /api/wallet ────────────────────────────────────
  if (path === "/api/wallet" && request.method === "POST") {
    const body = await request.json();
    await s.setJSON(WALLET_KEY, body);
    return new Response(JSON.stringify({ ok: true }), { headers: CORS });
  }

  return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: CORS });
};

export const config = {
  path: ["/api/books", "/api/covers", "/api/wallet"],
};
