const $ = (s) => document.querySelector(s);
const app = $("#app");
let ME = null;
const API_BASE = window.API_BASE || "";
const media = (u) => API_BASE && typeof u === "string" && u.startsWith("/") ? API_BASE + u : u;
const withQuery = (url, params) => {
  const qs = Object.entries(params).filter(([, v]) => v !== null && v !== void 0 && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return qs ? url + (url.includes("?") ? "&" : "?") + qs : url;
};
if (API_BASE) {
  const _fetch = window.fetch.bind(window);
  window.fetch = (input, init) => _fetch(
    typeof input === "string" && input.startsWith("/") ? API_BASE + input : input,
    init && init.credentials ? init : { ...init, credentials: "include" }
  );
}
const svg = (d, s = 22) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="currentColor">${d}</svg>`;
const ICON_HEART = svg('<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>', 16);
const ICON_HEART_O = svg('<path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/>', 16);
const ICON_PLUS = svg('<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>', 16);
const ICON_CHECK = svg('<path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>', 16);
const ICON_COLLECTION = svg('<path d="M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z"/>', 15);
const ICON_CHEV_L = svg('<path d="M15.41 16.59 10.83 12l4.58-4.59L14 6l-6 6 6 6z"/>', 24);
const ICON_CHEV_R = svg('<path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/>', 24);
const ICON_PLAY = svg('<path d="M8 5v14l11-7z"/>');
const ICON_PAUSE = svg('<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>');
const ICON_PREV = svg('<path d="M18 6l-8.5 6 8.5 6V6zM7 6h2v12H7z"/>');
const ICON_NEXT = svg('<path d="M6 6l8.5 6L6 18V6zM15 6h2v12h-2z"/>');
const ICON_BACK10 = svg('<path d="M12.5 8V5l-4 4 4 4V10c2.76 0 5 2.24 5 5s-2.24 5-5 5-5-2.24-5-5h-2c0 3.87 3.13 7 7 7s7-3.13 7-7-3.13-7-7-7z"/><text x="12.5" y="18" font-size="7" font-weight="700" text-anchor="middle" fill="currentColor">10</text>');
const ICON_FWD10 = svg('<path d="M11.5 8V5l4 4-4 4V10c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5h2c0 3.87-3.13 7-7 7s-7-3.13-7-7 3.13-7 7-7z"/><text x="11.5" y="18" font-size="7" font-weight="700" text-anchor="middle" fill="currentColor">10</text>');
const ICON_VOL_HIGH = svg('<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 21 12 9 9 0 0 0 14 3.23z"/>');
const ICON_VOL_LOW = svg('<path d="M7 9v6h4l5 5V4l-5 5H7zm9.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12z"/>');
const ICON_VOL_MUTE = svg('<path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.9 8.9 0 0 0 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4l-2.09 2.09L12 8.18V4z"/>');
const ICON_CC = svg('<path d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1z"/>');
const ICON_AUDIO = svg('<path d="M12 1a9 9 0 0 0-9 9v7a3 3 0 0 0 3 3h3v-8H5v-2a7 7 0 0 1 14 0v2h-4v8h3a3 3 0 0 0 3-3v-7a9 9 0 0 0-9-9z"/>');
const ICON_GEAR = svg('<path d="M19.14 12.94a7.5 7.5 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.59-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7 7 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.59.22L2.74 8.87a.5.5 0 0 0 .12.61l2.03 1.58a7.5 7.5 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.61l1.92 3.32a.5.5 0 0 0 .59.22l2.39-.96a7 7 0 0 0 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54a7 7 0 0 0 1.62-.94l2.39.96a.5.5 0 0 0 .59-.22l1.92-3.32a.5.5 0 0 0-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/>');
const ICON_LIST = svg('<path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4z"/>');
const ICON_PIP = svg('<path d="M19 11h-6v5h6v-5zm2-8H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H3V5h18v14z"/>');
const ICON_FS = svg('<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>');
const ICON_FS_EXIT = svg('<path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>');
const ICON_BACK = svg('<path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z"/>', 24);
const ICON_CAST = svg('<path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z"/>');
const ICON_CAST_ON = svg('<path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm18-7H5v1.63c3.96 1.28 7.09 4.41 8.37 8.37H19V7zM1 10v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>');
let SRV_FAVS = /* @__PURE__ */ new Set();
const srvIsFav = (k) => !!k && SRV_FAVS.has(k);
const srvPreferParam = () => [...SRV_FAVS].filter((k) => k.startsWith("q")).join(",");
function srvToggleFav(key) {
  if (!key) return false;
  const on = !SRV_FAVS.has(key);
  if (on) SRV_FAVS.add(key);
  else SRV_FAVS.delete(key);
  fetch("/api/server-favorite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key })
  }).catch(() => {
  });
  return on;
}
const srvAnimeKey = (s) => String((s == null ? void 0 : s.source) || "").split("\xB7")[0].trim() || "Source";
const srcName = (s) => String((s == null ? void 0 : s.source) || "").split("\xB7")[0].trim() || "Source";
function srcBadge(s) {
  if (!s) return "";
  const floor = s.tier === "floor";
  const name = floor ? "Instant" : srcName(s);
  const title = floor ? `${srcName(s)} \u2014 plays immediately, re-encoded. Not the best available picture.` : `${srcName(s)} \u2014 original release file`;
  return `<span class="p-src ${floor ? "floor" : "quality"}" title="${esc(title)}">${esc(name)}</span>`;
}
const LANG_NAMES = {
  eng: "English",
  jpn: "Japanese",
  fre: "French",
  fra: "French",
  ger: "German",
  deu: "German",
  spa: "Spanish",
  ita: "Italian",
  por: "Portuguese",
  rus: "Russian",
  ara: "Arabic",
  kor: "Korean",
  chi: "Chinese",
  zho: "Chinese",
  hin: "Hindi",
  dut: "Dutch",
  nld: "Dutch",
  pol: "Polish",
  tur: "Turkish",
  swe: "Swedish",
  nor: "Norwegian",
  dan: "Danish",
  fin: "Finnish",
  heb: "Hebrew",
  tha: "Thai",
  vie: "Vietnamese",
  ind: "Indonesian",
  cze: "Czech",
  ces: "Czech",
  hun: "Hungarian",
  gre: "Greek",
  ell: "Greek",
  ukr: "Ukrainian",
  ron: "Romanian",
  rum: "Romanian",
  und: "Undetermined"
};
function langName(code) {
  const c = String(code || "").toLowerCase();
  if (!c) return "";
  if (LANG_NAMES[c]) return LANG_NAMES[c];
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(c) || c;
  } catch {
    return c;
  }
}
function probedLangLabel(stream) {
  const tracks = (stream == null ? void 0 : stream.audioTracks) || [];
  if (!tracks.length) return null;
  const named = [...new Set(tracks.map((t) => langName(t.language)).filter(Boolean))].filter((n) => n !== "Undetermined");
  if (!named.length) return tracks.length > 1 ? `${tracks.length} audio tracks` : null;
  const shown = named.slice(0, 3).join(" \xB7 ");
  return named.length > 3 ? `${shown} +${named.length - 3}` : shown;
}
const CHANNEL_NAMES = { 1: "Mono", 2: "Stereo", 6: "5.1", 8: "7.1" };
function audTrackLabel(t, i) {
  const name = langName(t.language) || `Track ${i + 1}`;
  const bits = [
    CHANNEL_NAMES[t.channels] || (t.channels ? `${t.channels}ch` : null),
    (t.codec || "").toUpperCase() || null
  ].filter(Boolean);
  const title = t.title && !new RegExp(`^${name}$`, "i").test(t.title) ? ` (${t.title})` : "";
  return `${name}${bits.length ? ` \xB7 ${bits.join(" \xB7 ")}` : ""}${title}`;
}
function srvFavLabel(key) {
  const m = /^q(\d+)\|(.*)$/.exec(key || "");
  if (!m) return key || "this source";
  const parts = [m[1] === "0" ? "" : `${m[1]}p`, m[2] === "-" ? "" : m[2]].filter(Boolean);
  return parts.join(" ") || "untagged releases";
}
async function boot() {
  let meRes = null;
  for (let i = 0; i < 3; i++) {
    try {
      meRes = await fetch("/api/me", { cache: "no-store" });
    } catch {
      meRes = null;
    }
    if (meRes && (meRes.ok || meRes.status === 401)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!meRes || !meRes.ok) {
    location.replace("/login.html?next=" + encodeURIComponent(location.pathname + location.search));
    return;
  }
  ME = await meRes.json();
  SRV_FAVS = new Set(ME.serverFavs || []);
  $("#who").textContent = ME.name;
  $("#drawerWho").textContent = ME.name;
  if (ME.role === "admin") {
    $("#adminLink").style.display = "";
    $("#drawerAdmin").style.display = "";
  }
  initRouter();
}
const TITLE_CACHE = /* @__PURE__ */ new Map();
let BROWSE = { txt: null, data: null, at: 0 };
let APP_VIEW = null;
function initRouter() {
  history.replaceState({ d: 0 }, "", location.href);
  window.addEventListener("popstate", () => route());
  document.querySelector(".brand").addEventListener("click", (e) => {
    e.preventDefault();
    nav("/");
  });
  route();
  if (/^\/(title|watch)\//.test(location.pathname)) renderHome();
}
function nav(path, replace = false) {
  var _a, _b;
  if (!replace && location.pathname + location.search === path) return;
  const d = replace ? ((_a = history.state) == null ? void 0 : _a.d) || 0 : (((_b = history.state) == null ? void 0 : _b.d) || 0) + 1;
  history[replace ? "replaceState" : "pushState"]({ d }, "", path);
  route();
}
function goBack(fallback) {
  var _a;
  if ((((_a = history.state) == null ? void 0 : _a.d) || 0) > 0) history.back();
  else nav(fallback, true);
}
function activeTabFor(path) {
  if (path === "/browse" || path === "/movies" || path === "/tv") return "browse";
  if (path.startsWith("/movie/") || path.startsWith("/moviewatch/")) return "browse";
  if (path.startsWith("/tv/") || path.startsWith("/tvwatch/")) return "browse";
  return "home";
}
const APP_NAME = "Mediawan";
const appName = () => APP_NAME;
function setActiveTab(tab) {
  document.body.dataset.tab = tab;
  if (tab !== "browse") delete document.body.dataset.lib;
  document.querySelectorAll(".drawer-link[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
}
async function route() {
  const qs = new URLSearchParams(location.search);
  setActiveTab(activeTabFor(location.pathname));
  if (document.activeElement !== $("#search")) document.body.classList.remove("search-open");
  let m;
  if (m = location.pathname.match(/^\/title\/(\d+)/)) {
    Player.hide();
    hideMDetail();
    return showDetail(+m[1]);
  }
  if (m = location.pathname.match(/^\/watch\/(\d+)\/([^/?]+)/))
    return showPlayer(+m[1], decodeURIComponent(m[2]), qs.get("mode"));
  if (m = location.pathname.match(/^\/moviewatch\/([^/?]+)/)) {
    hideDetail();
    return showMoviePlayer(decodeURIComponent(m[1]));
  }
  if (m = location.pathname.match(/^\/tvwatch\/([^/]+)\/([^/]+)\/([^/?]+)/)) {
    hideDetail();
    return showTvPlayer(m[1], m[2], decodeURIComponent(m[3]));
  }
  if (m = location.pathname.match(/^\/movie\/([^/?]+)/)) {
    Player.hide();
    hideDetail();
    return showMediaDetail("movie", decodeURIComponent(m[1]));
  }
  if (m = location.pathname.match(/^\/tv\/([^/?]+)/)) {
    Player.hide();
    hideDetail();
    return showMediaDetail("tv", decodeURIComponent(m[1]));
  }
  Player.hide();
  hideDetail();
  hideMDetail();
  if (location.pathname === "/browse") return renderBrowse(browseFiltersFromQs(qs));
  if (location.pathname === "/movies" || location.pathname === "/tv") {
    const f = browseFiltersFromQs(qs);
    f.type = location.pathname === "/movies" ? "movies" : "tv";
    return nav(browsePath(f), true);
  }
  if (m = location.pathname.match(/^\/category\/(.+)/)) return renderCategory(decodeURIComponent(m[1]));
  if (location.pathname.startsWith("/schedule")) return renderSchedule();
  document.title = appName();
  const q = (qs.get("q") || "").trim();
  if (q.length >= 2) {
    $("#search").value = q;
    return runSearch(q);
  }
  return renderHome();
}
async function renderHome() {
  if (BROWSE.data) {
    if (APP_VIEW !== "home") paintHome(BROWSE.data);
  } else {
    APP_VIEW = "home";
    app.innerHTML = `<div class="loading">Loading your library\u2026</div>`;
  }
  if (BROWSE.data && Date.now() - BROWSE.at < 3e4) return;
  let res;
  try {
    res = await fetch("/api/browse");
  } catch {
    return;
  }
  if (!res.ok) return;
  const txt = await res.text();
  const changed = txt !== BROWSE.txt;
  BROWSE = { txt, data: JSON.parse(txt), at: Date.now() };
  if (changed && APP_VIEW === "home") paintHome(BROWSE.data);
  if (await refreshHomeRails() && APP_VIEW === "home") paintHome(BROWSE.data);
}
let RAILS = { movies: null, tv: null };
async function refreshHomeRails() {
  const grab = async (kind) => {
    const c = CATALOGS[kind];
    try {
      const d = await (await fetch(c.api)).json();
      if (d.enabled === false) return null;
      const items = (d.items || []).slice(0, 18);
      items.forEach((m) => c.cache.set(m.id, m));
      return items.length ? items : null;
    } catch {
      return null;
    }
  };
  const [movies, tv] = await Promise.all([grab("movies"), grab("tv")]);
  const changed = JSON.stringify([movies, tv]) !== JSON.stringify([RAILS.movies, RAILS.tv]);
  RAILS = { movies, tv };
  return changed;
}
function paintHome(data) {
  var _a, _b;
  APP_VIEW = "home";
  const { rows, continueWatching, favorites, watchlist, collections, recommendations, flags } = data;
  FAV = new Set((flags == null ? void 0 : flags.favorites) || []);
  LIST = new Set((flags == null ? void 0 : flags.watchlist) || []);
  const trending = ((_a = rows.trending) == null ? void 0 : _a.items) || [];
  let html = "";
  const seen = /* @__PURE__ */ new Set();
  const pool = [];
  for (const [label, items] of [["Recommended for you", (recommendations == null ? void 0 : recommendations.items) || []], ["Trending now", trending]])
    for (const m of items) if (!seen.has(m.anilistId)) {
      seen.add(m.anilistId);
      pool.push({ ...m, heroLabel: label });
    }
  const bannered = pool.filter((m) => m.banner);
  const slides = (bannered.length >= 3 ? bannered : pool).slice(0, 6);
  if (slides.length) html += heroCarouselHtml(slides);
  html += `<div class="rows">`;
  if (continueWatching == null ? void 0 : continueWatching.length) html += continueRowHtml(continueWatching);
  if (watchlist == null ? void 0 : watchlist.length) html += rowHtml("My List", watchlist, { cls: "list-row" });
  if (favorites == null ? void 0 : favorites.length) html += rowHtml("Favorites", favorites, { cls: "list-row" });
  for (const c of collections || []) {
    if (c.items.length) html += rowHtml(c.name, c.items, { collection: c.id, cls: "list-row" });
  }
  if ((_b = recommendations == null ? void 0 : recommendations.items) == null ? void 0 : _b.length) html += rowHtml(recommendations.label, recommendations.items);
  if (RAILS.movies) html += mediaRowHtml("Popular Movies", RAILS.movies, "movies");
  if (RAILS.tv) html += mediaRowHtml("Popular TV Shows", RAILS.tv, "tv");
  for (const key of ["airing", "trending", "popular", "top"]) {
    if (rows[key]) html += rowHtml(rows[key].label, rows[key].items);
  }
  html += `</div>`;
  app.innerHTML = html;
  startHeroCar(slides.length);
  initRowArrows();
}
const ICON_CLOCK = svg('<path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm.5-13H11v6l5 3 .75-1.23-4.25-2.52z"/>', 14);
const ICON_INFO = svg('<path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/>', 15);
const ICON_PLAY_SM = svg('<path d="M8 5v14l11-7z"/>', 15);
function heroCarouselHtml(slides) {
  return `<div class="hero-car" id="heroCar">
    ${slides.map((m, i) => {
    const badge = m.airing ? `${ICON_CLOCK} EP ${m.airing.episode} \xB7 Airing Now` : esc(m.heroLabel || "");
    const meta = [m.format || "TV", m.year, m.episodes ? `${m.episodes} eps` : null, m.score ? `\u2605 ${m.score}` : null].filter(Boolean);
    return `
      <div class="hero ${i === 0 ? "active" : ""} ${m.banner ? "" : "no-banner"}" style="--hero-img:url('${m.banner || m.cover}')">
        <div class="hero-bg"></div>
        <div class="hero-scrim"></div>
        <div class="hero-badge">${badge}</div>
        <div class="hero-content">
          <div class="hero-chips">${meta.map((c) => `<span class="hero-chip">${c}</span>`).join("")}</div>
          <div class="hero-title">${esc(m.title)}</div>
          <div class="hero-chips hero-genres">${(m.genres || []).slice(0, 3).map((g) => `<button class="hero-chip" onclick="openCategory('${esc(g)}')">${esc(g)}</button>`).join("")}</div>
          <div class="hero-actions">
            <button class="hero-btn" onclick="openTitle(${m.anilistId})">${ICON_INFO} Details</button>
            <button class="hero-btn primary" onclick="playTitle(${m.anilistId})">${ICON_PLAY_SM} Watch Now</button>
          </div>
        </div>
      </div>`;
  }).join("")}
    ${slides.length > 1 ? `
    <div class="hero-pager">
      <button class="hero-pg-btn" onclick="heroNav(-1)" title="Previous">${ICON_CHEV_L}</button>
      <div class="hero-count"><b id="heroCurrent">1</b> / ${slides.length}</div>
      <button class="hero-pg-btn" onclick="heroNav(1)" title="Next">${ICON_CHEV_R}</button>
    </div>` : ""}
  </div>`;
}
let heroTimer = null, heroIdx = 0, heroCount = 0;
const HERO_INTERVAL = 7e3;
function startHeroCar(count) {
  clearInterval(heroTimer);
  heroTimer = null;
  heroIdx = 0;
  heroCount = count;
  if (count < 2) return;
  heroTimer = setInterval(() => heroGo(heroIdx + 1), HERO_INTERVAL);
  const car = $("#heroCar");
  car.addEventListener("mouseenter", () => clearInterval(heroTimer));
  car.addEventListener("mouseleave", () => {
    clearInterval(heroTimer);
    heroTimer = setInterval(() => heroGo(heroIdx + 1), HERO_INTERVAL);
  });
}
function heroGo(i, user) {
  const car = $("#heroCar");
  if (!car || !heroCount) return;
  heroIdx = (i % heroCount + heroCount) % heroCount;
  car.querySelectorAll(".hero").forEach((el, j) => el.classList.toggle("active", j === heroIdx));
  const cur = $("#heroCurrent");
  if (cur) cur.textContent = heroIdx + 1;
  if (user) {
    clearInterval(heroTimer);
    heroTimer = setInterval(() => heroGo(heroIdx + 1), HERO_INTERVAL);
  }
}
function heroNav(d) {
  heroGo(heroIdx + d, true);
}
function rowHtml(label, items, opts = {}) {
  const del = opts.collection ? `<button class="row-del" title="Delete collection" onclick="deleteCollection(${opts.collection}, event)">\u2715</button>` : "";
  return `<div class="row ${opts.cls || ""}"><h2>${esc(label)}${del}</h2>
    ${scrollerHtml("cards", items.map(cardHtml).join(""))}</div>`;
}
function continueBadge(p) {
  var _a;
  if (p.kind === "movie") return null;
  if (p.kind === "tv") return `S${(_a = p.season) != null ? _a : 1} E${p.episode}`;
  return "EP " + p.episode;
}
function continueHref(p) {
  if (p.kind === "movie") return `playMovie('${esc(p.id)}')`;
  if (p.kind === "tv") return `openTvEpisode('${esc(p.id)}', ${Number(p.season) || 1}, ${Number(p.episode) || 1})`;
  return `openTitle(${p.anilistId})`;
}
function continueCardHtml(p) {
  const pct = p.duration ? Math.min(100, p.seconds / p.duration * 100) : 0;
  const left = p.duration && p.duration > p.seconds ? Math.round((p.duration - p.seconds) / 60) + "m left" : null;
  const badge = continueBadge(p);
  const art = p.cover ? `<img loading="lazy" src="${p.cover}" alt="" />` : `<div class="movie-noart"><span>${esc(p.title)}</span></div>`;
  return `<div class="card" onclick="${continueHref(p)}">
    <div class="card-art">${art}
      ${badge ? `<span class="badge">${esc(badge)}</span>` : ""}
      <div class="card-scrim">
        <div class="card-t">${esc(p.title)}</div>
        ${left ? `<div class="card-sub">${left}</div>` : ""}
      </div>
      ${pct ? `<div class="prog-track"><div class="prog" style="width:${pct}%"></div></div>` : ""}
    </div>
    <div class="cap">${esc(p.title)}</div>
  </div>`;
}
function continueRowHtml(items) {
  return `<div class="row"><h2>Continue Watching</h2>
    ${scrollerHtml("cards", items.map(continueCardHtml).join(""))}</div>`;
}
function mediaRowHtml(label, items, kind) {
  const c = CATALOGS[kind];
  return `<div class="row"><h2>${esc(label)}
      <a class="row-see" href="${c.path}" onclick="event.preventDefault(); nav('${c.path}')">See all \u203A</a></h2>
    ${scrollerHtml("cards", items.map((m) => mediaCardHtml(m, c.open(m))).join(""))}</div>`;
}
function scrollerHtml(boxClass, inner) {
  const mod = boxClass === "cards" ? " posters" : "";
  return `<div class="row-scroller${mod}">
      <button class="row-arrow left hide" onclick="scrollRow(this,-1)" title="Scroll left">${ICON_CHEV_L}</button>
      <div class="${boxClass}" onscroll="updateRowArrows(this)">${inner}</div>
      <button class="row-arrow right hide" onclick="scrollRow(this,1)" title="Scroll right">${ICON_CHEV_R}</button>
    </div>`;
}
function scrollRow(btn, dir) {
  const box = btn.parentElement.querySelector(".cards, .fr-cards");
  box.scrollBy({ left: dir * box.clientWidth * 0.85, behavior: "smooth" });
}
function updateRowArrows(box) {
  const scroller = box.parentElement;
  const left = scroller.querySelector(".row-arrow.left");
  const right = scroller.querySelector(".row-arrow.right");
  const max = box.scrollWidth - box.clientWidth;
  left.classList.toggle("hide", box.scrollLeft <= 4);
  right.classList.toggle("hide", box.scrollLeft >= max - 4 || max <= 0);
}
function initRowArrows(root = document) {
  root.querySelectorAll(".row-scroller .cards, .row-scroller .fr-cards").forEach(updateRowArrows);
}
function airingBadge(a) {
  if (!a) return null;
  const s = a.inSeconds;
  const t = s <= 0 ? "now" : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return `EP ${a.episode} \xB7 ${t}`;
}
function cardHtml(m) {
  const id = m.anilistId;
  const fav = FAV.has(id), inList = LIST.has(id);
  const airing = m.badge ? null : airingBadge(m.airing);
  const badge = m.badge || airing;
  const sub = [m.year, m.episodes ? m.episodes + " eps" : null, m.score ? m.score + "%" : null].filter(Boolean).join(" \xB7 ");
  return `<div class="card" onclick="openTitle(${id})">
    <div class="card-art">
      <img loading="lazy" src="${m.cover}" alt="" />
      ${badge ? `<span class="badge${airing ? " airing" : ""}">${badge}</span>` : ""}
      <div class="card-scrim">
        <div class="card-t">${esc(m.title)}</div>
        ${sub ? `<div class="card-sub">${sub}</div>` : ""}
      </div>
      ${m.progress ? `<div class="prog-track"><div class="prog" style="width:${m.progress}%"></div></div>` : ""}
      <div class="card-actions">
        <button class="card-act ${fav ? "on" : ""}" title="Favorite" onclick="toggleFav(${id}, this, event)">${ICON_HEART}</button>
        <button class="card-act ${inList ? "on" : ""}" title="My List" onclick="toggleList(${id}, this, event)">${inList ? ICON_CHECK : ICON_PLUS}</button>
      </div>
    </div>
    <div class="cap">${esc(m.title)}</div>
  </div>`;
}
let FAV = /* @__PURE__ */ new Set(), LIST = /* @__PURE__ */ new Set();
async function toggleFav(id, btn, e) {
  e == null ? void 0 : e.stopPropagation();
  const r = await (await fetch("/api/favorite/" + id, { method: "POST" })).json();
  btn.classList.toggle("on", r.favorite);
  r.favorite ? FAV.add(id) : FAV.delete(id);
  BROWSE.at = 0;
}
async function toggleList(id, btn, e) {
  e == null ? void 0 : e.stopPropagation();
  const r = await (await fetch("/api/watchlist/" + id, { method: "POST" })).json();
  btn.classList.toggle("on", r.inList);
  btn.innerHTML = r.inList ? ICON_CHECK : ICON_PLUS;
  r.inList ? LIST.add(id) : LIST.delete(id);
  BROWSE.at = 0;
}
async function deleteCollection(id, e) {
  e == null ? void 0 : e.stopPropagation();
  if (!confirm("Delete this collection? (Titles stay in your library.)")) return;
  await fetch("/api/collections/" + id, { method: "DELETE" });
  BROWSE.at = 0;
  renderHome();
}
let detail = null;
let detailMode = "sub";
let DETAIL_ID = null;
function openTitle(anilistId) {
  nav("/title/" + anilistId);
}
function playTitle(anilistId) {
  nav(`/watch/${anilistId}/first?mode=sub`);
}
async function showDetail(anilistId) {
  const isNew = DETAIL_ID !== anilistId;
  DETAIL_ID = anilistId;
  $("#detail").classList.add("show");
  document.body.style.overflow = "hidden";
  if (isNew) {
    $("#detail").scrollTop = 0;
    const sheet = document.querySelector("#detail .sheet");
    if (sheet) sheet.scrollTop = 0;
  }
  const cached = TITLE_CACHE.get(anilistId);
  if (cached) {
    if (isNew || detail !== cached) {
      detail = cached;
      detailMode = "sub";
      paintDetail();
    } else renderDetailEps();
  } else if (isNew) {
    detail = null;
    $("#d-title").textContent = "";
    $("#d-meta").textContent = "";
    $("#d-genres").innerHTML = "";
    $("#d-desc").textContent = "";
    $("#detailActions").innerHTML = "";
    $("#d-modePills").innerHTML = "";
    $("#d-franchise").hidden = true;
    $("#d-season").hidden = true;
    $("#detailHeroBg").style.backgroundImage = "";
    $("#detailHeroArt").style.backgroundImage = "";
    $("#d-eps").innerHTML = `<div style="color:var(--muted)">Loading episodes\u2026</div>`;
    $("#d-note").textContent = "";
  }
  if (!cached || Date.now() - cached._at > 6e4) {
    const res = await fetch("/api/title/" + anilistId).catch(() => null);
    if (!res || !res.ok) {
      if (!cached && DETAIL_ID === anilistId) $("#d-eps").innerHTML = "Couldn't load this title.";
      return;
    }
    const fresh = await res.json();
    fresh._at = Date.now();
    fresh.epMeta = (cached == null ? void 0 : cached.epMeta) || null;
    const sig = (t) => JSON.stringify([t.episodes, t.dubEpisodes, t.progress, t.favorite, t.inList, t.collections]);
    const changed = !cached || sig(fresh) !== sig(cached);
    TITLE_CACHE.set(anilistId, fresh);
    if (DETAIL_ID === anilistId) {
      detail = fresh;
      if (!cached) detailMode = "sub";
      if (changed) paintDetail();
    }
  }
  if (DETAIL_ID === anilistId && detail && !detail.epMeta) loadEpisodeMeta(anilistId);
}
function paintDetail() {
  var _a;
  const m = detail.meta;
  document.title = m.title + " \xB7 " + appName();
  $("#detailHero").classList.toggle("no-banner", !m.banner);
  $("#detailHeroBg").style.backgroundImage = `url('${m.banner || m.cover}')`;
  $("#detailHeroArt").style.backgroundImage = m.banner ? "" : `url('${m.cover}')`;
  $("#d-title").textContent = m.title;
  const seasons = ((_a = detail.franchise) == null ? void 0 : _a.seasons) || [];
  const si = seasons.findIndex((s) => s.anilistId === m.anilistId);
  const seasonPos = si >= 0 && seasons.length > 1 ? `Season ${si + 1} of ${seasons.length} \xB7 ` : "";
  $("#d-meta").textContent = `${seasonPos}${m.year || ""} \xB7 ${m.format || ""} \xB7 ${m.episodes || detail.episodes.length || "?"} episodes${m.score ? " \xB7 " + m.score + "%" : ""}`;
  $("#d-genres").innerHTML = (m.genres || []).map((g) => `<button onclick="openCategory('${esc(g)}')">${esc(g)}</button>`).join("");
  $("#d-desc").textContent = m.description;
  renderDetailActions();
  renderSeasonSelect();
  renderFranchise();
  renderModePills();
  renderDetailEps();
}
function epThumbFallback(img) {
  const d = img.parentElement;
  d.classList.add("ph");
  d.style.backgroundImage = `url('${detail.meta.cover}')`;
  img.remove();
}
async function loadEpisodeMeta(anilistId) {
  try {
    const { episodes } = await (await fetch("/api/episodes/" + anilistId)).json();
    if (!detail || detail.meta.anilistId !== anilistId) return;
    detail.epMeta = episodes || {};
    renderDetailEps();
  } catch {
  }
}
function renderSeasonSelect() {
  var _a;
  const sel = $("#d-season");
  const seasons = ((_a = detail.franchise) == null ? void 0 : _a.seasons) || [];
  if (seasons.length < 2) {
    sel.hidden = true;
    sel.innerHTML = "";
    return;
  }
  const cur = detail.meta.anilistId;
  sel.innerHTML = seasons.map(
    (s, i) => `<option value="${s.anilistId}" ${s.anilistId === cur ? "selected" : ""}>Season ${i + 1} \xB7 ${esc(s.title)}${s.year ? ` (${s.year})` : ""}</option>`
  ).join("");
  sel.hidden = false;
  sel.onchange = () => {
    const id = Number(sel.value);
    if (id !== detail.meta.anilistId) openTitle(id);
  };
}
function renderFranchise() {
  const f = detail.franchise;
  const box = $("#d-franchise");
  box.innerHTML = "";
  box.hidden = true;
  if (!f) return;
  const cur = detail.meta.anilistId;
  const groups = [
    ["Movies", f.movies],
    ["Specials & OVAs", f.specials],
    ["Related", f.related]
  ];
  let html = "";
  for (const [label, items] of groups) {
    if (!(items == null ? void 0 : items.length)) continue;
    html += `<div class="fr-group"><div class="fr-label">${label}</div>` + scrollerHtml("fr-cards", items.map((it) => frCardHtml(it, cur, null)).join("")) + `</div>`;
  }
  if (!html) return;
  box.innerHTML = `<div class="fr-head">More from this series</div>` + html;
  box.hidden = false;
  initRowArrows(box);
}
function frCardHtml(m, cur, num) {
  const active = m.anilistId === cur;
  return `<div class="fr-card ${active ? "active" : ""}" ${active ? "" : `onclick="openTitle(${m.anilistId})"`}>
    <img loading="lazy" src="${m.cover}" alt="" />
    <div class="fr-info">
      <div class="fr-num">${num ? `Season ${num}` : esc(m.format || "")}</div>
      <div class="fr-title" title="${esc(m.title)}">${esc(m.title)}</div>
      <div class="fr-sub">${m.year || ""}${m.episodes ? ` \xB7 ${m.episodes} eps` : ""}${active ? " \xB7 Viewing" : ""}</div>
    </div>
  </div>`;
}
function renderDetailActions() {
  const id = detail.meta.anilistId;
  $("#detailActions").innerHTML = `
    <button class="act-btn icon-btn ${detail.favorite ? "on" : ""}" id="actFav">${ICON_HEART}<span>${detail.favorite ? "Favorited" : "Favorite"}</span></button>
    <button class="act-btn icon-btn ${detail.inList ? "on" : ""}" id="actList">${detail.inList ? ICON_CHECK : ICON_PLUS}<span>${detail.inList ? "In My List" : "My List"}</span></button>
    <div class="act-col-wrap">
      <button class="act-btn icon-btn" id="actCol">${ICON_COLLECTION}<span>Collections \u25BE</span></button>
      <div class="col-menu" id="colMenu" hidden></div>
    </div>`;
  $("#actFav").onclick = async () => {
    const r = await (await fetch("/api/favorite/" + id, { method: "POST" })).json();
    detail.favorite = r.favorite;
    renderDetailActions();
  };
  $("#actList").onclick = async () => {
    const r = await (await fetch("/api/watchlist/" + id, { method: "POST" })).json();
    detail.inList = r.inList;
    renderDetailActions();
  };
  $("#actCol").onclick = (e) => {
    e.stopPropagation();
    const menu = $("#colMenu");
    menu.hidden = !menu.hidden;
    if (!menu.hidden) renderColMenu(id);
  };
}
function renderColMenu(id) {
  const menu = $("#colMenu");
  const rows = detail.collections.map(
    (c) => `<label class="col-row"><input type="checkbox" data-col="${c.id}" ${c.has ? "checked" : ""}/> ${esc(c.name)}</label>`
  ).join("") || `<div class="col-empty">No collections yet</div>`;
  menu.innerHTML = rows + `
    <div class="col-new">
      <input id="colNewName" placeholder="New collection\u2026" maxlength="60" />
      <button id="colNewBtn" class="btn mini">Create</button>
    </div>`;
  menu.querySelectorAll('input[type="checkbox"]').forEach((cb) => cb.onchange = async () => {
    const cid = cb.dataset.col;
    await fetch(`/api/collections/${cid}/item/${id}`, { method: cb.checked ? "POST" : "DELETE" });
    const c = detail.collections.find((x) => String(x.id) === cid);
    if (c) c.has = cb.checked;
  });
  $("#colNewBtn").onclick = async () => {
    const name = $("#colNewName").value.trim();
    if (!name) return;
    const c = await (await fetch("/api/collections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) })).json();
    await fetch(`/api/collections/${c.id}/item/${id}`, { method: "POST" });
    detail.collections.push({ id: c.id, name: c.name, has: true });
    renderColMenu(id);
  };
}
function renderModePills() {
  $("#d-modePills").innerHTML = `
    <button class="mode-pill ${detailMode === "sub" ? "active" : ""}" onclick="setDetailMode('sub')">Sub</button>
    <button class="mode-pill ${detailMode === "dub" ? "active" : ""}" onclick="setDetailMode('dub')" ${detail.hasDub ? "" : 'disabled title="No dub available"'}>Dub</button>`;
}
function setDetailMode(mode) {
  if (mode === "dub" && !detail.hasDub) return;
  detailMode = mode;
  renderModePills();
  renderDetailEps();
}
function renderDetailEps() {
  const eps = detailMode === "dub" ? detail.dubEpisodes : detail.episodes;
  if (!detail.playable || !eps.length) {
    $("#d-eps").innerHTML = `<div style="color:var(--muted)">No ${detailMode} source matched for this title.</div>`;
    return;
  }
  const p = detail.progress;
  const em = detail.epMeta || {};
  $("#d-eps").innerHTML = eps.map((ep) => {
    const pct = p && p.episode === String(ep) && p.duration ? Math.min(100, p.seconds / p.duration * 100) : 0;
    const meta = em[String(ep)] || {};
    const thumb = meta.thumbnail ? `<div class="ep-row-thumb"><img loading="lazy" src="${meta.thumbnail}" alt="" onerror="epThumbFallback(this)"><span class="ep-row-badge">${ep}</span></div>` : `<div class="ep-row-thumb ph" style="background-image:url('${detail.meta.cover}')"><span class="ep-row-badge">${ep}</span></div>`;
    const title = meta.title ? `Ep ${ep} \xB7 ${esc(meta.title)}` : `Episode ${ep}`;
    return `<div class="ep-row" onclick="launchPlayer('${ep}')">
      ${thumb}
      <div class="ep-row-body">
        <div class="ep-row-t">${title}</div>
        ${meta.airDate ? `<div class="ep-row-date">${fmtDate(meta.airDate)}</div>` : ""}
        ${pct ? `<div class="ep-row-prog"><div style="width:${pct}%"></div></div>` : ""}
      </div>
      <div class="ep-row-play">\u25B6</div>
    </div>`;
  }).join("");
  $("#d-eps").scrollTop = 0;
  $("#d-note").textContent = "\u201CSub\u201D plays Japanese audio \u2014 the release\u2019s English subtitles switch on automatically when available (more under the CC menu). \u201CDub\u201D plays English audio.";
}
function closeDetail() {
  goBack("/");
}
function hideDetail() {
  DETAIL_ID = null;
  $("#detail").classList.remove("show");
  if (!$("#player").classList.contains("show")) document.body.style.overflow = "";
}
$("#detailClose").addEventListener("click", closeDetail);
$("#detail").addEventListener("click", (e) => {
  if (e.target.id === "detail") closeDetail();
});
document.addEventListener("click", (e) => {
  const menu = $("#colMenu");
  if (menu && !menu.hidden && !e.target.closest(".act-col-wrap")) menu.hidden = true;
});
document.addEventListener("keydown", (e) => {
  var _a;
  if (e.key !== "Escape") return;
  if (!$("#detail").classList.contains("show") || $("#player").classList.contains("show")) return;
  if (["INPUT", "TEXTAREA", "SELECT"].includes((_a = document.activeElement) == null ? void 0 : _a.tagName)) return;
  const colMenu = $("#colMenu");
  if (colMenu && !colMenu.hidden) {
    colMenu.hidden = true;
    return;
  }
  closeDetail();
});
$("#detailPlay").addEventListener("click", () => {
  const eps = detailMode === "dub" ? detail.dubEpisodes : detail.episodes;
  const resume = detail.progress && eps.includes(detail.progress.episode) ? detail.progress.episode : eps[0];
  if (resume) launchPlayer(resume);
});
const Player = {
  el: $("#player"),
  video: $("#video"),
  hls: null,
  meta: null,
  playable: null,
  episodes: [],
  mode: "sub",
  ep: null,
  streams: [],
  quality: null,
  hideTimer: null,
  progressTimer: null,
  upNextTimer: null,
  resumeAt: 0,
  // Virtual timeline over a live transcode session. The media element's clock
  // starts at zero wherever the session started (tShift = the session's start
  // offset in the real runtime) and its duration only covers what has been
  // transcoded so far — fullDur carries the true runtime from ffprobe so the
  // scrubber shows the whole film, not the encoder's progress bar.
  tShift: 0,
  fullDur: null,
  async launch(ep) {
    this.meta = detail.meta;
    this.playable = detail.playable;
    this.mode = detailMode;
    this._serversUrl = null;
    this._streamBase = null;
    this.episodes = detailMode === "dub" ? detail.dubEpisodes : detail.episodes;
    this.el.classList.add("show");
    document.body.style.overflow = "hidden";
    $("#pTitleMain").textContent = this.meta.title;
    this.bindOnce();
    await this.play(ep, this._resumeFor(ep));
  },
  _resumeFor(ep) {
    const p = detail.progress;
    return p && p.episode === String(ep) && p.seconds > 5 ? p.seconds : 0;
  },
  // ---- movie mode (Real-Debrid vertical) ----
  // Movies reuse the whole player (scrubber, quality, speed, fullscreen, cast,
  // subtitles) but have no episodes/seasons/sub-dub, so we hide that chrome and
  // skip the episode-specific data paths (guarded by this.movieMode elsewhere).
  // #pAud stays: films and shows have audio LANGUAGES too (a dual-audio
  // release, an original-language track beside a dub), and the delivered
  // stream now reports its real tracks. It used to be hidden here because the
  // menu only knew how to express anime's sub/dub, so the tracks a film
  // actually shipped were unreachable. buildAudMenu handles both shapes; the
  // button hides itself when a file turns out to have one track.
  _toggleMovieChrome(isMovie) {
    for (const sel of ["#pPrev", "#pNext", "#pEps"]) {
      const el = $(sel);
      if (el) el.style.display = isMovie ? "none" : "";
    }
    $("#pAud").style.display = isMovie ? "none" : "";
    if (isMovie) $("#pSkip").hidden = true;
  },
  // Generic Real-Debrid stream player, shared by Movies and TV. `endpoint` is a
  // /api/…/stream URL, `subsUrl` its sibling subtitle listing (optional),
  // `back` is where the ‹ button returns to.
  // `track` identifies WHAT is playing for watch-progress purposes:
  //   { kind: "movie"|"tv", id, season?, episode?, cover? }
  // Without it the player has no way to name a film in the progress table —
  // `meta.anilistId` is null in this mode, which is why films used to record
  // nothing at all and never appeared in Continue Watching.
  async launchStream({ endpoint, subsUrl, altsUrl, serversUrl, title, sub, back, track = null }) {
    this.movieMode = true;
    this._track = track;
    this._streamBase = endpoint;
    this._streamEndpoint = withQuery(endpoint, { prefer: srvPreferParam() });
    this._subsUrl = subsUrl || null;
    this._altsUrl = altsUrl || null;
    this._serversUrl = serversUrl || null;
    this._streamNav = null;
    this._audioIndex = null;
    this._backPath = back || "/";
    this._streamSub = sub || "via Real-Debrid";
    this.meta = { anilistId: null, title: title || "Video" };
    this.episodes = [];
    this.mode = "movie";
    this.quality = null;
    this.el.classList.add("show");
    document.body.style.overflow = "hidden";
    $("#pTitleMain").textContent = this.meta.title;
    this.bindOnce();
    this._toggleMovieChrome(true);
    await this.playStream({ seek: await this._trackResume(), resume: true });
  },
  // The saved position for whatever this player is about to open, or 0.
  //
  // Asked of the server rather than passed in, because the click that starts
  // playback may know nothing: a Continue Watching card, a pasted /moviewatch
  // link and a ⏭ into the next episode all arrive with just an id. Guarded so a
  // failure (offline, logged out) simply starts from the beginning.
  //
  // The stored row is per TITLE for a film and per SHOW for a series, so a
  // series only resumes when the saved episode is the one being opened —
  // otherwise picking S1E1 after watching S3E7 would jump 40 minutes in.
  async _trackResume() {
    const t = this._track;
    if (!(t == null ? void 0 : t.kind) || !t.id) return 0;
    let p = null;
    try {
      p = await (await fetch(`/api/progress/${t.kind}/${encodeURIComponent(t.id)}`)).json();
    } catch {
      return 0;
    }
    if (!p || !(p.seconds > 5)) return 0;
    if (t.kind === "tv" && (String(p.episode) !== String(t.episode) || Number(p.season) !== Number(t.season))) return 0;
    if (p.duration && p.seconds / p.duration >= 0.95) return 0;
    return p.seconds;
  },
  // `seek` resumes at a timestamp (an audio-track switch mid-film), and the
  // request carries it so the transcode session STARTS there rather than
  // encoding from zero toward it.
  // `resume` marks a FRESH launch that happens to start part-way in, as opposed
  // to the mid-film re-resolve an audio-track switch performs. The difference
  // matters for the two steps below: a re-resolve already has its subtitles
  // loaded and a visible picture behind it, so it must not flash the "finding a
  // stream" overlay or re-fetch subs — but a resume has neither yet, and
  // skipping them left Continue Watching opening onto a black screen with no
  // status and no subtitles.
  async playStream({ seek = 0, resume = false } = {}) {
    var _a;
    const fresh = !seek || resume;
    this._closing = false;
    document.title = `${this.meta.title} \xB7 ${appName()}`;
    $("#pTitleSub").textContent = this._streamSub;
    if (fresh) this.showStatus("Finding a cached stream on Real-Debrid\u2026", true);
    this.hideMenus();
    this.closeDrawer();
    this.hideUpNext();
    this.resetServers();
    if (fresh) this.loadStreamSubs();
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    let data;
    try {
      const res = await fetch(withQuery(this._streamEndpoint, {
        audio: this._audioIndex,
        seek: seek > 6 ? Math.floor(seek) : null
      }));
      if (res.status === 202) {
        const j = await res.json();
        if ((_a = j.downloading) == null ? void 0 : _a.torrentId) {
          this.watchDebridDownload(j.downloading);
          return;
        }
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        const e = new Error(j.detail || j.error || "no source");
        e.code = j.error || null;
        throw e;
      }
      data = await res.json();
    } catch (e) {
      if (e.code === "debrid-account") {
        this.showStatus(String(e.message || "The debrid account can't play anything right now."), false);
        return;
      }
      this.showStatusAction(
        `No cached release played automatically. ${String(e.message || "")}`.trim(),
        this._serversUrl ? "Choose a server" : null,
        () => this.openServers()
      );
      return;
    }
    if (data.title) {
      this.meta.title = data.title;
      $("#pTitleMain").textContent = data.title;
      document.title = `${data.title} \xB7 ${appName()}`;
    }
    this.streams = data.streams;
    this.quality = data.streams[0];
    this.loadQuality(this.quality, seek || 0, true);
    this.buildQualityMenu();
    this.buildSpeedMenu();
    this.buildServers();
    this.buildAudMenu();
    clearTimeout(this._altsTimer);
    this._altsTimer = setTimeout(() => this.loadAlts(), 6e3);
  },
  // Lazy quality alternatives (movies/TV): playback already started on the
  // default band; ask the server which OTHER bands are Real-Debrid-cached and
  // add them to the Quality menu. The endpoint doubles as the staleness guard.
  async loadAlts() {
    var _a;
    if (!this._altsUrl) return;
    const token = this._streamEndpoint;
    let alts = [];
    try {
      const q = ((_a = this.quality) == null ? void 0 : _a.quality) ? `?have=${encodeURIComponent(this.quality.quality)}` : "";
      alts = (await (await fetch(this._altsUrl + q)).json()).streams || [];
    } catch {
      return;
    }
    if (!this.movieMode || this._streamEndpoint !== token || this._closing) return;
    const known = new Set(this.streams.map((s) => s.quality));
    const fresh = alts.filter((s) => !known.has(s.quality));
    if (!fresh.length) return;
    this.streams = [...this.streams, ...fresh].sort((a, b) => (Number(b.quality) || 0) - (Number(a.quality) || 0));
    this.streamIdx = this.streams.indexOf(this.quality);
    this.buildQualityMenu();
    this.buildServers();
  },
  async play(ep, resumeAt = 0) {
    var _a;
    this._closing = false;
    this.ep = String(ep);
    this.resumeAt = resumeAt;
    if (location.pathname.startsWith("/watch/"))
      history.replaceState(history.state, "", `/watch/${this.meta.anilistId}/${encodeURIComponent(this.ep)}?mode=${this.mode}`);
    document.title = `${this.meta.title} \u2014 E${this.ep} \xB7 ${appName()}`;
    $("#pTitleSub").textContent = `Episode ${ep} \xB7 ${this.mode.toUpperCase()}`;
    this.showStatus("Resolving stream\u2026", true);
    this.hideMenus();
    this.closeDrawer();
    this.hideUpNext();
    this.resetServers();
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.loadSkipTimes(ep);
    this.loadSubs(ep);
    this.cancelUpgrade();
    let data;
    try {
      const seek = resumeAt > 6 ? `&seek=${Math.floor(resumeAt)}` : "";
      const res = await fetch(`/api/stream/${this.meta.anilistId}/${ep}?mode=${this.mode}${seek}`);
      if (res.status === 202) {
        data = await res.json();
        if ((_a = data.downloading) == null ? void 0 : _a.torrentId) {
          this.watchDebridDownload(data.downloading);
          return;
        }
        this.showStatus("Fetching the best available release\u2026", true);
        this.watchUpgrade(data.upgrade, resumeAt, { primary: true });
        return;
      }
      if (!res.ok) throw new Error((await res.json()).error || "no source");
      data = await res.json();
    } catch (e) {
      this._noSource();
      return;
    }
    this.streams = data.streams;
    if (data.mode && data.mode !== this.mode) {
      this.mode = data.mode;
      if (data.audioFallback === "dub-unavailable")
        this.flashNote("No dub for this episode yet \u2014 playing Japanese with subtitles");
    }
    this.quality = data.streams.find((s) => srvIsFav(srvAnimeKey(s))) || data.streams.find((s) => {
      var _a2;
      return s.quality === ((_a2 = this.quality) == null ? void 0 : _a2.quality);
    }) || data.streams[0];
    this.loadQuality(this.quality, resumeAt, true);
    this.buildQualityMenu();
    this.buildSpeedMenu();
    this.buildAudMenu();
    this.buildCcMenu();
    this.buildServers();
    this.renderDrawer();
    this.highlightEp();
    if (data.upgrade) this.watchUpgrade(data.upgrade, resumeAt, { primary: false });
  },
  // ---- upgrade-in-place ----
  //
  // The floor tier (a streaming site, see lib/providers/vidlink.mjs) plays
  // instantly but is a
  // heavy re-encode. The quality tier is a real release that has to be fetched
  // to the array first.
  // Rather than choosing, we play the cheap one immediately and hot-swap to the
  // good one at the current timestamp once it has a head start — so a play both
  // starts in a second AND ends up at remux quality.
  // ---- waiting on Real-Debrid to fetch an uncached release (movies/TV) ----
  //
  // With RD as the only backend, "none of the releases we tried are cached"
  // used to end the play outright. It doesn't have to: RD will fetch the
  // release, usually in a couple of minutes. This shows that happening and
  // starts playback the moment it lands.
  cancelDebridDownload() {
    clearTimeout(this._dlTimer);
    this._dlTimer = null;
    this._dlTorrent = null;
  },
  watchDebridDownload(dl) {
    this._dlTorrent = dl.torrentId;
    const id = dl.torrentId;
    const started = Date.now();
    const label = dl.release ? String(dl.release).slice(0, 60) : "the best release";
    this.showStatusAction(
      `Not cached \u2014 Real-Debrid is fetching ${label}\u2026`,
      this._serversUrl ? "Choose a different release" : null,
      () => this.openServers()
    );
    const poll = async () => {
      var _a;
      if (this._closing || this._dlTorrent !== id) return;
      if (Date.now() - started > 20 * 60 * 1e3) {
        this.cancelDebridDownload();
        return this.showStatusAction(
          "That release is taking too long to download.",
          this._serversUrl ? "Choose a different release" : null,
          () => this.openServers()
        );
      }
      let st;
      try {
        st = await (await fetch(`/api/debrid/progress/${encodeURIComponent(id)}`)).json();
      } catch {
        this._dlTimer = setTimeout(poll, 5e3);
        return;
      }
      if (st.error) {
        this.cancelDebridDownload();
        return this.showStatusAction(
          `Download failed: ${st.error}`,
          this._serversUrl ? "Choose a different release" : null,
          () => this.openServers()
        );
      }
      if (!st.ready) {
        const pct = Math.round(st.progress || 0);
        const mbs = st.speed ? ` \xB7 ${(st.speed / 1e6).toFixed(1)} MB/s` : "";
        const seeds = st.seeders ? ` \xB7 ${st.seeders} seeders` : "";
        this.showStatusAction(
          `Real-Debrid is fetching ${label}\u2026 ${pct}%${mbs}${seeds}`,
          this._serversUrl ? "Choose a different release" : null,
          () => this.openServers()
        );
        this._dlTimer = setTimeout(poll, 3e3);
        return;
      }
      this.cancelDebridDownload();
      this.streams = st.streams || [];
      this.quality = st.best || this.streams[0];
      if (!this.quality) return (_a = this._noSource) == null ? void 0 : _a.call(this);
      this.loadQuality(this.quality, 0, true);
      this.buildQualityMenu();
      this.buildSpeedMenu();
      this.buildServers();
    };
    this._dlTimer = setTimeout(poll, 2500);
  },
  cancelUpgrade() {
    clearTimeout(this._upgradeTimer);
    this._upgradeTimer = null;
    this._upgradeKey = null;
  },
  watchUpgrade(upgrade, resumeAt, { primary }) {
    if (!(upgrade == null ? void 0 : upgrade.key)) return;
    this._upgradeKey = upgrade.key;
    const key = upgrade.key;
    const started = Date.now();
    const poll = async () => {
      if (this._closing || this._upgradeKey !== key) return;
      if (Date.now() - started > 15 * 60 * 1e3) return this.cancelUpgrade();
      let st;
      try {
        st = await (await fetch(`/api/upgrade/${encodeURIComponent(key)}`)).json();
      } catch {
        this._upgradeTimer = setTimeout(poll, 5e3);
        return;
      }
      if ((st == null ? void 0 : st.total) && !st.ready && primary) {
        const pct = Math.min(99, Math.round(st.bytes / st.total * 100));
        this.showStatus(`Fetching the best available release\u2026 ${pct}%`, true);
      }
      if (!(st == null ? void 0 : st.ready)) {
        this._upgradeTimer = setTimeout(poll, 3e3);
        return;
      }
      let up;
      try {
        up = await (await fetch("/api/upgrade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anilistId: this.meta.anilistId, ep: this.ep, mode: this.mode })
        })).json();
      } catch {
        this._upgradeTimer = setTimeout(poll, 5e3);
        return;
      }
      if (!(up == null ? void 0 : up.ready) || !up.playUrl) {
        if ((up == null ? void 0 : up.available) === false && primary) return this._noSource();
        this._upgradeTimer = setTimeout(poll, 5e3);
        return;
      }
      this.cancelUpgrade();
      this.applyUpgrade(up, primary ? resumeAt : this.curT());
    };
    this._upgradeTimer = setTimeout(poll, primary ? 1e3 : 4e3);
  },
  applyUpgrade(up, at) {
    const stream = {
      url: up.playUrl,
      playUrl: up.playUrl,
      type: up.type,
      quality: up.mbps ? String(Math.round(up.mbps)) + " Mbps" : "auto",
      source: up.source || "Real-Debrid",
      release: up.release || null,
      localFile: true,
      delivery: up.delivery,
      mbps: up.mbps,
      durationSec: up.durationSec || null,
      seekBase: 0,
      // virtual-timeline inputs
      audioLabel: up.audio ? `${up.audio.codec} ${up.audio.channels}ch` : null
    };
    this.streams = [stream, ...this.streams.filter((s) => s.url !== stream.url)];
    this.loadQuality(stream, at, true);
    this.buildQualityMenu();
    this.buildServers();
    const label = [up.release, up.mbps ? `${up.mbps.toFixed(1)} Mbps` : null].filter(Boolean).join(" \xB7 ");
    if (label) this.flashNote(`Upgraded to ${label}`);
  },
  flashNote(text) {
    const n = document.createElement("div");
    n.className = "p-note";
    n.textContent = text;
    n.style.cssText = "position:absolute;left:24px;bottom:96px;background:rgba(0,0,0,.72);color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;z-index:40;transition:opacity .4s";
    this.el.appendChild(n);
    setTimeout(() => {
      n.style.opacity = "0";
      setTimeout(() => n.remove(), 500);
    }, 4e3);
  },
  // `seekTo` is an ABSOLUTE position in the title's real runtime. For a plain
  // stream that is also the media element's clock; for a live session the
  // element's clock starts at the session's start offset, and a target the
  // session can't reach (a quality switch at 40:00 onto a session that begins
  // at 0) restarts the session at the target instead of stalling against the
  // encoder.
  loadQuality(stream, seekTo = null, autoplay = false) {
    const v = this.video;
    this.quality = stream;
    this.streamIdx = this.streams.indexOf(stream);
    $("#valQuality").textContent = stream.quality === "auto" ? "Auto" : stream.quality + (/^\d+$/.test(stream.quality) ? "p" : "");
    if (this.casting) {
      this.castLoad((seekTo != null ? seekTo : this.curT()) - (Number(stream.seekBase) || 0));
      return;
    }
    const at = seekTo != null ? seekTo : this.curT();
    const wasPlaying = autoplay || !v.paused;
    this._pendingSeek = at;
    this._pendingPlay = wasPlaying;
    const base = Number(stream.seekBase) || 0;
    if (this._streamIsSession(stream) && at - base > 6) {
      this._jumpTo(at, wasPlaying);
      return;
    }
    this._attachStream(stream, Math.max(0, at - base), wasPlaying);
  },
  _streamIsSession(s) {
    return !!(s && s.localFile && s.type === "hls" && /\/media\/hls\//.test(String(s.playUrl || "")));
  },
  // The live session behind a stream URL: [, sessionId, signedToken]. The token
  // authorizes every file under the session — seeks and subtitle sidecars both.
  _sessRef(s) {
    return String((s == null ? void 0 : s.playUrl) || "").match(/\/media\/hls\/([^/]+)\/index\.m3u8\?t=([^&]+)/);
  },
  // Far seek on a live session: restart the SAME file and plan at the target
  // (see /media/hls/:id/seek — no provider round trip, the old session is
  // retired server-side). Serialized so that scrubbing three times in two
  // seconds chases only the LAST target; a expired session falls back to a
  // full stream re-request at the timestamp.
  async _jumpTo(t, wasPlaying = null) {
    this._jumpTarget = t;
    if (this._jumping) return;
    this._jumping = true;
    const resume = wasPlaying != null ? wasPlaying : !this.video.paused;
    $("#pSpinner").hidden = false;
    try {
      while (this._jumpTarget != null) {
        const target = this._jumpTarget;
        this._jumpTarget = null;
        const s = this.quality;
        const m = this._sessRef(s);
        if (!m) {
          this._attachStream(s, Math.max(0, target - (Number(s == null ? void 0 : s.seekBase) || 0)), resume);
          break;
        }
        let j = null;
        try {
          const r = await fetch(media(`/media/hls/${m[1]}/seek?to=${Math.floor(target)}&t=${m[2]}`));
          j = r.ok ? await r.json() : null;
        } catch {
        }
        if (this._closing || this.quality !== s) break;
        if (!j) {
          if (!this.movieMode && this.ep != null) {
            this.play(this.ep, target);
            break;
          }
          this._attachStream(s, Math.max(0, target - (Number(s.seekBase) || 0)), resume);
          break;
        }
        s.playUrl = j.playUrl;
        s.url = j.playUrl;
        s.seekBase = j.seekBase;
        if (this._jumpTarget == null) this._attachStream(s, 0, resume);
      }
    } finally {
      this._jumping = false;
    }
  },
  // Point the media element at a stream. `relSeek` is in the MEDIA ELEMENT's
  // own timeline — already adjusted for the session's start offset, which
  // becomes this.tShift for everything that displays or saves time.
  _attachStream(stream, relSeek = 0, wasPlaying = false) {
    var _a, _b;
    const v = this.video;
    this.tShift = this._streamIsSession(stream) ? Number(stream.seekBase) || 0 : 0;
    this.fullDur = this._streamIsSession(stream) && Number(stream.durationSec) > 0 ? Number(stream.durationSec) : null;
    (_a = this._applySubSync) == null ? void 0 : _a.call(this);
    this._mergeEmbeddedSubs(stream);
    this._mergeProviderSubs(stream);
    const at = relSeek;
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    if (stream.type === "hls" && ((_b = window.Hls) == null ? void 0 : _b.isSupported())) {
      this.hls = new Hls({
        maxBufferLength: 30,
        // keep 30s ahead in normal conditions
        maxMaxBufferLength: 300,
        // …and run far ahead when it's cheap to
        maxBufferSize: 120 * 1e3 * 1e3,
        backBufferLength: 30,
        // release watched video — TV memory is small
        fragLoadingMaxRetry: 8,
        // a missing segment is usually just late
        fragLoadingRetryDelay: 500,
        fragLoadingMaxRetryTimeout: 16e3,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 6
      });
      this._hlsRecoveries = 0;
      this.hls.loadSource(media(stream.playUrl));
      this.hls.attachMedia(v);
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => this._onStreamReady(at, wasPlaying));
      const rebuildAudio = () => this.buildAudMenu();
      this.hls.on(Hls.Events.MANIFEST_PARSED, rebuildAudio);
      if (Hls.Events.AUDIO_TRACKS_UPDATED) this.hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, rebuildAudio);
      if (Hls.Events.AUDIO_TRACK_SWITCHED) this.hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, rebuildAudio);
      this.hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        if (this._hlsRecoveries < 4) {
          this._hlsRecoveries++;
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
            this.showStatus("Stream stalled \u2014 reconnecting\u2026", true);
            this.hls.startLoad();
            return;
          }
          if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
            this.showStatus("Recovering playback\u2026", true);
            this.hls.recoverMediaError();
            return;
          }
        }
        this._onStreamError();
      });
    } else {
      v.src = media(stream.playUrl);
      v.addEventListener("loadedmetadata", () => {
        this._onStreamReady(at, wasPlaying);
        this.buildAudMenu();
      }, { once: true });
    }
    this.startProgress();
  },
  // The stream is open and seekable. Anything the overlay was saying about
  // FINDING it is now stale, so clear it here rather than waiting for a
  // `playing` event: a TV webview may refuse autoplay, no `playing` ever
  // arrives, and "Finding a cached stream on Real-Debrid…" then sits over a
  // stream that was ready the whole time. That is the stuck loading screen.
  _onStreamReady(at, wasPlaying) {
    this.clearStatus();
    const v = this.video;
    if (at) v.currentTime = at;
    if (wasPlaying) this._attemptPlay();
  },
  // Automatic fallback: when a source fails, silently try the next ranked one
  // before surfacing an error. This is the single biggest "doesn't feel broken"
  // feature — dead providers are common and rotate constantly.
  _onStreamError() {
    if (this._closing) return;
    const s = this.streams[this.streamIdx];
    if (s && s.fallbackUrl && !s._triedFallback) {
      s._triedFallback = true;
      s.playUrl = s.fallbackUrl;
      this.showStatus("Direct link failed \u2014 routing via the server\u2026", true);
      this.loadQuality(s, this._pendingSeek || 0, true);
      return;
    }
    const next = this.streams[this.streamIdx + 1];
    if (next) {
      this.showStatus(`Source failed \u2014 trying ${next.source}\u2026`, true);
      this.loadQuality(next, this._pendingSeek || 0, true);
      this.buildQualityMenu();
      this.buildServers();
    } else {
      this.showStatusAction(
        this.movieMode ? "That release stopped playing." : "Every resolved source failed for this episode.",
        "Choose a server",
        () => this.openServers()
      );
    }
  },
  // Attempt playback and always reconcile the icon with the real state.
  // v.paused flips synchronously, so sync immediately (closes the load-time
  // window where the icon lagged), then again once play() settles — the catch
  // covers browsers that block autoplay (video stays paused).
  _attemptPlay() {
    const p = this.video.play();
    this.syncPlayIcon();
    if (!p || !p.then) return;
    p.then(() => this.syncPlayIcon()).catch(() => {
      this.syncPlayIcon();
      if (this.video.paused && !this._closing)
        this.showStatus(document.documentElement.classList.contains("tv") ? "Ready \u2014 press OK to play" : "Ready \u2014 press play to start", false);
    });
  },
  // Single source of truth for the play/pause button + center overlay.
  syncPlayIcon() {
    const paused = this.casting ? this.castPlayer.isPaused : this.video.paused;
    $("#pPlay").innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
  },
  // ---- menus ----
  buildQualityMenu() {
    $("#qualityList").innerHTML = this.streams.map((s, i) => {
      let label = s.quality === "auto" ? `Auto (${srcName(s)})` : s.quality + (/^\d+$/.test(s.quality) ? "p" : "");
      if (s.tag) label += ` \xB7 ${s.tag}`;
      return `<button class="p-menu-item ${s === this.quality ? "active" : ""}" data-q="${i}"><span>${label}</span>${srcBadge(s)}</button>`;
    }).join("") + `<button class="p-menu-row" id="qualityToServers"><span>All servers</span><span class="p-menu-val">\u203A</span></button>`;
    $("#qualityList").querySelectorAll("[data-q]").forEach((b) => b.onclick = () => {
      this.loadQuality(this.streams[+b.dataset.q]);
      this.buildQualityMenu();
      this.buildAudMenu();
      this.gotoSub("root");
    });
    $("#qualityToServers").onclick = () => this.showServersSub();
  },
  buildSpeedMenu() {
    const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
    $("#speedList").innerHTML = speeds.map((s) => `<button class="p-menu-item ${this.video.playbackRate === s ? "active" : ""}" data-s="${s}">${s === 1 ? "Normal" : s + "\xD7"}</button>`).join("");
    $("#speedList").querySelectorAll("[data-s]").forEach((b) => b.onclick = () => {
      this.video.playbackRate = +b.dataset.s;
      $("#valSpeed").textContent = +b.dataset.s === 1 ? "Normal" : b.dataset.s + "\xD7";
      this.buildSpeedMenu();
      this.gotoSub("root");
    });
  },
  // ---- servers: every source this stream can play from ----
  // The Quality menu answers "how big"; this answers "from where". Auto-play
  // only ever gets ONE opinion — the first scraper mirror, or the first release
  // Real-Debrid happens to have cached — and when that pick is a bad rip, the
  // wrong audio track or a stalling mirror there was previously no way to say
  // "give me a different one". Every candidate is listed here instead.
  resetServers() {
    this._srvList = null;
    this._srvLoaded = false;
    this._srvBusy = false;
    this._srvBusyId = null;
    this._srvError = "";
    this.closeServers();
  },
  // What "this stream" means right now — anything that changes it invalidates
  // an in-flight servers lookup.
  _srvToken() {
    var _a;
    return this.movieMode ? this._streamEndpoint : `${(_a = this.meta) == null ? void 0 : _a.anilistId}:${this.ep}:${this.mode}`;
  },
  _srvCanLoadMore() {
    var _a;
    return this.movieMode ? !!this._serversUrl : !!((_a = this.meta) == null ? void 0 : _a.anilistId);
  },
  // One row per selectable source, favourites first (the rest keep their
  // ranked order, which encodes how likely each is to actually play).
  _serverRows() {
    let rows;
    if (this.movieMode) {
      const live = this.quality;
      rows = (this._srvList || []).map((s) => {
        const isLive = !!(live == null ? void 0 : live.serverId) && live.serverId === s.id;
        return {
          kind: "rd",
          id: s.id,
          key: s.sig,
          label: s.name,
          title: s.name,
          // Resolution leads the row instead of sitting in the detail line.
          // Half a film's releases are "1080p BluRay" and the names are long
          // dotted strings, so deciding "4K or 1080p?" meant reading every
          // headline down to its middle. As its own column it is scannable,
          // and being outside .srv-name it survives the truncation that eats
          // the end of a long release name.
          res: /^\d{3,4}$/.test(String(s.quality || "")) ? `${s.quality}p` : null,
          detail: [
            s.tag,
            s.group,
            // Language, which is why this row exists at all: without it the
            // only way to find out whether a release spoke English was to play
            // it. The PLAYING row gets ffprobe's real track list instead of
            // the name's claim — see probedLangLabel.
            isLive ? probedLangLabel(live) || s.langLabel : s.langLabel,
            s.subLabel ? `${s.subLabel} subs` : null,
            s.seeders ? `${s.seeders} seeders` : null
          ].filter(Boolean).join(" \xB7 ") || "Release",
          live: isLive
        };
      });
      if (live && !rows.some((r) => r.live))
        rows.unshift({
          kind: "rd",
          id: live.serverId,
          key: live.sig,
          live: true,
          stream: live,
          res: /^\d{3,4}$/.test(String(live.quality || "")) ? `${live.quality}p` : null,
          label: live.serverName || live.serverLabel || live.source || "Playing now",
          title: live.serverName || "",
          detail: [live.serverLabel, probedLangLabel(live) || live.langLabel].filter(Boolean).join(" \xB7 ") || "Playing now"
        });
    } else {
      rows = this.streams.map((s) => ({
        kind: "anime",
        stream: s,
        key: srvAnimeKey(s),
        label: s.source || "Source",
        // The "p" is appended here, so only a bare resolution earns one — a
        // source that already said "1080p" would otherwise read "1080pp".
        res: /^\d{3,4}$/.test(String(s.quality || "")) ? `${s.quality}p` : null,
        detail: [
          /^\d{3,4}$/.test(String(s.quality || "")) ? null : s.quality && s.quality !== "auto" ? s.quality : "Auto quality",
          // Same rule as films: probed truth for what's playing, the release
          // name's claim for everything else.
          (s === this.quality ? probedLangLabel(s) : null) || s.langLabel,
          s.type === "hls" ? "HLS" : "MP4"
        ].filter(Boolean).join(" \xB7 "),
        live: s === this.quality
      }));
    }
    const fav = rows.filter((r) => srvIsFav(r.key));
    return fav.length ? [...fav, ...rows.filter((r) => !srvIsFav(r.key))] : rows;
  },
  buildServers() {
    const list = $("#srvList");
    if (!list) return;
    const rows = this._serverRows();
    const live = rows.find((r) => r.live);
    const val = $("#valServer");
    if (val) {
      const name = live ? live.label.length > 26 ? live.label.slice(0, 25) + "\u2026" : live.label : "Auto";
      val.textContent = (live == null ? void 0 : live.res) ? `${live.res} \xB7 ${name}` : name;
    }
    $("#srvCount").textContent = !rows.length && this._srvBusy ? "Looking for sources\u2026" : `${rows.length} server${rows.length === 1 ? "" : "s"}${this._srvBusy ? " \xB7 searching\u2026" : ""}`;
    list.innerHTML = rows.length ? rows.map((r, i) => {
      const on = srvIsFav(r.key);
      const busy = this._srvBusyId && r.id === this._srvBusyId;
      return `<div class="srv-row ${r.live ? "live" : ""} ${on ? "fav" : ""}" data-i="${i}" title="${esc(r.title || r.label)}">
            <div class="srv-body">
              <div class="srv-t">${r.res ? `<span class="srv-res">${esc(r.res)}</span>` : ""}<span class="srv-name">${esc(r.label)}</span>${r.stream ? srcBadge(r.stream) : ""}</div>
              <div class="srv-s">${busy ? "Starting\u2026" : esc(r.detail)}</div>
            </div>
            <button class="srv-fav ${on ? "on" : ""}" data-fav="${i}"
              title="${on ? "Stop preferring" : "Always prefer"} ${esc(srvFavLabel(r.key))}">${on ? ICON_HEART : ICON_HEART_O}</button>
            ${r.live ? `<span class="srv-live">${ICON_PLAY_SM} LIVE</span>` : ""}
          </div>`;
    }).join("") : `<div class="srv-note">${this._srvBusy ? "Searching for playable sources\u2026" : "No source is listed for this one yet."}</div>`;
    list.querySelectorAll(".srv-row").forEach((el) => {
      el.onclick = (e) => {
        if (!e.target.closest(".srv-fav")) this.pickServer(rows[+el.dataset.i]);
      };
    });
    list.querySelectorAll("[data-fav]").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        srvToggleFav(rows[+b.dataset.fav].key);
        this.buildServers();
      };
    });
    const foot = $("#srvFoot");
    foot.classList.toggle("bad", !!this._srvError);
    const langHint = rows.some((r) => !r.live && /·/.test(r.detail)) ? " Languages are read from the release name; the LIVE row shows the tracks the file really has." : "";
    const hint = this._srvError || (this.movieMode ? "Releases play instantly only while Real-Debrid has them cached. \u2665 a kind of release to have it tried first everywhere." : "\u2665 a source to always prefer it, on every title.") + langHint;
    foot.innerHTML = `<span>${esc(hint)}</span>` + (!this._srvLoaded && !this._srvBusy && this._srvCanLoadMore() ? `<button class="btn" id="srvMore">Find more sources</button>` : "");
    foot.hidden = false;
    const more = $("#srvMore");
    if (more) more.onclick = () => this.loadMoreServers();
  },
  // Movies/TV: the full ranked release list (pure list work on the server, no
  // Real-Debrid calls). Anime: the Real-Debrid-backed providers a normal play
  // warm-starts and throws away — those DO cost RD cycles, which is why anime
  // waits for the user to press the button instead of loading on open.
  async loadMoreServers() {
    if (this._srvBusy || this._srvLoaded || !this._srvCanLoadMore()) return;
    const token = this._srvToken();
    this._srvBusy = true;
    this._srvError = "";
    this.buildServers();
    try {
      if (this.movieMode) {
        const r = await fetch(this._serversUrl);
        const j = await r.json();
        if (this._srvToken() !== token) return;
        this._srvList = j.servers || [];
      } else {
        const url = `/api/stream/${this.meta.anilistId}/${encodeURIComponent(this.ep)}/more?mode=${this.mode}`;
        const fresh = (await (await fetch(url)).json()).streams || [];
        if (this._srvToken() !== token) return;
        const known = new Set(this.streams.map((s) => s.url));
        const add = fresh.filter((s) => !known.has(s.url));
        if (add.length) {
          this.streams = [...this.streams, ...add];
          this.buildQualityMenu();
        }
      }
    } catch {
      if (this._srvToken() !== token) return;
      this._srvError = "Couldn't reach the extra sources \u2014 try again in a moment.";
    }
    this._srvBusy = false;
    this._srvLoaded = true;
    this.buildServers();
  },
  pickServer(r) {
    if (!r) return;
    if (r.live) {
      this.closeServers();
      return;
    }
    if (r.kind === "anime") {
      this.loadQuality(r.stream, this.curT(), true);
      this.buildQualityMenu();
      this.buildServers();
      this.closeServers();
      return;
    }
    this.switchServer(r);
  },
  // Movies/TV: ask the server for this exact release. It's tried ALONE — no
  // falling through to the ranked default, which would silently undo the
  // choice — so an uncached pick fails fast and the old stream comes back.
  async switchServer(r) {
    var _a, _b, _c, _d;
    if (!r.id) return;
    const at = this.curT(), prev = this.quality;
    this._audioIndex = null;
    this._srvBusy = true;
    this._srvBusyId = r.id;
    this._srvError = "";
    this.buildServers();
    const token = this._srvToken();
    let data = null, err = "", errCode = null;
    try {
      const res = await fetch(withQuery(this._streamBase, { server: r.id }));
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        const e = new Error(j.detail || j.error || `the server replied ${res.status}`);
        e.code = j.error || null;
        throw e;
      }
      data = await res.json();
      if (res.status === 202 && (((_a = data.downloading) == null ? void 0 : _a.torrentId) || ((_b = data.upgrade) == null ? void 0 : _b.key))) {
        if (this._closing || this._srvToken() !== token) return;
        this._srvBusy = false;
        this._srvBusyId = null;
        this.closeServers();
        if ((_c = data.downloading) == null ? void 0 : _c.torrentId) {
          this.watchDebridDownload(data.downloading);
          return;
        }
        this.showStatus("Fetching the release you picked\u2026", true);
        this.watchUpgrade(data.upgrade, at, { primary: true });
        return;
      }
    } catch (e) {
      err = String(e.message || "unavailable");
      errCode = e.code || null;
    }
    if (this._closing || this._srvToken() !== token) return;
    this._srvBusy = false;
    this._srvBusyId = null;
    if (!((_d = data == null ? void 0 : data.streams) == null ? void 0 : _d.length)) {
      this._srvError = /network unreachable/i.test(err) ? `Couldn't reach the debrid service \u2014 ${err.replace(/^.*network unreachable/i, "network unreachable")}. Try again.` : errCode === "debrid-account" ? err : `${r.label} didn't start \u2014 ${err}`;
      this.buildServers();
      if (prev) this.loadQuality(prev, at, true);
      return;
    }
    const s = data.streams[0];
    this.streams = [s, ...this.streams.filter((x) => x.serverId !== s.serverId)];
    this.loadQuality(s, at, true);
    this.buildQualityMenu();
    this.buildServers();
    this.buildAudMenu();
    this.closeServers();
  },
  // Servers live INSIDE the settings menu now (a submenu next to Quality) —
  // one place for "make it play differently" instead of a dedicated drawer.
  // openServers is still the single entry point: the gear row, the quality
  // submenu's link, every "Choose a server" status action, and the `s` key all
  // land here.
  openServers() {
    this.hideMenus();
    this.closeDrawer();
    $("#settingsMenu").hidden = false;
    $("#pGear").classList.add("on");
    this.showServersSub();
  },
  // Navigate the already-open settings menu to the servers submenu.
  showServersSub() {
    this.gotoSub("servers");
    this.buildServers();
    if (this.movieMode) this.loadMoreServers();
  },
  serversOpen() {
    return !$("#settingsMenu").hidden && !document.querySelector('#settingsMenu [data-sub="servers"]').hidden;
  },
  closeServers() {
    this.hideMenus();
  },
  // ---- audio menu ----
  //
  // Two shapes behind one button:
  //   anime      — sub/dub, which are different RELEASES (Japanese vs English
  //                audio come from different files), so switching re-resolves.
  //   films / TV — the tracks inside THIS file, listed by language. Switching
  //                re-delivers the same release with a different track mapped.
  buildAudMenu() {
    if (this.movieMode) return this.buildTrackMenu();
    const items = [
      { mode: "sub", label: "Japanese", on: detail.episodes.length > 0 },
      { mode: "dub", label: "English", on: detail.hasDub }
    ];
    $("#audList").innerHTML = items.map((m) => `<button class="p-menu-item ${this.mode === m.mode ? "active" : ""}" data-m="${m.mode}" ${m.on ? "" : "disabled style='opacity:.4'"}>${m.label}</button>`).join("");
    $("#audList").querySelectorAll("[data-m]").forEach((b) => b.onclick = () => {
      if (b.disabled) return;
      this.switchMode(b.dataset.m);
    });
    $("#audNote").textContent = "Japanese audio shows the release\u2019s English subtitles when it carries them; English audio needs none.";
    const extra = this._audioChoices();
    if (extra.items.length > 1) {
      $("#audList").insertAdjacentHTML(
        "beforeend",
        `<div class="p-menu-title">This release</div>` + extra.items.map((t) => `<button class="p-menu-item ${t.active ? "active" : ""}" data-x="${esc(String(t.key))}">${esc(t.label)}</button>`).join("")
      );
      $("#audList").querySelectorAll("[data-x]").forEach((b) => b.onclick = () => extra.pick(b.dataset.x));
    }
  },
  // Films and TV: the file's own audio streams. Only meaningful once the
  // release has been probed, which is why this is built from the delivered
  // stream rather than offered up front — a release's languages aren't
  // knowable from its name.
  buildTrackMenu() {
    const list = this._audioChoices();
    $("#pAud").style.display = list.items.length > 1 ? "" : "none";
    if (list.items.length < 2) {
      $("#audList").innerHTML = "";
      $("#audNote").textContent = "";
      return;
    }
    $("#audList").innerHTML = list.items.map((t) => `<button class="p-menu-item ${t.active ? "active" : ""}" data-t="${esc(String(t.key))}">${esc(t.label)}</button>`).join("");
    $("#audList").querySelectorAll("[data-t]").forEach((b) => b.onclick = () => list.pick(b.dataset.t));
    $("#audNote").textContent = list.note;
  },
  // Where a "different audio track" can come from, in order of preference.
  // Only the first of these used to exist, which is why a Spanish-only-sounding
  // stream had no way out on the TV: the release wasn't locally probed, so the
  // menu was empty and the button hid itself, and a remote has no other route
  // to the source list.
  //
  //   probed  — ffprobe's track list for a release we deliver ourselves.
  //             Switching re-delivers the file with a different track mapped.
  //   hls     — alternate audio renditions declared by the playing manifest.
  //             Switching is client-side and instant (hls.js owns it).
  //   native  — HTMLMediaElement.audioTracks, when the webview plays the
  //             stream itself rather than through hls.js. Tizen has this.
  _audioChoices() {
    var _a, _b, _c, _d, _e;
    const probed = ((_a = this.quality) == null ? void 0 : _a.audioTracks) || [];
    if (probed.length > 1) {
      const cur = (_c = (_b = this.quality) == null ? void 0 : _b.audioIndex) != null ? _c : null;
      return {
        items: probed.map((t, i) => ({ key: t.index, label: audTrackLabel(t, i), active: t.index === cur })),
        pick: (k) => this.switchAudioTrack(+k),
        note: "Tracks come from this release. Subtitles are under the CC button."
      };
    }
    const hlsTracks = ((_d = this.hls) == null ? void 0 : _d.audioTracks) || [];
    if (hlsTracks.length > 1) {
      const cur = this.hls.audioTrack;
      return {
        items: hlsTracks.map((t, i) => ({
          key: i,
          label: langName(t.lang) || t.name || `Track ${i + 1}`,
          active: i === cur
        })),
        pick: (k) => {
          this.hls.audioTrack = +k;
          this.hideMenus();
          setTimeout(() => this.buildAudMenu(), 200);
        },
        note: "Audio tracks offered by this source. Try another server if the language you want isn't here."
      };
    }
    const nat = (_e = this.video) == null ? void 0 : _e.audioTracks;
    if (nat && nat.length > 1) {
      const items = [];
      for (let i = 0; i < nat.length; i++)
        items.push({ key: i, label: langName(nat[i].language) || nat[i].label || `Track ${i + 1}`, active: nat[i].enabled });
      return {
        items,
        pick: (k) => {
          for (let i = 0; i < nat.length; i++) nat[i].enabled = i === +k;
          this.hideMenus();
          setTimeout(() => this.buildAudMenu(), 200);
        },
        note: "Audio tracks offered by this source. Try another server if the language you want isn't here."
      };
    }
    return { items: [], pick: () => {
    }, note: "" };
  },
  // Re-deliver the SAME release with a different audio track, resuming where
  // the viewer was. The server keys a transcode session partly on the audio
  // index, so this is a new session — hence the full stream request rather
  // than a seek.
  async switchAudioTrack(index) {
    var _a, _b;
    if (!this.movieMode || index === ((_b = (_a = this.quality) == null ? void 0 : _a.audioIndex) != null ? _b : null)) {
      this.hideMenus();
      return;
    }
    const at = this.curT();
    this.hideMenus();
    this._audioIndex = index;
    this.showStatus("Switching audio track\u2026", true);
    await this.playStream({ seek: at });
  },
  // ---- subtitles menu: external multi-language tracks (OpenSubtitles) ----
  // Two subtitle sources feed ONE menu:
  //   embedded — the release's own text tracks, extracted by the transcode
  //              session as sidecar VTTs. Timed for exactly this file, which
  //              is what makes them the default for anime sub mode.
  //   provider — soft subtitle files that a streaming source ships beside the
  //              video. Timed for exactly that stream, and the ONLY subtitles a
  //              floor-tier play has: those sources are hardsub-free, so
  //              without these, sub mode is Japanese audio and a blank screen.
  //   external — OpenSubtitles, timed for SOME release and nudgeable.
  // They're kept apart because they refresh on different events (a seek remints
  // the embedded ones, switching source replaces the provider ones, a new
  // episode refetches the external ones) and composed whenever any changes.
  _composeSubs() {
    this.subsAvail = [
      ...this._subsEmbedded || [],
      ...this._subsProvider || [],
      ...this._subsExternal || []
    ];
    this.buildCcMenu();
  },
  _mergeProviderSubs(stream) {
    var _a;
    const tracks = (stream == null ? void 0 : stream.providerSubs) || [];
    this._subsProvider = tracks.map((t, i) => ({
      id: t.id || `os:${i}`,
      lang: t.lang || "und",
      label: t.label || langName(t.lang) || `Track ${i + 1}`,
      url: t.url
    }));
    this._composeSubs();
    const active = this.subId && this.subsAvail.some((t) => t.id === this.subId);
    if (active || this._subUserOff || this.mode !== "sub" || !this._subsProvider.length) return;
    if ((_a = this._subsEmbedded) == null ? void 0 : _a.length) return;
    const eng = this._subsProvider.find((t) => /^en/i.test(t.lang) || /english/i.test(t.label));
    this.setSubtitle((eng || this._subsProvider[0]).id, true);
  },
  _mergeEmbeddedSubs(stream) {
    const ref = this._streamIsSession(stream) && this._sessRef(stream);
    const subs = ref && stream.embeddedSubs || [];
    this._subsEmbedded = subs.map((s, i) => {
      const base = langName(s.language) || `Track ${i + 1}`;
      const t = (s.title || "").trim();
      const extra = t && !new RegExp(`^${base}$`, "i").test(t) ? ` (${t.slice(0, 24)})` : "";
      return {
        id: `emb:${s.index}`,
        lang: s.language || "und",
        label: `${base}${extra} \xB7 release`,
        url: `/media/hls/${ref[1]}/sub-${s.index}.vtt?t=${ref[2]}`,
        embedded: true
      };
    });
    this._composeSubs();
    if (this.subId && this.subId.startsWith("emb:")) {
      this.setSubtitle(this._subsEmbedded.some((t) => t.id === this.subId) ? this.subId : null, true);
    } else if (!this.subId && !this._subUserOff && this.mode === "sub" && this._subsEmbedded.length) {
      const eng = this._subsEmbedded.find((t) => /^en/i.test(t.lang) || /english/i.test(t.label));
      this.setSubtitle((eng || this._subsEmbedded[0]).id, true);
    }
  },
  loadSubs(ep) {
    this._subsExternal = [];
    this._subsEmbedded = [];
    this._subsProvider = [];
    this.video.querySelectorAll("track").forEach((t) => t.remove());
    this._composeSubs();
    fetch(`/api/subs/${this.meta.anilistId}/${ep}`).then((r) => r.ok ? r.json() : { tracks: [] }).then(({ tracks }) => {
      if (this.ep !== String(ep)) return;
      this._subsExternal = tracks || [];
      this._composeSubs();
      if (this.subLang && !/^(emb|os):/.test(this.subId || "")) this.setSubtitle(this.subLang, true);
    }).catch(() => {
    });
  },
  // Movie/TV variant: tracks come from the stream's sibling subs endpoint
  // (IMDb-keyed on the server). The endpoint doubles as the staleness guard.
  loadStreamSubs() {
    this._subsExternal = [];
    this._subsEmbedded = [];
    this._subsProvider = [];
    this.video.querySelectorAll("track").forEach((t) => t.remove());
    this._composeSubs();
    if (!this._subsUrl) return;
    const token = this._streamEndpoint;
    fetch(this._subsUrl).then((r) => r.ok ? r.json() : { tracks: [] }).then(({ tracks }) => {
      if (!this.movieMode || this._streamEndpoint !== token) return;
      this._subsExternal = tracks || [];
      this._composeSubs();
      if (this.subLang && !(this.subId || "").startsWith("emb:")) this.setSubtitle(this.subLang, true);
    }).catch(() => {
    });
  },
  // `pick` is a track id; a bare language code still works so the carry-over
  // between episodes ("keep showing English") needs no special case.
  setSubtitle(pick, silent) {
    const v = this.video;
    v.querySelectorAll("track").forEach((t2) => t2.remove());
    clearTimeout(this._subRefreshTimer);
    this._subRefreshTimer = null;
    this.subLang = null;
    this.subId = null;
    this._subEmbedded = false;
    if (!silent) this._subUserOff = !pick;
    const t = pick && (this.subsAvail.find((s) => s.id === pick) || this.subsAvail.find((s) => s.lang === pick));
    if (t) {
      this.subLang = t.lang;
      this.subId = t.id;
      this._subEmbedded = !!t.embedded;
      const el = document.createElement("track");
      el.kind = "subtitles";
      el.label = t.label;
      el.srclang = t.lang;
      el.src = media(t.url);
      el.default = true;
      v.appendChild(el);
      el.track.mode = "showing";
      this._armSubSync(el);
      if (t.embedded) {
        const cues = () => {
          var _a, _b;
          return ((_b = (_a = el.track) == null ? void 0 : _a.cues) == null ? void 0 : _b.length) || 0;
        };
        const rearm = () => {
          this._subRefreshTimer = setTimeout(() => {
            if (this._closing || this.subId !== t.id || this.video.ended) return;
            this.setSubtitle(t.id, true);
          }, cues() ? 45e3 : 6e3);
        };
        rearm();
      }
    }
    this.buildCcMenu();
    if (!silent) this.hideMenus();
  },
  // ---- subtitle sync ----
  // Even the right subtitle file often sits a second or two off the audio,
  // because it was timed against a different release. Rather than re-download
  // anything, shift the cues in place: each cue's ORIGINAL times are stashed on
  // first sight, so repeated nudges stay exact instead of accumulating drift.
  // The offset is per title and remembered, since a given release is usually
  // off by the same amount throughout.
  _subSyncKey() {
    var _a, _b;
    const id = ((_a = this.meta) == null ? void 0 : _a.anilistId) || this._streamBase || ((_b = this.meta) == null ? void 0 : _b.title) || "x";
    return `mw:subsync:${id}`;
  },
  _armSubSync(trackEl) {
    const stored = Number(localStorage.getItem(this._subSyncKey()));
    this.subOffset = Number.isFinite(stored) ? stored : 0;
    const apply = () => {
      const tt = trackEl.track;
      const cues = tt && tt.cues;
      if (!cues || !cues.length) return false;
      const mode = tt.mode;
      tt.mode = "hidden";
      const shift = this._subEmbedded ? 0 : Player.tShift || 0;
      for (const c of cues) {
        if (c._o === void 0) {
          c._o = c.startTime;
          c._e = c.endTime;
        }
        c.startTime = Math.max(0, c._o + this.subOffset - shift);
        c.endTime = Math.max(0.05, c._e + this.subOffset - shift);
      }
      tt.mode = mode;
      return true;
    };
    this._applySubSync = apply;
    if (!apply()) trackEl.addEventListener("load", () => apply(), { once: true });
  },
  nudgeSubtitles(delta) {
    var _a;
    if (!this.subId) return;
    this.subOffset = Math.round(((this.subOffset || 0) + delta) * 10) / 10;
    localStorage.setItem(this._subSyncKey(), String(this.subOffset));
    (_a = this._applySubSync) == null ? void 0 : _a.call(this);
    this.buildCcMenu();
  },
  resetSubtitleSync() {
    var _a;
    this.subOffset = 0;
    localStorage.removeItem(this._subSyncKey());
    (_a = this._applySubSync) == null ? void 0 : _a.call(this);
    this.buildCcMenu();
  },
  buildCcMenu() {
    var _a;
    const offLabel = "Off";
    const rows = [
      `<button class="p-menu-item ${!this.subId ? "active" : ""}" data-s="">${offLabel}</button>`,
      ...(this.subsAvail || []).map((t) => `<button class="p-menu-item ${this.subId === t.id ? "active" : ""}" data-s="${esc(t.id)}">${esc(t.label)}</button>`)
    ];
    const off = this.subOffset || 0;
    const sync = this.subId ? `
      <div class="p-menu-sec sep">Sync</div>
      <div class="sub-sync">
        <button class="p-icon" data-nudge="-0.5" title="Subtitles earlier">\u2212</button>
        <span class="sub-sync-val ${off ? "on" : ""}">${off > 0 ? "+" : ""}${off.toFixed(1)}s</span>
        <button class="p-icon" data-nudge="0.5" title="Subtitles later">+</button>
        ${off ? `<button class="p-menu-back sub-sync-reset" data-nudge="reset">Reset</button>` : ""}
      </div>` : "";
    $("#ccList").innerHTML = rows.join("") + sync + (((_a = this.subsAvail) == null ? void 0 : _a.length) ? "" : `<div class="p-menu-empty">No subtitles found for this one yet.</div>`);
    $("#ccList").querySelectorAll("[data-s]").forEach((b) => b.onclick = () => this.setSubtitle(b.dataset.s || null));
    $("#ccList").querySelectorAll("[data-nudge]").forEach((b) => b.onclick = () => b.dataset.nudge === "reset" ? this.resetSubtitleSync() : this.nudgeSubtitles(+b.dataset.nudge));
    $("#ccNote").textContent = "Tracks marked \u201Crelease\u201D come from the file itself and are timed exactly. External tracks were timed for some other release and can drift \u2014 nudge with \u2212 / +, or try another numbered variant of the same language.";
  },
  async switchMode(mode) {
    if (mode === this.mode) {
      this.hideMenus();
      return;
    }
    const eps = mode === "dub" ? detail.dubEpisodes : detail.episodes;
    if (!eps.includes(this.ep)) {
      this.showStatus(`Episode ${this.ep} not available in ${mode}.`, false);
      return;
    }
    this.mode = mode;
    this.episodes = eps;
    await this.play(this.ep, this.curT());
    this.hideMenus();
  },
  // ---- episode nav ----
  idx() {
    return this.episodes.indexOf(this.ep);
  },
  hasNext() {
    return this.idx() >= 0 && this.idx() < this.episodes.length - 1;
  },
  hasPrev() {
    return this.idx() > 0;
  },
  next() {
    var _a;
    if (this.movieMode) {
      if ((_a = this._streamNav) == null ? void 0 : _a.next) nav(this._streamNav.next.path, true);
      return;
    }
    if (this.hasNext()) this.play(this.episodes[this.idx() + 1], 0);
  },
  prev() {
    var _a;
    if (this.movieMode) {
      if ((_a = this._streamNav) == null ? void 0 : _a.prev) nav(this._streamNav.prev.path, true);
      return;
    }
    if (this.hasPrev()) this.play(this.episodes[this.idx() - 1], 0);
  },
  // TV episodes ride the movie-mode player but DO have neighbours; showTvPlayer
  // arms them here once it has looked the season up (movies never call this).
  // Passing { prev:null, next:null } still marks the stream as episodic, which
  // the 'ended' messaging uses ("End of available episodes", not "Movie ended").
  setStreamNav(navs) {
    this._streamNav = navs || null;
    this.highlightEp();
  },
  renderDrawer() {
    const p = detail.progress;
    $("#epsDrawerList").innerHTML = this.episodes.map((ep) => {
      const pct = p && p.episode === String(ep) && p.duration ? Math.min(100, p.seconds / p.duration * 100) : 0;
      return `<div class="p-drawer-ep ${ep === this.ep ? "active" : ""}" data-ep="${ep}">
        <div class="p-drawer-num">${ep}</div>
        <div class="p-drawer-meta"><div class="t">Episode ${ep}</div>
          <div class="s">${this.mode.toUpperCase()}</div>
          ${pct ? `<div class="mini-prog"><div style="width:${pct}%"></div></div>` : ""}
        </div></div>`;
    }).join("");
    $("#epsDrawerList").querySelectorAll(".p-drawer-ep").forEach((el) => el.onclick = () => {
      this.play(el.dataset.ep, 0);
      this.closeDrawer();
    });
  },
  highlightEp() {
    var _a, _b;
    const canPrev = this.movieMode ? !!((_a = this._streamNav) == null ? void 0 : _a.prev) : this.hasPrev();
    const canNext = this.movieMode ? !!((_b = this._streamNav) == null ? void 0 : _b.next) : this.hasNext();
    $("#pPrev").style.display = canPrev ? "" : "none";
    $("#pNext").style.display = canNext ? "" : "none";
    $("#pPrev").style.opacity = canPrev ? 1 : 0.35;
    $("#pNext").style.opacity = canNext ? 1 : 0.35;
    $("#epsDrawerList").querySelectorAll(".p-drawer-ep").forEach((el) => el.classList.toggle("active", el.dataset.ep === this.ep));
  },
  // ---- status / progress ----
  showStatus(text, spinner) {
    $("#pStatus").hidden = !text;
    $("#pStatus").textContent = text;
    $("#pSpinner").hidden = !spinner;
  },
  clearStatus() {
    $("#pStatus").hidden = true;
    $("#pSpinner").hidden = true;
  },
  // Status message with an action button (e.g. "Switch to Sub"). Returns the
  // node so callers can append extra lines (like a live source-status note).
  showStatusAction(text, actionLabel, onAction) {
    const s = $("#pStatus");
    $("#pSpinner").hidden = true;
    s.hidden = false;
    s.innerHTML = "";
    const line = document.createElement("div");
    line.textContent = text;
    s.appendChild(line);
    if (actionLabel) {
      const b = document.createElement("button");
      b.className = "btn";
      b.style.marginTop = "12px";
      b.textContent = actionLabel;
      b.onclick = () => onAction();
      s.appendChild(b);
    }
    return s;
  },
  // Smarter "no source" handling: dub releases are far rarer than sub ones, so
  // a dub miss is common and usually means "try Sub" rather than "this episode
  // is unavailable". Steer there instead of a dead end, and name which sources
  // are actually failing.
  _noSource() {
    const other = this.mode === "dub" ? "sub" : "dub";
    const otherEps = other === "dub" ? detail == null ? void 0 : detail.dubEpisodes : detail == null ? void 0 : detail.episodes;
    const canSwitch = otherEps == null ? void 0 : otherEps.includes(this.ep);
    if (this.mode === "dub" && canSwitch) {
      this.showStatusAction("Dub isn\u2019t available for this episode right now.", "Switch to Sub", () => this.switchMode("sub"));
    } else if (this.mode === "sub" && canSwitch) {
      this.showStatusAction("This source is down right now \u2014 the dub may still work.", "Try Dub", () => this.switchMode("dub"));
    } else {
      this.showStatus("No source could serve this episode right now. Try again shortly.", false);
    }
    fetch("/healthz").then((r) => r.json()).then((h) => {
      if (this._closing || !this.el.classList.contains("show")) return;
      const bad = ((h == null ? void 0 : h.providers) || []).filter((p) => p.status !== "ok" && p.status !== "unknown");
      if (!bad.length) return;
      const note = document.createElement("div");
      note.style.cssText = "margin-top:10px;font-size:13px;opacity:.65";
      note.textContent = `Sources: ${bad.map((p) => `${p.name} \u2014 ${p.lastError || p.status}`).join(" \xB7 ")}`;
      $("#pStatus").appendChild(note);
    }).catch(() => {
    });
  },
  // What to write to /api/progress for whatever is playing, or null when this
  // playback isn't something to remember (a film launched before `track` was
  // known — there is nothing to key the row on).
  _progressBody(seconds, duration) {
    var _a, _b, _c, _d;
    if (!this.movieMode) {
      return {
        kind: "anime",
        id: this.meta.anilistId,
        title: this.meta.title,
        cover: this.meta.cover,
        episode: this.ep,
        seconds,
        duration
      };
    }
    const t = this._track;
    if (!(t == null ? void 0 : t.kind) || !t.id) return null;
    return {
      kind: t.kind,
      id: t.id,
      // A film's player heading IS its title — a deep link opens on the
      // placeholder "Movie" and the stream response replaces it with the real
      // name long before the first report. A show's heading is the composite
      // "Show · S2 E4", which is not what belongs on a card, so TV sends the
      // catalog name or nothing and lets the server repair it.
      title: (_a = t.title) != null ? _a : t.kind === "movie" ? this.meta.title : null,
      cover: (_b = t.cover) != null ? _b : null,
      season: (_c = t.season) != null ? _c : null,
      episode: (_d = t.episode) != null ? _d : null,
      seconds,
      duration
    };
  },
  startProgress() {
    clearInterval(this.progressTimer);
    const report = (beacon) => {
      const seconds = this.curT(), duration = this.durT();
      if (!duration) return;
      const payload = this._progressBody(seconds, duration);
      if (!payload) return;
      const body = JSON.stringify(payload);
      if (!this.movieMode) detail.progress = { episode: this.ep, seconds, duration };
      if (beacon && navigator.sendBeacon) navigator.sendBeacon("/api/progress", new Blob([body], { type: "application/json" }));
      else fetch("/api/progress", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    };
    this.progressTimer = setInterval(() => report(false), 1e4);
    this._report = report;
  },
  // ---- chrome show/hide ----
  poke() {
    this.el.classList.remove("controls-hidden", "hide-cursor");
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.casting && !this.video.paused && !this._menuOpen()) {
        this.el.classList.add("controls-hidden", "hide-cursor");
        this.hideMenus();
      }
    }, 3e3);
  },
  _menuOpen() {
    return !$("#settingsMenu").hidden || !$("#ccMenu").hidden || !$("#audMenu").hidden || $("#epsDrawer").classList.contains("show");
  },
  hideMenus() {
    $("#settingsMenu").hidden = true;
    $("#ccMenu").hidden = true;
    $("#audMenu").hidden = true;
    $("#pGear").classList.remove("on");
    $("#pCc").classList.remove("on");
    $("#pAud").classList.remove("on");
    this.gotoSub("root");
  },
  toggleMenu(id, iconId) {
    const el = $(id);
    const show = el.hidden;
    this.hideMenus();
    this.closeDrawer();
    el.hidden = !show;
    $(iconId).classList.toggle("on", show);
  },
  gotoSub(name) {
    document.querySelectorAll("#settingsMenu .p-submenu").forEach((s) => s.hidden = s.dataset.sub !== name);
  },
  // The episodes drawer (servers moved into the settings menu).
  openDrawer(sel = "#epsDrawer") {
    this.hideMenus();
    const d = $(sel);
    d.hidden = false;
    void d.offsetWidth;
    d.classList.add("show");
  },
  closeDrawer(sel = "#epsDrawer") {
    const d = $(sel);
    if (!d) return;
    d.classList.remove("show");
    setTimeout(() => {
      if (!d.classList.contains("show")) d.hidden = true;
    }, 280);
  },
  // ---- skip intro/outro (AniSkip community timestamps, proxied by the server) ----
  loadSkipTimes(ep) {
    this.skip = null;
    fetch(`/api/skip/${this.meta.anilistId}/${ep}`).then((r) => r.ok ? r.json() : {}).then((s) => {
      if (this.ep === String(ep)) this.skip = s;
    }).catch(() => {
    });
  },
  // The interval (op or ed) the playhead is currently inside, if any.
  _skipInterval() {
    var _a;
    const t = this.curT();
    for (const type of ["op", "ed"]) {
      const iv = (_a = this.skip) == null ? void 0 : _a[type];
      if (iv && t >= iv.start && t < iv.end - 1) return { ...iv, type };
    }
    return null;
  },
  // ---- up next (next episode, or next season when the season ends) ----
  nextSeason() {
    var _a;
    const seasons = ((_a = detail == null ? void 0 : detail.franchise) == null ? void 0 : _a.seasons) || [];
    const i = seasons.findIndex((s) => s.anilistId === this.meta.anilistId);
    return i >= 0 && i < seasons.length - 1 ? seasons[i + 1] : null;
  },
  showUpNext(label, title, action) {
    $("#upNext .up-next-label").textContent = label;
    $("#upNextTitle").textContent = title;
    this._upNextAction = action;
    $("#upNext").hidden = false;
    let t = 0;
    const dur = 8e3;
    clearInterval(this.upNextTimer);
    this.upNextTimer = setInterval(() => {
      t += 100;
      $("#upNextFill").style.width = t / dur * 100 + "%";
      if (t >= dur) {
        this.hideUpNext();
        action();
      }
    }, 100);
  },
  playNextSeason() {
    const s = this.nextSeason();
    if (s) nav(`/watch/${s.anilistId}/first?mode=${this.mode}`, true);
  },
  hideUpNext() {
    clearInterval(this.upNextTimer);
    $("#upNext").hidden = true;
    $("#upNextFill").style.width = "0%";
  },
  // ---- Casting. One button dispatches to whichever protocol the browser
  // supports, in order of richness:
  //   1. Google Cast  — Chromecast / Google TV / Android TV (Chrome, Edge).
  //      Uses a RemotePlayer; `this.casting` gates the remote-control model.
  //   2. AirPlay      — Apple TV + AirPlay-2 TVs incl. Samsung/LG 2018+ (Safari).
  //   3. Remote Playback API — the standards-based fallback (Chrome & others).
  // AirPlay and Remote Playback keep playing through the <video> element and
  // mirror to the device, so the existing local controls just work and
  // `this.casting` stays false for them. Samsung TVs do NOT support Google
  // Cast — reach them via AirPlay or the Tizen app, never a Chromecast session.
  casting: false,
  // true only during a Google Cast session (RemotePlayer model)
  // Runs once when the player first opens: reveal the button (always visible so
  // it never looks broken) and wire the video-element remotes. Google Cast is
  // wired separately by initCast() if/when its SDK finishes loading.
  armCast() {
    const b = $("#pCast");
    b.hidden = false;
    b.innerHTML = ICON_CAST;
    b.onclick = () => this.toggleCast();
    this._castAvail = this._castAvail || { google: false, airplay: false, remote: false };
    const v = this.video;
    if (typeof v.webkitShowPlaybackTargetPicker === "function") {
      this._airplay = true;
      v.addEventListener("webkitplaybacktargetavailabilitychanged", (e) => {
        this._castAvail.airplay = e.availability === "available";
        this._updateCastAvailability();
      });
      v.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", () => {
        const on = v.webkitCurrentPlaybackTargetIsWireless;
        this._setCastBtn(on, on ? "AirPlay \u2014 click for the picker" : "Cast to TV");
      });
    }
    if (v.remote && typeof v.remote.prompt === "function") {
      this._remotePlayback = true;
      try {
        v.remote.addEventListener("connect", () => this._setCastBtn(true, "Casting \u2014 click to stop"));
        v.remote.addEventListener("disconnect", () => this._setCastBtn(false, "Cast to TV"));
      } catch {
      }
      try {
        v.remote.watchAvailability((available) => {
          this._castAvail.remote = available;
          this._updateCastAvailability();
        }).catch(() => {
        });
      } catch {
      }
    }
    this._updateCastAvailability();
  },
  // Grey the button out unless at least one protocol reports a reachable device
  // (or we're mid-cast, so Stop stays clickable). A disabled <button> ignores
  // clicks, so "clickable only when a device is present" falls out for free.
  _updateCastAvailability() {
    const b = $("#pCast");
    if (!b) return;
    const a = this._castAvail || {};
    const active = this.casting || b.classList.contains("on");
    const any = a.google || a.airplay || a.remote || active;
    b.disabled = !any;
    if (!active) b.title = any ? "Cast to TV" : "No cast device found";
  },
  _setCastBtn(active, title) {
    const b = $("#pCast");
    b.innerHTML = active ? ICON_CAST_ON : ICON_CAST;
    b.classList.toggle("on", active);
    b.title = title || (active ? "Casting \u2014 click to stop" : "Cast to TV");
    this._updateCastAvailability();
  },
  // Google Cast SDK ready (Chrome/Edge). Sets up the RemotePlayer control model.
  initCast() {
    const ctx = cast.framework.CastContext.getInstance();
    ctx.setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    });
    this._googleCast = true;
    this.castPlayer = new cast.framework.RemotePlayer();
    this.castCtl = new cast.framework.RemotePlayerController(this.castPlayer);
    const E = cast.framework.RemotePlayerEventType;
    this.castCtl.addEventListener(E.IS_CONNECTED_CHANGED, () => this._onCastConnected());
    this.castCtl.addEventListener(E.CURRENT_TIME_CHANGED, () => {
      if (this.casting) {
        this._lastCastTime = this.castPlayer.currentTime;
        this.syncScrub();
      }
    });
    this.castCtl.addEventListener(E.DURATION_CHANGED, () => {
      if (this.casting) this.syncScrub();
    });
    this.castCtl.addEventListener(E.IS_PAUSED_CHANGED, () => {
      var _a;
      this.syncPlayIcon();
      if (this.casting) (_a = this._report) == null ? void 0 : _a.call(this, false);
    });
    this.castCtl.addEventListener(E.PLAYER_STATE_CHANGED, () => this._onCastState());
    this.castCtl.addEventListener(E.VOLUME_LEVEL_CHANGED, () => this.syncVol());
    this.castCtl.addEventListener(E.IS_MUTED_CHANGED, () => this.syncVol());
    this._castAvail = this._castAvail || { google: false, airplay: false, remote: false };
    const noDev = cast.framework.CastState.NO_DEVICES_AVAILABLE;
    ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, (e) => {
      this._castAvail.google = e.castState !== noDev;
      this._updateCastAvailability();
    });
    this._castAvail.google = ctx.getCastState() !== noDev;
    if (this.el.classList.contains("show") && $("#pCast").hidden) this.armCast();
    this._updateCastAvailability();
  },
  _castDeviceName() {
    var _a, _b;
    return ((_b = (_a = cast.framework.CastContext.getInstance().getCurrentSession()) == null ? void 0 : _a.getCastDevice()) == null ? void 0 : _b.friendlyName) || "TV";
  },
  // Dispatch a click to the best available protocol. Google Cast has an explicit
  // stop; AirPlay/Remote Playback re-open their own picker (which offers stop).
  toggleCast() {
    const v = this.video;
    if (this._googleCast) {
      const ctx = cast.framework.CastContext.getInstance();
      if (this.casting) {
        ctx.endCurrentSession(true);
        return;
      }
      ctx.requestSession().catch(() => {
      });
      return;
    }
    if (this._airplay) {
      try {
        v.webkitShowPlaybackTargetPicker();
      } catch {
      }
      return;
    }
    if (this._remotePlayback) {
      v.remote.prompt().catch(() => {
      });
      return;
    }
    this.showStatus("Casting isn't available in this browser. Use Chrome or Edge for Chromecast/Google TV, or Safari for AirPlay (Apple TV and Samsung/LG 2018+).", false);
  },
  _onCastConnected() {
    var _a, _b, _c, _d;
    const was = this.casting;
    this.casting = !!this.castPlayer.isConnected;
    this._setCastBtn(this.casting, this.casting ? `Casting to ${this._castDeviceName()} \u2014 click to stop` : "Cast to TV");
    if (this.casting && !was && this.el.classList.contains("show") && this.quality) {
      this.castLoad(this.video.currentTime || this.resumeAt || 0);
    } else if (!this.casting && was) {
      const at = ((_c = (_b = (_a = this.castPlayer.savedPlayerState) == null ? void 0 : _a.currentTime) != null ? _b : this._lastCastTime) != null ? _c : 0) + (Number((_d = this.quality) == null ? void 0 : _d.seekBase) || 0);
      this.clearStatus();
      if (this.el.classList.contains("show") && this.quality) this.loadQuality(this.quality, at, true);
    }
    this.syncPlayIcon();
    this.syncVol();
    this.poke();
  },
  castLoad(at = 0) {
    const s = this.quality;
    const session = cast.framework.CastContext.getInstance().getCurrentSession();
    if (!s || !session) return;
    const url = new URL(media(s.playUrl), location.href).href;
    const mi = new chrome.cast.media.MediaInfo(url, s.type === "hls" ? "application/x-mpegurl" : "video/mp4");
    mi.streamType = chrome.cast.media.StreamType.BUFFERED;
    mi.metadata = new chrome.cast.media.GenericMediaMetadata();
    mi.metadata.title = `${this.meta.title} \u2014 Episode ${this.ep}`;
    if (this.meta.cover) mi.metadata.images = [new chrome.cast.Image(this.meta.cover)];
    const req = new chrome.cast.media.LoadRequest(mi);
    req.currentTime = at;
    req.autoplay = true;
    this.video.pause();
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.removeAttribute("src");
    this.video.load();
    this.showStatus(`Casting to ${this._castDeviceName()}`, true);
    session.loadMedia(req).then(() => this.showStatus(`Playing on ${this._castDeviceName()}`, false)).catch(() => this.showStatus("Cast failed \u2014 try another quality or source.", false));
    this.startProgress();
  },
  _onCastState() {
    var _a, _b, _c;
    this.syncPlayIcon();
    if (!this.casting || !this.el.classList.contains("show")) return;
    const state = this.castPlayer.playerState;
    if (state === "BUFFERING") {
      $("#pSpinner").hidden = false;
      return;
    }
    $("#pSpinner").hidden = true;
    if (state === "PLAYING") this.showStatus(`Playing on ${this._castDeviceName()}`, false);
    if (state === "IDLE") {
      const reason = (_b = (_a = cast.framework.CastContext.getInstance().getCurrentSession()) == null ? void 0 : _a.getMediaSession()) == null ? void 0 : _b.idleReason;
      if (reason !== "FINISHED") return;
      if (this.movieMode) {
        const n = (_c = this._streamNav) == null ? void 0 : _c.next;
        if (n) this.showUpNext("Next episode", n.label, () => nav(n.path, true));
        else this.showStatus(this._streamNav ? "End of available episodes." : "Movie ended.", false);
        return;
      }
      if (this.hasNext()) this.showUpNext("Next episode", `Episode ${this.episodes[this.idx() + 1]}`, () => this.next());
      else if (this.nextSeason()) this.showUpNext("Next season", this.nextSeason().title, () => this.playNextSeason());
      else this.showStatus("End of available episodes.", false);
    }
  },
  // Current time / duration / seek that follow whichever screen is playing.
  // Virtual for live sessions: time is shifted by the session's start offset
  // and duration is the real runtime, so the scrubber covers the whole film
  // rather than the encoder's progress. Casting stays on the TV's own clock.
  curT() {
    return this.casting ? this.castPlayer.currentTime || 0 : this.video.currentTime + (this.tShift || 0);
  },
  durT() {
    return this.casting ? this.castPlayer.duration || 0 : this.fullDur || this.video.duration;
  },
  seekTo(t) {
    var _a;
    if (this.casting) {
      this.castPlayer.currentTime = t;
      this.castCtl.seek();
      return;
    }
    const v = this.video;
    const rel = t - (this.tShift || 0);
    const end = ((_a = v.seekable) == null ? void 0 : _a.length) ? v.seekable.end(v.seekable.length - 1) : v.duration || 0;
    if (!this._streamIsSession(this.quality) || rel >= 0 && rel <= end) {
      v.currentTime = Math.max(0, rel);
      return;
    }
    this._jumpTo(t);
  },
  // User-initiated back (button / Esc / TV remote): tear down, then walk
  // history — or rewrite to the title page when this was a deep link.
  close() {
    var _a;
    const id = (_a = this.meta) == null ? void 0 : _a.anilistId;
    const back = this.movieMode ? this._backPath || "/" : id ? "/title/" + id : "/";
    this.hide();
    goBack(back);
  },
  // Router-driven teardown — pure DOM/media cleanup, never touches history.
  hide() {
    if (!this.el.classList.contains("show")) return;
    this._closing = true;
    this.cancelUpgrade();
    this.cancelDebridDownload();
    clearTimeout(this._subRefreshTimer);
    this._subRefreshTimer = null;
    if (this._report) this._report(true);
    if (this.casting) {
      this.casting = false;
      try {
        cast.framework.CastContext.getInstance().endCurrentSession(false);
      } catch {
      }
    }
    this._setCastBtn(false, "Cast to TV");
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    clearInterval(this.progressTimer);
    clearInterval(this.upNextTimer);
    clearTimeout(this.hideTimer);
    clearTimeout(this._altsTimer);
    this.hideUpNext();
    this.hideMenus();
    this.closeDrawer();
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.el.classList.remove("show", "controls-hidden", "hide-cursor");
    if (!$("#detail").classList.contains("show")) document.body.style.overflow = "";
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {
    });
    this._track = null;
    if (this.movieMode) {
      this.movieMode = false;
      this._toggleMovieChrome(false);
    }
    BROWSE.at = 0;
  },
  bindOnce() {
    if (this._bound) return;
    this._bound = true;
    const v = this.video, el = this.el;
    this.armCast();
    $("#pPlay").innerHTML = ICON_PLAY;
    $("#pBack10").innerHTML = ICON_BACK10;
    $("#pFwd10").innerHTML = ICON_FWD10;
    $("#pPrev").innerHTML = ICON_PREV;
    $("#pNext").innerHTML = ICON_NEXT;
    $("#pBack").innerHTML = ICON_BACK;
    $("#pGear").innerHTML = ICON_GEAR;
    $("#pAud").innerHTML = ICON_AUDIO;
    $("#pCc").innerHTML = ICON_CC;
    $("#pEps").innerHTML = ICON_LIST + "<span>Episodes</span>";
    $("#pPip").innerHTML = ICON_PIP;
    $("#pFs").innerHTML = ICON_FS;
    $("#pPlay").onclick = () => this.togglePlay();
    $("#pBack10").onclick = () => this.nudge(-10);
    $("#pFwd10").onclick = () => this.nudge(10);
    $("#pPrev").onclick = () => this.prev();
    $("#pNext").onclick = () => this.next();
    $("#pBack").onclick = () => this.close();
    $("#pGear").onclick = () => this.toggleMenu("#settingsMenu", "#pGear");
    $("#pAud").onclick = () => this.toggleMenu("#audMenu", "#pAud");
    $("#pCc").onclick = () => this.toggleMenu("#ccMenu", "#pCc");
    $("#pEps").onclick = () => this.openDrawer();
    $("#epsDrawerClose").onclick = () => this.closeDrawer("#epsDrawer");
    $("#pFs").onclick = () => this.toggleFs();
    $("#pPip").onclick = () => {
      var _a;
      if (document.pictureInPictureElement) document.exitPictureInPicture();
      else (_a = v.requestPictureInPicture) == null ? void 0 : _a.call(v).catch(() => {
      });
    };
    $("#pMute").onclick = () => {
      if (this.casting) {
        this.castCtl.muteOrUnmute();
        return;
      }
      v.muted = !v.muted;
      if (!v.muted && v.volume === 0) v.volume = 0.5;
      this.syncVol();
    };
    $("#pVol").oninput = (e) => {
      if (this.casting) {
        this.castPlayer.volumeLevel = +e.target.value;
        this.castCtl.setVolumeLevel();
        return;
      }
      v.volume = +e.target.value;
      v.muted = v.volume === 0;
      this.syncVol();
    };
    $("#upNextPlay").onclick = () => {
      var _a;
      this.hideUpNext();
      (_a = this._upNextAction) == null ? void 0 : _a.call(this);
    };
    $("#upNextCancel").onclick = () => this.hideUpNext();
    $("#pSkip").onclick = () => {
      const sk = this._skipInterval();
      if (sk) this.seekTo(Math.min(this.durT() || sk.end, sk.end));
    };
    document.addEventListener("fullscreenchange", () => $("#pFs").innerHTML = document.fullscreenElement ? ICON_FS_EXIT : ICON_FS);
    document.querySelectorAll("#settingsMenu [data-goto]").forEach((b) => b.onclick = () => {
      if (b.dataset.goto === "servers") this.showServersSub();
      else this.gotoSub(b.dataset.goto);
    });
    v.addEventListener("play", () => {
      this.syncPlayIcon();
      this.clearStatus();
      this.poke();
    });
    v.addEventListener("pause", () => {
      var _a;
      this.syncPlayIcon();
      this.poke();
      (_a = this._report) == null ? void 0 : _a.call(this, false);
    });
    v.addEventListener("waiting", () => {
      if (this.el.classList.contains("show")) $("#pSpinner").hidden = false;
    });
    v.addEventListener("seeking", () => {
      if (this.el.classList.contains("show")) $("#pSpinner").hidden = false;
    });
    v.addEventListener("seeked", () => $("#pSpinner").hidden = true);
    v.addEventListener("canplay", () => $("#pSpinner").hidden = true);
    v.addEventListener("playing", () => this.clearStatus());
    v.addEventListener("timeupdate", () => this.syncScrub());
    v.addEventListener("progress", () => this.syncBuffered());
    v.addEventListener("ended", () => {
      var _a;
      if (this.movieMode) {
        const n = (_a = this._streamNav) == null ? void 0 : _a.next;
        if (n) return this.showUpNext("Next episode", n.label, () => nav(n.path, true));
        return this.showStatus(this._streamNav ? "End of available episodes." : "Movie ended.", false);
      }
      if (this.hasNext()) this.showUpNext("Next episode", `Episode ${this.episodes[this.idx() + 1]}`, () => this.next());
      else if (this.nextSeason()) this.showUpNext("Next season", this.nextSeason().title, () => this.playNextSeason());
      else this.showStatus("End of available episodes.", false);
    });
    v.addEventListener("error", () => {
      if (!this._closing && this.el.classList.contains("show") && v.currentSrc) this._onStreamError();
    });
    v.addEventListener("volumechange", () => this.syncVol());
    const scrub = $("#scrub");
    const ratioAt = (clientX) => {
      const r = $("#scrub .scrub-track").getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    };
    const showTip = (clientX, ratio) => {
      const r = scrub.getBoundingClientRect();
      const tip = $("#scrubTip");
      tip.hidden = false;
      tip.textContent = fmt(ratio * (this.durT() || 0));
      tip.style.left = Math.max(0, Math.min(r.width, clientX - r.left)) + "px";
    };
    const previewTo = (ratio) => {
      const pct = ratio * 100;
      $("#scrubPlayed").style.width = pct + "%";
      $("#scrubKnob").style.left = pct + "%";
      $("#pCur").textContent = fmt(ratio * (this.durT() || 0));
    };
    scrub.addEventListener("pointerdown", (e) => {
      if (!this.durT()) return;
      this._dragging = true;
      scrub.classList.add("scrubbing");
      try {
        scrub.setPointerCapture(e.pointerId);
      } catch {
      }
      const ratio = ratioAt(e.clientX);
      previewTo(ratio);
      showTip(e.clientX, ratio);
      e.preventDefault();
    });
    scrub.addEventListener("pointermove", (e) => {
      if (!this.durT()) return;
      const ratio = ratioAt(e.clientX);
      showTip(e.clientX, ratio);
      if (this._dragging) previewTo(ratio);
    });
    const endDrag = (e) => {
      if (!this._dragging) return;
      this._dragging = false;
      scrub.classList.remove("scrubbing");
      this.seekTo(ratioAt(e.clientX) * this.durT());
    };
    scrub.addEventListener("pointerup", endDrag);
    scrub.addEventListener("pointercancel", () => {
      this._dragging = false;
      scrub.classList.remove("scrubbing");
    });
    scrub.addEventListener("mouseleave", () => {
      if (!this._dragging) $("#scrubTip").hidden = true;
    });
    let clickTimer = null;
    el.addEventListener("mousemove", () => this.poke());
    el.addEventListener("touchstart", () => {
      this._touchWasHidden = el.classList.contains("controls-hidden");
    }, { passive: true });
    el.addEventListener("click", (e) => {
      const onVideo = e.target === v || e.target === $("#pCenter");
      if (onVideo) {
        if (this._touchWasHidden) {
          this._touchWasHidden = false;
          this.poke();
          return;
        }
        this.hideMenus();
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
        } else clickTimer = setTimeout(() => {
          this.togglePlay();
          clickTimer = null;
        }, 220);
      } else if (!e.target.closest(".p-menu") && !e.target.closest(".p-drawer") && !e.target.closest(".up-next") && !e.target.closest(".p-bottom") && !e.target.closest(".p-top")) this.hideMenus();
    });
    v.addEventListener("dblclick", () => {
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      this.toggleFs();
    });
    document.addEventListener("keydown", (e) => {
      if (!el.classList.contains("show")) return;
      if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          this.togglePlay();
          break;
        case "ArrowRight":
        case "l":
          this.nudge(10);
          break;
        case "ArrowLeft":
        case "j":
          this.nudge(-10);
          break;
        case "ArrowUp":
          e.preventDefault();
          v.muted = false;
          v.volume = Math.min(1, v.volume + 0.1);
          this.syncVol();
          this.poke();
          break;
        case "ArrowDown":
          e.preventDefault();
          v.volume = Math.max(0, v.volume - 0.1);
          this.syncVol();
          this.poke();
          break;
        case "f":
          this.toggleFs();
          break;
        case "m":
          v.muted = !v.muted;
          if (!v.muted && v.volume === 0) v.volume = 0.5;
          this.syncVol();
          break;
        case "n":
          this.next();
          break;
        case "p":
          this.prev();
          break;
        case "c":
          this.toggleMenu("#ccMenu", "#pCc");
          break;
        case "s":
          this.serversOpen() ? this.closeServers() : this.openServers();
          break;
        case "Escape":
          if (document.fullscreenElement) document.exitFullscreen().catch(() => {
          });
          else if (this._menuOpen()) {
            this.hideMenus();
            this.closeDrawer();
          } else this.close();
          break;
      }
    });
    this.syncVol();
  },
  togglePlay() {
    if (this.casting) {
      this.castCtl.playOrPause();
      return;
    }
    const v = this.video;
    if (v.paused) this._attemptPlay();
    else {
      v.pause();
      this.syncPlayIcon();
    }
  },
  // Relative seek with a readable confirmation. On a TV the scrubber is metres
  // away and four pixels tall, so a jump that only moves the played bar reads
  // as "nothing happened" — the flash is what makes the seek land.
  nudge(delta) {
    const dur = this.durT() || 0;
    const to = Math.max(0, dur ? Math.min(dur - 1, this.curT() + delta) : this.curT() + delta);
    this.seekTo(to);
    this.poke();
    const osd = $("#pSeekOsd");
    if (osd) {
      osd.textContent = `${delta < 0 ? "\u25C0\u25C0" : "\u25B6\u25B6"} ${delta > 0 ? "+" : "\u2212"}${Math.abs(delta)}s \xB7 ${fmt(to)}`;
      osd.hidden = false;
      clearTimeout(this._seekOsdTimer);
      this._seekOsdTimer = setTimeout(() => {
        osd.hidden = true;
      }, 900);
    }
    if (dur) {
      const pct = to / dur * 100;
      $("#scrubPlayed").style.width = pct + "%";
      $("#scrubKnob").style.left = pct + "%";
      $("#pCur").textContent = fmt(to);
    }
  },
  toggleFs() {
    var _a, _b;
    if (document.fullscreenElement) document.exitFullscreen();
    else (_b = (_a = this.el).requestFullscreen) == null ? void 0 : _b.call(_a).catch(() => {
    });
  },
  syncVol() {
    var _a;
    const muted = this.casting ? this.castPlayer.isMuted : this.video.muted;
    const vol = this.casting ? (_a = this.castPlayer.volumeLevel) != null ? _a : 1 : this.video.volume;
    $("#pVol").value = muted ? 0 : vol;
    $("#pMute").innerHTML = muted || vol === 0 ? ICON_VOL_MUTE : vol < 0.5 ? ICON_VOL_LOW : ICON_VOL_HIGH;
  },
  syncScrub() {
    const dur = this.durT();
    if (!dur) return;
    $("#pDur").textContent = fmt(dur);
    const sk = this._skipInterval();
    $("#pSkip").hidden = !sk;
    if (sk) $("#pSkip").textContent = sk.type === "ed" ? "Skip Outro" : "Skip Intro";
    if (this._dragging) return;
    const pct = this.curT() / dur * 100;
    $("#scrubPlayed").style.width = pct + "%";
    $("#scrubKnob").style.left = pct + "%";
    $("#pCur").textContent = fmt(this.curT());
  },
  syncBuffered() {
    const v = this.video, dur = this.durT();
    if (!dur || !v.buffered.length) return;
    const shift = this.tShift || 0;
    const el = $("#scrubBuffered");
    el.style.left = (shift + v.buffered.start(0)) / dur * 100 + "%";
    el.style.width = (v.buffered.end(v.buffered.length - 1) - v.buffered.start(0)) / dur * 100 + "%";
  }
};
function launchPlayer(ep) {
  if (!detail) return;
  nav(`/watch/${detail.meta.anilistId}/${encodeURIComponent(ep)}?mode=${detailMode}`);
}
async function showPlayer(anilistId, ep, mode) {
  if (!detail || detail.meta.anilistId !== anilistId) {
    const ok = await loadTitleData(anilistId);
    if (!ok) {
      nav("/", true);
      return;
    }
  }
  detailMode = mode === "dub" && detail.hasDub ? "dub" : "sub";
  const eps = detailMode === "dub" ? detail.dubEpisodes : detail.episodes;
  let target = ep === "first" ? eps[0] : String(ep);
  if (!eps.includes(target)) target = eps[0];
  if (!target) {
    nav("/title/" + anilistId, true);
    return;
  }
  Player.launch(target);
}
async function loadTitleData(anilistId) {
  const cached = TITLE_CACHE.get(anilistId);
  if (cached && Date.now() - cached._at < 6e4) {
    detail = cached;
    return true;
  }
  try {
    const res = await fetch("/api/title/" + anilistId);
    if (!res.ok) return false;
    const fresh = await res.json();
    fresh._at = Date.now();
    fresh.epMeta = null;
    TITLE_CACHE.set(anilistId, fresh);
    detail = fresh;
    return true;
  } catch {
    return false;
  }
}
function gridView(heading, items) {
  const body = items.length ? `<div class="cards-grid">${items.map(cardHtml).join("")}</div>` : `<div class="grid-empty">Nothing here.</div>`;
  return `<div class="rows"><div class="row"><h2>${heading}</h2>${body}</div></div>`;
}
document.querySelector(".nav-search-wrap").addEventListener("click", () => {
  if (document.body.classList.contains("search-open")) return;
  if (!matchMedia("(max-width: 720px)").matches) return;
  document.body.classList.add("search-open");
  $("#search").focus();
});
$("#search").addEventListener("blur", () => {
  if (!$("#search").value.trim()) document.body.classList.remove("search-open");
});
let searchTimer = null;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) {
    if (APP_VIEW === "search") {
      history.replaceState(history.state, "", "/");
      document.title = appName();
      renderHome();
    }
    return;
  }
  searchTimer = setTimeout(() => runSearch(q), 350);
});
async function runSearch(q) {
  history.replaceState(history.state, "", "/?q=" + encodeURIComponent(q));
  APP_VIEW = "search";
  setActiveTab("home");
  document.title = `\u201C${q}\u201D \xB7 ${appName()}`;
  app.innerHTML = `<div class="rows">
    <div class="row"><h2>Results for \u201C${esc(q)}\u201D</h2></div>
    <div class="row" id="sr-anime"><div class="loading">Searching\u2026</div></div>
    <div class="row" id="sr-movies"></div>
    <div class="row" id="sr-tv"></div>
  </div>`;
  const alive = () => APP_VIEW === "search" && $("#search").value.trim() === q;
  const put = (sel, html) => {
    const el = $(sel);
    if (el && alive()) el.innerHTML = html;
  };
  const section = (label, cards) => `<h2>${label}</h2><div class="cards-grid">${cards}</div>`;
  const one = async (url, render) => {
    let items = [];
    try {
      items = (await (await fetch(url)).json()).items || [];
    } catch {
    }
    return render(items);
  };
  const enc = encodeURIComponent(q);
  await Promise.all([
    one("/api/search?q=" + enc, (items) => put("#sr-anime", items.length ? section("Anime", items.map(cardHtml).join("")) : "")),
    one("/api/movies/search?q=" + enc, (items) => {
      items.forEach((m) => MOVIE_CACHE.set(m.id, m));
      put("#sr-movies", items.length ? section("Movies", items.map((m) => mediaCardHtml(m, CATALOGS.movies.open(m))).join("")) : "");
    }),
    one("/api/tv/search?q=" + enc, (items) => {
      items.forEach((m) => TV_CACHE.set(m.id, m));
      put("#sr-tv", items.length ? section("TV Shows", items.map((m) => mediaCardHtml(m, CATALOGS.tv.open(m))).join("")) : "");
    })
  ]);
  if (!alive()) return;
  if (!["#sr-anime", "#sr-movies", "#sr-tv"].some((s) => {
    var _a;
    return (_a = $(s)) == null ? void 0 : _a.innerHTML.trim();
  }))
    put("#sr-anime", `<div class="grid-empty">Nothing matches \u201C${esc(q)}\u201D in anime, movies or TV shows.</div>`);
}
const ANIME_CACHE = /* @__PURE__ */ new Map();
const MOVIE_CACHE = /* @__PURE__ */ new Map();
const TV_CACHE = /* @__PURE__ */ new Map();
const CATALOGS = {
  anime: {
    title: "Anime",
    api: "/api/anime",
    path: "/browse?type=anime",
    cache: ANIME_CACHE,
    key: (m) => m.anilistId,
    card: (m) => cardHtml(m),
    open: (m) => `openTitle(${m.anilistId})`,
    disabled: `Anime is unavailable right now \u2014 AniList couldn't be reached.`
  },
  movies: {
    title: "Movies",
    api: "/api/movies",
    path: "/browse?type=movies",
    cache: MOVIE_CACHE,
    key: (m) => m.id,
    card: (m) => mediaCardHtml(m, `openMovie('${esc(m.id)}')`),
    open: (m) => `openMovie('${esc(m.id)}')`,
    disabled: `Movies are off \u2014 set a <code>REAL_DEBRID_TOKEN</code> to enable them.`
  },
  tv: {
    title: "TV Shows",
    api: "/api/tv",
    path: "/browse?type=tv",
    cache: TV_CACHE,
    key: (m) => m.id,
    card: (m) => mediaCardHtml(m, `openTvShow('${esc(m.id)}')`),
    open: (m) => `openTvShow('${esc(m.id)}')`,
    disabled: `TV Shows are unavailable right now \u2014 the catalog addon couldn't be reached.`
  }
};
const BROWSE_TYPES = [
  { id: "all", label: "All" },
  { id: "anime", label: "Anime" },
  { id: "movies", label: "Movies" },
  { id: "tv", label: "TV Shows" }
];
const CAT = {
  anime: { items: null, meta: null, hasMore: false, nextSkip: 0, off: false },
  movies: { items: null, meta: null, hasMore: false, nextSkip: 0, off: false },
  tv: { items: null, meta: null, hasMore: false, nextSkip: 0, off: false }
};
let BR = { filters: {}, sig: null, at: 0 };
const browseKinds = (type) => type === "all" ? ["anime", "movies", "tv"] : [type];
function browseFiltersFromQs(qs) {
  const type = BROWSE_TYPES.some((t) => t.id === qs.get("type")) ? qs.get("type") : "all";
  return {
    type,
    genre: qs.get("genre") || null,
    sort: qs.get("sort") || "popular",
    year: Number(qs.get("year")) || null
  };
}
function browsePath(f) {
  const p = new URLSearchParams();
  if (f.type && f.type !== "all") p.set("type", f.type);
  if (f.genre) p.set("genre", f.genre);
  if (f.sort && f.sort !== "popular") p.set("sort", f.sort);
  if (f.year) p.set("year", f.year);
  const s = p.toString();
  return "/browse" + (s ? "?" + s : "");
}
function catQuery(f, skip = 0) {
  const p = new URLSearchParams();
  if (f.genre) p.set("genre", f.genre);
  if (f.sort && f.sort !== "popular") p.set("sort", f.sort);
  if (f.year) p.set("year", f.year);
  if (skip) p.set("skip", skip);
  const s = p.toString();
  return s ? "?" + s : "";
}
function setBrowseFilters(patch) {
  const f = { ...BR.filters, ...patch };
  if (patch.year) f.sort = "new";
  if (patch.sort && patch.sort !== "new") f.year = null;
  if (patch.type && f.genre && !browseGenres(f.type).includes(f.genre)) f.genre = null;
  nav(browsePath(f));
}
function setBrowseType(type) {
  setBrowseFilters({ type });
}
function setBrowseSort(sort) {
  setBrowseFilters({ sort });
}
function resetBrowseFilters() {
  nav(browsePath({ type: BR.filters.type }));
}
function browseGenres(type) {
  const metas = browseKinds(type).map((k) => CAT[k].meta).filter(Boolean);
  if (!metas.length) return [];
  return metas.reduce((acc, m) => acc.filter((g) => m.genres.includes(g)), metas[0].genres.slice());
}
async function renderBrowse(filters) {
  const wasHere = APP_VIEW === "browse";
  const sig = JSON.stringify([filters.type, filters.genre, filters.sort || "popular", filters.year]);
  APP_VIEW = "browse";
  document.title = `Browse \xB7 ${appName()}`;
  $("#search").value = "";
  BR.filters = filters;
  document.body.dataset.lib = filters.type;
  if (!wasHere || !$("#catGrid")) {
    app.innerHTML = `<div class="rows"><div class="row">
      <h2>Browse</h2>
      <div class="mode-pills browse-types" id="catTypes" role="group" aria-label="Library"></div>
      <div class="filter-bar" id="catBar"></div>
      <div id="catGrid" class="cards-grid"><div class="grid-empty">Loading\u2026</div></div>
      <div class="cat-foot" id="catFoot"></div>
    </div></div>`;
    window.scrollTo(0, 0);
  }
  renderBrowseTypes();
  renderCatBar();
  if (BR.sig === sig && browseKinds(filters.type).some((k) => CAT[k].items)) {
    paintBrowse();
    if (Date.now() - BR.at < 3e4) return;
  } else {
    BR.sig = sig;
    for (const k of Object.keys(CAT)) CAT[k].items = null;
    setCatGrid(`<div class="grid-empty">Loading\u2026</div>`);
    const foot = $("#catFoot");
    if (foot) foot.innerHTML = "";
  }
  const kinds = browseKinds(filters.type);
  await Promise.all(kinds.map(async (kind) => {
    const st = CAT[kind];
    let data = null;
    try {
      data = await (await fetch(CATALOGS[kind].api + catQuery(filters))).json();
    } catch {
    }
    if (APP_VIEW !== "browse" || BR.sig !== sig) return;
    if (!data || data.enabled === false) {
      st.off = true;
      st.items = [];
      st.hasMore = false;
    } else {
      st.off = false;
      st.items = data.items || [];
      st.meta = data.filters || st.meta;
      st.hasMore = !!data.hasMore;
      st.nextSkip = data.nextSkip || 0;
      st.items.forEach((m) => CATALOGS[kind].cache.set(CATALOGS[kind].key(m), m));
    }
    BR.at = Date.now();
    if ($("#search").value.trim()) return;
    renderCatBar();
    paintBrowse();
  }));
}
function setCatGrid(html) {
  const g = $("#catGrid");
  if (g) g.innerHTML = html;
}
function renderBrowseTypes() {
  const box = $("#catTypes");
  if (!box) return;
  const cur = BR.filters.type || "all";
  box.innerHTML = BROWSE_TYPES.map((t) => `<button class="mode-pill ${cur === t.id ? "active" : ""}"
    aria-pressed="${cur === t.id}" onclick="setBrowseType('${t.id}')">${t.label}</button>`).join("");
}
function renderCatBar() {
  const f = BR.filters;
  const bar = $("#catBar");
  if (!bar) return;
  bar.hidden = false;
  const meta = browseKinds(f.type).map((k) => CAT[k].meta).find(Boolean);
  if (!meta) {
    bar.innerHTML = "";
    return;
  }
  const genres = browseGenres(f.type);
  const sort = f.sort || "popular";
  const active = f.genre || f.year || sort !== "popular";
  bar.innerHTML = `
    <div class="mode-pills" role="group" aria-label="Sort">
      ${meta.sorts.map((s) => `<button class="mode-pill ${sort === s.id ? "active" : ""}"
        aria-pressed="${sort === s.id}" onclick="setBrowseSort('${s.id}')">${s.label}</button>`).join("")}
    </div>
    <select class="season-select" id="catGenre" aria-label="Genre">
      <option value="">All genres</option>
      ${genres.map((g) => `<option value="${esc(g)}" ${f.genre === g ? "selected" : ""}>${esc(g)}</option>`).join("")}
    </select>
    <select class="season-select" id="catYear" aria-label="Year">
      <option value="">Any year</option>
      ${meta.years.map((y) => `<option value="${y}" ${f.year === y ? "selected" : ""}>${y}</option>`).join("")}
    </select>
    ${active ? `<button class="btn ghost mini" onclick="resetBrowseFilters()">Reset</button>` : ""}
    ${f.year ? `<span class="filter-note">A year always shows newest first</span>` : ""}`;
  $("#catGenre").onchange = (e) => setBrowseFilters({ genre: e.target.value || null });
  $("#catYear").onchange = (e) => setBrowseFilters({ year: Number(e.target.value) || null });
}
function interleave(lists) {
  const out = [];
  for (let i = 0; ; i++) {
    let took = false;
    for (const list of lists) if (i < list.length) {
      out.push(list[i]);
      took = true;
    }
    if (!took) return out;
  }
}
function browseCards() {
  const kinds = browseKinds(BR.filters.type).filter((k) => !CAT[k].off);
  return interleave(kinds.map((k) => (CAT[k].items || []).map((m) => CATALOGS[k].card(m))));
}
function paintBrowse() {
  const kinds = browseKinds(BR.filters.type);
  const cards = browseCards();
  if (cards.length) return setCatGrid(cards.join("")), renderCatFoot();
  const off = kinds.filter((k) => CAT[k].off);
  const loaded = kinds.every((k) => CAT[k].items);
  if (!loaded) return;
  setCatGrid(off.length === kinds.length ? off.map((k) => `<div class="grid-empty">${CATALOGS[k].disabled}</div>`).join("") : `<div class="grid-empty">Nothing matches these filters.
        <button class="btn ghost mini" onclick="resetBrowseFilters()">Reset filters</button></div>`);
  renderCatFoot();
}
function renderCatFoot() {
  const foot = $("#catFoot");
  if (!foot) return;
  foot.hidden = false;
  const more = browseKinds(BR.filters.type).some((k) => CAT[k].hasMore);
  foot.innerHTML = more ? `<button class="btn ghost" id="catMore" onclick="loadMoreBrowse()">Load more</button>` : "";
}
async function loadMoreBrowse() {
  const btn = $("#catMore");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Loading\u2026";
  }
  const sig = BR.sig;
  const kinds = browseKinds(BR.filters.type).filter((k) => CAT[k].hasMore);
  const added = await Promise.all(kinds.map(async (kind) => {
    const c = CATALOGS[kind], st = CAT[kind];
    let data = null;
    try {
      data = await (await fetch(c.api + catQuery(BR.filters, st.nextSkip))).json();
    } catch {
    }
    if (APP_VIEW !== "browse" || BR.sig !== sig) return [];
    if (!data || data.enabled === false) {
      st.hasMore = false;
      return [];
    }
    const seen = new Set((st.items || []).map((m) => c.key(m)));
    const fresh = (data.items || []).filter((m) => !seen.has(c.key(m)));
    fresh.forEach((m) => c.cache.set(c.key(m), m));
    st.items = (st.items || []).concat(fresh);
    st.hasMore = !!data.hasMore;
    st.nextSkip = data.nextSkip || 0;
    return fresh.map((m) => c.card(m));
  }));
  if (APP_VIEW !== "browse" || BR.sig !== sig) return;
  const g = $("#catGrid");
  const cards = interleave(added);
  if (g && cards.length) g.insertAdjacentHTML("beforeend", cards.join(""));
  renderCatFoot();
}
function mediaCardHtml(m, onclick) {
  const art = m.poster ? `<img loading="lazy" src="${m.poster}" alt="" />` : `<div class="movie-noart"><span>${esc(m.title)}</span></div>`;
  const sub = [m.year, m.rating ? m.rating + "%" : null].filter(Boolean).join(" \xB7 ");
  return `<div class="card movie-card" onclick="${onclick}">
    <div class="card-art">${art}
      ${m.rating ? `<span class="badge">${m.rating}%</span>` : ""}
      <div class="card-scrim"><div class="card-t">${esc(m.title)}</div>${sub ? `<div class="card-sub">${sub}</div>` : ""}</div>
    </div>
    <div class="cap">${esc(m.title)}</div>
  </div>`;
}
function openMovie(id) {
  nav("/movie/" + encodeURIComponent(id));
}
function playMovie(id) {
  nav("/moviewatch/" + encodeURIComponent(id));
}
function showMoviePlayer(id) {
  var _a, _b;
  Player.launchStream({
    endpoint: `/api/movie/${encodeURIComponent(id)}/stream`,
    subsUrl: `/api/movie/${encodeURIComponent(id)}/subs`,
    altsUrl: `/api/movie/${encodeURIComponent(id)}/alts`,
    serversUrl: `/api/movie/${encodeURIComponent(id)}/servers`,
    title: ((_a = MOVIE_CACHE.get(id)) == null ? void 0 : _a.title) || "Movie",
    sub: "Movie \xB7 via Real-Debrid",
    back: "/movie/" + encodeURIComponent(id),
    // back to the film's page, not the grid
    // The poster is whatever the catalog happened to cache; on a deep link
    // there is none, and the server repairs it from Cinemeta when the row is
    // next read (see continueWatchingFor).
    track: { kind: "movie", id, cover: ((_b = MOVIE_CACHE.get(id)) == null ? void 0 : _b.poster) || null }
  });
}
let mDetail = null;
let MDETAIL_KEY = null;
function openTvShow(id) {
  nav("/tv/" + encodeURIComponent(id));
}
function openTvEpisode(id, season, ep) {
  nav(`/tvwatch/${encodeURIComponent(id)}/${season}/${ep}`);
}
function hideMDetail() {
  MDETAIL_KEY = null;
  $("#mDetail").classList.remove("show");
  if (!$("#player").classList.contains("show")) document.body.style.overflow = "";
}
function closeMDetail() {
  goBack(browsePath({ type: (mDetail == null ? void 0 : mDetail.kind) === "movie" ? "movies" : "tv" }));
}
async function showMediaDetail(kind, id) {
  var _a, _b, _c;
  const key = `${kind}:${id}`;
  const isNew = MDETAIL_KEY !== key;
  MDETAIL_KEY = key;
  $("#mDetail").classList.add("show");
  document.body.style.overflow = "hidden";
  if (isNew) {
    $("#mDetail").scrollTop = 0;
    $("#m-title").textContent = "Loading\u2026";
    $("#m-meta").textContent = "";
    $("#m-genres").innerHTML = "";
    $("#m-desc").textContent = "";
    $("#m-facts").innerHTML = "";
    $("#m-eps").innerHTML = "";
    $("#m-note").textContent = "";
    $("#m-seasonList").innerHTML = "";
    $("#m-epsHead").hidden = true;
    $("#m-season").hidden = true;
    $("#mHeroBg").style.backgroundImage = "";
    $("#mHeroArt").style.backgroundImage = "";
    mDetail = null;
  }
  const cache = kind === "movie" ? MOVIE_CACHE : TV_CACHE;
  const url = kind === "movie" ? "/api/movie/" : "/api/tv/";
  let data = null;
  try {
    const res = await fetch(url + encodeURIComponent(id));
    if (res.ok) data = await res.json();
  } catch {
  }
  if (MDETAIL_KEY !== key) return;
  if (!data || data.error) {
    $("#m-title").textContent = ((_a = cache.get(id)) == null ? void 0 : _a.title) || "Unavailable";
    $("#m-note").textContent = "Couldn't load this one \u2014 it may have dropped out of the catalog.";
    return;
  }
  cache.set(id, { ...cache.get(id) || {}, ...data });
  const seasons = data.seasons || [];
  mDetail = { kind, id, data, season: (_c = (_b = seasons[0]) == null ? void 0 : _b.season) != null ? _c : null };
  paintMediaDetail();
}
function paintMediaDetail() {
  const { kind, id, data } = mDetail;
  const seasons = data.seasons || [];
  document.title = `${data.title} \xB7 ${appName()}`;
  const art = data.backdrop || data.poster || "";
  $("#mHero").classList.toggle("no-banner", !data.backdrop);
  $("#mHeroBg").style.backgroundImage = art ? `url('${art}')` : "";
  $("#mHeroArt").style.backgroundImage = data.backdrop ? "" : data.poster ? `url('${data.poster}')` : "";
  $("#m-title").textContent = data.title;
  const runtime = data.runtime ? `${data.runtime} min` : null;
  const seasonCount = seasons.length ? `${seasons.length} season${seasons.length === 1 ? "" : "s"}` : null;
  $("#m-meta").textContent = [
    kind === "movie" ? "Film" : "Series",
    data.year,
    kind === "movie" ? runtime : seasonCount,
    data.rating ? `${data.rating}%` : null
  ].filter(Boolean).join(" \xB7 ");
  $("#m-genres").innerHTML = (data.genres || []).slice(0, 6).map((g) => `<span>${esc(g)}</span>`).join("");
  $("#m-desc").textContent = data.overview || "";
  const facts = [
    ["Director", (data.director || []).join(", ")],
    ["Cast", (data.cast || []).slice(0, 6).join(", ")],
    ["Released", data.released ? fmtDate(data.released) || data.released : ""],
    [kind === "movie" ? "Runtime" : "Episode length", runtime || ""],
    ["Country", data.country || ""]
  ].filter(([, v]) => v);
  $("#m-facts").innerHTML = facts.map(([k, v]) => `<div class="fact"><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
  $("#mPlay").textContent = kind === "movie" ? "\u25B6 Play" : "\u25B6 Play S1 E1";
  $("#mPlay").hidden = data.playable === false;
  $("#m-note").textContent = data.playable === false ? "Playback needs a Real-Debrid token on the server." : kind === "movie" ? "Plays the best release Real-Debrid has cached. Pick another under Settings \u203A Server while watching, and the audio language under the headphones icon." : "";
  if (kind !== "tv" || !seasons.length) {
    $("#m-epsHead").hidden = true;
    $("#m-eps").innerHTML = "";
    $("#m-seasonList").innerHTML = "";
  }
  if (kind === "tv" && seasons.length) {
    $("#m-epsHead").hidden = false;
    const sel = $("#m-season");
    sel.innerHTML = seasons.map((s) => `<option value="${s.season}">${esc(s.name)} \xB7 ${s.episodes} ep</option>`).join("");
    sel.hidden = seasons.length < 2;
    sel.value = String(mDetail.season);
    sel.onchange = () => loadSeasonEps(id, +sel.value);
    const list = $("#m-seasonList");
    list.innerHTML = seasons.length < 2 ? "" : seasons.map((s) => `<button class="season-item" data-season="${s.season}">
        <span class="t">${esc(s.name)}</span><span class="s">${s.episodes} episodes</span>
      </button>`).join("");
    list.querySelectorAll(".season-item").forEach((b) => b.onclick = () => loadSeasonEps(id, +b.dataset.season));
    loadSeasonEps(id, mDetail.season);
  }
}
async function loadSeasonEps(id, season) {
  const key = MDETAIL_KEY;
  if (mDetail) mDetail.season = season;
  $("#mPlay").textContent = `\u25B6 Play S${season} E1`;
  const sel = $("#m-season");
  if (sel && +sel.value !== season) sel.value = String(season);
  document.querySelectorAll("#m-seasonList .season-item").forEach((b) => b.classList.toggle("active", +b.dataset.season === season));
  $("#m-eps").innerHTML = `<div class="grid-empty">Loading episodes\u2026</div>`;
  let eps = [];
  try {
    eps = (await (await fetch(`/api/tv/${encodeURIComponent(id)}/season/${season}`)).json()).episodes || [];
  } catch {
  }
  if (MDETAIL_KEY !== key) return;
  $("#m-eps").innerHTML = eps.length ? eps.map((e) => `
    <div class="ep-row" onclick="openTvEpisode('${esc(id)}', ${season}, ${e.ep})">
      <div class="ep-row-thumb ${e.still ? "" : "ph"}">
        ${e.still ? `<img loading="lazy" src="${e.still}" alt="" />` : ""}
        <span class="ep-row-badge">${e.ep}</span>
      </div>
      <div class="ep-row-body">
        <div class="ep-row-t">${e.ep}. ${esc(e.title)}</div>
        <div class="ep-row-date">${[e.airDate, esc((e.overview || "").slice(0, 80))].filter(Boolean).join(" \xB7 ")}</div>
      </div>
      <div class="ep-row-play">${ICON_PLAY}</div>
    </div>`).join("") : `<div class="grid-empty">No episodes listed for this season.</div>`;
}
$("#mDetailClose").addEventListener("click", closeMDetail);
$("#mPlay").addEventListener("click", () => {
  var _a;
  if (!mDetail) return;
  if (mDetail.kind === "movie") playMovie(mDetail.id);
  else openTvEpisode(mDetail.id, (_a = mDetail.season) != null ? _a : 1, 1);
});
document.addEventListener("keydown", (e) => {
  var _a;
  if (e.key !== "Escape") return;
  if (!$("#mDetail").classList.contains("show") || $("#player").classList.contains("show")) return;
  if (["INPUT", "TEXTAREA", "SELECT"].includes((_a = document.activeElement) == null ? void 0 : _a.tagName)) return;
  closeMDetail();
});
function showTvPlayer(id, season, ep) {
  var _a, _b, _c;
  const name = ((_a = TV_CACHE.get(id)) == null ? void 0 : _a.title) || "Episode";
  Player.launchStream({
    endpoint: `/api/tvshow/${encodeURIComponent(id)}/${encodeURIComponent(season)}/${encodeURIComponent(ep)}/stream`,
    subsUrl: `/api/tvshow/${encodeURIComponent(id)}/${encodeURIComponent(season)}/${encodeURIComponent(ep)}/subs`,
    altsUrl: `/api/tvshow/${encodeURIComponent(id)}/${encodeURIComponent(season)}/${encodeURIComponent(ep)}/alts`,
    serversUrl: `/api/tvshow/${encodeURIComponent(id)}/${encodeURIComponent(season)}/${encodeURIComponent(ep)}/servers`,
    title: `${name} \xB7 S${season} E${ep}`,
    sub: "TV \xB7 via Real-Debrid",
    back: `/tv/${encodeURIComponent(id)}`,
    // One row per SHOW, carrying the episode it stopped on — that is what makes
    // Continue Watching resume a series where it was left rather than listing
    // every episode ever started.
    track: {
      kind: "tv",
      id,
      season: Number(season),
      episode: Number(ep),
      // The SHOW's name and poster, not the player's "Show · S2 E4" heading —
      // the card renders the episode separately as a badge. Null on a deep
      // link, where the server repairs both from Cinemeta.
      title: ((_b = TV_CACHE.get(id)) == null ? void 0 : _b.title) || null,
      cover: ((_c = TV_CACHE.get(id)) == null ? void 0 : _c.poster) || null
    }
  });
  armTvPlayerNav(id, Number(season), Number(ep));
}
async function armTvPlayerNav(id, season, ep) {
  var _a, _b;
  const get = async (u) => {
    try {
      return await (await fetch(u)).json();
    } catch {
      return {};
    }
  };
  const here = () => location.pathname === `/tvwatch/${encodeURIComponent(id)}/${season}/${ep}`;
  const path = (s, e) => `/tvwatch/${encodeURIComponent(id)}/${s}/${e}`;
  const eps = (await get(`/api/tv/${encodeURIComponent(id)}/season/${season}`)).episodes || [];
  if (!here() || !Player.movieMode) return;
  const nums = new Set(eps.map((e) => e.ep));
  let prev = nums.has(ep - 1) ? { path: path(season, ep - 1), label: `Episode ${ep - 1}` } : null;
  let next = nums.has(ep + 1) ? { path: path(season, ep + 1), label: `Episode ${ep + 1}` } : null;
  if (!next || !prev) {
    const show = ((_a = TV_CACHE.get(id)) == null ? void 0 : _a.seasons) ? TV_CACHE.get(id) : await get(`/api/tv/${encodeURIComponent(id)}`);
    const seasons = (show.seasons || []).map((x) => x.season);
    if (!next && seasons.includes(season + 1))
      next = { path: path(season + 1, 1), label: `S${season + 1} \xB7 Episode 1` };
    if (!prev && seasons.includes(season - 1)) {
      const prevEps = (await get(`/api/tv/${encodeURIComponent(id)}/season/${season - 1}`)).episodes || [];
      const last = (_b = prevEps[prevEps.length - 1]) == null ? void 0 : _b.ep;
      if (last) prev = { path: path(season - 1, last), label: `S${season - 1} \xB7 Episode ${last}` };
    }
  }
  if (here() && Player.movieMode) Player.setStreamNav({ prev, next });
}
function openCategory(genre) {
  closeMenu();
  nav("/category/" + encodeURIComponent(genre));
}
async function renderCategory(genre) {
  const view = "cat:" + genre;
  APP_VIEW = view;
  document.title = genre + " \xB7 " + appName();
  $("#search").value = "";
  window.scrollTo(0, 0);
  app.innerHTML = `<div class="rows"><div class="row"><h2>${esc(genre)}</h2><div class="loading">Loading ${esc(genre)}\u2026</div></div></div>`;
  const res = await fetch("/api/category/" + encodeURIComponent(genre)).catch(() => null);
  if (APP_VIEW !== view) return;
  if (!res || !res.ok) {
    app.innerHTML = gridView(esc(genre), []);
    return;
  }
  const { items } = await res.json();
  if (APP_VIEW !== view) return;
  app.innerHTML = gridView(`${esc(genre)} anime`, items);
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
let schedByDay = null;
function openSchedule() {
  closeMenu();
  nav("/schedule");
}
async function renderSchedule() {
  var _a;
  APP_VIEW = "schedule";
  document.title = "Schedule \xB7 " + appName();
  $("#search").value = "";
  window.scrollTo(0, 0);
  app.innerHTML = `<div class="rows"><div class="row"><h2>Airing Schedule</h2><div class="loading">Loading schedule\u2026</div></div></div>`;
  let items = [];
  try {
    items = (await (await fetch("/api/schedule")).json()).items || [];
  } catch {
  }
  if (APP_VIEW !== "schedule") return;
  schedByDay = [[], [], [], [], [], [], []];
  for (const m of items) {
    if (!((_a = m.airing) == null ? void 0 : _a.at)) continue;
    schedByDay[new Date(m.airing.at * 1e3).getDay()].push(m);
  }
  for (const day of schedByDay) day.sort((a, b) => a.airing.at - b.airing.at);
  const today = (/* @__PURE__ */ new Date()).getDay();
  const tabs = DAY_ORDER.map((d) => `<button class="sched-day ${d === today ? "today" : ""}" data-day="${d}" onclick="selectSchedDay(${d})">
      <span class="sched-day-name">${DAYS[d]}</span><span class="sched-day-count">${schedByDay[d].length}</span>
    </button>`).join("");
  app.innerHTML = `<div class="rows"><div class="row"><h2>Airing Schedule</h2>
    <div class="sched-days">${tabs}</div>
    <div class="sched-list" id="schedList"></div></div></div>`;
  selectSchedDay(today);
}
function selectSchedDay(day) {
  document.querySelectorAll(".sched-day").forEach((b) => b.classList.toggle("active", +b.dataset.day === day));
  const list = schedByDay[day];
  const fmtTime = (at) => new Date(at * 1e3).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  $("#schedList").innerHTML = list.length ? list.map((m) => `<div class="sched-item" onclick="openTitle(${m.anilistId})">
        <div class="sched-time">${fmtTime(m.airing.at)}</div>
        <img class="sched-thumb" loading="lazy" src="${m.cover}" alt="" />
        <div class="sched-info">
          <div class="sched-title">${esc(m.title)}</div>
          <div class="sched-ep">Episode ${m.airing.episode}</div>
        </div>
      </div>`).join("") : `<div class="grid-empty">No episodes scheduled for this day.</div>`;
}
$("#randomBtn").addEventListener("click", async () => {
  const btn = $("#randomBtn");
  btn.disabled = true;
  try {
    const res = await fetch("/api/random");
    if (res.ok) {
      const { item } = await res.json();
      openTitle(item.anilistId);
    }
  } finally {
    btn.disabled = false;
  }
});
$("#logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  location.href = "/login.html";
});
function fmt(s) {
  s = Math.floor(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
function esc(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
window.openTitle = openTitle;
window.playTitle = playTitle;
window.setDetailMode = setDetailMode;
window.launchPlayer = launchPlayer;
window.toggleFav = toggleFav;
window.toggleList = toggleList;
window.deleteCollection = deleteCollection;
window.heroGo = heroGo;
window.heroNav = heroNav;
window.scrollRow = scrollRow;
window.updateRowArrows = updateRowArrows;
window.openCategory = openCategory;
window.selectSchedDay = selectSchedDay;
window.openMovie = openMovie;
window.playMovie = playMovie;
window.openTvShow = openTvShow;
window.openTvEpisode = openTvEpisode;
window.goBack = goBack;
window.setBrowseType = setBrowseType;
window.setBrowseSort = setBrowseSort;
window.resetBrowseFilters = resetBrowseFilters;
window.loadMoreBrowse = loadMoreBrowse;
window.nav = nav;
function closeMenu() {
  const d = $("#drawer");
  d.classList.remove("open");
  if (!$("#detail").classList.contains("show") && !$("#player").classList.contains("show"))
    document.body.style.overflow = "";
  setTimeout(() => {
    if (!d.classList.contains("open")) d.hidden = true;
  }, 300);
}
async function openMenu() {
  const d = $("#drawer");
  d.hidden = false;
  void d.offsetWidth;
  d.classList.add("open");
  document.body.style.overflow = "hidden";
  const box = $("#drawerGenres");
  if (box && !box.dataset.loaded) {
    try {
      const { genres } = await (await fetch("/api/genres")).json();
      box.innerHTML = genres.map((g) => `<button class="drawer-genre" onclick="openCategory('${esc(g)}')">${esc(g)}</button>`).join("");
      box.dataset.loaded = "1";
    } catch {
    }
  }
}
$("#navBurger").addEventListener("click", openMenu);
$("#drawerClose").addEventListener("click", closeMenu);
$("#drawerBackdrop").addEventListener("click", closeMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#drawer").hidden) closeMenu();
});
document.querySelectorAll(".drawer-link[data-tab]").forEach((b) => b.addEventListener("click", () => {
  nav(b.dataset.tab === "browse" ? "/browse" : "/");
  closeMenu();
}));
$("#drawerSchedule").addEventListener("click", openSchedule);
$("#drawerRandom").addEventListener("click", () => {
  closeMenu();
  $("#randomBtn").click();
});
$("#drawerLogout").addEventListener("click", () => $("#logout").click());
window.Player = Player;
window.epThumbFallback = epThumbFallback;
window.__onGCastApiAvailable = (ok) => {
  if (!ok) return;
  let tries = 0;
  (function ready() {
    var _a;
    if ((_a = window.cast) == null ? void 0 : _a.framework) {
      try {
        Player.initCast();
      } catch (e) {
        console.warn("cast init failed", e);
      }
    } else if (++tries < 50) setTimeout(ready, 100);
  })();
};
(function loadCastSdk() {
  const ua = navigator.userAgent;
  const chromium = navigator.vendor === "Google Inc." && !!window.chrome;
  if (!chromium || window.tizen || /SamsungBrowser|Tizen/.test(ua)) return;
  const s = document.createElement("script");
  s.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
  document.head.appendChild(s);
})();
boot();
