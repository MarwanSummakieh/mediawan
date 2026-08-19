(function() {
  if (/[?&]tv=1/.test(location.search)) {
    try {
      localStorage.setItem("tv", "1");
    } catch {
    }
  }
  const TV = !!window.tizen || /[?&]tv=1/.test(location.search) || localStorage.getItem("tv") === "1";
  if (!TV) return;
  document.documentElement.classList.add("tv");
  (function reportErrors() {
    const seen = /* @__PURE__ */ new Set();
    const send = (kind, message, extra) => {
      const key = kind + message;
      if (seen.has(key) || seen.size > 20) return;
      seen.add(key);
      try {
        fetch("/api/tv-log", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, message: String(message).slice(0, 500), ...extra })
        }).catch(function() {
        });
      } catch (e) {
      }
    };
    window.addEventListener("error", (e) => {
      if (e.target && e.target !== window && e.target.src)
        return send("resource", e.target.src, { tag: e.target.tagName });
      send("error", e.message, { at: (e.filename || "").split("/").pop() + ":" + e.lineno });
    }, true);
    window.addEventListener("unhandledrejection", (e) => send("rejection", e.reason && (e.reason.stack || e.reason.message) || e.reason));
    const P = window.Player;
    if (P && typeof P.showStatus === "function") {
      const status = P.showStatus.bind(P);
      P.showStatus = function(text, spinner) {
        if (text && !spinner) send("player", text);
        return status(text, spinner);
      };
      const action = P.showStatusAction.bind(P);
      P.showStatusAction = function(text, label, fn) {
        send("player", text + (label ? ` [${label}]` : ""));
        return action(text, label, fn);
      };
    }
    const vid = document.getElementById("video");
    if (vid) {
      vid.addEventListener("playing", function() {
        send("playing", `${Math.round(vid.videoWidth)}x${Math.round(vid.videoHeight)} dur=${Math.round(vid.duration || 0)}s`);
        setTimeout(function() {
          const name = (x, y) => {
            const e = document.elementFromPoint(x, y);
            if (!e) return "none";
            return (e.id || e.className && String(e.className).split(" ")[0] || e.tagName).slice(0, 24);
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
            `nav=${name(200, 60)}`
          ].join(" "));
        }, 600);
      }, { once: true });
      vid.addEventListener("stalled", () => send("stalled", "no data"), { once: true });
    }
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
        "vp=" + innerWidth + "x" + innerHeight
      ].join(" "));
    }, 1500));
  })();
  const $ = (s) => document.querySelector(s);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (getComputedStyle(el).visibility === "hidden") return false;
    if (el.closest(".p-drawer:not(.show)")) return false;
    return !el.closest(".hero:not(.active)");
  };
  const SEL = [
    ".card",
    ".fr-card",
    ".ep-row",
    ".sched-item",
    ".sched-day",
    ".hero-btn",
    ".hero-pg-btn",
    ".mode-pill",
    ".act-btn",
    ".detail-play",
    ".sheet-back",
    ".season-select",
    ".season-item",
    ".p-icon",
    ".p-bottom .scrub",
    ".up-next .btn",
    ".col-row input",
    "#search",
    ".filter-bar .btn",
    ".grid-empty .btn",
    "#catMore",
    ".nav .btn",
    "#navBurger",
    "#randomBtn",
    ".drawer-link",
    ".drawer-genre",
    ".tv-rail-btn",
    // (.row-arrow is deliberately absent: moving between cards scrolls the row,
    //  so the hover arrows are dead weight on a remote and tv.css hides them)
    ".auth-card input",
    ".auth-card .btn",
    // login / invite pages
    // inside the player: menus, the episodes drawer and the servers drawer.
    // A remote has no "s" or "c" shortcut key, so every one of these has to be
    // landable or the panel behind it may as well not exist on a TV.
    ".p-menu-item",
    ".p-menu-row",
    ".p-menu-back",
    ".sub-sync .p-icon",
    ".p-drawer-ep",
    ".srv-row",
    ".srv-fav",
    ".srv-foot .btn",
    ".p-status .btn"
  ].join(",");
  const isShown = (id) => {
    const el = $(id);
    return el && el.classList.contains("show");
  };
  function playerLayer() {
    const drawer = [...document.querySelectorAll("#player .p-drawer.show")].pop();
    if (drawer) return drawer;
    const menu = [...document.querySelectorAll("#player .p-menu:not([hidden])")].pop();
    return menu || null;
  }
  function surface() {
    const menu = $("#drawer");
    if (menu && !menu.hidden && menu.classList.contains("open")) return menu.querySelector(".drawer-panel");
    if (isShown("#player")) return playerLayer() || $("#player");
    if (isShown("#detail")) return $("#detail");
    if (isShown("#mDetail")) return $("#mDetail");
    return document.body;
  }
  function focusables() {
    return [...surface().querySelectorAll(SEL)].filter(visible);
  }
  let cur = null;
  let inControls = false;
  function setFocus(el, opts) {
    if (!el) return;
    const act = document.activeElement;
    if (act && act !== el && ["INPUT", "TEXTAREA", "SELECT"].includes(act.tagName)) {
      act.blur();
      if (act.id === "search" && !act.value.trim()) document.body.classList.remove("tv-search");
    }
    document.querySelectorAll(".tv-focus").forEach((e) => e.classList.remove("tv-focus"));
    document.querySelectorAll(".tv-focus-within").forEach((e) => e.classList.remove("tv-focus-within"));
    cur = el;
    el.classList.add("tv-focus");
    const card = el.closest(".card");
    if (card) card.classList.add("tv-focus-within");
    if (!opts || !opts.noScroll)
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    if (el.tagName === "INPUT" || el.tagName === "SELECT") {
      try {
        el.focus({ preventScroll: true });
      } catch {
      }
    }
  }
  function ensure() {
    var _a, _b, _c, _d;
    if (cur && document.contains(cur) && visible(cur) && surface().contains(cur)) return;
    const f = focusables();
    const marked = f.find((e) => e.matches(".srv-row.live, .p-menu-item.active, .p-drawer-ep.active, .drawer-link.active"));
    if (marked) {
      setFocus(marked);
      return;
    }
    if (inControls && isShown("#player") && !playerLayer()) {
      const bar = f.filter((e) => e.closest(".p-bottom"));
      if (bar.length) {
        setFocus(bar.find((b) => b.id === "pPlay") || bar[0]);
        return;
      }
    }
    if (surface() === document.body && $("#app") && browseDefault()) return;
    if (!f.length && isShown("#player") && playerLayer()) {
      (_b = (_a = window.Player) == null ? void 0 : _a.hideMenus) == null ? void 0 : _b.call(_a);
      (_d = (_c = window.Player) == null ? void 0 : _c.closeDrawer) == null ? void 0 : _d.call(_c);
      const bar = [...$("#player").querySelectorAll(".p-bottom .p-icon")].filter(visible);
      if (bar.length) {
        setFocus(bar.find((b) => b.id === "pPlay") || bar[0]);
        return;
      }
    }
    const noInput = f.filter((e) => !["INPUT", "SELECT"].includes(e.tagName));
    setFocus(noInput.find((e) => e.classList.contains("card")) || noInput[0] || f[0]);
  }
  let anchorX = null;
  function move(dir) {
    ensure();
    if (!cur) return;
    const a = cur.getBoundingClientRect();
    const vertical = dir === "up" || dir === "down";
    const ay = a.top + a.height / 2;
    const trueX = a.left + a.width / 2;
    if (!vertical) anchorX = null;
    else if (anchorX === null) anchorX = trueX;
    const ax = vertical ? anchorX : trueX;
    let best = null, score = Infinity;
    const fromRail = !!(cur && cur.closest && cur.closest("#tvRail"));
    for (const el of focusables()) {
      if (el === cur) continue;
      if (!fromRail && dir !== "left" && el.closest && el.closest("#tvRail")) continue;
      const b = el.getBoundingClientRect();
      const bx = b.left + b.width / 2, by = b.top + b.height / 2;
      const dx = bx - (vertical ? trueX : ax), dy = by - ay;
      let forward, primary, cross;
      if (dir === "left") {
        forward = -dx;
        primary = Math.abs(dx);
        cross = Math.abs(dy);
      } else if (dir === "right") {
        forward = dx;
        primary = Math.abs(dx);
        cross = Math.abs(dy);
      } else if (dir === "up") {
        forward = -dy;
        primary = Math.abs(dy);
        cross = Math.abs(bx - ax);
      } else {
        forward = dy;
        primary = Math.abs(dy);
        cross = Math.abs(bx - ax);
      }
      if (forward <= 2) continue;
      const s = primary + cross * 2;
      if (s < score) {
        score = s;
        best = el;
      }
    }
    if (best) {
      if (best.closest && best.closest("#tvRail") && cur && !cur.closest("#tvRail")) lastContent = cur;
      setFocus(best);
    }
  }
  function activate() {
    ensure();
    if (!cur) return;
    if (cur.tagName === "INPUT") {
      cur.focus();
      return;
    }
    if (cur.tagName === "SELECT") {
      cur.selectedIndex = (cur.selectedIndex + 1) % cur.options.length;
      cur.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    cur.click();
  }
  let lastContent = null;
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
        groups.push({
          type: "hero",
          el: hero.closest(".hero-car"),
          items,
          home: Math.max(0, items.findIndex((b) => b.classList.contains("primary")))
        });
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
      if (d < score) {
        score = d;
        best = i;
      }
    });
    return best;
  };
  function focusItem(group, i) {
    i = Math.max(0, Math.min(i, group.items.length - 1));
    const item = group.items[i];
    if (group.type !== "grid") group.el.__tvIdx = i;
    setFocus(item, { noScroll: true });
    if (group.type === "row") {
      const t = item.offsetLeft - 8;
      group.el.scrollLeft = Math.max(0, Math.min(t, group.el.scrollWidth - group.el.clientWidth));
    }
    if (group.type === "hero") {
      window.scrollTo(0, 0);
      return;
    }
    const cont = group.type === "row" ? group.el.closest(".row") || group.el : group.type === "grid" ? item : group.el;
    const y = window.pageYOffset + cont.getBoundingClientRect().top;
    window.scrollTo(0, Math.max(0, y - (group.type === "grid" ? 210 : 150)));
  }
  function browseDefault() {
    const groups = contentGroups();
    if (!groups.length) return false;
    const g = groups[0];
    focusItem(g, g.home != null ? g.home : g.el && g.el.__tvIdx || 0);
    return true;
  }
  function browseMove(dir) {
    const groups = contentGroups();
    if (!groups.length) return false;
    const pos = cur ? findPos(groups, cur) : null;
    if (!pos) return browseDefault();
    const group = groups[pos.g];
    if (dir === "left") {
      if (pos.i === 0) {
        focusRail();
        return true;
      }
      focusItem(group, pos.i - 1);
      return true;
    }
    if (dir === "right") {
      focusItem(group, pos.i + 1);
      return true;
    }
    const next = groups[pos.g + (dir === "down" ? 1 : -1)];
    if (!next) return true;
    const x = cur.getBoundingClientRect().left + cur.getBoundingClientRect().width / 2;
    const idx = next.type === "grid" ? nearestIdx(next.items, x) : next.el && next.el.__tvIdx != null ? next.el.__tvIdx : next.home != null ? next.home : nearestIdx(next.items, x);
    focusItem(next, idx);
    return true;
  }
  const railButtons = () => [...document.querySelectorAll("#tvRail .tv-rail-btn")].filter(visible);
  function focusRail() {
    const btns = railButtons();
    if (!btns.length) return;
    lastContent = cur;
    const y = cur ? cur.getBoundingClientRect().top : 0;
    let best = 0, score = Infinity;
    btns.forEach((b, i) => {
      const d = Math.abs(b.getBoundingClientRect().top - y);
      if (d < score) {
        score = d;
        best = i;
      }
    });
    setFocus(btns[best]);
  }
  function railMove(dir) {
    const btns = railButtons();
    const i = btns.indexOf(cur);
    if (i < 0) {
      setFocus(btns[0]);
      return;
    }
    if (dir === "up") setFocus(btns[Math.max(0, i - 1)]);
    else if (dir === "down") setFocus(btns[Math.min(btns.length - 1, i + 1)]);
    else if (dir === "right") {
      if (lastContent && document.contains(lastContent) && visible(lastContent)) setFocus(lastContent);
      else {
        cur = null;
        if (!browseDefault()) ensure();
      }
    }
  }
  const onBrowse = () => surface() === document.body && !!$("#app");
  const onRail = () => !!(cur && cur.classList && cur.classList.contains("tv-rail-btn"));
  function enterControls() {
    var _a, _b;
    const p = $("#player");
    if (!p) return;
    inControls = true;
    p.classList.add("tv-controls");
    (_b = (_a = window.Player) == null ? void 0 : _a.poke) == null ? void 0 : _b.call(_a);
    const bar = [...p.querySelectorAll(".p-bottom .p-icon")].filter(visible);
    setFocus(bar.find((b) => b.id === "pPlay") || bar[0]);
    armIdle();
  }
  function exitControls(idle) {
    var _a, _b, _c, _d;
    inControls = false;
    clearTimeout(idleTimer);
    (_a = $("#player")) == null ? void 0 : _a.classList.remove("tv-controls");
    document.querySelectorAll(".tv-focus").forEach((e) => e.classList.remove("tv-focus"));
    cur = null;
    if (idle) (_b = $("#player")) == null ? void 0 : _b.classList.add("controls-hidden", "hide-cursor");
    else (_d = (_c = window.Player) == null ? void 0 : _c.poke) == null ? void 0 : _d.call(_c);
  }
  const IDLE_MS = 5e3;
  let idleTimer = null;
  function armIdle() {
    clearTimeout(idleTimer);
    if (!inControls) return;
    idleTimer = setTimeout(() => {
      var _a, _b;
      if (!inControls) return;
      if (playerLayer() || ((_b = (_a = window.Player) == null ? void 0 : _a.video) == null ? void 0 : _b.paused)) {
        armIdle();
        return;
      }
      exitControls(true);
    }, IDLE_MS);
  }
  const onScrub = () => !!(cur && cur.id === "scrub");
  const seekBy = (secs) => {
    var _a, _b, _c, _d;
    (_b = (_a = window.Player) == null ? void 0 : _a.nudge) == null ? void 0 : _b.call(_a, secs);
    (_d = (_c = window.Player) == null ? void 0 : _c.poke) == null ? void 0 : _d.call(_c);
  };
  function back() {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k;
    if (isShown("#player")) {
      const layer = playerLayer();
      if (layer) {
        const sub = layer.id === "settingsMenu" && layer.querySelector("[data-sub]:not([hidden])");
        if (sub && sub.dataset.sub !== "root") (_b = (_a = window.Player) == null ? void 0 : _a.gotoSub) == null ? void 0 : _b.call(_a, "root");
        else if (layer.classList.contains("p-drawer")) (_d = (_c = window.Player) == null ? void 0 : _c.closeDrawer) == null ? void 0 : _d.call(_c);
        else (_f = (_e = window.Player) == null ? void 0 : _e.hideMenus) == null ? void 0 : _f.call(_e);
        cur = null;
        setTimeout(() => inControls && enterControls(), SETTLE_MS);
        return;
      }
      if (inControls) {
        exitControls();
        return;
      }
      (_h = (_g = window.Player) == null ? void 0 : _g.close) == null ? void 0 : _h.call(_g);
      return;
    }
    for (const id of ["#colMenu", "#ccMenu", "#audMenu", "#settingsMenu"]) {
      const m = $(id);
      if (m && !m.hidden) {
        m.hidden = true;
        return;
      }
    }
    const drawer = $("#drawer");
    if (drawer && drawer.classList.contains("open")) {
      (_i = $("#drawerClose")) == null ? void 0 : _i.click();
      return;
    }
    if (isShown("#detail")) {
      (_j = $("#detailClose")) == null ? void 0 : _j.click();
      cur = null;
      return;
    }
    if (isShown("#mDetail")) {
      (_k = $("#mDetailClose")) == null ? void 0 : _k.click();
      cur = null;
      return;
    }
    const sheetBack = document.querySelector("#app .sheet-back");
    if (sheetBack && visible(sheetBack)) {
      sheetBack.click();
      cur = null;
    }
  }
  document.addEventListener("keydown", (e) => {
    var _a, _b, _c, _d, _e, _f;
    const player2 = isShown("#player");
    const k = e.keyCode;
    if (k === 10009) {
      e.preventDefault();
      back();
      return;
    }
    if (player2) {
      const own = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const layer = playerLayer();
      if (layer) {
        switch (k) {
          case 37:
            own();
            move("left");
            return;
          case 39:
            own();
            move("right");
            return;
          case 38:
            own();
            move("up");
            return;
          case 40:
            own();
            move("down");
            return;
          case 13:
            own();
            activate();
            return;
        }
        return;
      }
      if (inControls) {
        (_b = (_a = window.Player) == null ? void 0 : _a.poke) == null ? void 0 : _b.call(_a);
        armIdle();
        switch (k) {
          case 37:
            own();
            onScrub() ? seekBy(-10) : move("left");
            return;
          case 39:
            own();
            onScrub() ? seekBy(10) : move("right");
            return;
          // Two rows: the scrubber sits above the buttons. Up reaches for it,
          // Down comes back — and Down from the buttons leaves the bar
          // altogether, which is the way in reversed.
          case 38:
            own();
            if (!onScrub()) move("up");
            return;
          case 40:
            own();
            onScrub() ? move("down") : exitControls();
            return;
          // OK on the scrubber has no "activate" of its own — play/pause is
          // what a remote's centre button means over a progress bar.
          case 13:
            own();
            onScrub() ? (_d = (_c = window.Player) == null ? void 0 : _c.togglePlay) == null ? void 0 : _d.call(_c) : activate();
            return;
        }
        return;
      }
      if (k === 40 || k === 38) {
        own();
        enterControls();
        return;
      }
      if (k === 13) {
        e.preventDefault();
        (_f = (_e = window.Player) == null ? void 0 : _e.togglePlay) == null ? void 0 : _f.call(_e);
        return;
      }
      if (k === 37) {
        own();
        seekBy(-10);
        return;
      }
      if (k === 39) {
        own();
        seekBy(10);
        return;
      }
      return;
    }
    const typing = document.activeElement && document.activeElement.tagName === "INPUT";
    const inSearch = typing && document.activeElement.id === "search";
    const go = (dir) => {
      if (onBrowse()) {
        if (onRail()) return railMove(dir);
        if (browseMove(dir)) return;
      }
      move(dir);
    };
    switch (k) {
      case 37:
        if (typing) return;
        go("left");
        e.preventDefault();
        break;
      // caret keys stay with the field
      case 39:
        if (typing) return;
        go("right");
        e.preventDefault();
        break;
      // Up/Down leave the field: setFocus blurs it, so the highlight and the
      // DOM focus move TOGETHER — splitting them is what trapped the remote.
      case 38:
        go("up");
        e.preventDefault();
        break;
      case 40:
        go("down");
        e.preventDefault();
        break;
      case 13:
        if (inSearch) {
          e.preventDefault();
          document.activeElement.blur();
          cur = null;
          setTimeout(() => {
            const hit = [...document.querySelectorAll("#app .card")].filter(visible)[0];
            if (hit) setFocus(hit);
            else ensure();
          }, 450);
          break;
        }
        if (!typing) {
          activate();
          e.preventDefault();
        }
        break;
    }
  }, true);
  const SETTLE_MS = 320;
  const reanchor = () => {
    cur = null;
    setTimeout(ensure, SETTLE_MS);
  };
  const detail = $("#detail"), player = $("#player"), appEl = $("#app");
  if (detail) new MutationObserver(reanchor).observe(detail, { attributes: true, attributeFilter: ["class"] });
  let wasShown = player == null ? void 0 : player.classList.contains("show");
  if (player) new MutationObserver(() => {
    const shown = player.classList.contains("show");
    if (shown === wasShown) return;
    wasShown = shown;
    if (!shown) {
      inControls = false;
      player.classList.remove("tv-controls");
    }
    reanchor();
  }).observe(player, { attributes: true, attributeFilter: ["class"] });
  for (const el of document.querySelectorAll("#player .p-drawer, #player .p-menu, #player .p-submenu"))
    new MutationObserver(reanchor).observe(el, { attributes: true, attributeFilter: ["class", "hidden"] });
  const navDrawer = $("#drawer");
  if (navDrawer)
    new MutationObserver(reanchor).observe(navDrawer, { attributes: true, attributeFilter: ["class", "hidden"] });
  if (appEl) new MutationObserver(() => {
    if (!cur || !document.contains(cur)) setTimeout(ensure, 60);
  }).observe(appEl, { childList: true, subtree: true });
  setTimeout(ensure, 800);
  (function buildRail() {
    var _a;
    if (!$("#app") || $("#tvRail")) return;
    const ic = (d) => `<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="${d}"/></svg>`;
    const I = {
      search: "M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z",
      home: "M12 3 2 12h3v8h6v-6h2v6h6v-8h3z",
      anime: "M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36A5.39 5.39 0 0 1 16.5 13a5.4 5.4 0 0 1-5.4-5.4c0-1.7.79-3.22 2.02-4.22C12.75 3.13 12.38 3 12 3z",
      movies: "M18 3v2h-2V3H8v2H6V3H4v18h2v-2h2v2h8v-2h2v2h2V3h-2zM8 17H6v-2h2v2zm0-4H6v-2h2v2zm0-4H6V7h2v2zm10 8h-2v-2h2v2zm0-4h-2v-2h2v2zm0-4h-2V7h2v2z",
      tv: "M21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5v2h8v-2h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 14H3V5h18z",
      sched: "M19 3h-1V1h-2v2H8V1H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H5V9h14v10zM5 7V5h14v2H5zm2 4h5v5H7z",
      random: "M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z",
      admin: "M19.14 12.94a7.5 7.5 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.59-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7 7 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.59.22L2.74 8.87a.5.5 0 0 0 .12.61l2.03 1.58a7.5 7.5 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.61l1.92 3.32a.5.5 0 0 0 .59.22l2.39-.96a7 7 0 0 0 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54a7 7 0 0 0 1.62-.94l2.39.96a.5.5 0 0 0 .59-.22l1.92-3.32a.5.5 0 0 0-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z",
      out: "M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8v-2H4z"
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
    const admin = $("#adminLink");
    const syncAdmin = () => {
      $("#tvRailAdmin").style.display = admin && admin.style.display !== "none" ? "" : "none";
    };
    if (admin) {
      new MutationObserver(syncAdmin).observe(admin, { attributes: true, attributeFilter: ["style"] });
      syncAdmin();
    }
    (_a = $("#search")) == null ? void 0 : _a.addEventListener("blur", () => {
      if (!$("#search").value.trim()) document.body.classList.remove("tv-search");
    });
    rail.addEventListener("click", (e) => {
      var _a2, _b, _c;
      const b = e.target.closest(".tv-rail-btn");
      if (!b) return;
      if (b.dataset.nav || ["schedule", "random"].includes(b.dataset.act))
        document.body.classList.remove("tv-search");
      if (b.dataset.nav) {
        if (window.nav) window.nav(b.dataset.nav);
        else location.href = b.dataset.nav;
        let tries = 0;
        const seek = setInterval(() => {
          const ready = document.querySelector("#heroCar .hero.active .hero-btn") || document.querySelector("#app .card");
          if (ready && visible(ready)) {
            clearInterval(seek);
            cur = null;
            browseDefault();
          } else if (++tries > 25) clearInterval(seek);
        }, 120);
        return;
      }
      switch (b.dataset.act) {
        case "search": {
          const s = $("#search");
          if (!s) break;
          document.body.classList.add("tv-search");
          setFocus(s);
          try {
            s.focus();
          } catch {
          }
          break;
        }
        case "schedule":
          (_a2 = $("#drawerSchedule")) == null ? void 0 : _a2.click();
          break;
        case "random":
          (_b = $("#randomBtn")) == null ? void 0 : _b.click();
          break;
        case "admin":
          location.href = "/admin.html";
          break;
        case "logout":
          (_c = $("#logout")) == null ? void 0 : _c.click();
          break;
      }
    });
  })();
  window.TVNav = { ensure, setFocus };
})();
