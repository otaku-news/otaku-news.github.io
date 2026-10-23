/**
 * Otaku News — AniList token exchange proxy (Cloud Function, v2, Node 20)
 *
 * WHY IT EXISTS
 * The site's OAuth "Connect AniList" flow ends with a code→token exchange at
 * POST https://anilist.co/api/v2/oauth/token. Done from the browser that is a
 * cross-origin fetch, and live probes of that endpoint (Aug 2026) showed NO
 * Access-Control-Allow-Origin headers on responses to unknown clients — the
 * browser exchange could be CORS-blocked. This function performs the exchange
 * server-side, so:
 *   • CORS: we answer the preflight ourselves → works by construction
 *   • secret: ANILIST_CLIENT_SECRET lives here (a function secret), not in
 *     any visitor's browser
 *
 * CONFIGURE (one-time, from the repo root):
 *   1) put your client ID + the exact registered redirect URI into firebase.json
 *      ("functions" → "params")
 *   2) firebase functions:secrets:set ANILIST_CLIENT_SECRET
 *   3) firebase deploy --only functions
 *   4) in index.html:  window.OTAKU_ANILIST_TOKEN_PROXY = "<function URL>"
 *      (the URL is in the deploy output / console → Functions; the region
 *       prefix depends on your project)
 *
 * SECURITY NOTES
 *   • Origin allowlist: only the site's own origin (plus local dev) is
 *     answered; everything else gets 403 with no CORS headers.
 *   • The body carries only the one-use authorization `code` — nothing that
 *     is reusable after the exchange, and nothing secret.
 *   • The secret is read from the function environment and is never echoed
 *     into any response.
 *   • No rate limiter in v1: the code is single-use and the free-tier quota
 *     already bounds abuse; add a Firestore counter if the site gets busy.
 */
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");

const clientSecret = defineSecret("ANILIST_CLIENT_SECRET");
const clientId = defineString({ param: "ANILIST_CLIENT_ID" });
const redirectUri = defineString({
  param: "ANILIST_REDIRECT_URI",
  default: "https://otaku-news.github.io/account.html",
});

const ALLOWED_ORIGINS = new Set([
  "https://otaku-news.github.io", // production
  "http://localhost:8000",        // local preview
  "http://127.0.0.1:8000",        // local preview
]);

const TOKEN_ENDPOINT = "https://anilist.co/api/v2/oauth/token";

exports.anilistToken = onRequest(async (req, res) => {
  const origin = req.headers.origin || "";
  const okOrigin = ALLOWED_ORIGINS.has(origin);
  const base = okOrigin
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };

  // Preflight: only for allowed origins.
  if (req.method === "OPTIONS") {
    if (!okOrigin) return res.status(403).json({ error: "origin not allowed" });
    res.status(204).set({
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    }).send();
    return;
  }

  if (req.method !== "POST") {
    return res.status(405).set(base).json({ error: "POST only" });
  }
  if (!okOrigin) {
    return res.status(403).set(base).json({ error: "origin not allowed" });
  }

  // v2 onRequest parses JSON bodies into req.body; rawBody is the string form.
  let body = req.body;
  if (!body && typeof req.rawBody === "string" && req.rawBody) {
    try { body = JSON.parse(req.rawBody); } catch (e) { body = {}; }
  }
  body = body || {};
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) return res.status(400).set(base).json({ error: "missing code" });

  let cid, csec, ruri;
  try {
    const got = await Promise.all([clientId.get(), clientSecret.get(), redirectUri.get()]);
    [cid, csec, ruri] = got;
  } catch (e) {
    return res.status(500).set(base).json({ error: "function not configured — set ANILIST_CLIENT_ID and ANILIST_CLIENT_SECRET" });
  }
  if (!cid || !csec) {
    return res.status(500).set(base).json({ error: "client id / secret not configured on the function" });
  }

  const payload = new URLSearchParams({
    grant_type: "authorization_code",
    code: code,
    client_id: cid,
    client_secret: csec,
    redirect_uri: ruri,
  }).toString();

  try {
    const r = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: payload,
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j && j.access_token) {
      res.status(200).set(base).json({ token: j.access_token });
    } else {
      res.status(400).set(base).json({
        error: (j && (j.message || j.error_description || j.error)) || ("AniList HTTP " + r.status),
      });
    }
  } catch (e) {
    res.status(502).set(base).json({ error: "could not reach AniList: " + ((e && e.message) || e) });
  }
});
