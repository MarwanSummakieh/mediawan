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
    ".p-icon",
    ".p-bottom .scrub",
    ".up-next .btn",
    ".col-row input",
    "#search",
    ".filter-bar .btn",
    ".grid-empty .btn",
    "#catMore",
    ".searchbar-close",
    // Genre chips: a detour mid-browse, but they are how a library gets
    // narrowed without a keyboard, so the remote reaches them like anything else.
    ".genres button",
    "button.hero-chip",
    // The picker replaced every <select> precisely so a D-pad could drive one.
    ".picker-btn",
    ".picker-opt",
    // The rail is the app's own navigation now, not a TV-only column.
    ".rail-btn",
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
    const picker = document.querySelector('.picker[data-open="true"] .picker-menu:not([hidden])');
    if (picker) return picker;
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
      if (act.id === "search" && !act.value.trim()) document.body.classList.remove("search-open");
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
    const marked = f.find((e) => e.matches(".srv-row.live, .p-menu-item.active, .p-drawer-ep.active, .picker-opt.active"));
    if (marked) {
      setFocus(marked);
      return;
    }
    if (isShown("#player") && !playerLayer() && !inControls) {
      const act = f.find((e) => e.closest(".p-status, .up-next"));
      if (act) {
        setFocus(act);
        return;
      }
      document.querySelectorAll(".tv-focus").forEach((e) => e.classList.remove("tv-focus"));
      document.querySelectorAll(".tv-focus-within").forEach((e) => e.classList.remove("tv-focus-within"));
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
    const content = noInput.filter((e) => !e.closest("#rail"));
    setFocus(content.find((e) => e.classList.contains("card")) || content[0] || noInput[0] || f[0]);
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
    const fromRail = !!(cur && cur.closest && cur.closest("#rail"));
    for (const el of focusables()) {
      if (el === cur) continue;
      if (!fromRail && dir !== "left" && el.closest && el.closest("#rail")) continue;
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
      if (best.closest && best.closest("#rail") && cur && !cur.closest("#rail")) lastContent = cur;
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
      const items = [...bar.querySelectorAll("button")].filter((b) => !b.closest(".picker-menu")).filter(visible);
      if (items.length) groups.push({ type: "bar", el: bar, items });
    }
    for (const row of document.querySelectorAll(".row .cards")) {
      const items = [...row.querySelectorAll(".card")].filter((c) => c.offsetWidth > 1);
      if (items.length) groups.push({ type: "row", el: row, items });
    }
    for (const grid of document.querySelectorAll(".cards-grid")) groups.push(...gridLines(grid));
    const more = $("#catMore");
    if (more && more.offsetHeight > 0) groups.push({ type: "foot", el: more.parentElement, items: [more] });
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
    const g = groups.find((x) => x.type !== "search") || groups[0];
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
  const railButtons = () => [...document.querySelectorAll("#rail .rail-btn")].filter(visible);
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
  const onRail = () => !!(cur && cur.classList && cur.classList.contains("rail-btn"));
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
  const onBar = () => !!(cur && cur.classList && cur.classList.contains("p-icon") && cur.closest(".p-bottom"));
  const onTop = () => !!(cur && cur.closest && cur.closest("#player .p-top"));
  const barButtons = () => [...document.querySelectorAll("#player .p-bottom .p-icon")].filter(visible).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  let barReturn = null;
  function barMove(dir) {
    const btns = barButtons();
    if (!btns.length) return;
    const i = btns.indexOf(cur);
    if (i < 0) {
      setFocus(btns.find((b) => b.id === "pPlay") || btns[0]);
      return;
    }
    setFocus(btns[Math.max(0, Math.min(btns.length - 1, i + (dir === "right" ? 1 : -1)))]);
  }
  function barDown() {
    const btns = barButtons();
    if (!btns.length) {
      exitControls();
      return;
    }
    setFocus(btns.includes(barReturn) ? barReturn : btns.find((b) => b.id === "pPlay") || btns[0]);
  }
  function back() {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
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
    const openPicker = document.querySelector('.picker[data-open="true"]');
    if (openPicker) {
      const btn = openPicker.querySelector(".picker-btn");
      btn.click();
      setFocus(btn);
      return;
    }
    if (isShown("#detail")) {
      (_i = $("#detailClose")) == null ? void 0 : _i.click();
      cur = null;
      return;
    }
    if (isShown("#mDetail")) {
      (_j = $("#mDetailClose")) == null ? void 0 : _j.click();
      cur = null;
      return;
    }
    const sheetBack = document.querySelector("#app .sheet-back");
    if (sheetBack && visible(sheetBack)) {
      sheetBack.click();
      cur = null;
      return;
    }
    if (document.body.classList.contains("search-open")) $("#searchClose").click();
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
            if (onScrub()) seekBy(-10);
            else if (onBar()) barMove("left");
            else if (!onTop()) move("left");
            return;
          case 39:
            own();
            if (onScrub()) seekBy(10);
            else if (onBar()) barMove("right");
            else if (!onTop()) move("right");
            return;
          // Three rungs: the ‹ in the title bar, the scrubber, the buttons.
          // Up climbs, Down comes back to where it left — and Down from the
          // buttons leaves the bar altogether, which is the way in reversed.
          // From the scrubber, Up goes spatially so whatever floats above the
          // bar (a status action, the up-next toast) takes precedence over
          // the ‹ when something does.
          case 38:
            own();
            if (onScrub() || !onBar()) move("up");
            else {
              barReturn = cur;
              const s = $("#player .p-bottom .scrub");
              if (s && visible(s)) setFocus(s);
            }
            return;
          case 40:
            own();
            if (onScrub()) barDown();
            else if (onBar()) exitControls();
            else if (onTop()) {
              const s = $("#player .p-bottom .scrub");
              if (s && visible(s)) setFocus(s);
              else barDown();
            } else move("down");
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
        if (cur && document.contains(cur) && visible(cur) && cur.closest(".p-status, .up-next")) activate();
        else (_f = (_e = window.Player) == null ? void 0 : _e.togglePlay) == null ? void 0 : _f.call(_e);
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
  const watchPickers = () => {
    for (const box of document.querySelectorAll(".picker")) {
      if (box.__tvWatched) continue;
      box.__tvWatched = true;
      new MutationObserver(reanchor).observe(box, { attributes: true, attributeFilter: ["data-open"] });
    }
  };
  watchPickers();
  new MutationObserver(watchPickers).observe(document.body, { childList: true, subtree: true });
  if (appEl) new MutationObserver(() => {
    if (!cur || !document.contains(cur)) setTimeout(ensure, 60);
  }).observe(appEl, { childList: true, subtree: true });
  let wasSearch = document.body.classList.contains("search-open");
  new MutationObserver(() => {
    const on = document.body.classList.contains("search-open");
    if (on === wasSearch) return;
    wasSearch = on;
    if (!on) reanchor();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  setTimeout(ensure, 800);
  const railEl = $("#rail");
  if (railEl) railEl.addEventListener("click", (e) => {
    const b = e.target.closest(".rail-btn");
    if (!b) return;
    if (b.dataset.act === "search") {
      const box = $("#search");
      if (box) setFocus(box);
      return;
    }
    if (!b.dataset.nav) return;
    let tries = 0;
    const seek = setInterval(() => {
      const ready = document.querySelector("#heroCar .hero.active .hero-btn") || document.querySelector("#app .card");
      if (ready && visible(ready)) {
        clearInterval(seek);
        cur = null;
        browseDefault();
      } else if (++tries > 25) clearInterval(seek);
    }, 120);
  });
  window.TVNav = { ensure, setFocus };
})();
