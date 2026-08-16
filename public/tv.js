// Remote-control (D-pad) spatial navigation for TV / Tizen.
//
// Enabled only in "TV mode" — a Tizen webview, a ?tv=1 URL param, or
// localStorage.tv==="1" — so desktop mouse behavior is completely unchanged.
// Arrow keys move a highlight between focusable elements, OK (Enter) activates
// the highlighted one, and Back (Tizen keycode 10009) closes the current layer.
(function () {
  // Persist the flag so TV mode survives navigations/redirects (login → home)
  // that would otherwise drop ?tv=1 from the URL.
  if (/[?&]tv=1/.test(location.search)) { try { localStorage.setItem("tv", "1"); } catch {} }
  const TV = !!window.tizen || /[?&]tv=1/.test(location.search) || localStorage.getItem("tv") === "1";
  if (!TV) return;
  document.documentElement.classList.add("tv");

  // A retail Samsung TV gives you nothing to debug with: no console, no dlog,
  // no Web Inspector. So the app reports its own failures back to the server,
  // which prints them next to the request log. Errors only, capped and
  // deduplicated — this is a lifeline, not telemetry.
  (function reportErrors() {
    const seen = new Set();
    const send = (kind, message, extra) => {
      const key = kind + message;
      if (seen.has(key) || seen.size > 20) return; // never loop on a repeating error
      seen.add(key);
      try {
        fetch("/api/tv-log", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, message: String(message).slice(0, 500), ...extra }),
        }).catch(function () {});
      } catch (e) {}
    };
    window.addEventListener("error", (e) => {
      if (e.target && e.target !== window && e.target.src)      // a failed <script>/<img>/<video>
        return send("resource", e.target.src, { tag: e.target.tagName });
      send("error", e.message, { at: (e.filename || "").split("/").pop() + ":" + e.lineno });
    }, true);
    window.addEventListener("unhandledrejection", (e) =>
      send("rejection", (e.reason && (e.reason.stack || e.reason.message)) || e.reason));

    // Playback failures are HANDLED — they surface as a status message rather
    // than an exception — so an error beacon alone would report a perfectly
    // silent broken player. Forward what the user is actually being shown.
    const P = window.Player;
    if (P && typeof P.showStatus === "function") {
      const status = P.showStatus.bind(P);
      P.showStatus = function (text, spinner) {
        if (text && !spinner) send("player", text);   // spinner:false == it gave up
        return status(text, spinner);
      };
      const action = P.showStatusAction.bind(P);
      P.showStatusAction = function (text, label, fn) {
        send("player", text + (label ? ` [${label}]` : ""));
        return action(text, label, fn);
      };
    }

    // Did a frame ever actually reach the screen? "No errors" is not the same
    // as "playing", and on a TV there's no other way to tell the two apart.
    const vid = document.getElementById("video");
    if (vid) {
      vid.addEventListener("playing", function () {
        send("playing", `${Math.round(vid.videoWidth)}x${Math.round(vid.videoHeight)} dur=${Math.round(vid.duration || 0)}s`);
        // What is actually painting on top, measured on the device. If the home
        // page shows through the player this says so outright, which no amount
        // of reading the stylesheet can.
        setTimeout(function () {
          const name = (x, y) => {
            const e = document.elementFromPoint(x, y);
            if (!e) return "none";
            return (e.id || (e.className && String(e.className).split(" ")[0]) || e.tagName).slice(0, 24);
          };
          const p = document.getElementById("player");
          const r = p.getBoundingClientRect();
          send("layers", [
            `player=${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`,
            `z=${getComputedStyle(p).zIndex}`,
            `op=${getComputedStyle(p).opacity}`,
            `bg=${getComputedStyle(p).backgroundColor}`,
            `top=${name(innerWidth / 2, 60)}`,
            `mid=${name(innerWidth / 2, innerHeight / 2)}`,
            `nav=${name(200, 60)}`,
          ].join(" "));
        }, 600);
      }, { once: true });
      vid.addEventListener("stalled", () => send("stalled", "no data"), { once: true });
    }

    // What this webview can actually play, reported once. Whether hls.js runs
    // here decides the entire playback path, and there's no other way to find out.
    window.addEventListener("load", () => setTimeout(() => {
      const v = document.createElement("video");
      send("caps", [
        "hls.js=" + (window.Hls ? "loaded" : "MISSING"),
        "hls.isSupported=" + (window.Hls && window.Hls.isSupported ? window.Hls.isSupported() : "n/a"),
        "MediaSource=" + (typeof window.MediaSource !== "undefined"),
        "nativeHLS=" + (v.canPlayType("application/vnd.apple.mpegurl") || "no"),
        "mp4=" + (v.canPlayType('video/mp4; codecs="avc1.42E01E"') || "no"),
        // If the TV opens Matroska itself, .mkv releases could skip the debrid
        // transcoder too — which measurably halves the bitrate.
        "mkv=" + (v.canPlayType("video/x-matroska") || v.canPlayType('video/x-matroska; codecs="avc1.42E01E,mp4a.40.2"') || "no"),
        "hevc=" + (v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') || "no"),
        "vp=" + innerWidth + "x" + innerHeight,
      ].join(" "));
    }, 1500));
  })();

  const $ = (s) => document.querySelector(s);
  // Eligible = RENDERED, deliberately not "currently on screen". Moving is what
  // causes scrolling, so a viewport test is circular: with TV-sized posters the
  // next row sits entirely below the fold, so it would never become focusable
  // and the highlight would dead-end at the bottom of the first row. Same for a
  // row scrolled past its right edge.
  //
  // Overlays and the nav drawer hide with display:none, so zero size already
  // excludes them. The player's .p-drawer is the exception — it's parked at
  // translateX(100%) with its full size (its display rule beats the [hidden] UA
  // rule), so a closed one has to be ruled out explicitly or it steals focus.
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (getComputedStyle(el).visibility === "hidden") return false;
    if (el.closest(".p-drawer:not(.show)")) return false;
    // Hero slides are STACKED full-size and cross-fade via opacity, so only the
    // active slide's buttons are real — the rest are invisible twins that would
    // swallow the highlight and answer OK for the wrong title.
    return !el.closest(".hero:not(.active)");
  };

  // Everything the remote can land on, across every surface.
  const SEL = [
    ".card", ".fr-card", ".ep-row", ".sched-item", ".sched-day",
    ".hero-btn", ".hero-pg-btn", ".mode-pill", ".act-btn", ".detail-play", ".sheet-back",
    ".season-select", ".season-item", ".p-icon", ".up-next .btn", ".col-row input", "#search",
    ".filter-bar .btn", ".grid-empty .btn", "#catMore",
    ".nav .btn", "#navBurger", "#randomBtn", ".drawer-link", ".drawer-genre", ".tv-rail-btn",
    // (.row-arrow is deliberately absent: moving between cards scrolls the row,
    //  so the hover arrows are dead weight on a remote and tv.css hides them)
    ".auth-card input", ".auth-card .btn", // login / invite pages
    // inside the player: menus, the episodes drawer and the servers drawer.
    // A remote has no "s" or "c" shortcut key, so every one of these has to be
    // landable or the panel behind it may as well not exist on a TV.
    ".p-menu-item", ".p-menu-row", ".p-menu-back", ".sub-sync .p-icon",
    ".p-drawer-ep", ".srv-row", ".srv-fav", ".srv-foot .btn", ".p-status .btn",
  ].join(",");

  const isShown = (id) => { const el = $(id); return el && el.classList.contains("show"); };
  // The topmost open layer owns navigation (player > detail modal > browse).
  // Inside the player, an open drawer or menu is its own layer — otherwise the
  // control bar underneath competes with it for the D-pad.
  // Pages without a player/modal (login, invite, admin) just use the body.
  function playerLayer() {
    const drawer = [...document.querySelectorAll("#player .p-drawer.show")].pop();
    if (drawer) return drawer;
    const menu = [...document.querySelectorAll("#player .p-menu:not([hidden])")].pop();
    return menu || null;
  }
  function surface() {
    // The hamburger drawer sits above everything with a backdrop; while it's
    // open the D-pad must not wander onto the cards showing through behind it —
    // that's how "press OK on Movies" ends up activating something invisible.
    const menu = $("#drawer");
    if (menu && !menu.hidden && menu.classList.contains("open")) return menu.querySelector(".drawer-panel");
    if (isShown("#player")) return playerLayer() || $("#player");
    if (isShown("#detail")) return $("#detail");
    // The films/shows sheet is its own layer for the same reason the anime one
    // is: it covers the screen, and the D-pad must not wander onto the catalog
    // cards still mounted behind it.
    if (isShown("#mDetail")) return $("#mDetail");
    return document.body;
  }
  function focusables() {
    return [...surface().querySelectorAll(SEL)].filter(visible);
  }

  let cur = null;          // the highlighted element
  let inControls = false;  // remote is walking the player's control bar (see below)
  function setFocus(el, opts) {
    if (!el) return;
    // Leaving an input behind must BLUR it, or it keeps DOM focus and swallows
    // every key while the visible highlight sits somewhere else entirely —
    // that's the search-field trap.
    const act = document.activeElement;
    if (act && act !== el && ["INPUT", "TEXTAREA", "SELECT"].includes(act.tagName)) {
      act.blur();
      // Blur EVENTS can't be trusted here — they don't fire at all in an
      // unfocused document and TV webviews are erratic with them — so the
      // search strip's dismissal rides on the focus move itself: leaving the
      // field empty puts the bar away. (The blur listener still covers exits
      // that bypass the D-pad, like the IME's own Cancel.)
      if (act.id === "search" && !act.value.trim()) document.body.classList.remove("tv-search");
    }
    document.querySelectorAll(".tv-focus").forEach((e) => e.classList.remove("tv-focus")); // never leave a stray highlight
    document.querySelectorAll(".tv-focus-within").forEach((e) => e.classList.remove("tv-focus-within"));
    cur = el;
    el.classList.add("tv-focus");
    // Card artwork owns the focus ring, but a card's own buttons sit inside it —
    // mark the owning card so its actions stay visible while one is highlighted.
    // (:has() would do this in CSS, but that needs Chromium 105 and TVs have 69.)
    const card = el.closest(".card");
    if (card) card.classList.add("tv-focus-within");
    // Always instant. Smooth scrolling runs on the same TV compositor that
    // couldn't keep the video plane painted: the highlight moves but the page
    // visibly doesn't follow, which reads as the D-pad "not working". Snapping
    // is what native TV UIs do, and it can't fall behind.
    // (The browse rows engine positions the page itself and passes noScroll.)
    if (!opts || !opts.noScroll)
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    if (el.tagName === "INPUT" || el.tagName === "SELECT") { try { el.focus({ preventScroll: true }); } catch {} }
  }
  function ensure() {
    if (cur && document.contains(cur) && visible(cur) && surface().contains(cur)) return;
    const f = focusables();
    // Land on whatever the layer is "currently on" — the playing server, the
    // selected quality, this episode — before falling back to the first card
    // (browse) or the first control.
    const marked = f.find((e) => e.matches(".srv-row.live, .p-menu-item.active, .p-drawer-ep.active, .drawer-link.active"));
    if (marked) { setFocus(marked); return; }
    // A panel closed (picked a server, chose a quality) while the remote was on
    // the control bar — put the highlight back where it came from, not on the
    // first control in the DOM, which is the ‹ back button at the top.
    if (inControls && isShown("#player") && !playerLayer()) {
      const bar = f.filter((e) => e.closest(".p-bottom"));
      if (bar.length) { setFocus(bar.find((b) => b.id === "pPlay") || bar[0]); return; }
    }
    // Browse pages enter Netflix-style: the hero's primary button first,
    // falling through the ladder if there's no hero.
    if (surface() === document.body && $("#app") && browseDefault()) return;
    // A player panel with NOTHING landable would swallow the remote: no element
    // to highlight means every arrow press does nothing, and only Back gets out
    // — indistinguishable from a frozen app. Close it and hand the highlight
    // back to the control bar. (Reachable while a release is still resolving,
    // when a menu built from the stream's own tracks has no rows yet.)
    if (!f.length && isShown("#player") && playerLayer()) {
      window.Player?.hideMenus?.();
      window.Player?.closeDrawer?.();
      const bar = [...$("#player").querySelectorAll(".p-bottom .p-icon")].filter(visible);
      if (bar.length) { setFocus(bar.find((b) => b.id === "pPlay") || bar[0]); return; }
    }
    // Never LAND on an input by default — focusing one summons the TV's IME,
    // which is jarring when nobody asked to type. Inputs stay reachable by an
    // explicit move; they just stop being the fallback.
    const noInput = f.filter((e) => !["INPUT", "SELECT"].includes(e.tagName));
    setFocus(noInput.find((e) => e.classList.contains("card")) || noInput[0] || f[0]);
  }

  // Column memory. Rows scroll independently, so stepping down out of a row and
  // back up would otherwise land wherever that row happens to be scrolled to.
  // Vertical moves measure from the column the user last chose horizontally,
  // which is what every TV UI does and what people expect.
  let anchorX = null;

  // Nearest focusable in a direction: must lie ahead, prefer axis-aligned & close.
  function move(dir) {
    ensure();
    if (!cur) return;
    const a = cur.getBoundingClientRect();
    const vertical = dir === "up" || dir === "down";
    const ay = a.top + a.height / 2;
    const trueX = a.left + a.width / 2;
    if (!vertical) anchorX = null;            // choosing a column resets the memory
    else if (anchorX === null) anchorX = trueX;
    const ax = vertical ? anchorX : trueX;
    let best = null, score = Infinity;
    const fromRail = !!(cur && cur.closest && cur.closest("#tvRail"));
    for (const el of focusables()) {
      if (el === cur) continue;
      // The rail is a deliberate destination, not a neighbour: only Left may
      // reach it. Otherwise "Down past the last season" lands on Sign out.
      if (!fromRail && dir !== "left" && el.closest && el.closest("#tvRail")) continue;
      const b = el.getBoundingClientRect();
      const bx = b.left + b.width / 2, by = b.top + b.height / 2;
      // "forward" is always measured from where we actually are; only the
      // cross-axis distance uses the remembered column.
      const dx = bx - (vertical ? trueX : ax), dy = by - ay;
      let forward, primary, cross;
      if (dir === "left") { forward = -dx; primary = Math.abs(dx); cross = Math.abs(dy); }
      else if (dir === "right") { forward = dx; primary = Math.abs(dx); cross = Math.abs(dy); }
      else if (dir === "up") { forward = -dy; primary = Math.abs(dy); cross = Math.abs(bx - ax); }
      else { forward = dy; primary = Math.abs(dy); cross = Math.abs(bx - ax); }
      if (forward <= 2) continue; // strictly in the requested direction
      const s = primary + cross * 2;
      if (s < score) { score = s; best = el; }
    }
    if (best) {
      // hopping to the rail remembers the origin, so Right can return to it
      if (best.closest && best.closest("#tvRail") && cur && !cur.closest("#tvRail")) lastContent = cur;
      setFocus(best);
    }
  }

  function activate() {
    ensure();
    if (!cur) return;
    if (cur.tagName === "INPUT") { cur.focus(); return; }
    // A native <select> dropdown can't be driven from a remote, so OK cycles
    // through its options instead (wrapping) — good enough for the catalog's
    // genre/year/sort filters without rebuilding them.
    if (cur.tagName === "SELECT") {
      cur.selectedIndex = (cur.selectedIndex + 1) % cur.options.length;
      cur.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    cur.click();
  }

  // ---- Netflix-model browse navigation ----
  // A browse page is not free 2D space, it's a LADDER: hero buttons, the
  // filter bar, each card row, each visual line of a grid, the load-more foot.
  // Up/Down step between rungs, Left/Right step within one, every rung
  // remembers its position, the focused rung is held at a stable height, and
  // a focused card pins LEFT while its row slides underneath. That grammar —
  // not nearest-element-in-some-direction — is why native TV apps feel solid.
  let lastContent = null; // where the highlight was before hopping to the rail

  function gridLines(grid) {
    const out = [];
    let line = null, top = null;
    for (const c of grid.querySelectorAll(".card")) {
      if (c.offsetWidth < 2) continue;
      if (top === null || Math.abs(c.offsetTop - top) > 4) {
        top = c.offsetTop;
        line = { type: "grid", el: grid, items: [] };
        out.push(line);
      }
      line.items.push(c);
    }
    return out;
  }
  function contentGroups() {
    const groups = [];
    const hero = document.querySelector("#heroCar .hero.active");
    if (hero) {
      const items = [...hero.querySelectorAll("button.hero-chip, .hero-btn")].filter(visible);
      if (items.length)
        groups.push({ type: "hero", el: hero.closest(".hero-car"), items,
          home: Math.max(0, items.findIndex((b) => b.classList.contains("primary"))) });
    }
    const bar = $("#catBar");
    if (bar && !bar.hidden && bar.offsetHeight > 0) {
      const items = [...bar.querySelectorAll("button, select")].filter(visible);
      if (items.length) groups.push({ type: "bar", el: bar, items });
    }
    for (const row of document.querySelectorAll(".row .cards")) {
      const items = [...row.querySelectorAll(".card")].filter((c) => c.offsetWidth > 1);
      if (items.length) groups.push({ type: "row", el: row, items });
    }
    for (const grid of document.querySelectorAll(".cards-grid")) groups.push(...gridLines(grid));
    const more = $("#catMore");
    if (more && more.offsetHeight > 0) groups.push({ type: "foot", el: more.parentElement, items: [more] });
    return groups;
  }
  function findPos(groups, el) {
    for (let g = 0; g < groups.length; g++) {
      const i = groups[g].items.indexOf(el);
      if (i >= 0) return { g, i };
    }
    return null;
  }
  const nearestIdx = (items, x) => {
    let best = 0, score = Infinity;
    items.forEach((it, i) => {
      const r = it.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - x);
      if (d < score) { score = d; best = i; }
    });
    return best;
  };
  function focusItem(group, i) {
    i = Math.max(0, Math.min(i, group.items.length - 1));
    const item = group.items[i];
    if (group.type !== "grid") group.el.__tvIdx = i;
    setFocus(item, { noScroll: true });
    // card rows slide under a left-pinned highlight
    if (group.type === "row") {
      const t = item.offsetLeft - 8;
      group.el.scrollLeft = Math.max(0, Math.min(t, group.el.scrollWidth - group.el.clientWidth));
    }
    // hold the rung at a stable height: hero owns the top, rows keep their
    // title readable, grid lines sit in the same band every time
    if (group.type === "hero") { window.scrollTo(0, 0); return; }
    const cont = group.type === "row" ? (group.el.closest(".row") || group.el)
               : group.type === "grid" ? item : group.el;
    const y = window.pageYOffset + cont.getBoundingClientRect().top;
    window.scrollTo(0, Math.max(0, y - (group.type === "grid" ? 210 : 150)));
  }
  function browseDefault() {
    const groups = contentGroups();
    if (!groups.length) return false;
    const g = groups[0];
    focusItem(g, g.home != null ? g.home : (g.el && g.el.__tvIdx) || 0);
    return true;
  }
  function browseMove(dir) {
    const groups = contentGroups();
    if (!groups.length) return false;
    const pos = cur ? findPos(groups, cur) : null;
    if (!pos) return browseDefault(); // rail, a vanished slide, a repaint — re-enter at the top
    const group = groups[pos.g];
    if (dir === "left") {
      if (pos.i === 0) { focusRail(); return true; }
      focusItem(group, pos.i - 1);
      return true;
    }
    if (dir === "right") { focusItem(group, pos.i + 1); return true; }
    const next = groups[pos.g + (dir === "down" ? 1 : -1)];
    if (!next) return true; // top/bottom of the ladder — never drop the highlight
    const x = cur.getBoundingClientRect().left + cur.getBoundingClientRect().width / 2;
    const idx = next.type === "grid" ? nearestIdx(next.items, x)  // grids column-align
      : next.el && next.el.__tvIdx != null ? next.el.__tvIdx      // rows remember
      : next.home != null ? next.home
      : nearestIdx(next.items, x);
    focusItem(next, idx);
    return true;
  }
  // The rail is its own vertical rung: Up/Down walk it, Right returns to the
  // content exactly where it was left.
  const railButtons = () => [...document.querySelectorAll("#tvRail .tv-rail-btn")].filter(visible);
  function focusRail() {
    const btns = railButtons();
    if (!btns.length) return;
    lastContent = cur;
    const y = cur ? cur.getBoundingClientRect().top : 0;
    let best = 0, score = Infinity;
    btns.forEach((b, i) => {
      const d = Math.abs(b.getBoundingClientRect().top - y);
      if (d < score) { score = d; best = i; }
    });
    setFocus(btns[best]);
  }
  function railMove(dir) {
    const btns = railButtons();
    const i = btns.indexOf(cur);
    if (i < 0) { setFocus(btns[0]); return; }
    if (dir === "up") setFocus(btns[Math.max(0, i - 1)]);
    else if (dir === "down") setFocus(btns[Math.min(btns.length - 1, i + 1)]);
    else if (dir === "right") {
      if (lastContent && document.contains(lastContent) && visible(lastContent)) setFocus(lastContent);
      else { cur = null; if (!browseDefault()) ensure(); } // ladder-less pages re-enter spatially
    } // left on the rail: nothing further left exists
  }
  const onBrowse = () => surface() === document.body && !!$("#app");
  const onRail = () => !!(cur && cur.classList && cur.classList.contains("tv-rail-btn"));

  // ---- player control bar ----
  // With no menu open the arrows belong to the video (seek / volume), so the
  // control bar is entered explicitly with Up and left with Down — the pattern
  // every TV player uses. Without this the whole bottom bar, Servers button
  // included, is unreachable: a remote has no mouse and no letter keys.
  function enterControls() {
    const p = $("#player");
    if (!p) return;
    inControls = true;
    p.classList.add("tv-controls"); // pin the chrome open under the highlight
    window.Player?.poke?.();
    const bar = [...p.querySelectorAll(".p-bottom .p-icon")].filter(visible);
    setFocus(bar.find((b) => b.id === "pPlay") || bar[0]);
  }
  function exitControls() {
    inControls = false;
    $("#player")?.classList.remove("tv-controls");
    document.querySelectorAll(".tv-focus").forEach((e) => e.classList.remove("tv-focus"));
    cur = null;
    window.Player?.poke?.();
  }

  // Back button: unwind the most specific open thing.
  function back() {
    // an open drawer/menu closes before the control bar, which closes before
    // the player itself — one Back per layer, innermost first
    if (isShown("#player")) {
      const layer = playerLayer();
      if (layer) {
        // Inside the settings menu, Back walks submenus before closing: the
        // servers list steps back to the root (servers live there now, and
        // losing the whole menu to one Back press is hostile on a remote).
        const sub = layer.id === "settingsMenu" && layer.querySelector('[data-sub]:not([hidden])');
        if (sub && sub.dataset.sub !== "root") window.Player?.gotoSub?.("root");
        else if (layer.classList.contains("p-drawer")) window.Player?.closeDrawer?.();
        else window.Player?.hideMenus?.();
        cur = null;
        setTimeout(() => inControls && enterControls(), SETTLE_MS);
        return;
      }
      if (inControls) { exitControls(); return; }
      window.Player?.close?.();
      return;
    }
    for (const id of ["#colMenu", "#ccMenu", "#audMenu", "#settingsMenu"]) {
      const m = $(id); if (m && !m.hidden) { m.hidden = true; return; }
    }
    const drawer = $("#drawer");
    if (drawer && drawer.classList.contains("open")) { $("#drawerClose")?.click(); return; }
    if (isShown("#detail")) { $("#detailClose")?.click(); cur = null; return; }
    // Films and shows use their own sheet (same treatment, different overlay).
    if (isShown("#mDetail")) { $("#mDetailClose")?.click(); cur = null; return; }
    // In-page views with their own ‹ (category sheets): the remote's Back
    // drives it, same contract as everywhere else.
    const sheetBack = document.querySelector("#app .sheet-back");
    if (sheetBack && visible(sheetBack)) { sheetBack.click(); cur = null; }
  }

  document.addEventListener("keydown", (e) => {
    const player = isShown("#player");
    const k = e.keyCode;
    if (k === 10009) { e.preventDefault(); back(); return; }          // Tizen Back
    if (player) {
      // Three modes inside the player, innermost first:
      //   a drawer/menu is open → the D-pad navigates it;
      //   the control bar is entered → left/right walk the buttons, Down exits;
      //   otherwise → the arrows stay with the video (seek/volume) and Up enters.
      // Taking a key here means stopping it in the capture phase, or the
      // player's own document handler would seek at the same time.
      const own = () => { e.preventDefault(); e.stopPropagation(); };
      const layer = playerLayer();
      if (layer) {
        switch (k) {
          case 37: own(); move("left"); return;
          case 39: own(); move("right"); return;
          case 38: own(); move("up"); return;
          case 40: own(); move("down"); return;
          case 13: own(); activate(); return;
        }
        return;
      }
      if (inControls) {
        window.Player?.poke?.(); // keep the chrome up while the remote is on it
        switch (k) {
          case 37: own(); move("left"); return;
          case 39: own(); move("right"); return;
          // The bar is a single row at the bottom of the screen (the on-screen
          // ‹ is hidden on TV — the remote's Back button IS that control), so
          // vertical presses have nowhere real to go. Swallow them: a stray
          // Up/Down must not silently drop the highlight or change the volume.
          case 38: case 40: own(); return;
          case 13: own(); activate(); return;
        }
        return;
      }
      // The controls live at the BOTTOM of the screen, so Down is the press
      // that reaches for them. Up is accepted too — nobody should have to
      // learn which one is right while the film is running.
      if (k === 40 || k === 38) { own(); enterControls(); return; }
      if (k === 13) { e.preventDefault(); window.Player?.togglePlay?.(); }
      return;                                                          // else: Left/Right seek
    }
    const typing = document.activeElement && document.activeElement.tagName === "INPUT";
    const inSearch = typing && document.activeElement.id === "search";
    // Browse pages run the rows engine; overlays (detail sheet, login) keep the
    // spatial search, which suits list-shaped layouts.
    const go = (dir) => {
      if (onBrowse()) {
        if (onRail()) return railMove(dir);
        // Ladder-less pages inside #app (the TV-show detail with its season
        // list, the schedule) fall back to the spatial engine — an empty
        // group set must never mean a dead D-pad.
        if (browseMove(dir)) return;
      }
      move(dir);
    };
    switch (k) {
      case 37: if (typing) return; go("left"); e.preventDefault(); break;   // caret keys stay with the field
      case 39: if (typing) return; go("right"); e.preventDefault(); break;
      // Up/Down leave the field: setFocus blurs it, so the highlight and the
      // DOM focus move TOGETHER — splitting them is what trapped the remote.
      case 38: go("up"); e.preventDefault(); break;
      case 40: go("down"); e.preventDefault(); break;
      case 13:
        // OK in the search field = "done typing": close the IME and jump to
        // the results the query just painted (they render on a debounce, so
        // give them a beat). Login/invite inputs keep their submit behaviour.
        if (inSearch) {
          e.preventDefault();
          document.activeElement.blur();
          cur = null;
          setTimeout(() => {
            const hit = [...document.querySelectorAll("#app .card")].filter(visible)[0];
            if (hit) setFocus(hit); else ensure();
          }, 450);
          break;
        }
        if (!typing) { activate(); e.preventDefault(); }
        break;
    }
  }, true); // capture phase so we pre-empt default page scrolling

  // Re-anchor focus whenever a view or layer changes (elements may be absent
  // on the login / invite / admin pages — observe only what exists).
  // Wait out the drawer's 280ms slide before re-anchoring: focusability is
  // decided from on-screen geometry, and a drawer caught mid-transition is
  // still parked off the right edge — we'd find nothing to highlight.
  const SETTLE_MS = 320;
  const reanchor = () => { cur = null; setTimeout(ensure, SETTLE_MS); };
  const detail = $("#detail"), player = $("#player"), appEl = $("#app");
  if (detail) new MutationObserver(reanchor).observe(detail, { attributes: true, attributeFilter: ["class"] });
  // Only an open/close is a layer change. The player's class churns constantly
  // (controls-hidden, hide-cursor, tv-controls) and reanchoring on that would
  // yank the highlight back to the first control on every keypress.
  let wasShown = player?.classList.contains("show");
  if (player) new MutationObserver(() => {
    const shown = player.classList.contains("show");
    if (shown === wasShown) return;
    wasShown = shown;
    if (!shown) { inControls = false; player.classList.remove("tv-controls"); }
    reanchor();
  }).observe(player, { attributes: true, attributeFilter: ["class"] });
  // A drawer opening (.show), a menu un-hiding, or Settings swapping to a
  // submenu all create a new layer that must take the highlight — none of them
  // shows up as a class change on #player itself.
  for (const el of document.querySelectorAll("#player .p-drawer, #player .p-menu, #player .p-submenu"))
    new MutationObserver(reanchor).observe(el, { attributes: true, attributeFilter: ["class", "hidden"] });
  // Same for the hamburger drawer: opening it must pull the highlight onto the
  // active tab link, and closing it must hand the highlight back to the page.
  const navDrawer = $("#drawer");
  if (navDrawer)
    new MutationObserver(reanchor).observe(navDrawer, { attributes: true, attributeFilter: ["class", "hidden"] });
  if (appEl) new MutationObserver(() => { if (!cur || !document.contains(cur)) setTimeout(ensure, 60); })
    .observe(appEl, { childList: true, subtree: true });
  setTimeout(ensure, 800);

  // ---- the rail: TV navigation as a fixed icon column on the left ----
  // A hamburger menu is a pointer idiom — on a remote it's a detour. The rail
  // is always there, one Left away, like every native TV app. It doesn't build
  // new behaviour: each icon proxies a hidden original control (the drawer tab
  // links, #randomBtn, #logout…), so routing, tab state and auth stay app.js's
  // business. tv.css hides those originals and pads the page for the column.
  (function buildRail() {
    if (!$("#app") || $("#tvRail")) return; // SPA pages only (login has its own layout), once
    const ic = (d) => `<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="${d}"/></svg>`;
    // Paths lifted from the app's own icon set so the language stays consistent.
    const I = {
      search: "M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z",
      home: "M12 3 2 12h3v8h6v-6h2v6h6v-8h3z",
      anime: "M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36A5.39 5.39 0 0 1 16.5 13a5.4 5.4 0 0 1-5.4-5.4c0-1.7.79-3.22 2.02-4.22C12.75 3.13 12.38 3 12 3z",
      movies: "M18 3v2h-2V3H8v2H6V3H4v18h2v-2h2v2h8v-2h2v2h2V3h-2zM8 17H6v-2h2v2zm0-4H6v-2h2v2zm0-4H6V7h2v2zm10 8h-2v-2h2v2zm0-4h-2v-2h2v2zm0-4h-2V7h2v2z",
      tv: "M21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5v2h8v-2h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 14H3V5h18z",
      sched: "M19 3h-1V1h-2v2H8V1H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H5V9h14v10zM5 7V5h14v2H5zm2 4h5v5H7z",
      random: "M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z",
      admin: "M19.14 12.94a7.5 7.5 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.59-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7 7 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.59.22L2.74 8.87a.5.5 0 0 0 .12.61l2.03 1.58a7.5 7.5 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.61l1.92 3.32a.5.5 0 0 0 .59.22l2.39-.96a7 7 0 0 0 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54a7 7 0 0 0 1.62-.94l2.39.96a.5.5 0 0 0 .59-.22l1.92-3.32a.5.5 0 0 0-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z",
      out: "M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8v-2H4z",
    };
    const rail = document.createElement("div");
    rail.id = "tvRail";
    rail.innerHTML = `
      <div class="tv-rail-mark" title="Mediawan"></div>
      <button class="tv-rail-btn" data-act="search" title="Search">${ic(I.search)}</button>
      <button class="tv-rail-btn" data-nav="/" data-id="home" title="Home">${ic(I.home)}</button>
      <button class="tv-rail-btn" data-nav="/browse?type=anime" data-id="anime" title="Anime">${ic(I.anime)}</button>
      <button class="tv-rail-btn" data-nav="/browse?type=movies" data-id="movies" title="Movies">${ic(I.movies)}</button>
      <button class="tv-rail-btn" data-nav="/browse?type=tv" data-id="tv" title="TV Shows">${ic(I.tv)}</button>
      <button class="tv-rail-btn anime-tool" data-act="schedule" title="Schedule">${ic(I.sched)}</button>
      <button class="tv-rail-btn anime-tool" data-act="random" title="Random">${ic(I.random)}</button>
      <div class="tv-rail-spacer"></div>
      <button class="tv-rail-btn" data-act="admin" id="tvRailAdmin" title="Admin" style="display:none">${ic(I.admin)}</button>
      <button class="tv-rail-btn" data-act="logout" title="Sign out">${ic(I.out)}</button>`;
    document.body.appendChild(rail);

    // Admin visibility mirrors the hidden original, which boot() reveals for admins.
    const admin = $("#adminLink");
    const syncAdmin = () => { $("#tvRailAdmin").style.display = admin && admin.style.display !== "none" ? "" : "none"; };
    if (admin) { new MutationObserver(syncAdmin).observe(admin, { attributes: true, attributeFilter: ["style"] }); syncAdmin(); }

    // Abandoning the field empty puts the screen back to rail + content only;
    // with a query still in it the strip stays, so Up from the results can
    // return to edit it.
    $("#search")?.addEventListener("blur", () => {
      if (!$("#search").value.trim()) document.body.classList.remove("tv-search");
    });

    rail.addEventListener("click", (e) => {
      const b = e.target.closest(".tv-rail-btn");
      if (!b) return;
      // Destination hops dismiss the search strip; the query itself is left alone.
      if (b.dataset.nav || ["schedule", "random"].includes(b.dataset.act))
        document.body.classList.remove("tv-search");
      if (b.dataset.nav) {
        // Straight to the route. The rail does NOT drive the web drawer by
        // proxy any more: the web collapsed its libraries behind one Browse
        // page, and inheriting that here would turn a single button press into
        // "open Browse, walk down to the pills, pick one" on a D-pad.
        if (window.nav) window.nav(b.dataset.nav);
        else location.href = b.dataset.nav; // app.js never booted — still navigable
        // Landing puts the highlight on the new page's hero button the moment
        // it exists — the rail is a means, not a destination.
        let tries = 0;
        const seek = setInterval(() => {
          const ready = document.querySelector("#heroCar .hero.active .hero-btn") ||
                        document.querySelector("#app .card");
          if (ready && visible(ready)) { clearInterval(seek); cur = null; browseDefault(); }
          else if (++tries > 25) clearInterval(seek); // page never painted — stay on the rail
        }, 120);
        return;
      }
      switch (b.dataset.act) {
        case "search": {
          const s = $("#search");
          if (!s) break;
          // the strip is display:none until summoned — reveal BEFORE focusing,
          // a hidden input can't take focus
          document.body.classList.add("tv-search");
          setFocus(s);
          try { s.focus(); } catch {}
          break;
        }
        case "schedule": $("#drawerSchedule")?.click(); break;
        case "random": $("#randomBtn")?.click(); break;
        case "admin": location.href = "/admin.html"; break;
        case "logout": $("#logout")?.click(); break;
      }
    });
  })();

  window.TVNav = { ensure, setFocus };
})();
