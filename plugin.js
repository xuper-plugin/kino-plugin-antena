// @ts-check
/// <reference path="./kino.d.ts" />
// Antena (live TV, Xtream Codes): the channels of any Xtream Codes server, in Kino's En vivo tab.
// Read it top to bottom: 1. texts  2. config  3. cache  4. API  5. channels  6. live exports
//                        7. guide  8. resolve and search  9. settings

// ---- 1. texts ----------------------------------------------------------------------------------------------------

const TEXTS = {
  es: {
    notConfigured: "Configura servidor, usuario y contraseña en los ajustes del plugin.",
    badLogin: "Usuario o contraseña incorrectos.",
    expired: "La cuenta está vencida o desactivada.",
    server: "El servidor respondió {status}.",
    unknownRef: "Referencia desconocida.",
    notXtream: "El servidor no respondió como Xtream Codes.",
    askServer: "Escribe la dirección del servidor",
    askUser: "Escribe el usuario",
    askPass: "Escribe la contraseña",
    timeout: "El servidor no responde. Revisa la dirección.",
    network: "No se pudo conectar. Revisa la dirección.",
    unverified: "No se pudo verificar: {detail}",
    unconfigured: "Sin configurar",
    active: "Activa — vence {exp} · {used}/{max} conexiones",
    noLimit: "sin límite",
    offline: "Sin conexión: {detail}",
    ok: "Conectado. Vence: {exp}. Conexiones: {used}/{max}",
  },
  en: {
    notConfigured: "Set the server, username and password in the plugin's settings.",
    badLogin: "Wrong username or password.",
    expired: "The account is expired or disabled.",
    server: "The server answered {status}.",
    unknownRef: "Unknown reference.",
    notXtream: "The server did not answer like Xtream Codes.",
    askServer: "Enter the server address",
    askUser: "Enter the username",
    askPass: "Enter the password",
    timeout: "The server isn't responding. Check the address.",
    network: "Could not connect. Check the address.",
    unverified: "Could not verify: {detail}",
    unconfigured: "Not configured",
    active: "Active — expires {exp} · {used}/{max} connections",
    noLimit: "no limit",
    offline: "Offline: {detail}",
    ok: "Connected. Expires: {exp}. Connections: {used}/{max}",
  },
};

function t(key, vars) {
  const lang = String(kino.lang || "").toLowerCase().startsWith("es") ? "es" : "en";
  const tpl = TEXTS[lang][key] || TEXTS.es[key] || key;
  return vars ? tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] != null ? vars[k] : "")) : tpl;
}

// ---- 2. config ---------------------------------------------------------------------------------------------------

function creds() {
  const server = String(kino.config.get("server") || "").trim().replace(/\/+$/, "");
  const username = String(kino.config.get("username") || "").trim();
  const password = String(kino.config.get("password") || "").trim();
  return { server, username, password };
}

function configured() {
  const c = creds();
  return !!(c.server && c.username && c.password);
}

function liveExt() {
  return kino.config.get("liveFormat") === "ts" ? "ts" : "m3u8";
}

// ---- 3. cache ----------------------------------------------------------------------------------------------------

// kino.storage keeps 256 KB in all: only the (small) category list goes there. Channel lists, which can be
// thousands of entries, live in memory for as long as the plugin's sandbox lives.
const CATS_KEY = "x1:live-cats";
const TTL_CATS = 3 * 60 * 60 * 1000;
const TTL_CHANNELS = 15 * 60 * 1000;
const MEM = new Map();

async function cachedMem(key, ttl, fn) {
  const hit = MEM.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const v = await fn();
  MEM.set(key, { at: Date.now(), v });
  return v;
}

async function cachedCats(fn) {
  const raw = kino.storage.get(CATS_KEY);
  if (raw) {
    try {
      const e = JSON.parse(raw);
      if (e && typeof e.at === "number" && Date.now() - e.at < TTL_CATS) return e.v;
    } catch { /* unreadable: refetch */ }
  }
  const v = await fn();
  const text = JSON.stringify({ at: Date.now(), v });
  if (text.length < 32 * 1024) {
    try { kino.storage.set(CATS_KEY, text); } catch { /* storage full: not cached */ }
  }
  return v;
}

// ---- 4. API ------------------------------------------------------------------------------------------------------

function enc(s) {
  return encodeURIComponent(String(s));
}

function failAuth(info) {
  const u = info && !Array.isArray(info) && typeof info === "object" ? info.user_info : null;
  if (!u) return;
  if (Number(u.auth) === 0) throw kino.error("auth_required", "auth 0", { userMessage: t("badLogin") });
  const status = String(u.status || "").toLowerCase();
  if (status && status !== "active") throw kino.error("auth_required", "status " + status.slice(0, 20), { userMessage: t("expired") });
}

async function api(action, params = {}, timeoutMs = 20000) {
  const { server, username, password } = creds();
  if (!server || !username || !password) {
    throw kino.error("auth_required", "not configured", { userMessage: t("notConfigured") });
  }
  const q = [`username=${enc(username)}`, `password=${enc(password)}`];
  if (action) q.push(`action=${enc(action)}`);
  for (const k of Object.keys(params)) q.push(`${enc(k)}=${enc(params[k])}`);
  const r = await kino.fetch(`${server}/player_api.php?${q.join("&")}`, { timeoutMs });
  if (r.status === 401 || r.status === 403) throw kino.error("auth_required", "http " + r.status, { userMessage: t("badLogin") });
  if (!r.ok) throw kino.error("unavailable", "http " + r.status, { userMessage: t("server", { status: r.status }) });
  let data;
  try { data = r.json(); } catch { throw kino.error("unavailable", "not json", { userMessage: t("notXtream") }); }
  failAuth(data);
  return data;
}

async function list(action, params, timeoutMs) {
  const data = await api(action, params, timeoutMs);
  return Array.isArray(data) ? data : [];
}

// ---- 5. channels -------------------------------------------------------------------------------------------------

const ID = /^[A-Za-z0-9._~-]{1,128}$/;
const DECOR = /[⭐✨✅❌♦️⚡️]|️/g;

function safeId(raw) {
  return String(raw).replace(/[^A-Za-z0-9._~-]/g, "-").slice(0, 120) || "x";
}

function clean(name, fallback, max) {
  return String(name || fallback).replace(DECOR, "").replace(/\s+/g, " ").trim().slice(0, max) || String(fallback);
}

function adultName(name) {
  return /\badult|\+\s?18|18\s?\+|xxx|hentai/i.test(String(name || ""));
}

function genreOf(name) {
  const n = String(name || "").toLowerCase();
  if (/deport|f[uú]tbol|nba|nfl|mls|sport|liga|copa/.test(n)) return "deportes";
  if (/notic|news/.test(n)) return "noticias";
  if (/infantil|ni[nñ]os|kids|cartoon|disney/.test(n)) return "infantil";
  if (/radio|m[uú]sica|music/.test(n)) return "musica";
  if (/document|cultura/.test(n)) return "documentales";
  if (/cine|pel[ií]cula|movie/.test(n)) return "peliculas";
  if (/serie|novela/.test(n)) return "series";
  return undefined;
}

function httpUrl(v) {
  return typeof v === "string" && /^https?:\/\//.test(v) ? v : undefined;
}

function categoriesRaw() {
  return cachedCats(() => list("get_live_categories"));
}

// category_id -> adult, so every channel of an adult category is marked 18+ even when its own name is plain.
async function adultIds() {
  const ids = new Set();
  for (const c of await categoriesRaw()) if (adultName(c.category_name)) ids.add(String(c.category_id));
  return ids;
}

function channel(ch, adult) {
  const catId = String(ch.category_id || "");
  const n = parseInt(ch.num, 10);
  return {
    id: "c" + safeId(ch.stream_id),
    title: clean(ch.name, ch.stream_id, 200),
    ref: "live:" + ch.stream_id,
    categoryId: ID.test(catId) ? catId : undefined,
    logo: httpUrl(ch.stream_icon),
    number: n > 0 && n <= 9999 ? n : undefined,
    adult: adult.has(catId) || adultName(ch.name),
  };
}

// ---- 6. live exports (capability: channels) ----------------------------------------------------------------------

export async function liveCategories() {
  const cats = await categoriesRaw();
  return cats
    .filter((c) => ID.test(String(c.category_id)))
    .map((c) => ({
      id: String(c.category_id),
      title: clean(c.category_name, c.category_id, 100),
      genre: genreOf(c.category_name),
      adult: adultName(c.category_name),
    }));
}

export async function liveChannels({ categoryId, cursor }) {
  const [all, adult] = await Promise.all([
    cachedMem("live:" + categoryId, TTL_CHANNELS, () => list("get_live_streams", { category_id: categoryId })),
    adultIds(),
  ]);
  const PAGE = 500;
  const offset = Math.max(0, parseInt(cursor, 10) || 0);
  return {
    items: all.slice(offset, offset + PAGE).map((ch) => channel(ch, adult)),
    next: offset + PAGE < all.length ? String(offset + PAGE) : undefined,
  };
}

async function findChannels(q, max) {
  const [all, adult] = await Promise.all([
    cachedMem("live-all", TTL_CHANNELS, () => list("get_live_streams", {}, 28000)),
    adultIds(),
  ]);
  return all.filter((ch) => String(ch.name || "").toLowerCase().includes(q)).slice(0, max).map((ch) => channel(ch, adult));
}

export async function liveSearch({ query }) {
  const q = String(query || "").toLowerCase().trim();
  if (q.length < 2) return { items: [] };
  return { items: await findChannels(q, 100) };
}

// ---- 7. guide ----------------------------------------------------------------------------------------------------

function b64text(s) {
  try {
    const bin = atob(String(s || ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return String(s || "");
  }
}

export async function guide({ channelIds, from, to }) {
  const ids = (channelIds || []).filter((id) => /^c\d+$/.test(id)).slice(0, 50);
  const perChannel = await Promise.all(ids.map(async (id) => {
    try {
      const data = await api("get_short_epg", { stream_id: id.slice(1), limit: 12 }, 12000);
      const rows = data && Array.isArray(data.epg_listings) ? data.epg_listings : [];
      const out = [];
      for (const p of rows) {
        const start = parseInt(p.start_timestamp, 10) * 1000;
        const end = parseInt(p.stop_timestamp, 10) * 1000;
        const title = b64text(p.title).trim();
        if (!(start > 0 && end > start && title) || end < from || start > to) continue;
        const description = b64text(p.description).trim();
        out.push({ channelId: id, title: title.slice(0, 200), start, end, ...(description ? { description: description.slice(0, 500) } : {}) });
      }
      return out;
    } catch (e) {
      kino.log("guide failed: " + (e && e.code));
      return [];
    }
  }));
  return perChannel.flat();
}

// ---- 8. resolve and search ---------------------------------------------------------------------------------------

export async function resolve(ref) {
  const { server, username, password } = creds();
  if (!server || !username || !password) {
    throw kino.error("auth_required", "not configured", { userMessage: t("notConfigured") });
  }
  const m = /^live:(\d+)$/.exec(String(ref));
  if (!m) throw kino.error("not_found", "ref", { userMessage: t("unknownRef") });
  const ext = liveExt();
  return {
    url: `${server}/live/${enc(username)}/${enc(password)}/${m[1]}.${ext}`,
    mime: ext === "ts" ? "video/mp2t" : "application/x-mpegURL",
  };
}

// A channel as an item of kind "live": Kino's search and Home rows (apiVersion 6) show it as a channel card.
function liveItem(c) {
  return {
    id: c.id,
    ref: c.ref,
    title: c.title,
    kind: "live",
    poster: c.logo,
    ...(c.adult ? { adult: true } : {}),
  };
}

export async function search(query) {
  if (!configured()) return [];
  const q = String(query.q || "").toLowerCase().trim();
  if (q.length < 2) return [];
  return (await findChannels(q, 40)).map(liveItem);
}

// One row per category (the first plain ones, in the server's order), each with its first channels.
export async function home() {
  if (!configured()) return [];
  const [cats, adult] = await Promise.all([categoriesRaw(), adultIds()]);
  const plain = cats.filter((c) => !adult.has(String(c.category_id)) && ID.test(String(c.category_id))).slice(0, 4);
  const rows = await Promise.all(plain.map(async (c) => {
    try {
      const all = await cachedMem("live:" + c.category_id, TTL_CHANNELS, () => list("get_live_streams", { category_id: c.category_id }));
      const items = all.slice(0, 20).map((ch) => liveItem(channel(ch, adult)));
      if (!items.length) return null;
      return { id: "lc" + safeId(c.category_id), title: clean(c.category_name, c.category_id, 100), items, genre: genreOf(c.category_name) };
    } catch (e) {
      kino.log("home row failed: " + (e && e.code));
      return null;
    }
  }));
  return rows.filter(Boolean);
}

// ---- 9. settings -------------------------------------------------------------------------------------------------

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function dateText(epochSeconds) {
  const n = parseInt(epochSeconds, 10);
  if (!(n > 0)) return t("noLimit");
  const d = new Date(n * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function accountLine(info, key) {
  const u = (info && info.user_info) || {};
  return t(key, { exp: dateText(u.exp_date), used: u.active_cons ?? "?", max: u.max_connections ?? "?" });
}

export async function settingsStatus() {
  if (!configured()) return { accountStatus: t("unconfigured") };
  try {
    return { accountStatus: accountLine(await api("", {}, 10000), "active") };
  } catch (e) {
    return { accountStatus: t("offline", { detail: (e && e.userMessage) || (e && e.code) || "error" }) };
  }
}

export async function action(key) {
  if (key !== "checkConn") return null;
  return { message: accountLine(await api("", {}, 12000), "ok") };
}

export async function validateSettings(values) {
  const server = String(values.server || "").trim().replace(/\/+$/, "");
  const username = String(values.username || "").trim();
  const password = String(values.password || "").trim();
  if (!server) return { server: t("askServer") };
  if (!username) return { username: t("askUser") };
  if (!password) return { password: t("askPass") };
  try {
    const r = await kino.fetch(`${server}/player_api.php?username=${enc(username)}&password=${enc(password)}`, { timeoutMs: 12000 });
    if (!r.ok) return t("server", { status: r.status });
    let data;
    try { data = r.json(); } catch { return t("notXtream"); }
    if (!data || !data.user_info) return t("notXtream");
    if (Number(data.user_info.auth) === 0) return t("badLogin");
  } catch (e) {
    if (e && e.code === "timeout") return t("timeout");
    if (e && e.code === "network") return t("network");
    return t("unverified", { detail: (e && e.code) || "error" });
  }
  return null;
}
