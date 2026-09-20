(() => {
  "use strict";
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const $ = (s) => document.querySelector(s);
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (t) => new Date(t).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  const priorities = ["premier-league", "la-liga", "bundesliga", "champions-league", "europa-league", "nfl", "nhl"];
  let catalog = null, host = null, options = null, view = "", generation = 0, language = "preferred", query = "", limit = 48, guideDay = 0, guideHour = null, showEmpty = false, playerFocus = null;
  let follows = new Set(priorities), saved = /* @__PURE__ */ new Set(), key = "", refreshTimer = null, guideTimer = null, modalFocus = null;
  let player = null, hls = null, beat = null, playGeneration = 0, playQueue = Promise.resolve(), recoveries = 0;
  const now = () => Date.now();
  const media = (url) => (window.API_BASE || "") + url;
  async function api(url, init) {
    const res = await fetch(url, init);
    let data;
    try {
      data = await res.json();
    } catch {
      data = { error: "The server returned an unreadable response." };
    }
    if (!res.ok) throw Error(data.error || "Request failed. Try again.");
    return data;
  }
  const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const comp = (id) => catalog.competitions.find((c) => c.id === id);
  const channel = (id) => catalog.channels.find((c) => c.id === id);
  const current = (c) => (c.programmes || []).find((p) => p.start <= now() && p.end > now()) || null;
  const upcoming = (c) => (c.programmes || []).filter((p) => p.start > now());
  const channelComp = (c) => Array.from(new Set(c.competitions.concat((c.programmes || []).filter((p) => p.end > now()).reduce((all, p) => all.concat(p.competitions), []))));
  const nav = (url) => options.nav(url);
  const link = (url, label, cls = "") => `<a class="${cls}" href="${esc(url)}" data-sports-nav="${esc(url)}">${label}</a>`;
  function savePrefs() {
    try {
      localStorage.setItem(key, JSON.stringify({ follows: Array.from(follows), saved: Array.from(saved), language }));
    } catch {
    }
  }
  function filteredChannels() {
    let list = catalog.channels.slice();
    if (view.startsWith("competition/")) {
      const id = view.split("/")[1];
      list = list.filter((c) => channelComp(c).includes(id));
    } else if (view === "football") list = list.filter((c) => channelComp(c).some((id) => {
      var _a;
      return ((_a = comp(id)) == null ? void 0 : _a.sport) === "Football";
    }) || /football|futbol|voetbal|calcio|soccer/i.test(c.name));
    else if (["nfl", "nhl"].includes(view)) list = list.filter((c) => channelComp(c).includes(view));
    if (language !== "preferred" && language !== "all") list = list.filter((c) => c.language === language);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((c) => `${c.name} ${c.language} ${c.region} ${channelComp(c).map((id) => {
      var _a;
      return (_a = comp(id)) == null ? void 0 : _a.name;
    }).join(" ")} ${(c.programmes || []).map((p) => p.title).join(" ")}`.toLowerCase().includes(q));
    return list.sort((a, b) => {
      if (language === "preferred") {
        const lang = catalog.preferredLanguage || "English";
        const d = Number(b.language === lang) - Number(a.language === lang);
        if (d) return d;
      }
      return Number(saved.has(b.id)) - Number(saved.has(a.id)) || a.name.localeCompare(b.name);
    });
  }
  function title() {
    var _a;
    if (view.startsWith("competition/")) return ((_a = comp(view.split("/")[1])) == null ? void 0 : _a.name) || "Competition";
    return { football: "Football", nfl: "NFL", nhl: "NHL", guide: "TV guide", channels: "All channels" }[view] || "Sports";
  }
  function tabs() {
    return `<nav class="sports-tabs" aria-label="Sports navigation">${[["", "For you"], ["football", "Football"], ["nfl", "NFL"], ["nhl", "NHL"], ["guide", "TV guide"], ["channels", "All channels"]].map(([id, label]) => link("/sports" + (id ? "/" + id : ""), label, view === id ? "selected" : "")).join("")}</nav>`;
  }
  function toolbar() {
    return `<div class="sports-tools"><label class="sports-search"><span class="sr-only">Search channels, competitions and programmes</span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input id="sports-search" type="search" placeholder="Channels, competitions, programmes" value="${esc(query)}" autocomplete="off"></label>
    <label class="sports-language"><span>Commentary</span><select id="sports-language" aria-label="Commentary language filter"><option value="preferred" ${language === "preferred" ? "selected" : ""}>${esc(catalog.preferredLanguage === "All" ? "All languages" : (catalog.preferredLanguage || "English") + " first")}</option><option value="all" ${language === "all" ? "selected" : ""}>All languages</option>${catalog.languages.map((l) => `<option ${l === language ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label></div>`;
  }
  function competitionTile(c) {
    const count = catalog.channels.filter((ch) => channelComp(ch).includes(c.id)).length;
    return `<article class="competition-tile" style="--competition:${c.color}">${link("/sports/competition/" + c.id, `<span class="competition-mark" aria-hidden="true">${c.code}</span><strong>${esc(c.name)}</strong><span>${count} channels</span>`)}<button class="competition-follow ${follows.has(c.id) ? "following" : ""}" data-follow="${c.id}" aria-label="${follows.has(c.id) ? "Unfollow" : "Follow"} ${esc(c.name)}" aria-pressed="${follows.has(c.id)}">${follows.has(c.id) ? "\u2713" : "+"}</button></article>`;
  }
  function competitionRail() {
    let list = catalog.competitions;
    if (view === "football") list = list.filter((c) => c.sport === "Football");
    else if (["nfl", "nhl"].includes(view)) return "";
    list = list.slice().sort((a, b) => Number(follows.has(b.id)) - Number(follows.has(a.id)));
    return `<section class="sports-section"><div class="sports-section-head"><h2>${view === "football" ? "Football competitions" : "Your competitions"}</h2><span>Follow with +</span></div><div class="competition-rail">${list.map(competitionTile).join("")}</div></section>`;
  }
  function logo(c) {
    return `<span class="channel-logo"><span aria-hidden="true">${esc(c.name.replace(/^[^:]+:\s*/, "").slice(0, 2).toUpperCase())}</span>${c.logo ? `<img src="${esc(c.logo)}" alt="" loading="lazy" onerror="this.hidden=true">` : ""}</span>`;
  }
  function channelCard(c) {
    const p = current(c);
    const percentage = p ? Math.max(0, Math.min(100, (now() - p.start) / (p.end - p.start) * 100)) : 0;
    return `<article class="sports-channel"><button class="channel-watch" data-watch="${c.id}" aria-label="Watch ${esc(c.name)}, ${esc(c.language)}"><div class="channel-art">${logo(c)}<span class="channel-quality">${esc(c.quality)}</span><span class="channel-play" aria-hidden="true">\u25B6</span></div>
    <span class="channel-line"><strong>${esc(c.name)}</strong></span><span class="channel-meta" title="Language inferred from ${esc(c.languageSource)}">${esc(c.language)} \xB7 ${esc(c.region)}</span>
    <span class="channel-programme">${esc(p && !p.generic ? p.title : "No programme listing")}</span>${p ? `<span class="channel-progress"><i style="width:${percentage}%"></i></span><span class="channel-times">${clock(p.start)} \u2014 ${clock(p.end)}</span>` : ""}</button>
    <button class="channel-save ${saved.has(c.id) ? "saved" : ""}" data-save="${c.id}" aria-label="${saved.has(c.id) ? "Remove" : "Save"} ${esc(c.name)}" aria-pressed="${saved.has(c.id)}">${saved.has(c.id) ? "\u2605" : "\u2606"}</button>
    <button class="channel-details" data-details="${c.id}" aria-label="Guide and details for ${esc(c.name)}">Guide <span aria-hidden="true">\u2197</span></button></article>`;
  }
  function programmes(channels, future = false) {
    const results = /* @__PURE__ */ new Map();
    for (const c of channels) {
      const slots = future ? upcoming(c).filter((p) => p.start < now() + 36 * 36e5) : [current(c)].filter(Boolean);
      for (const p of slots) {
        if (p.generic) continue;
        const id = p.title.trim().toLowerCase() + "|" + p.start;
        let item = results.get(id);
        if (!item) {
          item = { ...p, channels: [] };
          results.set(id, item);
        }
        item.channels.push(c);
      }
    }
    return Array.from(results.values()).sort((a, b) => a.start - b.start).slice(0, future ? 16 : 12);
  }
  function programmeCard(p) {
    const c = p.channels[0], competition = comp(p.competitions[0]), on = p.start <= now() && p.end > now();
    return `<article class="event-card" style="--competition:${(competition == null ? void 0 : competition.color) || "#315c50"}"><button ${on ? `data-watch="${c.id}"` : `data-details="${c.id}"`} aria-label="${on ? "Watch" : "View guide for"} ${esc(p.title)}">
    <div class="event-art"><span class="event-label ${on ? "on-now" : ""}">${on ? "On now" : day(p.start) + " \xB7 " + clock(p.start)}</span><span class="event-code" aria-hidden="true">${esc((competition == null ? void 0 : competition.code) || "TV")}</span><span>${esc((competition == null ? void 0 : competition.name) || c.name)}</span></div>
    <strong>${esc(p.title)}</strong><span class="event-meta">${esc(c.language)}${p.channels.length > 1 ? " \xB7 " + p.channels.length + " channel options" : " \xB7 " + esc(c.name)}</span>${on ? `<span class="event-time">Until ${clock(p.end)}</span>` : ""}</button></article>`;
  }
  function programmeRail(label, items) {
    return items.length ? `<section class="sports-section"><div class="sports-section-head"><h2>${label}</h2>${link("/sports/guide", 'Open guide <span aria-hidden="true">\u2197</span>')}</div><div class="events-rail">${items.map(programmeCard).join("")}</div></section>` : "";
  }
  function channelRail(label, channels, url) {
    return channels.length ? `<section class="sports-section"><div class="sports-section-head"><h2>${esc(label)}</h2>${url ? link(url, 'See all <span aria-hidden="true">\u2197</span>') : ""}</div><div class="sports-channel-rail">${channels.slice(0, 12).map(channelCard).join("")}</div></section>` : "";
  }
  function hero(channels) {
    const selected = comp(view.split("/")[1] || (["nfl", "nhl"].includes(view) ? view : "premier-league")) || catalog.competitions[0];
    const relevant = channels.filter((c) => channelComp(c).includes(selected.id));
    const event = programmes(relevant).find((p) => !p.replay);
    return `<section class="sports-hero" style="--competition:${selected.color}"><div class="sports-hero-copy"><span class="sports-eyebrow">${event ? "On now \xB7 " + esc(selected.name) : esc(selected.sport)}</span><h2>${esc(event ? event.title : selected.name)}</h2>
      <div class="sports-hero-meta">${event ? esc(event.channels[0].name) + " \xB7 " + esc(event.channels[0].language) + " \xB7 Until " + clock(event.end) : relevant.length + " channels \xB7 " + Array.from(new Set(relevant.map((c) => c.language))).length + " commentary languages"}</div>
      <div class="sports-hero-actions">${event ? `<button class="sports-button primary" data-watch="${event.channels[0].id}">\u25B6 Watch channel</button>` : link("/sports/competition/" + selected.id, "Explore " + esc(selected.name), "sports-button primary")}${link("/sports/guide", "TV guide", "sports-button secondary")}</div></div>
      <div class="sports-hero-art" aria-hidden="true"><div class="pitch-lines"><i></i><b></b></div><span class="hero-competition-code">${selected.code}</span><span class="hero-competition-name">${esc(selected.name)}</span></div></section>`;
  }
  function guideHtml(channels) {
    const today = /* @__PURE__ */ new Date();
    today.setHours(0, 0, 0, 0);
    today.setDate(today.getDate() + guideDay);
    const date = today.valueOf();
    const start = guideHour === null && guideDay === 0 ? Math.floor(now() / 18e5) * 18e5 : new Date(today).setHours(guideHour === null ? 12 : guideHour), end = start + 6 * 36e5;
    const rows = channels.filter((c) => showEmpty || (c.programmes || []).some((p) => !p.generic && p.end > date && p.start < date + 864e5));
    return `<section class="sports-guide"><div class="guide-controls"><div><button data-guide-day="-1" aria-label="Previous day" ${guideDay === 0 ? "disabled" : ""}>\u2039</button><strong>${guideDay === 0 ? "Today" : day(date)}</strong><button data-guide-day="1" aria-label="Next day" ${guideDay === 7 ? "disabled" : ""}>\u203A</button></div><label><input type="checkbox" id="guide-empty" ${showEmpty ? "checked" : ""}> Include channels without listings</label></div>
    <div class="guide-controls"><label>Start time <select id="guide-hour">${Array.from({ length: 24 }, (_, hour) => `<option value="${hour}" ${hour === new Date(start).getHours() ? "selected" : ""}>${String(hour).padStart(2, "0")}:00</option>`).join("")}</select></label><button class="sports-button secondary" data-guide-now>Now</button></div>
    <p class="guide-coverage">${catalog.guide.informativeChannels || 0} of ${catalog.channels.length} channels have detailed programme listings. Times are shown in your local time.</p>
    ${rows.length ? `<div class="guide-scroll" tabindex="0" aria-label="Channel schedule; scroll horizontally for later programmes"><div class="guide-grid"><div class="guide-axis"><strong>Channel</strong><div>${Array.from({ length: 12 }, (_, i) => `<span>${clock(start + i * 18e5)}</span>`).join("")}</div></div>${rows.slice(0, limit).map((c) => {
      const slots = (c.programmes || []).filter((p) => p.end > start && p.start < end);
      return `<div class="guide-row"><button class="guide-channel" data-watch="${c.id}">${logo(c)}<span><strong>${esc(c.name)}</strong><small>${esc(c.language)}</small></span></button><div class="guide-lane">${slots.length ? slots.map((p) => {
        const left = Math.max(0, (p.start - start) / (end - start) * 100), width = Math.min(100, (p.end - start) / (end - start) * 100) - left;
        return `<button class="guide-programme ${p.start <= now() && p.end > now() ? "current" : ""}" data-details="${c.id}" style="left:${left}%;width:${width}%" title="${esc(p.title)} \xB7 ${clock(p.start)}\u2013${clock(p.end)}"><strong>${esc(p.generic ? "No programme details" : p.title)}</strong><span>${clock(p.start)} \u2013 ${clock(p.end)}</span></button>`;
      }).join("") : '<span class="guide-no-listing">No listing supplied for this time</span>'}</div></div>`;
    }).join("")}</div></div>` : '<div class="sports-empty"><h2>No guide listings for this selection</h2><p>You can still watch channels from All channels. Another language may have more listings.</p>' + link("/sports/channels", "Browse channels", "sports-button secondary") + "</div>"}
    ${rows.length > limit ? '<button class="sports-button secondary sports-load" data-more>Show more channels</button>' : ""}</section>`;
  }
  function content() {
    const channels = filteredChannels();
    let html = "";
    if (!catalog.channels.length) return `<div class="sports-empty"><h2>Add your live channels</h2><p>Import an M3U playlist to build your sports library.</p>${options.user.role === "admin" ? '<button class="sports-button primary" data-settings>Import playlist</button>' : "<p>Your administrator can add a playlist.</p>"}</div>`;
    if (view === "guide") return guideHtml(channels);
    if (view === "channels" || query.trim()) return `<section class="sports-section"><div class="sports-section-head"><h2>${query ? "Search results" : "Channels"}</h2><span>${channels.length} channels</span></div>${channels.length ? `<div class="sports-channel-grid">${channels.slice(0, limit).map(channelCard).join("")}</div>` : '<div class="sports-empty"><h2>No channels match</h2><p>Try another language or search term.</p></div>'}${channels.length > limit ? '<button class="sports-button secondary sports-load" data-more>Show more channels</button>' : ""}</section>`;
    html += hero(channels);
    if (!view || view === "football") html += competitionRail();
    html += programmeRail("On now", programmes(channels));
    if (!view) {
      html += channelRail("Your saved channels", channels.filter((c) => saved.has(c.id)), "/sports/channels");
      for (const id of Array.from(follows).slice(0, 9)) {
        const c = comp(id);
        if (c) html += channelRail(c.name, channels.filter((ch) => channelComp(ch).includes(id)), "/sports/competition/" + id);
      }
      html += programmeRail("Coming up", programmes(channels, true));
      html += channelRail("More sports channels", channels.filter((c) => !channelComp(c).length), "/sports/channels");
    } else {
      html += programmeRail("Coming up", programmes(channels, true));
      if (!channels.length) html += `<div class="sports-empty"><h2>No channels linked yet</h2><p>A channel appears here when its playlist or guide names this competition. You can browse all channels${options.user.role === "admin" ? " or assign a competition in channel details" : ""}.</p>${link("/sports/channels", "All channels", "sports-button secondary")}</div>`;
      else html += `<section class="sports-section"><div class="sports-section-head"><h2>Channels</h2><span>${channels.length} options</span></div><div class="sports-channel-grid">${channels.slice(0, limit).map(channelCard).join("")}</div>${channels.length > limit ? '<button class="sports-button secondary sports-load" data-more>Show more channels</button>' : ""}</section>`;
    }
    return html;
  }
  function paint() {
    if (!host || !catalog || !location.pathname.startsWith("/sports")) return;
    const selected = view.startsWith("competition/") ? comp(view.split("/")[1]) : null;
    host.innerHTML = `<div class="sports-page"><header class="sports-heading"><div>${selected ? link("/sports", 'Sports <span aria-hidden="true">/</span>', "sports-breadcrumb") : ""}<h1>${esc(title())}</h1></div><div>${selected ? `<button class="sports-button secondary" data-follow="${selected.id}">${follows.has(selected.id) ? "\u2713 Following" : "+ Follow competition"}</button>` : ""}${options.user.role === "admin" ? '<button class="sports-settings" data-settings>Manage live TV</button>' : ""}</div></header>${tabs()}${toolbar()}<div id="sports-content">${content()}</div>${catalog.guide.status === "stale" || catalog.guide.status === "unavailable" ? '<p class="sports-guide-warning" role="status">The guide could not be refreshed. Channels remain available; some listings may be outdated.</p>' : ""}</div>`;
    host.querySelector("#sports-search").addEventListener("input", (e) => {
      query = e.target.value;
      limit = 48;
      $("#sports-content").innerHTML = content();
    });
    host.querySelector("#sports-language").addEventListener("change", (e) => {
      language = e.target.value;
      limit = 48;
      savePrefs();
      $("#sports-content").innerHTML = content();
    });
    document.title = title() + " \xB7 Mediawan";
  }
  async function refresh() {
    var _a;
    const gen = generation;
    try {
      const next = await api("/api/live/catalog");
      if (gen !== generation) return;
      catalog = next;
      if (!((_a = $("#sports-search")) == null ? void 0 : _a.matches(":focus")) && !$(".sports-modal")) paint();
    } catch {
    }
  }
  async function render(target, opts) {
    generation++;
    const gen = generation;
    host = target;
    options = opts;
    view = location.pathname.slice("/sports".length).replace(/^\//, "");
    limit = 48;
    query = "";
    guideDay = 0;
    guideHour = null;
    const nextKey = "mediawan-sports:" + opts.user.email;
    if (key !== nextKey) {
      key = nextKey;
      try {
        const prefs = JSON.parse(localStorage.getItem(key) || "{}");
        follows = new Set(prefs.follows || priorities);
        saved = new Set(prefs.saved || []);
        language = prefs.language || "preferred";
      } catch {
      }
    }
    if (catalog) paint();
    else host.innerHTML = '<div class="sports-page"><h1>Sports</h1><div class="loading" role="status">Loading your sports library\u2026</div></div>';
    try {
      const data = await api("/api/live/catalog");
      if (gen !== generation) return;
      catalog = data;
      paint();
    } catch (e) {
      if (gen === generation) host.innerHTML = `<div class="sports-page sports-empty"><h1>Sports unavailable</h1><p>${esc(e.message)}</p><button class="sports-button primary" data-sports-retry>Retry</button></div>`;
    }
    clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, 5 * 6e4);
  }
  function leave() {
    generation++;
    clearInterval(refreshTimer);
    clearTimeout(guideTimer);
    refreshTimer = null;
    closeModal();
    closePlayer();
    host = null;
  }
  function openModal(label, html) {
    closeModal();
    modalFocus = document.activeElement;
    const box = document.createElement("div");
    box.className = "sports-modal";
    box.innerHTML = `<section class="sports-dialog" role="dialog" aria-modal="true" aria-label="${esc(label)}"><header><h2>${esc(label)}</h2><button class="sports-dialog-close" data-close-modal aria-label="Close dialog">\xD7</button></header>${html}</section>`;
    document.body.appendChild(box);
    box.querySelector("button").focus();
  }
  function closeModal() {
    var _a;
    const m = $(".sports-modal");
    if (m) {
      m.remove();
      (_a = modalFocus == null ? void 0 : modalFocus.focus) == null ? void 0 : _a.call(modalFocus);
    }
    modalFocus = null;
  }
  function details(id) {
    const c = channel(id);
    if (!c) return;
    openModal(c.name, `<div class="channel-detail-heading">${logo(c)}<div><p>${esc(c.language)} \xB7 ${esc(c.region)} \xB7 ${esc(c.quality)}</p><small>Language from ${esc(c.languageSource)}. Actual commentary can vary by programme.</small></div></div><button class="sports-button primary" data-watch="${id}">\u25B6 Watch channel</button>
      <h3>Programme guide</h3><div class="channel-schedule">${(c.programmes || []).length ? c.programmes.filter((p) => p.end > now()).slice(0, 22).map((p) => `<div class="channel-slot"><time>${day(p.start)}<br>${clock(p.start)}\u2013${clock(p.end)}</time><div><strong>${esc(p.title)}</strong>${p.subtitle ? `<span>${esc(p.subtitle)}</span>` : ""}${p.start <= now() && p.end > now() ? '<span class="slot-current">On now</span>' : ""}</div></div>`).join("") : '<p class="sports-muted">No programme listings were supplied for this channel.</p>'}</div>
      ${options.user.role === "admin" ? `<button class="sports-button secondary" data-edit-channel="${id}">Edit competition, language or guide</button>` : ""}`);
  }
  async function settings() {
    openModal("Live TV settings", '<p class="sports-muted" role="status">Loading settings\u2026</p>');
    try {
      const s = await api("/api/admin/live");
      if (!$(".sports-modal")) return;
      openModal("Live TV settings", `<div class="live-summary"><strong>${s.channels} channels</strong><span>${s.guide.listedChannels} with upcoming listings</span><span>${s.maxConnections} upstream connection${s.maxConnections === 1 ? "" : "s"}</span></div>
      <form id="live-import-form"><h3>Playlist</h3><label for="live-import-file">M3U file</label><input id="live-import-file" type="file" accept=".m3u,.m3u8,audio/x-mpegurl" required><p class="sports-muted">Replaces the channel list. Provider addresses stay on the server.</p><button class="sports-button primary" type="submit">Import playlist</button></form>
      <form id="live-guide-form"><h3>Programme guide</h3><p class="sports-muted">${esc(s.guide.configured ? "A guide source is configured. Enter another URL only to replace it." : "Add an XMLTV URL to provide programme listings.")}</p><label for="live-guide-url">XMLTV URL</label><input id="live-guide-url" type="url" placeholder="https://\u2026" autocomplete="off"><label for="live-default-language">Default commentary order</label><select id="live-default-language">${["English", "Arabic", "All"].map((l) => `<option ${l === s.preferredLanguage ? "selected" : ""}>${l}</option>`).join("")}</select><div class="sports-form-actions"><button class="sports-button secondary" type="submit">Save settings</button><button class="sports-button secondary" type="button" data-refresh-guide>Refresh guide</button></div><p class="sports-muted">${s.guide.updatedAt ? "Last refreshed " + day(s.guide.updatedAt) + " at " + clock(s.guide.updatedAt) : "No guide refresh completed yet."}</p></form><p class="sports-form-feedback" id="live-settings-feedback" role="status"></p>`);
    } catch (e) {
      const d = $(".sports-dialog");
      if (d) d.insertAdjacentHTML("beforeend", `<p role="alert">${esc(e.message)}</p>`);
    }
  }
  async function editChannel(id) {
    const c = channel(id);
    openModal("Edit " + c.name, `<form id="live-channel-form" data-channel="${id}"><label for="live-channel-language">Commentary language</label><input id="live-channel-language" value="${esc(c.language)}" maxlength="50"><fieldset><legend>Competitions</legend><div class="competition-checks">${catalog.competitions.map((x) => `<label><input name="competition" type="checkbox" value="${x.id}" ${c.competitions.includes(x.id) ? "checked" : ""}>${esc(x.name)}</label>`).join("")}</div></fieldset><label for="live-guide-search">Find guide channel</label><input id="live-guide-search" type="search" placeholder="Channel name"><div id="live-guide-matches"></div><label for="live-channel-guide">Guide channel ID</label><input id="live-channel-guide" value="${esc(c.guideId || "")}" maxlength="200"><button class="sports-button primary" type="submit">Save channel</button><p id="live-settings-feedback" role="status"></p></form>`);
  }
  function feedback(message, bad = false) {
    const el = $("#live-settings-feedback");
    if (el) {
      el.textContent = message;
      el.classList.toggle("error", bad);
    }
  }
  function playerMarkup(c) {
    return `<section class="sports-player" role="dialog" aria-modal="true" aria-label="Live TV player"><header><button data-close-player aria-label="Close live player">\u2190 Back</button><div><span class="live-dot">LIVE TV</span><strong id="live-playing-name">${esc(c.name)}</strong></div><button data-player-fullscreen aria-label="Full screen">\u26F6</button></header><div class="sports-player-layout"><div class="live-video-wrap"><video id="sports-video" controls autoplay playsinline></video><div class="live-player-status" id="live-player-status" role="status">Connecting to channel\u2026</div><button class="sports-button secondary live-retry" data-retry-player hidden>Retry channel</button></div><aside class="live-player-sidebar"><h2>Watching</h2><div id="live-playing-programme"></div><div class="live-player-actions"><button class="sports-button secondary" data-jump-live>Jump to live</button><button class="sports-button secondary" data-toggle-live>Play / pause</button></div><label for="live-player-language">Commentary language</label><select id="live-player-language"><option value="all">All languages</option>${catalog.languages.map((l) => `<option ${l === c.language ? "selected" : ""}>${esc(l)}</option>`).join("")}</select><h3>Switch channel</h3><div class="live-channel-switch" id="live-channel-switch"></div></aside></div></section>`;
  }
  function playerStatus(message, retry = false) {
    const el = $("#live-player-status");
    if (el) {
      el.textContent = message;
      el.hidden = !message;
    }
    const r = $("[data-retry-player]");
    if (r) r.hidden = !retry;
  }
  function paintSwitch(c) {
    const selector = $("#live-player-language");
    if (!selector) return;
    const ids = channelComp(c);
    let list = catalog.channels.filter((x) => (selector.value === "all" || x.language === selector.value) && (!ids.length || channelComp(x).some((id) => ids.includes(id))));
    if (!list.length) list = catalog.channels.filter((x) => selector.value === "all" || x.language === selector.value);
    $("#live-channel-switch").innerHTML = list.slice(0, 100).map((x) => `<button class="${x.id === c.id ? "playing" : ""}" data-watch="${x.id}"><strong>${esc(x.name)}</strong><span>${esc(x.language)} \xB7 ${esc(x.quality)}</span></button>`).join("");
    const p = current(c);
    $("#live-playing-programme").innerHTML = `<strong>${esc(p && !p.generic ? p.title : c.name)}</strong><p>${esc(c.language)} \xB7 ${esc(c.quality)}${p ? " \xB7 Until " + clock(p.end) : ""}</p>${(p == null ? void 0 : p.description) ? `<p class="sports-muted">${esc(p.description.slice(0, 350))}</p>` : ""}`;
    $("#live-playing-name").textContent = c.name;
  }
  async function releasePlayer() {
    clearInterval(beat);
    beat = null;
    if (hls) {
      hls.destroy();
      hls = null;
    }
    const v = $("#sports-video");
    if (v) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    const old = player;
    player = null;
    if (old) await fetch(`/api/live/session/${old.sessionId}/${old.viewerId}`, { method: "DELETE", keepalive: true }).catch(() => {
    });
  }
  function closePlayer() {
    playGeneration++;
    void releasePlayer();
    const box = $(".sports-player");
    if (box) {
      box.remove();
      document.body.classList.remove("live-player-open");
      if (playerFocus == null ? void 0 : playerFocus.isConnected) playerFocus.focus();
    }
  }
  function watch(id) {
    const c = channel(id);
    if (!c) return;
    closeModal();
    const gen = ++playGeneration;
    if (!$(".sports-player")) {
      playerFocus = document.activeElement;
      document.body.insertAdjacentHTML("beforeend", playerMarkup(c));
      document.body.classList.add("live-player-open");
      $("[data-close-player]").focus();
    }
    $(".sports-player").dataset.channel = id;
    playerStatus("Connecting to channel\u2026");
    paintSwitch(c);
    playQueue = playQueue.then(async () => {
      var _a;
      await releasePlayer();
      if (gen !== playGeneration) return;
      let result;
      try {
        result = await api("/api/live/play", json("POST", { channelId: id }));
      } catch (e) {
        if (gen === playGeneration) {
          playerStatus(e.message, true);
          $(".sports-player").dataset.channel = id;
        }
        return;
      }
      if (gen !== playGeneration) {
        await fetch(`/api/live/session/${result.sessionId}/${result.viewerId}`, { method: "DELETE" }).catch(() => {
        });
        return;
      }
      player = { ...result, channelId: id };
      $(".sports-player").dataset.channel = id;
      const v = $("#sports-video");
      recoveries = 0;
      const url = media(result.playUrl);
      let progressAt = Date.now(), lastTime = 0, stallRecoveries = 0;
      const ready = () => v.play().catch(() => playerStatus("Press play to watch this channel."));
      v.ontimeupdate = () => {
        if (v.currentTime > lastTime + 0.2) {
          progressAt = Date.now();
          lastTime = v.currentTime;
        }
      };
      v.onplaying = () => playerStatus("");
      v.onwaiting = () => {
        if (!v.paused) playerStatus("Buffering live channel\u2026");
      };
      v.onerror = () => playerStatus("Playback interrupted. Retry or choose another channel.", true);
      if ((_a = window.Hls) == null ? void 0 : _a.isSupported()) {
        hls = new Hls({ liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 7, maxBufferLength: 20, maxMaxBufferLength: 30, backBufferLength: 8 });
        hls.loadSource(url);
        hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED, ready);
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (!d.fatal) return;
          console.warn("[live-tv]", d.details);
          if (recoveries++ < 3 && hls) {
            if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
              playerStatus("Reconnecting\u2026");
              hls.startLoad();
            } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
            else playerStatus("Playback interrupted. Try another channel.", true);
          } else playerStatus("This channel stopped responding. Retry or choose another channel.", true);
        });
      } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
        v.src = url;
        v.onloadedmetadata = ready;
      } else playerStatus("This browser cannot play live HLS video.", true);
      beat = setInterval(async () => {
        if (!player) return;
        if (!v.paused && Date.now() - progressAt > 1e4) {
          if (stallRecoveries++ < 3) {
            const edge = (hls == null ? void 0 : hls.liveSyncPosition) || (v.seekable.length ? v.seekable.end(v.seekable.length - 1) - 2 : 0);
            if (edge > v.currentTime + 0.5) v.currentTime = edge;
            hls == null ? void 0 : hls.startLoad();
            progressAt = Date.now();
          } else playerStatus("This channel stopped responding. Retry or choose another channel.", true);
        }
        try {
          const r = await fetch(`/api/live/session/${player.sessionId}/${player.viewerId}/heartbeat`, { method: "POST" });
          if (r.status === 410) playerStatus("The live session ended. Retry to reconnect.", true);
        } catch {
        }
      }, 1e4);
    }).catch(() => playerStatus("Live playback failed. Retry the channel.", true));
  }
  document.addEventListener("click", (e) => {
    var _a, _b;
    const a = e.target.closest("[data-sports-nav]");
    if (a) {
      e.preventDefault();
      nav(a.dataset.sportsNav);
      return;
    }
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-follow")) {
      const id = b.dataset.follow;
      follows.has(id) ? follows.delete(id) : follows.add(id);
      savePrefs();
      paint();
    } else if (b.hasAttribute("data-save")) {
      const id = b.dataset.save;
      saved.has(id) ? saved.delete(id) : saved.add(id);
      savePrefs();
      paint();
    } else if (b.hasAttribute("data-watch")) watch(b.dataset.watch);
    else if (b.hasAttribute("data-details")) details(b.dataset.details);
    else if (b.hasAttribute("data-settings")) void settings();
    else if (b.hasAttribute("data-close-modal")) closeModal();
    else if (b.hasAttribute("data-close-player")) closePlayer();
    else if (b.hasAttribute("data-more")) {
      limit += 48;
      $("#sports-content").innerHTML = content();
    } else if (b.hasAttribute("data-guide-day")) {
      guideDay = Math.min(7, Math.max(0, guideDay + Number(b.dataset.guideDay)));
      $("#sports-content").innerHTML = content();
    } else if (b.hasAttribute("data-guide-now")) {
      guideDay = 0;
      guideHour = null;
      $("#sports-content").innerHTML = content();
    } else if (b.hasAttribute("data-sports-retry")) render(host, options);
    else if (b.hasAttribute("data-edit-channel")) editChannel(b.dataset.editChannel);
    else if (b.hasAttribute("data-guide-id")) $("#live-channel-guide").value = b.dataset.guideId;
    else if (b.hasAttribute("data-refresh-guide")) {
      b.disabled = true;
      feedback("Refreshing programme guide\u2026");
      api("/api/admin/live/refresh", { method: "POST" }).then((d) => {
        feedback(d.guide.error || "Guide refreshed.", !!d.guide.error);
        return refresh();
      }).catch((e2) => feedback(e2.message, true)).finally(() => {
        b.disabled = false;
      });
    } else if (b.hasAttribute("data-retry-player")) watch($(".sports-player").dataset.channel);
    else if (b.hasAttribute("data-player-fullscreen")) {
      const box = $(".sports-player");
      if (document.fullscreenElement) (_a = document.exitFullscreen) == null ? void 0 : _a.call(document);
      else (_b = box.requestFullscreen) == null ? void 0 : _b.call(box);
    } else if (b.hasAttribute("data-jump-live")) {
      const v = $("#sports-video");
      if (v) {
        v.currentTime = (hls == null ? void 0 : hls.liveSyncPosition) || (v.seekable.length ? v.seekable.end(v.seekable.length - 1) - 1 : v.currentTime);
        v.play().catch(() => {
        });
      }
    } else if (b.hasAttribute("data-toggle-live")) {
      const v = $("#sports-video");
      if (v) v.paused ? v.play().catch(() => {
      }) : v.pause();
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "guide-hour") {
      guideHour = Number(e.target.value);
      $("#sports-content").innerHTML = content();
    }
    if (e.target.id === "guide-empty") {
      showEmpty = e.target.checked;
      $("#sports-content").innerHTML = content();
    }
    if (e.target.id === "live-player-language") {
      const c = channel($(".sports-player").dataset.channel || (player == null ? void 0 : player.channelId));
      if (c) paintSwitch(c);
    }
  });
  document.addEventListener("input", (e) => {
    if (e.target.id !== "live-guide-search") return;
    clearTimeout(guideTimer);
    const q = e.target.value;
    guideTimer = setTimeout(async () => {
      try {
        const d = await api("/api/admin/live/guide-channels?q=" + encodeURIComponent(q));
        const box = $("#live-guide-matches");
        if (box) box.innerHTML = d.channels.slice(0, 12).map((c) => `<button type="button" data-guide-id="${esc(c.id)}">${esc(c.names[0] || c.id)} <small>${esc(c.id)}</small></button>`).join("");
      } catch {
      }
    }, 300);
  });
  document.addEventListener("submit", async (e) => {
    if (!["live-import-form", "live-guide-form", "live-channel-form"].includes(e.target.id)) return;
    e.preventDefault();
    const button = e.target.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      if (e.target.id === "live-import-form") {
        const file = $("#live-import-file").files[0];
        if (!file || file.size > 12 * 1024 * 1024) throw Error("Choose an M3U file smaller than 12 MB.");
        feedback("Importing channels and checking guide availability\u2026");
        const text = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          r.readAsText(file);
        });
        const d = await api("/api/admin/live/import", { method: "POST", headers: { "Content-Type": "text/plain" }, body: text });
        feedback(`Imported ${d.channels} channels. The programme guide is refreshing.`);
      }
      if (e.target.id === "live-guide-form") {
        const data = { preferredLanguage: $("#live-default-language").value };
        if ($("#live-guide-url").value.trim()) data.guideUrl = $("#live-guide-url").value.trim();
        await api("/api/admin/live/settings", json("PATCH", data));
        feedback("Settings saved.");
      }
      if (e.target.id === "live-channel-form") {
        await api("/api/admin/live/channels/" + e.target.dataset.channel, json("PATCH", { language: $("#live-channel-language").value, guideId: $("#live-channel-guide").value, competitions: Array.from(e.target.querySelectorAll('input[name="competition"]:checked')).map((e2) => e2.value) }));
        feedback("Channel updated.");
      }
      catalog = await api("/api/live/catalog");
      paint();
    } catch (error) {
      feedback(error.message || "The file could not be read.", true);
    } finally {
      button.disabled = false;
    }
  });
  document.addEventListener("keydown", (e) => {
    const modal = $(".sports-modal"), live = $(".sports-player"), surface = modal || live;
    if (!surface) return;
    if (e.key === "Escape" || e.keyCode === 10009) {
      e.preventDefault();
      e.stopImmediatePropagation();
      modal ? closeModal() : closePlayer();
      return;
    }
    if (e.key === "Tab") {
      const items = Array.from(surface.querySelectorAll("button:not([disabled]),input,select,video,a[href]")).filter((e2) => !e2.hidden && e2.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    if (live && !modal && (e.code === "Space" || e.key === "MediaPlayPause" || e.keyCode === 10252) && !["INPUT", "SELECT", "BUTTON"].includes(e.target.tagName)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const v = $("#sports-video");
      v.paused ? v.play().catch(() => {
      }) : v.pause();
    }
  }, true);
  window.addEventListener("pagehide", () => {
    if (player) navigator.sendBeacon(media(`/api/live/session/${player.sessionId}/${player.viewerId}/stop`), "");
  });
  window.MediawanSports = { render, leave, closePlayer, closeModal };
})();
