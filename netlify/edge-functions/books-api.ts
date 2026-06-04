// @ts-nocheck
import { getStore } from "@netlify/blobs";

const BOOKS_KEY  = "books-v1";
const COVERS_KEY = "covers-v1";
const WALLET_KEY = "wallet-v1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export default async (request: Request, context: any) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const path = new URL(request.url).pathname;
  
  // Use context-aware store (no siteID/token needed - Netlify injects automatically)
  const store = getStore("gotham-library");

  // ── GET /api/books ──────────────────────────────────────
  if (path === "/api/books" && request.method === "GET") {
    const data = await store.get(BOOKS_KEY, { type: "json" }).catch(() => null);
    return new Response(JSON.stringify(data ?? []), { headers: CORS });
  }

  // ── POST /api/books ─────────────────────────────────────
  if (path === "/api/books" && request.method === "POST") {
    const body = await request.json();
    if (!Array.isArray(body))
      return new Response(JSON.stringify({ error: "Expected array" }), { status: 400, headers: CORS });
    await store.setJSON(BOOKS_KEY, body);
    return new Response(JSON.stringify({ ok: true, count: body.length }), { headers: CORS });
  }

  // ── GET /api/covers ─────────────────────────────────────
  if (path === "/api/covers" && request.method === "GET") {
    const data = await store.get(COVERS_KEY, { type: "json" }).catch(() => null);
    return new Response(JSON.stringify(data ?? {}), { headers: CORS });
  }

  // ── POST /api/covers ────────────────────────────────────
  if (path === "/api/covers" && request.method === "POST") {
    const body = await request.json();
    const existing = await store.get(COVERS_KEY, { type: "json" }).catch(() => ({})) ?? {};
    await store.setJSON(COVERS_KEY, { ...existing, ...body });
    return new Response(JSON.stringify({ ok: true }), { headers: CORS });
  }

  // ── GET /api/wallet ─────────────────────────────────────
  if (path === "/api/wallet" && request.method === "GET") {
    const data = await store.get(WALLET_KEY, { type: "json" }).catch(() => null);
    return new Response(JSON.stringify(data ?? { balance: 0, txs: [] }), { headers: CORS });
  }

  // ── POST /api/wallet ────────────────────────────────────
  if (path === "/api/wallet" && request.method === "POST") {
    const body = await request.json();
    await store.setJSON(WALLET_KEY, body);
    return new Response(JSON.stringify({ ok: true }), { headers: CORS });
  }

  return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: CORS });
};

export const config = {
  path: ["/api/books", "/api/covers", "/api/wallet"],
};
