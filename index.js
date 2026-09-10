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

/**
 * Verified Where to Watch provider lookup
 *
 * Uses TMDB's watch-provider data on the server. The browser never receives
 * the TMDB token. Results are classified by availability type and only append
 * to the AniList links already shown by anime.html.
 *
 * Setup:
 *   firebase functions:secrets:set TMDB_API_READ_TOKEN
 *   firebase deploy --only functions
 */
const tmdbToken = defineSecret("TMDB_API_READ_TOKEN");
const TMDB_API = "https://api.themoviedb.org/3";

function normalizeTitle(s) {
  return String(s || "").toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function titleScore(candidate, titles) {
  const c = normalizeTitle(candidate);
  if (!c) return 0;
  let best = 0;
  for (const raw of titles || []) {
    const t = normalizeTitle(raw);
    if (!t) continue;
    if (c === t) best = Math.max(best, 1);
    else if (c.includes(t) || t.includes(c)) best = Math.max(best, 0.82);
    else {
      const a = new Set(c.split(" ")), b = new Set(t.split(" "));
      const common = [...a].filter(x => b.has(x)).length;
      best = Math.max(best, common / Math.max(a.size, b.size, 1));
    }
  }
  return best;
}

exports.watchProviders = onRequest({ secrets: [tmdbToken] }, async (req, res) => {
  const origin = req.headers.origin || "";
  const okOrigin = ALLOWED_ORIGINS.has(origin);
  const base = okOrigin
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };

  if (req.method === "OPTIONS") {
    if (!okOrigin) return res.status(403).json({ error: "origin not allowed" });
    return res.status(204).set({
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    }).send();
  }
  if (req.method !== "POST") return res.status(405).set(base).json({ error: "POST only" });
  if (!okOrigin) return res.status(403).set(base).json({ error: "origin not allowed" });

  const body = req.body || {};
  const titles = Array.isArray(body.titles) ? body.titles.filter(x => typeof x === "string" && x.trim()) : [];
  const title = typeof body.title === "string" ? body.title.trim() : titles[0];
  const year = Number.isInteger(body.year) ? body.year : parseInt(body.year, 10);
  const country = /^[A-Z]{2}$/i.test(body.country || "") ? body.country.toUpperCase() : "IN";
  if (!title) return res.status(400).set(base).json({ error: "missing title" });

  let token;
  try { token = await tmdbToken.value(); }
  catch (e) { return res.status(500).set(base).json({ error: "TMDB function secret is not configured" }); }
  if (!token) return res.status(500).set(base).json({ error: "TMDB function secret is not configured" });

  const tmdbFetch = async path => {
    const r = await fetch(TMDB_API + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.status_message || `TMDB HTTP ${r.status}`);
    return j;
  };

  try {
    // Search with every AniList title variant, then choose the strongest match.
    const queries = [...new Set([title, ...titles])].slice(0, 4);
    const candidates = [];
    for (const q of queries) {
      const params = new URLSearchParams({ query: q, include_adult: "false", language: "en-US" });
      const j = await tmdbFetch(`/search/tv?${params}`);
      candidates.push(...(j.results || []));
    }
    const unique = [...new Map(candidates.map(x => [x.id, x])).values()];
    const ranked = unique.map(x => {
      let score = titleScore(x.name, queries) * 0.8;
      if (year && x.first_air_date && String(x.first_air_date).startsWith(String(year))) score += 0.2;
      return { x, score };
    }).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best || best.score < 0.55) return res.status(200).set(base).json({ providers: [], country, matched: false });

    const providersData = await tmdbFetch(`/tv/${best.x.id}/watch/providers`);
    const region = (providersData.results || {})[country];
    if (!region) return res.status(200).set(base).json({ providers: [], country, matched: true, title: best.x.name });

    const groups = [
      ["flatrate", "subscription"], ["free", "free"], ["ads", "ads"],
      ["rent", "rent"], ["buy", "buy"]
    ];
    const seen = new Set();
    const providers = [];
    for (const [field, type] of groups) {
      for (const p of region[field] || []) {
        const key = normalizeTitle(p.provider_name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        providers.push({ name: p.provider_name, type });
      }
    }

    // TMDB provides the regional availability page link. It is used for each
    // newly discovered provider so we never invent provider URLs.
    res.status(200).set(base).json({
      providers,
      link: region.link || "",
      country,
      matched: true,
      title: best.x.name
    });
  } catch (e) {
    res.status(502).set(base).json({ error: "watch provider lookup failed: " + ((e && e.message) || e) });
  }
});
