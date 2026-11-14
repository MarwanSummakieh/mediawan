/* Mediawan v3 web UI. Plain ES2017 so Tizen's Chromium 69 runs it without a build step:
   no optional chaining, no ??, no class fields, no object spread. */
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
  // "1 hr 32 min", "47 min": how long something runs, the way people say it.
  function runtime(seconds) {
    seconds = Math.round(seconds || 0);
    if (!seconds) return "";
    var h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
    if (m === 60) { h++; m = 0; }
    return h ? h + " hr" + (m ? " " + m + " min" : "") : (m || 1) + " min";
  }
  function left(position, duration) {
    var rest = Math.max(0, (duration || 0) - (position || 0));
    return rest >= 60 ? runtime(rest) + " left" : Math.round(rest) + " sec left";
  }
  function size(bytes) {
    var units = ["B", "KB", "MB", "GB", "TB"], i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return bytes.toFixed(i > 2 ? 1 : 0) + " " + units[i];
  }
  function hue(text) {
    var h = 0;
    text = String(text || "");
    for (var i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
    return h;
  }
  function initials(name) {
    var parts = String(name || "?").replace(/[^\w\s'-]/g, "").trim().split(/\s+/);
    return ((parts[0] || "?").charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "")).toUpperCase();
  }
  function fmtDate(iso) {
    var m = /^(\d{4})-(\d\d)-(\d\d)/.exec(iso || "");
    if (!m) return iso || "";
    try { return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); }
    catch (e) { return iso; }
  }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
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
          var error = new Error(typeof detail === "string" ? detail : "Request failed (" + response.status + ")");
          error.status = response.status;
          error.reason = data && data.reason; // torrent errors say which next step fits
          throw error;
        }
        return data;
      });
    });
  }
  function fail(error) { toast(error.message || String(error)); }

  // ---- D-pad navigation --------------------------------------------------------------------
  // Rows ([data-row]: shelves, button bars, tabs) behave like a TV media app: Left/Right step
  // through the row, Up/Down jump to the next row and land on the card you last left there.
  // Everything else (grids, lists, forms) moves to the nearest element in the pressed direction.
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
    if (!el.closest("#player") && !el.closest("#rail") && !el.closest("#menu") && !el.closest("#topbar")) keepInView(el);
  }
  // Horizontal shelves. TV: move the track with a transform (smooth on TV GPUs) so the focused
  // card sits at the left edge. Web: scroll the shelf only as far as needed.
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
  // TV home: shelves slide up under the details area so the focused shelf is always the top one.
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
    var target = el.closest(".row-section") || el.closest(".ep-row") || el;
    var r = el.getBoundingClientRect(), tr = target.getBoundingClientRect();
    var top = TV ? 40 : 90;
    if (r.top < top || r.bottom > innerHeight - 40) {
      window.scrollBy(0, tr.top - Math.max(top, (innerHeight - tr.height) / 3));
    }
  }
  function center(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  function railOpen() { return visible($("#rail a")); }
  function openRail(current) {
    if (scope() !== document.body || !railOpen()) return;
    lastMain = current;
    focusEl($("#rail a.active") || $("#rail a[data-route=home]"));
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
  // Each control is remembered by what it is (its link, id or episode) and where it was, so the
  // right one is found again even when the page around it has changed shape.
  var focusMemory = {};
  function focusKey(el) {
    return el.getAttribute("href") || el.id || el.getAttribute("data-item") || el.getAttribute("data-ep") ||
      el.getAttribute("data-season") || el.getAttribute("data-seen") || (el.textContent || "").trim().slice(0, 40);
  }
  function rememberFocus() {
    var el = document.activeElement;
    if (el && main.contains(el)) focusMemory[location.hash] = { i: focusables(main).indexOf(el), k: focusKey(el) };
  }
  function recall(memory) {
    if (!memory) return null;
    var list = focusables(main), best = null, gap = Infinity;
    list.forEach(function (el, i) {
      if (focusKey(el) === memory.k && Math.abs(i - memory.i) < gap) { gap = Math.abs(i - memory.i); best = el; }
    });
    return best || list[memory.i] || null;
  }
  document.addEventListener("focusin", rememberFocus); // mouse/tab focus on the web
  function autofocus() {
    if (!TV) return;
    setTimeout(function () {
      if (scope() !== document.body) return;
      var active = document.activeElement;
      if (active && active !== document.body && main.contains(active)) return; // already somewhere
      focusEl(recall(focusMemory[location.hash]) || firstFocus());
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
    return el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !/^(button|checkbox|radio|range|file)$/.test(el.type)));
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
      if (!$("#menu").hidden) { closeMenu(true); return; }
      if (!$("#modal").hidden) { closeModal(); return; }
      if (document.body.classList.contains("drawer")) { drawer(false); return; }
      if ($("#rail").contains(active)) { leaveRail(); return; }
      // Home: Back first returns to the top, before it does anything else.
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

  // ---- pop-up menus, dialogs, the phone drawer ----------------------------------------------
  var menuEl = $("#menu"), menuAnchor = null;
  // A list that opens under its button. Arrows stay inside; Back or a click outside closes it.
  function popMenu(anchor, html, bind) {
    if (!menuEl.hidden && menuAnchor === anchor) { closeMenu(true); return; }
    closeMenu(false);
    menuAnchor = anchor;
    menuEl.innerHTML = html;
    menuEl.hidden = false;
    if (layers.indexOf(menuEl) < 0) layers.push(menuEl);
    anchor.setAttribute("aria-expanded", "true");
    var r = anchor.getBoundingClientRect(), w = menuEl.offsetWidth, h = menuEl.offsetHeight;
    var x = Math.max(8, Math.min(r.left, innerWidth - w - 8)), y = r.bottom + 6;
    if (y + h > innerHeight - 8 && r.top - h - 6 > 8) y = r.top - h - 6;
    menuEl.style.left = x + "px";
    menuEl.style.top = y + "px";
    bind(menuEl);
    focusEl($("[aria-checked='true']", menuEl) || $("button, a", menuEl));
  }
  function closeMenu(refocus) {
    if (menuEl.hidden) return;
    menuEl.hidden = true;
    layers = layers.filter(function (l) { return l !== menuEl; });
    if (menuAnchor) {
      menuAnchor.setAttribute("aria-expanded", "false");
      if (refocus && document.body.contains(menuAnchor)) focusEl(menuAnchor);
    }
    menuAnchor = null;
  }
  // A menu of choices; onPick gets the chosen value.
  function choiceMenu(anchor, options, current, onPick) {
    popMenu(anchor, options.map(function (o) {
      return '<button role="menuitemradio" data-v="' + esc(o[0]) + '" aria-checked="' + (String(o[0]) === String(current)) + '">' +
        icon("check", "chk") + "<span>" + esc(o[1]) + "</span></button>";
    }).join(""), function (m) {
      $$("[data-v]", m).forEach(function (b) {
        b.onclick = function () { closeMenu(true); onPick(b.getAttribute("data-v")); };
      });
    });
  }
  document.addEventListener("click", function (e) {
    if (!menuEl.hidden && !menuEl.contains(e.target) && !(menuAnchor && menuAnchor.contains(e.target))) closeMenu(false);
  }, true);

  var modal = $("#modal"), modalBox = $(".modal-box", modal), modalReturn = null;
  function openModal(html, bind) {
    closeMenu(false);
    if (modal.hidden) modalReturn = document.activeElement;
    modalBox.innerHTML = html;
    modal.hidden = false;
    if (layers.indexOf(modal) < 0) layers.push(modal);
    document.body.style.overflow = "hidden";
    if (bind) bind(modalBox);
    var first = $("[data-autofocus]", modalBox) || $("input", modalBox) || $("button", modalBox);
    if (TV) focusEl(first); else if (first) first.focus();
  }
  function closeModal() {
    if (modal.hidden) return;
    modal.hidden = true;
    modalBox.innerHTML = "";
    layers = layers.filter(function (l) { return l !== modal; });
    if ($("#player").hidden) document.body.style.overflow = "";
    if (modalReturn && document.body.contains(modalReturn)) focusEl(modalReturn);
  }
  modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });
  // A question with a confirm button (replaces window.confirm, which TVs draw poorly).
  function confirmDialog(title, text, action, danger) {
    return new Promise(function (resolve) {
      openModal("<h2>" + esc(title) + "</h2><p class=\"muted\">" + esc(text) + '</p><div class="modal-actions" data-row>' +
        '<button id="m-no" class="ghost">Cancel</button><button id="m-yes" class="' + (danger ? "danger" : "primary") + '" data-autofocus>' + esc(action) + "</button></div>",
        function (box) {
          $("#m-no", box).onclick = function () { closeModal(); resolve(false); };
          $("#m-yes", box).onclick = function () { closeModal(); resolve(true); };
        });
    });
  }
  function promptDialog(title, label, value, action) {
    return new Promise(function (resolve) {
      openModal("<h2>" + esc(title) + '</h2><form id="m-form"><label>' + esc(label) + '<input name="v" value="' + esc(value || "") + '" required data-autofocus></label>' +
        '<div class="modal-actions" data-row><button type="button" id="m-no" class="ghost">Cancel</button><button class="primary">' + esc(action) + "</button></div></form>",
        function (box) {
          $("#m-no", box).onclick = function () { closeModal(); resolve(null); };
          $("#m-form", box).onsubmit = function (e) { e.preventDefault(); var v = e.target.elements.v.value.trim(); closeModal(); resolve(v || null); };
        });
    });
  }

  function drawer(open) {
    document.body.classList.toggle("drawer", open);
    $("#scrim").hidden = !open;
    $("#menu-btn").setAttribute("aria-expanded", String(open));
  }
  $("#menu-btn").onclick = function () { drawer(!document.body.classList.contains("drawer")); };
  $("#scrim").onclick = function () { drawer(false); };

  // Over a backdrop the top bar starts clear and fills in once the page scrolls.
  var scrolled = false;
  window.addEventListener("scroll", function () {
    var now = window.pageYOffset > 24;
    if (now !== scrolled) { scrolled = now; document.body.classList.toggle("scrolled", now); }
  }, { passive: true });

  // ---- icons, artwork, cards ---------------------------------------------------------------
  function icon(name, cls) {
    return '<svg class="i' + (cls ? " " + cls : "") + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }
  // Pictures fade in once loaded; one already seen this session shows at once (no flicker on re-render).
  var LOADED = {};
  window.__mwImg = function (img) { img.className = "ready"; LOADED[img.getAttribute("src")] = 1; };
  function img(src, cls) {
    return '<img alt="" src="' + esc(src) + '"' + (LOADED[src] ? ' class="ready"' : ' onload="__mwImg(this)"') +
      ' onerror="this.remove()"' + (cls ? ' data-c="' + cls + '"' : "") + ">";
  }
  function art(src, name, extra, cls) {
    var fallback = '<div class="fallback" style="--hue:' + hue(name) + '">' + icon(cls === "wide" ? "tv" : "film") + esc(name) + "</div>";
    return '<div class="art' + (cls ? " " + cls : "") + '">' + fallback + (src ? img(src) : "") + (extra || "") + "</div>";
  }
  function bar(position, duration) {
    var pct = duration ? Math.min(100, (100 * position) / duration) : 0;
    return pct > 0.5 ? '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' : "";
  }
  var PLAY_OVER = '<span class="shade"></span><span class="card-play" data-play aria-hidden="true">' + icon("play") + "</span>";
  function iconButton(id, name, tip, extra) {
    return '<button class="icon-btn" id="' + id + '" aria-label="' + esc(tip) + '" data-tip="' + esc(tip) + '"' + (extra || "") + ">" + icon(name) + "</button>";
  }
  function stars(rating, source) {
    return rating ? '<span class="star">' + icon("star") + esc(rating) + (source ? "<small>" + source + "</small>" : "") + "</span>" : "";
  }

  // What each card shows in the home billboard when focused, and plays from its play button.
  var FEAT = [];
  function feature(data) { FEAT.push(data); return FEAT.length - 1; }
  var PEEK = {}; // title cards seen, so a title page can draw its top half before its data arrives

  // Unwatched film: a corner fold. Show: unwatched episodes. Fully watched: a quiet tick.
  function marks(t) {
    if (t.watched) return '<span class="tick">' + icon("check") + "</span>";
    if (t.kind === "show") return t.unwatched ? '<span class="count">' + t.unwatched + "</span>" : "";
    return '<span class="corner"></span>';
  }
  function titleCard(t) {
    PEEK[t.id] = t;
    var k = feature({ type: "title", id: t.id, kind: t.kind, name: t.name, year: t.year, rating: t.rating,
      genres: t.genres, description: t.description, background: t.background, poster: t.poster });
    return '<a class="card" href="#/title/' + t.id + '" data-k="' + k + '">' + art(t.poster, t.name, marks(t) + PLAY_OVER) +
      '<div class="caption"><div class="t">' + esc(t.name) + '</div><div class="s">' + esc(t.year || "") + "</div></div></a>";
  }
  function entryCard(e) { // Continue Watching / Next Up: an episode or film to play right away
    var k = feature({ type: "entry", id: e.id, item_id: e.item_id, kind: e.kind, name: e.name, year: e.year,
      label: e.label, item_name: e.item_name, position: e.position, duration: e.duration,
      description: e.description, background: e.background || e.thumbnail, poster: e.poster });
    var sub = e.label ? [e.label.replace(/^S0?(\d+)E0?(\d+)$/, "S$1 · E$2"), e.item_name].filter(Boolean).join(" · ")
      : e.duration && e.position ? left(e.position, e.duration) : e.year || "";
    return '<a class="card wide" href="#/play/' + e.item_id + '" data-k="' + k + '">' +
      art(e.thumbnail || e.background || e.poster, e.name, bar(e.position, e.duration) + PLAY_OVER, "wide") +
      '<div class="caption"><div class="t">' + esc(e.name) + '</div><div class="s">' + esc(sub) + "</div></div></a>";
  }
  var FORMATS = { TV: "TV", TV_SHORT: "TV short", MOVIE: "Movie", OVA: "OVA", ONA: "ONA", SPECIAL: "Special", MUSIC: "Music" };
  function animeCard(a) { // an AniList search result
    var badge = a.available ? "" : '<span class="badge">Soon</span>';
    var k = feature({ type: "anime", id: a.id, name: a.name, year: a.year, genres: a.genres,
      rating: a.score ? (a.score / 10).toFixed(1) : "", background: a.background || a.poster, poster: a.poster });
    var sub = [a.year, FORMATS[a.format] || "", a.available ? a.available + " ep" : "not out yet"].filter(Boolean).join(" · ");
    return '<a class="card" href="#/anime/' + a.id + '" data-k="' + k + '">' + art(a.poster, a.name, badge + PLAY_OVER) +
      '<div class="caption"><div class="t">' + esc(a.name) + '</div><div class="s">' + esc(sub) + "</div></div></a>";
  }
  function animeEntryCard(e) { // Continue Watching · Anime
    var k = feature({ type: "anime-entry", id: e.anilist_id, episode: e.episode, lang: e.lang, name: e.name,
      position: e.position, duration: e.duration, background: e.background || e.poster, poster: e.poster });
    var sub = "Episode " + e.episode + (e.lang === "dub" ? " · Dub" : "") + (e.duration ? " · " + left(e.position, e.duration) : "");
    return '<a class="card wide" href="#/anime/' + e.anilist_id + "?play=" + e.episode + '" data-k="' + k + '">' +
      art(e.background || e.poster, e.name, bar(e.position, e.duration) + PLAY_OVER, "wide") +
      '<div class="caption"><div class="t">' + esc(e.name) + '</div><div class="s">' + esc(sub) + "</div></div></a>";
  }
  function watchCard(m) { // a Cinemeta search result, played from Usenet
    var sub = [m.year, m.kind === "show" ? "TV show" : "Movie"].filter(Boolean).join(" · ");
    return '<a class="card" href="#/watch/' + m.kind + "/" + m.id + '">' + art(m.poster, m.name) +
      '<div class="caption"><div class="t">' + esc(m.name) + '</div><div class="s">' + esc(sub) + "</div></div></a>";
  }
  function watchLabel(e) { return e.kind === "show" ? "S" + e.season + " · E" + e.episode : ""; }
  function watchEntryCard(e) { // Continue Watching · Online
    var k = feature({ type: "watch-entry", id: e.id, kind: e.kind, season: e.season, episode: e.episode, name: e.name,
      label: watchLabel(e), position: e.position, duration: e.duration, background: e.background || e.poster, poster: e.poster,
      source: e.source, quality: e.quality });
    var sub = [watchLabel(e), e.duration ? left(e.position, e.duration) : ""].filter(Boolean).join(" · ");
    return '<a class="card wide" href="#/watch/' + e.kind + "/" + e.id + "?play=" + e.season + "." + e.episode + '" data-k="' + k + '">' +
      art(e.background || e.poster, e.name, bar(e.position, e.duration) + PLAY_OVER, "wide") +
      '<div class="caption"><div class="t">' + esc(e.name) + '</div><div class="s">' + esc(sub) + "</div></div></a>";
  }

  // Cards: the round play button plays at once; Continue Watching cards play instead of opening a page.
  document.addEventListener("click", function (e) {
    var play = e.target.closest && e.target.closest("[data-play]");
    if (play) {
      var card = play.closest("[data-k]");
      if (card) { e.preventDefault(); e.stopPropagation(); playFeature(FEAT[+card.getAttribute("data-k")]); return; }
    }
    var link = e.target.closest && e.target.closest('a[href^="#/play/"]');
    if (link) { e.preventDefault(); Player.open({ item_id: +link.getAttribute("href").split("/")[2] }); return; }
    var arrow = e.target.closest && e.target.closest(".shelf-arrow");
    if (arrow) {
      var vp = $(".row-viewport", arrow.parentNode);
      var by = vp.clientWidth * 0.8 * (arrow.classList.contains("l") ? -1 : 1);
      try { vp.scrollBy({ left: by, behavior: "smooth" }); } catch (x) { vp.scrollLeft += by; }
    }
  });
  function bindShelves(root) {
    if (TV) return;
    $$(".row-section", root).forEach(function (s) {
      var vp = $(".row-viewport", s), l = $(".shelf-arrow.l", s), r = $(".shelf-arrow.r", s);
      if (!vp || !l) return;
      function update() {
        l.classList.toggle("off", vp.scrollLeft <= 2);
        r.classList.toggle("off", vp.scrollLeft + vp.clientWidth >= vp.scrollWidth - 2);
      }
      vp.addEventListener("scroll", update, { passive: true });
      update();
    });
  }

  // Ask for details while the pointer or remote rests on a card, so the page opens instantly.
  var warmTimer = null;
  function warm(event) {
    var link = event.target.closest && event.target.closest('a[href^="#/title/"], a[href^="#/anime/"]');
    if (!link) return;
    var m = link.getAttribute("href").match(/^#\/(title|anime)\/(\d+)/);
    if (!m) return;
    var path = m[1] === "title" ? "/api/titles/" + m[2] : "/api/online/anime/" + m[2];
    clearTimeout(warmTimer);
    warmTimer = setTimeout(function () { prefetch(path); }, 120);
  }
  document.addEventListener("mouseover", warm);
  document.addEventListener("focusin", warm);

  function shelf(section) {
    var id = section.id;
    var wide = id === "continue" || id === "next" || id === "online" || id === "usenet";
    var render = id === "online" ? animeEntryCard : id === "usenet" ? watchEntryCard : wide ? entryCard : titleCard;
    var more = { movies: "#/movies?sort=added", shows: "#/shows?sort=added", watchlist: "#/watchlist", favorites: "#/favorites" }[id] ||
      (/^collection-(\d+)$/.test(id) ? "#/collection/" + id.split("-")[1] : "");
    return '<section class="row-section"><div class="shelf-head"><h2>' + esc(section.name) + "</h2>" +
      (more ? '<a class="more" href="' + more + '">See all' + icon("chevron") + "</a>" : "") + "</div>" +
      '<div class="row-viewport"><div class="row-track" data-row>' + section.items.map(render).join("") + "</div></div>" +
      '<span class="shelf-arrow l" aria-hidden="true">' + icon("chevron-left") + '</span><span class="shelf-arrow r" aria-hidden="true">' + icon("chevron") + "</span></section>";
  }

  // ---- skeletons and states ------------------------------------------------------------------
  function skCards(n, wide) {
    var out = "";
    for (var i = 0; i < n; i++) out += '<div class="sk-card' + (wide ? " wide" : "") + '"><div class="sk"></div><div class="sk sk-line" style="width:70%"></div></div>';
    return out;
  }
  function skShelf(wide) {
    return '<section class="row-section"><div class="sk sk-line" style="width:180px;height:1.1em;margin:0"></div><div class="row-viewport"><div class="row-track">' + skCards(10, wide) + "</div></div></section>";
  }
  function skGrid(n) { return '<div class="grid">' + skCards(n || 18) + "</div>"; }
  function skHead(width) { return '<div class="page-head"><div class="sk" style="width:' + (width || 220) + 'px;height:2.1rem"></div></div>'; }
  function stateHtml(iconName, title, text, extra) {
    return '<div class="state"><div class="state-icon">' + icon(iconName) + "</div><h2>" + esc(title) + "</h2>" +
      (text ? "<p>" + text + "</p>" : "") + (extra || "") + "</div>";
  }

  // ---- data cache ------------------------------------------------------------------------
  // Pages draw at once from the last answer for the same address, then quietly redraw if the
  // fresh answer differs (keeping focus and scroll). First visits draw a skeleton meanwhile.
  var CACHE = {}, INFLIGHT = {}, QUIET = false;
  function remember(path, data) { var s = JSON.stringify(data); var same = CACHE[path] && CACHE[path].s === s; CACHE[path] = { data: data, s: s }; return same; }
  function prefetch(path) {
    if (CACHE[path] || INFLIGHT[path]) return;
    INFLIGHT[path] = api(path).then(function (d) { remember(path, d); }).catch(function () {}).then(function () { delete INFLIGHT[path]; });
  }
  function keepState(draw) {
    var a = document.activeElement, y = window.pageYOffset;
    var memo = a && main.contains(a) ? { i: focusables(main).indexOf(a), k: focusKey(a) } : null;
    draw();
    window.scrollTo(0, y);
    var el = recall(memo);
    if (el) focusEl(el);
  }
  // opts: render(data) draws the page; fallback() draws something first when nothing is cached.
  function cachedView(view, path, opts) {
    var hit = CACHE[path], quiet = opts.quiet !== undefined ? opts.quiet : QUIET;
    if (!quiet) {
      if (hit) { opts.render(hit.data); autofocus(); }
      else if (opts.fallback) opts.fallback();
    }
    var pending = INFLIGHT[path] || api(path).then(function (d) { return d; });
    return Promise.resolve(pending).then(function (data) {
      if (data === undefined) data = CACHE[path] && CACHE[path].data; // a prefetch finished
      if (data === undefined) return api(path).then(function (d) { return d; });
      return data;
    }).then(function (data) {
      var same = remember(path, data);
      if (view !== VIEW) return;
      if (same && hit && !quiet) return;
      keepState(function () { opts.render(data); });
    });
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
    [/^\/watchlist$/, function (_, q, view) { return viewTagged("watchlist", view); }],
    [/^\/favorites$/, function (_, q, view) { return viewTagged("favorite", view); }],
    [/^\/collections$/, viewCollections],
    [/^\/collection\/(\d+)$/, viewCollection],
    [/^\/settings$/, viewSettings],
    [/^\/admin(?:\/(\w+))?$/, viewAdmin],
  ];

  // quiet: redraw the current page in place (after an action, or when the player closes).
  function route(quiet) {
    if (!ME) return;
    quiet = quiet === true;
    var hash = location.hash.replace(/^#/, "") || "/";
    var path = hash.split("?")[0];
    var query = {};
    (hash.split("?")[1] || "").split("&").forEach(function (pair) {
      if (pair) { var kv = pair.split("="); query[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ""); }
    });
    var view = ++VIEW;
    QUIET = quiet;
    if (!quiet) {
      FEAT = [];
      homeFocus = null;
      closeMenu(false);
      closeModal();
      drawer(false);
      document.body.classList.remove("over-art");
      if (path !== "/search") $("#top-q").value = "";
    }
    var section = path === "/" ? "home" : path.split("/")[1];
    $$("#rail a").forEach(function (a) { a.classList.toggle("active", a.getAttribute("data-route") === section); });
    for (var i = 0; i < routes.length; i++) {
      var match = path.match(routes[i][0]);
      if (match) {
        if (!quiet) window.scrollTo(0, 0);
        Promise.resolve(routes[i][1](match[1], query, view)).then(autofocus).catch(function (err) {
          if (view !== VIEW) return;
          // Nothing real on screen yet: say so plainly and offer to try again.
          if (!main.firstElementChild || $(".sk", main)) {
            document.body.classList.remove("over-art");
            main.innerHTML = stateHtml("alert", "This page did not load", esc(err.message || String(err)),
              '<button class="primary" id="retry" data-autofocus>' + icon("refresh") + "Try again</button>");
            $("#retry").onclick = function () { route(); };
            autofocus();
          } else fail(err);
        });
        return;
      }
    }
    main.innerHTML = stateHtml("alert", "Page not found", "There is nothing at this address.", '<a class="btn primary" href="#/" data-autofocus>Go home</a>');
  }
  function refresh() { route(true); }
  function paint(view, html) {
    if (view !== undefined && view !== VIEW) return false;
    main.innerHTML = html;
    return true;
  }
  window.addEventListener("hashchange", route);

  // ---- home: a billboard for one title over shelves ---------------------------------------
  function infoHref(f) {
    return f.type === "watch-entry" ? "#/watch/" + f.kind + "/" + f.id
      : f.type === "anime" || f.type === "anime-entry" ? "#/anime/" + f.id : "#/title/" + f.id;
  }
  function playFeature(f) {
    if (!f) return;
    if (f.type === "entry") Player.open({ item_id: f.item_id });
    else if (f.type === "anime-entry") Player.open({ online: { anilist_id: f.id, episode: f.episode, lang: f.lang } });
    else if (f.type === "watch-entry") Player.open(f.source === "torrent"
      ? { torrent: { kind: f.kind, id: f.id, season: f.season, episode: f.episode, quality: f.quality || 0 } }
      : { usenet: { kind: f.kind, id: f.id, season: f.season, episode: f.episode } });
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
    if (f.type === "entry" && f.label) meta.push(esc(f.label.replace(/^S0?(\d+)E0?(\d+)$/, "Season $1 · Episode $2") + (f.item_name ? " · " + f.item_name : "")));
    if (f.type === "watch-entry" && f.label) meta.push(esc(f.label));
    if (f.type === "anime-entry") meta.push("Episode " + f.episode + (f.lang === "dub" ? " · Dubbed" : ""));
    if (f.year) meta.push(esc(f.year));
    if (f.rating) meta.push(stars(f.rating));
    if (resuming && f.duration) meta.push(esc(left(f.position, f.duration)));
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
    var pic = new Image();
    pic.onload = function () {
      if (home.getAttribute("data-want") !== src) return;
      hidden.style.backgroundImage = 'url("' + src.replace(/"/g, "%22") + '")';
      hidden.setAttribute("data-src", src);
      hidden.classList.add("on");
      shown.classList.remove("on");
    };
    pic.src = src;
  }
  function viewHome(_, __, view) {
    document.body.classList.add("over-art");
    return cachedView(view, "/api/home", {
      fallback: function () {
        paint(view, '<div class="home"><div class="bb"><div class="bb-shade"></div><div class="bb-copy"><div class="sk" style="width:40%;height:1em"></div>' +
          '<div class="sk" style="width:70%;height:2.8rem;margin:14px 0"></div><div class="sk" style="width:90%;height:3.5em"></div></div></div>' +
          '<div class="home-rows">' + skShelf(true) + skShelf() + skShelf() + "</div></div>");
      },
      render: function (data) { renderHome(data, view); },
    });
  }
  function renderHome(data, view) {
    FEAT = [];
    if (!data.rails.length) {
      document.body.classList.remove("over-art");
      var admin = ME.role === "admin";
      return paint(view, stateHtml("film", "Welcome to Mediawan", admin
        ? "Your library is empty. Add folders with LIBRARY_ROOTS, then run a scan from Admin. You can also find anime and films online from Search."
        : "Your library is empty. Ask your administrator to add some media, or find anime and films online from Search.",
        (admin ? '<a class="btn primary" href="#/admin/library" data-autofocus>' + icon("refresh") + "Scan the library</a>" : "") +
        '<a class="btn" href="#/search">' + icon("search") + "Search</a>"));
    }
    var rows = data.rails.map(shelf).join("");
    // Feature what you were watching, else the newest film or show with a backdrop.
    var withArt = FEAT.filter(function (f) { return f.background; });
    var resume = withArt.filter(function (f) { return /entry$/.test(f.type); });
    var featured = resume[0] || withArt[0] || FEAT[0];
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
      // Continue Watching entries carry no summary: borrow the title's (an episode's when it has one).
      if (f.type === "entry" && !f.enriched) {
        var path = "/api/titles/" + f.id;
        var fill = function (t) {
          if (!t) return;
          f.enriched = true;
          var item = t.items.filter(function (i) { return i.id === f.item_id; })[0];
          f.description = (item && item.overview) || t.description;
          f.genres = t.genres;
          f.rating = t.rating;
          if (current === f && document.body.contains(home)) $("#bb-text").innerHTML = billboardText(f);
        };
        if (CACHE[path]) fill(CACHE[path].data);
        else api(path).then(function (t) { remember(path, t); fill(t); }).catch(function () {});
      }
    }
    show(featured);
    $("#bb-play").onclick = function () { playFeature(current); };
    $("#bb-info").onclick = function () { location.hash = infoHref(current); };
    bindShelves(home);
    // On a TV the billboard follows the remote: it describes the focused card.
    // (Called from focusEl, because focus events do not fire while the window is unfocused.)
    var timer = null;
    homeFocus = function (el) {
      var card = el.closest(".card[data-k]");
      if (!card || !document.body.contains(home)) return;
      clearTimeout(timer);
      timer = setTimeout(function () { show(FEAT[+card.getAttribute("data-k")]); }, 140);
    };
  }

  // ---- libraries ---------------------------------------------------------------------------
  var SORTS = [["name", "Title"], ["added", "Recently added"], ["year", "Release year"], ["rating", "Rating"]];
  var SHOWING = [["all", "All"], ["unwatched", "Unwatched"], ["watched", "Watched"]];
  function label(list, value) { var f = list.filter(function (o) { return o[0] === value; })[0]; return f ? f[1] : value; }
  function dd(id, lbl, value, on) {
    return '<button class="dd' + (on ? " on" : "") + '" id="' + id + '" aria-haspopup="menu"><span class="lbl">' + lbl + "</span>" + esc(value) + icon("down") + "</button>";
  }
  function viewLibrary(kind, query, view) {
    var state = viewLibrary.state[kind] || (viewLibrary.state[kind] = { sort: "name", genre: "", show: "all" });
    if (query.sort && label(SORTS, query.sort) !== query.sort) state.sort = query.sort;
    var heading = kind === "movie" ? "Movies" : "TV Shows";
    function path() { return "/api/titles?kind=" + kind + "&sort=" + state.sort + "&genre=" + encodeURIComponent(state.genre) + "&limit=500"; }
    function render(data) {
      FEAT = [];
      var titles = data.titles.filter(function (t) { return state.show === "all" || (state.show === "watched" ? t.watched : !t.watched); });
      var html = '<div class="page-head"><h1>' + heading + '</h1><span class="count">' + plural(titles.length, kind === "movie" ? "movie" : "show") + "</span></div>" +
        '<div class="toolbar" data-row>' + dd("dd-sort", "Sort", label(SORTS, state.sort)) +
        (data.genres.length ? dd("dd-genre", "Genre", state.genre || "All", !!state.genre) : "") +
        dd("dd-show", "Show", label(SHOWING, state.show), state.show !== "all") + "</div>" +
        (titles.length ? '<div class="grid">' + titles.map(titleCard).join("") + "</div>"
          : data.titles.length ? stateHtml("filter", "Nothing matches", "No " + (state.show === "watched" ? "watched" : "unwatched") + " titles" + (state.genre ? " in " + esc(state.genre) : "") + ".",
            '<button id="clear-filters">Clear filters</button>')
          : state.genre ? stateHtml("filter", "Nothing in " + state.genre, "", '<button id="clear-filters">Clear filters</button>')
          : stateHtml(kind === "movie" ? "film" : "tv", "No " + heading.toLowerCase() + " yet",
            ME.role === "admin" ? "Add a folder of " + heading.toLowerCase() + " to LIBRARY_ROOTS and scan the library from Admin." : "Your administrator has not added any yet."));
      if (!paint(view, html)) return;
      function again(focusId) {
        cachedView(view, path(), { quiet: false, render: render }).then(function () { if (focusId && $("#" + focusId)) focusEl($("#" + focusId)); }).catch(fail);
        if (focusId && $("#" + focusId)) focusEl($("#" + focusId));
      }
      $("#dd-sort").onclick = function () { choiceMenu(this, SORTS, state.sort, function (v) { state.sort = v; again("dd-sort"); }); };
      if ($("#dd-genre")) $("#dd-genre").onclick = function () {
        choiceMenu(this, [["", "All genres"]].concat(data.genres.map(function (g) { return [g, g]; })), state.genre, function (v) { state.genre = v; again("dd-genre"); });
      };
      $("#dd-show").onclick = function () { choiceMenu(this, SHOWING, state.show, function (v) { state.show = v; render(data); focusEl($("#dd-show")); }); };
      if ($("#clear-filters")) $("#clear-filters").onclick = function () { state.genre = ""; state.show = "all"; again("dd-sort"); };
    }
    return cachedView(view, path(), {
      fallback: function () { paint(view, '<div class="page-head"><h1>' + heading + '</h1></div><div class="toolbar"><div class="sk" style="width:320px;height:2.3em"></div></div>' + skGrid()); },
      render: render,
    });
  }
  viewLibrary.state = {};

  // Watchlist and Favorites: every title you marked, as a grid.
  function viewTagged(tag, view) {
    var heading = tag === "watchlist" ? "Watchlist" : "Favorites";
    return cachedView(view, "/api/titles?tag=" + tag + "&sort=name&limit=500", {
      fallback: function () { paint(view, '<div class="page-head"><h1>' + heading + "</h1></div>" + skGrid(12)); },
      render: function (data) {
        FEAT = [];
        paint(view, '<div class="page-head"><h1>' + heading + '</h1><span class="count">' + plural(data.titles.length, "title") + "</span></div>" +
          (data.titles.length ? '<div class="grid">' + data.titles.map(titleCard).join("") + "</div>"
            : stateHtml(tag === "watchlist" ? "bookmark" : "heart", tag === "watchlist" ? "Your watchlist is empty" : "No favorites yet",
              "Use the " + (tag === "watchlist" ? "bookmark" : "heart") + " button on any film or show to add it here.",
              '<a class="btn" href="#/movies" data-autofocus>Browse movies</a><a class="btn" href="#/shows">Browse TV shows</a>')));
      },
    });
  }

  // ---- search ------------------------------------------------------------------------------
  // On a desktop the top bar's field drives this page; on phones and TVs the page has its own.
  $("#top-q").addEventListener("input", function () {
    if (!/^#\/search/.test(location.hash)) location.hash = "#/search?q=" + encodeURIComponent(this.value);
  });
  $("#top-q").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !/^#\/search/.test(location.hash)) location.hash = "#/search?q=" + encodeURIComponent(this.value);
  });
  function viewSearch(_, query, view) {
    var top = $("#top-q"), useTop = visible(top);
    paint(view, (useTop ? "" : '<div class="search-field">' + icon("search") + '<input id="q" type="search" placeholder="Search movies, shows and anime" autocomplete="off" data-autofocus value="' + esc(query.q || "") + '"></div>') +
      '<div id="results"><div id="r-local"></div><div id="r-usenet"></div><div id="r-online"></div></div>');
    var input = useTop ? top : $("#q"), timer = null;
    if (useTop && query.q && !top.value) top.value = query.q;
    function hint() {
      $("#r-local").innerHTML = stateHtml("search", "Find something to watch",
        "Search your library by title or description. Anime from AniList and films and series online are searched at the same time.");
      $("#r-usenet").innerHTML = $("#r-online").innerHTML = "";
    }
    // Library matches as a grid; the online groups as shelves, so neither buries the other.
    function section(id, heading, cards, render, note, asShelf) {
      var head = '<div class="section-h"><h2>' + heading + '</h2><span class="s">' + cards.length + "</span>" + (note ? '<span class="s search-hint">' + note + "</span>" : "") + "</div>";
      $("#" + id).innerHTML = !cards.length ? "" : asShelf
        ? '<section class="row-section search-sec">' + head + '<div class="row-viewport"><div class="row-track" data-row>' + cards.map(render).join("") + "</div></div>" +
          '<span class="shelf-arrow l" aria-hidden="true">' + icon("chevron-left") + '</span><span class="shelf-arrow r" aria-hidden="true">' + icon("chevron") + "</span></section>"
        : '<section class="search-sec">' + head + '<div class="grid">' + cards.map(render).join("") + "</div></section>";
      bindShelves($("#" + id));
    }
    function loading(id, heading) {
      $("#" + id).innerHTML = '<section class="search-sec"><div class="section-h"><h2>' + heading + '</h2></div><div class="grid">' + skCards(6) + "</div></section>";
    }
    function run() {
      var q = input.value.trim();
      history.replaceState(null, "", "#/search" + (q ? "?q=" + encodeURIComponent(q) : ""));
      if (!q) { hint(); return; }
      FEAT = [];
      loading("r-local", "In your library");
      loading("r-online", "Anime");
      var local = api("/api/titles?q=" + encodeURIComponent(q) + "&limit=60").then(function (data) {
        if (input.value.trim() === q) section("r-local", "In your library", data.titles, titleCard);
        return data.titles.length;
      }, function () { if (input.value.trim() === q) $("#r-local").innerHTML = ""; return 0; });
      var online = api("/api/online/search?q=" + encodeURIComponent(q)).then(function (data) {
        if (input.value.trim() === q) section("r-online", "Anime", data.results, animeCard, "Streams online", true);
        return data.results.length;
      }, function (err) {
        if (input.value.trim() === q) $("#r-online").innerHTML = '<p class="empty small">Anime search failed: ' + esc(err.message) + "</p>";
        return 0;
      });
      var usenet = api("/api/usenet/search?q=" + encodeURIComponent(q)).then(function (data) {
        if (input.value.trim() === q) section("r-usenet", "Movies and TV online", data.results, watchCard, "From Usenet", true);
        return data.results.length;
      }, function () { return 0; });
      Promise.all([local, online, usenet]).then(function (counts) {
        if (input.value.trim() === q && !counts[0] && !counts[1] && !counts[2] && !$("#r-online").textContent) {
          $("#r-local").innerHTML = stateHtml("search", "No matches for “" + q + "”", "Check the spelling, or try fewer words.");
        }
      }).catch(fail);
    }
    input.oninput = function () { clearTimeout(timer); timer = setTimeout(run, 250); };
    input.onkeydown = function (e) {
      var k = keyName(e);
      if (k === "down" || k === "enter") {
        var first = $(".card", $("#results"));
        if (first || k === "enter") { e.preventDefault(); input.blur(); focusEl(first || input); }
      }
    };
    if (query.q) run(); else hint();
    if (!TV) input.focus();
  }

  // ---- title pages (library titles, online anime and online films share the layout) -------
  function backdrop(src) {
    if (!src) return "";
    return '<div class="detail-bg"><i' + (LOADED[src] ? ' class="on"' : "") + ' data-bg="' + esc(src) + '" style="background-image:url(&quot;' + esc(src) + '&quot;)"></i></div>';
  }
  function bindBackdrop() {
    var layer = $(".detail-bg i", main);
    if (!layer || layer.classList.contains("on")) return;
    var src = layer.getAttribute("data-bg"), pic = new Image();
    pic.onload = function () { LOADED[src] = 1; layer.classList.add("on"); };
    pic.src = src;
  }
  // o: name, subtitle, poster, background, meta[], genres[], actions, resume, description, facts[[k,v]],
  //    tech[[k,v]], note, body. Missing parts are simply left out.
  function detailHtml(o) {
    var facts = (o.facts || []).filter(function (f) { return f[1]; });
    var tech = (o.tech || []).filter(function (f) { return f[1]; });
    return '<div class="detail">' + backdrop(o.background) +
      '<div class="detail-main"><div class="detail-poster">' + art(o.poster, o.name) + '</div><div class="detail-info">' +
      "<h1>" + esc(o.name) + "</h1>" + (o.subtitle ? '<div class="subtitle">' + esc(o.subtitle) + "</div>" : "") +
      (o.meta.length ? '<div class="meta">' + o.meta.map(function (m) { return "<span>" + m + "</span>"; }).join("") + "</div>" : "") +
      (o.genres && o.genres.length ? '<div class="genres">' + o.genres.map(function (g) { return "<span>" + esc(g) + "</span>"; }).join("") + "</div>" : "") +
      '<div class="actions" data-row>' + o.actions + "</div>" + (o.resume || "") +
      (o.description ? '<p class="desc' + (o.description.length > 320 ? " clamp" : "") + '">' + esc(o.description) + "</p>" +
        (o.description.length > 320 ? '<button class="more-btn" id="more">More</button>' : "") : "") +
      (facts.length ? '<dl class="facts">' + facts.map(function (f) { return "<dt>" + f[0] + "</dt><dd>" + esc(f[1]) + "</dd>"; }).join("") + "</dl>" : "") +
      (tech.length ? '<dl class="tech">' + tech.map(function (f) { return "<dt>" + f[0] + "</dt><dd>" + esc(f[1]) + "</dd>"; }).join("") + "</dl>" : "") +
      (o.note ? '<p class="note">' + o.note + "</p>" : "") +
      '</div></div><div class="detail-body">' + (o.body || "") + "</div></div>";
  }
  function bindDetail() {
    bindBackdrop();
    bindShelves(main);
    if ($("#more")) $("#more").onclick = function () {
      var d = $(".desc", main), open = d.classList.toggle("clamp");
      this.textContent = open ? "More" : "Less";
    };
  }
  function skDetailBody() {
    return '<div class="section-h"><div class="sk" style="width:160px;height:1.2em"></div></div>' +
      '<div class="ep-row"><div class="sk" style="width:250px;height:140px;margin:10px"></div><div style="flex:1"><div class="sk sk-line" style="width:40%"></div><div class="sk sk-line" style="width:80%"></div></div></div>';
  }
  function skActions() { return '<span class="sk" style="width:130px;height:2.9em;display:inline-block"></span><span class="sk" style="width:2.75em;height:2.75em;border-radius:50%;display:inline-block"></span><span class="sk" style="width:2.75em;height:2.75em;border-radius:50%;display:inline-block"></span>'; }

  // One episode in the list: a thumbnail, the number and name, when it aired, how long, what happens.
  function episodeRow(o) {
    var thumb = art(o.thumbnail, o.name, (o.completed ? '<span class="tick">' + icon("check") + "</span>" : "") +
      bar(o.completed ? 0 : o.position, o.duration) + '<span class="shade"></span><span class="card-play" aria-hidden="true">' + icon("play") + "</span>", "wide");
    var meta = (o.meta || []).filter(Boolean).map(function (m, i) { return (i ? '<span class="dot"></span>' : "") + m; }).join("");
    return '<div class="ep-row" data-row><button class="ep' + (o.unavailable ? " unavailable" : "") + '" ' + o.attr + '><div class="ep-thumb">' + thumb + "</div>" +
      '<div class="ep-text"><div class="ep-title"><span class="n">' + esc(o.num) + "</span>" + esc(o.name) + "</div>" +
      (meta ? '<div class="ep-meta">' + meta + "</div>" : "") + (o.overview ? '<p class="ep-desc">' + esc(o.overview) + "</p>" : "") + "</div></button>" +
      (o.seen ? '<button class="icon-btn ep-seen" data-seen="' + o.seen + '" aria-pressed="' + !!o.completed + '" aria-label="' + (o.completed ? "Mark unwatched" : "Mark watched") + '" title="' + (o.completed ? "Mark unwatched" : "Mark watched") + '">' + icon("seen") + "</button>" : "") +
      "</div>";
  }
  function progressMeta(o) {
    return o.completed ? '<span class="on">Watched</span>' : o.position && o.duration ? '<span class="on">' + esc(left(o.position, o.duration)) + "</span>" : "";
  }
  // Cast and crew as a row of portraits (initials when there is no picture).
  function peopleRow(heading, people) {
    if (!people.length) return "";
    return '<section class="row-section"><div class="section-h"><h2>' + heading + '</h2></div><div class="row-viewport people-viewport"><div class="people">' +
      people.map(function (p) {
        return '<div class="person"><div class="face" style="--hue:' + hue(p.name) + '">' + esc(initials(p.name)) + (p.image ? img(p.image) : "") + "</div><b>" + esc(p.name) + "</b>" +
          (p.role ? "<span>" + esc(p.role) + "</span>" : "") + "</div>";
      }).join("") + "</div></div></section>";
  }
  function relatedShelf(titles) {
    if (!titles || !titles.length) return "";
    return '<section class="row-section"><div class="section-h"><h2>More like this</h2></div><div class="row-viewport"><div class="row-track" data-row>' +
      titles.map(titleCard).join("") + "</div></div>" +
      '<span class="shelf-arrow l" aria-hidden="true">' + icon("chevron-left") + '</span><span class="shelf-arrow r" aria-hidden="true">' + icon("chevron") + "</span></section>";
  }
  var CODECS = { h264: "H.264", hevc: "HEVC", av1: "AV1", vp9: "VP9", mpeg4: "MPEG-4", mpeg2video: "MPEG-2", aac: "AAC", ac3: "Dolby Digital", eac3: "Dolby Digital+",
                 dts: "DTS", truehd: "TrueHD", flac: "FLAC", mp3: "MP3", opus: "Opus", vorbis: "Vorbis",
                 subrip: "SRT", srt: "SRT", ass: "ASS", ssa: "SSA", mov_text: "Text", hdmv_pgs_subtitle: "PGS", dvd_subtitle: "VobSub" };
  var LANG_NAMES = { en: "English", ar: "Arabic", da: "Danish", pt: "Portuguese", fr: "French", de: "German", es: "Spanish", it: "Italian", ja: "Japanese",
                     nl: "Dutch", ko: "Korean", zh: "Chinese", ru: "Russian", eng: "English", jpn: "Japanese" };
  function resolution(h) { return !h ? "" : h >= 2000 ? "4K" : h >= 1000 ? "1080p" : h >= 700 ? "720p" : h >= 560 ? "576p" : h >= 470 ? "480p" : h + "p"; }
  function channels(n) { return n >= 8 ? "7.1" : n >= 6 ? "5.1" : n === 2 ? "Stereo" : n === 1 ? "Mono" : n ? n + " ch" : ""; }
  function techTags(file) {
    if (!file || !file.height) return [];
    var tags = [resolution(file.height)];
    if (file.hdr) tags.push("HDR");
    var a = (file.audio || [])[0];
    if (a && a.channels >= 6) tags.push(channels(a.channels));
    return tags.map(function (t) { return '<span class="tag">' + t + "</span>"; });
  }
  function techRows(file) {
    if (!file) return [];
    var video = file.height ? [resolution(file.height), CODECS[file.video] || (file.video || "").toUpperCase(), file.hdr ? "HDR" : ""].filter(Boolean).join(" ") : "";
    var audio = (file.audio || []).map(function (a) {
      var codec = [CODECS[a.codec] || (a.codec || "").toUpperCase(), channels(a.channels)].filter(Boolean).join(" ");
      var lang = LANG_NAMES[a.lang] || (a.lang || "").toUpperCase();
      return lang ? lang + " (" + codec + ")" : codec;
    }).join(", ");
    return [["Video", video], ["Audio", audio], ["File", file.size ? size(file.size) + (file.duration ? " · " + runtime(file.duration) : "") : ""]];
  }

  function viewTitle(id, query, view) {
    document.body.classList.add("over-art");
    var state = viewTitle.state[id] || (viewTitle.state[id] = {});
    return cachedView(view, "/api/titles/" + id, {
      fallback: function () {
        var p = PEEK[id];
        if (!p) { paint(view, '<div class="detail"><div class="detail-main"><div class="detail-poster"><div class="sk" style="padding-top:150%"></div></div><div class="detail-info">' +
          '<div class="sk" style="width:60%;height:2.6rem"></div><div class="sk sk-line" style="width:40%;margin:16px 0"></div>' + skActions() + "</div></div>" + skDetailBody() + "</div>"); return; }
        // The card you came from already knows the title, poster and backdrop: draw those now.
        paint(view, detailHtml({ name: p.name, poster: p.poster, background: p.background, meta: [p.year ? esc(p.year) : "", stars(p.rating, "IMDb")].filter(Boolean),
          genres: p.genres, description: p.description, actions: skActions(), body: skDetailBody() }));
        bindBackdrop();
      },
      render: function (t) { renderTitle(t, state, view); },
    });
  }
  viewTitle.state = {};
  function renderTitle(t, state, view) {
    FEAT = [];
    var nextItem = t.next && t.items.filter(function (i) { return i.id === t.next.item_id; })[0];
    if (state.season === undefined || t.seasons.indexOf(state.season) < 0) state.season = nextItem ? nextItem.season : t.seasons[0];
    var show = t.kind === "show";
    var playLabel = !t.next ? "Play" : t.next.resume ? "Resume" : show && nextItem && nextItem.label ? "Play " + nextItem.label.replace(/^S0?(\d+)E0?(\d+)$/, "S$1 · E$2") : "Play";
    var fav = t.tags.indexOf("favorite") >= 0, wl = t.tags.indexOf("watchlist") >= 0;
    var allWatched = t.items.length && t.items.every(function (i) { return i.completed; });
    var first = ((nextItem || t.items[0] || {}).files || [])[0];
    var seasons = t.seasons.filter(Boolean).length;
    var meta = [show && t.release_info ? esc(t.release_info) : t.year ? esc(t.year) : "",
      !show && t.runtime ? esc(t.runtime) : !show && first && first.duration ? runtime(first.duration) : "",
      stars(t.rating, "IMDb"),
      show && seasons ? plural(seasons, "season") : "",
      show ? plural(t.items.length, "episode") : "",
      show && t.status ? esc(t.status) : ""].filter(Boolean).concat(techTags(first));
    var actions = (t.next ? '<button class="primary" id="play" data-autofocus>' + icon("play") + esc(playLabel) + "</button>" : "") +
      (t.next && t.next.resume ? iconButton("restart", "restart", "Play from the start") : "") +
      (show ? iconButton("shuffle", "shuffle", "Shuffle") : "") +
      iconButton("watched", "seen", allWatched ? "Mark unwatched" : "Mark watched", ' aria-pressed="' + !!allWatched + '"') +
      iconButton("wl", "bookmark", wl ? "On your watchlist" : "Add to watchlist", ' aria-pressed="' + wl + '"') +
      iconButton("fav", "heart", fav ? "A favorite" : "Add to favorites", ' aria-pressed="' + fav + '"') +
      iconButton("collect", "stack", "Collections") +
      (ME.role === "admin" ? '<span class="list-only">' + iconButton("edit", "edit", "Edit details") + "</span>" : "");
    var resume = "";
    if (t.next && t.next.resume && nextItem) {
      var d = nextItem.duration || (first && first.duration) || 0;
      resume = '<div class="resume-line">' + (d ? '<div class="track"><i style="width:' + Math.min(100, 100 * t.next.position / d).toFixed(1) + '%"></i></div>' : "") +
        (show && nextItem.label ? esc(nextItem.label.replace(/^S0?(\d+)E0?(\d+)$/, "S$1 · E$2")) + " · " : "") + esc(d ? left(t.next.position, d) : clock(t.next.position) + " in") + "</div>";
    }
    var facts = [["Directed by", t.director.join(", ")], ["Written by", t.writer.join(", ")], ["Starring", t.cast.slice(0, 5).join(", ")],
      ["Country", t.country], ["Released", fmtDate(t.released)], ["Awards", t.awards]];
    var body = "";
    if (show) {
      body += '<div class="section-h"><h2>Episodes</h2><span class="s" id="ep-count"></span></div>' +
        '<div class="season-bar"><div class="tabs" id="seasons" data-row>' + t.seasons.map(function (s) {
          return '<button data-season="' + s + '" aria-pressed="' + (s === state.season) + '">' + (s ? "Season " + s : "Specials") + "</button>";
        }).join("") + '<button class="ghost" id="season-seen">' + icon("seen") + '<span id="season-seen-label">Mark season watched</span></button></div></div>' +
        '<div class="episodes" id="episodes"></div><div id="admin-files"></div>';
    }
    var people = t.cast.map(function (n) { return { name: n }; })
      .concat(t.director.map(function (n) { return { name: n, role: "Director" }; }))
      .concat(t.writer.filter(function (n) { return t.director.indexOf(n) < 0; }).map(function (n) { return { name: n, role: "Writer" }; }));
    body += peopleRow("Cast &amp; crew", people) + relatedShelf(t.related) + (show ? "" : filesHtml(t.items[0]));
    if (!paint(view, detailHtml({ name: t.name, poster: t.poster, background: t.background, meta: meta, genres: t.genres,
      description: t.description, actions: actions, resume: resume, facts: facts, tech: show ? [] : techRows(first), body: body }))) return;
    bindDetail();

    function episodes() {
      var items = t.items.filter(function (i) { return i.season === state.season; });
      var seen = items.length && items.every(function (i) { return i.completed; });
      $("#ep-count").textContent = plural(items.length, "episode");
      $("#season-seen-label").textContent = seen ? "Mark season unwatched" : "Mark season watched";
      $("#season-seen").setAttribute("data-on", String(!!seen));
      $("#episodes").innerHTML = items.map(function (i) {
        var length = i.files[0] && i.files[0].duration;
        return episodeRow({ attr: 'data-item="' + i.id + '"', thumbnail: i.thumbnail || t.background, num: i.episode ? i.episode + "." : "",
          name: i.name || "Episode " + i.episode, overview: i.overview, position: i.position, duration: i.duration || length,
          meta: [i.label ? esc(i.label.replace(/^S0?(\d+)E0?(\d+)$/, "S$1 · E$2")) : "", i.aired ? esc(fmtDate(i.aired)) : "", length ? esc(runtime(length)) : "",
            i.available ? progressMeta(i) : '<span class="on">File missing</span>'],
          completed: i.completed, unavailable: !i.available, seen: i.id });
      }).join("");
      $("#admin-files").innerHTML = ME.role === "admin" ? items.map(filesHtml).join("") : "";
      $$("#episodes .ep").forEach(function (b) {
        b.onclick = function () { Player.open({ item_id: +b.getAttribute("data-item"), title_id: t.id }); };
      });
      $$("#episodes [data-seen]").forEach(function (b) {
        b.onclick = function () {
          var item = t.items.filter(function (x) { return x.id === +b.getAttribute("data-seen"); })[0], on = !item.completed;
          api("/api/items/" + item.id + "/watched", { method: "POST", body: { watched: on } }).then(function () {
            item.completed = on;
            if (on) item.position = 0;
            var idx = focusables(main).indexOf(b);
            episodes();
            focusEl(focusables(main)[idx]);
          }).catch(fail);
        };
      });
      bindFixButtons();
    }
    if (show) {
      episodes();
      $$("#seasons [data-season]").forEach(function (b) {
        b.onclick = function () {
          state.season = +b.getAttribute("data-season");
          $$("#seasons [data-season]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
          episodes();
        };
      });
      $("#season-seen").onclick = function () {
        var on = this.getAttribute("data-on") !== "true";
        api("/api/titles/" + t.id + "/watched", { method: "POST", body: { watched: on, season: state.season } }).then(refresh).catch(fail);
      };
      // Coming into the season tabs lands on the season shown.
      $("#seasons").setAttribute("data-last", String(t.seasons.indexOf(state.season)));
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
      api("/api/titles/" + t.id + "/watched", { method: "POST", body: { watched: !allWatched } }).then(refresh).catch(fail);
    };
    [["fav", "favorite", fav, "A favorite", "Add to favorites"], ["wl", "watchlist", wl, "On your watchlist", "Add to watchlist"]].forEach(function (x) {
      var on = x[2], button = $("#" + x[0]);
      button.onclick = function () {
        on = !on;
        button.setAttribute("aria-pressed", String(on)); // answer the press at once
        button.setAttribute("data-tip", on ? x[3] : x[4]);
        api("/api/titles/" + t.id + "/tags/" + x[1], { method: on ? "PUT" : "DELETE" }).then(function () {
          toast(on ? (x[1] === "favorite" ? "Added to favorites" : "Added to your watchlist") : (x[1] === "favorite" ? "Removed from favorites" : "Removed from your watchlist"));
          delete CACHE["/api/titles/" + t.id];
        }).catch(function (err) { on = !on; button.setAttribute("aria-pressed", String(on)); fail(err); });
      };
    });
    $("#collect").onclick = function () { collectBox(t); };
    if ($("#edit")) $("#edit").onclick = function () { editBox(t.id); };
  }

  // ---- online anime (AniList details, MegaPlay streams) ----------------------------------
  function viewAnime(id, query, view) {
    document.body.classList.add("over-art");
    var played = false;
    return cachedView(view, "/api/online/anime/" + id, {
      fallback: function () {
        paint(view, '<div class="detail"><div class="detail-main"><div class="detail-poster"><div class="sk" style="padding-top:150%"></div></div><div class="detail-info">' +
          '<div class="sk" style="width:60%;height:2.6rem"></div><div class="sk sk-line" style="width:40%;margin:16px 0"></div>' + skActions() + "</div></div>" + skDetailBody() + "</div>");
      },
      render: function (a) {
        renderAnime(a, id, view);
        if (query.play && !played) { // from a Continue Watching card
          played = true;
          history.replaceState(null, "", "#/anime/" + id);
          Player.open({ online: { anilist_id: a.id, episode: +query.play, lang: viewAnime.state[id].lang }, start: undefined });
        }
      },
    });
  }
  viewAnime.state = {};
  function renderAnime(a, id, view) {
    var state = viewAnime.state[id] || (viewAnime.state[id] = { lang: a.lang || "sub" });
    var PAGE = 100, pages = Math.ceil(a.episodes.length / PAGE);
    if (state.page === undefined) state.page = a.next ? Math.floor((a.next.episode - 1) / PAGE) : 0;
    var resume = a.next && a.next.position > 5;
    var playLabel = !a.next ? "" : (resume ? "Resume" : "Play") + (a.episodes.length > 1 ? " episode " + a.next.episode : "");
    var meta = [a.year ? esc(a.year) : "", FORMATS[a.format] || "",
      a.available ? a.available + (a.total && a.total !== a.available ? " of " + a.total : "") + " episodes" : "Not out yet",
      a.minutes ? a.minutes + " min" : "",
      a.score ? stars((a.score / 10).toFixed(1), "AniList") : "",
      a.status === "RELEASING" ? "Airing" : a.status === "FINISHED" ? "Finished" : ""].filter(Boolean);
    var actions = (a.next ? '<button class="primary" id="play" data-autofocus>' + icon("play") + esc(playLabel) + "</button>" : "") +
      '<div class="choice" id="lang"><button data-lang="sub" aria-pressed="' + (state.lang === "sub") + '">Subtitled</button>' +
      '<button data-lang="dub" aria-pressed="' + (state.lang === "dub") + '">Dubbed</button></div>';
    var resumeLine = resume && a.next.duration ? '<div class="resume-line"><div class="track"><i style="width:' + Math.min(100, 100 * a.next.position / a.next.duration).toFixed(1) +
      '%"></i></div>Episode ' + a.next.episode + " · " + esc(left(a.next.position, a.next.duration)) + "</div>" : "";
    var body = "";
    if (a.episodes.length > 1) {
      body += '<div class="section-h"><h2>Episodes</h2><span class="s">' + a.episodes.length + "</span></div>";
      if (pages > 1) {
        body += '<div class="tabs ep-pages" id="pages" data-row>';
        for (var p = 0; p < pages; p++) {
          body += '<button data-page="' + p + '" aria-pressed="' + (p === state.page) + '">' + (p * PAGE + 1) + "–" + Math.min(a.episodes.length, (p + 1) * PAGE) + "</button>";
        }
        body += "</div>";
      }
      body += '<div class="episodes" id="episodes"></div>';
    }
    body += peopleRow("Characters", (a.characters || []).map(function (c) { return { name: c.name, role: c.role, image: c.image }; }));
    if (!paint(view, detailHtml({ name: a.name, subtitle: a.native, poster: a.poster, background: a.background || a.poster, meta: meta,
      genres: (a.genres || []).slice(0, 6), description: a.description, actions: actions, resume: resumeLine,
      facts: [["Studio", (a.studios || []).join(", ")], ["Season", [a.season, a.year].filter(Boolean).join(" ")]], body: body,
      note: "Streams from MegaPlay through this server." }))) return;
    bindDetail();

    function play(number, start) {
      Player.open({ online: { anilist_id: a.id, episode: number, lang: state.lang }, start: start });
    }
    function episodes() {
      if (!$("#episodes")) return;
      $("#episodes").innerHTML = a.episodes.slice(state.page * PAGE, (state.page + 1) * PAGE).map(function (e) {
        return episodeRow({ attr: 'data-ep="' + e.number + '"', thumbnail: e.thumbnail || a.background, num: e.number + ".",
          name: e.name || "Episode " + e.number, position: e.position, duration: e.duration, completed: e.completed,
          meta: [a.minutes ? a.minutes + " min" : "", progressMeta(e)] });
      }).join("");
      $$("#episodes .ep").forEach(function (b) {
        b.onclick = function () { play(+b.getAttribute("data-ep")); };
      });
    }
    episodes();
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
  }

  // ---- torrent sources: the quality picker, the status line, the prepared stream ----------
  var QUALITY_NAMES = { 480: "SD", 720: "720p", 1080: "1080p", 2160: "4K" };
  function rate(bytes) { return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB/s" : Math.max(1, Math.round(bytes / 1024)) + " KB/s"; }
  function releaseLine(r) {
    return r ? [r.tags.slice(1).join(" "), r.size ? size(r.size) : "", r.seeders != null ? plural(r.seeders, "seeder") : ""].filter(Boolean).join(" · ") : "";
  }
  // 4K only by default where it plays as it is: a 4K HEVC file on a 1080p or non-HEVC screen
  // would be converted on the NAS. The menu still offers it.
  function defaultQuality(options) {
    var c = Player.caps(), prefs = (ME && ME.preferences) || {};
    var uhd = c.max_height >= 2160 && c.video.indexOf("hevc") >= 0 && (!prefs.max_height || +prefs.max_height >= 2160);
    var standard = options.qualities[0], q = options.default;
    if (q === 2160 && !uhd && standard && standard.available) q = standard.quality;
    return q || (standard && standard.quality) || 1080;
  }
  function sourceLabel(state, sources, options) {
    if (state.source === "usenet") return '<span class="lbl">Source</span>Usenet';
    var name = state.quality ? QUALITY_NAMES[state.quality] : options ? "–" : "Auto";
    return '<span class="lbl">' + (sources.usenet ? "Torrent" : "Quality") + "</span>" + esc(name);
  }
  // The line under Play: what will play and whether it is ready, live while the page is open.
  function sourceStatus(state, options, s) {
    var dot = function (kind) { return '<i class="sl-dot ' + kind + '"></i>'; };
    var rel = function (r) { return r && r.name ? '<span class="sl-rel">' + esc(r.name) + "</span>" : ""; };
    if (state.source !== "torrent") return "";
    if (!options) return dot("wait") + "<span>Checking sources…</span>";
    if (options.error) return dot("bad") + "<span>" + esc(options.error) + "</span>";
    if (!options.enabled || (options.engine && !options.engine.ok)) {
      return dot("bad") + "<span>" + esc((options.engine && options.engine.message) || "Torrent streaming is off") + "</span>";
    }
    var q = options.qualities.filter(function (o) { return o.quality === state.quality; })[0];
    if (!q) return "";
    if (!q.available) return dot("bad") + "<span>" + esc(q.reason) + "</span>";
    if (!s) return dot("wait") + "<span>Preparing · " + esc(releaseLine(q.release)) + "</span>" + rel(q.release);
    var r = s.release || q.release, peers = s.peers ? plural(s.peers, "peer") : "";
    if (s.state === "failed") return dot("bad") + "<span>" + esc(s.message) + "</span>";
    if (s.duration) {
      return dot("ok") + "<span>Ready to play" + (peers ? " · " + peers : "") + (s.fallback ? " · switched to another release" : "") + "</span>" + rel(r);
    }
    if (s.state === "buffering") return dot("wait") + "<span>Getting ready · " + Math.round(100 * (s.ready_fraction || 0)) + "%" + (peers ? " · " + peers : "") + "</span>" + rel(r);
    if (s.state === "connecting") return dot("wait") + "<span>Connecting · " + esc(peers) + "</span>" + rel(r);
    return dot("wait") + "<span>Finding sources</span>" + rel(r);
  }
  function sourceMenu(anchor, state, sources, options, onPick) {
    var html = "";
    if (sources.torrent) {
      html += '<div class="menu-h"><b>Torrent</b><span>Plays while it downloads, through the VPN</span></div>';
      if (!options) html += '<p class="menu-note">Checking sources…</p>';
      else if (options.error || !options.enabled) html += '<p class="menu-note">' + esc(options.error || (options.engine && options.engine.message) || "") + "</p>";
      else options.qualities.forEach(function (o) {
        var on = state.source === "torrent" && state.quality === o.quality;
        html += '<button role="menuitemradio" data-q="' + o.quality + '" aria-checked="' + on + '"' + (o.available ? "" : " disabled") + ">" +
          icon("check", "chk") + "<span>" + esc(o.label) + "<small>" + esc(o.available ? releaseLine(o.release) : o.reason) + "</small></span></button>";
      });
    }
    if (sources.usenet) {
      html += (sources.torrent ? "<hr>" : "") + '<div class="menu-h"><b>Usenet</b><span>The best version on the Usenet sidecar</span></div>' +
        '<button role="menuitemradio" data-src="usenet" aria-checked="' + (state.source === "usenet") + '">' + icon("check", "chk") + "<span>Best version</span></button>";
    }
    popMenu(anchor, html, function (m) {
      $$("[data-q]", m).forEach(function (b) { b.onclick = function () { closeMenu(true); onPick("torrent", +b.getAttribute("data-q")); }; });
      $$("[data-src]", m).forEach(function (b) { b.onclick = function () { closeMenu(true); onPick("usenet"); }; });
    });
  }
  // One prepared stream at a time: the server joins the swarm of what Play would start, so play
  // usually starts warm. Polling keeps it alive and stops when the page is left.
  var Warm = { key: null, stream: null, status: null, timer: null, draw: null };
  function warmStop() { clearTimeout(Warm.timer); Warm.key = Warm.stream = Warm.status = Warm.draw = null; }
  function warmStream(req, draw) {
    var key = [req.kind, req.id, req.season, req.episode, req.quality].join("|");
    Warm.draw = draw;
    if (Warm.key === key) { if (Warm.status) draw(Warm.status); return; }
    clearTimeout(Warm.timer);
    Warm.key = key; Warm.stream = null; Warm.status = null;
    function show(s) { if (Warm.key !== key) return false; Warm.status = s; if (Warm.draw) Warm.draw(s); return true; }
    function poll(delay) {
      Warm.timer = setTimeout(function () {
        if (Warm.key !== key) return;
        if (!$("#source-line")) { warmStop(); return; } // the page was left
        api("/api/torrent/streams/" + Warm.stream).then(function (s) {
          if (show(s) && s.state !== "failed") poll(s.duration ? 5000 : 1000);
        }).catch(function () { // expired or stopped (the player closed it): prepare again
          if (Warm.key === key && $("#source-line")) { Warm.key = null; warmStream(req, Warm.draw); }
        });
      }, delay);
    }
    api("/api/torrent/prepare", { method: "POST", body: { kind: req.kind, id: req.id, season: req.season, episode: req.episode, quality: req.quality, player: CLIENT } })
      .then(function (s) { if (!show(s)) return; Warm.stream = s.id; if (s.state !== "failed") poll(700); })
      .catch(function (err) { show({ state: "failed", message: err.message }); });
  }

  // ---- online movies and TV (Cinemeta details; torrent and Usenet streams) ----------------
  function viewWatch(path, query, view) {
    document.body.classList.add("over-art");
    var played = false;
    return cachedView(view, "/api/usenet/title/" + path, {
      fallback: function () {
        paint(view, '<div class="detail"><div class="detail-main"><div class="detail-poster"><div class="sk" style="padding-top:150%"></div></div><div class="detail-info">' +
          '<div class="sk" style="width:60%;height:2.6rem"></div><div class="sk sk-line" style="width:40%;margin:16px 0"></div>' + skActions() + "</div></div></div>");
      },
      render: function (t) {
        var play = renderWatch(t, path, view);
        if (query.play && !played && play) { // from a Continue Watching card
          played = true;
          history.replaceState(null, "", "#/watch/" + path);
          play(+query.play.split(".")[0], +query.play.split(".")[1]);
        }
      },
    });
  }
  viewWatch.state = {};
  function renderWatch(t, path, view) {
    var state = viewWatch.state[path] || (viewWatch.state[path] = {});
    var show = t.kind === "show", next = t.next, seasons = [];
    t.episodes.forEach(function (e) { if (seasons.indexOf(e.season) < 0) seasons.push(e.season); });
    if (state.season === undefined) state.season = next.season || seasons[0];
    // Two online sources play from this page: torrents (with a quality choice) and Usenet.
    // Play uses the one last used for this title, else torrents when the engine is set up.
    var sources = t.sources || { usenet: t.ready, torrent: false };
    var played = (t.source || "") + ":" + (t.quality || 0); // what played last (changes after the player closes)
    if (state.played !== played && t.source && sources[t.source]) {
      state.source = t.source;
      if (t.source === "torrent" && t.quality) state.quality = t.quality;
    }
    state.played = played;
    if (!state.source || !sources[state.source]) state.source = sources.torrent ? "torrent" : sources.usenet ? "usenet" : null;
    var playable = !!state.source && (!show || t.episodes.length);
    var resume = next.position > 5;
    var playLabel = (resume ? "Resume" : "Play") + (show ? " " + watchLabel({ kind: "show", season: next.season, episode: next.episode }) : "");
    var meta = [show && t.release_info ? esc(t.release_info) : t.year ? esc(t.year) : "", t.runtime ? esc(t.runtime) : "",
      stars(t.rating, "IMDb"),
      show && seasons.length ? plural(seasons.length, "season") : "",
      show && t.status ? esc(t.status) : ""].filter(Boolean);
    var actions = !playable ? "" : '<button class="primary" id="play" data-autofocus>' + icon("play") + esc(playLabel) + "</button>" +
      '<button class="dd" id="source" aria-haspopup="menu">' + sourceLabel(state, sources, null) + icon("down") + "</button>" +
      (resume ? iconButton("restart", "restart", "Play from the start") : "") + '<button id="versions">' + icon("sliders") + "Versions</button>";
    var body = '<div id="versions-box"></div>';
    if (show && t.episodes.length) {
      body += '<div class="section-h"><h2>Episodes</h2></div><div class="season-bar"><div class="tabs" id="seasons" data-row>' + seasons.map(function (s) {
        return '<button data-season="' + s + '" aria-pressed="' + (s === state.season) + '">Season ' + s + "</button>";
      }).join("") + '</div></div><div class="episodes" id="episodes"></div>';
    }
    var cast = t.cast || [], director = t.director || [], writer = t.writer || [];
    body += peopleRow("Cast &amp; crew", cast.map(function (n) { return { name: n }; })
      .concat(director.map(function (n) { return { name: n, role: "Director" }; }))
      .concat(writer.filter(function (n) { return director.indexOf(n) < 0; }).map(function (n) { return { name: n, role: "Writer" }; })));
    var note = show && !t.episodes.length ? "Not out yet."
      : sources.torrent && sources.usenet ? "Streams over BitTorrent through the VPN, or from Usenet, through this server."
      : sources.torrent ? "Streams over BitTorrent through the VPN while it downloads."
      : sources.usenet ? "Streams from Usenet through this server."
      : "Playing this needs the torrent engine (TORRENT_URL) or a Usenet indexer and sidecar (NEWZNAB_INDEXERS and USENET_DAV_URL).";
    if (!paint(view, detailHtml({ name: t.name, poster: t.poster, background: t.background || t.poster, meta: meta,
      genres: (t.genres || []).slice(0, 6), description: t.description, actions: actions,
      resume: playable ? '<div class="source-line" id="source-line" aria-live="polite"></div>' : "", body: body,
      facts: [["Directed by", director.join(", ")], ["Written by", writer.join(", ")], ["Starring", cast.slice(0, 5).join(", ")],
        ["Country", t.country], ["Released", fmtDate(t.released)], ["Awards", t.awards]],
      note: note }))) return null;
    bindDetail();

    function play(season, episode, extra) {
      if (!state.source) return;
      var u = { kind: t.kind, id: t.id, season: season, episode: episode };
      if (extra && extra.release) u.release = extra.release;
      if (state.source === "torrent") {
        u.quality = state.quality || 0;
        Player.open({ torrent: u, start: extra && extra.start, usenetOk: sources.usenet, title: t.name,
          subtitle: show ? watchLabel({ kind: "show", season: season, episode: episode }) : "" });
      } else Player.open({ usenet: u, start: extra && extra.start });
    }
    // Torrent qualities for what Play would start, and a prepared stream so play starts warm.
    var options = null;
    function target() { return { kind: t.kind, id: t.id, season: next.season, episode: next.episode }; }
    function optionsPath(e) { return "/api/torrent/options/" + path + "?season=" + e.season + "&episode=" + e.episode; }
    function drawSource(status) {
      var line = $("#source-line");
      if ($("#source")) $("#source").innerHTML = sourceLabel(state, sources, options) + icon("down");
      if (line) line.innerHTML = sourceStatus(state, options, status);
    }
    function warmUp(e) {
      if (state.source !== "torrent" || !options || !options.enabled) { warmStop(); drawSource(null); return; }
      var q = options.qualities.filter(function (o) { return o.quality === state.quality; })[0];
      if (!q || !q.available) { warmStop(); drawSource(null); return; }
      warmStream({ kind: t.kind, id: t.id, season: e.season, episode: e.episode, quality: state.quality }, drawSource);
    }
    function loadOptions() {
      if (state.source !== "torrent") { warmStop(); drawSource(null); return; }
      drawSource(null);
      var p = optionsPath(target());
      var use = function (data) {
        if (view !== VIEW) return;
        options = data;
        if (!state.quality || !data.qualities.some(function (o) { return o.quality === state.quality && o.available; })) state.quality = defaultQuality(data);
        drawSource(null);
        warmUp(target());
      };
      if (CACHE[p]) use(CACHE[p].data);
      api(p).then(function (data) { remember(p, data); use(data); }).catch(function (err) {
        if (view !== VIEW) return;
        options = { enabled: true, error: err.message, qualities: [] };
        drawSource(null);
      });
    }
    if (playable) loadOptions();
    if ($("#source")) $("#source").onclick = function () {
      var anchor = this;
      sourceMenu(anchor, state, sources, options, function (source, quality) {
        state.source = source;
        if (quality) state.quality = quality;
        $("#versions-box").innerHTML = "";
        if (source === "torrent" && !options) loadOptions(); else { drawSource(null); warmUp(target()); }
      });
    };
    function find(card) {
      var at = card.getAttribute("data-ep").split(".");
      return t.episodes.filter(function (e) { return e.season === +at[0] && e.episode === +at[1]; })[0];
    }
    function episodes() {
      $("#episodes").innerHTML = t.episodes.filter(function (e) { return e.season === state.season; }).map(function (e) {
        return episodeRow({ attr: 'data-ep="' + e.season + "." + e.episode + '"', thumbnail: e.thumbnail || t.background, num: e.episode + ".",
          name: e.name || "Episode " + e.episode, overview: e.overview, position: e.position, duration: e.duration, completed: e.completed,
          meta: [esc(watchLabel({ kind: "show", season: e.season, episode: e.episode })), e.aired ? esc(fmtDate(e.aired)) : "", progressMeta(e)] });
      }).join("");
      $$("#episodes .ep").forEach(function (b) {
        b.onclick = function () { var e = find(b); play(e.season, e.episode); };
      });
    }
    if ($("#episodes")) {
      episodes();
      $$("#seasons button").forEach(function (b) {
        b.onclick = function () {
          state.season = +b.getAttribute("data-season");
          $$("#seasons button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
          episodes();
        };
      });
      $("#seasons").setAttribute("data-last", String(seasons.indexOf(state.season)));
    }
    if ($("#play")) $("#play").onclick = function () { play(next.season, next.episode); };
    if ($("#restart")) $("#restart").onclick = function () { play(next.season, next.episode, { start: 0 }); };
    // Every release of the film, or of the episode Play would start, best picture first.
    if ($("#versions")) $("#versions").onclick = function () {
      var box = $("#versions-box");
      box.innerHTML = '<div class="box"><h3 style="margin-top:0">Versions</h3><div class="sk sk-line" style="width:70%"></div><div class="sk sk-line" style="width:60%"></div><div class="sk sk-line" style="width:65%"></div></div>';
      if (state.source === "torrent") { // the ranked releases at the chosen quality, best first
        var label = QUALITY_NAMES[state.quality] || "";
        api("/api/torrent/releases/" + path + "?season=" + next.season + "&episode=" + next.episode + "&quality=" + (state.quality || 0)).then(function (data) {
          if (!box.isConnected) return;
          box.innerHTML = '<div class="box"><h3 style="margin-top:0">Versions · ' + esc(label) + " torrents</h3>" + (data.releases.length
            ? '<div class="versions">' + data.releases.map(function (r, i) {
              var tags = r.tags.map(function (x) { return '<span class="tag">' + esc(x) + "</span>"; }).join("");
              return '<button data-i="' + i + '" title="' + esc(r.why.join("\n")) + '">' + tags + "<span>" + esc(r.name) + "</span><span>" +
                [r.size ? size(r.size) : "", r.seeders != null ? plural(r.seeders, "seeder") : ""].filter(Boolean).join(" · ") + "</span></button>";
            }).join("") + "</div>" : '<p class="empty small">No ' + esc(label) + " release passes the checks.</p>") + "</div>";
          $$("button", box).forEach(function (b) {
            b.onclick = function () { play(next.season, next.episode, { release: data.releases[+b.getAttribute("data-i")].hash }); };
          });
          if ($("button", box)) focusEl($("button", box));
        }).catch(function (err) { box.innerHTML = ""; fail(err); });
        return;
      }
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
    return play;
  }

  function filesHtml(item) {
    if (!item || ME.role !== "admin") return "";
    return '<div class="box list-only" style="margin-top:18px"><h3 style="margin-top:0">' + esc(item.label ? item.label + " · files" : "Files") + "</h3><ul class=\"files\">" +
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
    holder.innerHTML = '<form class="box" style="margin-top:12px"><div class="form-grid">' +
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
    if (TV) focusEl(form.elements.name); else form.elements.name.focus();
  }

  // Add to or remove from collections, or start a new one, in a dialog.
  function collectBox(t) {
    api("/api/collections").then(function (list) {
      openModal('<h2>Collections<span class="grow"></span><button class="icon-btn" id="m-close" aria-label="Close">' + icon("close") + "</button></h2>" +
        '<p class="muted small">' + esc(t.name) + "</p>" +
        (list.length ? '<div class="col-pick">' + list.map(function (c) {
          var has = c.titles.indexOf(t.id) >= 0;
          return '<button data-col="' + c.id + '" aria-pressed="' + has + '">' + icon("check") + "<span>" + esc(c.name) + '</span><span class="grow"></span><span class="muted small">' + plural(c.titles.length, "title") + "</span></button>";
        }).join("") + "</div>" : '<p class="muted">No collections yet. Name one to start.</p>') +
        '<form class="new-col" id="m-new"><input name="name" placeholder="New collection" required><button class="primary">' + icon("plus") + "Create</button></form>",
        function (box) {
          $("#m-close", box).onclick = closeModal;
          $$("[data-col]", box).forEach(function (b) {
            b.onclick = function () {
              var on = b.getAttribute("aria-pressed") !== "true";
              b.setAttribute("aria-pressed", String(on));
              api("/api/collections/" + b.getAttribute("data-col"), { method: "PATCH", body: on ? { add: t.id } : { remove: t.id } })
                .catch(function (err) { b.setAttribute("aria-pressed", String(!on)); fail(err); });
            };
          });
          $("#m-new", box).onsubmit = function (e) {
            e.preventDefault();
            api("/api/collections", { method: "POST", body: { name: e.target.elements.name.value, titles: [t.id] } })
              .then(function (c) { toast("Added to " + c.name); collectBox(t); }).catch(fail);
          };
        });
    }).catch(fail);
  }

  // Edit a title's details (admins). Edited fields are locked against metadata refreshes.
  function editBox(id) {
    api("/api/admin/titles/" + id).then(function (t) {
      var fields = [["name", "Name"], ["year", "Year"], ["imdb_id", "IMDb ID"], ["poster", "Poster URL"],
                    ["background", "Backdrop URL"], ["genres", "Genres (comma separated)"]];
      function lock(f) {
        return t.locked_fields.indexOf(f) >= 0 ? ' <span class="lock">· locked</span> <button type="button" class="small ghost" data-unlock="' + f + '">Unlock</button>' : "";
      }
      openModal('<form id="m-edit"><h2>Edit details<span class="grow"></span><button type="button" class="icon-btn" id="m-close" aria-label="Close">' + icon("close") + "</button></h2>" +
        '<p class="muted small">Edited fields are locked so metadata refreshes never overwrite them. Matched: ' + (t.matched === 1 ? "yes" : t.matched === -1 ? "no match found" : "not yet") + "</p>" +
        '<div class="form-grid">' + fields.map(function (f) {
          var value = f[0] === "genres" ? (t.genres || []).join(", ") : t[f[0]];
          return "<label>" + f[1] + lock(f[0]) + '<input name="' + f[0] + '" value="' + esc(value == null ? "" : value) + '"></label>';
        }).join("") + "</div><label>Description" + lock("description") + '<textarea name="description" rows="4">' + esc(t.description || "") + "</textarea></label>" +
        '<div class="row"><button class="primary">Save</button><button type="button" id="refresh">' + icon("refresh") + 'Refresh from Cinemeta</button><span class="error"></span></div>' +
        '<h3>Find the right match</h3><div class="row"><input id="msearch" placeholder="Search Cinemeta" value="' + esc(t.name) + '" style="max-width:320px"><button type="button" id="msearch-go">' + icon("search") + 'Search</button></div><div id="mresults"></div></form>',
        function (box) {
          var form = $("#m-edit", box);
          $("#m-close", box).onclick = closeModal;
          form.onsubmit = function (e) {
            e.preventDefault();
            var body = {};
            fields.concat([["description"]]).forEach(function (f) {
              var value = form.elements[f[0]].value.trim();
              var before = f[0] === "genres" ? (t.genres || []).join(", ") : (t[f[0]] == null ? "" : String(t[f[0]]));
              if (value !== before) body[f[0]] = value;
            });
            api("/api/admin/titles/" + id, { method: "PATCH", body: body }).then(function () { toast("Saved"); closeModal(); refresh(); })
              .catch(function (err) { $(".error", form).textContent = err.message; });
          };
          $$("[data-unlock]", form).forEach(function (b) {
            b.onclick = function () {
              api("/api/admin/titles/" + id, { method: "PATCH", body: { unlock: [b.getAttribute("data-unlock")] } })
                .then(function () { editBox(id); }).catch(fail);
            };
          });
          $("#refresh", box).onclick = function () {
            api("/api/admin/titles/" + id + "/refresh", { method: "POST" }).then(function () { toast("Refreshed"); closeModal(); refresh(); }).catch(fail);
          };
          $("#msearch-go", box).onclick = function () {
            $("#mresults", box).innerHTML = '<div class="sk sk-line" style="width:60%"></div><div class="sk sk-line" style="width:50%"></div>';
            api("/api/admin/metadata/search?kind=" + t.kind + "&q=" + encodeURIComponent($("#msearch", box).value)).then(function (list) {
              $("#mresults", box).innerHTML = list.length ? list.map(function (m) {
                return '<button type="button" class="match" data-imdb="' + esc(m.imdb_id) + '">' + (m.poster ? '<img alt="" src="' + esc(m.poster) + '" onerror="this.className=\'ph\';this.removeAttribute(\'src\')">' : '<span class="ph"></span>') +
                  "<span>" + esc(m.name) + " (" + esc(m.year || "?") + ')<br><span class="small muted">' + esc(m.imdb_id) + "</span></span></button>";
              }).join("") : '<p class="muted">No results.</p>';
              $$("[data-imdb]", box).forEach(function (b) {
                b.onclick = function () {
                  api("/api/admin/titles/" + id, { method: "PATCH", body: { imdb_id: b.getAttribute("data-imdb") } })
                    .then(function () { toast("Matched"); closeModal(); refresh(); }).catch(fail);
                };
              });
            }).catch(fail);
          };
        });
    }).catch(fail);
  }

  // ---- collections ------------------------------------------------------------------------
  function collage(ids) {
    return '<div class="col-art"><div class="fallback">' + icon("stack") + "</div>" + ids.slice(0, 3).map(function (id, i) {
      var src = "/api/art/" + id + "/poster";
      return '<img alt="" class="p' + i + (LOADED[src] ? " ready" : "") + '" src="' + src + '" onload="this.classList.add(\'ready\')" onerror="this.remove()">';
    }).join("") + "</div>";
  }
  function viewCollections(_, __, view) {
    return cachedView(view, "/api/collections", {
      fallback: function () { paint(view, skHead(200) + '<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr))">' + skCards(4, true) + "</div>"); },
      render: function (list) {
        paint(view, '<div class="page-head"><h1>Collections</h1><span class="count">' + plural(list.length, "collection") + "</span></div>" +
          '<form class="new-col" id="new-col"><input name="name" placeholder="New collection name" required><button>' + icon("plus") + "Create</button></form>" +
          (list.length ? '<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr))">' + list.map(function (c) {
            return '<a class="col-tile" href="#/collection/' + c.id + '">' + collage(c.titles) + '<div class="caption"><b>' + esc(c.name) + "</b><span>" + plural(c.titles.length, "title") + "</span></div></a>";
          }).join("") + "</div>" : stateHtml("stack", "No collections yet", "Group titles any way you like, then play a whole collection in order or shuffled. Add titles from their page with the Collections button.")));
        $("#new-col").onsubmit = function (e) {
          e.preventDefault();
          api("/api/collections", { method: "POST", body: { name: e.target.elements.name.value, titles: [] } }).then(refresh).catch(fail);
        };
      },
    });
  }

  function viewCollection(id, _, view) {
    return cachedView(view, "/api/collections/" + id, {
      fallback: function () { paint(view, skHead(260) + skGrid(8)); },
      render: function (c) {
        FEAT = [];
        paint(view, '<div class="page-head"><h1>' + esc(c.name) + '</h1><span class="count">' + plural(c.cards.length, "title") + "</span></div>" +
          '<div class="actions" data-row style="margin-bottom:18px">' +
          (c.cards.length ? '<button id="play-all" class="primary" data-autofocus>' + icon("play") + "Play all</button><button id=\"shuffle-all\">" + icon("shuffle") + "Shuffle</button>" : "") +
          iconButton("rename", "edit", "Rename") + iconButton("delete", "trash", "Delete collection") + "</div>" +
          (c.cards.length ? '<div class="grid">' + c.cards.map(titleCard).join("") + "</div>" : stateHtml("stack", "This collection is empty", "Add titles from their page with the Collections button.")));
        function queue(mode) {
          api("/api/queues", { method: "POST", body: { name: c.name, mode: mode, collection: c.id } })
            .then(function (q) { Player.open({ item_id: q.current, queue: q.id }); }).catch(fail);
        }
        if ($("#play-all")) { $("#play-all").onclick = function () { queue("sequential"); }; $("#shuffle-all").onclick = function () { queue("shuffle"); }; }
        $("#rename").onclick = function () {
          promptDialog("Rename collection", "Name", c.name, "Rename").then(function (name) {
            if (name) api("/api/collections/" + c.id, { method: "PATCH", body: { name: name } }).then(refresh).catch(fail);
          });
        };
        $("#delete").onclick = function () {
          confirmDialog("Delete " + c.name + "?", "The titles stay in your library.", "Delete", true).then(function (yes) {
            if (yes) api("/api/collections/" + c.id, { method: "DELETE" }).then(function () { location.hash = "#/collections"; }).catch(fail);
          });
        };
      },
    });
  }

  // ---- settings -------------------------------------------------------------------------
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
  var PREF_MENUS = {};
  function prefMenu(name, options, value) { // a long list of choices: a drop-down instead of buttons
    PREF_MENUS[name] = options;
    return '<button class="dd" data-row data-pref="' + name + '" aria-haspopup="menu"><span class="v">' + esc(label(options, value)) + "</span>" + icon("down") + "</button>";
  }
  function setRow(title, hint, control) {
    return '<div class="set-row"><div class="set-l"><b>' + title + "</b>" + (hint ? "<span>" + hint + "</span>" : "") + '</div><div class="set-c">' + control + "</div></div>";
  }

  function viewSettings(_, __, view) {
    return cachedView(view, "/api/preferences", {
      fallback: function () { paint(view, skHead(160) + '<div class="box"><div class="sk sk-line" style="width:50%"></div><div class="sk sk-line" style="width:70%"></div><div class="sk sk-line" style="width:40%"></div></div>'); },
      render: function (p) { renderSettings(p, view); },
    });
  }
  function renderSettings(p, view) {
    paint(view, '<div class="page-head"><h1>Settings</h1></div>' +
      '<div class="box"><h2>Playback</h2>' +
      setRow("Audio language", "Used when a file has more than one audio track.", prefMenu("audio_language", LANGS, p.audio_language)) +
      setRow("Subtitles", "Automatic shows forced subtitles, and full subtitles when the audio is not in your subtitle language.",
        choice("subtitle_mode", [["off", "Off"], ["auto", "Automatic"], ["always", "Always on"]], p.subtitle_mode)) +
      setRow("Subtitle language", "", prefMenu("subtitle_language", [["", "Same as audio"]].concat(LANGS.slice(1)), p.subtitle_language)) +
      setRow("Maximum quality", "Higher quality than this is converted down.", choice("max_height", [[2160, "4K"], [1080, "1080p"], [720, "720p"], [480, "480p"]], p.max_height)) +
      setRow("Surround sound", "Downmix when your speakers are stereo.", choice("stereo", [[false, "Keep surround"], [true, "Downmix to stereo"]], p.stereo)) +
      setRow("Autoplay", "Play the next episode when one ends.", choice("autoplay_next", [[true, "On"], [false, "Off"]], p.autoplay_next)) +
      "</div>" +
      '<div class="box"><h2>Subtitle style</h2>' +
      SUB_STYLE.map(function (s) { return setRow(s[1], "", choice(s[0], s[2], p[s[0]])); }).join("") + "</div>" +
      '<div class="box"><h2>Account</h2><div class="account-card"><span class="avatar" style="--hue:' + hue(ME.name) + '">' + esc(initials(ME.name)) + "</span><div><b>" + esc(ME.name) + '</b><div class="muted small">' + esc(ME.email) +
      (ME.role === "admin" ? " · Administrator" : "") + "</div></div></div>" +
      '<form id="pw" class="list-only"><div class="form-grid"><label>Current password<input type="password" name="current" autocomplete="current-password"></label>' +
      '<label>New password<input type="password" name="password" autocomplete="new-password" minlength="10"></label></div>' +
      '<button>Change password</button> <span class="error"></span></form>' +
      '<p style="margin-top:16px"><button id="logout">' + icon("logout") + "Sign out</button></p></div>");
    $$("[data-choice]").forEach(function (group) {
      group.setAttribute("data-last", String($$("button", group).indexOf($("[aria-pressed='true']", group))));
      $$("button", group).forEach(function (b) {
        b.onclick = function () {
          var raw = b.getAttribute("data-value"), value = raw === "true" ? true : raw === "false" ? false : /^\d+$/.test(raw) ? +raw : raw;
          var body = {}, before = $("[aria-pressed='true']", group);
          body[group.getAttribute("data-choice")] = value;
          $$("button", group).forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); // answer at once
          api("/api/preferences", { method: "PUT", body: body }).then(function (saved) {
            ME.preferences = saved;
            remember("/api/preferences", saved);
          }).catch(function (err) {
            $$("button", group).forEach(function (x) { x.setAttribute("aria-pressed", String(x === before)); });
            fail(err);
          });
        };
      });
    });
    $$("[data-pref]").forEach(function (b) {
      b.onclick = function () {
        var name = b.getAttribute("data-pref"), options = PREF_MENUS[name];
        choiceMenu(b, options, ME.preferences && ME.preferences[name] !== undefined ? ME.preferences[name] : p[name], function (v) {
          var body = {};
          body[name] = v;
          $(".v", b).textContent = label(options, v);
          api("/api/preferences", { method: "PUT", body: body }).then(function (saved) { ME.preferences = saved; p = saved; remember("/api/preferences", saved); }).catch(fail);
        });
      };
    });
    $("#pw").onsubmit = function (e) {
      e.preventDefault();
      api("/api/me/password", { method: "POST", body: { current: e.target.elements.current.value, password: e.target.elements.password.value } })
        .then(function () { toast("Password changed"); e.target.reset(); })
        .catch(function (err) { $(".error", e.target).textContent = err.message; });
    };
    $("#logout").onclick = signOut;
  }
  function signOut() { api("/api/logout", { method: "POST" }).then(function () { ME = null; CACHE = {}; showLogin(); }); }

  // ---- admin: dashboard, library, people, live TV --------------------------------------------
  var ADMIN_TABS = [["", "Dashboard", "pulse"], ["library", "Library", "folder"], ["users", "People", "users"], ["live", "Live TV", "live"]];
  function adminHead(tab, extra) {
    return '<div class="page-head"><h1>Admin</h1>' + (extra || "") + '</div><nav class="subnav" data-row>' + ADMIN_TABS.map(function (t) {
      return '<a href="#/admin' + (t[0] ? "/" + t[0] : "") + '" class="' + (t[0] === tab ? "on" : "") + '"' + (t[0] === tab ? " data-autofocus" : "") + ">" + icon(t[2]) + t[1] + "</a>";
    }).join("") + "</nav>";
  }
  function viewAdmin(tab, _, view) {
    tab = tab || "";
    if (ME.role !== "admin") return paint(view, stateHtml("shield", "Administrators only", "Ask an administrator if you need something changed."));
    if (tab === "library") return adminLibrary(view);
    if (tab === "users") return adminUsers(view);
    if (tab === "live") {
      paint(view, adminHead("live") + '<div id="admin-live" class="box"><h2>Live TV</h2><div class="sk sk-line" style="width:50%"></div><div class="sk sk-line" style="width:30%"></div></div>');
      adminLive($("#admin-live"));
      return;
    }
    return adminDashboard(view);
  }
  function sessionsHtml(o) {
    return '<div class="box" id="now-playing"><h2>Now playing</h2>' + (o.sessions.length ? '<div class="table-wrap"><table><tr><th>User</th><th>Mode</th><th>Why</th><th>Age</th></tr>' +
      o.sessions.map(function (s) {
        return "<tr><td>" + s.user_id + '</td><td><span class="pill ' + s.mode + '">' + s.mode + "</span>" + (s.hwaccel ? " " + esc(s.hwaccel) : "") +
          "</td><td>" + esc(s.reasons.join("; ")) + (s.error ? '<br><span class="error">' + esc(s.error) + "</span>" : "") + "</td><td>" + clock(s.age) + "</td></tr>";
      }).join("") + "</table></div>" : '<p class="muted">No active streams. Direct play does not appear here.</p>') + "</div>";
  }
  function scanSummary(o) {
    var last = o.scan.last;
    return last ? '<p class="small muted">Last scan ' + new Date(last.started * 1000).toLocaleString() + " in " + last.seconds + "s: " + last.files + " files, " +
      last.added + " added, " + last.updated + " updated, " + last.missing + " newly missing, " + last.refused + " refused links." +
      (last.errors.length ? '<br><span class="error">' + last.errors.map(esc).join("<br>") + "</span>" : "") + "</p>" : '<p class="small muted">No scan has finished yet.</p>';
  }
  function scanButton(o) {
    return '<span class="grow"></span><button class="primary" id="scan"' + (o.scan.running ? " disabled" : "") + ">" + icon("refresh") +
      (o.scan.running ? "Scanning…" : "Scan library now") + "</button>" + (o.scan.metadata_running ? '<span class="muted small" style="margin-left:14px">Fetching metadata…</span>' : "");
  }
  function bindScan() {
    if (!$("#scan")) return;
    $("#scan").onclick = function () {
      api("/api/admin/scan", { method: "POST" }).then(function () {
        toast("Scan started");
        $("#scan").disabled = true;
        $("#scan").textContent = "Scanning…";
        var view = VIEW;
        var poll = setInterval(function () {
          if (view !== VIEW) return clearInterval(poll);
          api("/api/admin/overview").then(function (x) {
            if (!x.scan.running && !x.scan.metadata_running) { clearInterval(poll); refresh(); }
          }).catch(function () { clearInterval(poll); });
        }, 1500);
      }).catch(fail);
    };
  }
  function adminDashboard(view) {
    return cachedView(view, "/api/admin/overview", {
      fallback: function () { paint(view, adminHead("") + '<div class="stats">' + [1, 2, 3, 4, 5, 6].map(function () { return '<div class="sk" style="height:76px"></div>'; }).join("") + "</div>"); },
      render: function (o) {
        var labels = { movies: "Movies", shows: "Shows", files: "Files", missing: "Missing files", unmatched: "Need placing", no_metadata: "No metadata" };
        paint(view, adminHead("", scanButton(o)) +
          '<div class="stats">' + ["movies", "shows", "files", "missing", "unmatched", "no_metadata"].map(function (k) {
            var warn = k !== "movies" && k !== "shows" && k !== "files" && o.counts[k] > 0;
            var href = warn ? "#/admin/library" : k === "movies" ? "#/movies" : k === "shows" ? "#/shows" : "";
            return (href ? '<a class="stat' + (warn ? " warn" : "") + '" href="' + href + '">' : '<span class="stat">') + "<b>" + o.counts[k] + "</b>" + labels[k] + (href ? "</a>" : "</span>");
          }).join("") + "</div>" + sessionsHtml(o) +
          '<div class="box"><h2>Server</h2><p class="small muted">Folders: ' + (o.roots.length ? o.roots.map(esc).join(", ") : "none — set LIBRARY_ROOTS") + "<br>" +
          "Hardware acceleration: " + esc(o.settings.hwaccel) + " · Transcode slots: " + o.settings.max_transcodes +
          " · Metadata: " + (o.settings.metadata_online ? "online (Cinemeta)" : "offline") + "</p>" + scanSummary(o) + "</div>");
        bindScan();
        // Keep Now playing current while the dashboard is open.
        var timer = setInterval(function () {
          if (view !== VIEW || !$("#now-playing")) return clearInterval(timer);
          if (!$("#player").hidden) return;
          api("/api/admin/overview").then(function (x) { var box = $("#now-playing"); if (box && view === VIEW) box.outerHTML = sessionsHtml(x); }).catch(function () {});
        }, 10000);
      },
    });
  }
  function adminLibrary(view) {
    paint(view, adminHead("library") + '<div class="box"><div class="sk sk-line" style="width:40%"></div><div class="sk sk-line" style="width:60%"></div></div>');
    return Promise.all([api("/api/admin/overview"), api("/api/admin/review")]).then(function (r) {
      var o = r[0], rev = r[1];
      var html = adminHead("library", scanButton(o)) +
        '<div class="box"><h2>Folders</h2><p class="small muted">' + (o.roots.length ? o.roots.map(esc).join("<br>") : "None — set LIBRARY_ROOTS") + "</p>" + scanSummary(o) + "</div>";
      html += '<div class="box"><h2>Needs review</h2>' + (rev.files.length ? '<p class="muted small">Files the scanner could not place. Your placement is remembered across rescans.</p><div class="table-wrap"><table>' +
        rev.files.map(function (f) {
          return '<tr><td class="path">' + esc(f.path) + '<br><span class="small muted">' + esc(f.reason) + '</span><div data-holder="' + f.id + '"></div></td><td style="width:1%"><button data-assign="' + f.id + '">Place…</button></td></tr>';
        }).join("") + "</table></div>" : '<p class="muted">Every file is placed.</p>') + "</div>";
      html += '<div class="box"><h2>No metadata match</h2>' + (rev.titles.length ? '<p class="muted small">Open a title and use Edit details to find the right match.</p><div class="table-wrap"><table>' + rev.titles.map(function (t) {
        return '<tr><td><a href="#/title/' + t.id + '"><u>' + esc(t.name) + "</u></a> " + esc(t.year || "") + ' <span class="pill">' + t.kind + "</span></td></tr>";
      }).join("") + "</table></div>" : '<p class="muted">Every title has metadata.</p>') + "</div>";
      if (rev.missing.length) html += '<div class="box"><h2>Missing files</h2><div class="table-wrap"><table>' + rev.missing.map(function (f) {
        return '<tr><td class="path">' + esc(f.path) + "</td></tr>";
      }).join("") + "</table></div></div>";
      if (!paint(view, html)) return;
      bindScan();
      $$("[data-assign]").forEach(function (b) {
        b.onclick = function () {
          var id = b.getAttribute("data-assign");
          assignForm($('[data-holder="' + id + '"]'), {}, function (body) {
            return api("/api/admin/review/" + id + "/assign", { method: "POST", body: body }).then(function () { toast("Placed"); refresh(); });
          });
        };
      });
    });
  }
  function adminUsers(view) {
    return cachedView(view, "/api/admin/users", {
      fallback: function () { paint(view, adminHead("users") + '<div class="box"><div class="sk sk-line" style="width:40%"></div><div class="sk sk-line" style="width:60%"></div></div>'); },
      render: function (users) {
        paint(view, adminHead("users") + '<div class="box"><h2>People</h2><div class="table-wrap"><table><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr>' + users.map(function (u) {
          return '<tr><td><span class="avatar" style="--hue:' + hue(u.name) + ';width:28px;height:28px;font-size:0.75rem;margin-right:10px;vertical-align:middle">' + esc(initials(u.name)) + "</span>" + esc(u.name) +
            "</td><td>" + esc(u.email) + "</td><td>" + (u.role === "admin" ? "Administrator" : "Member") + (u.active ? "" : ' <span class="pill">disabled</span>') + '</td><td style="text-align:right">' +
            (u.id !== ME.id ? '<button class="small" data-toggle="' + u.id + '" data-active="' + u.active + '">' + (u.active ? "Disable" : "Enable") + "</button>" : '<span class="muted small">You</span>') + "</td></tr>";
        }).join("") + '</table></div></div><form id="add-user" class="box"><h2>Add someone</h2><div class="form-grid"><label>Name<input name="name"></label><label>Email<input name="email" type="email"></label>' +
          '<label>Password<input name="password" type="password" minlength="10"></label><label>Role<select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label></div>' +
          '<button class="primary">' + icon("plus") + 'Add</button> <span class="error"></span></form>');
        $$("[data-toggle]").forEach(function (b) {
          b.onclick = function () {
            api("/api/admin/users/" + b.getAttribute("data-toggle"), { method: "PATCH", body: { active: b.getAttribute("data-active") !== "1" } }).then(refresh).catch(fail);
          };
        });
        $("#add-user").onsubmit = function (e) {
          e.preventDefault();
          var f = e.target.elements;
          api("/api/admin/users", { method: "POST", body: { name: f.name.value, email: f.email.value, password: f.password.value, role: f.role.value } })
            .then(function () { toast("Added " + f.name.value); refresh(); })
            .catch(function (err) { $(".error", e.target).textContent = err.message; });
        };
      },
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
      : '<p class="small muted" style="margin:8px 0 0">None of your channels lists this.</p>';
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
    if (!CACHE["/api/live"]) paint(view, '<div class="page-head"><h1>Live sports</h1></div><div class="sk" style="height:110px;max-width:1100px;margin-bottom:10px"></div><div class="sk" style="height:110px;max-width:1100px"></div>');
    return api("/api/live").then(function (st) {
      remember("/api/live", st);
      if (!st.enabled) return paint(view, stateHtml("live", "Live TV is off", "This server has live TV turned off (LIVE_TV=false)."));
      if (!st.channels) {
        return paint(view, stateHtml("live", "No channels yet", ME.role === "admin" ? "Add your IPTV provider under Admin → Live TV, and the day's matches appear here with the channels that show them."
          : "Ask your administrator to add an IPTV provider.", ME.role === "admin" ? '<a class="btn primary" href="#/admin/live" data-autofocus>Set up live TV</a>' : ""));
      }
      var lang = LIVE.lang === null ? (LIVE.lang = liveLang()) : LIVE.lang;
      var langs = [["", "Any language"]].concat(st.languages.filter(function (l) { return l.name !== "Unspecified"; }).map(function (l) { return [l.name, l.name + " (" + l.count + ")"]; }));
      var html = '<div class="page-head"><h1>Live sports</h1></div><div class="toolbar" data-row><div class="choice" id="live-tabs" style="margin:0 10px 8px 0">' +
        '<button data-tab="schedule" aria-pressed="' + (LIVE.tab === "schedule") + '">Schedule</button>' +
        '<button data-tab="channels" aria-pressed="' + (LIVE.tab === "channels") + '">Channels</button></div>' +
        dd("live-lang", "Language", lang || "Any", !!lang) + "</div>" +
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
      $("#live-lang").onclick = function () {
        var button = this;
        choiceMenu(button, langs, LIVE.lang || "", function (v) {
          LIVE.lang = liveLang(v);
          button.innerHTML = '<span class="lbl">Language</span>' + esc(v || "Any") + icon("down");
          button.classList.toggle("on", !!v);
          liveBody(view);
        });
      };
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
    }).join("") + '</div><div class="choice" id="live-sports" data-row></div></div><div id="live-events">' +
      '<div class="sk" style="height:110px;max-width:1100px;margin-bottom:10px"></div><div class="sk" style="height:110px;max-width:1100px"></div></div>';
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
      $("#live-sports").innerHTML = sports.length > 1 ? [""].concat(sports).map(function (s) {
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
      $("#live-events").innerHTML = html || stateHtml("live", "Nothing on the schedule" + (LIVE.sport ? " for " + LIVE.sport : ""), "Try another day, or browse every channel.",
        '<button id="to-channels">Browse channels</button>');
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
        var daysLeft = a && a.expires ? Math.ceil((a.expires * 1000 - Date.now()) / 86400000) : null;
        html += '<div class="stats"><span class="stat"><b>' + d.channels + '</b>channels</span><span class="stat"><b>' + g.channels + '</b>with a TV guide</span>' +
          '<span class="stat"><b>' + d.max_connections + "</b>at a time</span></div>" +
          "<p>" + esc(d.name || "Channels") + (d.imported ? ' <span class="muted small">imported ' + new Date(d.imported).toLocaleDateString() + "</span>" : "") + "</p>" +
          (a && a.kind === "xtream" ? "<p>Provider <b>" + esc(a.server) + "</b>: " + (a.active ? '<span class="good">active</span>' : '<span class="error">' + esc(a.status) + "</span>") +
            (a.expires ? " · subscription ends " + new Date(a.expires * 1000).toLocaleDateString() +
              (daysLeft !== null && daysLeft <= 14 ? ' <span class="error">(' + (daysLeft <= 0 ? "expired" : daysLeft + " days left") + ")</span>" : "") : "") +
            (a.max_connections ? " · " + a.max_connections + " connection" + (a.max_connections === 1 ? "" : "s") + " allowed" : "") + "</p>" : "") +
          '<form id="live-conn" class="inline-form"><label>Channels at a time <input name="n" type="number" min="1" max="20" value="' + d.max_connections + '"></label> <button>Save</button></form>' +
          "<h3>TV guides</h3>" + (g.sources.length ? '<div class="table-wrap"><table>' + g.sources.map(function (s) {
            return '<tr><td class="path">' + esc(s.url) + "</td><td>" + (s.ok ? s.channels + " channels" : '<span class="error">' + esc(s.error) + "</span>") + "</td></tr>";
          }).join("") + "</table></div>" : '<p class="muted">Not fetched yet.</p>') +
          '<p class="small muted">' + (g.updated ? "Updated " + new Date(g.updated * 1000).toLocaleString() + ". " : "") + "Guides refresh every six hours. Fixtures come from ESPN" + (d.fixtures ? "." : " (turned off).") + "</p>" +
          '<button id="live-guide"' + (g.running ? " disabled" : "") + ">" + icon("refresh") + (g.running ? "Refreshing…" : "Refresh guides now") + "</button>" +
          "<h3>Streaming now</h3>" + (d.streams.length ? '<div class="table-wrap"><table>' + d.streams.map(function (s) {
            return "<tr><td>" + esc(s.channel.name) + '</td><td><span class="pill ' + (s.video === "copy" ? "remux" : "transcode") + '">' + s.video + "</span></td><td>" + s.viewers + " watching · " + clock(s.age) +
              (s.restarts ? " · " + s.restarts + " reconnects" : "") + (s.error ? '<br><span class="error">' + esc(s.error) + "</span>" : "") + '</td><td><button class="small" data-end="' + esc(s.id) + '">End</button></td></tr>';
          }).join("") + "</table></div>" : '<p class="muted">Nothing is streaming.</p>');
      } else {
        html += '<p class="muted">No channels yet. Import your IPTV provider below.</p>';
      }
      html += "<h3>" + (d.channels ? "Import again (replaces the list)" : "Import channels") + '</h3><form id="live-xtream"><div class="form-grid">' +
        '<label>Server<input name="server" placeholder="http://provider.example:8080" required></label>' +
        '<label>Username<input name="username" autocomplete="off" required></label><label>Password<input name="password" type="password" autocomplete="new-password" required></label></div>' +
        '<label class="check"><input type="checkbox" name="everything"> All channels, not only sports</label> <button class="primary">Import from Xtream Codes</button> <span class="error"></span></form>' +
        '<form id="live-m3u" style="margin-top:16px"><label>Or an M3U playlist file<input type="file" name="file" accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain"></label> <button>Import playlist</button> <span class="error"></span></form>' +
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
    document.body.classList.remove("over-art");
    closeMenu(false);
    closeModal();
    if (!$("#player").hidden) Player.close();
    api("/api/status").then(function (status) {
      var setup = status.setup;
      main.innerHTML = '<div class="auth-wrap"><form class="auth" id="auth"><div class="logo">' + icon("logo") + "<b>Mediawan</b></div><h1>" + (setup ? "Welcome" : "Sign in") + "</h1>" +
        (setup ? '<p class="muted">Create the administrator account to get started.</p><label>Name<input name="name" value="Administrator"></label>' : '<p class="muted">Your films and shows, everywhere.</p>') +
        '<label>Email<input name="email" type="email" autocomplete="username" required data-autofocus></label>' +
        '<label>Password<input name="password" type="password" autocomplete="' + (setup ? "new-password" : "current-password") + '" required' + (setup ? ' minlength="10"' : "") + "></label>" +
        '<button class="primary">' + (setup ? "Create account" : "Sign in") + '</button><p class="error"></p></form></div>';
      var form = $("#auth");
      form.onsubmit = function (e) {
        e.preventDefault();
        var f = form.elements, body = { email: f.email.value, password: f.password.value }, button = $("button", form);
        if (setup) body.name = f.name.value;
        button.disabled = true;
        button.textContent = setup ? "Creating…" : "Signing in…";
        api(setup ? "/api/setup" : "/api/login", { method: "POST", body: body }).then(start)
          .catch(function (err) {
            $(".error", form).textContent = err.message;
            button.disabled = false;
            button.textContent = setup ? "Create account" : "Sign in";
          });
      };
      if (TV) focusEl(form.elements.email); else form.elements.email.focus();
    });
  }

  $("#account-btn").onclick = function () {
    if (!ME) return;
    popMenu(this, '<div class="menu-h"><b>' + esc(ME.name) + "</b><span>" + esc(ME.email) + "</span></div>" +
      '<a href="#/settings">' + icon("sliders") + "Settings</a>" +
      (ME.role === "admin" ? '<a href="#/admin">' + icon("shield") + "Admin</a>" : "") +
      '<hr><button id="menu-logout">' + icon("logout") + "Sign out</button>", function (m) {
      $$("a", m).forEach(function (a) { a.onclick = function () { closeMenu(false); }; });
      $("#menu-logout", m).onclick = function () { closeMenu(false); signOut(); };
    });
  };

  function start() {
    return api("/api/me").then(function (me) {
      ME = me;
      document.body.classList.remove("bare");
      main.innerHTML = "";
      $("#admin-link").hidden = me.role !== "admin";
      var avatar = $("#account-initial");
      avatar.textContent = initials(me.name);
      avatar.style.setProperty("--hue", hue(me.name));
      $("#account-btn").setAttribute("aria-label", "Account: " + me.name);
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
      var device = screen.height > 1300 || TV ? 2160 : 1080;
      // The Quality menu can ask for less than the device manages, for this playback only.
      var max = state.maxHeight ? Math.min(device, state.maxHeight) : device;
      return { video: v, audio: a, hls_audio: hlsAudio, containers: containers, max_height: max };
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
    var MODES = { direct: "Direct play", remux: "Direct stream", transcode: "Converting", online: "Online stream", live: "Live" };
    function modeText(info) {
      var text = MODES[info.mode] || info.mode || "";
      if (info.mode === "transcode" && info.hwaccel && info.hwaccel !== "none") text += " · " + info.hwaccel;
      if (info.torrent) text = "Torrent " + info.torrent.label + " · " + text;
      if (state.maxHeight) text += " · up to " + state.maxHeight + "p";
      return text;
    }

    function open(request) {
      closeMenu(false);
      closeModal();
      state = { request: request, queue: request.queue || null, tries: 0 };
      root.hidden = false;
      layers.push(root);
      document.body.style.overflow = "hidden";
      $("#p-title").textContent = request.title || ""; // known at once for online titles
      $("#p-sub").textContent = request.subtitle || "";
      $("#p-mode").textContent = "";
      $("#p-time").textContent = "0:00"; // nothing left over from the last playback
      $("#p-duration").textContent = "";
      $("#p-progress").style.width = $("#p-buffer").style.width = "0";
      showUi();
      load({ item_id: request.item_id, online: request.online, usenet: request.usenet, torrent: request.torrent, live: request.live, start: request.start });
    }

    // The same episode or film again, at another point or with other options.
    function again(extra) {
      var info = state.info, t = info.torrent, opts = info.live ? { live: { channel_id: info.live.channel.id } }
        : t ? { torrent: { kind: t.kind, id: t.id, season: t.season, episode: t.episode, quality: t.quality, stream: t.stream }, audio: state.audio }
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
      root.classList.remove("failed");
      hideStatus();
      cancelSeek();
      stopStream(true);
      var request;
      if (opts.torrent) {
        request = torrentPlay(opts);
      } else if (opts.live) {
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
        if (root.hidden) {
          if (info.session) api("/api/sessions/" + info.session, { method: "DELETE" });
          if (info.torrent) api("/api/torrent/streams/" + info.torrent.stream, { method: "DELETE" }).catch(function () {});
          return;
        }
        hideStatus();
        // A new torrent stream (another quality, the next episode) replaces the old one.
        if (state.torrentStream && (!info.torrent || info.torrent.stream !== state.torrentStream)) {
          api("/api/torrent/streams/" + state.torrentStream, { method: "DELETE" }).catch(function () {});
        }
        state.torrentStream = info.torrent ? info.torrent.stream : null;
        if (info.torrent && info.status && info.status.fallback && !state.fallbackShown) {
          state.fallbackShown = true;
          toast("The first choice did not work (" + info.status.fallback.reason + "), so another release is playing.", $("#p-toast"));
        }
        state.info = info;
        state.offset = info.start;
        state.audio = info.audio_index;
        state.duration = info.duration;
        $("#p-title").textContent = info.item.title_name;
        $("#p-sub").textContent = [info.item.label, info.item.name].filter(Boolean).join(" · ");
        $("#p-mode").textContent = modeText(info);
        root.classList.toggle("live", info.mode === "live");
        if (info.live) liveSub(info.live.programme);
        $("#p-next").hidden = !(info.next || state.queue);
        $("#p-next").setAttribute("data-tip", info.next && info.next.label ? "Next: " + info.next.label : "Next");
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
        if (err.cancelled || root.hidden) return;
        $("#spinner").hidden = true;
        if (opts.torrent) showFailure(err, opts); else toast(err.message, $("#p-toast"));
      });
    }

    // ---- torrent streams: prepare (or claim the warm one), show progress, then play ------
    var CANCELLED = { cancelled: true, message: "" };
    function torrentPlay(opts) {
      var t = opts.torrent, token = state.loadToken = {};
      state.qualities = state.qualities || null;
      if (!state.qualities || state.qualitiesFor !== t.id + t.season + "." + t.episode) {
        state.qualitiesFor = t.id + t.season + "." + t.episode;
        var p = "/api/torrent/options/" + t.kind + "/" + t.id + "?season=" + t.season + "&episode=" + t.episode;
        (CACHE[p] ? Promise.resolve(CACHE[p].data) : api(p)).then(function (d) { if (state.loadToken === token || state.info) state.qualities = d.qualities; }).catch(function () {});
      }
      function body(stream) {
        var b = { stream: stream, caps: caps(), client: CLIENT };
        if (opts.start !== undefined && opts.start !== null) b.start = opts.start;
        if (opts.audio !== undefined) b.audio = opts.audio;
        if (opts.escalate) b.escalate = opts.escalate;
        return b;
      }
      function play(stream) {
        if (state.loadToken !== token) return Promise.reject(CANCELLED);
        return api("/api/torrent/play", { method: "POST", body: body(stream) });
      }
      function wait(s) {
        return new Promise(function (resolve, reject) {
          (function step(s) {
            if (state.loadToken !== token || root.hidden) { reject(CANCELLED); return; }
            showStatus(s);
            if (s.state === "failed") {
              var e = new Error(s.error ? s.error.message : s.message);
              e.reason = s.error && s.error.reason;
              e.stream = s;
              reject(e);
              return;
            }
            if (s.duration) { resolve(s); return; } // probed: playback can start
            setTimeout(function () { api("/api/torrent/streams/" + s.id).then(step, reject); }, 400);
          })(s);
        });
      }
      function prepare() {
        var b = { kind: t.kind, id: t.id, season: t.season, episode: t.episode, quality: t.quality || 0, player: CLIENT, intent: "play" };
        if (t.release) b.release = t.release;
        return api("/api/torrent/prepare", { method: "POST", body: b }).then(wait).then(function (s) {
          showStatus(s, true);
          return play(s.id);
        });
      }
      if (t.stream) { // the same stream again (a seek, an audio change, a step up)
        state.bufferTimer = setTimeout(bufferStatus, 600); // a seek into data not here yet says so
        return play(t.stream).catch(function (err) {
          if (err.reason === "gone" || err.reason === "not-ready") return prepare();
          throw err;
        });
      }
      showStatus({ state: "finding", quality: t.quality, peers: 0 });
      return prepare();
    }
    function statusText(s, starting) {
      var peers = s.peers ? plural(s.peers, "peer") : "", speed = s.download_rate ? rate(s.download_rate) : "";
      var tries = (s.attempts || []).length;
      if (starting || s.duration) return { title: "Starting playback", detail: [peers, speed].filter(Boolean).join(" · ") };
      if (s.state === "buffering") {
        return { title: "Buffering", detail: [peers, speed].filter(Boolean).join(" · "), pct: Math.round(100 * (s.ready_fraction || 0)) };
      }
      if (s.state === "connecting") return { title: "Connecting", detail: peers + (tries > 1 ? " · trying release " + tries : "") };
      return { title: "Finding sources", detail: tries > 1 ? "The first choice is slow; also trying release " + tries : "Looking for people sharing it" };
    }
    function showStatus(s, starting) {
      var el = $("#p-status"), x = statusText(s, starting), r = s.release;
      var what = [QUALITY_NAMES[s.quality] || "", r ? r.name : ""].filter(Boolean).join(" · ");
      el.innerHTML = '<div class="ps-title">' + esc(x.title) + (x.pct != null ? " · " + x.pct + "%" : "") + "</div>" +
        (x.pct != null ? '<div class="ps-bar"><i style="width:' + x.pct + '%"></i></div>' : "") +
        (x.detail ? '<div class="ps-detail">' + esc(x.detail) + "</div>" : "") +
        (what ? '<div class="ps-release">' + esc(what) + "</div>" : "") +
        (s.fallback ? '<div class="ps-detail">' + esc("Switched release: " + s.fallback.reason) + "</div>" : "");
      el.classList.remove("fail");
      el.hidden = false;
    }
    function hideStatus() {
      var el = $("#p-status");
      el.hidden = true;
      el.innerHTML = "";
      el.classList.remove("fail");
      clearTimeout(state.bufferTimer);
    }
    var FAILURES = {
      "no-peers": "Nobody is sharing this right now", "no-release": "None of the releases worked", vpn: "The VPN is not connected",
      engine: "The torrent engine is not reachable", unavailable: "Not available at this quality", "wrong-film": "Only lookalike releases were found",
      disk: "Not enough disk space", limit: "Too many streams at once", probe: "The video could not be read", gone: "The stream ended", off: "Torrent streaming is off",
    };
    // Every failure is a screen with a next step: try again, another quality, Usenet, or back.
    function showFailure(err, opts) {
      var t = opts.torrent, el = $("#p-status"), request = state.request || {};
      var buttons = '<button class="primary" id="ps-retry">' + icon("refresh") + "Try again</button>";
      (state.qualities || []).forEach(function (q) {
        if (q.available && q.quality !== t.quality) buttons += '<button data-q="' + q.quality + '">Play ' + esc(q.label) + "</button>";
      });
      if (request.usenetOk) buttons += '<button id="ps-usenet">Play from Usenet</button>';
      buttons += '<button class="ghost" id="ps-back">Back</button>';
      el.innerHTML = '<div class="state-icon">' + icon("alert") + "</div><h2>" + esc(FAILURES[err.reason] || "This could not be played") + "</h2>" +
        "<p>" + esc(err.message) + '</p><div class="actions" data-row>' + buttons + "</div>";
      el.classList.add("fail");
      el.hidden = false;
      root.classList.add("failed");
      var fresh = { kind: t.kind, id: t.id, season: t.season, episode: t.episode, quality: t.quality };
      $("#ps-retry").onclick = function () { load({ torrent: fresh, start: opts.start }); };
      $$("[data-q]", el).forEach(function (b) {
        b.onclick = function () { fresh.quality = +b.getAttribute("data-q"); load({ torrent: fresh, start: opts.start }); };
      });
      if ($("#ps-usenet")) $("#ps-usenet").onclick = function () { load({ usenet: { kind: t.kind, id: t.id, season: t.season, episode: t.episode }, start: opts.start }); };
      $("#ps-back").onclick = close;
      setTimeout(function () { focusEl($("#ps-retry")); }, 30);
    }
    // While a torrent stream waits for data, say why and how it is going.
    function bufferStatus() {
      var info = state.info;
      clearTimeout(state.bufferTimer);
      if (!info || !info.torrent || $("#spinner").hidden) { if (!$("#p-status").classList.contains("fail")) $("#p-status").hidden = true; return; }
      api("/api/torrent/streams/" + info.torrent.stream).then(function (s) {
        if (state.info !== info || $("#spinner").hidden) return;
        var el = $("#p-status"), peers = s.peers ? plural(s.peers, "peer") : "no peers yet";
        el.innerHTML = '<div class="ps-title">Buffering</div><div class="ps-detail">' + esc([peers, s.download_rate ? rate(s.download_rate) : ""].filter(Boolean).join(" · ")) + "</div>";
        el.classList.remove("fail");
        el.hidden = false;
      }).catch(function () {});
      state.bufferTimer = setTimeout(bufferStatus, 1200);
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
      if (info.torrent) {
        var t = info.torrent, tb = { position: absolute(), duration: state.duration, session: info.session };
        for (var key in t) tb[key] = t[key];
        // Most of an episode watched: start the next one's stream, so Next Up starts warm.
        if (info.next && !state.nextWarm && state.duration && absolute() / state.duration > 0.8) {
          state.nextWarm = true;
          api("/api/torrent/prepare", { method: "POST", body: { kind: t.kind, id: t.id, season: t.next_season, episode: t.next_episode,
            quality: t.quality, player: CLIENT } }).catch(function () {});
        }
        return api("/api/torrent/progress", { method: "POST", body: tb }).catch(function () {});
      }
      return api("/api/progress", { method: "POST", body: { item_id: info.item.id, position: absolute(), duration: state.duration, session: info.session } })
        .catch(function () {});
    }

    function close() {
      var info = state.info;
      var done = report();
      clearInterval(reportTimer); clearInterval(cueTimer); clearInterval(pingTimer);
      stopStream();
      hideStatus();
      root.classList.remove("failed");
      if (state.torrentStream) api("/api/torrent/streams/" + state.torrentStream, { method: "DELETE" }).catch(function () {});
      state = {};
      panel.hidden = true;
      panel.removeAttribute("data-kind");
      root.hidden = true;
      root.classList.remove("ui", "sheet");
      layers = layers.filter(function (l) { return l !== root && l !== panel; });
      document.body.style.overflow = "";
      exitFullscreen();
      // Redraw the page underneath in place, so progress and watched marks are current.
      if (info) done.then(function () { if (!$("#player").hidden) return; refresh(); });
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
      } else if (state.info && state.info.torrent) {
        var t = state.info.torrent;
        state.nextWarm = false;
        if (state.info.next) load({ torrent: { kind: t.kind, id: t.id, season: t.next_season, episode: t.next_episode, quality: t.quality }, start: 0 });
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
      $("#p-subs").setAttribute("aria-pressed", String(!!sub));
      if (!sub) return;
      // Translated tracks answer 202 with progress until the translation is done.
      function fetchVtt() {
        return fetch(sub.url, { credentials: "same-origin" }).then(function (r) {
          if (r.status === 202) {
            return r.json().then(function (p) {
              if (state.subKey !== sub.key) return null;
              var pct = p.total ? Math.round((100 * p.done) / p.total) : 0;
              toast(p.message || "Translating " + sub.title.replace(/\s*\(translated\)/, "") + " subtitles… " + pct + "%", $("#p-toast"));
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
      return [track.title, track.lang ? (LANG_NAMES[track.lang] || track.lang.toUpperCase()) : "", track.codec === "webvtt" ? "" : CODECS[track.codec] || track.codec,
        track.channels ? channels(track.channels) : "", track.forced ? "forced" : ""]
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
      button.onclick = function () { if (!state.info) return; if (owns(button)) closePanel(); else show(); };
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
          esc(label(s)) + (s.external ? " (file)" : "") + (s.available ? "" : /pgs|dvd|vob|hdmv|dvb/i.test(s.codec || "") ? " — picture-based, not supported" : " — unavailable"), !s.available);
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
    // Quality: online streams switch between their own renditions; library and Usenet titles
    // restart at the same point with a lower ceiling, which the server converts down to.
    function qualityPanel() {
      var info = state.info, html = "<h3>Quality</h3><p>Now: " + esc(modeText(info)) + "</p>";
      if (info.online && hls && hls.levels && hls.levels.length > 1) {
        var current = hls.autoLevelEnabled ? -1 : hls.currentLevel;
        html += option('data-level="-1"', current === -1, "Automatic") + hls.levels.map(function (l, i) {
          return { i: i, h: l.height || 0, b: l.bitrate || 0 };
        }).sort(function (a, b) { return b.h - a.h || b.b - a.b; }).map(function (l) {
          return option('data-level="' + l.i + '"', current === l.i, (l.h ? l.h + "p" : "Level " + (l.i + 1)) + (l.b ? " · " + (l.b / 1e6).toFixed(1) + " Mbps" : ""));
        }).join("");
      } else if (info.online) {
        html += "<p>This stream comes in one quality.</p>";
      } else {
        if (info.torrent) { // which release is downloaded, then how it is converted for this screen
          html += "<h4>Download</h4>" + (state.qualities || [{ quality: info.torrent.quality, label: info.torrent.label, available: true }]).map(function (q) {
            var detail = q.available ? releaseLine(q.release) : q.reason;
            return option('data-tq="' + q.quality + '"', q.quality === info.torrent.quality, esc(q.label) + (detail ? '<small class="sub">' + esc(detail) + "</small>" : ""), !q.available);
          }).join("") + "<h4>Convert for this screen</h4>";
        }
        html += [[0, "Original (best for this device)"], [1080, "1080p"], [720, "720p"], [480, "480p"]].map(function (q) {
          return option('data-height="' + q[0] + '"', (state.maxHeight || 0) === q[0], q[1]);
        }).join("") + "<p>Lower settings are converted on the server, which helps on a slow connection.</p>";
      }
      openPanel("quality", html, function () {
        $$("[data-level]", panel).forEach(function (b) {
          b.onclick = function () { hls.currentLevel = +b.getAttribute("data-level"); closePanel(); };
        });
        $$("[data-tq]", panel).forEach(function (b) {
          b.onclick = function () {
            var q = +b.getAttribute("data-tq");
            closePanel();
            if (q !== info.torrent.quality) switchQuality(q);
          };
        });
        $$("[data-height]", panel).forEach(function (b) {
          b.onclick = function () {
            var h = +b.getAttribute("data-height");
            closePanel();
            if (h === (state.maxHeight || 0)) return;
            state.maxHeight = h || null;
            again({ start: absolute() });
          };
        });
      });
    }
    // Another torrent quality: the current one keeps playing while the new one connects and
    // buffers (progress in a toast), then playback continues from the same point.
    function switchQuality(q) {
      var info = state.info, t = info.torrent, token = state.switchToken = {}, name = QUALITY_NAMES[q];
      var say = function (text) { toast(text, $("#p-toast")); };
      say("Preparing " + name + "… " + t.label + " keeps playing meanwhile.");
      function step(s) {
        if (state.switchToken !== token || state.info !== info || root.hidden) return;
        if (s.state === "failed") { say(name + " could not start: " + (s.error ? s.error.message : s.message) + " Still playing " + t.label + "."); return; }
        if (s.duration) {
          state.fallbackShown = false;
          $("#p-toast").hidden = true;
          again({ torrent: { kind: t.kind, id: t.id, season: t.season, episode: t.episode, quality: q, stream: s.id }, start: absolute() });
          return;
        }
        var x = statusText(s);
        say(name + ": " + x.title + (x.pct != null ? " " + x.pct + "%" : "") + (x.detail ? " · " + x.detail : ""));
        setTimeout(function () { api("/api/torrent/streams/" + s.id).then(step).catch(function (err) { say(name + " could not start: " + err.message); }); }, 700);
      }
      api("/api/torrent/prepare", { method: "POST", body: { kind: t.kind, id: t.id, season: t.season, episode: t.episode, quality: q, player: CLIENT, intent: "play" } })
        .then(step).catch(function (err) { say(name + " could not start: " + err.message + " Still playing " + t.label + "."); });
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
      openPanel("info", "<h3>Playback</h3><p><span class=\"pill " + info.mode + '">' + esc(MODES[info.mode] || info.mode) + "</span>" + (info.hwaccel && info.hwaccel !== "none" ? " " + esc(info.hwaccel) : "") + "</p>" +
        (info.reasons || []).map(function (r) { return "<p>• " + esc(r) + "</p>"; }).join("") +
        (info.torrent ? '<p id="p-torrent-live"></p>' : "") + '<button style="margin-top:16px">' + icon("close") + "<span>Close</span></button>", function () {
        $("button", panel).onclick = closePanel;
      });
      if (info.torrent) api("/api/torrent/streams/" + info.torrent.stream).then(function (s) {
        var el = $("#p-torrent-live");
        if (!el) return;
        el.textContent = "• " + [plural(s.peers, "peer"), rate(s.download_rate || 0), s.size ? Math.round((100 * s.downloaded) / s.size) + "% downloaded" : "",
          s.buffered_ahead ? size(s.buffered_ahead) + " ahead of the playhead" : ""].filter(Boolean).join(" · ");
      }).catch(function () {});
    }

    function showUi() {
      root.classList.add("ui");
      clearTimeout(uiTimer);
      uiTimer = setTimeout(function () { if (!video.paused && panel.hidden && pending === null) root.classList.remove("ui"); }, 4000);
    }
    function togglePlay() { if (video.paused) video.play(); else video.pause(); showUi(); }

    // Full screen (browsers; TVs are always full screen).
    var fsEl = root.requestFullscreen ? "requestFullscreen" : root.webkitRequestFullscreen ? "webkitRequestFullscreen" : null;
    if (!fsEl || TV) $("#p-full").hidden = true;
    function isFull() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
    function exitFullscreen() {
      if (!isFull()) return;
      try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) { /* ignore */ }
    }
    $("#p-full").onclick = function () {
      if (isFull()) exitFullscreen();
      else try { root[fsEl](); } catch (e) { /* ignore */ }
    };

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
      if (root.classList.contains("failed")) { // the failure screen: its buttons take the remote
        if (name === "back" || name === "stop") { close(); return true; }
        return false;
      }
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
        $("#p-skip").click(); // OK on the remote takes the skip offer
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
    video.addEventListener("playing", function () { $("#spinner").hidden = true; root.classList.remove("paused"); showUi(); if (state.info && state.info.torrent) hideStatus(); });
    video.addEventListener("pause", function () { root.classList.add("paused"); showUi(); report(); });
    video.addEventListener("waiting", function () {
      $("#spinner").hidden = false;
      if (state.info && state.info.torrent) { clearTimeout(state.bufferTimer); state.bufferTimer = setTimeout(bufferStatus, 700); }
    });
    video.addEventListener("canplay", function () { $("#spinner").hidden = true; if (state.info && state.info.torrent) hideStatus(); });
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
    video.addEventListener("dblclick", function () { if (fsEl && !TV) $("#p-full").click(); });
    $("#p-play").onclick = togglePlay;
    $("#p-close").onclick = close;
    $("#p-back10").onclick = function () { seekTo(absolute() - 10); };
    $("#p-fwd30").onclick = function () { seekTo(absolute() + 30); };
    $("#p-next").onclick = next;
    togglePanel($("#p-audio"), audioPanel);
    togglePanel($("#p-subs"), subsPanel);
    togglePanel($("#p-quality"), qualityPanel);
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
