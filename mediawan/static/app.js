/* Mediawan v3 web UI. Plain ES2017 so Tizen's Chromium 69 runs it without a build step:
   no optional chaining, no ??, no class fields. */
(function () {
  "use strict";

  // ---- helpers -------------------------------------------------------------------------
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var main = $("#main");
  var ME = null;
  var CLIENT = (function () {
    try {
      var id = localStorage.getItem("mediawan.client");
      if (!id) { id = Math.random().toString(36).slice(2, 12); localStorage.setItem("mediawan.client", id); }
      return id;
    } catch (e) { return "web"; }
  })();
  var TV = /[?&]tv=1/.test(location.search) || /Tizen|Web0S|webOS|SMART-TV|SmartTV|AFT/i.test(navigator.userAgent);
  if (TV) document.documentElement.classList.add("tv");

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function clock(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    var h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    var mm = h ? (m < 10 ? "0" : "") + m : String(m);
    return (h ? h + ":" : "") + mm + ":" + (s < 10 ? "0" : "") + s;
  }
  function size(bytes) {
    var units = ["B", "KB", "MB", "GB", "TB"], i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return bytes.toFixed(i > 2 ? 1 : 0) + " " + units[i];
  }
  function hue(text) {
    var h = 0;
    for (var i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
    return h;
  }
  var toastTimer = null;
  function toast(message, el) {
    el = el || $("#toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 4000);
  }

  function api(path, options) {
    options = options || {};
    var init = { method: options.method || "GET", credentials: "same-origin", headers: {} };
    if (options.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    return fetch(path, init).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = { detail: text }; }
        if (response.status === 401 && path !== "/api/login") {
          ME = null;
          showLogin();
          throw new Error("Sign in to continue");
        }
        if (!response.ok) {
          var detail = data && data.detail;
          throw new Error(typeof detail === "string" ? detail : "Request failed (" + response.status + ")");
        }
        return data;
      });
    });
  }
  function fail(error) { toast(error.message || String(error)); }

  // ---- D-pad navigation --------------------------------------------------------------------
  // Rows ([data-row]: card rails, button bars, tabs) behave like Plex on a TV: Left/Right step
  // through the row, Up/Down jump to the next row and land on the card you last left there.
  // Everything else (grids, forms) moves to the nearest element in the pressed direction.
  var FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex='0']";
  var layers = []; // open overlays, topmost last; arrows never leave the top one
  var lastMain = null; // where focus was before stepping into the sidebar
  var homeFocus = null; // set by the home view: updates its billboard for the focused card

  function scope() {
    for (var i = layers.length - 1; i >= 0; i--) if (!layers[i].hidden) return layers[i];
    return document.body;
  }
  function visible(el) {
    if (el.closest("[hidden]")) return false;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }
  function focusables(root) {
    return $$(FOCUSABLE, root || scope()).filter(function (el) {
      if (!$("#player").hidden && !el.closest("#player")) return false;
      return visible(el);
    });
  }
  function rowItems(row) { return $$(FOCUSABLE, row).filter(visible); }
  function pageRows(root) {
    return $$("[data-row]", root).filter(function (r) { return !r.closest("[hidden]") && rowItems(r).length; });
  }
  // Coming into a row: the card you left it on, else the one nearest where you came from.
  function enterRow(row, from) {
    var list = rowItems(row), last = parseInt(row.getAttribute("data-last") || "-1", 10);
    if (last >= 0 && list[last]) return list[last];
    var x = from ? from.getBoundingClientRect().left : 0, best = list[0], gap = Infinity;
    list.forEach(function (el) {
      var d = Math.abs(el.getBoundingClientRect().left - x);
      if (d < gap) { gap = d; best = el; }
    });
    return best;
  }

  function focusEl(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    rememberFocus(); // focus events do not fire while the window itself is unfocused
    var row = el.closest("[data-row]");
    if (row) row.setAttribute("data-last", String(rowItems(row).indexOf(el)));
    var track = el.closest(".row-track");
    if (track) slideRow(track, el);
    if (el.closest(".home") && TV) { slideHome(el); if (homeFocus) homeFocus(el); return; }
    if (!el.closest("#player") && !el.closest("#rail")) keepInView(el);
  }
  // Horizontal rails. TV: move the track with a transform (smooth on TV GPUs) so the focused
  // card sits at the left edge. Web: scroll the rail only as far as needed.
  function slideRow(track, el) {
    var viewport = track.parentNode;
    if (TV) {
      var first = track.firstElementChild, last = track.lastElementChild;
      var end = last.offsetLeft + last.offsetWidth - first.offsetLeft;
      var room = viewport.clientWidth - parseFloat(getComputedStyle(viewport).paddingLeft) * 2;
      var x = Math.max(0, Math.min(el.offsetLeft - first.offsetLeft, end - room));
      track.style.transform = "translate3d(" + -x + "px,0,0)";
      return;
    }
    var r = el.getBoundingClientRect(), v = viewport.getBoundingClientRect(), pad = 60;
    if (r.left < v.left + pad) viewport.scrollLeft -= v.left + pad - r.left;
    else if (r.right > v.right - pad) viewport.scrollLeft += r.right - (v.right - pad);
  }
  // TV home: rows slide up under the details area so the focused row is always the top one.
  function slideHome(el) {
    var home = el.closest(".home"), trackY = $(".home-rows-track", home), section = el.closest(".row-section");
    var sections = $$(".row-section", home), index = sections.indexOf(section);
    trackY.style.transform = "translate3d(0," + (section ? -section.offsetTop : 0) + "px,0)";
    sections.forEach(function (s, i) { s.classList.toggle("gone", i < index); });
    home.classList.toggle("browsing", !!section);
  }
  window.addEventListener("resize", function () { // re-measure slid rows (window resized, TV rotated)
    var el = document.activeElement;
    if (el && el !== document.body && main.contains(el)) focusEl(el);
  });
  function keepInView(el) {
    var target = el.closest(".row-section") || el.closest(".ep-rail") || el;
    var r = el.getBoundingClientRect(), tr = target.getBoundingClientRect();
    if (r.top < 90 || r.bottom > innerHeight - 40) {
      window.scrollBy(0, tr.top - Math.max(90, (innerHeight - tr.height) / 3));
    }
  }
  function center(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  function openRail(current) {
    if (scope() !== document.body) return;
    lastMain = current;
    focusEl($("#rail a.active") || $("#rail a"));
  }
  function leaveRail() {
    if (lastMain && document.body.contains(lastMain) && visible(lastMain)) focusEl(lastMain);
    else focusEl(firstFocus());
  }

  function move(direction) {
    var current = document.activeElement;
    var items = focusables();
    if (!current || current === document.body || items.indexOf(current) < 0) {
      focusEl(firstFocus());
      return;
    }
    var nav = $("#rail");
    if (nav.contains(current)) {
      var links = $$("#rail a").filter(visible), i = links.indexOf(current);
      if (direction === "up" && i > 0) focusEl(links[i - 1]);
      else if (direction === "down" && i < links.length - 1) focusEl(links[i + 1]);
      else if (direction === "right") leaveRail();
      return;
    }
    var row = current.closest("[data-row]");
    if (row && scope().contains(row)) {
      var list = rowItems(row), at = list.indexOf(current);
      if (direction === "right") { if (at < list.length - 1) focusEl(list[at + 1]); return; }
      if (direction === "left") {
        if (at > 0) focusEl(list[at - 1]);
        else if (scope() === document.body) openRail(current);
        return;
      }
      var rows = pageRows(scope() === document.body ? main : scope()), r = rows.indexOf(row);
      var next = rows[r + (direction === "down" ? 1 : -1)];
      if (next) { focusEl(enterRow(next, current)); return; }
      // no row that way: fall through to the nearest element (a form or list below, say)
    }
    items = items.filter(function (el) { return direction === "left" || !nav.contains(el); });
    var from = current.getBoundingClientRect(), c = center(from);
    var best = null, bestScore = Infinity;
    items.forEach(function (el) {
      if (el === current) return;
      var r = el.getBoundingClientRect(), p = center(r), primary, secondary, overlap;
      if (direction === "right") { primary = r.left - from.right; secondary = p.y - c.y; overlap = r.top < from.bottom && r.bottom > from.top; }
      if (direction === "left") { primary = from.left - r.right; secondary = p.y - c.y; overlap = r.top < from.bottom && r.bottom > from.top; }
      if (direction === "down") { primary = r.top - from.bottom; secondary = p.x - c.x; overlap = r.left < from.right && r.right > from.left; }
      if (direction === "up") { primary = from.top - r.bottom; secondary = p.x - c.x; overlap = r.left < from.right && r.right > from.left; }
      if (primary < -4) return; // not in that direction
      var score = Math.max(primary, 0) + Math.abs(secondary) * (overlap ? 0.3 : 2.5);
      if (score < bestScore) { best = el; bestScore = score; }
    });
    if (!best) {
      if (direction === "left" && scope() === document.body) openRail(current);
      return;
    }
    if (nav.contains(best)) { openRail(current); return; }
    var into = best.closest("[data-row]");
    if (into && into !== row) best = enterRow(into, current);
    focusEl(best);
  }
  function firstFocus() {
    var root = scope();
    if (root === document.body) root = main;
    var auto = $("[data-autofocus]", root);
    return auto && visible(auto) ? auto : focusables(root)[0] || focusables()[0];
  }
  // Back returns focus to the control you left the page from (by position among the page's
  // focusable elements, which survives the page being re-rendered).
  var focusMemory = {};
  function rememberFocus() {
    var el = document.activeElement;
    if (el && main.contains(el)) focusMemory[location.hash] = focusables(main).indexOf(el);
  }
  document.addEventListener("focusin", rememberFocus); // mouse/tab focus on the web
  function autofocus() {
    if (!TV) return;
    setTimeout(function () {
      if (scope() !== document.body) return;
      var remembered = focusables(main)[focusMemory[location.hash]];
      focusEl(remembered || firstFocus());
    }, 30);
  }

  var KEY = { 37: "left", 38: "up", 39: "right", 40: "down", 13: "enter", 27: "back", 10009: "back", 461: "back",
              415: "play", 19: "pause", 10252: "playpause", 413: "stop", 417: "ff", 412: "rw", 179: "playpause" };
  function keyName(event) {
    var named = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Enter: "enter",
                  Escape: "back", GoBack: "back", BrowserBack: "back", MediaPlayPause: "playpause",
                  MediaPlay: "play", MediaPause: "pause", MediaStop: "stop",
                  MediaFastForward: "ff", MediaRewind: "rw" }[event.key];
    return named || KEY[event.keyCode] || (event.key === "Backspace" ? "backspace" : null);
  }
  function typing(el) {
    return el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !/^(button|checkbox|radio|range)$/.test(el.type)));
  }

  document.addEventListener("keydown", function (event) {
    var key = keyName(event);
    if (!key) return;
    var active = document.activeElement;
    if (key === "backspace") {
      if (typing(active)) return;
      key = "back";
    }
    if (!$("#player").hidden && Player.key(key, event)) { event.preventDefault(); return; }
    if (key === "back") {
      event.preventDefault();
      if (typing(active) && active.value) { active.blur(); return; }
      if ($("#rail").contains(active)) { leaveRail(); return; }
      // Home: Back first returns to the top, like Plex, before it does anything else.
      var home = $(".home", main);
      if (home && active && home.contains(active) && active.closest(".home-rows")) { focusEl(firstFocus()); return; }
      if (location.hash && location.hash !== "#/" && location.hash !== "#") history.back();
      return;
    }
    if (typing(active) && (key === "left" || key === "right")) return; // let the caret move
    if (active && active.tagName === "SELECT" && (key === "up" || key === "down")) return;
    if (key === "left" || key === "right" || key === "up" || key === "down") {
      event.preventDefault();
      move(key);
    }
  });
  try { // packaged Tizen apps must ask for media keys
    window.tizen.tvinputdevice.registerKeyBatch(["MediaPlayPause", "MediaPlay", "MediaPause", "MediaStop",
      "MediaFastForward", "MediaRewind"]);
  } catch (e) { /* not a Tizen app */ }

  // ---- icons, artwork, cards ---------------------------------------------------------------
  function icon(name, cls) {
    return '<svg class="i' + (cls ? " " + cls : "") + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }
  function art(src, name, extra) {
    var fallback = '<div class="fallback" style="--hue:' + hue(name || "") + '">' + esc(name) + "</div>";
    var img = src ? '<img loading="lazy" alt="" src="' + esc(src) + '" onload="this.className=\'ready\'" onerror="this.remove()">' : "";
    return '<div class="art">' + fallback + img + (extra || "") + "</div>";
  }
  function bar(position, duration) {
    var pct = duration ? Math.min(100, (100 * position) / duration) : 0;
    return pct > 0.5 ? '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' : "";
  }
  function iconButton(id, name, tip, extra) {
    return '<button class="icon-btn" id="' + id + '" aria-label="' + esc(tip) + '" data-tip="' + esc(tip) + '"' + (extra || "") + ">" + icon(name) + "</button>";
  }

  // What each card shows in the home billboard when focused, by its data-k.
  var FEAT = [];
  function feature(data) { FEAT.push(data); return FEAT.length - 1; }

  function titleCard(t) {
    var badge = t.watched ? '<span class="badge">' + icon("check") + "</span>"
      : t.kind === "show" && t.unwatched ? '<span class="badge">' + t.unwatched + "</span>" : "";
    var k = feature({ type: "title", id: t.id, kind: t.kind, name: t.name, year: t.year, rating: t.rating,
      genres: t.genres, description: t.description, background: t.background, poster: t.poster });
    return '<a class="card" href="#/title/' + t.id + '" data-k="' + k + '">' + art(t.poster, t.name, badge) +
      '<div class="caption"><div>' + esc(t.name) + '</div><div class="s">' + esc(t.year || "") + "</div></div></a>";
  }
  function entryCard(e) { // Continue Watching / Next Up: an episode or film to play right away
    var k = feature({ type: "entry", id: e.id, item_id: e.item_id, kind: e.kind, name: e.name, year: e.year,
      label: e.label, item_name: e.item_name, position: e.position, duration: e.duration,
      description: e.description, background: e.background || e.thumbnail, poster: e.poster });
    var sub = [e.label, e.item_name].filter(Boolean).join(" · ") || (e.duration ? clock(e.duration - e.position) + " left" : "");
    return '<a class="card wide" href="#/play/' + e.item_id + '" data-k="' + k + '">' +
      art(e.thumbnail || e.background || e.poster, e.name, bar(e.position, e.duration)) +
      '<div class="caption"><div>' + esc(e.name) + '</div><div class="s">' + esc(sub) + "</div></div></a>";
  }
  var FORMATS = { TV: "TV", TV_SHORT: "TV short", MOVIE: "Movie", OVA: "OVA", ONA: "ONA", SPECIAL: "Special", MUSIC: "Music" };
  function animeCard(a) { // an AniList search result
    var badge = a.available ? "" : '<span class="badge soon">Soon</span>';
    var k = feature({ type: "anime", id: a.id, name: a.name, year: a.year, genres: a.genres,
      rating: a.score ? (a.score / 10).toFixed(1) : "", background: a.background || a.poster, poster: a.poster });
    var sub = [a.year, FORMATS[a.format] || "", a.available ? a.available + " ep" : "not out yet"].filter(Boolean).join(" · ");
    return '<a class="card" href="#/anime/' + a.id + '" data-k="' + k + '">' + art(a.poster, a.name, badge) +
      '<div class="caption"><div>' + esc(a.name) + '</div><div class="s">' + esc(sub) + "</div></div></a>";
  }
  function animeEntryCard(e) { // Continue Watching · Anime
    var k = feature({ type: "anime-entry", id: e.anilist_id, episode: e.episode, lang: e.lang, name: e.name,
      position: e.position, duration: e.duration, background: e.background || e.poster, poster: e.poster });
    var sub = "Episode " + e.episode + (e.lang === "dub" ? " · Dub" : "") + (e.duration ? " · " + clock(e.duration - e.position) + " left" : "");
    return '<a class="card wide" href="#/anime/' + e.anilist_id + "?play=" + e.episode + '" data-k="' + k + '">' +
      art(e.background || e.poster, e.name, bar(e.position, e.duration)) +
      '<div class="caption"><div>' + esc(e.name) + '</div><div class="s">' + esc(sub) + "</div></div></a>";
  }
  function watchCard(m) { // a Cinemeta search result, played from Usenet
    var sub = [m.year, m.kind === "show" ? "TV show" : "Movie"].filter(Boolean).join(" · ");
    return '<a class="card" href="#/watch/' + m.kind + "/" + m.id + '">' + art(m.poster, m.name) +
      '<div class="caption"><div>' + esc(m.name) + '</div><div class="s">' + esc(sub) + "</div></div></a>";
  }
  function watchLabel(e) { return e.kind === "show" ? "S" + e.season + " · E" + e.episode : ""; }
  function watchEntryCard(e) { // Continue Watching · Online
    var k = feature({ type: "watch-entry", id: e.id, kind: e.kind, season: e.season, episode: e.episode, name: e.name,
      label: watchLabel(e), position: e.position, duration: e.duration, background: e.background || e.poster, poster: e.poster });
    var sub = [watchLabel(e), e.duration ? clock(e.duration - e.position) + " left" : ""].filter(Boolean).join(" · ");
    return '<a class="card wide" href="#/watch/' + e.kind + "/" + e.id + "?play=" + e.season + "." + e.episode + '" data-k="' + k + '">' +
      art(e.background || e.poster, e.name, bar(e.position, e.duration)) +
      '<div class="caption"><div>' + esc(e.name) + '</div><div class="s">' + esc(sub) + "</div></div></a>";
  }
  // Ask for an anime's details while the pointer or remote focus rests on its card: the server
  // caches AniList's answer, so the page opens instantly on click instead of after ~0.5 s.
  var warmed = {};
  function warmAnime(event) {
    var link = event.target.closest && event.target.closest('a[href^="#/anime/"]');
    var id = link && (link.getAttribute("href").match(/^#\/anime\/(\d+)/) || [])[1];
    if (!id || warmed[id]) return;
    warmed[id] = true;
    fetch("/api/online/anime/" + id, { credentials: "same-origin" }).catch(function () { delete warmed[id]; });
  }
  document.addEventListener("mouseover", warmAnime);
  document.addEventListener("focusin", warmAnime);

  function rowSection(section) {
    var wide = section.id === "continue" || section.id === "next" || section.id === "online" || section.id === "usenet";
    var lists = /^(watchlist|favorites|collection-)/.test(section.id);
    var render = section.id === "online" ? animeEntryCard : section.id === "usenet" ? watchEntryCard : wide ? entryCard : titleCard;
    return '<section class="row-section' + (lists ? " list-only" : "") + '"><h2>' + esc(section.name) + "</h2>" +
      '<div class="row-viewport"><div class="row-track" data-row>' + section.items.map(render).join("") + "</div></div></section>";
  }

  // ---- router ----------------------------------------------------------------------------
  var VIEW = 0; // bumps on every navigation, so late responses never paint over a newer view
  var routes = [
    [/^\/?$/, viewHome],
    [/^\/movies$/, function (_, q, view) { return viewLibrary("movie", q, view); }],
    [/^\/shows$/, function (_, q, view) { return viewLibrary("show", q, view); }],
    [/^\/search$/, viewSearch],
    [/^\/title\/(\d+)$/, viewTitle],
    [/^\/anime\/(\d+)$/, viewAnime],
    [/^\/watch\/((?:movie|show)\/tt\d+)$/, viewWatch],
    [/^\/sports$/, viewSports],
    [/^\/play\/(\d+)$/, function (id, q, view) { history.replaceState(null, "", "#/"); Player.open({ item_id: +id }); return viewHome(null, q, view); }],
    [/^\/collections$/, viewCollections],
    [/^\/collection\/(\d+)$/, viewCollection],
    [/^\/settings$/, viewSettings],
    [/^\/admin$/, viewAdmin],
  ];

  function route() {
    if (!ME) return;
    var hash = location.hash.replace(/^#/, "") || "/";
    var path = hash.split("?")[0];
    var query = {};
    (hash.split("?")[1] || "").split("&").forEach(function (pair) {
      if (pair) { var kv = pair.split("="); query[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ""); }
    });
    var view = ++VIEW;
    FEAT = [];
    $$("#rail a").forEach(function (a) {
      var r = a.getAttribute("data-route");
      a.classList.toggle("active", r === (path === "/" ? "home" : path.split("/")[1]));
    });
    for (var i = 0; i < routes.length; i++) {
      var match = path.match(routes[i][0]);
      if (match) {
        window.scrollTo(0, 0);
        Promise.resolve(routes[i][1](match[1], query, view)).then(autofocus).catch(fail);
        return;
      }
    }
    main.innerHTML = '<p class="empty">Page not found.</p>';
  }
  function paint(view, html) {
    if (view !== undefined && view !== VIEW) return false;
    main.innerHTML = html;
    return true;
  }
  window.addEventListener("hashchange", route);

  // ---- home: a billboard for one title over rows of cards ---------------------------------
  function infoHref(f) {
    return f.type === "watch-entry" ? "#/watch/" + f.kind + "/" + f.id
      : f.type === "anime" || f.type === "anime-entry" ? "#/anime/" + f.id : "#/title/" + f.id;
  }
  function playFeature(f) {
    if (f.type === "entry") Player.open({ item_id: f.item_id });
    else if (f.type === "anime-entry") Player.open({ online: { anilist_id: f.id, episode: f.episode, lang: f.lang } });
    else if (f.type === "watch-entry") Player.open({ usenet: { kind: f.kind, id: f.id, season: f.season, episode: f.episode } });
    else if (f.type === "anime") location.hash = infoHref(f);
    else api("/api/titles/" + f.id).then(function (t) {
      if (t.next) Player.open({ item_id: t.next.item_id, title_id: t.id });
      else location.hash = infoHref(f);
    }).catch(fail);
  }
  function billboardText(f) {
    var resuming = /entry$/.test(f.type) && f.position > 5;
    var kicker = resuming ? "Continue watching" : /entry$/.test(f.type) ? "Up next"
      : f.type === "anime" ? "Anime" : f.kind === "show" ? "TV show" : "Movie";
    var meta = [];
    if (f.type === "entry" && f.label) meta.push(esc(f.label + (f.item_name ? " · " + f.item_name : "")));
    if (f.type === "watch-entry" && f.label) meta.push(esc(f.label));
    if (f.type === "anime-entry") meta.push("Episode " + f.episode + (f.lang === "dub" ? " · Dubbed" : ""));
    if (f.year) meta.push(esc(f.year));
    if (f.rating) meta.push('<span class="star">' + icon("star") + esc(f.rating) + "</span>");
    if (resuming && f.duration) meta.push(esc(clock(f.duration - f.position)) + " left");
    if (f.genres && f.genres.length) meta.push(esc(f.genres.slice(0, 3).join(", ")));
    return '<div class="bb-kicker">' + kicker + '</div><h1 class="bb-title">' + esc(f.name) + "</h1>" +
      '<div class="meta">' + meta.map(function (m) { return "<span>" + m + "</span>"; }).join("") + "</div>" +
      (f.description ? '<p class="bb-desc">' + esc(f.description) + "</p>" : "");
  }
  // Crossfade the backdrop once the new picture has loaded, so it never flashes empty.
  function setBackdrop(home, src) {
    var layers = $$(".bb-layer", home), shown = layers[0].classList.contains("on") ? layers[0] : layers[1];
    var hidden = shown === layers[0] ? layers[1] : layers[0];
    src = src || "";
    home.setAttribute("data-want", src);
    if ((shown.getAttribute("data-src") || "") === src && shown.classList.contains("on")) return;
    if (!src) { shown.classList.remove("on"); shown.setAttribute("data-src", ""); return; }
    var img = new Image();
    img.onload = function () {
      if (home.getAttribute("data-want") !== src) return;
      hidden.style.backgroundImage = 'url("' + src.replace(/"/g, "%22") + '")';
      hidden.setAttribute("data-src", src);
      hidden.classList.add("on");
      shown.classList.remove("on");
    };
    img.src = src;
  }
  function viewHome(_, __, view) {
    return api("/api/home").then(function (data) {
      if (!data.rails.length) {
        var admin = ME.role === "admin";
        return paint(view, '<div class="box" style="margin-top:10vh"><h1>Welcome to Mediawan</h1><p class="muted">Your library is empty. ' +
          (admin ? 'Add folders with LIBRARY_ROOTS, then run a scan from <a href="#/admin"><u>Admin</u></a>. You can also find anime from ' +
            '<a href="#/search"><u>Search</u></a>.' : "Ask your administrator to add some media.") + "</p></div>");
      }
      var rows = data.rails.map(rowSection).join("");
      // Feature what you were watching, else something recent with a backdrop.
      var withArt = FEAT.filter(function (f) { return f.background; });
      var resume = withArt.filter(function (f) { return /entry$/.test(f.type); });
      var featured = resume[0] || withArt[Math.floor(Math.random() * Math.min(withArt.length, 8))] || FEAT[0];
      var html = '<div class="home"><div class="bb"><div class="bb-layer"></div><div class="bb-layer"></div><div class="bb-shade"></div>' +
        '<div class="bb-copy"><div id="bb-text"></div><div class="actions bb-actions" data-row>' +
        '<button class="primary" id="bb-play" data-autofocus>' + icon("play") + '<span id="bb-play-label">Play</span></button>' +
        '<button id="bb-info">' + icon("info") + "More info</button></div></div></div>" +
        '<div class="home-rows"><div class="home-rows-track">' + rows + "</div></div></div>";
      if (!paint(view, html)) return;
      var home = $(".home", main), current = null;
      function show(f) {
        if (!f || f === current) return;
        current = f;
        $("#bb-text").innerHTML = billboardText(f);
        $("#bb-play-label").textContent = /entry$/.test(f.type) && f.position > 5 ? "Resume" : f.type === "anime" ? "Episodes" : "Play";
        setBackdrop(home, f.background);
      }
      show(featured);
      $("#bb-play").onclick = function () { playFeature(current); };
      $("#bb-info").onclick = function () { location.hash = infoHref(current); };
      // On a TV the billboard follows the remote, like Plex: it describes the focused card.
      // (Called from focusEl, because focus events do not fire while the window is unfocused.)
      var timer = null;
      homeFocus = function (el) {
        var card = el.closest(".card[data-k]");
        if (!card || !document.body.contains(home)) return;
        clearTimeout(timer);
        timer = setTimeout(function () { show(FEAT[+card.getAttribute("data-k")]); }, 140);
      };
    });
  }

  // ---- libraries and search ----------------------------------------------------------------
  function viewLibrary(kind, query, view) {
    var state = viewLibrary.state[kind] || (viewLibrary.state[kind] = { sort: "name", genre: "" });
    function load() {
      var params = "kind=" + kind + "&sort=" + state.sort + "&genre=" + encodeURIComponent(state.genre);
      return api("/api/titles?" + params).then(function (data) {
        var sorts = [["name", "A–Z"], ["added", "Recently added"], ["year", "Year"], ["rating", "Rating"]];
        var html = '<div class="page-head"><h1>' + (kind === "movie" ? "Movies" : "TV Shows") + "</h1>" +
          '<span class="count">' + data.titles.length + (data.titles.length === 1 ? " title" : " titles") + '</span><span class="grow"></span>' +
          '<div class="choice" id="sorts" data-row>' + sorts.map(function (s) {
            return '<button data-sort="' + s[0] + '" aria-pressed="' + (state.sort === s[0]) + '">' + s[1] + "</button>";
          }).join("") + "</div>" +
          (data.genres.length ? '<select class="genre-filter" id="genre"><option value="">All genres</option>' +
            data.genres.map(function (g) {
              return "<option" + (g === state.genre ? " selected" : "") + ">" + esc(g) + "</option>";
            }).join("") + "</select>" : "") + "</div>" +
          (data.titles.length ? '<div class="grid">' + data.titles.map(titleCard).join("") + "</div>"
            : '<p class="empty">Nothing here yet.</p>');
        if (!paint(view, html)) return;
        $$("#sorts button").forEach(function (b) {
          b.onclick = function () { state.sort = b.getAttribute("data-sort"); load().then(function () { focusEl($('[data-sort="' + state.sort + '"]')); }); };
        });
        var genre = $("#genre");
        if (genre) genre.onchange = function () { state.genre = genre.value; load(); };
      });
    }
    return load();
  }
  viewLibrary.state = {};

  function viewSearch(_, query, view) {
    paint(view, '<div class="search-field">' + icon("search") + '<input id="q" type="search" placeholder="Search movies, shows and anime" autocomplete="off" data-autofocus value="' +
      esc(query.q || "") + '"></div><div id="results"><div id="r-local"></div><div id="r-usenet"></div><div id="r-online"></div></div>');
    var input = $("#q"), timer = null;
    function section(id, heading, cards, render) {
      $("#" + id).innerHTML = cards.length ? '<section class="row-section"><h2>' + heading + '</h2><div class="grid">' + cards.map(render).join("") + "</div></section>" : "";
    }
    function run() {
      var q = input.value.trim();
      history.replaceState(null, "", "#/search" + (q ? "?q=" + encodeURIComponent(q) : ""));
      if (!q) { $("#r-local").innerHTML = $("#r-usenet").innerHTML = $("#r-online").innerHTML = ""; return; }
      var local = api("/api/titles?q=" + encodeURIComponent(q) + "&limit=60").then(function (data) {
        if (input.value.trim() === q) section("r-local", "In your library", data.titles, titleCard);
        return data.titles.length;
      });
      $("#r-online").innerHTML = '<p class="empty small">Searching anime…</p>';
      var online = api("/api/online/search?q=" + encodeURIComponent(q)).then(function (data) {
        if (input.value.trim() === q) section("r-online", "Anime", data.results, animeCard);
        return data.results.length;
      }, function (err) {
        if (input.value.trim() === q) $("#r-online").innerHTML = '<p class="empty small">Anime search failed: ' + esc(err.message) + "</p>";
        return 0;
      });
      var usenet = api("/api/usenet/search?q=" + encodeURIComponent(q)).then(function (data) {
        if (input.value.trim() === q) section("r-usenet", "Movies and TV online", data.results, watchCard);
        return data.results.length;
      }, function () { return 0; });
      Promise.all([local, online, usenet]).then(function (counts) {
        if (input.value.trim() === q && !counts[0] && !counts[1] && !counts[2] && !$("#r-online").textContent) {
          $("#r-local").innerHTML = '<p class="empty">No matches for “' + esc(q) + "”.</p>";
        }
      }).catch(fail);
    }
    input.oninput = function () { clearTimeout(timer); timer = setTimeout(run, 250); };
    input.onkeydown = function (e) { if (keyName(e) === "down" || keyName(e) === "enter") { e.preventDefault(); input.blur(); focusEl($(".card", $("#results")) || input); } };
    if (query.q) run();
    if (!TV) input.focus();
  }

  // ---- title pages (library titles and online anime share the layout) ---------------------
  function detailHtml(o) {
    return '<div class="detail">' + (o.background ? '<div class="detail-bg" style="background-image:url(&quot;' + esc(o.background) + '&quot;)"></div>' : "") +
      '<div class="detail-main"><div class="detail-poster">' + art(o.poster, o.name) + '</div><div class="detail-info">' +
      "<h1>" + esc(o.name) + "</h1>" +
      (o.meta.length ? '<div class="meta">' + o.meta.map(function (m) { return "<span>" + m + "</span>"; }).join("") + "</div>" : "") +
      (o.genres ? '<div class="genres">' + esc(o.genres) + "</div>" : "") +
      (o.description ? '<p class="desc">' + esc(o.description) + "</p>" : "") +
      '<div class="actions" data-row>' + o.actions + "</div>" + (o.note ? '<p class="note">' + o.note + "</p>" : "") +
      '</div></div><div class="detail-body">' + (o.body || "") + "</div></div>";
  }
  function episodeCard(o) {
    var extra = '<span class="num">' + esc(o.num) + "</span>" + (o.completed ? '<span class="seen">' + icon("check") + "</span>" : "") +
      bar(o.completed ? 0 : o.position, o.duration);
    return '<button class="card ep' + (o.unavailable ? " unavailable" : "") + '" ' + o.attr + ">" + art(o.thumbnail, o.name || o.num, extra) +
      '<div class="caption"><div>' + esc(o.name || o.num) + '</div><div class="s">' + esc(o.sub || "") + "</div></div></button>";
  }
  function episodeRail() {
    return '<div class="ep-rail"><div class="row-viewport"><div class="row-track" id="episodes" data-row></div></div>' +
      '<div class="ep-detail" id="ep-detail"></div></div>';
  }
  // The focused (or hovered) episode's details, under the rail.
  function bindEpisodeDetail(describe) {
    var rail = $("#episodes"), box = $("#ep-detail");
    function update(e) {
      var card = e.target.closest && e.target.closest(".ep");
      if (card) box.innerHTML = describe(card);
    }
    rail.addEventListener("focusin", update);
    rail.addEventListener("mouseover", update);
  }
  function techTags(file) {
    if (!file || !file.height) return [];
    var tags = [file.height >= 2000 ? "4K" : file.height >= 1000 ? "1080p" : file.height >= 700 ? "720p" : "SD"];
    if (file.hdr) tags.push("HDR");
    var a = (file.audio || [])[0];
    if (a && a.channels >= 6) tags.push(a.channels >= 8 ? "7.1" : "5.1");
    return tags.map(function (t) { return '<span class="tag">' + t + "</span>"; });
  }

  function viewTitle(id, query, view) {
    return api("/api/titles/" + id).then(function (t) {
      var state = viewTitle.state[id] || (viewTitle.state[id] = {});
      var nextItem = t.next && t.items.filter(function (i) { return i.id === t.next.item_id; })[0];
      if (state.season === undefined) state.season = nextItem ? nextItem.season : t.seasons[0];
      var playLabel = !t.next ? "Play" : t.next.resume ? "Resume" : t.kind === "show" && nextItem ? "Play " + nextItem.label : "Play";
      var fav = t.tags.indexOf("favorite") >= 0, wl = t.tags.indexOf("watchlist") >= 0;
      var allWatched = t.items.length && t.items.every(function (i) { return i.completed; });
      var first = (nextItem || t.items[0] || {}).files;
      var meta = [t.year ? esc(t.year) : "", t.runtime ? esc(t.runtime) : "",
        t.rating ? '<span class="star">' + icon("star") + esc(t.rating) + "</span>" : "",
        t.kind === "show" ? t.seasons.filter(Boolean).length + (t.seasons.filter(Boolean).length === 1 ? " season" : " seasons") : "",
        t.next && t.next.resume ? esc(clock(t.next.position)) + " in" : ""].filter(Boolean).concat(techTags(first && first[0]));
      var actions = (t.next ? '<button class="primary" id="play" data-autofocus>' + icon("play") + esc(playLabel) + "</button>" : "") +
        (t.next && t.next.resume ? iconButton("restart", "restart", "From the start") : "") +
        (t.kind === "show" ? iconButton("shuffle", "shuffle", "Shuffle") : "") +
        iconButton("watched", "seen", allWatched ? "Mark unwatched" : "Mark watched", ' aria-pressed="' + !!allWatched + '"') +
        '<span class="list-only">' + iconButton("fav", "heart", "Favorite", ' aria-pressed="' + fav + '"') + "</span>" +
        '<span class="list-only">' + iconButton("wl", "bookmark", "Watchlist", ' aria-pressed="' + wl + '"') + "</span>" +
        '<span class="list-only">' + iconButton("collect", "stack", "Collections") + "</span>" +
        (ME.role === "admin" ? '<span class="list-only">' + iconButton("edit", "edit", "Edit details") + "</span>" : "");
      var body = '<div id="collect-box"></div><div id="edit-box"></div>';
      if (t.kind === "show") {
        body += '<div class="tabs" id="seasons" data-row>' + t.seasons.map(function (s) {
          return '<button data-season="' + s + '" aria-pressed="' + (s === state.season) + '">' + (s ? "Season " + s : "Specials") + "</button>";
        }).join("") + "</div>" + episodeRail() + '<div id="admin-files"></div>';
      } else {
        body += filesHtml(t.items[0]);
      }
      if (!paint(view, detailHtml({ name: t.name, poster: t.poster, background: t.background, meta: meta,
        genres: (t.genres || []).join(", "), description: t.description, actions: actions, body: body }))) return;

      function episodes() {
        var items = t.items.filter(function (i) { return i.season === state.season; });
        $("#episodes").style.transform = "";
        $("#episodes").removeAttribute("data-last");
        $("#episodes").innerHTML = items.map(function (i) {
          var length = i.files[0] && i.files[0].duration;
          return episodeCard({ attr: 'data-item="' + i.id + '"', thumbnail: i.thumbnail || t.background, num: i.label || "E" + i.episode,
            name: i.name || "Episode " + i.episode, sub: length ? clock(length) : "", position: i.position, duration: i.duration,
            completed: i.completed, unavailable: !i.available });
        }).join("");
        $("#admin-files").innerHTML = ME.role === "admin" ? items.map(filesHtml).join("") : "";
        $$("#episodes .ep").forEach(function (b) {
          b.onclick = function () { Player.open({ item_id: +b.getAttribute("data-item"), title_id: t.id }); };
        });
        bindFixButtons();
        // Start the rail at the episode you are on.
        var current = nextItem && $('#episodes [data-item="' + nextItem.id + '"]');
        if (current) $("#episodes").setAttribute("data-last", String($$("#episodes .ep").indexOf(current)));
      }
      if (t.kind === "show") {
        episodes();
        bindEpisodeDetail(function (card) {
          var i = t.items.filter(function (x) { return x.id === +card.getAttribute("data-item"); })[0];
          var length = i.files[0] && i.files[0].duration;
          return "<h3>" + esc(i.label) + " · " + esc(i.name || "Episode " + i.episode) + "</h3>" +
            '<div class="meta small">' + (length ? "<span>" + clock(length) + "</span>" : "") + (i.aired ? "<span>" + esc(i.aired) + "</span>" : "") +
            (i.completed ? "<span>Watched</span>" : i.position ? "<span>" + clock(i.duration - i.position) + " left</span>" : "") + "</div>" +
            (i.overview ? "<p>" + esc(i.overview) + "</p>" : "");
        });
        $$("#seasons button").forEach(function (b) {
          b.onclick = function () {
            state.season = +b.getAttribute("data-season");
            $$("#seasons button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
            episodes();
          };
        });
      } else {
        bindFixButtons();
      }
      if ($("#play")) $("#play").onclick = function () { Player.open({ item_id: t.next.item_id, title_id: t.id }); };
      if ($("#restart")) $("#restart").onclick = function () { Player.open({ item_id: t.next.item_id, title_id: t.id, start: 0 }); };
      if ($("#shuffle")) $("#shuffle").onclick = function () {
        api("/api/queues", { method: "POST", body: { name: t.name + " (shuffle)", mode: "shuffle", titles: [t.id] } })
          .then(function (q) { Player.open({ item_id: q.current, queue: q.id }); }).catch(fail);
      };
      $("#watched").onclick = function () {
        api("/api/titles/" + t.id + "/watched", { method: "POST", body: { watched: !allWatched } }).then(route).catch(fail);
      };
      [["fav", "favorite", fav], ["wl", "watchlist", wl]].forEach(function (x) {
        var on = x[2];
        $("#" + x[0]).onclick = function () {
          on = !on;
          api("/api/titles/" + t.id + "/tags/" + x[1], { method: on ? "PUT" : "DELETE" }).then(function () {
            $("#" + x[0]).setAttribute("aria-pressed", String(on));
          }).catch(fail);
        };
      });
      $("#collect").onclick = function () { collectBox(t); };
      if ($("#edit")) $("#edit").onclick = function () { editBox(t.id); };
    });
  }
  viewTitle.state = {};

  // ---- online anime (AniList details, MegaPlay streams) ----------------------------------
  function viewAnime(id, query, view) {
    return api("/api/online/anime/" + id).then(function (a) {
      var state = viewAnime.state[id] || (viewAnime.state[id] = { lang: a.lang || "sub" });
      var PAGE = 100, pages = Math.ceil(a.episodes.length / PAGE);
      if (state.page === undefined) state.page = a.next ? Math.floor((a.next.episode - 1) / PAGE) : 0;
      var resume = a.next && a.next.position > 5;
      var playLabel = !a.next ? "" : (resume ? "Resume" : "Play") + (a.episodes.length > 1 ? " episode " + a.next.episode : "");
      var meta = [a.year ? esc(a.year) : "", FORMATS[a.format] || "",
        a.available ? a.available + (a.total && a.total !== a.available ? " of " + a.total : "") + " episodes" : "Not out yet",
        a.score ? '<span class="star">' + icon("star") + (a.score / 10).toFixed(1) + "</span>" : "",
        resume ? esc(clock(a.next.position)) + " in" : ""].filter(Boolean);
      var actions = (a.next ? '<button class="primary" id="play" data-autofocus>' + icon("play") + esc(playLabel) + "</button>" : "") +
        '<div class="choice" id="lang"><button data-lang="sub" aria-pressed="' + (state.lang === "sub") + '">Subtitled</button>' +
        '<button data-lang="dub" aria-pressed="' + (state.lang === "dub") + '">Dubbed</button></div>';
      var body = "";
      if (a.episodes.length > 1) {
        if (pages > 1) {
          body += '<div class="tabs" id="pages" data-row>';
          for (var p = 0; p < pages; p++) {
            body += '<button data-page="' + p + '" aria-pressed="' + (p === state.page) + '">' + (p * PAGE + 1) + "–" + Math.min(a.episodes.length, (p + 1) * PAGE) + "</button>";
          }
          body += "</div>";
        }
        body += episodeRail();
      }
      if (!paint(view, detailHtml({ name: a.name, poster: a.poster, background: a.background || a.poster, meta: meta,
        genres: (a.genres || []).slice(0, 5).join(", "), description: a.description, actions: actions, body: body,
        note: "Streams from MegaPlay through this server." }))) return;

      function play(number, start) {
        Player.open({ online: { anilist_id: a.id, episode: number, lang: state.lang }, start: start });
      }
      function episodes() {
        if (!$("#episodes")) return;
        $("#episodes").style.transform = "";
        $("#episodes").removeAttribute("data-last");
        $("#episodes").innerHTML = a.episodes.slice(state.page * PAGE, (state.page + 1) * PAGE).map(function (e) {
          return episodeCard({ attr: 'data-ep="' + e.number + '"', thumbnail: e.thumbnail || a.background, num: "E" + e.number,
            name: e.name || "Episode " + e.number, sub: e.name ? "Episode " + e.number : "", position: e.position,
            duration: e.duration, completed: e.completed });
        }).join("");
        $$("#episodes .ep").forEach(function (b) {
          b.onclick = function () { play(+b.getAttribute("data-ep")); };
        });
        var current = a.next && $('#episodes [data-ep="' + a.next.episode + '"]');
        if (current) $("#episodes").setAttribute("data-last", String($$("#episodes .ep").indexOf(current)));
      }
      episodes();
      if ($("#episodes")) bindEpisodeDetail(function (card) {
        var e = a.episodes[+card.getAttribute("data-ep") - 1];
        return "<h3>Episode " + e.number + (e.name ? " · " + esc(e.name) : "") + "</h3>" +
          '<div class="meta small">' + (a.minutes ? "<span>" + a.minutes + " min</span>" : "") +
          (e.completed ? "<span>Watched</span>" : e.position ? "<span>" + clock(e.duration - e.position) + " left</span>" : "") + "</div>";
      });
      $$("#pages button").forEach(function (b) {
        b.onclick = function () {
          state.page = +b.getAttribute("data-page");
          $$("#pages button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
          episodes();
        };
      });
      $$("#lang button").forEach(function (b) {
        b.onclick = function () {
          state.lang = b.getAttribute("data-lang");
          $$("#lang button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        };
      });
      if ($("#play")) $("#play").onclick = function () { play(a.next.episode); };
      if (query.play) { // from a Continue Watching card
        history.replaceState(null, "", "#/anime/" + id);
        play(+query.play);
      }
    });
  }
  viewAnime.state = {};

  // ---- online movies and TV (Cinemeta details, Usenet streams) ---------------------------
  function viewWatch(path, query, view) {
    return api("/api/usenet/title/" + path).then(function (t) {
      var state = viewWatch.state[path] || (viewWatch.state[path] = {});
      var show = t.kind === "show", next = t.next, seasons = [];
      t.episodes.forEach(function (e) { if (seasons.indexOf(e.season) < 0) seasons.push(e.season); });
      if (state.season === undefined) state.season = next.season || seasons[0];
      var playable = t.ready && (!show || t.episodes.length);
      var resume = next.position > 5;
      var playLabel = (resume ? "Resume" : "Play") + (show ? " " + watchLabel({ kind: "show", season: next.season, episode: next.episode }) : "");
      var meta = [t.year ? esc(t.year) : "", t.runtime ? esc(t.runtime) : "",
        t.rating ? '<span class="star">' + icon("star") + esc(t.rating) + "</span>" : "",
        show && seasons.length ? seasons.length + (seasons.length === 1 ? " season" : " seasons") : "",
        resume ? esc(clock(next.position)) + " in" : ""].filter(Boolean);
      var actions = !playable ? "" : '<button class="primary" id="play" data-autofocus>' + icon("play") + esc(playLabel) + "</button>" +
        (resume ? iconButton("restart", "restart", "From the start") : "") + '<button id="versions">Versions</button>';
      var body = '<div id="versions-box"></div>';
      if (show && t.episodes.length) {
        body += '<div class="tabs" id="seasons" data-row>' + seasons.map(function (s) {
          return '<button data-season="' + s + '" aria-pressed="' + (s === state.season) + '">Season ' + s + "</button>";
        }).join("") + "</div>" + episodeRail();
      }
      if (!paint(view, detailHtml({ name: t.name, poster: t.poster, background: t.background || t.poster, meta: meta,
        genres: (t.genres || []).slice(0, 5).join(", "), description: t.description, actions: actions, body: body,
        note: t.ready ? "Streams from Usenet through this server." : show && !t.episodes.length ? "Not out yet."
          : "Playing this needs a Usenet indexer and sidecar (NEWZNAB_INDEXERS and USENET_DAV_URL)." }))) return;

      function play(season, episode, extra) {
        if (!t.ready) return;
        var u = { kind: t.kind, id: t.id, season: season, episode: episode };
        if (extra && extra.release) u.release = extra.release;
        Player.open({ usenet: u, start: extra && extra.start });
      }
      function find(card) {
        var at = card.getAttribute("data-ep").split(".");
        return t.episodes.filter(function (e) { return e.season === +at[0] && e.episode === +at[1]; })[0];
      }
      function episodes() {
        $("#episodes").style.transform = "";
        $("#episodes").removeAttribute("data-last");
        $("#episodes").innerHTML = t.episodes.filter(function (e) { return e.season === state.season; }).map(function (e) {
          return episodeCard({ attr: 'data-ep="' + e.season + "." + e.episode + '"', thumbnail: e.thumbnail || t.background, num: "E" + e.episode,
            name: e.name || "Episode " + e.episode, sub: e.aired, position: e.position, duration: e.duration, completed: e.completed });
        }).join("");
        $$("#episodes .ep").forEach(function (b) {
          b.onclick = function () { var e = find(b); play(e.season, e.episode); };
        });
        var current = $('#episodes [data-ep="' + next.season + "." + next.episode + '"]');
        if (current) $("#episodes").setAttribute("data-last", String($$("#episodes .ep").indexOf(current)));
      }
      if ($("#episodes")) {
        episodes();
        bindEpisodeDetail(function (card) {
          var e = find(card);
          return "<h3>" + esc(watchLabel({ kind: "show", season: e.season, episode: e.episode })) + (e.name ? " · " + esc(e.name) : "") + "</h3>" +
            '<div class="meta small">' + (e.aired ? "<span>" + esc(e.aired) + "</span>" : "") +
            (e.completed ? "<span>Watched</span>" : e.position ? "<span>" + clock(e.duration - e.position) + " left</span>" : "") + "</div>" +
            (e.overview ? "<p>" + esc(e.overview) + "</p>" : "");
        });
        $$("#seasons button").forEach(function (b) {
          b.onclick = function () {
            state.season = +b.getAttribute("data-season");
            $$("#seasons button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
            episodes();
          };
        });
      }
      if ($("#play")) $("#play").onclick = function () { play(next.season, next.episode); };
      if ($("#restart")) $("#restart").onclick = function () { play(next.season, next.episode, { start: 0 }); };
      // Every release of the film, or of the episode Play would start, best picture first.
      if ($("#versions")) $("#versions").onclick = function () {
        var box = $("#versions-box");
        box.innerHTML = '<div class="box"><p class="empty small">Looking on Usenet…</p></div>';
        api("/api/usenet/releases/" + path + "?season=" + next.season + "&episode=" + next.episode).then(function (data) {
          if (!box.isConnected) return;
          box.innerHTML = '<div class="box"><h3 style="margin-top:0">Versions</h3>' + (data.releases.length
            ? '<div class="versions">' + data.releases.slice(0, 30).map(function (r, i) {
              var tags = [r.resolution, r.source].concat(r.tags).filter(Boolean).map(function (x) { return '<span class="tag">' + esc(x) + "</span>"; }).join("");
              return '<button data-i="' + i + '">' + tags + "<span>" + esc(r.name) + "</span><span>" + size(r.size) + "</span></button>";
            }).join("") + "</div>" : '<p class="empty small">Nothing on Usenet yet.</p>') + "</div>";
          $$("button", box).forEach(function (b) {
            b.onclick = function () { play(next.season, next.episode, { release: data.releases[+b.getAttribute("data-i")].id }); };
          });
          if ($("button", box)) focusEl($("button", box));
        }).catch(function (err) { box.innerHTML = ""; fail(err); });
      };
      if (query.play) { // from a Continue Watching card
        history.replaceState(null, "", "#/watch/" + path);
        play(+query.play.split(".")[0], +query.play.split(".")[1]);
      }
    });
  }
  viewWatch.state = {};

  function filesHtml(item) {
    if (!item || ME.role !== "admin") return "";
    return '<div class="box list-only"><h3 style="margin-top:0">' + esc(item.label || "Files") + "</h3><ul class=\"files\">" +
      item.files.map(function (f) {
        var tech = [f.video, f.height ? f.height + "p" : "", f.hdr ? "HDR" : "", (f.audio || []).map(function (a) { return a.codec + (a.lang ? " " + a.lang : ""); }).join(" / "), size(f.size)]
          .filter(Boolean).join(" · ");
        return "<li>" + esc(f.name) + (f.missing ? ' <span class="pill">missing</span>' : "") +
          '<br><span class="small">' + esc(tech) + '</span> <button class="small ghost" data-fix="' + f.id + '">' + icon("edit") + "Fix match</button></li>";
      }).join("") + "</ul></div>";
  }
  function bindFixButtons() {
    $$("[data-fix]").forEach(function (b) {
      b.onclick = function () {
        var holder = document.createElement("div");
        b.parentNode.appendChild(holder);
        assignForm(holder, {}, function (body) {
          return api("/api/admin/files/" + b.getAttribute("data-fix") + "/assign", { method: "POST", body: body })
            .then(function (r) { toast("File moved"); return api("/api/items/" + r.item_id + "/watched", { method: "POST", body: { watched: false } }).catch(function () {}); })
            .then(function () { location.hash = "#/"; });
        });
      };
    });
  }

  function assignForm(holder, initial, submit) {
    holder.innerHTML = '<form class="box"><div class="form-grid">' +
      '<label>Type<select name="kind"><option value="movie">Movie</option><option value="show">Show</option></select></label>' +
      '<label>Name<input name="name" required value="' + esc(initial.name || "") + '"></label>' +
      '<label>Year<input name="year" inputmode="numeric" value="' + esc(initial.year || "") + '"></label>' +
      '<label>Season<input name="season" inputmode="numeric"></label>' +
      '<label>Episode<input name="episode" inputmode="numeric"></label></div>' +
      '<button class="primary">Save placement</button> <span class="error"></span></form>';
    var form = $("form", holder);
    form.onsubmit = function (e) {
      e.preventDefault();
      var body = {};
      ["kind", "name", "year", "season", "episode"].forEach(function (k) { body[k] = form.elements[k].value.trim(); });
      submit(body).catch(function (err) { $(".error", form).textContent = err.message; });
    };
    form.elements.name.focus();
  }

  function collectBox(t) {
    var box = $("#collect-box");
    if (box.innerHTML) { box.innerHTML = ""; return; }
    api("/api/collections").then(function (list) {
      box.innerHTML = '<div class="box"><h2>Collections</h2><div class="row">' + list.map(function (c) {
        var has = c.titles.indexOf(t.id) >= 0;
        return '<button data-col="' + c.id + '" aria-pressed="' + has + '">' + esc(c.name) + "</button>";
      }).join("") + '</div><form class="row" style="margin-top:14px"><input name="name" placeholder="New collection" style="max-width:280px"><button>Create</button></form></div>';
      $$("[data-col]", box).forEach(function (b) {
        b.onclick = function () {
          var on = b.getAttribute("aria-pressed") !== "true";
          api("/api/collections/" + b.getAttribute("data-col"), { method: "PATCH", body: on ? { add: t.id } : { remove: t.id } })
            .then(function () { b.setAttribute("aria-pressed", String(on)); }).catch(fail);
        };
      });
      $("form", box).onsubmit = function (e) {
        e.preventDefault();
        api("/api/collections", { method: "POST", body: { name: e.target.elements.name.value, titles: [t.id] } })
          .then(function () { box.innerHTML = ""; collectBox(t); }).catch(fail);
      };
    }).catch(fail);
  }

  function editBox(id) {
    var box = $("#edit-box");
    if (box.innerHTML) { box.innerHTML = ""; return; }
    api("/api/admin/titles/" + id).then(function (t) {
      var fields = [["name", "Name"], ["year", "Year"], ["imdb_id", "IMDb ID"], ["poster", "Poster URL"],
                    ["background", "Backdrop URL"], ["genres", "Genres (comma separated)"]];
      function lock(f) {
        return t.locked_fields.indexOf(f) >= 0 ? ' <span class="lock">🔒 locked</span> <button type="button" class="small" data-unlock="' + f + '">Unlock</button>' : "";
      }
      box.innerHTML = '<form class="box"><h2>Edit details</h2><p class="muted small">Edited fields are locked so metadata refreshes never overwrite them.' +
        " Matched: " + (t.matched === 1 ? "yes" : t.matched === -1 ? "no match found" : "not yet") + "</p>" +
        '<div class="form-grid">' + fields.map(function (f) {
          var value = f[0] === "genres" ? (t.genres || []).join(", ") : t[f[0]];
          return "<label>" + f[1] + lock(f[0]) + '<input name="' + f[0] + '" value="' + esc(value == null ? "" : value) + '"></label>';
        }).join("") + "</div><label>Description" + lock("description") + '<textarea name="description" rows="4">' + esc(t.description || "") + "</textarea></label>" +
        '<div class="row"><button class="primary">Save</button><button type="button" id="refresh">Refresh from Cinemeta</button><span class="error"></span></div>' +
        '<h3>Find the right match</h3><div class="row"><input id="msearch" placeholder="Search Cinemeta" value="' + esc(t.name) + '" style="max-width:320px"><button type="button" id="msearch-go">Search</button></div><div id="mresults"></div></form>';
      var form = $("form", box);
      form.onsubmit = function (e) {
        e.preventDefault();
        var body = {};
        fields.concat([["description"]]).forEach(function (f) {
          var value = form.elements[f[0]].value.trim();
          var before = f[0] === "genres" ? (t.genres || []).join(", ") : (t[f[0]] == null ? "" : String(t[f[0]]));
          if (value !== before) body[f[0]] = value;
        });
        api("/api/admin/titles/" + id, { method: "PATCH", body: body }).then(function () { toast("Saved"); route(); })
          .catch(function (err) { $(".error", form).textContent = err.message; });
      };
      $$("[data-unlock]", form).forEach(function (b) {
        b.onclick = function () {
          api("/api/admin/titles/" + id, { method: "PATCH", body: { unlock: [b.getAttribute("data-unlock")] } })
            .then(function () { box.innerHTML = ""; editBox(id); }).catch(fail);
        };
      });
      $("#refresh").onclick = function () {
        api("/api/admin/titles/" + id + "/refresh", { method: "POST" }).then(function () { toast("Refreshed"); route(); }).catch(fail);
      };
      $("#msearch-go").onclick = function () {
        api("/api/admin/metadata/search?kind=" + t.kind + "&q=" + encodeURIComponent($("#msearch").value)).then(function (list) {
          $("#mresults").innerHTML = list.length ? list.map(function (m) {
            return '<button type="button" class="match" data-imdb="' + esc(m.imdb_id) + '">' + (m.poster ? '<img alt="" src="' + esc(m.poster) + '">' : "") +
              "<span>" + esc(m.name) + " (" + esc(m.year || "?") + ')<br><span class="small muted">' + esc(m.imdb_id) + "</span></span></button>";
          }).join("") : '<p class="muted">No results.</p>';
          $$("[data-imdb]", box).forEach(function (b) {
            b.onclick = function () {
              api("/api/admin/titles/" + id, { method: "PATCH", body: { imdb_id: b.getAttribute("data-imdb") } })
                .then(function () { toast("Matched"); route(); }).catch(fail);
            };
          });
        }).catch(fail);
      };
    }).catch(fail);
  }

  function viewCollections(_, __, view) {
    return api("/api/collections").then(function (list) {
      paint(view, '<div class="page-head"><h1>Collections</h1></div>' +
        '<form class="row" id="new-col" style="margin-bottom:24px"><input name="name" placeholder="New collection name" style="max-width:320px"><button>' + icon("plus") + "Create</button></form>" +
        (list.length ? '<div style="max-width:760px">' + list.map(function (c) {
          return '<a class="list-row" href="#/collection/' + c.id + '">' + icon("stack") + "<b>" + esc(c.name) + '</b><span class="s">' +
            c.titles.length + " title" + (c.titles.length === 1 ? "" : "s") + "</span></a>";
        }).join("") + "</div>" : '<p class="empty">No collections yet. Add titles from their page with the Collections button.</p>'));
      $("#new-col").onsubmit = function (e) {
        e.preventDefault();
        api("/api/collections", { method: "POST", body: { name: e.target.elements.name.value, titles: [] } }).then(route).catch(fail);
      };
    });
  }

  function viewCollection(id, _, view) {
    return api("/api/collections/" + id).then(function (c) {
      paint(view, '<div class="page-head"><h1>' + esc(c.name) + '</h1><div class="actions" data-row style="margin-top:12px">' +
        (c.cards.length ? '<button id="play-all" class="primary" data-autofocus>' + icon("play") + "Play all</button>" + iconButton("shuffle-all", "shuffle", "Shuffle") : "") +
        iconButton("rename", "edit", "Rename") + iconButton("delete", "close", "Delete") + "</div></div>" +
        (c.cards.length ? '<div class="grid">' + c.cards.map(titleCard).join("") + "</div>" : '<p class="empty">This collection is empty.</p>'));
      function queue(mode) {
        api("/api/queues", { method: "POST", body: { name: c.name, mode: mode, collection: c.id } })
          .then(function (q) { Player.open({ item_id: q.current, queue: q.id }); }).catch(fail);
      }
      if ($("#play-all")) { $("#play-all").onclick = function () { queue("sequential"); }; $("#shuffle-all").onclick = function () { queue("shuffle"); }; }
      $("#rename").onclick = function () {
        var name = prompt("Collection name", c.name);
        if (name) api("/api/collections/" + c.id, { method: "PATCH", body: { name: name } }).then(route).catch(fail);
      };
      $("#delete").onclick = function () {
        if (confirm("Delete " + c.name + "? The titles stay in your library.")) {
          api("/api/collections/" + c.id, { method: "DELETE" }).then(function () { location.hash = "#/collections"; }).catch(fail);
        }
      };
    });
  }

  function choice(name, options, value) {
    return '<div class="choice" data-row data-choice="' + name + '">' + options.map(function (o) {
      return '<button type="button" data-value="' + esc(o[0]) + '" aria-pressed="' + (String(value) === String(o[0])) + '">' + esc(o[1]) + "</button>";
    }).join("") + "</div>";
  }
  var LANGS = [["", "File default"], ["en", "English"], ["ar", "Arabic"], ["da", "Danish"], ["pt", "Portuguese"], ["fr", "French"], ["de", "German"], ["es", "Spanish"], ["it", "Italian"],
               ["ja", "Japanese"], ["nl", "Dutch"], ["ko", "Korean"], ["zh", "Chinese"]];
  // Subtitle look: [preference, label, options]. Keep in step with SUBTITLE_STYLE in library.py.
  var SUB_STYLE = [
    ["subtitle_size", "Size", [["small", "Small"], ["medium", "Medium"], ["large", "Large"], ["xlarge", "Huge"]]],
    ["subtitle_color", "Color", [["white", "White"], ["yellow", "Yellow"], ["cyan", "Cyan"], ["green", "Green"]]],
    ["subtitle_background", "Background", [["none", "Outline"], ["translucent", "Shaded"], ["solid", "Black box"]]],
    ["subtitle_position", "Position", [["low", "Bottom"], ["raised", "Raised"]]],
  ];
  var STYLE_DEFAULT = { subtitle_size: 1, subtitle_color: 0, subtitle_background: 1, subtitle_position: 0 };
  function styleCaptions(prefs) {
    var c = $("#captions");
    SUB_STYLE.forEach(function (s) {
      c.setAttribute("data-" + s[0].slice(9), (prefs && prefs[s[0]]) || s[2][STYLE_DEFAULT[s[0]]][0]);
    });
  }

  function viewSettings(_, __, view) {
    return api("/api/preferences").then(function (p) {
      paint(view, '<div class="page-head"><h1>Settings</h1></div>' +
        '<div class="box"><h2>Playback</h2>' +
        "<h3>Audio language</h3>" + choice("audio_language", LANGS, p.audio_language) +
        "<h3>Subtitles</h3>" + choice("subtitle_mode", [["off", "Off"], ["auto", "Automatic"], ["always", "Always on"]], p.subtitle_mode) +
        '<p class="muted small">Automatic shows forced subtitles, and full subtitles when the audio is not in your subtitle language.</p>' +
        "<h3>Subtitle language</h3>" + choice("subtitle_language", [["", "Same as audio"]].concat(LANGS.slice(1)), p.subtitle_language) +
        SUB_STYLE.map(function (s) { return "<h3>Subtitle " + s[1].toLowerCase() + "</h3>" + choice(s[0], s[2], p[s[0]]); }).join("") +
        "<h3>Maximum quality</h3>" + choice("max_height", [[2160, "4K"], [1080, "1080p"], [720, "720p"], [480, "480p"]], p.max_height) +
        "<h3>Surround sound</h3>" + choice("stereo", [[false, "Keep surround"], [true, "Downmix to stereo"]], p.stereo) +
        "<h3>Play next episode automatically</h3>" + choice("autoplay_next", [[true, "On"], [false, "Off"]], p.autoplay_next) +
        "</div>" +
        '<div class="box"><h2>Account</h2><p>' + esc(ME.name) + " · " + esc(ME.email) + "</p>" +
        '<form id="pw" class="list-only"><div class="form-grid"><label>Current password<input type="password" name="current" autocomplete="current-password"></label>' +
        '<label>New password<input type="password" name="password" autocomplete="new-password" minlength="10"></label></div>' +
        '<button>Change password</button> <span class="error"></span></form>' +
        '<p><button id="logout">' + icon("logout") + "Sign out</button></p></div>");
      $$("[data-choice]").forEach(function (group) {
        $$("button", group).forEach(function (b) {
          b.onclick = function () {
            var raw = b.getAttribute("data-value"), value = raw === "true" ? true : raw === "false" ? false : /^\d+$/.test(raw) ? +raw : raw;
            var body = {};
            body[group.getAttribute("data-choice")] = value;
            api("/api/preferences", { method: "PUT", body: body }).then(function (saved) {
              ME.preferences = saved;
              $$("button", group).forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
            }).catch(fail);
          };
        });
      });
      $("#pw").onsubmit = function (e) {
        e.preventDefault();
        api("/api/me/password", { method: "POST", body: { current: e.target.elements.current.value, password: e.target.elements.password.value } })
          .then(function () { toast("Password changed"); e.target.reset(); })
          .catch(function (err) { $(".error", e.target).textContent = err.message; });
      };
      $("#logout").onclick = function () { api("/api/logout", { method: "POST" }).then(function () { ME = null; showLogin(); }); };
    });
  }

  function viewAdmin(_, __, view) {
    if (ME.role !== "admin") return paint(view, '<p class="empty">Administrators only.</p>');
    return Promise.all([api("/api/admin/overview"), api("/api/admin/review"), api("/api/admin/users")]).then(function (r) {
      var o = r[0], rev = r[1], users = r[2], last = o.scan.last;
      var html = '<div class="page-head"><h1>Admin</h1><button class="primary" id="scan"' + (o.scan.running ? " disabled" : "") + ">" + icon("refresh") +
        (o.scan.running ? "Scanning…" : "Scan library now") + "</button>" + (o.scan.metadata_running ? '<span class="muted" style="margin-left:14px">Fetching metadata…</span>' : "") + "</div>" +
        '<div class="box"><h2>Library</h2>' + ["movies", "shows", "files", "missing", "unmatched", "no_metadata"].map(function (k) {
          return '<span class="stat"><b>' + o.counts[k] + "</b>" + k.replace("_", " ") + "</span>";
        }).join("") +
        '<p class="small muted">Folders: ' + (o.roots.length ? o.roots.map(esc).join(", ") : "none — set LIBRARY_ROOTS") + "<br>" +
        "Hardware acceleration: " + esc(o.settings.hwaccel) + " · Transcode slots: " + o.settings.max_transcodes +
        " · Metadata: " + (o.settings.metadata_online ? "online (Cinemeta)" : "offline") + "</p>" +
        (last ? '<p class="small">Last scan ' + new Date(last.started * 1000).toLocaleString() + " in " + last.seconds + "s: " + last.files + " files, " +
          last.added + " added, " + last.updated + " updated, " + last.missing + " newly missing, " + last.refused + " refused links." +
          (last.errors.length ? '<br><span class="error">' + last.errors.map(esc).join("<br>") + "</span>" : "") + "</p>" : "") + "</div>";
      html += '<div class="box"><h2>Now playing</h2>' + (o.sessions.length ? "<table><tr><th>User</th><th>Mode</th><th>Why</th><th>Age</th></tr>" +
        o.sessions.map(function (s) {
          return "<tr><td>" + s.user_id + '</td><td><span class="pill ' + s.mode + '">' + s.mode + "</span>" + (s.hwaccel ? " " + esc(s.hwaccel) : "") +
            "</td><td>" + esc(s.reasons.join("; ")) + (s.error ? '<br><span class="error">' + esc(s.error) + "</span>" : "") + "</td><td>" + clock(s.age) + "</td></tr>";
        }).join("") + "</table>" : '<p class="muted">No active streams. Direct play does not appear here.</p>') + "</div>";
      html += '<div id="admin-live" class="box"><h2>Live TV</h2><p class="muted">Loading…</p></div>';
      html += '<div class="box"><h2>Needs review</h2>' + (rev.files.length ? "<p class=\"muted small\">Files the scanner could not place. Your placement is remembered across rescans.</p><table>" +
        rev.files.map(function (f) {
          return '<tr><td class="path">' + esc(f.path) + '<br><span class="small muted">' + esc(f.reason) + '</span><div data-holder="' + f.id + '"></div></td><td><button data-assign="' + f.id + '">Place…</button></td></tr>';
        }).join("") + "</table>" : '<p class="muted">Every file is placed.</p>') +
        (rev.titles.length ? "<h3>No metadata match</h3><table>" + rev.titles.map(function (t) {
          return '<tr><td><a href="#/title/' + t.id + '"><u>' + esc(t.name) + "</u></a> " + esc(t.year || "") + ' <span class="pill">' + t.kind + "</span></td></tr>";
        }).join("") + "</table>" : "") +
        (rev.missing.length ? "<h3>Missing files</h3><table>" + rev.missing.map(function (f) {
          return '<tr><td class="path">' + esc(f.path) + "</td></tr>";
        }).join("") + "</table>" : "") + "</div>";
      html += '<div class="box"><h2>People</h2><table><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr>' + users.map(function (u) {
        return "<tr><td>" + esc(u.name) + "</td><td>" + esc(u.email) + "</td><td>" + u.role + (u.active ? "" : " (disabled)") + "</td><td>" +
          (u.id !== ME.id ? '<button data-toggle="' + u.id + '" data-active="' + u.active + '">' + (u.active ? "Disable" : "Enable") + "</button>" : "") + "</td></tr>";
      }).join("") + '</table><form id="add-user"><h3>Add someone</h3><div class="form-grid"><label>Name<input name="name"></label><label>Email<input name="email" type="email"></label>' +
        '<label>Password<input name="password" type="password" minlength="10"></label><label>Role<select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label></div>' +
        '<button>Add</button> <span class="error"></span></form></div>';
      if (!paint(view, html)) return;
      adminLive($("#admin-live"));
      $("#scan").onclick = function () {
        api("/api/admin/scan", { method: "POST" }).then(function () {
          toast("Scan started");
          $("#scan").disabled = true;
          $("#scan").textContent = "Scanning…";
          var view = VIEW;
          var poll = setInterval(function () {
            if (view !== VIEW) return clearInterval(poll);
            api("/api/admin/overview").then(function (x) {
              if (!x.scan.running && !x.scan.metadata_running) { clearInterval(poll); route(); }
            }).catch(function () { clearInterval(poll); });
          }, 1500);
        }).catch(fail);
      };
      $$("[data-assign]").forEach(function (b) {
        b.onclick = function () {
          var id = b.getAttribute("data-assign");
          assignForm($('[data-holder="' + id + '"]'), {}, function (body) {
            return api("/api/admin/review/" + id + "/assign", { method: "POST", body: body }).then(function () { toast("Placed"); route(); });
          });
        };
      });
      $$("[data-toggle]").forEach(function (b) {
        b.onclick = function () {
          api("/api/admin/users/" + b.getAttribute("data-toggle"), { method: "PATCH", body: { active: b.getAttribute("data-active") !== "1" } }).then(route).catch(fail);
        };
      });
      $("#add-user").onsubmit = function (e) {
        e.preventDefault();
        var f = e.target.elements;
        api("/api/admin/users", { method: "POST", body: { name: f.name.value, email: f.email.value, password: f.password.value, role: f.role.value } })
          .then(function () { toast("Added " + f.name.value); route(); })
          .catch(function (err) { $(".error", e.target).textContent = err.message; });
      };
    });
  }

  // ---- live sports: the day's matches with the channels that show them, and every channel ----
  var LIVE = { day: 0, sport: "", tab: "schedule", q: "", lang: null };
  function liveLang(value) {
    try {
      if (value !== undefined) localStorage.setItem("mediawan.liveLang", value);
      return localStorage.getItem("mediawan.liveLang") || "";
    } catch (e) { return value || ""; }
  }
  function hhmm(epoch) {
    var d = new Date(epoch * 1000);
    return (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
  }
  function channelButton(c, extra) {
    var logo = c.logo ? '<img alt="" src="' + esc(c.logo) + '" onerror="this.remove()">' : '<span class="ch-dot">' + icon("live") + "</span>";
    var tip = c.source === "competition" ? "Carries this competition; the guide does not say which match" : c.programme || "";
    return '<button class="ch' + (c.source === "competition" ? " maybe" : "") + '" data-ch="' + esc(c.id) + '"' + (tip ? ' title="' + esc(tip) + '"' : "") + (extra || "") + ">" +
      logo + '<span class="ch-text"><b>' + esc(c.name) + '</b><span class="s">' + esc([c.language === "Unspecified" ? "" : c.language, c.quality === "Auto" ? "" : c.quality].filter(Boolean).join(" · ")) + "</span></span></button>";
  }
  function teamLine(e) {
    if (!e.teams.length) return '<div class="ev-title">' + esc(e.title) + "</div>" + (e.subtitle ? '<div class="ev-sub">' + esc(e.subtitle) + "</div>" : "");
    var showScore = e.state !== "upcoming" && e.teams[0].score !== null && e.teams[0].score !== undefined;
    return '<div class="ev-teams">' + e.teams.map(function (t, i) {
      var crest = t.logo ? '<img alt="" src="' + esc(t.logo) + '" onerror="this.remove()">' : "";
      return '<span class="team' + (i ? " away" : "") + '">' + (i ? "" : crest) + "<b>" + esc(t.name) + "</b>" + (i ? crest : "") + "</span>" +
        (i === 0 ? '<span class="score">' + (showScore ? esc(e.teams[0].score) + " – " + esc(e.teams[1].score) : "v") + "</span>" : "");
    }).join("") + "</div>";
  }
  function eventRow(e) {
    var comp = e.competition, when = e.state === "live" ? '<span class="pill live">LIVE</span>' : hhmm(e.start);
    var detail = e.state === "live" && e.detail && !/^\d{1,2}:\d{2}/.test(e.detail) ? e.detail : e.state === "finished" ? (e.detail || "Ended") : "";
    var chans = e.state === "finished" ? "" : e.channels.length
      ? '<div class="ev-channels" data-row>' + e.channels.slice(0, 4).map(function (c) { return channelButton(c); }).join("") +
        (e.channels.length > 4 ? '<button class="ch more" data-more="' + esc(e.id) + '">+' + (e.channels.length - 4) + " more</button>" : "") + "</div>"
      : '<p class="small muted">None of your channels lists this.</p>';
    return '<div class="event" data-state="' + e.state + '" data-id="' + esc(e.id) + '"><div class="ev-time">' + when + (detail ? '<span class="s">' + esc(detail) + "</span>" : "") + "</div>" +
      '<div class="ev-main"><div class="ev-comp">' + (comp ? '<span class="comp" style="background:' + esc(comp.color) + '">' + esc(comp.code) + "</span>" + esc(e.league || comp.name) : esc(e.sport)) + "</div>" +
      teamLine(e) + chans + "</div></div>";
  }
  // Coming into a row of choices with the remote lands on the selected one.
  function landOnPressed(root) {
    $$(".choice[data-row]", root).forEach(function (row) {
      row.setAttribute("data-last", String($$("button", row).indexOf($("[aria-pressed='true']", row))));
    });
  }
  function dayStart(offset) {
    var d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
    return d.getTime() / 1000;
  }
  function dayLabel(offset) {
    if (offset === 0) return "Today";
    if (offset === -1) return "Yesterday";
    if (offset === 1) return "Tomorrow";
    return new Date(dayStart(offset) * 1000).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
  }

  function viewSports(_, query, view) {
    if (query.tab) LIVE.tab = query.tab === "channels" ? "channels" : "schedule";
    return api("/api/live").then(function (st) {
      if (!st.enabled) return paint(view, '<p class="empty">Live TV is turned off on this server (LIVE_TV=false).</p>');
      if (!st.channels) {
        return paint(view, '<div class="box" style="margin-top:8vh"><h1>Live sports</h1><p class="muted">No channels yet. ' +
          (ME.role === "admin" ? 'Add your IPTV provider under <a href="#/admin"><u>Admin → Live TV</u></a>.' : "Ask your administrator to add an IPTV provider.") + "</p></div>");
      }
      var lang = LIVE.lang === null ? (LIVE.lang = liveLang()) : LIVE.lang;
      var html = '<div class="page-head"><h1>Live sports</h1><div class="choice" id="live-tabs" data-row>' +
        '<button data-tab="schedule" aria-pressed="' + (LIVE.tab === "schedule") + '">Schedule</button>' +
        '<button data-tab="channels" aria-pressed="' + (LIVE.tab === "channels") + '">Channels</button></div><span class="grow"></span>' +
        '<select id="live-lang" aria-label="Preferred language"><option value="">Any language</option>' + st.languages.filter(function (l) { return l.name !== "Unspecified"; }).map(function (l) {
          return '<option value="' + esc(l.name) + '"' + (l.name === lang ? " selected" : "") + ">" + esc(l.name) + " (" + l.count + ")</option>";
        }).join("") + "</select></div>" +
        (st.watching.length ? '<p class="small muted live-busy">' + icon("live") + "Now streaming: " + st.watching.map(function (w) { return "<b>" + esc(w.channel.name) + "</b>"; }).join(", ") +
          (st.max_connections === 1 ? " · your provider allows one channel at a time" : "") + "</p>" : "") +
        '<div id="live-body"></div>';
      if (!paint(view, html)) return;
      $$("#live-tabs button").forEach(function (b) {
        b.onclick = function () {
          LIVE.tab = b.getAttribute("data-tab");
          history.replaceState(null, "", "#/sports" + (LIVE.tab === "channels" ? "?tab=channels" : ""));
          $$("#live-tabs button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
          liveBody(view);
        };
      });
      $("#live-lang").onchange = function () { LIVE.lang = liveLang(this.value); liveBody(view); };
      return liveBody(view);
    });
  }
  function liveBody(view) {
    var el = $("#live-body");
    if (!el) return;
    return LIVE.tab === "channels" ? liveChannels(el, view) : liveSchedule(el, view);
  }
  function liveSchedule(el, view) {
    var days = [];
    for (var i = -1; i <= 5; i++) days.push(i);
    el.innerHTML = '<div class="live-filters"><div class="choice" id="live-days" data-row>' + days.map(function (d) {
      return '<button data-day="' + d + '" aria-pressed="' + (d === LIVE.day) + '">' + esc(dayLabel(d)) + "</button>";
    }).join("") + '</div><div class="choice" id="live-sports" data-row></div></div><div id="live-events"><p class="empty small">Loading the schedule…</p></div>';
    $$("#live-days button").forEach(function (b) {
      b.onclick = function () {
        LIVE.day = +b.getAttribute("data-day");
        $$("#live-days button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        load();
      };
    });
    var events = [];
    function draw() {
      var sports = [];
      events.forEach(function (e) { if (sports.indexOf(e.sport) < 0) sports.push(e.sport); });
      sports.sort(function (a, b) { return (a === "Other") - (b === "Other") || (a < b ? -1 : 1); });
      if (LIVE.sport && sports.indexOf(LIVE.sport) < 0) LIVE.sport = "";
      $("#live-sports").innerHTML = sports.length > 1 ? ["", ].concat(sports).map(function (s) {
        return '<button data-sport="' + esc(s) + '" aria-pressed="' + (s === LIVE.sport) + '">' + esc(s || "All sports") + "</button>";
      }).join("") : "";
      $$("#live-sports button").forEach(function (b) {
        b.onclick = function () { LIVE.sport = b.getAttribute("data-sport"); draw(); focusEl($('#live-sports [data-sport="' + LIVE.sport + '"]')); };
      });
      var shown = events.filter(function (e) { return !LIVE.sport || e.sport === LIVE.sport; });
      var groups = [["live", "On now"], ["upcoming", "Coming up"], ["finished", "Finished"]];
      var html = groups.map(function (g) {
        var list = shown.filter(function (e) { return e.state === g[0]; });
        return list.length ? '<section class="ev-group"><h2>' + g[1] + ' <span class="count">' + list.length + "</span></h2>" + list.map(eventRow).join("") + "</section>" : "";
      }).join("");
      $("#live-events").innerHTML = html || '<p class="empty">Nothing on the schedule' + (LIVE.sport ? " for " + esc(LIVE.sport) : "") +
        '. <button class="ghost" id="to-channels">Browse channels</button></p>';
      landOnPressed(main);
      $$("#live-events [data-ch]").forEach(function (b) { b.onclick = function () { watchChannel(b.getAttribute("data-ch")); }; });
      $$("#live-events [data-more]").forEach(function (b) {
        b.onclick = function () {
          var e = events.filter(function (x) { return x.id === b.getAttribute("data-more"); })[0];
          var row = b.parentNode;
          row.innerHTML = e.channels.map(function (c) { return channelButton(c); }).join("");
          $$("[data-ch]", row).forEach(function (x) { x.onclick = function () { watchChannel(x.getAttribute("data-ch")); }; });
          focusEl($$("[data-ch]", row)[4] || $("[data-ch]", row));
        };
      });
      if ($("#to-channels")) $("#to-channels").onclick = function () { $('#live-tabs [data-tab="channels"]').click(); };
    }
    function load() {
      var start = dayStart(LIVE.day), want = LIVE.day + "|" + LIVE.lang;
      return api("/api/live/schedule?start=" + start + "&end=" + (start + 86400) + "&language=" + encodeURIComponent(LIVE.lang || "")).then(function (data) {
        if (view !== VIEW || LIVE.day + "|" + LIVE.lang !== want || !$("#live-events")) return;
        events = data.events;
        draw();
      }).catch(function (err) { if ($("#live-events")) $("#live-events").innerHTML = '<p class="error">' + esc(err.message) + "</p>"; });
    }
    // Scores and "On now" move on: refresh today's schedule every minute while it is open.
    var timer = setInterval(function () {
      if (view !== VIEW || !$("#live-events")) return clearInterval(timer);
      if (LIVE.tab === "schedule" && LIVE.day === 0 && $("#player").hidden && !document.activeElement.closest(".ev-channels")) load();
    }, 60000);
    return load();
  }
  function liveChannels(el, view) {
    el.innerHTML = '<div class="search-field">' + icon("search") + '<input id="ch-q" type="search" placeholder="Search channels: beIN, Sky Sports, Eurosport…" autocomplete="off" value="' + esc(LIVE.q) + '"></div>' +
      '<div id="ch-list" class="ch-grid"></div><div id="ch-more"></div>';
    var input = $("#ch-q"), timer = null, offset = 0;
    function row(c) {
      return '<button class="ch-row" data-ch="' + esc(c.id) + '">' + (c.logo ? '<img alt="" src="' + esc(c.logo) + '" onerror="this.remove()">' : '<span class="ch-dot">' + icon("live") + "</span>") +
        '<span class="ch-text"><b>' + esc(c.name) + '</b><span class="s">' + esc(c.now ? hhmm(c.now.start) + " " + c.now.title : c.group || "") + "</span>" +
        '<span class="s">' + esc([c.language === "Unspecified" ? "" : c.language, c.quality === "Auto" ? "" : c.quality].filter(Boolean).join(" · ")) + "</span></span></button>";
    }
    function load(more) {
      var q = input.value.trim();
      LIVE.q = q;
      if (!more) offset = 0;
      return api("/api/live/channels?q=" + encodeURIComponent(q) + "&language=" + encodeURIComponent(LIVE.lang || "") + "&offset=" + offset + "&limit=60").then(function (data) {
        if (view !== VIEW || input.value.trim() !== q) return;
        var list = $("#ch-list");
        if (!more) list.innerHTML = "";
        list.insertAdjacentHTML("beforeend", data.channels.map(row).join(""));
        offset += data.channels.length;
        $$("[data-ch]", list).forEach(function (b) { b.onclick = function () { watchChannel(b.getAttribute("data-ch")); }; });
        $("#ch-more").innerHTML = offset < data.total ? '<button id="ch-more-btn">Show more channels (' + (data.total - offset) + ")</button>" : "";
        if ($("#ch-more-btn")) $("#ch-more-btn").onclick = function () { var at = offset; load(true).then(function () { focusEl($$("#ch-list [data-ch]")[at]); }); };
        if (!data.total) list.innerHTML = '<p class="empty">No channel matches' + (LIVE.lang ? " in " + esc(LIVE.lang) : "") + ".</p>";
      }).catch(fail);
    }
    input.oninput = function () { clearTimeout(timer); timer = setTimeout(function () { load(); }, 250); };
    return load();
  }
  function watchChannel(id) { Player.open({ live: { channel_id: id } }); }

  // Admin → Live TV: the provider, its guide and what is streaming right now.
  function adminLive(el) {
    if (!el) return;
    api("/api/admin/live").then(function (d) {
      var a = d.account, g = d.guide, html = "<h2>Live TV</h2>";
      if (d.channels) {
        var left = a && a.expires ? Math.ceil((a.expires * 1000 - Date.now()) / 86400000) : null;
        html += '<span class="stat"><b>' + d.channels + '</b>channels</span><span class="stat"><b>' + g.channels + '</b>with a TV guide</span>' +
          '<span class="stat"><b>' + d.max_connections + "</b>at a time</span>" +
          "<p>" + esc(d.name || "Channels") + (d.imported ? ' <span class="muted small">imported ' + new Date(d.imported).toLocaleDateString() + "</span>" : "") + "</p>" +
          (a && a.kind === "xtream" ? "<p>Provider <b>" + esc(a.server) + "</b>: " + (a.active ? '<span class="good">active</span>' : '<span class="error">' + esc(a.status) + "</span>") +
            (a.expires ? " · subscription ends " + new Date(a.expires * 1000).toLocaleDateString() +
              (left !== null && left <= 14 ? ' <span class="error">(' + (left <= 0 ? "expired" : left + " days left") + ")</span>" : "") : "") +
            (a.max_connections ? " · " + a.max_connections + " connection" + (a.max_connections === 1 ? "" : "s") + " allowed" : "") + "</p>" : "") +
          '<form id="live-conn" class="inline-form"><label>Channels at a time <input name="n" type="number" min="1" max="20" value="' + d.max_connections + '"></label> <button>Save</button></form>' +
          "<h3>TV guides</h3>" + (g.sources.length ? "<table>" + g.sources.map(function (s) {
            return '<tr><td class="path">' + esc(s.url) + "</td><td>" + (s.ok ? s.channels + " channels" : '<span class="error">' + esc(s.error) + "</span>") + "</td></tr>";
          }).join("") + "</table>" : '<p class="muted">Not fetched yet.</p>') +
          '<p class="small muted">' + (g.updated ? "Updated " + new Date(g.updated * 1000).toLocaleString() + ". " : "") + "Guides refresh every six hours. Fixtures come from ESPN" + (d.fixtures ? "." : " (turned off).") + "</p>" +
          '<button id="live-guide"' + (g.running ? " disabled" : "") + ">" + icon("refresh") + (g.running ? "Refreshing…" : "Refresh guides now") + "</button>" +
          "<h3>Streaming now</h3>" + (d.streams.length ? "<table>" + d.streams.map(function (s) {
            return "<tr><td>" + esc(s.channel.name) + '</td><td><span class="pill ' + (s.video === "copy" ? "remux" : "transcode") + '">' + s.video + "</span></td><td>" + s.viewers + " watching · " + clock(s.age) +
              (s.restarts ? " · " + s.restarts + " reconnects" : "") + (s.error ? '<br><span class="error">' + esc(s.error) + "</span>" : "") + '</td><td><button data-end="' + esc(s.id) + '">End</button></td></tr>';
          }).join("") + "</table>" : '<p class="muted">Nothing is streaming.</p>');
      } else {
        html += '<p class="muted">No channels yet. Import your IPTV provider below.</p>';
      }
      html += "<h3>" + (d.channels ? "Import again (replaces the list)" : "Import channels") + '</h3><form id="live-xtream"><div class="form-grid">' +
        '<label>Server<input name="server" placeholder="http://provider.example:8080" required></label>' +
        '<label>Username<input name="username" autocomplete="off" required></label><label>Password<input name="password" type="password" autocomplete="new-password" required></label></div>' +
        '<label class="check"><input type="checkbox" name="everything"> All channels, not only sports</label> <button class="primary">Import from Xtream Codes</button> <span class="error"></span></form>' +
        '<form id="live-m3u"><label>Or an M3U playlist file<input type="file" name="file" accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain"></label> <button>Import playlist</button> <span class="error"></span></form>' +
        '<p class="small muted">Saved on the server in ' + esc(d.folder) + "; the browser never sees channel addresses or the provider password.</p>";
      el.innerHTML = html;
      el.className = "box";
      if ($("#live-guide")) $("#live-guide").onclick = function () {
        var button = this;
        button.disabled = true;
        api("/api/admin/live/guide", { method: "POST" }).then(function () {
          toast("Refreshing the TV guides…");
          setTimeout(function () { adminLive(el); }, 10000);
        }).catch(function (err) { button.disabled = false; fail(err); });
      };
      if ($("#live-conn")) $("#live-conn").onsubmit = function (e) {
        e.preventDefault();
        api("/api/admin/live/settings", { method: "POST", body: { max_connections: +e.target.elements.n.value } }).then(function () { toast("Saved"); adminLive(el); }).catch(fail);
      };
      $$("[data-end]", el).forEach(function (b) {
        b.onclick = function () { api("/api/admin/live/streams/" + b.getAttribute("data-end"), { method: "DELETE" }).then(function () { adminLive(el); }).catch(fail); };
      });
      $("#live-xtream").onsubmit = function (e) {
        e.preventDefault();
        var f = e.target.elements, err = $(".error", e.target), btn = $("button", e.target);
        err.textContent = ""; btn.disabled = true; btn.textContent = "Importing…";
        api("/api/admin/live/xtream", { method: "POST", body: { server: f.server.value, username: f.username.value, password: f.password.value, everything: f.everything.checked } })
          .then(function (r) { toast("Imported " + r.channels + " channels. Fetching the TV guides…"); adminLive(el); })
          .catch(function (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = "Import from Xtream Codes"; });
      };
      $("#live-m3u").onsubmit = function (e) {
        e.preventDefault();
        var file = e.target.elements.file.files[0], err = $(".error", e.target);
        if (!file) { err.textContent = "Choose a playlist file first"; return; }
        var reader = new FileReader();
        reader.onload = function () {
          api("/api/admin/live/m3u", { method: "POST", body: { text: reader.result, name: file.name.replace(/\.[^.]+$/, "") } })
            .then(function (r) { toast("Imported " + r.channels + " channels"); adminLive(el); })
            .catch(function (x) { err.textContent = x.message; });
        };
        reader.readAsText(file);
      };
    }).catch(function (err) { el.innerHTML = '<h2>Live TV</h2><p class="error">' + esc(err.message) + "</p>"; el.className = "box"; });
  }

  // ---- sign in -------------------------------------------------------------------------
  function showLogin() {
    document.body.classList.add("bare");
    if (!$("#player").hidden) Player.close();
    api("/api/status").then(function (status) {
      var setup = status.setup;
      main.innerHTML = '<form class="box auth" id="auth"><div class="logo">' + icon("logo") + "<b>MEDIAWAN</b></div><h1>" + (setup ? "Welcome" : "Sign in") + "</h1>" +
        (setup ? '<p class="muted">Create the administrator account.</p><label>Name<input name="name" value="Administrator"></label>' : "") +
        '<label>Email<input name="email" type="email" autocomplete="username" required data-autofocus></label>' +
        '<label>Password<input name="password" type="password" autocomplete="' + (setup ? "new-password" : "current-password") + '" required></label>' +
        '<button class="primary">' + (setup ? "Create account" : "Sign in") + '</button><p class="error"></p></form>';
      var form = $("#auth");
      form.onsubmit = function (e) {
        e.preventDefault();
        var f = form.elements, body = { email: f.email.value, password: f.password.value };
        if (setup) body.name = f.name.value;
        api(setup ? "/api/setup" : "/api/login", { method: "POST", body: body }).then(start)
          .catch(function (err) { $(".error", form).textContent = err.message; });
      };
      if (TV) focusEl(form.elements.email); else form.elements.email.focus();
    });
  }

  function start() {
    return api("/api/me").then(function (me) {
      ME = me;
      document.body.classList.remove("bare");
      $("#admin-link").hidden = me.role !== "admin";
      route();
    }).catch(function () { /* showLogin already ran */ });
  }

  // ---- player ----------------------------------------------------------------------------
  var Player = (function () {
    var video = $("#video"), root = $("#player"), panel = $("#p-panel");
    var hls = null, state = {}, uiTimer = null, reportTimer = null, cueTimer = null, pingTimer = null;

    function caps() {
      var ms = window.MediaSource, mse = function (type) { try { return !!(ms && ms.isTypeSupported(type)); } catch (e) { return false; } };
      var tag = function (type) { return !!video.canPlayType(type); };
      var either = function (type) { return mse(type) || tag(type); };
      var v = ["h264"], a = ["aac", "mp3"];
      if (either('video/mp4; codecs="hvc1.1.6.L120.90"') || either('video/mp4; codecs="hev1.1.6.L120.90"')) v.push("hevc");
      if (either('video/mp4; codecs="av01.0.08M.08"')) v.push("av1");
      if (either('video/mp4; codecs="vp09.00.10.08"')) v.push("vp9");
      if (either('audio/mp4; codecs="ac-3"')) a.push("ac3");
      if (either('audio/mp4; codecs="ec-3"')) a.push("eac3");
      if (either('audio/mp4; codecs="opus"')) a.push("opus");
      if (either('audio/mp4; codecs="fLaC"')) a.push("flac");
      var containers = ["mp4"];
      if (tag('video/webm; codecs="vp9, opus"')) containers.push("webm");
      // Audio that survives our fMP4 HLS. hls.js goes through MediaSource, Safari/TVs play HLS natively;
      // Chromium plays an MP3 file yet rejects MP3 inside fMP4 through MediaSource.
      var viaHls = window.Hls && Hls.isSupported() ? mse : tag;
      var hlsAudio = ["aac"];
      [["mp3", 'audio/mp4; codecs="mp4a.6B"'], ["ac3", 'audio/mp4; codecs="ac-3"'], ["eac3", 'audio/mp4; codecs="ec-3"'],
       ["opus", 'audio/mp4; codecs="opus"'], ["flac", 'audio/mp4; codecs="fLaC"']].forEach(function (c) {
        if (viaHls(c[1])) hlsAudio.push(c[0]);
      });
      return { video: v, audio: a, hls_audio: hlsAudio, containers: containers, max_height: screen.height > 1300 || TV ? 2160 : 1080 };
    }
    function absolute() { return (state.offset || 0) + (video.currentTime || 0); }
    function isLive() { return !!(state.info && state.info.live); }
    // Live: the subtitle line shows what is on, from the TV guide.
    function liveSub(programme) {
      var text = programme ? programme.title : (state.info.live.channel.group || "");
      $("#p-sub").innerHTML = '<span class="pill live">LIVE</span> ' + esc(text);
    }
    function livePing() {
      var info = state.info;
      if (!info || !info.live) return;
      api("/api/live/streams/" + info.live.stream + "/ping", { method: "POST", body: { client: CLIENT } }).then(function (r) {
        if (state.info === info) liveSub(r.programme);
      }).catch(function (err) {
        if (state.info !== info || root.hidden) return;
        toast(err.message || "The channel stopped", $("#p-toast"));
        clearInterval(pingTimer);
      });
    }

    function open(request) {
      state = { request: request, queue: request.queue || null, tries: 0 };
      root.hidden = false;
      layers.push(root);
      document.body.style.overflow = "hidden";
      load({ item_id: request.item_id, online: request.online, usenet: request.usenet, live: request.live, start: request.start });
    }

    // The same episode or film again, at another point or with other options.
    function again(extra) {
      var info = state.info, opts = info.live ? { live: { channel_id: info.live.channel.id } }
        : info.usenet ? { usenet: info.usenet, audio: state.audio } : info.online
        ? { online: { anilist_id: info.online.anilist_id, episode: info.online.episode, lang: info.online.lang } }
        : { item_id: info.item.id, audio: state.audio, file_id: info.file_id };
      for (var k in extra) opts[k] = extra[k];
      return load(opts);
    }

    function load(opts) {
      $("#spinner").hidden = false;
      $("#p-skip").hidden = true;
      root.classList.add("paused");
      cancelSeek();
      stopStream(true);
      var request;
      if (opts.live) {
        request = api("/api/live/watch", { method: "POST", body: { channel_id: opts.live.channel_id, client: CLIENT, tv: TV } });
      } else if (opts.online) {
        var o = { anilist_id: opts.online.anilist_id, episode: opts.online.episode, lang: opts.online.lang };
        if (opts.start !== undefined && opts.start !== null) o.start = opts.start;
        request = api("/api/online/play", { method: "POST", body: o });
      } else if (opts.usenet) {
        var u = opts.usenet, b = { kind: u.kind, id: u.id, season: u.season, episode: u.episode, release: u.release, caps: caps(), client: CLIENT };
        if (opts.start !== undefined && opts.start !== null) b.start = opts.start;
        if (opts.audio !== undefined) b.audio = opts.audio;
        if (opts.escalate) b.escalate = opts.escalate;
        request = api("/api/usenet/play", { method: "POST", body: b });
      } else {
        var body = { item_id: opts.item_id, caps: caps(), client: CLIENT };
        if (opts.start !== undefined && opts.start !== null) body.start = opts.start;
        if (opts.audio !== undefined) body.audio = opts.audio;
        if (opts.escalate) body.escalate = opts.escalate;
        if (opts.file_id) body.file_id = opts.file_id;
        request = api("/api/play", { method: "POST", body: body });
      }
      return request.then(function (info) {
        if (root.hidden) { if (info.session) api("/api/sessions/" + info.session, { method: "DELETE" }); return; }
        state.info = info;
        state.offset = info.start;
        state.audio = info.audio_index;
        state.duration = info.duration;
        $("#p-title").textContent = info.item.title_name;
        $("#p-sub").textContent = [info.item.label, info.item.name].filter(Boolean).join(" · ");
        root.classList.toggle("live", info.mode === "live");
        if (info.live) liveSub(info.live.programme);
        $("#p-next").hidden = !(info.next || state.queue);
        var target = info.position - info.start; // time to seek to inside this stream
        attach(info.url, info.mode !== "direct", target > 0.5 ? target : 0);
        chooseSubtitles(info);
        styleCaptions(info.preferences);
        clearInterval(reportTimer);
        reportTimer = setInterval(report, 10000);
        clearInterval(pingTimer);
        if (info.session) pingTimer = setInterval(function () { api("/api/sessions/" + info.session + "/ping", { method: "POST" }).catch(function () {}); }, 20000);
        if (info.live) pingTimer = setInterval(livePing, 15000);
        showUi();
        setTimeout(function () { focusEl($("#p-play")); }, 50);
      }).catch(function (err) {
        $("#spinner").hidden = true;
        toast(err.message, $("#p-toast"));
      });
    }

    function attach(url, isHls, seekTo) {
      var useHls = isHls && window.Hls && Hls.isSupported();
      if (useHls) {
        var config = { startPosition: seekTo || 0, maxBufferLength: 60, backBufferLength: 90, liveDurationInfinity: false,
                       manifestLoadingMaxRetry: 6, levelLoadingMaxRetry: 6, fragLoadingMaxRetry: 6 };
        if (isLive()) { // start three segments behind the live edge: a cushion against provider hiccups
          config.startPosition = -1;
          config.liveSyncDurationCount = 3;
          config.maxBufferLength = 30;
          config.backBufferLength = 60;
        }
        // Online streams come in 1080p/720p/480p: begin at 720p rather than hls.js's cautious
        // 480p guess, then let it adapt to what the NAS's internet link actually delivers.
        if (state.info && state.info.online) config.abrEwmaDefaultEstimate = 3000000;
        hls = new Hls(config);
        hls.on(Hls.Events.ERROR, function (_, data) {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && state.tries < 1) { state.tries++; hls.recoverMediaError(); return; }
          escalate(data.type === Hls.ErrorTypes.MEDIA_ERROR ? "decode" : "network");
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else {
        video.src = url; // direct play, or Safari's native HLS
        if (seekTo) video.addEventListener("loadedmetadata", function once() { video.removeEventListener("loadedmetadata", once); video.currentTime = seekTo; });
      }
      var playing = video.play();
      if (playing && playing.catch) playing.catch(function () { showUi(); });
    }

    function escalate(reason) {
      var mode = state.info && state.info.mode;
      if (mode === "live") { // the provider dropped: join the channel again, a few times
        if (state.tries < 4) {
          state.tries++;
          toast("Reconnecting to the channel…", $("#p-toast"));
          setTimeout(function () { if (!root.hidden && isLive()) again({}); }, 1500);
        } else {
          $("#spinner").hidden = true;
          toast("The channel stopped responding. Try another one.", $("#p-toast"));
        }
        return;
      }
      var next = mode === "direct" ? "remux" : mode === "remux" ? "transcode" : null;
      if (!next || reason === "network" && mode !== "direct") {
        toast("Playback failed. " + (reason === "network" ? "The stream stopped responding." : "This device could not decode the video."), $("#p-toast"));
        $("#spinner").hidden = true;
        return;
      }
      toast(next === "remux" ? "Repackaging the stream for this device…" : "Converting the video for this device…", $("#p-toast"));
      again({ start: absolute(), escalate: next });
    }

    function stopStream(keepUi) {
      if (hls) { hls.destroy(); hls = null; }
      video.removeAttribute("src");
      try { video.load(); } catch (e) { /* ignore */ }
      if (state.info && state.info.session) api("/api/sessions/" + state.info.session, { method: "DELETE" }).catch(function () {});
      if (state.info && state.info.live) {
        api("/api/live/streams/" + state.info.live.stream + "?client=" + encodeURIComponent(CLIENT), { method: "DELETE" }).catch(function () {});
      }
      if (!keepUi) $("#captions").innerHTML = "";
    }

    function report() {
      var info = state.info;
      if (!info || info.live || !video.currentTime) return Promise.resolve();
      if (info.online) {
        var o = info.online;
        return api("/api/online/progress", { method: "POST", body: { anilist_id: o.anilist_id, episode: o.episode, lang: o.lang,
          position: absolute(), duration: state.duration, name: o.name, poster: o.poster, background: o.background, available: o.available } })
          .catch(function () {});
      }
      if (info.usenet) {
        var body = { position: absolute(), duration: state.duration, session: info.session };
        for (var k in info.usenet) body[k] = info.usenet[k];
        return api("/api/usenet/progress", { method: "POST", body: body }).catch(function () {});
      }
      return api("/api/progress", { method: "POST", body: { item_id: info.item.id, position: absolute(), duration: state.duration, session: info.session } })
        .catch(function () {});
    }

    function close() {
      var info = state.info;
      var done = report();
      clearInterval(reportTimer); clearInterval(cueTimer); clearInterval(pingTimer);
      stopStream();
      state = {};
      panel.hidden = true;
      panel.removeAttribute("data-kind");
      root.hidden = true;
      root.classList.remove("ui", "sheet");
      layers = layers.filter(function (l) { return l !== root && l !== panel; });
      document.body.style.overflow = "";
      if (info) done.then(function () { if (!$("#player").hidden) return; route(); });
    }

    function seekTo(target) {
      if (isLive()) return; // live has no timeline to jump around in
      target = Math.max(0, Math.min(target, (state.duration || 0) - 1));
      var info = state.info;
      if (!info || info.mode === "live") return;
      if (info.mode === "direct" || info.mode === "online") { video.currentTime = target; return; } // whole file seekable
      var rel = target - state.offset, end = 0;
      for (var i = 0; i < video.seekable.length; i++) end = Math.max(end, video.seekable.end(i));
      if (rel >= 0 && rel <= end - 1) { video.currentTime = rel; return; }
      // Beyond what the server has prepared: restart the stream at the new point.
      again({ start: target });
    }

    function next() {
      report();
      if (state.info && state.info.online) {
        var o = state.info.online;
        if (state.info.next) load({ online: { anilist_id: o.anilist_id, episode: state.info.next.episode, lang: o.lang }, start: 0 });
        else close();
      } else if (state.info && state.info.usenet) {
        var u = state.info.usenet;
        if (state.info.next) load({ usenet: { kind: u.kind, id: u.id, season: u.next_season, episode: u.next_episode }, start: 0 });
        else close();
      } else if (state.queue) {
        api("/api/queues/" + state.queue + "/step", { method: "POST", body: { step: 1 } }).then(function (q) {
          if (q.current) load({ item_id: q.current, start: 0 }); else close();
        }).catch(fail);
      } else if (state.info && state.info.next) {
        load({ item_id: state.info.next.item_id, start: 0 });
      } else close();
    }

    // subtitles: fetched as WebVTT and drawn by us, so offsets and TVs behave the same
    function chooseSubtitles(info) {
      var p = info.preferences || {}, subs = info.subtitles.filter(function (s) { return s.available; });
      var audio = info.audio.filter(function (a) { return a.index === info.audio_index; })[0];
      var audioLang = audio && audio.lang, want = p.subtitle_language || audioLang || "en";
      var pick = null;
      if (state.subKey !== undefined) {
        pick = subs.filter(function (s) { return s.key === state.subKey; })[0] || null;
      } else if (info.online && info.online.lang === "sub" && p.subtitle_mode !== "off") {
        // Subtitled anime is Japanese audio: subtitles on unless switched off in Settings.
        var mine = p.subtitle_language || "en";
        pick = subs.filter(function (s) { return s.lang === mine; })[0] || subs.filter(function (s) { return s.lang === "en"; })[0] ||
          subs.filter(function (s) { return s.default; })[0] || subs[0] || null;
      } else if (p.subtitle_mode === "always") {
        pick = subs.filter(function (s) { return s.lang === want && !s.forced; })[0] || subs.filter(function (s) { return s.lang === want; })[0] || subs[0] || null;
      } else if (p.subtitle_mode === "auto") {
        pick = subs.filter(function (s) { return s.forced && (!audioLang || s.lang === audioLang || !s.lang); })[0] || null;
        if (!pick && p.subtitle_language && audioLang && audioLang !== p.subtitle_language) {
          pick = subs.filter(function (s) { return s.lang === p.subtitle_language; })[0] || null;
        }
      }
      setSubtitle(pick);
    }
    function parseVtt(text) {
      var cues = [];
      var time = function (t) { var p = t.trim().split(":"); var s = 0; for (var i = 0; i < p.length; i++) s = s * 60 + parseFloat(p[i].replace(",", ".")); return s; };
      text.replace(/\r/g, "").split(/\n\n+/).forEach(function (block) {
        var lines = block.split("\n"), i = 0;
        while (i < lines.length && lines[i].indexOf("-->") < 0) i++;
        if (i >= lines.length) return;
        var parts = lines[i].split("-->");
        var body = lines.slice(i + 1).join("\n").trim();
        if (body) cues.push({ start: time(parts[0]), end: time(parts[1].trim().split(/\s/)[0]), text: body });
      });
      return cues;
    }
    function setSubtitle(sub) {
      state.subKey = sub ? sub.key : null;
      state.cues = [];
      clearInterval(cueTimer);
      $("#captions").innerHTML = "";
      if (!sub) return;
      // Translated tracks answer 202 with progress until the translation is done.
      function fetchVtt() {
        return fetch(sub.url, { credentials: "same-origin" }).then(function (r) {
          if (r.status === 202) {
            return r.json().then(function (p) {
              if (state.subKey !== sub.key) return null;
              var pct = p.total ? Math.round((100 * p.done) / p.total) : 0;
              toast("Translating " + sub.title.replace(/\s*\(translated\)/, "") + " subtitles… " + pct + "%", $("#p-toast"));
              return new Promise(function (done) { setTimeout(done, 1500); }).then(function () {
                return state.subKey === sub.key ? fetchVtt() : null;
              });
            });
          }
          if (!r.ok) {
            return r.json().catch(function () { return {}; }).then(function (p) {
              throw new Error("Subtitles could not be loaded" + (p.detail ? ": " + p.detail : ""));
            });
          }
          if (sub.translated) $("#p-toast").hidden = true;
          return r.text();
        });
      }
      fetchVtt().then(function (text) {
        if (text === null || state.subKey !== sub.key) return;
        state.cues = parseVtt(text);
        var last = "";
        cueTimer = setInterval(function () {
          var t = absolute(), lines = [];
          for (var i = 0; i < state.cues.length; i++) if (state.cues[i].start <= t && state.cues[i].end > t) lines.push(state.cues[i].text);
          var html = lines.map(function (l) {
            return l.split("\n").map(function (x) { return "<span>" + esc(x).replace(/&lt;(\/?)(i|b|u)&gt;/g, "<$1$2>").replace(/&lt;[^&]*&gt;/g, "") + "</span>"; }).join("<br>");
          }).join("<br>");
          if (html !== last) { drawCaptions(html); last = html; }
        }, 120);
      }).catch(function (err) { toast(err.message, $("#p-toast")); });
    }

    function label(track) {
      return [track.title, track.lang ? track.lang.toUpperCase() : "", track.codec === "webvtt" ? "" : track.codec,
        track.channels ? track.channels + "ch" : "", track.forced ? "forced" : ""]
        .filter(Boolean).join(" · ") || "Track " + track.index;
    }
    function option(attrs, pressed, text, disabled) {
      return "<button " + attrs + ' aria-pressed="' + !!pressed + '"' + (disabled ? " disabled" : "") + ">" + icon("check") + "<span>" + text + "</span></button>";
    }
    // One option sheet at a time. Its button toggles it; a click anywhere outside closes it.
    function openPanel(kind, html, bind, focus) {
      panel.innerHTML = html;
      panel.setAttribute("data-kind", kind);
      panel.scrollTop = 0;
      if (panel.hidden) { panel.hidden = false; layers.push(panel); }
      root.classList.add("sheet");
      refreshPreview();
      bind();
      // Up/Down into a row of choices lands on the one that is selected.
      $$("[data-choice]", panel).forEach(function (row) { row.setAttribute("data-last", String($$("button", row).indexOf($("[aria-pressed='true']", row)))); });
      focusEl((focus && $(focus, panel)) || $("[aria-pressed='true']", panel) || $("button", panel));
    }
    function closePanel() {
      if (panel.hidden) return;
      panel.hidden = true;
      panel.removeAttribute("data-kind");
      root.classList.remove("sheet");
      layers = layers.filter(function (l) { return l !== panel; });
      refreshPreview();
      focusEl($("#p-play"));
      showUi();
    }
    function refreshPreview() {
      var c = $("#captions");
      if (!c.textContent || $(".preview", c)) drawCaptions(""); // never over a real subtitle line
    }
    function owns(button) { // the subtitles button owns both the track list and the style sheet
      return !panel.hidden && (" " + button.getAttribute("data-panel") + " ").indexOf(" " + panel.getAttribute("data-kind") + " ") >= 0;
    }
    function togglePanel(button, show) {
      button.onclick = function () { if (owns(button)) closePanel(); else show(); };
    }
    root.addEventListener("click", function (e) {
      if (panel.hidden || panel.contains(e.target)) return;
      var opener = e.target.closest("[data-panel]");
      if (opener && owns(opener)) return; // its own button toggles it shut
      closePanel();
      // Another control (play, audio…) still does its job; a click on the picture only dismisses.
      if (!e.target.closest("button, #p-seek")) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    function audioPanel() {
      var info = state.info;
      openPanel("audio", "<h3>Audio</h3>" + info.audio.map(function (a) {
        return option('data-audio="' + a.index + '"', a.index === state.audio, esc(label(a)));
      }).join("") + (info.audio.length ? "" : "<p>No audio tracks.</p>"), function () {
        $$("[data-audio]", panel).forEach(function (b) {
          b.onclick = function () {
            closePanel();
            var index = +b.getAttribute("data-audio");
            if (index === state.audio) return;
            if (info.online) { // sub and dub are separate streams: switch at the same point
              var o = info.online;
              state.subKey = undefined; // choose again: subtitles on for Japanese audio, off for the dub
              load({ online: { anilist_id: o.anilist_id, episode: o.episode, lang: index === 1 ? "dub" : "sub" }, start: absolute() });
            } else again({ start: absolute(), audio: index });
          };
        });
      });
    }
    function subsPanel(focusStyle) {
      var info = state.info;
      openPanel("subs", "<h3>Subtitles</h3>" + option('data-sub=""', !state.subKey, "Off") + info.subtitles.map(function (s) {
        return option('data-sub="' + s.key + '"', s.key === state.subKey,
          esc(label(s)) + (s.external ? " (file)" : "") + (s.available ? "" : " — picture-based, not supported"), !s.available);
      }).join("") + '<button class="panel-link" id="sub-style">' + icon("sliders") + "<span>Style</span>" + icon("chevron", "end") + "</button>", function () {
        $$("[data-sub]", panel).forEach(function (b) {
          b.onclick = function () {
            var key = b.getAttribute("data-sub");
            setSubtitle(info.subtitles.filter(function (s) { return s.key === key; })[0] || null);
            closePanel();
          };
        });
        $("#sub-style").onclick = stylePanel;
      }, focusStyle === true ? "#sub-style" : null);
    }
    // Subtitle look: applied live over the picture and saved with the user's preferences.
    function stylePanel() {
      var prefs = state.info.preferences || (state.info.preferences = {});
      openPanel("style", '<button class="panel-link" id="style-back">' + icon("back") + "<span>Subtitles</span></button>" +
        "<h3>Subtitle style</h3>" + SUB_STYLE.map(function (s) {
          return "<h4>" + s[1] + "</h4>" + choice(s[0], s[2], prefs[s[0]] || s[2][STYLE_DEFAULT[s[0]]][0]);
        }).join(""), function () {
        $("#style-back").onclick = function () { subsPanel(true); };
        $$("[data-choice]", panel).forEach(function (group) {
          $$("button", group).forEach(function (b) {
            b.onclick = function () {
              var name = group.getAttribute("data-choice"), body = {};
              body[name] = prefs[name] = b.getAttribute("data-value");
              $$("button", group).forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
              styleCaptions(prefs);
              api("/api/preferences", { method: "PUT", body: body }).then(function (saved) { ME.preferences = saved; }).catch(function (err) { toast(err.message, $("#p-toast")); });
            };
          });
        });
      });
    }
    // While the style sheet is open, an empty screen shows a sample line to judge the look by.
    function drawCaptions(html) {
      if (!html && !panel.hidden && panel.getAttribute("data-kind") === "style") {
        html = '<span class="preview">This is how subtitles will look</span>';
      }
      $("#captions").innerHTML = html;
    }
    function infoPanel() {
      var info = state.info;
      openPanel("info", "<h3>Playback</h3><p><span class=\"pill " + info.mode + '">' + info.mode + "</span>" + (info.hwaccel && info.hwaccel !== "none" ? " " + esc(info.hwaccel) : "") + "</p>" +
        info.reasons.map(function (r) { return "<p>• " + esc(r) + "</p>"; }).join("") + '<button style="margin-top:16px">' + icon("close") + "<span>Close</span></button>", function () {
        $("button", panel).onclick = closePanel;
      });
    }

    function showUi() {
      root.classList.add("ui");
      clearTimeout(uiTimer);
      uiTimer = setTimeout(function () { if (!video.paused && panel.hidden && pending === null) root.classList.remove("ui"); }, 4000);
    }
    function togglePlay() { if (video.paused) video.play(); else video.pause(); showUi(); }

    // Seeking with the remote: each Left/Right press moves a preview marker; the jump happens
    // once the presses stop, so ten quick presses are one seek, not ten stream restarts.
    // Holding the button speeds up from 10 s to 30 s to 60 s steps.
    var pending = null, pendingTimer = null, lastNudge = 0, streak = 0;
    function drawSeek(t) {
      var d = state.duration || 0, pct = d ? Math.min(100, (100 * t) / d) : 0;
      $("#p-progress").style.width = pct + "%";
      $("#p-thumb").style.left = pct + "%";
      return pct;
    }
    function bubble(t, pct) {
      var b = $("#p-bubble");
      b.hidden = false;
      b.style.left = pct + "%";
      b.textContent = clock(t);
    }
    function nudge(direction) {
      if (isLive()) return;
      var now = Date.now();
      streak = now - lastNudge < 450 ? streak + 1 : 0;
      lastNudge = now;
      var step = streak > 12 ? 60 : streak > 5 ? 30 : 10;
      var d = state.duration || 0;
      pending = Math.max(0, Math.min((pending === null ? absolute() : pending) + direction * step, Math.max(0, d - 2)));
      bubble(pending, drawSeek(pending));
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(commitSeek, 700);
      showUi();
    }
    function commitSeek() {
      clearTimeout(pendingTimer);
      if (pending === null) return;
      var t = pending;
      pending = null;
      $("#p-bubble").hidden = true;
      seekTo(t);
    }
    function cancelSeek() {
      clearTimeout(pendingTimer);
      pending = null;
      $("#p-bubble").hidden = true;
    }

    function key(name) {
      if (name === "back") {
        if (pending !== null) cancelSeek();
        else if (!panel.hidden && panel.getAttribute("data-kind") === "style") subsPanel(true);
        else if (!panel.hidden) closePanel();
        else close();
        return true;
      }
      if (name === "playpause") { togglePlay(); return true; }
      if (name === "play") { video.play(); showUi(); return true; }
      if (name === "pause") { video.pause(); showUi(); return true; }
      if (name === "stop") { close(); return true; }
      if (name === "ff") { seekTo(absolute() + 30); showUi(); return true; }
      if (name === "rw") { seekTo(absolute() - 10); showUi(); return true; }
      var uiShown = root.classList.contains("ui");
      if (name === "enter" && state.skip && !$("#p-skip").hidden && (!uiShown || document.activeElement === $("#p-skip"))) {
        $("#p-skip").click(); // OK on the remote takes the skip offer, like Plex and Netflix
        return true;
      }
      if (!uiShown) {
        showUi();
        if (isLive() && name !== "enter") focusEl($("#p-play"));
        else if (name === "left" || name === "right") { focusEl($("#p-seek")); nudge(name === "left" ? -1 : 1); }
        else if (name === "enter") togglePlay();
        else if (name === "up") focusEl($("#p-seek"));
        else focusEl($("#p-play"));
        return true;
      }
      showUi();
      if (document.activeElement === $("#p-seek") && (name === "left" || name === "right")) {
        nudge(name === "left" ? -1 : 1);
        return true;
      }
      if (name === "enter" && document.activeElement === $("#p-seek")) {
        if (pending !== null) commitSeek(); else togglePlay();
        return true;
      }
      if (pending !== null && (name === "up" || name === "down")) commitSeek();
      return false; // arrows move between controls, Enter clicks
    }

    // Skip intro / credits: shown over the video, whether or not the controls are up.
    function skipAction(t) {
      var info = state.info;
      if (!info) return null;
      var intro = info.intro, outro = info.outro;
      if (intro && t >= intro.start && t < intro.end - 2) return { text: "Skip intro", run: function () { seekTo(intro.end); } };
      if (outro && t >= outro.start && t < outro.end - 2) {
        if (info.next) return { text: "Next episode", run: next };
        return { text: "Skip credits", run: function () { seekTo(outro.end); } };
      }
      return null;
    }
    function updateSkip(t) {
      var action = skipAction(t), button = $("#p-skip");
      state.skip = action;
      if (!action) { if (!button.hidden) { if (document.activeElement === button) focusEl($("#p-play")); button.hidden = true; } return; }
      button.textContent = action.text;
      button.hidden = false;
    }
    $("#p-skip").onclick = function () { var a = state.skip; if (a) { $("#p-skip").hidden = true; a.run(); } };

    // video events
    video.addEventListener("durationchange", function () {
      // Online streams: the length comes from the playlist, not from the server.
      if (state.info && state.info.online && isFinite(video.duration)) state.duration = video.duration;
    });
    video.addEventListener("timeupdate", function () {
      var t = absolute(), d = state.duration || 0;
      updateSkip(t);
      $("#p-time").textContent = clock(t);
      $("#p-duration").textContent = d ? "-" + clock(d - t) : "";
      if (pending === null) drawSeek(t);
      $("#p-seek").setAttribute("aria-valuenow", String(Math.floor(t)));
      var end = 0;
      for (var i = 0; i < video.buffered.length; i++) end = Math.max(end, video.buffered.end(i));
      $("#p-buffer").style.left = d ? (100 * state.offset) / d + "%" : "0";
      $("#p-buffer").style.width = d ? Math.min(100, (100 * end) / d) + "%" : "0";
    });
    video.addEventListener("playing", function () { $("#spinner").hidden = true; root.classList.remove("paused"); showUi(); });
    video.addEventListener("pause", function () { root.classList.add("paused"); showUi(); report(); });
    video.addEventListener("waiting", function () { $("#spinner").hidden = false; });
    video.addEventListener("canplay", function () { $("#spinner").hidden = true; });
    video.addEventListener("ended", function () {
      report().then(function () {
        var auto = state.info && state.info.preferences && state.info.preferences.autoplay_next;
        if (state.queue || (auto && state.info.next)) next(); else close();
      });
    });
    video.addEventListener("error", function () {
      if (!state.info || root.hidden || !video.error) return;
      escalate(video.error.code === 2 ? "network" : "decode");
    });
    root.addEventListener("mousemove", showUi);
    video.addEventListener("click", togglePlay);
    $("#p-play").onclick = togglePlay;
    $("#p-close").onclick = close;
    $("#p-back10").onclick = function () { seekTo(absolute() - 10); };
    $("#p-fwd30").onclick = function () { seekTo(absolute() + 30); };
    $("#p-next").onclick = next;
    togglePanel($("#p-audio"), audioPanel);
    togglePanel($("#p-subs"), subsPanel);
    togglePanel($("#p-info"), infoPanel);
    function pointerTime(e) {
      var r = $("#p-seek").getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (state.duration || 0);
    }
    $("#p-seek").addEventListener("click", function (e) { cancelSeek(); seekTo(pointerTime(e)); });
    $("#p-seek").addEventListener("mousemove", function (e) { // time under the pointer
      var t = pointerTime(e), d = state.duration || 0;
      if (d && pending === null) bubble(t, (100 * t) / d);
    });
    $("#p-seek").addEventListener("mouseleave", function () { if (pending === null) $("#p-bubble").hidden = true; });

    return { open: open, close: close, key: key, caps: caps };
  })();
  window.MediawanPlayer = Player;

  start();
})();
