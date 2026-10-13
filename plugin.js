// @ts-check
/// <reference path="./kino.d.ts" />
// Antena — live TV via Xtream Codes. Modes: auto (repo accounts) | custom (own server).

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
    autoSearching: "Buscando servidor disponible…",
    autoOk: "Auto — vence {exp} · {used}/{max} conexiones",
    autoFailed: "No se encontró ningún servidor disponible.",
    autoRetry: "Buscando de nuevo…",
    noServers: "No se pudo obtener la lista de servidores.",
  },
  en: {
    notConfigured: "Set the server, username and password in the plugin settings.",
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
    autoSearching: "Looking for an available server…",
    autoOk: "Auto — expires {exp} · {used}/{max} connections",
    autoFailed: "No available server found.",
    autoRetry: "Searching again…",
    noServers: "Could not fetch server list.",
  },
};

function t(key, vars) {
  const lang = String(kino.lang || "").toLowerCase().startsWith("es") ? "es" : "en";
  const tpl = TEXTS[lang][key] || TEXTS.es[key] || key;
  return vars ? tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] != null ? vars[k] : "")) : tpl;
}

// ---- 2. crypto (AES-128-GCM, sealed manifest key) ---------------------------------------------------------------

// Stored format: "b64Nonce.b64CiphertextTag"
function dec(enc) {
  const dot = String(enc || "").indexOf(".");
  if (dot < 0) return "";
  try {
    return kino.crypto.decrypt("aes-128-gcm", {
      key: kino.secret("serverKey"),
      iv: enc.slice(0, dot), ivEncoding: "base64",
      data: enc.slice(dot + 1), inputEncoding: "base64",
      outputEncoding: "utf8",
    });
  } catch { return ""; }
}

// ---- 3. config ---------------------------------------------------------------------------------------------------

const INDEX_URL = "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-antena/main/data/index.json";
const CRED_KEY = "x1:auto-cred";
const CRED_TTL = 6 * 60 * 60 * 1000;

function isAuto() { return kino.config.get("mode") !== "custom"; }

function creds() {
  if (isAuto()) {
    const raw = kino.storage.get(CRED_KEY);
    if (raw) {
      try {
        const e = JSON.parse(raw);
        if (e && Date.now() - e.at < CRED_TTL) return { server: e.s, username: e.u, password: e.p };
      } catch { /* stale */ }
    }
    return { server: "", username: "", password: "" };
  }
  return {
    server: String(kino.config.get("server") || "").trim().replace(/\/+$/, ""),
    username: String(kino.config.get("username") || "").trim(),
    password: String(kino.config.get("password") || "").trim(),
  };
}

function configured() { const c = creds(); return !!(c.server && c.username && c.password); }
function liveExt() { return kino.config.get("liveFormat") === "ts" ? "ts" : "m3u8"; }

function saveCred(s, u, p) {
  try { kino.storage.set(CRED_KEY, JSON.stringify({ at: Date.now(), s, u, p })); } catch { /* full */ }
}
function clearCred() { try { kino.storage.set(CRED_KEY, ""); } catch { /* ok */ } }

// ---- 4. cache ----------------------------------------------------------------------------------------------------

const CATS_KEY = "x1:live-cats";
const TTL_CATS = 3 * 60 * 60 * 1000;
const TTL_CH = 15 * 60 * 1000;
const MEM = new Map();

async function memCache(key, ttl, fn) {
  const h = MEM.get(key);
  if (h && Date.now() - h.at < ttl) return h.v;
  const v = await fn();
  MEM.set(key, { at: Date.now(), v });
  return v;
}

async function cachedCats(key, fn) {
  const raw = kino.storage.get(key);
  if (raw) {
    try {
      const e = JSON.parse(raw);
      if (e && Date.now() - e.at < TTL_CATS) return e.v;
    } catch { /* refetch */ }
  }
  const v = await fn();
  const text = JSON.stringify({ at: Date.now(), v });
  if (text.length < 32 * 1024) try { kino.storage.set(key, text); } catch { /* full */ }
  return v;
}

function flushCache() { MEM.clear(); }

// ---- 5. API ------------------------------------------------------------------------------------------------------

function urlEnc(s) { return encodeURIComponent(String(s)); }

function failAuth(data) {
  const u = data && !Array.isArray(data) && typeof data === "object" ? data.user_info : null;
  if (!u) return;
  if (Number(u.auth) === 0) throw kino.error("auth_required", "auth 0", { userMessage: t("badLogin") });
  const st = String(u.status || "").toLowerCase();
  if (st && st !== "active") throw kino.error("auth_required", "status " + st.slice(0, 20), { userMessage: t("expired") });
}

async function callApi(server, username, password, action, params = {}, ms = 20000) {
  const q = [`username=${urlEnc(username)}`, `password=${urlEnc(password)}`];
  if (action) q.push(`action=${urlEnc(action)}`);
  for (const k of Object.keys(params)) q.push(`${urlEnc(k)}=${urlEnc(params[k])}`);
  const r = await kino.fetch(`${server}/player_api.php?${q.join("&")}`, { timeoutMs: ms });
  if (r.status === 401 || r.status === 403) throw kino.error("auth_required", "http " + r.status, { userMessage: t("badLogin") });
  if (!r.ok) throw kino.error("unavailable", "http " + r.status, { userMessage: t("server", { status: r.status }) });
  let data;
  try { data = r.json(); } catch { throw kino.error("unavailable", "not json", { userMessage: t("notXtream") }); }
  failAuth(data);
  return data;
}

async function ensureCred() {
  const c = creds();
  if (c.server && c.username && c.password) return c;
  if (!isAuto()) throw kino.error("auth_required", "not configured", { userMessage: t("notConfigured") });
  return findAccount();
}

async function api(action, params = {}, ms = 20000) {
  const c = await ensureCred();
  try {
    return await callApi(c.server, c.username, c.password, action, params, ms);
  } catch (e) {
    if (!isAuto()) throw e;
    clearCred(); flushCache();
    const f = await findAccount(tagOf(c.server)).catch(() => findAccount());
    return callApi(f.server, f.username, f.password, action, params, ms);
  }
}

async function lst(action, params, ms) {
  const data = await api(action, params, ms);
  return Array.isArray(data) ? data : [];
}

// ---- auto mode: find a working account ---------------------------------------------------------------------------

function tagOf(server) {
  let h = 0;
  for (const ch of String(server)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 1296).toString(36).padStart(2, "0");
}

async function useServer(tag) {
  const c = creds();
  if (c.server && c.username && c.password && (tagOf(c.server) === tag || !isAuto())) return c;
  try { return await findAccount(tag); } catch { return ensureCred(); }
}

function notExpired(entry) {
  if (!entry || typeof entry.e !== "number") return true;
  return Date.now() < entry.e * 1000;
}

async function streams(server, username, password, categoryId) {
  try {
    const list = await callApi(server, username, password, "get_live_streams", { category_id: categoryId }, 12000);
    for (const x of (Array.isArray(list) ? list : []).slice(0, 3)) {
      const r = await kino.fetch(`${server}/live/${urlEnc(username)}/${urlEnc(password)}/${x.stream_id}.m3u8`, { redirect: "manual", timeoutMs: 8000 });
      if (r.status >= 200 && r.status < 400) return true;
    }
  } catch { /* not usable */ }
  return false;
}

async function tryFile(url, tag, limit = 8) {
  let accounts;
  try {
    const r = await kino.fetch(url, { timeoutMs: 15000 });
    if (!r.ok) return null;
    accounts = r.json();
  } catch { return null; }
  if (!Array.isArray(accounts)) return null;
  const pool = accounts.slice().sort(() => Math.random() - 0.5);
  for (const entry of pool.slice(0, limit)) {
    if (!entry || !entry.s || !entry.u || !entry.p || !notExpired(entry)) continue;
    if (tag && tagOf(entry.s) !== tag) continue;
    const server = entry.s;
    const username = dec(entry.u);
    const password = dec(entry.p);
    if (!username || !password) continue;
    try {
      const cats = await callApi(server, username, password, "get_live_categories", {}, 10000);
      if (!Array.isArray(cats) || !cats.length) continue;
      if (!(await streams(server, username, password, cats[0].category_id))) continue;
      return { server, username, password };
    } catch { /* try next */ }
  }
  return null;
}

async function findAccount(tag) {
  let files;
  try {
    const r = await kino.fetch(INDEX_URL, { timeoutMs: 10000 });
    if (!r.ok) throw new Error("idx " + r.status);
    const idx = r.json();
    if (!idx || !Array.isArray(idx.files)) throw new Error("bad idx");
    files = idx.files;
  } catch {
    throw kino.error("unavailable", "index", { userMessage: t("noServers") });
  }
  const shuffled = files.slice().sort(() => Math.random() - 0.5);
  for (const url of shuffled) {
    const found = await tryFile(url, tag);
    if (found) { saveCred(found.server, found.username, found.password); flushCache(); return found; }
  }
  throw kino.error("unavailable", "no account", { userMessage: t("autoFailed") });
}

// ---- 6. channels -------------------------------------------------------------------------------------------------

const ID = /^[A-Za-z0-9._~-]{1,128}$/;
const DECOR = /[⭐✨✅❌♦️⚡️]|️/g;
function safeId(raw) { return String(raw).replace(/[^A-Za-z0-9._~-]/g, "-").slice(0, 120) || "x"; }
function clean(name, fb, max) { return String(name || fb).replace(DECOR, "").replace(/\s+/g, " ").trim().slice(0, max) || String(fb); }
function adultName(name) { return /\badult|\+\s?18|18\s?\+|xxx|hentai/i.test(String(name || "")); }

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

function httpUrl(v) { return typeof v === "string" && /^https?:\/\//.test(v) ? v : undefined; }
async function catsRaw() {
  const { server } = await ensureCred();
  return cachedCats(CATS_KEY + ":" + server, () => lst("get_live_categories"));
}

async function adultIds() {
  const ids = new Set();
  for (const c of await catsRaw()) if (adultName(c.category_name)) ids.add(String(c.category_id));
  return ids;
}

function buildChannel(c, adult, tg) {
  const catId = String(c.category_id || "");
  const n = parseInt(c.num, 10);
  return {
    id: "c" + tg + "_" + safeId(c.stream_id),
    title: clean(c.name, c.stream_id, 200),
    ref: "live:" + tg + ":" + c.stream_id,
    categoryId: ID.test(catId) ? catId : undefined,
    logo: httpUrl(c.stream_icon),
    number: n > 0 && n <= 9999 ? n : undefined,
    adult: adult.has(catId) || adultName(c.name),
  };
}

// ---- 7. live exports ---------------------------------------------------------------------------------------------

export async function liveCategories() {
  const { server } = await ensureCred();
  const tg = tagOf(server);
  const cats = await catsRaw();
  return cats.filter((c) => ID.test(String(c.category_id))).map((c) => ({
    id: tg + "_" + String(c.category_id),
    title: clean(c.category_name, c.category_id, 100),
    genre: genreOf(c.category_name),
    adult: adultName(c.category_name),
  }));
}

export async function liveChannels({ categoryId, cursor }) {
  const m = /^([0-9a-z]{2})_(.+)$/.exec(String(categoryId));
  const cat = m ? m[2] : String(categoryId);
  const c = m ? await useServer(m[1]) : await ensureCred();
  const tg = tagOf(c.server);
  const [all, adult] = await Promise.all([
    memCache("live:" + tg + ":" + cat, TTL_CH, () => lst("get_live_streams", { category_id: cat })),
    adultIds(),
  ]);
  const PAGE = 500, off = Math.max(0, parseInt(cursor, 10) || 0);
  return {
    items: all.slice(off, off + PAGE).map((ch) => buildChannel(ch, adult, tg)),
    next: off + PAGE < all.length ? String(off + PAGE) : undefined,
  };
}

async function findChannels(q, max) {
  const { server } = await ensureCred();
  const tg = tagOf(server);
  const [all, adult] = await Promise.all([
    memCache("live-all:" + tg, TTL_CH, () => lst("get_live_streams", {}, 28000)),
    adultIds(),
  ]);
  return all.filter((c) => String(c.name || "").toLowerCase().includes(q)).slice(0, max).map((c) => buildChannel(c, adult, tg));
}

export async function liveSearch({ query }) {
  const q = String(query || "").toLowerCase().trim();
  if (q.length < 2) return { items: [] };
  return { items: await findChannels(q, 100) };
}

// ---- 8. guide ----------------------------------------------------------------------------------------------------

function b64text(s) {
  try {
    const bin = atob(String(s || ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch { return String(s || ""); }
}

export async function guide({ channelIds, from, to }) {
  const cur = await ensureCred();
  const tg = tagOf(cur.server);
  const ids = (channelIds || []).map((id) => /^c([0-9a-z]{2})_(\d+)$/.exec(String(id))).filter((m) => m && m[1] === tg).slice(0, 20);
  const out = [];
  let failed = false;
  for (let i = 0; i < ids.length && !failed; i += 6) {
    await Promise.all(ids.slice(i, i + 6).map(async (m) => {
      try {
        const data = await callApi(cur.server, cur.username, cur.password, "get_short_epg", { stream_id: m[2], limit: 12 }, 10000);
        const rows = data && Array.isArray(data.epg_listings) ? data.epg_listings : [];
        for (const p of rows) {
          const start = parseInt(p.start_timestamp, 10) * 1000;
          const end = parseInt(p.stop_timestamp, 10) * 1000;
          const title = b64text(p.title).trim();
          if (!(start > 0 && end > start && title) || end < from || start > to) continue;
          const description = b64text(p.description).trim();
          out.push({ channelId: m[0], title: title.slice(0, 200), start, end, ...(description ? { description: description.slice(0, 500) } : {}) });
        }
      } catch (e) { failed = true; kino.log("guide: " + (e && e.code)); }
    }));
  }
  return out;
}

// ---- 9. resolve and search ---------------------------------------------------------------------------------------

async function playable(url) {
  try {
    const r = await kino.fetch(url, { redirect: "manual", timeoutMs: 6000 });
    return r.status >= 200 && r.status < 400;
  } catch { return false; }
}

async function alternate(tag, build, current) {
  let files;
  try {
    const r = await kino.fetch(INDEX_URL, { timeoutMs: 10000 });
    const idx = r.json();
    files = Array.isArray(idx && idx.files) ? idx.files.slice().sort(() => Math.random() - 0.5) : [];
  } catch { return null; }
  let tried = 0;
  for (const url of files.slice(0, 3)) {
    let accounts;
    try { accounts = (await kino.fetch(url, { timeoutMs: 15000 })).json(); } catch { continue; }
    if (!Array.isArray(accounts)) continue;
    const pool = accounts.filter((e) => e && e.s && e.u && e.p && tagOf(e.s) === tag && notExpired(e)).sort(() => Math.random() - 0.5);
    for (const e of pool) {
      if (tried >= 6) return null;
      const username = dec(e.u), password = dec(e.p);
      if (!username || !password || username === current.username) continue;
      tried++;
      const cand = { server: e.s, username, password };
      if (await playable(build(cand))) return cand;
    }
  }
  return null;
}

export async function resolve(ref) {
  const m = /^live:(?:([0-9a-z]{2}):)?(\d+)$/.exec(String(ref));
  if (!m) throw kino.error("not_found", "ref", { userMessage: t("unknownRef") });
  const c = m[1] ? await useServer(m[1]) : await ensureCred();
  const ext = liveExt();
  const build = (a) => `${a.server}/live/${urlEnc(a.username)}/${urlEnc(a.password)}/${m[2]}.${ext}`;
  let pick = c;
  if (isAuto() && !(await playable(build(c)))) {
    const alt = await alternate(tagOf(c.server), build, c);
    if (alt) { pick = alt; saveCred(alt.server, alt.username, alt.password); }
  }
  return { url: build(pick), mime: ext === "ts" ? "video/mp2t" : "application/x-mpegURL" };
}

function liveItem(c) {
  return { id: c.id, ref: c.ref, title: c.title, kind: "live", poster: c.logo, ...(c.adult ? { adult: true } : {}) };
}

export async function search(query) {
  if (!configured() && !isAuto()) return [];
  const q = String(query.q || "").toLowerCase().trim();
  if (q.length < 2) return [];
  return (await findChannels(q, 40)).map(liveItem);
}

export async function home() {
  if (!configured() && !isAuto()) return [];
  const { server } = await ensureCred();
  const tg = tagOf(server);
  const [cats, adult] = await Promise.all([catsRaw(), adultIds()]);
  const plain = cats.filter((c) => !adult.has(String(c.category_id)) && ID.test(String(c.category_id))).slice(0, 4);
  const rows = await Promise.all(plain.map(async (c) => {
    try {
      const all = await memCache("live:" + tg + ":" + c.category_id, TTL_CH, () => lst("get_live_streams", { category_id: c.category_id }));
      const items = all.slice(0, 20).map((ch) => liveItem(buildChannel(ch, adult, tg)));
      if (!items.length) return null;
      return { id: "lc" + safeId(c.category_id), title: clean(c.category_name, c.category_id, 100), items, genre: genreOf(c.category_name) };
    } catch (e) { kino.log("home: " + (e && e.code)); return null; }
  }));
  return rows.filter(Boolean);
}

// ---- 10. settings ------------------------------------------------------------------------------------------------

function pad(n) { return n < 10 ? "0" + n : String(n); }

function dateText(s) {
  const n = parseInt(s, 10);
  if (!(n > 0)) return t("noLimit");
  const d = new Date(n * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function accountLine(info, key) {
  const u = (info && info.user_info) || {};
  return t(key, { exp: dateText(u.exp_date), used: u.active_cons ?? "?", max: u.max_connections ?? "?" });
}

export async function settingsStatus() {
  if (isAuto()) {
    const c = creds();
    if (!c.server) return { accountStatus: t("autoSearching") };
    try { return { accountStatus: accountLine(await callApi(c.server, c.username, c.password, "", {}, 10000), "autoOk") }; }
    catch { clearCred(); return { accountStatus: t("autoRetry") }; }
  }
  if (!configured()) return { accountStatus: t("unconfigured") };
  try { return { accountStatus: accountLine(await api("", {}, 10000), "active") }; }
  catch (e) { return { accountStatus: t("offline", { detail: (e && e.userMessage) || (e && e.code) || "error" }) }; }
}

export async function action(key) {
  if (key === "checkConn") {
    if (isAuto()) {
      clearCred(); flushCache();
      const found = await findAccount();
      return { message: accountLine(await callApi(found.server, found.username, found.password, "", {}, 12000), "ok") };
    }
    return { message: accountLine(await api("", {}, 12000), "ok") };
  }
  return null;
}

export async function validateSettings(values) {
  if ((values.mode || "auto") !== "custom") return null;
  const server = String(values.server || "").trim().replace(/\/+$/, "");
  const username = String(values.username || "").trim();
  const password = String(values.password || "").trim();
  if (!server) return { server: t("askServer") };
  if (!username) return { username: t("askUser") };
  if (!password) return { password: t("askPass") };
  try {
    const r = await kino.fetch(`${server}/player_api.php?username=${urlEnc(username)}&password=${urlEnc(password)}`, { timeoutMs: 12000 });
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
