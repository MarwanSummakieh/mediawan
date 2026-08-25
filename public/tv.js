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
    ".p-icon", ".p-bottom .scrub", ".up-next .btn", ".col-row input", "#search",
    ".filter-bar .btn", ".grid-empty .btn", "#catMore", ".searchbar-close",
    // Genre chips: a detour mid-browse, but they are how a library gets
    // narrowed without a keyboard, so the remote reaches them like anything else.
    ".genres button", "button.hero-chip",
    // The picker replaced every <select> precisely so a D-pad could drive one.
    ".picker-btn", ".picker-opt",
    // The rail is the app's own navigation now, not a TV-only column.
    ".rail-btn",
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
    // An open picker owns the remote while it is up, wherever it was opened
    // from — the filter bar, a season chooser inside a detail sheet. Without
    // this, Left/Right would walk straight out of the list and along the bar
    // behind it, and OK would fire whatever it landed on.
    const picker = document.querySelector('.picker[data-open="true"] .picker-menu:not([hidden])');
    if (picker) return picker;
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
      if (act.id === "search" && !act.value.trim()) document.body.classList.remove("search-open");
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
    const marked = f.find((e) => e.matches(".srv-row.live, .p-menu-item.active, .p-drawer-ep.active, .picker-opt.active"));
    if (marked) { setFocus(marked); return; }
    // The bare player — no menu open, bar not entered — has no destination for
    // a highlight: the arrows seek and Up/Down is the deliberate way into the
    // bar. Auto-landing one anyway used to put a ring on a fading control;
    // once the scrubber became landable it put a grown, accent-washed progress
    // bar over the film's opening seconds. A status action or the up-next
    // toast is the exception: those exist to be pressed, so they take the
    // highlight — otherwise leave the picture alone.
    if (isShown("#player") && !playerLayer() && !inControls) {
      const act = f.find((e) => e.closest(".p-status, .up-next"));
      if (act) { setFocus(act); return; }
      // no highlight at all — and none left behind on the page under the overlay
      document.querySelectorAll(".tv-focus").forEach((e) => e.classList.remove("tv-focus"));
      document.querySelectorAll(".tv-focus-within").forEach((e) => e.classList.remove("tv-focus-within"));
      return;
    }
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
    // Nor on the rail. It is a destination reached with Left, not a resting
    // place — and it is the FIRST thing in the document now that it is the
    // app's own navigation, so a plain "first focusable" fallback would park
    // the highlight on Home every time a ladder-less page (the schedule)
    // repainted, and Down would then walk the rail instead of the content.
    const content = noInput.filter((e) => !e.closest("#rail"));
    setFocus(content.find((e) => e.classList.contains("card")) || content[0] || noInput[0] || f[0]);
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
    const fromRail = !!(cur && cur.closest && cur.closest("#rail"));
    for (const el of focusables()) {
      if (el === cur) continue;
      // The rail is a deliberate destination, not a neighbour: only Left may
      // reach it. Otherwise "Down past the last season" lands on Sign out.
      if (!fromRail && dir !== "left" && el.closest && el.closest("#rail")) continue;
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
      if (best.closest && best.closest("#rail") && cur && !cur.closest("#rail")) lastContent = cur;
      setFocus(best);
    }
  }

  function activate() {
    ensure();
    if (!cur) return;
    if (cur.tagName === "INPUT") { cur.focus(); return; }
    // OK used to have to CYCLE a native <select>, because its dropdown was a
    // platform-drawn list no remote could enter. Every one of them is a .picker
    // now — a real list of real buttons — so OK just presses what it is on.
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
      // An open picker is its own layer (see surface()), so its options must
      // not also count as rungs of the bar underneath it.
      const items = [...bar.querySelectorAll("button")]
        .filter((b) => !b.closest(".picker-menu")).filter(visible);
      if (items.length) groups.push({ type: "bar", el: bar, items });
    }
    for (const row of document.querySelectorAll(".row .cards")) {
      const items = [...row.querySelectorAll(".card")].filter((c) => c.offsetWidth > 1);
      if (items.length) groups.push({ type: "row", el: row, items });
    }
    for (const grid of document.querySelectorAll(".cards-grid")) groups.push(...gridLines(grid));
    const more = $("#catMore");
    if (more && more.offsetHeight > 0) groups.push({ type: "foot", el: more.parentElement, items: [more] });
    // The search strip, when it is up, is the rung above everything else — the
    // field and the ✕ that dismisses it. Only ever an EXTRA rung, though: on a
    // ladder-less view (the schedule) an empty group set is the signal to fall
    // back to the spatial engine, and a lone search rung would swallow it and
    // trap the remote on a text field.
    const strip = $("#searchbar");
    if (groups.length && strip && strip.offsetHeight > 0) {
      const items = [...strip.querySelectorAll("#search, .searchbar-close")].filter(visible);
      if (items.length) groups.unshift({ type: "search", el: strip, items });
    }
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
    // Never LAND on the search rung: focusing the field summons the TV's IME,
    // and nobody asked to type just because a page repainted. It stays one
    // deliberate Up away.
    const g = groups.find((x) => x.type !== "search") || groups[0];
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
  const railButtons = () => [...document.querySelectorAll("#rail .rail-btn")].filter(visible);
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
  const onRail = () => !!(cur && cur.classList && cur.classList.contains("rail-btn"));

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
    armIdle();
  }
  function exitControls(idle) {
    inControls = false;
    clearTimeout(idleTimer);
    $("#player")?.classList.remove("tv-controls");
    document.querySelectorAll(".tv-focus").forEach((e) => e.classList.remove("tv-focus"));
    cur = null;
    // Leaving on purpose (Down / Back) restarts the normal fade. Leaving
    // because nobody touched the remote must NOT: poke() would pull the bar
    // straight back up for another three seconds, which is the stuck-open
    // behaviour with an extra step.
    if (idle) $("#player")?.classList.add("controls-hidden", "hide-cursor");
    else window.Player?.poke?.();
  }
  // The control bar used to be PINNED for as long as the remote was on it, so
  // walking into it and then just watching left the chrome burnt across the
  // bottom of the picture forever. It stays up while the remote is being used
  // and steps back out on its own once it isn't — the highlight goes with it,
  // because chrome that fades out from under a highlight is worse than either.
  const IDLE_MS = 5000;
  let idleTimer = null;
  function armIdle() {
    clearTimeout(idleTimer);
    if (!inControls) return;
    idleTimer = setTimeout(() => {
      // An open menu/drawer is a deliberate act, and a paused film is someone
      // who walked away — neither is idleness the chrome should punish.
      if (!inControls) return;
      if (playerLayer() || window.Player?.video?.paused) { armIdle(); return; }
      exitControls(true);
    }, IDLE_MS);
  }
  // The scrubber is a control like any other: standing on it makes Left/Right
  // seek instead of walking the row, which is the whole reason it is landable.
  const onScrub = () => !!(cur && cur.id === "scrub");
  const seekBy = (secs) => { window.Player?.nudge?.(secs); window.Player?.poke?.(); };
  // The bar is a fixed two-rung ladder, not free space. The scrubber spans the
  // whole width one rung above the buttons, so to the spatial engine it is
  // "nearest to the right" the moment a gap in the button row (the flex spacer
  // before Audio/Settings) is wider than the hop up — walking toward Settings
  // hijacked the highlight onto the scrubber, whose Left/Right mean SEEK, and
  // the right half of the bar became unreachable. So inside the bar the
  // D-pad walks rungs explicitly: Left/Right step through the buttons in
  // screen order, Up/Down swap rungs, and the scrubber remembers which button
  // to hand the highlight back to.
  const onBar = () => !!(cur && cur.classList && cur.classList.contains("p-icon") && cur.closest(".p-bottom"));
  // The ‹ in the title bar is the ladder's top rung — a single-button row, so
  // sideways presses on it go nowhere rather than leaping somewhere surprising.
  const onTop = () => !!(cur && cur.closest && cur.closest("#player .p-top"));
  const barButtons = () => [...document.querySelectorAll("#player .p-bottom .p-icon")]
    .filter(visible)
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  let barReturn = null; // where Down from the scrubber lands
  function barMove(dir) {
    const btns = barButtons();
    if (!btns.length) return;
    const i = btns.indexOf(cur);
    if (i < 0) { setFocus(btns.find((b) => b.id === "pPlay") || btns[0]); return; }
    setFocus(btns[Math.max(0, Math.min(btns.length - 1, i + (dir === "right" ? 1 : -1)))]);
  }
  function barDown() {
    const btns = barButtons();
    if (!btns.length) { exitControls(); return; } // a rung with no buttons is no rung
    setFocus(btns.includes(barReturn) ? barReturn : btns.find((b) => b.id === "pPlay") || btns[0]);
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
    // An open picker is the innermost layer — one Back closes it and hands the
    // highlight back to the control, not to the page behind the sheet.
    const openPicker = document.querySelector('.picker[data-open="true"]');
    if (openPicker) {
      const btn = openPicker.querySelector(".picker-btn");
      btn.click(); // app.js owns open/close; this is the same press a mouse makes
      setFocus(btn);
      return;
    }
    if (isShown("#detail")) { $("#detailClose")?.click(); cur = null; return; }
    // Films and shows use their own sheet (same treatment, different overlay).
    if (isShown("#mDetail")) { $("#mDetailClose")?.click(); cur = null; return; }
    // In-page views with their own ‹ (category sheets): the remote's Back
    // drives it, same contract as everywhere else.
    const sheetBack = document.querySelector("#app .sheet-back");
    if (sheetBack && visible(sheetBack)) { sheetBack.click(); cur = null; return; }
    // The search strip is the outermost layer: nothing is covering it, so this
    // is the last thing Back can unwind. Its ✕ does the same job for a pointer,
    // but a remote never reaches it — arrow keys inside a text field move the
    // caret, which is why the field swallows Left and Right.
    if (document.body.classList.contains("search-open")) $("#searchClose").click();
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
        armIdle();
        switch (k) {
          case 37: own(); if (onScrub()) seekBy(-10); else if (onBar()) barMove("left"); else if (!onTop()) move("left"); return;
          case 39: own(); if (onScrub()) seekBy(10); else if (onBar()) barMove("right"); else if (!onTop()) move("right"); return;
          // Three rungs: the ‹ in the title bar, the scrubber, the buttons.
          // Up climbs, Down comes back to where it left — and Down from the
          // buttons leaves the bar altogether, which is the way in reversed.
          // From the scrubber, Up goes spatially so whatever floats above the
          // bar (a status action, the up-next toast) takes precedence over
          // the ‹ when something does.
          case 38: own();
            if (onScrub() || !onBar()) move("up");
            else { barReturn = cur; const s = $("#player .p-bottom .scrub"); if (s && visible(s)) setFocus(s); }
            return;
          case 40: own();
            if (onScrub()) barDown();
            else if (onBar()) exitControls();
            else if (onTop()) { const s = $("#player .p-bottom .scrub"); if (s && visible(s)) setFocus(s); else barDown(); }
            else move("down");
            return;
          // OK on the scrubber has no "activate" of its own — play/pause is
          // what a remote's centre button means over a progress bar.
          case 13: own(); onScrub() ? window.Player?.togglePlay?.() : activate(); return;
        }
        return;
      }
      // The controls live at the BOTTOM of the screen, so Down is the press
      // that reaches for them. Up is accepted too — nobody should have to
      // learn which one is right while the film is running.
      if (k === 40 || k === 38) { own(); enterControls(); return; }
      // OK over the bare video is play/pause — unless a status action or the
      // up-next toast holds the highlight, in which case OK means THAT button.
      if (k === 13) {
        e.preventDefault();
        if (cur && document.contains(cur) && visible(cur) && cur.closest(".p-status, .up-next")) activate();
        else window.Player?.togglePlay?.();
        return;
      }
      if (k === 37) { own(); seekBy(-10); return; }
      if (k === 39) { own(); seekBy(10); return; }
      return;
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
  // Wait out the player drawer's 280ms slide before re-anchoring: focusability
  // is decided from on-screen geometry, and a drawer caught mid-transition is
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
  // Opening a picker creates a layer the same way a player menu does, and it
  // has to take the highlight — onto the option already chosen, which ensure()
  // finds by .picker-opt.active. data-open is what surface() reads, so that is
  // what to watch. Pickers are re-rendered constantly, so this observes the
  // page and re-attaches rather than binding to elements that will be replaced.
  const watchPickers = () => {
    for (const box of document.querySelectorAll(".picker")) {
      if (box.__tvWatched) continue;
      box.__tvWatched = true;
      new MutationObserver(reanchor).observe(box, { attributes: true, attributeFilter: ["data-open"] });
    }
  };
  watchPickers();
  new MutationObserver(watchPickers).observe(document.body, { childList: true, subtree: true });
  if (appEl) new MutationObserver(() => { if (!cur || !document.contains(cur)) setTimeout(ensure, 60); })
    .observe(appEl, { childList: true, subtree: true });
  // Dismissing the search strip hides the field and the ✕ with display:none —
  // they stay in the document, so the check above never fires and the highlight
  // is left on something invisible. Summoning it needs no help: the rail's own
  // handler moves the highlight onto the field.
  let wasSearch = document.body.classList.contains("search-open");
  new MutationObserver(() => {
    const on = document.body.classList.contains("search-open");
    if (on === wasSearch) return;
    wasSearch = on;
    if (!on) reanchor();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  setTimeout(ensure, 800);

  // ---- the rail, on a remote ----
  // The rail is no longer a TV invention: it is the app's only navigation on
  // every device, static markup in index.html driven by app.js. What a D-pad
  // still needs is somewhere to BE afterwards — the rail is a means, not a
  // destination, so a press has to hand the highlight to what it summoned.
  const railEl = $("#rail");
  if (railEl) railEl.addEventListener("click", (e) => {
    const b = e.target.closest(".rail-btn");
    if (!b) return;
    if (b.dataset.act === "search") {
      // app.js has already revealed the strip and focused the field; a hidden
      // input cannot take focus, so the highlight follows rather than leads.
      const box = $("#search");
      if (box) setFocus(box);
      return;
    }
    if (!b.dataset.nav) return;
    // Landing puts the highlight on the new page's hero button the moment it
    // exists, so the rail is never where the remote is left sitting.
    let tries = 0;
    const seek = setInterval(() => {
      const ready = document.querySelector("#heroCar .hero.active .hero-btn") ||
                    document.querySelector("#app .card");
      if (ready && visible(ready)) { clearInterval(seek); cur = null; browseDefault(); }
      else if (++tries > 25) clearInterval(seek); // page never painted — stay on the rail
    }, 120);
  });
  window.TVNav = { ensure, setFocus };
})();
