(() => {
  // public/core.js
  var $ = (selector) => document.querySelector(selector);
  var esc = (value) => String(value == null ? "" : value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
  async function api(url, body, method) {
    const response = await fetch(url, {
      method: method || (body ? "POST" : "GET"),
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : void 0
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed");
    return data;
  }
  var toastTimer;
  function toast(message) {
    $("#toast").textContent = message;
    $("#toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $("#toast").hidden = true, 5e3);
  }
  var restoreFocus;
  function modal(html) {
    restoreFocus = document.activeElement;
    $("#dialog-content").innerHTML = html;
    if (!$("#dialog").open) {
      if ($("#dialog").showModal) $("#dialog").showModal();
      else $("#dialog").setAttribute("open", "");
    }
    setTimeout(() => {
      var _a;
      return (_a = $("#dialog-content").querySelector("button,input,select")) == null ? void 0 : _a.focus();
    }, 0);
  }
  function closeModal() {
    if ($("#dialog").close) $("#dialog").close();
    else $("#dialog").removeAttribute("open");
    restoreFocus == null ? void 0 : restoreFocus.focus();
  }
  var episodeLabel = (item) => (item == null ? void 0 : item.episode) ? item.season ? `S${item.season} \xB7 E${item.episode}` : `Episode ${item.episode}` : "Movie";
  var progress = (state) => (state == null ? void 0 : state.duration) ? `<progress class="progress" aria-label="Watch progress" value="${Math.min(state.position, state.duration)}" max="${state.duration}"></progress>` : "";
  function poster(title) {
    const url = String(title.poster || "");
    return /^https?:\/\//.test(url) ? `<img src="${esc(url)}" alt="" loading="lazy">` : `<div class="poster-placeholder">${esc(title.name)}</div>`;
  }
  function card(title, mode = "library") {
    const item = mode === "resume" ? title.resumable : mode === "next" ? title.next : null;
    const remaining = (item == null ? void 0 : item.state.duration) ? `${Math.ceil(Math.max(0, item.state.duration - item.state.position) / 60)} min left` : "";
    return `<article class="card"><a class="poster" href="#/title/${esc(title.id)}" aria-label="Open ${esc(title.name)}">${poster(title)}${item ? `<span class="badge">${esc(episodeLabel(item))}</span>` : title.readyCount ? '<span class="badge">Downloaded</span>' : ""}</a>${item ? progress(item.state) : ""}<a class="card-name" href="#/title/${esc(title.id)}">${esc(title.name)}</a><p class="meta">${esc(item ? mode === "resume" ? remaining : item.name : [title.year, title.kind === "movie" ? "Movie" : title.kind === "anime" ? "Anime" : "Series"].filter(Boolean).join(" \xB7 "))}</p>${item ? `<div class="resume-actions"><button class="card-action ${mode === "resume" ? "primary" : ""}" data-action="${item.available ? "play" : "release"}" data-item="${esc(item.id)}" data-title="${esc(title.id)}">${item.available ? mode === "resume" ? "Resume" : "Play next" : "Not downloaded"}</button>${mode === "resume" ? `<button class="menu-button" data-action="resume-menu" data-title="${esc(title.id)}" data-item="${esc(item.id)}" aria-label="More actions for ${esc(title.name)}">\u2022\u2022\u2022</button>` : ""}</div>` : ""}</article>`;
  }
  function heading(name, caption = "", action2 = "") {
    return `<header class="page-heading"><div><h1>${esc(name)}</h1>${caption ? `<p>${esc(caption)}</p>` : ""}</div>${action2}</header>`;
  }
  var empty = (name, description, action2 = "") => `<div class="empty"><h2>${esc(name)}</h2><p>${esc(description)}</p>${action2}</div>`;

  // public/metadata.js
  function durationLabel(seconds) {
    if (!(seconds > 0)) return "Runtime unavailable";
    if (seconds < 60) return `${Math.round(seconds)} sec`;
    const minutes = Math.round(seconds / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}` : `${minutes} min`;
  }
  function itemRuntime(item) {
    return `${durationLabel(item.durationSeconds)}${item.durationSource === "file" ? " \xB7 Local file" : item.durationSource === "estimate" ? " \xB7 Estimated" : item.durationSeconds ? " \xB7 Catalog" : ""}`;
  }
  function metadataHtml(title) {
    var _a, _b, _c;
    const movie = title.kind === "movie";
    const runtime = movie && ((_a = title.items[0]) == null ? void 0 : _a.durationSeconds) ? itemRuntime(title.items[0]) : `${durationLabel(title.runtimeSeconds)}${!movie && title.runtimeSeconds ? " per episode \xB7 Typical" : ""}`;
    const facts = [
      runtime,
      title.imdbRating ? `IMDb ${title.imdbRating}/10` : "",
      title.anilistRating ? `AniList ${title.anilistRating}/100` : "",
      (_b = title.status) == null ? void 0 : _b.replace(/_/g, " ")
    ];
    const fields = [
      ["Released", (_c = title.released) == null ? void 0 : _c.slice(0, 10)],
      ["Director", title.directors],
      ["Writers", title.writers],
      ["Cast", title.cast],
      ["Country", title.country],
      ["Language", title.language],
      ["Network", title.network],
      ["Studio", title.studios],
      ["Awards", title.awards]
    ];
    const rows = fields.map(([name, value]) => {
      const text = Array.isArray(value) ? value.join(", ") : value;
      return text ? `<div><dt>${name}</dt><dd>${esc(text)}</dd></div>` : "";
    }).join("");
    const trailers = (title.trailers || []).filter((t) => /^[\w-]{11}$/.test(t.id)).map(
      (t, i) => `<a href="https://www.youtube.com/watch?v=${esc(t.id)}" target="_blank" rel="noopener noreferrer">${esc(t.name)} ${i + 1}</a>`
    ).join(" \xB7 ");
    const source2 = /^tt\d+$/.test(title.external_id) ? `<a href="https://www.imdb.com/title/${esc(title.external_id)}/" target="_blank" rel="noopener noreferrer">IMDb</a> \xB7 Cinemeta` : title.kind === "anime" && /^\d+$/.test(title.external_id) ? `<a href="https://anilist.co/anime/${esc(title.external_id)}" target="_blank" rel="noopener noreferrer">AniList</a>` : "";
    const tvmaze = Number.isInteger(title.tvmazeId) ? ` \xB7 Episode data: <a href="https://www.tvmaze.com/shows/${title.tvmazeId}" target="_blank" rel="noopener noreferrer">TVmaze</a> (<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA</a>)` : "";
    return `<p class="runtime-facts">${facts.filter(Boolean).map(esc).join(" \xB7 ")}</p><details class="metadata-details"><summary>Cast &amp; details</summary><dl class="metadata-list">${rows}</dl>${trailers ? `<p class="meta">${trailers}</p>` : ""}<p class="meta">${source2}${tvmaze}</p><button class="quiet" data-action="refresh-metadata">Refresh metadata</button></details>`;
  }
  function episodeMetadata(item) {
    var _a;
    const file = item.fileInfo;
    const technical = file ? [
      file.width && file.height ? `${file.width} \xD7 ${file.height}` : "",
      (_a = file.video) == null ? void 0 : _a.toUpperCase(),
      file.bytes ? `${(file.bytes / 1073741824).toFixed(2)} GiB` : "",
      ...(file.audio || []).map(
        (a) => {
          var _a2;
          return `${a.language} ${(_a2 = a.codec) == null ? void 0 : _a2.toUpperCase()}${a.channels ? ` ${a.channels}ch` : ""}`;
        }
      ),
      (file.subtitles || []).length ? `Subtitles: ${[...new Set(file.subtitles.map((s) => s.language))].join(", ")}` : ""
    ].filter(Boolean).join(" \xB7 ") : "";
    return `<p class="episode-runtime">${esc(itemRuntime(item))}</p>${item.description ? `<details class="episode-description"><summary>Synopsis</summary><p class="muted">${esc(item.description)}</p></details>` : ""}${technical ? `<details class="episode-description"><summary>File details</summary><p class="meta">${esc(technical)}</p></details>` : ""}`;
  }

  // public/torrents.js
  async function downloadSeason(title, season) {
    modal("<h2>Checking season\u2026</h2>");
    $("#dialog-content").onclick = null;
    try {
      const path = `/api/titles/${title.id}/seasons/${season}/downloads`;
      const data = await api(path);
      if (!$("#dialog").open) return;
      const count = (state) => data.items.filter((item) => item.state === state).length;
      const label = title.kind === "anime" && !season ? "all episodes" : season ? `season ${season}` : "specials";
      const enabled = data.torrentConfigured || data.debridConfigured;
      $("#dialog-content").innerHTML = `<h2>Download ${esc(label)}</h2>
      <p>${count("pending")} episodes to download${count("downloaded") ? ` \xB7 ${count("downloaded")} already downloaded` : ""}${count("already_queued") ? ` \xB7 ${count("already_queued")} already queued` : ""}${count("unreleased") ? ` \xB7 ${count("unreleased")} not released` : ""}</p>
      ${data.active ? '<p>This season is already being queued.</p><button id="season-view" class="primary">View downloads</button>' : `<form id="season-download-form" class="form">
      <label>Download with<select name="provider"><option value="realdebrid" ${!data.debridConfigured ? "disabled" : ""} ${data.debridConfigured ? "selected" : ""}>Real-Debrid</option><option value="torrent" ${!data.torrentConfigured ? "disabled" : ""} ${!data.debridConfigured && data.torrentConfigured ? "selected" : ""}>Direct torrent \xB7 qBittorrent</option></select></label>
      <label>Quality<select name="resolution">${data.resolutions.map((resolution) => `<option value="${resolution}" ${resolution === (data.resolutions.includes(1080) ? 1080 : data.resolutions[0]) ? "selected" : ""}>${resolution === 2160 ? "4K" : resolution + "p"}</option>`).join("")}</select></label>
      <p class="meta">Chooses a matching release for each episode. Downloaded and queued episodes are skipped. Unavailable episodes appear in Downloads.</p>
      <p id="season-provider-note" class="meta"></p>
      ${!enabled ? '<p class="error">No download provider is configured.</p>' : ""}
      <button class="primary" ${!enabled || !count("pending") ? "disabled" : ""}>Download ${count("pending")} episodes</button><p id="season-error" class="error" role="alert"></p></form>`}`;
      if (data.active) {
        $("#season-view").onclick = () => {
          closeModal();
          location.hash = "/downloads";
        };
        return;
      }
      const form = $("#season-download-form");
      const providerNote = () => {
        $("#season-provider-note").textContent = form.elements.provider.value === "torrent" ? "Torrent rules apply. Episodes sharing an existing torrent may need a separate release or Real-Debrid." : "Downloads original episode files through Real-Debrid.";
      };
      form.elements.provider.onchange = providerNote;
      providerNote();
      form.onsubmit = async (event) => {
        event.preventDefault();
        const submit = form.querySelector("button");
        if (submit.disabled) return;
        submit.disabled = true;
        $("#season-error").textContent = "";
        try {
          await api(path, {
            provider: form.elements.provider.value,
            resolution: Number(form.elements.resolution.value)
          });
          closeModal();
          toast("Season download queued");
          location.hash = "/downloads";
        } catch (error) {
          submit.disabled = false;
          $("#season-error").textContent = error.message;
        }
      };
    } catch (error) {
      if ($("#dialog").open)
        $("#dialog-content").innerHTML = `<h2>Season unavailable</h2><p class="error">${esc(error.message)}</p>`;
    }
  }
  function seasonDownloadRow(batch) {
    const count = (state) => batch.items.filter((item) => item.state === state).length;
    const active2 = ["queued", "finding"].includes(batch.state);
    const unavailable = batch.items.filter((item) => item.state === "unavailable");
    const label = batch.season ? `Season ${batch.season}` : "Episodes";
    return `<div class="row"><div class="row-main"><h3>${esc(batch.name)} \xB7 ${label}</h3>
    <p class="meta">${batch.resolution === 2160 ? "4K" : batch.resolution + "p"} \xB7 ${batch.provider === "torrent" ? "Direct torrent" : "Real-Debrid"} \xB7 ${active2 ? `Finding releases (${batch.items.length - count("pending")}/${batch.items.length})` : batch.state === "stopped" ? "Queueing stopped" : "Queueing finished"}</p>
    <p class="meta">${count("queued")} queued${count("downloaded") ? ` \xB7 ${count("downloaded")} downloaded` : ""}${count("already_queued") ? ` \xB7 ${count("already_queued")} already queued` : ""}${count("unreleased") ? ` \xB7 ${count("unreleased")} not released` : ""}${!active2 && count("pending") ? ` \xB7 ${count("pending")} not queued` : ""}</p>
    ${batch.error ? `<p class="error">${esc(batch.error)}</p>` : ""}
    ${unavailable.length ? `<details><summary>${unavailable.length} unavailable</summary>${unavailable.map((item) => `<p class="error">Episode ${esc(item.episode)}: ${esc(item.error)}</p>`).join("")}</details>` : ""}
    ${active2 ? '<p class="meta">Stopping queueing leaves existing downloads running.</p>' : ""}</div>
    <div class="actions">${active2 ? `<button data-action="season-stop" data-id="${esc(batch.id)}">Stop queueing</button>` : ""}<button data-action="download-title" data-title="${esc(batch.title_id)}">Open title</button></div></div>`;
  }
  async function releases(itemId) {
    modal("<h2>Finding releases\u2026</h2>");
    $("#dialog-content").onclick = null;
    try {
      const data = await api(`/api/items/${itemId}/releases`);
      if (!$("#dialog").open) return;
      let provider = data.torrentConfigured ? "torrent" : "realdebrid", rejected = false;
      const render = () => {
        const direct = provider === "torrent";
        const items = data.items.map((r, index) => ({ ...r, index })).filter((r) => !direct || r.accepted || rejected);
        if (direct)
          items.sort(
            (a, b) => Number(b.accepted) - Number(a.accepted) || (b.seeders || 0) - (a.seeders || 0)
          );
        $("#dialog-content").innerHTML = `<h2>Choose a release</h2><label>Download with<select id="release-provider"><option value="torrent" ${direct ? "selected" : ""} ${!data.torrentConfigured ? "disabled" : ""}>Direct torrent \xB7 qBittorrent</option><option value="realdebrid" ${!direct ? "selected" : ""} ${!data.debridConfigured ? "disabled" : ""}>Real-Debrid</option></select></label>
        <p class="meta">${direct ? `At least ${data.rules.minSeeders} reported seeders \xB7 ${data.rules.resolutions.map((n) => n + "p").join(" / ")} \xB7 ${data.rules.movieMaxGB} GB movies / ${data.rules.episodeMaxGB} GB episodes. Counts may be stale; live progress is checked after selection. Direct torrents connect this PC to peers.` : "Download the original file through Real-Debrid."}</p>
        ${direct ? `<label class="check"><input id="show-rejected" type="checkbox" ${rejected ? "checked" : ""}>Show filtered releases (${data.items.filter((r) => !r.accepted).length})</label>` : ""}
        ${items.map((r) => `<button class="release" data-release="${r.index}" ${direct && !r.accepted ? "disabled" : ""}>${esc(r.label)}${direct ? `<span class="meta">${r.accepted ? "Meets search rules" : esc(r.reasons.join(" \xB7 "))}</span>` : ""}</button>`).join("")}
        ${!items.length ? "<p>No releases meet these rules. Review the filtered results or adjust Torrent rules in Settings.</p>" : ""}`;
        $("#release-provider").onchange = (e) => {
          provider = e.target.value;
          render();
        };
        if ($("#show-rejected"))
          $("#show-rejected").onchange = (e) => {
            rejected = e.target.checked;
            render();
          };
      };
      render();
      $("#dialog-content").onclick = async (e) => {
        const button2 = e.target.closest("[data-release]");
        if (!button2 || button2.disabled) return;
        button2.disabled = true;
        try {
          await api(`/api/items/${itemId}/download`, {
            ...data.items[Number(button2.dataset.release)],
            provider
          });
          closeModal();
          toast("Download queued");
          location.hash = "/downloads";
        } catch (error) {
          button2.disabled = false;
          toast(error.message);
        }
      };
    } catch (error) {
      $("#dialog-content").innerHTML = `<h2>Releases unavailable</h2><p class="error">${esc(error.message)}</p>`;
    }
  }
  function downloadRow(j) {
    const action2 = (label, operation) => `<button data-action="download-action" data-id="${esc(j.id)}" data-operation="${operation}">${label}</button>`;
    const direct = j.provider === "torrent";
    let controls = "";
    if (j.state === "ready" || j.state === "evicted" || j.retryable === false)
      controls = `<button data-action="download-title" data-title="${esc(j.titleId)}">Open title</button>`;
    else if (["failed", "cancelled"].includes(j.state)) controls = action2("Retry", "retry");
    else if (j.state === "paused") controls = action2("Resume", "resume") + action2("Cancel", "cancel");
    else if (j.state === "stopping") controls = '<span class="meta">Stopping\u2026</span>';
    else controls = (direct ? action2("Pause", "pause") : "") + action2("Cancel", "cancel");
    const state = j.state === "checking" ? "Finding peers and checking files" : j.state === "evicted" ? "Removed to free storage" : j.state === "preparing" ? "Checking with Real-Debrid" : j.state;
    return `<div class="row"><div class="row-main"><h3>${esc(j.name)}${j.episode ? ` \xB7 Episode ${j.episode}` : ""}</h3><p class="meta">${direct ? "Direct torrent" : "Real-Debrid"} \xB7 ${esc(state)}${j.total ? ` \xB7 ${Math.round(100 * j.bytes / j.total)}% \xB7 ${(j.total / 1073741824).toFixed(1)} GB` : ""}</p>
    ${direct && j.seeders != null ? `<p class="meta">${j.seeders} connected seeders \xB7 ${j.peers} other peers \xB7 ${(j.speed / 1048576).toFixed(1)} MB/s${j.availability != null && j.availability >= 0 ? ` \xB7 ${j.availability.toFixed(2)} copies available` : ""}</p>` : ""}
    ${j.total ? `<progress class="progress" value="${j.bytes}" max="${j.total}" aria-label="Download progress"></progress>` : ""}${j.error ? `<p class="error">${esc(j.error)}</p>` : ""}</div><div class="actions">${controls}</div></div>`;
  }
  function torrentRulesForm(admin) {
    if (!admin) return "";
    const r = admin.torrentRules;
    const fields = [
      ["minSeeders", "Minimum reported seeders", 0, 1e4, 1],
      ["movieMaxGB", "Maximum movie size (GB)", 0.1, 1e3, 0.1],
      ["episodeMaxGB", "Maximum episode size (GB)", 0.1, 1e3, 0.1],
      ["metadataMinutes", "Metadata timeout (minutes)", 1, 30, 1],
      ["stallMinutes", "No-progress timeout (minutes)", 1, 120, 1],
      ["maxConcurrent", "Concurrent downloads", 1, 4, 1],
      ["uploadKBps", "Upload limit per torrent (KB/s)", 16, 102400, 1],
      ["seedRatio", "Stop seeding at ratio", 0, 10, 0.1],
      ["seedMinutes", "Or after seeding (minutes)", 0, 1440, 1]
    ];
    return `<section class="section"><form id="torrent-rules" class="form"><h2>Torrent rules</h2><p class="meta">qBittorrent: ${admin.torrentConfigured ? "Configured" : "Not configured"}. Rules apply to new jobs and retries. Existing jobs keep their saved rules. CAM / TS / screeners are always excluded.</p>${fields.map(([key, label, min, max, step]) => `<label>${label}<input type="number" name="${key}" min="${min}" max="${max}" step="${step}" required value="${r[key]}"></label>`).join("")}
    <fieldset><legend>Accepted resolutions</legend>${[480, 720, 1080, 2160].map((n) => `<label class="check"><input type="checkbox" name="resolutions" value="${n}" ${r.resolutions.includes(n) ? "checked" : ""}>${n === 2160 ? "2160p / 4K" : n + "p"}</label>`).join("")}</fieldset>
    <label class="check"><input type="checkbox" name="rejectUnknown" ${r.rejectUnknown ? "checked" : ""}>Reject unknown seed count, size or resolution</label><p class="meta">Timeouts stop the selected torrent and retain partial data. They never choose another release automatically. Uploads can continue until the ratio or time limit is reached.</p><button class="primary">Save torrent rules</button><button type="button" id="torrent-health">Test connection</button><p id="torrent-status" role="status"></p></form></section>`;
  }
  function bindTorrentRules() {
    const form = $("#torrent-rules");
    if (!form) return;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = new FormData(form), payload = {};
      for (const [key, value] of data)
        if (!["resolutions", "rejectUnknown"].includes(key)) payload[key] = Number(value);
      payload.resolutions = data.getAll("resolutions").map(Number);
      payload.rejectUnknown = data.has("rejectUnknown");
      try {
        await api("/api/admin/torrent-rules", payload, "PUT");
        toast("Torrent rules saved");
      } catch (error) {
        toast(error.message);
      }
    };
    $("#torrent-health").onclick = async () => {
      try {
        const result = await api("/api/admin/torrent-health");
        $("#torrent-status").textContent = `Connected to qBittorrent ${result.version}`;
      } catch (error) {
        $("#torrent-status").textContent = error.message;
      }
    };
  }

  // public/playback-time.js
  function clockTime(value) {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    const minutes = Math.floor(seconds / 60);
    return `${minutes >= 60 ? `${Math.floor(minutes / 60)}:` : ""}${String(minutes % 60).padStart(minutes >= 60 ? 2 : 1, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }
  function playbackPosition(currentTime, offset, duration) {
    return Math.min(duration || Infinity, Math.max(0, (Number(currentTime) || 0) + offset));
  }
  function seekPlan(target, duration, offset, converting, ranges) {
    const position = Math.max(0, Math.min(Number(target) || 0, Math.max(0, duration - 0.1)));
    const relative = position - offset;
    const available = ranges.some(([start, end]) => relative >= start && relative < end);
    return { position, relative, restart: converting && !available };
  }
  function atTitleEnd(position, duration) {
    return duration > 0 && position >= duration - 2;
  }

  // public/player.js
  var active = null;
  var queue = null;
  var hls = null;
  var conversion = null;
  var timer = null;
  var countdown = null;
  var loading = false;
  var scrubbing = false;
  var video = () => $("#video");
  var icons = {
    back: '<path d="m14 5-7 7 7 7"/>',
    play: '<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M7 5h3v14H7zm7 0h3v14h-3z" fill="currentColor" stroke="none"/>',
    rewind: '<path d="M4 8a9 9 0 1 1-1 7M4 3v5h5"/><text x="12" y="16" text-anchor="middle" font-size="9" font-family="sans-serif" fill="currentColor" stroke="none">10</text>',
    forward: '<path d="M20 8a9 9 0 1 0 1 7M20 3v5h-5"/><text x="12" y="16" text-anchor="middle" font-size="9" font-family="sans-serif" fill="currentColor" stroke="none">10</text>',
    volume: '<path d="M11 4 6 8H3v8h3l5 4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    muted: '<path d="M11 4 6 8H3v8h3l5 4Zm5 5 5 6m0-6-5 6"/>',
    fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
    exitFullscreen: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>',
    previous: '<path d="M6 5v14m12-14L8 12l10 7Z"/>',
    next: '<path d="M18 5v14M6 5l10 7-10 7Z"/>',
    queue: '<path d="M4 6h16M4 12h10M4 18h10m4-5 4 3-4 3Z"/>',
    chapters: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m4-10h4m-4 4h4"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="#171918"/><circle cx="15" cy="17" r="3" fill="#171918"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>'
  };
  function iconButton(id, icon, label, shortcut = "") {
    const button2 = $("#" + id);
    if (button2.dataset.icon !== icon) {
      button2.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icons[icon]}</svg>`;
      button2.dataset.icon = icon;
    }
    button2.setAttribute("aria-label", label);
    button2.title = shortcut ? `${label} (${shortcut})` : label;
  }
  var controlsTimer = null;
  var keyboardControls = false;
  function showControls() {
    $("#player").classList.remove("controls-idle");
    $("#player").classList.toggle("keyboard-controls", keyboardControls);
    clearTimeout(controlsTimer);
    if (!active || video().paused || loading || keyboardControls || !$("#player-settings").hidden)
      return;
    controlsTimer = setTimeout(() => {
      if (video().paused || loading || scrubbing || $("#dialog").open || !$("#up-next").hidden)
        return;
      if ($("#player").contains(document.activeElement)) $("#player").focus();
      clearTimeout(controlsTimer);
      $("#player").classList.add("controls-idle");
    }, 3e3);
  }
  function closeSettings(restoreFocus2 = false) {
    $("#player-settings").hidden = true;
    $("#player-settings-toggle").setAttribute("aria-expanded", "false");
    if (restoreFocus2) $("#player-settings-toggle").focus();
    showControls();
  }
  var playing = () => !!active;
  function currentQueue() {
    return queue;
  }
  function replaceQueue(next) {
    queue = next;
  }
  async function releaseConversion() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
    if (conversion) {
      const key = conversion;
      conversion = null;
      await api(`/api/media/sessions/${key}`, {}, "DELETE").catch(() => {
      });
    }
  }
  async function report(type = "progress", beacon = false) {
    if (!active || loading) return;
    const payload = {
      type,
      seq: ++active.seq,
      position: playbackPosition(video().currentTime, active.offset, active.info.duration),
      duration: active.info.duration || 0
    };
    const url = `/api/playback/${active.session.id}/events`;
    if (beacon) {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => {
      });
      return;
    }
    try {
      await api(url, payload);
    } catch (error) {
      $("#player-message").textContent = `Progress could not be saved: ${error.message}`;
    }
  }
  async function closePlayer() {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {
    });
    clearInterval(timer);
    cancelNext();
    await report("stop");
    loading = true;
    video().pause();
    await releaseConversion();
    video().removeAttribute("src");
    video().load();
    active = null;
    clearTimeout(controlsTimer);
    closeSettings();
    queue = null;
    loading = false;
    $("#player").hidden = true;
    document.body.classList.remove("player-open");
    $("#shell").removeAttribute("inert");
    window.dispatchEvent(new Event("library-changed"));
  }
  async function play(itemId, titleId, { replay = false, queueId = null } = {}) {
    var _a, _b, _c;
    clearInterval(timer);
    cancelNext();
    await report("stop");
    loading = true;
    video().pause();
    await releaseConversion();
    try {
      const title = await api(`/api/titles/${titleId}`), item = title.items.find((i) => i.id === itemId);
      if (!(item == null ? void 0 : item.available))
        throw new Error(
          "This episode is not downloaded. Download it or explicitly skip to another episode."
        );
      if (!queueId && !replay && item.state.mode === "shuffle") {
        const saved = (await api("/api/queues")).find(
          (q) => q.mode === "shuffle" && q.items[q.index] === itemId
        );
        if (saved) queueId = (await api(`/api/queues/${saved.id}/fork`, {})).id;
      }
      queue = queueId ? await api(`/api/queues/${queueId}`) : title.kind !== "movie" ? await api("/api/queues", { titleId, startItem: itemId }) : null;
      const info = await api(`/api/items/${itemId}/media`), preferences = await api("/api/preferences");
      const session = await api("/api/playback", { itemId, replay, queueId: queue == null ? void 0 : queue.id });
      active = {
        item,
        title,
        info,
        preferences,
        session,
        seq: 0,
        offset: 0,
        pendingPosition: session.position
      };
      scrubbing = false;
      updateTransport();
      $("#player").hidden = false;
      document.body.classList.add("player-open");
      closeSettings();
      $("#shell").setAttribute("inert", "");
      $("#player-title").textContent = title.name;
      $("#player-episode").textContent = title.kind === "movie" ? "" : `${episodeLabel(item)}${item.name ? " \xB7 " + item.name : ""}`;
      $("#player-message").textContent = "";
      $("#audio").innerHTML = info.audio.map(
        (t) => `<option value="${t.index}">${esc(t.language)} \xB7 ${esc(t.title || t.codec)} ${t.channels || ""}</option>`
      ).join("");
      $("#subtitles").innerHTML = '<option value="">Off</option>' + info.subtitles.filter((t) => ["subrip", "ass", "ssa", "webvtt", "mov_text"].includes(t.codec)).map(
        (t) => `<option value="${t.index}">${esc(t.language)} \xB7 ${esc(t.title || t.codec)}</option>`
      ).join("");
      $("#previous").disabled = !queue || queue.index <= 0;
      $("#next").disabled = !queue || queue.index >= queue.items.length - 1;
      $("#player-queue").disabled = !queue;
      $("#previous").hidden = $("#next").hidden = $("#player-queue").hidden = !queue;
      $("#chapters").hidden = !((_a = info.chapters) == null ? void 0 : _a.length);
      $("#chapters").disabled = !((_b = info.chapters) == null ? void 0 : _b.length);
      const preferred = info.audio.find(
        (t) => preferences.audioLanguage && t.language === preferences.audioLanguage
      );
      if (preferred) $("#audio").value = String(preferred.index);
      if (info.direct && (!preferred || preferred.index === ((_c = info.audio[0]) == null ? void 0 : _c.index)))
        await source(`/api/items/${itemId}/file`, session.position);
      else await convert(session.position);
      if (preferences.subtitleMode === "preferred") {
        const track = info.subtitles.find((t) => t.language === preferences.subtitleLanguage);
        if (track) {
          $("#subtitles").value = String(track.index);
          setSubtitles();
        }
      }
      loading = false;
      active.pendingPosition = null;
      updateTransport();
      timer = setInterval(() => void report(), 1e4);
      $("#player-close").focus();
      showControls();
    } catch (error) {
      loading = false;
      if (active) active.pendingPosition = null;
      updateTransport();
      $("#player-message").textContent = error.message;
      toast(error.message);
      if (!active) $("#player").hidden = true;
    }
  }
  async function source(url, seek = 0, autoplay = true) {
    video().querySelectorAll("track").forEach((t) => t.remove());
    return new Promise((resolve, reject) => {
      var _a;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Playback could not start. Try compatibility playback."));
      }, 25e3);
      const error = () => {
        cleanup();
        reject(new Error("This format needs compatibility playback."));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        video().removeEventListener("error", error);
        video().onloadedmetadata = null;
      };
      video().addEventListener("error", error, { once: true });
      video().onloadedmetadata = () => {
        cleanup();
        if (seek > 0) video().currentTime = seek;
        if (autoplay)
          video().play().catch(() => {
            $("#player-message").textContent = "Press Play to begin.";
          });
        resolve();
      };
      if (url.includes(".m3u8") && ((_a = window.Hls) == null ? void 0 : _a.isSupported())) {
        hls = new window.Hls({ startPosition: 0, lowLatencyMode: false });
        hls.loadSource(url);
        hls.attachMedia(video());
        hls.on(window.Hls.Events.ERROR, (_, data) => {
          if (data.fatal) {
            cleanup();
            $("#player-message").textContent = "Playback failed. Try compatibility playback again.";
            reject(new Error("Compatibility playback failed"));
          }
        });
      } else video().src = url;
    });
  }
  async function convert(position, autoplay = true) {
    if (!active) return;
    const owner = active;
    loading = true;
    showControls();
    active.pendingPosition = position;
    updateTransport();
    $("#player-message").textContent = "";
    video().pause();
    try {
      await releaseConversion();
      const result = await api(`/api/items/${active.item.id}/convert`, {
        seek: position,
        audio: Number($("#audio").value) || void 0
      });
      if (active !== owner) {
        await api(`/api/media/sessions/${result.id}`, {}, "DELETE").catch(() => {
        });
        return;
      }
      conversion = result.id;
      active.offset = result.offset;
      await source(result.url, 0, autoplay);
      setSubtitles();
      $("#player-message").textContent = "";
    } finally {
      loading = false;
      if (active) active.pendingPosition = null;
      updateTransport();
      showControls();
    }
  }
  function setSubtitles() {
    video().querySelectorAll("track").forEach((t) => t.remove());
    const index = $("#subtitles").value;
    if (index === "" || !active) return;
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = "Selected subtitles";
    track.src = `/api/items/${active.item.id}/subtitles/${index}?offset=${active.offset}`;
    track.default = true;
    video().appendChild(track);
    track.addEventListener("load", () => track.track.mode = "showing");
    track.addEventListener("error", () => toast("These subtitles could not be loaded"));
  }
  async function advance(delta) {
    if (!queue || loading) return;
    cancelNext();
    await report("stop");
    try {
      queue = await api(
        `/api/queues/${queue.id}`,
        { revision: queue.revision, index: queue.index + delta },
        "PATCH"
      );
      const next = await api(`/api/queues/${queue.id}`);
      const item = next.entries[next.index];
      if (!item.available)
        throw new Error("This queued episode is unavailable. Download it, or use Queue to skip it.");
      await play(item.id, item.title_id, { queueId: queue.id, replay: queue.mode === "shuffle" });
    } catch (error) {
      toast(error.message);
      $("#player-message").textContent = error.message;
    }
  }
  function cancelNext() {
    clearInterval(countdown);
    countdown = null;
    $("#up-next").hidden = true;
  }
  async function showQueue(queueId = queue == null ? void 0 : queue.id) {
    if (!queueId) return;
    const data = await api(`/api/queues/${queueId}`);
    modal(
      `<h2>${esc(data.name)} \xB7 ${data.mode === "shuffle" ? "Shuffle" : "Queue"}</h2><div class="actions"><button data-queue-clear>Clear queue</button></div>${data.entries.map((item, index) => `<div class="row ${index === data.index ? "queue-current" : ""}"><div class="row-main"><strong>${index + 1}. ${esc(item.name)}</strong><p class="meta">${esc(episodeLabel(item))} \xB7 ${item.available ? "Downloaded" : "Unavailable"}</p></div><button data-queue-play="${index}" ${item.available ? "" : "disabled"}>Play</button><button data-queue-up="${index}" ${index === 0 ? "disabled" : ""} aria-label="Move ${esc(item.name)} up">\u2191</button><button data-queue-remove="${index}" aria-label="Remove ${esc(item.name)}">Remove</button></div>`).join("") || "<p>Queue is empty.</p>"}`
    );
    $("#dialog-content").onclick = async (event) => {
      const b = event.target.closest("button");
      if (!b) return;
      try {
        if (b.hasAttribute("data-queue-play")) {
          const index = Number(b.dataset.queuePlay);
          const sourceQueue = (queue == null ? void 0 : queue.id) === data.id ? data : await api(`/api/queues/${data.id}/fork`, {});
          const updated2 = await api(
            `/api/queues/${sourceQueue.id}`,
            { revision: sourceQueue.revision, index },
            "PATCH"
          );
          closeModal();
          const item = data.entries[index];
          await play(item.id, item.title_id, {
            queueId: updated2.id,
            replay: data.mode === "shuffle" && index !== data.index
          });
          return;
        }
        let items = [...data.items];
        if (b.hasAttribute("data-queue-clear")) items = [];
        else if (b.hasAttribute("data-queue-remove")) items.splice(Number(b.dataset.queueRemove), 1);
        else if (b.hasAttribute("data-queue-up")) {
          const index = Number(b.dataset.queueUp);
          [items[index - 1], items[index]] = [items[index], items[index - 1]];
        } else return;
        const updated = await api(
          `/api/queues/${data.id}`,
          { revision: data.revision, items },
          "PATCH"
        );
        if ((queue == null ? void 0 : queue.id) === data.id) queue = updated;
        await showQueue(data.id);
      } catch (error) {
        toast(error.message);
      }
    };
  }
  function updateTransport() {
    var _a;
    if (!active) return;
    const duration = active.info.duration || 0;
    const position = active.pendingPosition != null ? active.pendingPosition : playbackPosition(video().currentTime, active.offset, duration);
    const slider = $("#player-seek");
    slider.max = String(duration);
    slider.disabled = loading || !duration;
    if (!scrubbing) slider.value = String(position);
    const shown = scrubbing ? Number(slider.value) : position;
    slider.style.setProperty("--played", `${duration ? shown / duration * 100 : 0}%`);
    $("#player-time").textContent = `${clockTime(shown)} / ${clockTime(duration)}`;
    slider.setAttribute("aria-valuetext", `${clockTime(shown)} of ${clockTime(duration)}`);
    iconButton(
      "player-toggle",
      video().paused ? "play" : "pause",
      video().paused ? "Play" : "Pause",
      "Space"
    );
    iconButton(
      "player-mute",
      video().muted || !video().volume ? "muted" : "volume",
      video().muted ? "Unmute" : "Mute",
      "M"
    );
    $("#player-volume").value = String(video().volume);
    $("#player-buffering").textContent = loading ? "Preparing\u2026" : !video().paused && video().readyState < 3 ? "Buffering\u2026" : "";
    $("#player-loading").hidden = !$("#player-buffering").textContent;
    for (const id of [
      "player-toggle",
      "player-back",
      "player-forward",
      "convert",
      "audio",
      "chapters"
    ])
      $("#" + id).disabled = loading || id === "chapters" && !((_a = active.info.chapters) == null ? void 0 : _a.length);
  }
  async function seekTo(target) {
    if (!active || loading) return;
    cancelNext();
    const ranges = Array.from({ length: video().seekable.length }, (_, i) => [
      video().seekable.start(i),
      video().seekable.end(i)
    ]);
    const plan = seekPlan(target, active.info.duration, active.offset, !!conversion, ranges);
    if (plan.restart) {
      await convert(plan.position, !video().paused);
      await report("seek");
    } else video().currentTime = plan.relative;
    updateTransport();
  }
  function initPlayer() {
    for (const [id, icon, label] of [
      ["player-close", "back", "Back to library"],
      ["player-toggle", "play", "Play"],
      ["player-back", "rewind", "Rewind 10 seconds"],
      ["player-forward", "forward", "Forward 10 seconds"],
      ["player-mute", "volume", "Mute"],
      ["player-fullscreen", "fullscreen", "Fullscreen"],
      ["previous", "previous", "Previous episode"],
      ["next", "next", "Next episode"],
      ["player-queue", "queue", "Episode queue"],
      ["chapters", "chapters", "Chapters"],
      ["player-settings-toggle", "settings", "Playback settings"],
      ["player-settings-close", "close", "Close playback settings"]
    ])
      iconButton(id, icon, label);
    $("#player-settings-toggle").onclick = () => {
      const open = $("#player-settings").hidden;
      $("#player-settings").hidden = !open;
      $("#player-settings-toggle").setAttribute("aria-expanded", String(open));
      showControls();
      if (open) $("#player-settings-close").focus();
    };
    $("#player-settings-close").onclick = () => closeSettings(true);
    $("#player").addEventListener("pointermove", () => {
      keyboardControls = false;
      showControls();
    });
    $("#player").addEventListener("pointerdown", (event) => {
      keyboardControls = false;
      if (!event.target.closest("#player-settings, #player-settings-toggle")) closeSettings();
      showControls();
    });
    $("#player").addEventListener("focusin", showControls);
    document.addEventListener("keydown", (event) => {
      if (!active || $("#dialog").open) return;
      keyboardControls = true;
      showControls();
      if ((event.key === "Escape" || event.keyCode === 10009) && !$("#player-settings").hidden) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeSettings(true);
        return;
      }
      if (["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) return;
      const key = event.key.toLowerCase();
      if (key === " " && event.target.tagName !== "BUTTON" || key === "k" || event.keyCode === 10252) {
        event.preventDefault();
        if (!loading) $("#player-toggle").click();
      } else if (key === "m") $("#player-mute").click();
      else if (key === "f") $("#player-fullscreen").click();
      else if (event.keyCode === 415 && !loading)
        void video().play().catch((e) => toast(e.message));
      else if (event.keyCode === 19) video().pause();
    });
    $("#player-toggle").onclick = () => {
      if (video().paused)
        video().play().catch((e) => toast(e.message));
      else video().pause();
    };
    $("#player-back").onclick = () => seekTo((video().currentTime || 0) + ((active == null ? void 0 : active.offset) || 0) - 10).catch((e) => toast(e.message));
    $("#player-forward").onclick = () => seekTo((video().currentTime || 0) + ((active == null ? void 0 : active.offset) || 0) + 10).catch((e) => toast(e.message));
    $("#player-seek").oninput = () => {
      scrubbing = true;
      showControls();
      updateTransport();
    };
    $("#player-seek").onchange = () => {
      const target = Number($("#player-seek").value);
      scrubbing = false;
      showControls();
      seekTo(target).catch((e) => {
        toast(e.message);
        updateTransport();
      });
    };
    $("#player-seek").onblur = () => {
      scrubbing = false;
      updateTransport();
    };
    $("#player-mute").onclick = () => {
      video().muted = !video().muted;
    };
    $("#player-volume").oninput = () => {
      video().volume = Number($("#player-volume").value);
      video().muted = false;
    };
    $("#player-fullscreen").onclick = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else if ($("#player").requestFullscreen) await $("#player").requestFullscreen();
        else toast("Fullscreen is unavailable in this browser");
      } catch (e) {
        toast(e.message);
      }
    };
    document.addEventListener("fullscreenchange", () => {
      iconButton(
        "player-fullscreen",
        document.fullscreenElement ? "exitFullscreen" : "fullscreen",
        document.fullscreenElement ? "Exit fullscreen" : "Fullscreen",
        "F"
      );
    });
    video().onclick = () => {
      if (!loading) $("#player-toggle").click();
    };
    video().ondblclick = () => $("#player-fullscreen").click();
    for (const event of ["playing", "pause", "waiting"])
      video().addEventListener(event, showControls);
    for (const event of [
      "timeupdate",
      "durationchange",
      "loadedmetadata",
      "progress",
      "waiting",
      "playing",
      "pause",
      "seeking",
      "seeked",
      "volumechange"
    ])
      video().addEventListener(event, updateTransport);
    $("#player-close").onclick = () => void closePlayer();
    $("#previous").onclick = () => void advance(-1);
    $("#next").onclick = () => void advance(1);
    $("#player-queue").onclick = () => showQueue().catch((e) => toast(e.message));
    $("#convert").onclick = () => convert((video().currentTime || 0) + ((active == null ? void 0 : active.offset) || 0), !video().paused).catch(
      (e) => toast(e.message)
    );
    $("#audio").onchange = $("#convert").onclick;
    $("#subtitles").onchange = setSubtitles;
    $("#chapters").onclick = () => {
      modal(
        `<h2>Chapters</h2>${((active == null ? void 0 : active.info.chapters) || []).map((c, i) => `<button class="release" data-chapter="${i}">${esc(c.name)} \xB7 ${Math.floor(c.start / 60)}:${String(Math.floor(c.start % 60)).padStart(2, "0")}</button>`).join("")}`
      );
      $("#dialog-content").onclick = (e) => {
        const b = e.target.closest("[data-chapter]");
        if (!b) return;
        const chapter = active.info.chapters[Number(b.dataset.chapter)];
        closeModal();
        seekTo(chapter.start).catch((e2) => toast(e2.message));
      };
    };
    video().addEventListener("pause", () => void report("pause"));
    video().addEventListener("seeked", () => void report("seek"));
    video().addEventListener("error", () => {
      if (!loading && active)
        $("#player-message").textContent = "This format may need compatibility playback. Select that button below.";
    });
    video().addEventListener("ended", async () => {
      if (!active || loading) return;
      if (!atTitleEnd(
        playbackPosition(video().currentTime, active.offset, active.info.duration),
        active.info.duration
      )) {
        $("#player-message").textContent = "Playback stopped before the end. Retry compatibility playback to continue.";
        await report("pause");
        return;
      }
      await report("ended");
      if (!queue || queue.index >= queue.items.length - 1) return;
      $("#up-next").hidden = false;
      let seconds = 10;
      $("#up-next-label").textContent = "Next episode is ready";
      if (active.preferences.autoplay)
        countdown = setInterval(() => {
          $("#up-next-label").textContent = `Next episode in ${--seconds} seconds`;
          if (seconds <= 0) void advance(1);
        }, 1e3);
    });
    $("#up-next-play").onclick = () => void advance(1);
    $("#up-next-cancel").onclick = cancelNext;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void report("pause", true);
    });
    window.addEventListener("pagehide", () => void report("stop", true));
  }

  // public/app.js
  var user = null;
  var generation = 0;
  var poll = null;
  var currentTitle = null;
  var discoverResults = [];
  var locationKey = "";
  var returnPositions = {};
  var main = () => $("#main");
  var button = (label, action2, attrs = "", style = "") => `<button class="${style}" data-action="${action2}" ${attrs}>${esc(label)}</button>`;
  var option = (value, label, current) => `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(label)}</option>`;
  var grid = (items) => `<div class="grid">${items.map((t) => card(t)).join("")}</div>`;
  function shelf(label, items, mode) {
    return items.length ? `<section class="section"><div class="section-heading"><h2>${esc(label)}</h2></div><div class="rail ${mode ? "resume-rail" : ""}">${items.map((t) => card(t, mode)).join("")}</div></section>` : "";
  }
  async function route({ quiet = false } = {}) {
    var _a;
    if (!user) return;
    const ticket = ++generation;
    clearInterval(poll);
    currentTitle = null;
    const hash = location.hash.slice(1) || "/", url = new URL(hash, "http://local"), parts = url.pathname.split("/").filter(Boolean), page = parts[0] || "home";
    if (locationKey !== hash) {
      returnPositions[locationKey] = {
        y: window.scrollY,
        key: (_a = document.activeElement) == null ? void 0 : _a.getAttribute("href")
      };
      locationKey = hash;
    }
    document.querySelectorAll("[data-nav]").forEach(
      (a) => a.classList.toggle(
        "active",
        a.dataset.nav === page || page === "title" && a.dataset.nav === "library"
      )
    );
    const draw = (html) => {
      var _a2, _b;
      if (ticket !== generation) return;
      main().innerHTML = html;
      if (!quiet) {
        window.scrollTo(0, ((_a2 = returnPositions[hash]) == null ? void 0 : _a2.y) || 0);
        const href = (_b = returnPositions[hash]) == null ? void 0 : _b.key;
        if (href) {
          const target = [...main().querySelectorAll("a")].find(
            (a) => a.getAttribute("href") === href
          );
          target == null ? void 0 : target.focus({ preventScroll: true });
        }
      }
    };
    if (!quiet) main().innerHTML = '<p class="loading" role="status">Loading\u2026</p>';
    try {
      if (page === "home") {
        const data = await api("/api/home"), queues = await api("/api/queues");
        const count = data.continueWatching.length + data.nextUp.length + data.recentlyAdded.length;
        draw(
          heading("Home", "", `<a class="quiet" href="#/settings">${esc(user.name)}</a>`) + shelf("Continue watching", data.continueWatching, "resume") + shelf("Next up", data.nextUp, "next") + shelf("Recently added", data.recentlyAdded) + shelf("My list", data.watchlist) + (!count ? empty(
            "Make yourself at home",
            "Find a movie or series, download it to your library, and watch it here.",
            `<a class="primary card-action" href="#/discover">Discover something to watch</a>`
          ) : "") + (queues.some((q) => q.items.length) ? `<section class="section"><h2>Saved queues</h2>${queues.filter((q) => q.items.length).slice(0, 3).map(
            (q) => `<div class="row"><div class="row-main"><h3>${esc(q.name)}</h3><p class="meta">${q.mode === "shuffle" ? "Shuffle" : "In order"} \xB7 ${q.items.length} items</p></div>${button("Open queue", "queue", `data-id="${q.id}"`)}</div>`
          ).join("")}</section>` : "")
        );
      } else if (page === "library" || page === "list") {
        const params = new URLSearchParams(url.search);
        if (page === "list") {
          params.set("scope", "all");
          if (!params.get("tag")) params.set("tag", "watchlist");
        }
        const data = await api(`/api/library?${params}`), collections = page === "list" ? await api("/api/collections") : [];
        draw(
          heading(page === "list" ? "My List" : "Your library", `${data.total} titles`) + `<form id="filters" class="toolbar"><label>Search<input name="q" type="search" value="${esc(params.get("q"))}" placeholder="Find a title"></label><label>Type<select name="kind">${[
            ["", "All types"],
            ["movie", "Movies"],
            ["tv", "Series"],
            ["anime", "Anime"]
          ].map(([v, l]) => option(v, l, params.get("kind") || "")).join("")}</select></label><label>View<select name="status">${[
            ["", "All titles"],
            ["ready", "Downloaded"],
            ["progress", "In progress"],
            ["unwatched", "Unwatched"],
            ["watched", "Watched"]
          ].map(([v, l]) => option(v, l, params.get("status") || "")).join("")}</select></label><label>Sort<select name="sort">${[
            ["", "Title"],
            ["added", "Recently added"],
            ["played", "Last watched"],
            ["year", "Year"]
          ].map(([v, l]) => option(v, l, params.get("sort") || "")).join(
            ""
          )}</select></label>${page === "list" ? `<label>List<select name="tag">${option("watchlist", "Watchlist", params.get("tag"))}${option("favorite", "Favorites", params.get("tag"))}</select></label>` : ""}<button>Apply</button></form>` + (page === "list" ? `<div class="collection-links">${button("New collection", "new-collection")}${collections.map((c) => button(c.name, "collection", `data-id="${c.id}"`)).join("")}</div>` : "") + (data.items.length ? grid(data.items) : empty(
            "Nothing here yet",
            page === "list" ? "Save titles to your watchlist or favorites from their detail page." : "Downloaded titles will appear here. Try different filters or discover a title."
          )) + `<div class="actions section">${data.offset ? button("Previous page", "page", `data-offset="${Math.max(0, data.offset - 48)}"`) : ""}${data.offset + 48 < data.total ? button("Next page", "page", `data-offset="${data.offset + 48}"`) : ""}</div>`
        );
        $("#filters").onsubmit = (e) => {
          e.preventDefault();
          const query = new URLSearchParams(new FormData(e.target));
          location.hash = `/${page}?${query}`;
        };
      } else if (page === "discover") {
        const q = url.searchParams.get("q") || "";
        draw(
          heading("Discover") + `<form id="search" class="toolbar"><label>Search<input name="q" type="search" placeholder="Search movies, series and anime" value="${esc(q)}"></label><button class="primary">Search</button></form><div id="results"><p class="loading">Finding titles\u2026</p></div>`
        );
        $("#search").onsubmit = (e) => {
          e.preventDefault();
          location.hash = `/discover?${new URLSearchParams(new FormData(e.target))}`;
        };
        try {
          const data = await api(`/api/discover?q=${encodeURIComponent(q)}`);
          if (ticket !== generation) return;
          discoverResults = data.items;
          $("#results").innerHTML = data.items.length ? `<div class="grid">${data.items.map((t, i) => `<article class="card"><button class="poster" data-action="discover-title" data-index="${i}" aria-label="Open ${esc(t.name)}">${poster(t)}</button><h3 class="card-name">${esc(t.name)}</h3><p class="meta">${esc(t.year)}</p></article>`).join("")}</div>` : empty("No matching titles", "Try another title.");
        } catch (error) {
          if (ticket === generation)
            $("#results").innerHTML = empty("Discovery is unavailable", error.message);
        }
      } else if (page === "title") {
        const title = await api(`/api/titles/${parts[1]}`);
        if (ticket !== generation) return;
        currentTitle = title;
        draw(detailHtml(title));
      } else if (page === "downloads") {
        const [jobs, seasons] = await Promise.all([
          api("/api/downloads"),
          api("/api/season-downloads")
        ]);
        draw(
          heading("Downloads") + (seasons.length ? '<section class="section"><h2>Season downloads</h2>' + seasons.map(seasonDownloadRow).join("") + "</section><h2>Episodes</h2>" : "") + (jobs.length ? jobs.map(downloadRow).join("") : empty("No downloads yet", "Choose a release on a title page to save it locally."))
        );
        poll = setInterval(() => {
          if (!document.hidden && !playing()) route({ quiet: true });
        }, 5e3);
      } else if (page === "settings") {
        const prefs = await api("/api/preferences");
        const admin = user.role === "admin" ? await api("/api/admin") : null;
        draw(
          heading("Settings") + torrentRulesForm(admin) + `<form id="preferences" class="form"><h2>Playback</h2><label class="check section"><input type="checkbox" name="autoplay" ${prefs.autoplay ? "checked" : ""}>Play the next episode automatically</label><label>Preferred audio language<input name="audioLanguage" placeholder="eng, dan, jpn\u2026" maxlength="20" value="${esc(prefs.audioLanguage)}"></label><label>Preferred subtitle language<input name="subtitleLanguage" maxlength="20" placeholder="eng, dan\u2026" value="${esc(prefs.subtitleLanguage)}"></label><label>Subtitles<select name="subtitleMode">${option("off", "Off", prefs.subtitleMode)}${option("preferred", "Use preferred language", prefs.subtitleMode)}</select></label><button class="primary">Save preferences</button></form>${admin ? `<section class="section"><h2>Server</h2><p class="meta">Real-Debrid: ${admin.debridConfigured ? "Configured" : "Not configured"}</p><p class="meta">Import folders: ${esc(admin.importRoots.join(", ") || "None configured")}</p></section><section class="section"><div class="section-heading"><h2>People</h2>${button("Add person", "add-user")}</div>${admin.users.map((u) => `<div class="row"><div class="row-main"><h3>${esc(u.name)}</h3><p class="meta">${esc(u.email)} \xB7 ${u.active ? "Active" : "Disabled"} \xB7 ${u.role === "admin" || u.can_download ? "Downloads allowed" : "Viewing only"}</p></div>${u.id !== user.id ? button(u.can_download ? "Disable downloads" : "Allow downloads", "user-permission", `data-id="${u.id}" data-active="${!!u.active}" data-allowed="${!u.can_download}"`) : ""}</div>`).join("")}</section>` : ""}<section class="section">${button("Sign out", "logout")}</section>`
        );
        bindTorrentRules();
        $("#preferences").onsubmit = async (e) => {
          e.preventDefault();
          const data = new FormData(e.target);
          try {
            await api(
              "/api/preferences",
              {
                autoplay: data.has("autoplay"),
                audioLanguage: data.get("audioLanguage"),
                subtitleLanguage: data.get("subtitleLanguage"),
                subtitleMode: data.get("subtitleMode")
              },
              "PATCH"
            );
            toast("Preferences saved");
          } catch (error) {
            toast(error.message);
          }
        };
      } else draw(empty("Page not found", "Use the navigation to return to your library."));
    } catch (error) {
      draw(empty("Could not open this page", error.message, button("Try again", "refresh")));
    }
  }
  function detailHtml(title) {
    var _a;
    const primary = title.primary;
    let html = `<div class="detail"><div class="detail-art poster">${poster(title)}</div><div class="detail-copy"><p class="eyebrow">${esc(title.kind === "movie" ? "Movie" : title.kind === "anime" ? "Anime" : "Series")} ${esc(title.year)}</p><h1>${esc(title.name)}</h1>${metadataHtml(title)}<p class="muted">${esc(title.description)}</p><div class="actions">${primary ? button(primary.available ? title.resumable ? "Resume " + episodeLabel(primary) : primary.state.completed ? "Replay" : "Play " + episodeLabel(primary) : "Find a release", primary.available ? "play" : "release", `data-item="${primary.id}" data-title="${title.id}"`, "primary") : ""}${title.kind !== "movie" && title.readyCount ? button("Shuffle episodes", "shuffle", `data-title="${title.id}"`) : ""}${button(title.tags.includes("watchlist") ? "In My List" : "Add to My List", "tag", `data-tag="watchlist" data-active="${!title.tags.includes("watchlist")}"`)}${button(title.tags.includes("favorite") ? "Favorited" : "Favorite", "tag", `data-tag="favorite" data-active="${!title.tags.includes("favorite")}"`)}${button("Collections", "add-collection")}</div><p class="meta">${title.readyCount} downloaded${((_a = title.genres) == null ? void 0 : _a.length) ? " \xB7 " + esc(title.genres.join(" / ")) : ""}</p></div></div>`;
    const seasons = [...new Set(title.items.map((i) => i.season))];
    for (const season of seasons) {
      const items = title.items.filter((i) => i.season === season);
      html += `<section><div class="season-header"><h2>${title.kind === "movie" ? "Your copy" : season ? `Season ${season}` : title.kind === "anime" ? "Episodes" : "Specials"}</h2><div class="actions">${title.kind !== "movie" && user.canDownload && items.some((i) => !i.available) ? button(title.kind === "anime" && !season ? "Download all episodes" : "Download season", "download-season", `data-season="${season}"`) : ""}${title.kind !== "movie" && items.some((i) => i.available) ? button("Shuffle season", "shuffle", `data-title="${title.id}" data-season="${season}"`) : ""}${button(items.every((i) => i.state.completed) ? "Mark unwatched" : "Mark watched", "bulk-watched", `data-season="${season}" data-watched="${!items.every((i) => i.state.completed)}"`)}</div></div>${items.map((i) => `<div class="episode"><span class="episode-number">${i.episode || "\u2014"}</span><div class="episode-body">${i.thumbnail ? `<img class="episode-thumbnail" src="${esc(i.thumbnail)}" alt="" loading="lazy">` : ""}<h3>${esc(i.name || episodeLabel(i))}</h3><p class="meta">${i.available ? "Downloaded" : "Not downloaded"} \xB7 ${i.state.completed ? "Watched" : i.state.position >= 10 ? "In progress" : "Unwatched"}${i.released ? " \xB7 " + esc(String(i.released).slice(0, 10)) : ""}</p>${episodeMetadata(i)}${progress(i.state)}</div><div class="actions">${button(i.available ? i.state.position >= 10 && !i.state.completed ? "Resume" : "Play" : "Download", i.available ? "play" : "release", `data-item="${i.id}" data-title="${title.id}"`, i.available ? "" : "quiet")}${button("More", "item-menu", `data-item="${i.id}"`)}</div></div>`).join("")}</section>`;
    }
    return html;
  }
  async function chooseCollection() {
    const collections = await api("/api/collections");
    modal(
      "<h2>Add to collection</h2>" + collections.map((c) => button(c.name, "collection-toggle", `data-id="${c.id}"`)).join("") + `<form id="new-collection"><label>New collection<input name="name" required maxlength="100"></label><button>Create</button></form>`
    );
    $("#new-collection").onsubmit = async (e) => {
      e.preventDefault();
      try {
        const c = await api("/api/collections", { name: new FormData(e.target).get("name") });
        if (currentTitle)
          await api(`/api/collections/${c.id}`, { items: [currentTitle.id] }, "PATCH");
        closeModal();
        toast("Collection created");
        if (!currentTitle) route();
      } catch (error) {
        toast(error.message);
      }
    };
    $("#dialog-content").onclick = async (e) => {
      const b = e.target.closest("[data-id]");
      if (!b || !currentTitle) return;
      try {
        const c = collections.find((c2) => c2.id === b.dataset.id);
        await api(
          `/api/collections/${c.id}`,
          { items: [.../* @__PURE__ */ new Set([...c.items, currentTitle.id])] },
          "PATCH"
        );
        closeModal();
        toast("Added to collection");
      } catch (error) {
        toast(error.message);
      }
    };
  }
  async function action(event) {
    const b = event.target.closest("[data-action]");
    if (!b) return;
    const actionName = b.dataset.action;
    b.disabled = true;
    try {
      if (actionName === "refresh") await route();
      else if (actionName === "refresh-metadata") {
        const titleId = currentTitle.id;
        await api(`/api/titles/${titleId}/refresh`, {});
        if ((currentTitle == null ? void 0 : currentTitle.id) === titleId) await route({ quiet: true });
        toast("Metadata refreshed");
      } else if (actionName === "play") {
        closeModal();
        await play(b.dataset.item, b.dataset.title, { replay: b.dataset.replay === "true" });
      } else if (actionName === "release") await releases(b.dataset.item);
      else if (actionName === "download-season")
        await downloadSeason(currentTitle, Number(b.dataset.season));
      else if (actionName === "season-stop") {
        await api(`/api/season-downloads/${b.dataset.id}/stop`, {});
        await route({ quiet: true });
      } else if (actionName === "discover-title") {
        const title = discoverResults[Number(b.dataset.index)];
        const stored = await api("/api/discover", {
          kind: title.kind,
          externalId: title.external_id
        });
        location.hash = `/title/${stored.id}`;
      } else if (actionName === "tag") {
        await api(`/api/titles/${currentTitle.id}/tags`, {
          tag: b.dataset.tag,
          active: b.dataset.active === "true"
        });
        await route({ quiet: true });
      } else if (actionName === "shuffle") {
        const titleId = b.dataset.title, season = b.dataset.season;
        modal(
          '<h2>Shuffle episodes</h2><p class="meta">Downloaded episodes, without repeats.</p><form id="shuffle-form"><label class="check section"><input name="unwatched" type="checkbox">Unwatched episodes only</label><button class="primary">Start shuffle</button></form>'
        );
        $("#dialog-content").onclick = null;
        $("#shuffle-form").onsubmit = async (e) => {
          e.preventDefault();
          try {
            const queue2 = await api("/api/queues", {
              titleId,
              season: season == null ? void 0 : Number(season),
              mode: "shuffle",
              unwatched: new FormData(e.target).has("unwatched")
            });
            closeModal();
            await play(queue2.items[0], titleId, { queueId: queue2.id, replay: true });
          } catch (error) {
            toast(error.message);
          }
        };
      } else if (actionName === "resume-menu") {
        modal(
          '<h2>Continue watching</h2><div class="actions">' + button(
            "Play from beginning",
            "play",
            `data-title="${b.dataset.title}" data-item="${b.dataset.item}" data-replay="true"`
          ) + button("Mark watched", "watched", `data-item="${b.dataset.item}" data-watched="true"`) + button("Remove from Continue Watching", "dismiss", `data-title="${b.dataset.title}"`) + "</div>"
        );
        $("#dialog-content").onclick = action;
      } else if (actionName === "dismiss") {
        await api(`/api/titles/${b.dataset.title}/dismiss`, { hidden: true });
        closeModal();
        await route({ quiet: true });
      } else if (actionName === "watched" || actionName === "bulk-watched") {
        const items = actionName === "watched" ? [b.dataset.item] : currentTitle.items.filter((i) => i.season === Number(b.dataset.season)).map((i) => i.id);
        const watched = b.dataset.watched === "true";
        const result = await api("/api/watched", { items, watched });
        closeModal();
        await route({ quiet: true });
        toast(
          `${items.length} item${items.length === 1 ? "" : "s"} marked ${watched ? "watched" : "unwatched"}`
        );
        const undo = document.createElement("button");
        undo.textContent = "Undo";
        undo.onclick = async () => {
          try {
            await api("/api/watched/undo", { token: result.undoToken });
            await route({ quiet: true });
            toast("Change undone");
          } catch (error) {
            toast(error.message);
          }
        };
        $("#toast").appendChild(undo);
      } else if (actionName === "item-menu") {
        const item = currentTitle.items.find((i) => i.id === b.dataset.item), attrs = `data-item="${item.id}"`;
        modal(
          `<h2>${esc(item.name || episodeLabel(item))}</h2><div class="actions">${button(item.state.completed ? "Mark unwatched" : "Mark watched", "watched", `${attrs} data-watched="${!item.state.completed}"`)}${item.available ? button("Play from beginning", "play", `${attrs} data-title="${currentTitle.id}" data-replay="true"`) + button("Add to queue", "enqueue", attrs) + button("Play next", "enqueue", `${attrs} data-next="true"`) : ""}${user.role === "admin" ? button("Import local file", "import", attrs) : ""}</div>`
        );
        $("#dialog-content").onclick = action;
      } else if (actionName === "enqueue") {
        let q = currentQueue();
        if (!q) {
          q = await api("/api/queues", { items: [b.dataset.item] });
          toast("Saved a new queue");
        } else {
          const items = q.items.filter((i) => i !== b.dataset.item);
          items.splice(b.dataset.next === "true" ? q.index + 1 : items.length, 0, b.dataset.item);
          replaceQueue(await api(`/api/queues/${q.id}`, { revision: q.revision, items }, "PATCH"));
          toast("Added to queue");
        }
        closeModal();
      } else if (actionName === "queue") {
        await showQueue(b.dataset.id);
      } else if (actionName === "download-action") {
        await api(`/api/downloads/${b.dataset.id}`, { action: b.dataset.operation });
        await route({ quiet: true });
      } else if (actionName === "download-title") {
        location.hash = `/title/${b.dataset.title}`;
      } else if (actionName === "page") {
        const url = new URL(location.hash.slice(1), "http://local");
        url.searchParams.set("offset", b.dataset.offset);
        location.hash = url.pathname + url.search;
      } else if (actionName === "add-collection" || actionName === "new-collection")
        await chooseCollection();
      else if (actionName === "collection") {
        const collections = await api("/api/collections"), collection = collections.find((c) => c.id === b.dataset.id);
        const titles = await Promise.all(
          collection.items.map((id) => api(`/api/titles/${id}`).catch(() => null))
        );
        modal(
          `<h2>${esc(collection.name)}</h2>${grid(titles.filter(Boolean))}<div class="actions section">${button("Delete collection", "delete-collection", `data-id="${collection.id}"`)}</div>`
        );
        $("#dialog-content").onclick = (e) => {
          if (e.target.closest("a")) closeModal();
          else action(e);
        };
      } else if (actionName === "delete-collection") {
        await api(`/api/collections/${b.dataset.id}`, {}, "DELETE");
        closeModal();
        await route({ quiet: true });
      } else if (actionName === "import") {
        const itemId = b.dataset.item;
        modal(
          '<h2>Import a local file</h2><form id="import-form"><label>Server file path<input name="path" required placeholder="/media/existing/episode.mkv"></label><p class="meta">The file stays in place. Its folder must be allowed in server settings.</p><button class="primary">Import</button></form>'
        );
        $("#dialog-content").onclick = null;
        $("#import-form").onsubmit = async (e) => {
          e.preventDefault();
          try {
            await api("/api/admin/import", { itemId, path: new FormData(e.target).get("path") });
            closeModal();
            await route({ quiet: true });
            toast("File imported");
          } catch (error) {
            toast(error.message);
          }
        };
      } else if (actionName === "add-user") {
        modal(
          '<h2>Add a person</h2><form id="user-form" class="form"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>Initial password<input name="password" type="password" minlength="10" required autocomplete="new-password"></label><label class="check"><input name="canDownload" type="checkbox">Allow downloads</label><button class="primary">Create account</button></form>'
        );
        $("#dialog-content").onclick = null;
        $("#user-form").onsubmit = async (e) => {
          e.preventDefault();
          const data = new FormData(e.target);
          try {
            await api("/api/admin/users", {
              name: data.get("name"),
              email: data.get("email"),
              password: data.get("password"),
              canDownload: data.has("canDownload")
            });
            closeModal();
            await route({ quiet: true });
          } catch (error) {
            toast(error.message);
          }
        };
      } else if (actionName === "user-permission") {
        await api(
          `/api/admin/users/${b.dataset.id}`,
          { active: b.dataset.active === "true", canDownload: b.dataset.allowed === "true" },
          "PATCH"
        );
        await route({ quiet: true });
      } else if (actionName === "logout") await logout();
    } catch (error) {
      toast(error.message);
    } finally {
      b.disabled = false;
    }
  }
  async function logout() {
    if (playing()) await closePlayer();
    await api("/api/logout", {});
    location.reload();
  }
  async function boot() {
    const auth = await api("/api/auth");
    user = auth.user;
    if (!user) {
      $("#sidebar").hidden = true;
      main().style.marginLeft = "0";
      main().style.width = "100%";
      main().innerHTML = `<div class="login"><p class="eyebrow">Mediawan</p><h1>Your library awaits.</h1>${auth.setupRequired ? "<p>Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 10 characters on the server, then restart Mediawan.</p>" : '<form id="login" class="form"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="primary">Sign in</button><p id="login-error" class="error" role="alert"></p></form>'}</div>`;
      if ($("#login"))
        $("#login").onsubmit = async (e) => {
          e.preventDefault();
          const data = new FormData(e.target);
          try {
            await api("/api/login", { email: data.get("email"), password: data.get("password") });
            location.reload();
          } catch (error) {
            $("#login-error").textContent = error.message;
          }
        };
      return;
    }
    $("#account").textContent = user.name;
    $("#signout").onclick = logout;
    $("#dialog-close").onclick = closeModal;
    main().onclick = action;
    initPlayer();
    window.addEventListener("hashchange", () => {
      closeModal();
      route();
    });
    window.addEventListener("library-changed", () => route({ quiet: true }));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !playing()) route({ quiet: true });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || e.keyCode === 10009) {
        if ($("#dialog").open) {
          e.preventDefault();
          closeModal();
        } else if (playing()) {
          e.preventDefault();
          void closePlayer();
        }
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) || ["INPUT", "SELECT", "TEXTAREA", "VIDEO"].includes(document.activeElement.tagName))
        return;
      const root = $("#dialog").open ? $("#dialog") : playing() ? $("#player") : document;
      const candidates = [...root.querySelectorAll("a,button,input,select")].filter(
        (el) => !el.disabled && el.getClientRects().length
      );
      const origin = document.activeElement.getBoundingClientRect(), cx = origin.x + origin.width / 2, cy = origin.y + origin.height / 2;
      const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight", positive = e.key === "ArrowRight" || e.key === "ArrowDown";
      const ranked = candidates.filter((el) => el !== document.activeElement).map((el) => {
        const r = el.getBoundingClientRect(), dx = r.x + r.width / 2 - cx, dy = r.y + r.height / 2 - cy;
        return { el, primary: horizontal ? dx : dy, secondary: horizontal ? dy : dx };
      }).filter((c) => positive ? c.primary > 5 : c.primary < -5).sort(
        (a, b) => Math.abs(a.primary) + Math.abs(a.secondary) * 3 - (Math.abs(b.primary) + Math.abs(b.secondary) * 3)
      );
      if (ranked[0]) {
        e.preventDefault();
        ranked[0].el.focus();
        ranked[0].el.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    });
    await route();
  }
  boot().catch((error) => {
    main().innerHTML = empty("Mediawan could not start", error.message);
  });
})();
