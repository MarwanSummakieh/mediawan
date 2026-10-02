(function() {
  if (/[?&]tv=1/.test(location.search)) {
    try {
      localStorage.setItem("tv", "1");
    } catch {
    }
  }
  let savedTV = false;
  try {
    savedTV = localStorage.getItem("tv") === "1";
  } catch {
  }
  const TV = !!window.tizen || /[?&]tv=1/.test(location.search) || savedTV;
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
  const tvUnit = (pixels) => {
    var _a;
    const style = getComputedStyle(document.documentElement);
    const scale = Number((_a = style.getPropertyValue) == null ? void 0 : _a.call(style, "--tv-scale"));
    return pixels * (scale > 0 ? scale : 1);
  };
  const visible = (el) => {
    if (!el || el.disabled || el.closest('[aria-disabled="true"], fieldset[disabled]') || el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < tvUnit(2) || r.height < tvUnit(2)) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (el.closest(".p-drawer:not(.show)")) return false;
    return !el.closest(".hero:not(.active)");
  };
  const SEL = [
    'button, a[href], summary, input:not([type="hidden"]), select, textarea',
    '[role="button"], [role="link"], [tabindex]:not([tabindex="-1"]), [data-tv-scroll]',
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
    // The picker replaced the catalog filters (<select> drew its list in the
    // platform, where a D-pad cannot reach). Seasons skip the menu entirely and
    // stand as tabs beside the episodes.
    ".picker-btn",
    ".picker-opt",
    ".season-item",
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
    ".watch-menu .btn",
    ".watch-menu input",
    ".watch-lobby .btn",
    ".watch-lobby input",
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
    if (selectDialog) return selectDialog;
    if (isShown("#watchLobby")) return $("#watchLobby");
    const modal = [...document.querySelectorAll('[aria-modal="true"], .sports-modal .sports-dialog')].filter(visible).pop();
    if (modal) return modal;
    if (isShown("#player")) {
      const layer = playerLayer() || $("#player");
      const picker2 = layer.querySelector('.picker[data-open="true"] .picker-menu:not([hidden])');
      return picker2 && visible(picker2) ? picker2 : layer;
    }
    const context = isShown("#detail") ? $("#detail") : isShown("#mDetail") ? $("#mDetail") : document.body;
    const picker = context.querySelector('.picker[data-open="true"] .picker-menu:not([hidden])');
    if (picker && visible(picker)) return picker;
    const collection = $("#colMenu");
    if (collection && visible(collection)) return collection;
    const live = $(".sports-player");
    if (live) return live;
    if (isShown("#detail")) return $("#detail");
    if (isShown("#mDetail")) return $("#mDetail");
    return document.body;
  }
  function focusables() {
    return [...surface().querySelectorAll(SEL)].filter((el) => !el.matches(".skip-link") && visible(el));
  }
  let cur = null;
  let inControls = false;
  let editing = null;
  let selectDialog = null;
  let selectSource = null;
  let currentSurface = null;
  const memories = /* @__PURE__ */ new WeakMap();
  const textField = (el) => !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" && !/^(checkbox|radio|range|button|submit|reset|color|file|hidden)$/i.test(el.type));
  const identity = (el) => el.id ? "id:" + el.id : el.dataset.tvKey ? "key:" + el.dataset.tvKey : null;
  function finishEditing() {
    if (!editing) return;
    editing.classList.remove("tv-editing");
    editing.blur();
    editing = null;
  }
  function startEditing(el) {
    setFocus(el);
    editing = el;
    el.classList.add("tv-editing");
    el.focus();
    if (el.readOnly && el.select) el.select();
  }
  function clearFocus() {
    finishEditing();
    document.querySelectorAll(".tv-focus, .tv-focus-within").forEach((e) => {
      e.classList.remove("tv-focus", "tv-focus-within");
    });
    cur = null;
  }
  function setFocus(el, opts) {
    if (!el) return;
    const act = document.activeElement;
    if (editing && editing !== el) finishEditing();
    if (act && act !== el && act.blur) {
      act.blur();
      if (act.id === "search" && !act.value.trim()) document.body.classList.remove("search-open");
    }
    document.querySelectorAll(".tv-focus").forEach((e) => e.classList.remove("tv-focus"));
    document.querySelectorAll(".tv-focus-within").forEach((e) => e.classList.remove("tv-focus-within"));
    cur = el;
    currentSurface = surface();
    memories.set(currentSurface, { node: el, key: identity(el), rect: el.getBoundingClientRect() });
    el.classList.add("tv-focus");
    const card = el.closest(".card");
    if (card) card.classList.add("tv-focus-within");
    if (!opts || !opts.noScroll)
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    if (!textField(el) && el.tagName !== "SELECT") {
      if (!el.hasAttribute("tabindex") && !el.matches("button, a, input")) el.setAttribute("tabindex", "0");
      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus();
      }
    }
  }
  function ensure() {
    var _a, _b, _c, _d;
    const s = surface();
    if (s === currentSurface && cur && document.contains(cur) && visible(cur) && s.contains(cur)) return;
    const f = focusables();
    const memory = memories.get(s);
    const previousSurface = currentSurface;
    currentSurface = s;
    if (!(s === $("#player") && !inControls)) {
      const restored = memory && f.find((e) => e === memory.node || memory.key && identity(e) === memory.key);
      if (restored) {
        setFocus(restored);
        return;
      }
      if (memory && previousSurface === s && f.length) {
        const a = memory.rect;
        const nearby = f.filter((e) => !e.closest("#rail"));
        nearby.sort((x, y) => {
          const distance = (e) => {
            const b = e.getBoundingClientRect();
            return Math.abs(a.left - b.left) + Math.abs(a.top - b.top);
          };
          return distance(x) - distance(y);
        });
        if (nearby[0]) {
          setFocus(nearby[0]);
          return;
        }
      }
    }
    const marked = f.find((e) => e.matches(".srv-row.live, .p-menu-item.active, .p-drawer-ep.active, .picker-opt.active, .season-item.active"));
    if (marked) {
      setFocus(marked);
      return;
    }
    if (s === $("#player") && !playerLayer() && !inControls) {
      const act = f.find((e) => e.closest(".p-status, .up-next"));
      if (act) {
        setFocus(act);
        return;
      }
      clearFocus();
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
    const content = f.filter((e) => !e.closest("#rail"));
    setFocus(content.find((e) => e.classList.contains("card")) || content[0] || f[0]);
  }
  let anchorX = null;
  function move(dir) {
    ensure();
    if (!cur) return;
    const form = cur.closest("form");
    if (form && (dir === "up" || dir === "down")) {
      const fields = focusables().filter((el) => el.closest("form") === form);
      const index = fields.indexOf(cur);
      const direction = dir === "up" ? -1 : 1;
      for (let i = index + direction; index >= 0 && i >= 0 && i < fields.length; i += direction) {
        const sameLine = Math.abs(fields[i].getBoundingClientRect().top - cur.getBoundingClientRect().top) < tvUnit(18);
        if (textField(cur) || cur.tagName === "SELECT" || !sameLine) {
          setFocus(fields[i]);
          return;
        }
      }
    }
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
      if (forward <= tvUnit(2)) continue;
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
    if (textField(cur)) {
      startEditing(cur);
      return;
    }
    if (cur.tagName === "SELECT") {
      openSelect(cur);
      return;
    }
    if (cur.tagName === "INPUT" && cur.type === "range") {
      adjustRange(cur, 1);
      return;
    }
    cur.click();
  }
  function adjustRange(el, direction) {
    const min = Number(el.min || 0), max = Number(el.max || 100);
    const step = el.step === "any" ? (max - min) / 100 : Number(el.step || 1);
    const next = Math.max(min, Math.min(max, Number(el.value) + direction * step));
    if (next === Number(el.value)) return;
    el.value = String(Number(next.toFixed(6)));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function closeSelect() {
    const source = selectSource;
    if (selectDialog) selectDialog.parentElement.remove();
    selectDialog = null;
    selectSource = null;
    if (source && document.contains(source)) setFocus(source);
    else ensure();
  }
  function openSelect(source) {
    const cover = document.createElement("div");
    cover.className = "tv-select-overlay";
    const dialog = document.createElement("div");
    dialog.className = "tv-select-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const label = source.labels && source.labels[0];
    const labelText = label && [...label.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join(" ").trim();
    dialog.setAttribute("aria-label", source.getAttribute("aria-label") || labelText || "Choose an option");
    const title = document.createElement("h2");
    title.textContent = dialog.getAttribute("aria-label");
    dialog.appendChild(title);
    let selected = null;
    [...source.options].forEach((option, index) => {
      if (option.hidden) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tv-select-option";
      button.textContent = option.textContent;
      button.disabled = option.disabled || !!option.closest("optgroup[disabled]");
      button.setAttribute("aria-pressed", String(option.selected));
      if (option.selected) selected = button;
      button.addEventListener("click", () => {
        const changed = source.selectedIndex !== index;
        source.selectedIndex = index;
        closeSelect();
        if (changed) {
          source.dispatchEvent(new Event("input", { bubbles: true }));
          source.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      dialog.appendChild(button);
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.className = "tv-select-option";
    cancel.addEventListener("click", closeSelect);
    dialog.appendChild(cancel);
    cover.appendChild(dialog);
    document.body.appendChild(cover);
    selectSource = source;
    selectDialog = dialog;
    setFocus(selected && visible(selected) ? selected : focusables()[0]);
  }
  document.addEventListener("focusin", (event) => {
    const el = event.target;
    if (!el.matches || !el.matches(SEL) || el.matches(".skip-link") || !visible(el) || !surface().contains(el)) return;
    if (cur !== el) setFocus(el);
    if (textField(el) && !editing) {
      editing = el;
      el.classList.add("tv-editing");
    }
  });
  let lastContent = null;
  function gridLines(grid) {
    const out = [];
    let line = null, top = null;
    for (const c of grid.querySelectorAll(".card")) {
      if (!visible(c)) continue;
      if (top === null || Math.abs(c.offsetTop - top) > tvUnit(4)) {
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
      const items = [...row.querySelectorAll(".card")].filter(visible);
      if (items.length) groups.push({ type: "row", el: row, items });
    }
    for (const grid of document.querySelectorAll(".cards-grid")) groups.push(...gridLines(grid));
    const more = $("#catMore");
    if (more && more.offsetHeight > 0) groups.push({ type: "foot", el: more.parentElement, items: [more] });
    const grouped = groups.reduce((all, group) => all.concat(group.items), []);
    const extra = focusables().filter((el) => !el.closest("#rail, #searchbar") && !grouped.some((item) => item === el || item.contains(el)));
    for (const el of extra) {
      const y = el.getBoundingClientRect().top;
      const row = groups.find((g) => g.type === "actions" && Math.abs(g.y - y) < tvUnit(18));
      if (row) row.items.push(el);
      else groups.push({ type: "actions", el, items: [el], y });
    }
    groups.forEach((g, index) => {
      g.order = index;
    });
    const groupTop = (g) => (g.type === "grid" || g.type === "actions" ? g.items[0] : g.el).getBoundingClientRect().top;
    groups.sort((a, b) => groupTop(a) - groupTop(b) || a.order - b.order);
    groups.forEach((g) => {
      if (g.type === "actions") g.items.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    });
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
    setFocus(item, { noScroll: group.type !== "actions" });
    if (group.type === "row") {
      const t = item.offsetLeft - tvUnit(8);
      group.el.scrollLeft = Math.max(0, Math.min(t, group.el.scrollWidth - group.el.clientWidth));
    }
    if (group.type === "hero") {
      window.scrollTo(0, 0);
      return;
    }
    const cont = group.type === "actions" ? item : group.type === "row" ? group.el.closest(".row") || group.el : group.type === "grid" ? item : group.el;
    const y = window.pageYOffset + cont.getBoundingClientRect().top;
    window.scrollTo(0, Math.max(0, y - tvUnit(group.type === "grid" ? 210 : 150)));
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
    if (!pos) return false;
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
  function topMove(dir) {
    const buttons = [...$("#player .p-top").querySelectorAll(SEL)].filter(visible).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const index = buttons.indexOf(cur);
    if (index >= 0) setFocus(buttons[Math.max(0, Math.min(buttons.length - 1, index + (dir === "right" ? 1 : -1)))]);
  }
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
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m;
    if (editing) {
      finishEditing();
      return;
    }
    if (selectDialog) {
      closeSelect();
      return;
    }
    const s = surface();
    const close = s.querySelector("[data-close-modal], #watchLobbyClose");
    if (s.matches('[aria-modal="true"], .sports-dialog') && close) {
      close.click();
      ensure();
      return;
    }
    const openPicker = s.closest('.picker[data-open="true"]');
    if (openPicker && s.classList.contains("picker-menu")) {
      const btn = openPicker.querySelector(".picker-btn");
      btn.click();
      setFocus(btn);
      return;
    }
    if (s.id === "colMenu") {
      if (window.closeCollections) window.closeCollections();
      else s.hidden = true;
      setFocus($("#actCol"));
      return;
    }
    if (isShown("#player")) {
      const layer = playerLayer();
      if (layer) {
        const sub = layer.id === "settingsMenu" && layer.querySelector("[data-sub]:not([hidden])");
        if (sub && sub.dataset.sub !== "root") (_b = (_a = window.Player) == null ? void 0 : _a.gotoSub) == null ? void 0 : _b.call(_a, "root");
        else if (layer.classList.contains("p-drawer")) (_d = (_c = window.Player) == null ? void 0 : _c.closeDrawer) == null ? void 0 : _d.call(_c);
        else (_f = (_e = window.Player) == null ? void 0 : _e.hideMenus) == null ? void 0 : _f.call(_e);
        cur = null;
        setTimeout(ensure, SETTLE_MS);
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
    if (s.classList.contains("sports-player")) {
      const liveBack = s.querySelector("[data-close-player]");
      if (liveBack) liveBack.click();
      else (_j = (_i = window.MediawanSports) == null ? void 0 : _i.closePlayer) == null ? void 0 : _j.call(_i);
      ensure();
      return;
    }
    if (isShown("#detail")) {
      (_k = $("#detailClose")) == null ? void 0 : _k.click();
      cur = null;
      return;
    }
    if (isShown("#mDetail")) {
      (_l = $("#mDetailClose")) == null ? void 0 : _l.click();
      cur = null;
      return;
    }
    const sheetBack = document.querySelector("#app .sheet-back");
    if (sheetBack && visible(sheetBack)) {
      sheetBack.click();
      cur = null;
      return;
    }
    if (document.body.classList.contains("search-open")) {
      $("#searchClose").click();
      ensure();
      return;
    }
    const home = !$("#app") && document.querySelector('a[href="/"], a[href="/login.html"]');
    if (home && visible(home)) {
      home.click();
      return;
    }
    if (location.pathname !== "/") {
      const fallback = location.pathname.startsWith("/sports/") ? "/sports" : "/";
      if (window.goBack) window.goBack(fallback);
      else (_m = window.nav) == null ? void 0 : _m.call(window, fallback);
    }
  }
  document.addEventListener("keydown", (e) => {
    var _a, _b, _c, _d, _e, _f;
    const codes = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 10009, BrowserBack: 10009 };
    const k = codes[e.key] || e.keyCode;
    const own = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (k === 10009 || k === 27 || k === 8 && !editing) {
      own();
      back();
      return;
    }
    if (editing) {
      if (k === 13) {
        own();
        const wasSearch2 = editing.id === "search";
        finishEditing();
        if (wasSearch2) setTimeout(() => {
          const hit = [...document.querySelectorAll("#app .card")].filter(visible)[0];
          if (hit) setFocus(hit);
          else ensure();
        }, 450);
        return;
      }
      if (k === 38 || k === 40) finishEditing();
      else return;
    }
    ensure();
    if ((k === 37 || k === 39) && (cur == null ? void 0 : cur.tagName) === "INPUT" && cur.type === "range") {
      own();
      adjustRange(cur, k === 37 ? -1 : 1);
      return;
    }
    if ((cur == null ? void 0 : cur.hasAttribute("data-tv-scroll")) && k >= 37 && k <= 40) {
      const horizontal = k === 37 || k === 39;
      const pos = horizontal ? cur.scrollLeft : cur.scrollTop;
      const max = horizontal ? cur.scrollWidth - cur.clientWidth : cur.scrollHeight - cur.clientHeight;
      const step = Math.max(tvUnit(80), (horizontal ? cur.clientWidth : cur.clientHeight) * 0.7);
      const next = Math.max(0, Math.min(max, pos + (k === 37 || k === 38 ? -step : step)));
      if (next !== pos && max > 0) {
        own();
        if (horizontal) cur.scrollLeft = next;
        else cur.scrollTop = next;
        return;
      }
    }
    const activeSurface = surface();
    const player2 = isShown("#player") && (activeSurface === $("#player") || activeSurface === playerLayer());
    if (player2) {
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
            else if (onTop()) topMove("left");
            else move("left");
            return;
          case 39:
            own();
            if (onScrub()) seekBy(10);
            else if (onBar()) barMove("right");
            else if (onTop()) topMove("right");
            else move("right");
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
        own();
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
    const go = (dir) => {
      if (onBrowse()) {
        if (onRail()) return railMove(dir);
        if (browseMove(dir)) return;
      }
      move(dir);
    };
    switch (k) {
      case 37:
        own();
        go("left");
        break;
      case 39:
        own();
        go("right");
        break;
      // Up/Down leave the field: setFocus blurs it, so the highlight and the
      // DOM focus move TOGETHER — splitting them is what trapped the remote.
      case 38:
        own();
        go("up");
        break;
      case 40:
        own();
        go("down");
        break;
      case 13:
        own();
        activate();
        break;
    }
  }, true);
  const SETTLE_MS = 320;
  let anchorTimer = null;
  const reanchor = () => {
    clearTimeout(anchorTimer);
    anchorTimer = setTimeout(ensure, 60);
  };
  const player = $("#player");
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
  new MutationObserver((records) => {
    if (records.some((record) => record.type === "childList" || record.attributeName !== "class" || !cur || !visible(cur) || surface() !== currentSurface)) reanchor();
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "hidden", "disabled", "aria-disabled", "aria-hidden", "data-open"]
  });
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
      if (box) startEditing(box);
      return;
    }
    if (!b.dataset.nav && !["schedule", "random"].includes(b.dataset.act)) return;
    let tries = 0;
    const seek = setInterval(() => {
      const ready = [...$("#app").querySelectorAll(SEL)].find(visible);
      if (ready) {
        clearInterval(seek);
        memories.delete(document.body);
        cur = null;
        if (!browseDefault()) setFocus(ready);
      } else if (++tries > 25) clearInterval(seek);
    }, 120);
  });
  window.TVNav = {
    ensure,
    setFocus,
    move,
    activate,
    back,
    focusables,
    surface,
    unit: tvUnit,
    get current() {
      return cur;
    }
  };
})();
