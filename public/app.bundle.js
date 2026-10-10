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
  function poster(title, landscape = false) {
    const url = String(landscape && title.background || title.poster || "");
    return /^https?:\/\//.test(url) ? `<img src="${esc(url)}" alt="" loading="lazy">` : `<div class="poster-placeholder">${esc(title.name)}</div>`;
  }
  var icon = (name) => {
    const paths = {
      play: '<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
      left: '<path d="m15 5-7 7 7 7"/>',
      right: '<path d="m9 5 7 7-7 7"/>'
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
  };
  function card(title, mode = "library") {
    const item = mode === "resume" ? title.resumable : mode === "next" ? title.next : null;
    const remaining = (item == null ? void 0 : item.state.duration) ? `${Math.ceil(Math.max(0, item.state.duration - item.state.position) / 60)} min left` : "";
    return `<article class="card"><a class="poster" href="#/title/${esc(title.id)}" aria-label="Open ${esc(title.name)}">${poster(title, mode !== "library")}${item ? `<span class="badge">${esc(episodeLabel(item))}</span>` : title.readyCount ? '<span class="badge">Downloaded</span>' : ""}</a>${item ? progress(item.state) : ""}<a class="card-name" href="#/title/${esc(title.id)}">${esc(title.name)}</a><p class="meta">${esc(item ? mode === "resume" ? remaining : item.name : [title.year, title.kind === "movie" ? "Movie" : title.kind === "anime" ? "Anime" : "Series"].filter(Boolean).join(" \xB7 "))}</p>${item ? `<div class="resume-actions"><button class="card-action ${mode === "resume" ? "primary" : ""}" data-action="${item.available ? "play" : "release"}" data-item="${esc(item.id)}" data-title="${esc(title.id)}">${item.available ? icon("play") : ""}${item.available ? mode === "resume" ? "Resume" : "Play next" : "Not downloaded"}</button>${mode === "resume" ? `<button class="menu-button" data-action="resume-menu" data-title="${esc(title.id)}" data-item="${esc(item.id)}" aria-label="More actions for ${esc(title.name)}">\u2022\u2022\u2022</button>` : ""}</div>` : ""}</article>`;
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

  // public/live-cast.js
  var sdk;
  function prepareLiveCast() {
    if (sdk) return sdk;
    if (!window.isSecureContext || !/Chrome\//.test(navigator.userAgent))
      return Promise.reject(Error("Cast from Chrome over HTTPS, on the same Wi-Fi as your TV."));
    sdk = new Promise((resolve, reject) => {
      const timer2 = setTimeout(
        () => reject(Error("Casting could not load. Reload and try again.")),
        15e3
      );
      window.__onGCastApiAvailable = (available) => {
        clearTimeout(timer2);
        if (!available) return reject(Error("Casting is unavailable in this browser. Use Chrome."));
        const context = window.cast.framework.CastContext.getInstance();
        context.setOptions({
          receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
          autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
        });
        resolve(context);
      };
      const script = document.createElement("script");
      script.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
      script.onerror = () => {
        clearTimeout(timer2);
        reject(Error("Casting could not load. Reload and try again."));
      };
      document.head.appendChild(script);
    });
    return sdk;
  }
  function bindLiveCast({
    session,
    button: button2,
    stopButton,
    pauseButton,
    status,
    onStart,
    onStop,
    prepare = prepareLiveCast,
    request = api,
    origin = location.origin
  }) {
    let context, receiver, grant, controller, remote, disposed = false, busy = false;
    const framework = () => window.cast.framework;
    const ownsReceiver = () => {
      var _a, _b;
      return ((_b = (_a = receiver == null ? void 0 : receiver.getMediaSession()) == null ? void 0 : _a.media) == null ? void 0 : _b.contentId) === (grant ? new URL(grant.url, origin).href : null);
    };
    const message = (text) => {
      if (!disposed) status.textContent = text;
    };
    const revoke = async (value) => {
      if (value)
        await request(`/api/live/sessions/${session.id}`, { lease: value.lease }, "DELETE").catch(
          () => {
          }
        );
    };
    const render = () => {
      if (disposed || !grant) return;
      if (!ownsReceiver()) {
        void stop(false);
        return;
      }
      pauseButton.textContent = remote.isPaused ? "Play on TV" : "Pause TV";
      message(
        `${remote.isPaused ? "Paused" : "Playing"} on ${receiver.getCastDevice().friendlyName}`
      );
    };
    const disconnected = (event) => {
      if (event.sessionState === framework().SessionState.SESSION_ENDED && grant) void stop(false);
    };
    async function stop(endReceiver = true) {
      var _a, _b;
      const previous = grant;
      grant = null;
      if (controller)
        controller.removeEventListener(framework().RemotePlayerEventType.ANY_CHANGE, render);
      controller = remote = null;
      if (endReceiver && previous && ((_b = (_a = receiver == null ? void 0 : receiver.getMediaSession()) == null ? void 0 : _a.media) == null ? void 0 : _b.contentId) === new URL(previous.url, origin).href)
        receiver.endSession(true);
      receiver = null;
      stopButton.hidden = pauseButton.hidden = true;
      button2.hidden = false;
      await revoke(previous);
      if (!disposed && previous) {
        message("");
        onStop();
      }
    }
    prepare().then((value) => {
      if (disposed) return;
      context = value;
      context.addEventListener(
        framework().CastContextEventType.SESSION_STATE_CHANGED,
        disconnected
      );
      button2.disabled = false;
      button2.title = "Cast to a TV on the same Wi-Fi";
    }).catch((error) => {
      if (!disposed) {
        button2.disabled = false;
        button2.title = error.message;
      }
    });
    button2.disabled = true;
    button2.onclick = async () => {
      if (busy || disposed) return;
      if (!context) {
        message(button2.title || "Casting is loading. Try again.");
        return;
      }
      busy = true;
      button2.disabled = true;
      let pending;
      try {
        await context.requestSession();
        if (disposed) return;
        receiver = context.getCurrentSession();
        if (!receiver) throw Error("No TV connected. Try casting again.");
        pending = await request(`/api/live/sessions/${session.id}/cast`, { lease: session.lease });
        if (disposed) {
          await revoke(pending);
          return;
        }
        const media = window.chrome.cast.media;
        const info = new media.MediaInfo(
          new URL(pending.url, origin).href,
          "application/vnd.apple.mpegurl"
        );
        info.streamType = media.StreamType.LIVE;
        info.hlsSegmentFormat = media.HlsSegmentFormat.TS;
        info.hlsVideoSegmentFormat = media.HlsVideoSegmentFormat.MPEG2_TS;
        info.metadata = new media.GenericMediaMetadata();
        info.metadata.title = session.channel.name;
        await receiver.loadMedia(new media.LoadRequest(info));
        if (disposed) {
          receiver.endSession(true);
          await revoke(pending);
          return;
        }
        grant = pending;
        remote = new (framework()).RemotePlayer();
        controller = new (framework()).RemotePlayerController(remote);
        controller.addEventListener(framework().RemotePlayerEventType.ANY_CHANGE, render);
        button2.hidden = true;
        stopButton.hidden = pauseButton.hidden = false;
        onStart();
        render();
      } catch (error) {
        await revoke(pending);
        message(
          error === "cancel" || (error == null ? void 0 : error.code) === "cancel" ? "Casting cancelled." : "Could not cast. Check that Chrome and your TV are on the same Wi-Fi, then try again."
        );
      } finally {
        busy = false;
        if (!disposed) button2.disabled = false;
      }
    };
    stopButton.onclick = () => {
      void stop();
    };
    pauseButton.onclick = () => controller == null ? void 0 : controller.playOrPause();
    return {
      get active() {
        return !!grant;
      },
      async close() {
        disposed = true;
        if (context)
          context.removeEventListener(
            framework().CastContextEventType.SESSION_STATE_CHANGED,
            disconnected
          );
        await stop();
      }
    };
  }

  // public/sports.js
  var schedule = null;
  var channels = [];
  var liveSession = null;
  var hls = null;
  var heartbeat = null;
  var casting = null;
  var playbackGeneration = 0;
  var timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  function dateKey(time2 = /* @__PURE__ */ new Date()) {
    return `${time2.getFullYear()}-${String(time2.getMonth() + 1).padStart(2, "0")}-${String(time2.getDate()).padStart(2, "0")}`;
  }
  var time = (stamp) => new Intl.DateTimeFormat(void 0, { hour: "2-digit", minute: "2-digit" }).format(stamp);
  var dayLabel = (date) => new Intl.DateTimeFormat(void 0, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  }).format(/* @__PURE__ */ new Date(date + "T12:00:00Z"));
  function sportsUrl(values = {}) {
    const url = new URL(location.hash.slice(1), "http://local");
    for (const [key, value] of Object.entries(values))
      value ? url.searchParams.set(key, value) : url.searchParams.delete(key);
    return "#/sports" + url.search;
  }
  function dateOffset(date, delta) {
    const day = /* @__PURE__ */ new Date(date + "T12:00:00Z");
    day.setUTCDate(day.getUTCDate() + delta);
    return day.toISOString().slice(0, 10);
  }
  var option = (value, label, current) => `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(label)}</option>`;
  var statusLabel = { live: "On now", upcoming: "Upcoming", finished: "Ended" };
  function eventRow(event, admin) {
    const languages = [...new Set(event.channels.map((c) => c.language).filter(Boolean))];
    return `<article class="sports-event"><div class="sports-event-time"><time datetime="${new Date(event.start).toISOString()}">${esc(time(event.start))}</time><span class="sports-status ${event.status}">${statusLabel[event.status]}</span></div><div class="sports-event-main"><p class="sports-competition">${esc([event.sport, event.competition].filter(Boolean).join(" \xB7 "))}</p><h3>${esc(event.title)}</h3>${event.subtitle ? `<p class="meta">${esc(event.subtitle)}</p>` : ""}<p class="meta">${event.channels.length ? `${event.channels.length} channel${event.channels.length === 1 ? "" : "s"}${languages.length ? " \xB7 " + esc(languages.join(" / ")) : ""}` : "No channel linked"} \xB7 Until ${esc(time(event.end))}</p></div><div class="sports-event-actions">${event.status !== "finished" && event.channels.length ? `<button class="${event.status === "live" ? "primary" : ""}" data-action="sports-watch" data-id="${esc(event.id)}">${event.status === "live" ? "Watch" : "View channels"}</button>` : ""}${admin && event.source === "manual" ? `<button class="quiet" data-action="sports-edit" data-id="${esc(event.id)}">Edit</button>` : ""}</div></article>`;
  }
  async function sportsPage(url, user2) {
    void prepareLiveCast().catch(() => {
    });
    const date = url.searchParams.get("date") || dateKey();
    schedule = await api(`/api/sports?${new URLSearchParams({ date, timezone: timezone() })}`);
    const sport = url.searchParams.get("sport") || "", status = url.searchParams.get("status") || "", query = url.searchParams.get("q") || "";
    const admin = user2.role === "admin";
    const matching = schedule.events.filter(
      (e) => (!sport || e.sport === sport) && `${e.title} ${e.competition}`.toLowerCase().includes(query.toLowerCase())
    );
    const filtered = matching.filter((e) => !status || e.status === status);
    const count = (value) => matching.filter((e) => !value || e.status === value).length;
    let html = heading(
      "Live sports",
      "",
      admin ? '<div class="actions"><button data-action="sports-add">Add event</button><button class="quiet" data-action="sports-manage">Manage live TV</button></div>' : ""
    ).replace("page-heading", "page-heading sports-heading");
    html += `<div class="sports-datebar"><div class="actions"><a class="sports-day" href="${esc(sportsUrl({ date: dateOffset(date, -1) }))}" aria-label="Previous day">\u2190</a><h2>${esc(dateLabel(date))}</h2><a class="sports-day" href="${esc(sportsUrl({ date: dateOffset(date, 1) }))}" aria-label="Next day">\u2192</a></div><div class="actions"><a class="sports-day ${date === dateKey() ? "selected" : ""}" href="${esc(sportsUrl({ date: "" }))}">Today</a><label class="sports-date-label">Date<input id="sports-date" type="date" value="${esc(date)}" required></label></div></div>`;
    html += `<div class="sports-filters"><nav class="sports-tabs" aria-label="Event status">${[
      ["", "All events"],
      ["live", "On now"],
      ["upcoming", "Upcoming"]
    ].map(
      ([value, label]) => `<a href="${esc(sportsUrl({ status: value }))}" ${status === value ? 'aria-current="page"' : ""}>${label}<span>${count(value)}</span></a>`
    ).join(
      ""
    )}</nav><form id="sports-filter" class="sports-filter-form"><label>Sport<select name="sport">${option("", "All sports", sport)}${schedule.sports.map((s) => option(s, s, sport)).join("")}</select></label><label>Find an event<input name="q" type="search" value="${esc(query)}" placeholder="Team, event or competition"></label><button>Search</button></form></div>`;
    if (["missing", "unavailable", "stale", "refreshing"].includes(schedule.guideStatus)) {
      const message = schedule.guideStatus === "refreshing" ? "The programme guide is updating." : schedule.guideStatus === "stale" ? "The guide could not be updated. Showing the saved schedule." : schedule.guideStatus === "unavailable" ? "The programme guide is unavailable. Check the guide source or add events." : schedule.guideConfigured ? "The programme guide has not been refreshed." : "Connect a programme guide to fill the daily schedule. Events can also be added manually.";
      html += `<p class="sports-notice" role="status">${esc(message)}${admin ? ' <button class="text-button" data-action="sports-manage">Manage live TV</button>' : ""}</p>`;
    }
    if (!filtered.length)
      html += empty(
        schedule.events.length ? "No matching events" : "No events listed for this day",
        schedule.events.length ? "Try another sport or search." : schedule.channels ? "Check another day, open a channel below, or add a scheduled event." : "Import your live TV playlist to connect channels to matches and events.",
        admin ? '<button data-action="sports-add">Add event</button>' : ""
      );
    for (const [state, title] of [
      ["live", "On now"],
      ["upcoming", date === dateKey() ? "Later today" : "Upcoming"],
      ["finished", "Finished"]
    ]) {
      const items = filtered.filter((e) => e.status === state);
      if (items.length)
        html += `<section class="sports-section"><div class="section-heading"><h2>${title}</h2><span class="meta">${items.length} event${items.length === 1 ? "" : "s"}</span></div>${items.map((e) => eventRow(e, admin)).join("")}</section>`;
    }
    html += `<section class="sports-channels section"><button data-action="sports-channels">Browse channels (${schedule.channels})</button><p class="meta">Times shown in ${esc(schedule.timezone)}. \u201COn now\u201D follows the scheduled broadcast time.</p></section>`;
    return html;
  }
  function dateLabel(date) {
    return `${date === dateKey() ? "Today \xB7 " : ""}${dayLabel(date)}`;
  }
  function bindSportsFilters() {
    $("#sports-date").onchange = (e) => {
      if (e.target.value) location.hash = sportsUrl({ date: e.target.value });
    };
    $("#sports-filter").onsubmit = (e) => {
      e.preventDefault();
      const data = new FormData(e.target);
      location.hash = sportsUrl({ sport: data.get("sport"), q: data.get("q") });
    };
    $("#sports-filter select").onchange = () => $("#sports-filter").requestSubmit ? $("#sports-filter").requestSubmit() : $("#sports-filter").dispatchEvent(new Event("submit", { cancelable: true }));
  }
  async function loadChannels() {
    channels = (await api("/api/live/channels")).items;
    return channels;
  }
  function channelButtons(items) {
    return items.map(
      (c) => `<button class="sports-channel" data-action="sports-play" data-id="${esc(c.id)}"><strong>${esc(c.name)}</strong><span class="meta">${esc([c.language, c.quality].filter(Boolean).join(" \xB7 "))}</span></button>`
    ).join("");
  }
  function bindDialog(context) {
    $("#dialog-content").onclick = (e) => {
      const b = e.target.closest("[data-action]");
      if (!b) return;
      b.disabled = true;
      void sportsAction(b, context).catch((error) => toast(error.message)).finally(() => {
        b.disabled = false;
      });
    };
  }
  async function sportsAction(button2, context) {
    const action2 = button2.dataset.action, key = button2.dataset.id;
    if (action2 === "sports-watch") {
      const event = schedule.events.find((e) => e.id === key);
      modal(
        `<h2>${esc(event.title)}</h2><p class="meta">${event.status === "upcoming" ? `Scheduled for ${esc(time(event.start))}. Opening a channel plays its current broadcast.` : "Choose a channel"}</p><div class="sports-channel-list">${channelButtons(event.channels)}</div>`
      );
      bindDialog(context);
    } else if (action2 === "sports-channels") {
      await loadChannels();
      modal(
        '<h2>Live channels</h2><label class="section">Find a channel<input id="channel-search" type="search"></label><div id="channel-results" class="sports-channel-list"></div>'
      );
      const render = () => {
        const q = $("#channel-search").value.toLowerCase();
        const found = channels.filter((c) => `${c.name} ${c.language}`.toLowerCase().includes(q));
        $("#channel-results").innerHTML = channelButtons(found.slice(0, 100)) + (found.length > 100 ? '<p class="meta">Search to narrow the channel list.</p>' : !found.length ? '<p class="meta">No channels found.</p>' : "");
      };
      $("#channel-search").oninput = render;
      render();
      bindDialog(context);
    } else if (action2 === "sports-play") {
      closeModal();
      await context.closeVod();
      await playLive(key);
    } else if (action2 === "sports-manage") {
      const status = await api("/api/admin/live");
      modal(
        `<h2>Manage live TV</h2><p class="meta">${status.channels} channels \xB7 Guide: ${esc(status.guideStatus)}${status.guideUpdatedAt ? " \xB7 Updated " + esc(new Date(status.guideUpdatedAt).toLocaleString()) : ""}</p><form id="live-import" class="form section"><h3>Import playlist</h3><label>M3U file<input name="playlist" type="file" accept=".m3u,.m3u8,text/plain" required></label><p class="meta">Replaces the channel list. Provider credentials stay on the server.</p><button>Import channels</button></form><form id="live-settings" class="form section"><h3>Programme guide</h3><label>XMLTV guide URL<input name="guideUrl" type="url" placeholder="${status.guideConfigured ? "Leave blank to keep the current guide" : "https://provider.example/guide.xml"}" autocomplete="off"></label><label>Simultaneous channels<select name="maxConnections">${[1, 2, 3, 4].map((n) => option(String(n), String(n), String(status.maxConnections))).join("")}</select></label><p class="meta">Use the connection limit allowed by your provider.</p><div class="actions"><button>Save settings</button><button type="button" data-action="sports-refresh-guide">Refresh guide</button></div><p id="live-settings-result" class="meta" role="status"></p></form>`
      );
      bindDialog(context);
      $("#live-import").onsubmit = async (e) => {
        e.preventDefault();
        const b = e.target.querySelector("button");
        b.disabled = true;
        try {
          const file = e.target.elements.playlist.files[0];
          if (file.size > 12 * 1024 * 1024) throw Error("Playlist must be smaller than 12 MB");
          const playlist = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(Error("The playlist could not be read"));
            reader.readAsText(file);
          });
          await api("/api/admin/live/import", { playlist });
          closeModal();
          await context.refresh();
          toast("Channels imported");
        } catch (error) {
          toast(error.message);
        } finally {
          b.disabled = false;
        }
      };
      $("#live-settings").onsubmit = async (e) => {
        e.preventDefault();
        const b = e.target.querySelector("button");
        b.disabled = true;
        const data = new FormData(e.target), guideUrl = String(data.get("guideUrl")).trim();
        try {
          await api(
            "/api/admin/live",
            { ...guideUrl ? { guideUrl } : {}, maxConnections: Number(data.get("maxConnections")) },
            "PATCH"
          );
          $("#live-settings-result").textContent = "Settings saved. Refresh the guide to update events.";
          await context.refresh();
        } catch (error) {
          toast(error.message);
        } finally {
          b.disabled = false;
        }
      };
    } else if (action2 === "sports-refresh-guide") {
      button2.textContent = "Refreshing\u2026";
      try {
        const result = await api("/api/admin/live/refresh", {});
        toast(
          result.guideStatus === "ready" ? "Programme guide updated" : result.guideConfigured ? "Guide update failed. Check the source and try again." : "Add a guide URL first"
        );
        await context.refresh();
        if ($("#live-settings-result"))
          $("#live-settings-result").textContent = `Guide: ${result.guideStatus}`;
      } finally {
        button2.textContent = "Refresh guide";
      }
    } else if (action2 === "sports-add" || action2 === "sports-edit") {
      await loadChannels();
      const event = action2 === "sports-edit" ? schedule.events.find((e) => e.id === key) : null;
      const localInput = (stamp) => {
        const d = new Date(stamp);
        return dateKey(d) + "T" + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      };
      const date = schedule.date;
      modal(
        `<h2>${event ? "Edit event" : "Add event"}</h2><form id="sports-event-form" class="form section"><label>Match or event<input name="title" value="${esc((event == null ? void 0 : event.title) || "")}" maxlength="180" required placeholder="Home team vs Away team"></label><div class="sports-form-pair"><label>Sport<select name="sport">${schedule.sports.map((s) => option(s, s, (event == null ? void 0 : event.sport) || "Football")).join("")}</select></label><label>Competition<input name="competition" value="${esc((event == null ? void 0 : event.competition) || "")}" maxlength="100"></label></div><div class="sports-form-pair"><label>Starts<input name="start" type="datetime-local" value="${event ? localInput(event.start) : date + "T18:00"}" required></label><label>Ends<input name="end" type="datetime-local" value="${event ? localInput(event.end) : date + "T20:00"}" required></label></div><p class="meta">Times in ${esc(timezone())}.</p><fieldset class="sports-channel-picker"><legend>Channels</legend><label>Find a channel<input id="event-channel-search" type="search"></label><div id="event-channel-options"></div><p id="event-channel-count" class="meta" role="status"></p></fieldset><div class="actions"><button class="primary">Save event</button>${event ? `<button type="button" data-action="sports-delete" data-id="${esc(event.id)}">Delete event</button>` : ""}</div></form>`
      );
      bindDialog(context);
      const selected = new Set((event == null ? void 0 : event.channelIds) || []);
      const render = () => {
        const q = $("#event-channel-search").value.toLowerCase();
        const items = channels.filter((c) => `${c.name} ${c.language}`.toLowerCase().includes(q)).sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id))).slice(0, 80);
        $("#event-channel-options").innerHTML = items.map(
          (c) => `<label class="check"><input type="checkbox" value="${esc(c.id)}" ${selected.has(c.id) ? "checked" : ""}>${esc(c.name)} <span class="meta">${esc(c.language)}</span></label>`
        ).join("") || '<p class="meta">No channels found.</p>';
        $("#event-channel-count").textContent = `${selected.size} selected${channels.length > 80 ? " \xB7 Search to find more channels" : ""}`;
      };
      $("#event-channel-search").oninput = render;
      $("#event-channel-options").onchange = (e) => {
        if (e.target.checked) selected.add(e.target.value);
        else selected.delete(e.target.value);
        $("#event-channel-count").textContent = `${selected.size} selected`;
      };
      render();
      $("#sports-event-form").onsubmit = async (e) => {
        e.preventDefault();
        const b = e.target.querySelector("button");
        b.disabled = true;
        try {
          const data = Object.fromEntries(new FormData(e.target));
          await api(
            `/api/admin/sports/events${event ? "/" + event.id : ""}`,
            {
              title: data.title,
              sport: data.sport,
              competition: data.competition,
              start: new Date(data.start).toISOString(),
              end: new Date(data.end).toISOString(),
              channelIds: [...selected]
            },
            event ? "PUT" : "POST"
          );
          closeModal();
          await context.refresh();
          toast("Event saved");
        } catch (error) {
          toast(error.message);
        } finally {
          b.disabled = false;
        }
      };
    } else if (action2 === "sports-delete") {
      await api(`/api/admin/sports/events/${key}`, {}, "DELETE");
      closeModal();
      await context.refresh();
      toast("Event deleted");
    }
  }
  var livePlaying = () => !!$("#live-player");
  async function closeLive() {
    var _a;
    ++playbackGeneration;
    const cast = casting;
    casting = null;
    await (cast == null ? void 0 : cast.close());
    clearInterval(heartbeat);
    heartbeat = null;
    const session = liveSession;
    liveSession = null;
    if (hls) {
      hls.destroy();
      hls = null;
    }
    const video2 = $("#live-video");
    if (video2) {
      video2.pause();
      video2.removeAttribute("src");
      video2.load();
    }
    const player = $("#live-player"), restore = player == null ? void 0 : player.restoreFocus;
    player == null ? void 0 : player.remove();
    restore == null ? void 0 : restore.focus();
    if (((_a = document.fullscreenElement) == null ? void 0 : _a.id) === "live-video")
      await document.exitFullscreen().catch(() => {
      });
    if (session)
      await api(`/api/live/sessions/${session.id}`, { lease: session.lease }, "DELETE").catch(
        () => {
        }
      );
  }
  async function playLive(channelId) {
    var _a;
    await closeLive();
    const ticket = ++playbackGeneration;
    const player = document.createElement("section");
    player.id = "live-player";
    player.setAttribute("aria-label", "Live TV player");
    player.tabIndex = -1;
    player.restoreFocus = document.activeElement;
    player.innerHTML = '<header><button id="live-close">Back to sports</button><strong id="live-channel-name">Opening channel\u2026</strong><span class="sports-status live">Live TV</span><button id="live-cast" disabled>Cast to TV</button><button id="live-cast-pause" hidden>Pause TV</button><button id="live-cast-stop" hidden>Stop casting</button></header><video id="live-video" controls playsinline></video><p id="live-player-status" role="status">Starting live playback\u2026</p>';
    document.body.appendChild(player);
    $("#live-close").onclick = closeLive;
    $("#live-close").focus();
    try {
      const session = await api(`/api/live/channels/${channelId}/play`, {});
      if (ticket !== playbackGeneration) {
        await api(`/api/live/sessions/${session.id}`, { lease: session.lease }, "DELETE").catch(
          () => {
          }
        );
        return;
      }
      liveSession = session;
      $("#live-channel-name").textContent = session.channel.name;
      heartbeat = setInterval(() => {
        void api(`/api/live/sessions/${session.id}/heartbeat`, { lease: session.lease }).catch(
          (error) => {
            clearInterval(heartbeat);
            if ($("#live-player-status")) $("#live-player-status").textContent = error.message;
          }
        );
      }, 15e3);
      const video2 = $("#live-video");
      const play2 = () => video2.play().catch(() => {
        $("#live-player-status").textContent = "Press play to watch this channel.";
      });
      video2.onplaying = () => {
        if (!(casting == null ? void 0 : casting.active)) $("#live-player-status").textContent = "";
      };
      video2.onwaiting = () => {
        if (!(casting == null ? void 0 : casting.active)) $("#live-player-status").textContent = "Buffering\u2026";
      };
      video2.onerror = () => {
        $("#live-player-status").textContent = "Playback stopped. Return to sports and try this channel again.";
      };
      if ((_a = window.Hls) == null ? void 0 : _a.isSupported()) {
        hls = new window.Hls();
        hls.loadSource(session.url);
        hls.attachMedia(video2);
        hls.on(window.Hls.Events.MANIFEST_PARSED, play2);
        hls.on(window.Hls.Events.ERROR, (_event, data) => {
          if (data.fatal && $("#live-player-status"))
            $("#live-player-status").textContent = "The channel stopped responding. Return to sports and try another channel.";
        });
      } else if (video2.canPlayType("application/vnd.apple.mpegurl")) {
        video2.src = session.url;
        await play2();
      } else {
        await closeLive();
        toast("This browser cannot play live HLS video.");
      }
      if (ticket === playbackGeneration && liveSession)
        casting = bindLiveCast({
          session,
          button: $("#live-cast"),
          stopButton: $("#live-cast-stop"),
          pauseButton: $("#live-cast-pause"),
          status: $("#live-player-status"),
          onStart: () => {
            video2.pause();
            hls == null ? void 0 : hls.stopLoad();
          },
          onStop: () => {
            hls == null ? void 0 : hls.startLoad(-1);
            void play2();
          }
        });
    } catch (error) {
      if (ticket === playbackGeneration) {
        await closeLive();
        toast(error.message);
      }
    }
  }
  window.addEventListener("pagehide", () => {
    if (liveSession)
      void fetch(`/api/live/sessions/${liveSession.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lease: liveSession.lease }),
        keepalive: true
      }).catch(() => {
      });
  });

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
      <label>Quality<select name="resolution">${data.resolutions.map((resolution) => `<option value="${resolution}">${resolution}p WEB-DL</option>`).join("")}</select></label>
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
        const items = data.items.map((r, index) => ({ ...r, index })).filter((r) => r.qualityAccepted && (!direct || r.accepted || rejected));
        if (direct)
          items.sort(
            (a, b) => Number(b.accepted) - Number(a.accepted) || (b.seeders || 0) - (a.seeders || 0)
          );
        $("#dialog-content").innerHTML = `<h2>Choose a release</h2><label>Download with<select id="release-provider"><option value="torrent" ${direct ? "selected" : ""} ${!data.torrentConfigured ? "disabled" : ""}>Direct torrent \xB7 qBittorrent</option><option value="realdebrid" ${!direct ? "selected" : ""} ${!data.debridConfigured ? "disabled" : ""}>Real-Debrid</option></select></label>
        <p class="meta">${esc(data.qualityRule)}. Required for both providers. No quality fallback.</p>
        <p class="meta">${direct ? `At least ${data.rules.minSeeders} reported seeders \xB7 ${data.rules.movieMaxGB} GB movies / ${data.rules.episodeMaxGB} GB episodes. Counts may be stale; live progress is checked after selection. Direct torrents connect this PC to peers.` : "Download the original file through Real-Debrid."}</p>
        ${direct ? `<label class="check"><input id="show-rejected" type="checkbox" ${rejected ? "checked" : ""}>Show filtered releases (${data.items.filter((r) => r.qualityAccepted && !r.accepted).length})</label>` : ""}
        ${items.map((r) => `<button class="release" data-release="${r.index}" ${direct && !r.accepted ? "disabled" : ""}>${esc(r.label)}${direct ? `<span class="meta">${r.accepted ? "Meets search rules" : esc(r.reasons.join(" \xB7 "))}</span>` : ""}</button>`).join("")}
        ${!items.length ? `<p>No releases meet these rules. ${esc(data.qualityRule)} is required; other qualities and sources cannot be selected.</p>` : ""}`;
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
    return `<section class="section"><form id="torrent-rules" class="form"><h2>Torrent rules</h2><p class="meta">qBittorrent: ${admin.torrentConfigured ? "Configured" : "Not configured"}. Rules apply to new jobs and retries. Existing jobs keep their saved rules. CAM / TS / screeners are always excluded.</p><p class="meta">Required quality for both providers: 1080p WEB-DL for anime and TV shows \xB7 2160p WEB-DL for movies. This rule cannot be changed.</p>${fields.map(([key, label, min, max, step]) => `<label>${label}<input type="number" name="${key}" min="${min}" max="${max}" step="${step}" required value="${r[key]}"></label>`).join("")}
    <label class="check"><input type="checkbox" name="rejectUnknown" ${r.rejectUnknown ? "checked" : ""}>Reject unknown seed count or size</label><p class="meta">Timeouts stop the selected torrent and retain partial data. They never choose another release automatically. Uploads can continue until the ratio or time limit is reached.</p><button class="primary">Save torrent rules</button><button type="button" id="torrent-health">Test connection</button><p id="torrent-status" role="status"></p></form></section>`;
  }
  function bindTorrentRules() {
    const form = $("#torrent-rules");
    if (!form) return;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = new FormData(form), payload = {};
      for (const [key, value] of data)
        if (!["resolutions", "rejectUnknown"].includes(key)) payload[key] = Number(value);
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

  // public/subtitles.js
  var subtitleSizes = [
    ["s", "Small", 0.03],
    ["m", "Medium", 0.038],
    ["l", "Large", 0.048],
    ["xl", "Extra large", 0.06],
    ["xxl", "Huge", 0.075]
  ];
  var subtitleColors = [
    ["white", "White", "#ffffff"],
    ["yellow", "Yellow", "#ffe066"],
    ["green", "Green", "#a5e6a2"],
    ["cyan", "Cyan", "#8ce4ef"],
    ["pink", "Pink", "#ffb3d1"],
    ["grey", "Grey", "#c9ced8"],
    ["black", "Black", "#000000"]
  ];
  var subtitleBackgrounds = [
    ["none", "None", null],
    ["black", "Black", "#000000"],
    ["grey", "Grey", "#333333"],
    ["white", "White", "#ffffff"],
    ["navy", "Deep blue", "#101a34"],
    ["yellow", "Yellow", "#ffe867"]
  ];
  var subtitleDefaults = {
    size: "m",
    color: "white",
    bg: "black",
    bgOpacity: 0.75,
    pos: 6,
    align: "center"
  };
  function subtitleStyle(saved) {
    const s = { ...subtitleDefaults };
    if (!saved || typeof saved !== "object") return s;
    for (const [key, choices] of [
      ["size", subtitleSizes],
      ["color", subtitleColors],
      ["bg", subtitleBackgrounds]
    ])
      if (choices.some(([id]) => id === saved[key])) s[key] = saved[key];
    if (["left", "center", "right"].includes(saved.align)) s.align = saved.align;
    if (Number.isFinite(saved.pos)) s.pos = Math.max(0, Math.min(80, Math.round(saved.pos)));
    if (Number.isFinite(saved.bgOpacity)) s.bgOpacity = Math.max(0, Math.min(1, saved.bgOpacity));
    return s;
  }
  function srtToVtt(text) {
    text = text.replace(/^\uFEFF/, "").replace(/\r/g, "");
    return /^WEBVTT(?:\s|$)/.test(text) ? text : "WEBVTT\n\n" + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  }
  function decodeSubtitle(bytes, language = "") {
    const buffer = new Uint8Array(bytes);
    if (buffer[0] === 255 && buffer[1] === 254) return new TextDecoder("utf-16le").decode(buffer);
    if (buffer[0] === 254 && buffer[1] === 255) return new TextDecoder("utf-16be").decode(buffer);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      const encodings = {
        ara: "windows-1256",
        ar: "windows-1256",
        per: "windows-1256",
        fas: "windows-1256",
        rus: "windows-1251",
        bul: "windows-1251",
        ukr: "windows-1251",
        srp: "windows-1251",
        gre: "windows-1253",
        ell: "windows-1253",
        heb: "windows-1255",
        tur: "windows-1254",
        tha: "windows-874",
        vie: "windows-1258"
      };
      return new TextDecoder(encodings[language.toLowerCase()] || "windows-1252").decode(buffer);
    }
  }
  var isArabic = (language) => /^(ar|ara)(-|$)/i.test(language || "");
  var subtitleLanguageLabel = (language) => isArabic(language) ? "Arabic \xB7 \u0627\u0644\u0639\u0631\u0628\u064A\u0629" : language;
  function shiftSubtitleCues(cues, delay, offset = 0, originals = /* @__PURE__ */ new WeakMap()) {
    for (const cue of Array.from(cues || [])) {
      if (!originals.has(cue)) originals.set(cue, [cue.startTime, cue.endTime]);
      const [start, end] = originals.get(cue);
      cue.startTime = start + delay - offset;
      cue.endTime = end + delay - offset;
    }
    return originals;
  }
  function createSubtitleRenderer(video2, layer) {
    let style, track = null, preview = false;
    try {
      style = subtitleStyle(JSON.parse(localStorage.getItem("mw:substyle")));
    } catch {
      style = subtitleStyle();
    }
    function render() {
      layer.textContent = "";
      const cues = preview ? [] : Array.from((track == null ? void 0 : track.track.cues) || []).filter(
        (cue) => cue.startTime <= video2.currentTime && cue.endTime > video2.currentTime
      );
      layer.hidden = !preview && !cues.length;
      if (layer.hidden) return;
      const bounds = video2.getBoundingClientRect(), parent = layer.parentElement.getBoundingClientRect();
      const scale = video2.videoWidth && video2.videoHeight ? Math.min(bounds.width / video2.videoWidth, bounds.height / video2.videoHeight) : 1;
      const width = video2.videoWidth ? video2.videoWidth * scale : bounds.width;
      const height = video2.videoHeight ? video2.videoHeight * scale : bounds.height;
      Object.assign(layer.style, {
        left: `${bounds.left - parent.left + (bounds.width - width) / 2}px`,
        top: `${bounds.top - parent.top + (bounds.height - height) / 2}px`,
        width: `${width}px`,
        height: `${height}px`
      });
      const stacks = {};
      function add(content, edge = "bottom") {
        if (!stacks[edge]) {
          const stack = document.createElement("div");
          stack.className = "subtitle-stack";
          stack.style[edge] = `${style.pos}%`;
          stack.style.alignItems = { left: "flex-start", center: "center", right: "flex-end" }[style.align];
          layer.appendChild(stack);
          stacks[edge] = stack;
        }
        const box = document.createElement("div");
        box.className = "subtitle-cue";
        box.dir = "auto";
        const color = subtitleColors.find(([id]) => id === style.color)[2];
        const bg = subtitleBackgrounds.find(([id]) => id === style.bg)[2];
        const rgb = bg && [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16)).join(",");
        Object.assign(box.style, {
          fontSize: `${Math.max(13, height * subtitleSizes.find(([id]) => id === style.size)[2])}px`,
          color,
          textAlign: style.align,
          background: bg ? `rgba(${rgb},${style.bgOpacity})` : "transparent",
          textShadow: bg && style.bgOpacity >= 0.5 ? "none" : "0 0 4px #000, 0 2px 5px #000"
        });
        if (typeof content === "string") box.textContent = content;
        else box.appendChild(content);
        stacks[edge].appendChild(box);
      }
      if (preview) add("Subtitles will look like this.");
      for (const cue of cues) {
        const top = cue.line !== "auto" && Number.isFinite(Number(cue.line)) && (cue.snapToLines === false ? Number(cue.line) < 50 : Number(cue.line) >= 0 && Number(cue.line) < 6);
        add(
          cue.getCueAsHTML ? cue.getCueAsHTML() : String(cue.text).replace(/<[^>]*>/g, ""),
          top ? "top" : "bottom"
        );
      }
    }
    const renderer = {
      get style() {
        return style;
      },
      set(next) {
        style = subtitleStyle(next);
        try {
          localStorage.setItem("mw:substyle", JSON.stringify(style));
        } catch {
        }
        render();
      },
      reset() {
        this.set(subtitleDefaults);
      },
      preview(on) {
        preview = on;
        render();
      },
      attach(element) {
        this.detach();
        track = element;
        track.track.mode = "hidden";
        track.track.addEventListener("cuechange", render);
        render();
      },
      detach() {
        track == null ? void 0 : track.track.removeEventListener("cuechange", render);
        track = null;
        render();
      },
      render
    };
    window.addEventListener("resize", render);
    document.addEventListener("fullscreenchange", render);
    video2.addEventListener("loadedmetadata", render);
    video2.addEventListener("resize", render);
    video2.addEventListener("timeupdate", render);
    return renderer;
  }

  // public/player.js
  var subtitleRenderer = null;
  var active = null;
  var queue = null;
  var hls2 = null;
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
    subtitles: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M10 9H7v6h3m7-6h-3v6h3"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>'
  };
  function iconButton(id, icon2, label, shortcut = "") {
    const button2 = $("#" + id);
    if (button2.dataset.icon !== icon2) {
      button2.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icons[icon2]}</svg>`;
      button2.dataset.icon = icon2;
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
    if (!active || video().paused || loading || keyboardControls || !$("#player-settings").hidden || !$("#player-subtitles").hidden)
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
  function closeSubtitles(restoreFocus2 = false) {
    $("#player-subtitles").hidden = true;
    $("#player-subtitles-toggle").setAttribute("aria-expanded", "false");
    subtitleRenderer == null ? void 0 : subtitleRenderer.preview(false);
    if (restoreFocus2) $("#player-subtitles-toggle").focus();
    showControls();
  }
  function openSubtitles() {
    closeSettings();
    $("#player-subtitles").hidden = false;
    $("#player-subtitles-toggle").setAttribute("aria-expanded", "true");
    subtitleRenderer.preview($("#subtitle-appearance").open);
    showControls();
    $("#subtitles").focus();
  }
  function clearSubtitleTrack() {
    subtitleRenderer == null ? void 0 : subtitleRenderer.detach();
    for (const track of Array.from(video().textTracks || [])) track.mode = "disabled";
    video().querySelectorAll("track").forEach((t) => t.remove());
  }
  function releaseSubtitleFile() {
    clearSubtitleTrack();
    if (active == null ? void 0 : active.subtitleFile) URL.revokeObjectURL(active.subtitleFile);
    $("#subtitle-file").value = "";
  }
  var playing = () => !!active;
  function currentQueue() {
    return queue;
  }
  function replaceQueue(next) {
    queue = next;
  }
  async function releaseConversion() {
    if (hls2) {
      hls2.destroy();
      hls2 = null;
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
    releaseSubtitleFile();
    await releaseConversion();
    video().removeAttribute("src");
    video().load();
    active = null;
    clearTimeout(controlsTimer);
    closeSettings();
    closeSubtitles();
    queue = null;
    loading = false;
    $("#player").hidden = true;
    document.body.classList.remove("player-open");
    $("#shell").removeAttribute("inert");
    window.dispatchEvent(new Event("library-changed"));
  }
  async function play(itemId, titleId, { replay = false, queueId = null } = {}) {
    var _a, _b, _c;
    await closeLive();
    clearInterval(timer);
    cancelNext();
    await report("stop");
    loading = true;
    video().pause();
    releaseSubtitleFile();
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
        pendingPosition: session.position,
        subtitleDelay: 0,
        onlineSubtitles: []
      };
      try {
        const saved = Number(localStorage.getItem(`mw:subsync:${itemId}`));
        if (Number.isFinite(saved)) active.subtitleDelay = Math.max(-120, Math.min(120, saved));
      } catch {
      }
      $("#subtitle-delay").value = String(active.subtitleDelay);
      $("#subtitle-status").textContent = "";
      $("#subtitle-find").disabled = false;
      $("#player-subtitles-toggle").classList.remove("subtitles-active");
      scrubbing = false;
      updateTransport();
      $("#player").hidden = false;
      document.body.classList.add("player-open");
      closeSettings();
      closeSubtitles();
      $("#shell").setAttribute("inert", "");
      $("#player-title").textContent = title.name;
      $("#player-episode").textContent = title.kind === "movie" ? "" : `${episodeLabel(item)}${item.name ? " \xB7 " + item.name : ""}`;
      $("#player-message").textContent = "";
      $("#audio").innerHTML = info.audio.map(
        (t) => `<option value="${t.index}">${esc(t.language)} \xB7 ${esc(t.title || t.codec)} ${t.channels || ""}</option>`
      ).join("");
      const supportedSubtitles = info.subtitles.filter(
        (t) => ["subrip", "ass", "ssa", "webvtt", "mov_text"].includes(t.codec)
      );
      $("#subtitles").innerHTML = '<option value="">Off</option>' + supportedSubtitles.map(
        (t) => `<option value="${t.index}">${esc(subtitleLanguageLabel(t.language))} \xB7 ${esc(t.title || t.codec)}</option>`
      ).join("");
      if (!supportedSubtitles.length)
        $("#subtitle-status").textContent = info.subtitles.length ? "This file only has image subtitles. Find online subtitles or open an SRT/VTT file." : "No subtitles in this file. Find online subtitles or open an SRT/VTT file.";
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
        const track = supportedSubtitles.find(
          (t) => t.language === preferences.subtitleLanguage || isArabic(t.language) && isArabic(preferences.subtitleLanguage)
        );
        if (track) {
          $("#subtitles").value = String(track.index);
          setSubtitles();
        }
      }
      loading = false;
      active.pendingPosition = null;
      updateTransport();
      timer = setInterval(() => void report(), 1e4);
      if (preferences.subtitleMode === "preferred" && preferences.subtitleLanguage && $("#subtitles").value === "")
        void findSubtitles(true);
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
    clearSubtitleTrack();
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
        hls2 = new window.Hls({ startPosition: 0, lowLatencyMode: false });
        hls2.loadSource(url);
        hls2.attachMedia(video());
        hls2.on(window.Hls.Events.ERROR, (_, data) => {
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
    var _a, _b, _c;
    clearSubtitleTrack();
    const index = $("#subtitles").value;
    $("#player-subtitles-toggle").classList.toggle("subtitles-active", index !== "");
    if (index === "" || !active) return;
    const owner = active;
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = ((_a = $("#subtitles").selectedOptions[0]) == null ? void 0 : _a.textContent) || "Subtitles";
    const language = index.startsWith("online:") ? (_b = active.onlineSubtitles.find((t) => t.id === index.slice(7))) == null ? void 0 : _b.language : (_c = active.info.subtitles.find((t) => String(t.index) === index)) == null ? void 0 : _c.language;
    if (language) track.srclang = isArabic(language) ? "ar" : language;
    const external = index.startsWith("online:") || index === "file";
    track.src = index === "file" ? active.subtitleFile : index.startsWith("online:") ? `/api/items/${active.item.id}/subtitles/online/${encodeURIComponent(index.slice(7))}` : `/api/items/${active.item.id}/subtitles/${index}?offset=${active.offset}`;
    track.default = true;
    const originals = /* @__PURE__ */ new WeakMap();
    active.syncSubtitles = () => {
      if (active !== owner || !track.isConnected) return;
      shiftSubtitleCues(
        track.track.cues,
        active.subtitleDelay,
        external ? active.offset : 0,
        originals
      );
      subtitleRenderer.render();
    };
    track.addEventListener("load", () => {
      if (active !== owner || !track.isConnected) return;
      active.syncSubtitles();
      $("#subtitle-status").textContent = "";
    });
    track.addEventListener("error", () => {
      if (active !== owner || !track.isConnected) return;
      $("#subtitle-status").textContent = "These subtitles could not be loaded. Choose another track or open a subtitle file.";
      toast("These subtitles could not be loaded");
    });
    video().appendChild(track);
    subtitleRenderer.attach(track);
  }
  async function findSubtitles(selectPreferred = false) {
    var _a;
    if (!active || $("#subtitle-find").disabled) return;
    const owner = active;
    $("#subtitle-find").disabled = true;
    $("#subtitle-status").textContent = "Finding subtitles\u2026";
    try {
      const tracks = await api(`/api/items/${owner.item.id}/subtitles`);
      if (active !== owner) return;
      const selection = $("#subtitles").value;
      active.onlineSubtitles = tracks;
      (_a = $("#subtitles-online")) == null ? void 0 : _a.remove();
      if (tracks.length) {
        const group = document.createElement("optgroup");
        group.id = "subtitles-online";
        group.label = "Online \xB7 OpenSubtitles";
        group.innerHTML = tracks.map((t) => `<option value="online:${esc(t.id)}">${esc(t.label)}</option>`).join("");
        $("#subtitles").appendChild(group);
        $("#subtitles").value = selection;
        if (selectPreferred && !selection && !active.subtitleUserChoice) {
          const preferred = tracks.find(
            (t) => t.language === active.preferences.subtitleLanguage || isArabic(t.language) && isArabic(active.preferences.subtitleLanguage)
          );
          if (preferred) {
            $("#subtitles").value = `online:${preferred.id}`;
            setSubtitles();
          }
        }
      }
      $("#subtitle-status").textContent = tracks.length ? "Choose an online track. Adjust delay if needed." : "No online subtitles found. You can open an SRT/VTT file.";
    } catch (error) {
      if (active === owner)
        $("#subtitle-status").textContent = `${error.message} You can open an SRT/VTT file.`;
    } finally {
      if (active === owner) $("#subtitle-find").disabled = false;
    }
  }
  function updateSubtitleStyleControls() {
    for (const [id, key] of [
      ["size", "size"],
      ["color", "color"],
      ["bg", "bg"],
      ["bg-opacity", "bgOpacity"],
      ["pos", "pos"],
      ["align", "align"]
    ])
      $("#subtitle-" + id).value = String(subtitleRenderer.style[key]);
    $("#subtitle-bg-opacity").disabled = subtitleRenderer.style.bg === "none";
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
    subtitleRenderer = createSubtitleRenderer(video(), $("#subtitle-layer"));
    for (const [id, choices] of [
      ["size", subtitleSizes],
      ["color", subtitleColors],
      ["bg", subtitleBackgrounds]
    ])
      $("#subtitle-" + id).innerHTML = choices.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
    updateSubtitleStyleControls();
    for (const [id, key] of [
      ["size", "size"],
      ["color", "color"],
      ["bg", "bg"],
      ["bg-opacity", "bgOpacity"],
      ["pos", "pos"],
      ["align", "align"]
    ])
      $("#subtitle-" + id).onchange = () => {
        const value = $("#subtitle-" + id).value;
        subtitleRenderer.set({
          ...subtitleRenderer.style,
          [key]: ["pos", "bgOpacity"].includes(key) ? Number(value) : value
        });
        updateSubtitleStyleControls();
      };
    $("#subtitle-style-reset").onclick = () => {
      subtitleRenderer.reset();
      updateSubtitleStyleControls();
    };
    $("#subtitle-pos").oninput = () => {
      const value = $("#subtitle-pos").value;
      if (value !== "" && Number.isFinite(Number(value)))
        subtitleRenderer.set({ ...subtitleRenderer.style, pos: Number(value) });
    };
    $("#subtitle-appearance").ontoggle = () => subtitleRenderer.preview($("#subtitle-appearance").open && !$("#player-subtitles").hidden);
    const changeSubtitleDelay = (normalize) => {
      var _a;
      if (!active) return;
      const delay = Number($("#subtitle-delay").value);
      active.subtitleDelay = Number.isFinite(delay) ? Math.max(-120, Math.min(120, delay)) : 0;
      if (normalize) $("#subtitle-delay").value = String(active.subtitleDelay);
      try {
        localStorage.setItem(`mw:subsync:${active.item.id}`, String(active.subtitleDelay));
      } catch {
      }
      (_a = active.syncSubtitles) == null ? void 0 : _a.call(active);
    };
    $("#subtitle-delay").onchange = () => changeSubtitleDelay(true);
    $("#subtitle-delay").oninput = () => {
      if ($("#subtitle-delay").value !== "") changeSubtitleDelay(false);
    };
    $("#subtitle-sync-reset").onclick = () => {
      $("#subtitle-delay").value = "0";
      $("#subtitle-delay").onchange();
    };
    $("#subtitle-find").onclick = () => void findSubtitles();
    $("#subtitle-file").onchange = async () => {
      var _a;
      const file = $("#subtitle-file").files[0] || (active == null ? void 0 : active.subtitleUpload), owner = active;
      if (!file || !owner) return;
      try {
        if (file.size > 2 * 1024 * 1024) throw new Error("Choose a subtitle file smaller than 2 MB.");
        const text = srtToVtt(
          decodeSubtitle(
            await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(new Error("This subtitle file could not be read."));
              reader.readAsArrayBuffer(file);
            }),
            $("#subtitle-file-encoding").value || owner.preferences.subtitleLanguage
          )
        );
        if (!/(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s*-->/.test(text))
          throw new Error("Choose a valid SRT or WebVTT file.");
        if (active !== owner) return;
        active.subtitleUpload = file;
        active.subtitleUserChoice = true;
        if (active.subtitleFile) URL.revokeObjectURL(active.subtitleFile);
        active.subtitleFile = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
        (_a = $("#subtitle-file-option")) == null ? void 0 : _a.remove();
        const option3 = document.createElement("option");
        option3.id = "subtitle-file-option";
        option3.value = "file";
        option3.textContent = file.name;
        $("#subtitles").appendChild(option3);
        $("#subtitles").value = "file";
        setSubtitles();
      } catch (error) {
        if (active === owner) $("#subtitle-status").textContent = error.message;
      } finally {
        if (active === owner) $("#subtitle-file").value = "";
      }
    };
    $("#subtitle-file-encoding").onchange = () => {
      if (active == null ? void 0 : active.subtitleUpload) void $("#subtitle-file").onchange();
    };
    for (const [id, icon2, label] of [
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
      ["player-settings-close", "close", "Close playback settings"],
      ["player-subtitles-toggle", "subtitles", "Subtitles"],
      ["player-subtitles-close", "close", "Close subtitles"]
    ])
      iconButton(id, icon2, label);
    $("#player-settings-toggle").onclick = () => {
      const open = $("#player-settings").hidden;
      closeSubtitles();
      $("#player-settings").hidden = !open;
      $("#player-settings-toggle").setAttribute("aria-expanded", String(open));
      showControls();
      if (open) $("#player-settings-close").focus();
    };
    $("#player-settings-close").onclick = () => closeSettings(true);
    $("#player-subtitles-toggle").onclick = () => $("#player-subtitles").hidden ? openSubtitles() : closeSubtitles(true);
    $("#player-subtitles-settings").onclick = openSubtitles;
    $("#player-subtitles-close").onclick = () => closeSubtitles(true);
    $("#player").addEventListener("pointermove", () => {
      keyboardControls = false;
      showControls();
    });
    $("#player").addEventListener("pointerdown", (event) => {
      keyboardControls = false;
      if (!event.target.closest("#player-settings, #player-settings-toggle")) closeSettings();
      if (!event.target.closest(
        "#player-subtitles, #player-subtitles-toggle, #player-subtitles-settings"
      ))
        closeSubtitles();
      showControls();
    });
    $("#player").addEventListener("focusin", showControls);
    document.addEventListener("keydown", (event) => {
      if (!active || $("#dialog").open) return;
      keyboardControls = true;
      showControls();
      if ((event.key === "Escape" || event.keyCode === 10009) && !$("#player-subtitles").hidden) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeSubtitles(true);
        return;
      }
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
      else if (key === "c") $("#player-subtitles-toggle").click();
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
    $("#subtitles").onchange = () => {
      if (active) active.subtitleUserChoice = true;
      setSubtitles();
    };
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
  var featuredTitles = [];
  var featuredIndex = 0;
  var main = () => $("#main");
  var button = (label, action2, attrs = "", style = "") => `<button class="${style}" data-action="${action2}" ${attrs}>${esc(label)}</button>`;
  var option2 = (value, label, current) => `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(label)}</option>`;
  var grid = (items) => `<div class="grid">${items.map((t) => card(t)).join("")}</div>`;
  function shelf(label, items, mode = "landscape") {
    return items.length ? `<section class="section media-shelf"><div class="section-heading"><h2>${esc(label)}</h2><div class="rail-controls"><button data-action="rail-back" aria-label="Scroll ${esc(label)} left">${icon("left")}</button><button data-action="rail-next" aria-label="Scroll ${esc(label)} right">${icon("right")}</button></div></div><div class="rail ${mode === "resume" || mode === "next" ? "resume-rail" : ""}" aria-label="${esc(label)}">${items.map((t) => card(t, mode)).join("")}</div></section>` : "";
  }
  function featureHtml() {
    const title = featuredTitles[featuredIndex];
    if (!title) return "";
    const artwork = [title.background, title.poster].find((url) => /^https?:\/\//.test(url || ""));
    const item = title.primary;
    const saved = title.tags.includes("watchlist");
    return `<div class="hero-art ${title.background ? "" : "hero-poster"}" aria-hidden="true">${artwork ? `<img src="${esc(artwork)}" alt="" fetchpriority="high">` : '<span class="hero-monogram">m.</span>'}</div><div class="hero-shade"></div><div class="hero-copy"><p class="hero-label">Featured in your library</p><h2>${esc(title.name)}</h2><p class="hero-facts">${esc([title.year, title.kind === "movie" ? "Movie" : title.kind === "anime" ? "Anime" : "Series", ...(title.genres || []).slice(0, 2)].filter(Boolean).join(" \xB7 "))}</p>${title.description ? `<p class="hero-description">${esc(title.description)}</p>` : ""}<div class="hero-actions">${(item == null ? void 0 : item.available) ? `<button class="hero-play" data-action="play" data-item="${esc(item.id)}" data-title="${esc(title.id)}">${icon("play")}${title.resumable ? "Resume watching" : "Watch now"}</button>` : `<a class="hero-play" href="#/title/${esc(title.id)}">View title</a>`}<a class="hero-round" href="#/title/${esc(title.id)}" aria-label="Details for ${esc(title.name)}" title="Title details">${icon("info")}</a><button class="hero-round" data-action="feature-save" data-title="${esc(title.id)}" aria-label="${saved ? "Remove from" : "Add to"} My List" aria-pressed="${saved}" title="${saved ? "Remove from" : "Add to"} My List">${icon(saved ? "check" : "plus")}</button></div>${title.readyCount ? `<p class="hero-availability">${icon("check")}Available in your library</p>` : ""}</div>${featuredTitles.length > 1 ? `<div class="feature-controls"><button class="feature-arrow" data-action="feature-prev" aria-label="Previous featured title">${icon("left")}</button><div class="feature-dots" role="group" aria-label="Featured titles">${featuredTitles.map((t, i) => `<button class="feature-dot" data-action="feature-select" data-index="${i}" aria-label="Feature ${esc(t.name)}" aria-pressed="${i === featuredIndex}"></button>`).join("")}</div><button class="feature-arrow" data-action="feature-next" aria-label="Next featured title">${icon("right")}</button></div>` : ""}`;
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
    document.querySelectorAll("[data-nav]").forEach((a) => {
      const active2 = a.dataset.nav === page || page === "title" && a.dataset.nav === "library";
      a.classList.toggle("active", active2);
      if (active2) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    document.querySelector(".account-menu").removeAttribute("open");
    main().classList.toggle("home-page", page === "home");
    main().classList.toggle("title-page", page === "title");
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
      if (page === "sports") {
        const html = await sportsPage(url, user);
        draw(html);
        if (ticket !== generation) return;
        bindSportsFilters();
        poll = setInterval(() => {
          if (!document.hidden && !$("#dialog").open && !livePlaying() && !main().contains(document.activeElement))
            void route({ quiet: true });
        }, 6e4);
      } else if (page === "home") {
        const data = await api("/api/home"), queues = await api("/api/queues");
        const kind = ["movie", "tv", "anime"].includes(url.searchParams.get("kind")) ? url.searchParams.get("kind") : "";
        const visible = (items) => items.filter((t) => !kind || t.kind === kind);
        const count = Object.values(data).reduce((total, items) => total + visible(items).length, 0);
        featuredTitles = [
          ...new Map(
            [
              ...visible(data.recentlyAdded),
              ...visible(data.continueWatching),
              ...visible(data.watchlist)
            ].map((t) => [t.id, t])
          ).values()
        ].slice(0, 5);
        if (!quiet || featuredIndex >= featuredTitles.length) featuredIndex = 0;
        draw(
          `<h1 class="sr-only">Home</h1><nav class="browse-tabs" aria-label="Browse library">${[
            ["", "All"],
            ["movie", "Movies"],
            ["tv", "TV shows"],
            ["anime", "Anime"]
          ].map(
            ([value, label]) => `<a href="#/${value ? "?kind=" + value : ""}" ${kind === value ? 'aria-current="page"' : ""}>${label}</a>`
          ).join("")}</nav>` + (featuredTitles.length ? `<section class="feature" id="feature" aria-label="Featured title">${featureHtml()}</section>` : "") + '<div class="home-content">' + shelf("Continue watching", visible(data.continueWatching), "resume") + shelf("Next up", visible(data.nextUp), "next") + shelf("Recently added", visible(data.recentlyAdded)) + shelf("My List", visible(data.watchlist)) + (!count ? empty(
            kind ? "No titles in this category yet" : "Your library starts here",
            "Find a title in Discover to add it to your library.",
            `<a class="primary empty-action" href="#/discover">Browse titles</a>`
          ) : "") + (queues.some((q) => q.items.length) ? `<section class="section"><h2>Saved queues</h2>${queues.filter((q) => q.items.length).slice(0, 3).map(
            (q) => `<div class="row"><div class="row-main"><h3>${esc(q.name)}</h3><p class="meta">${q.mode === "shuffle" ? "Shuffle" : "In order"} \xB7 ${q.items.length} items</p></div>${button("Open queue", "queue", `data-id="${q.id}"`)}</div>`
          ).join("")}</section>` : "") + "</div>"
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
          ].map(([v, l]) => option2(v, l, params.get("kind") || "")).join("")}</select></label><label>View<select name="status">${[
            ["", "All titles"],
            ["ready", "Downloaded"],
            ["progress", "In progress"],
            ["unwatched", "Unwatched"],
            ["watched", "Watched"]
          ].map(([v, l]) => option2(v, l, params.get("status") || "")).join("")}</select></label><label>Sort<select name="sort">${[
            ["", "Title"],
            ["added", "Recently added"],
            ["played", "Last watched"],
            ["year", "Year"]
          ].map(([v, l]) => option2(v, l, params.get("sort") || "")).join(
            ""
          )}</select></label>${page === "list" ? `<label>List<select name="tag">${option2("watchlist", "Watchlist", params.get("tag"))}${option2("favorite", "Favorites", params.get("tag"))}</select></label>` : ""}<button>Apply</button></form>` + (page === "list" ? `<div class="collection-links">${button("New collection", "new-collection")}${collections.map((c) => button(c.name, "collection", `data-id="${c.id}"`)).join("")}</div>` : "") + (data.items.length ? grid(data.items) : empty(
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
          heading("Settings") + torrentRulesForm(admin) + `<form id="preferences" class="form"><h2>Playback</h2><label class="check section"><input type="checkbox" name="autoplay" ${prefs.autoplay ? "checked" : ""}>Play the next episode automatically</label><label>Preferred audio language<input name="audioLanguage" placeholder="eng, dan, jpn\u2026" maxlength="20" value="${esc(prefs.audioLanguage)}"></label><label>Preferred subtitle language<input name="subtitleLanguage" maxlength="20" placeholder="eng, dan\u2026" value="${esc(prefs.subtitleLanguage)}"></label><label>Subtitles<select name="subtitleMode">${option2("off", "Off", prefs.subtitleMode)}${option2("preferred", "Use preferred language", prefs.subtitleMode)}</select></label><button class="primary">Save preferences</button></form>${admin ? `<section class="section"><h2>Server</h2><p class="meta">Real-Debrid: ${admin.debridConfigured ? "Configured" : "Not configured"}</p><p class="meta">Import folders: ${esc(admin.importRoots.join(", ") || "None configured")}</p></section><section class="section"><div class="section-heading"><h2>People</h2>${button("Add person", "add-user")}</div>${admin.users.map((u) => `<div class="row"><div class="row-main"><h3>${esc(u.name)}</h3><p class="meta">${esc(u.email)} \xB7 ${u.active ? "Active" : "Disabled"} \xB7 ${u.role === "admin" || u.can_download ? "Downloads allowed" : "Viewing only"}</p></div>${u.id !== user.id ? button(u.can_download ? "Disable downloads" : "Allow downloads", "user-permission", `data-id="${u.id}" data-active="${!!u.active}" data-allowed="${!u.can_download}"`) : ""}</div>`).join("")}</section>` : ""}<section class="section">${button("Sign out", "logout")}</section>`
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
    let html = `<div class="detail">${/^https?:\/\//.test(title.background || "") ? `<div class="detail-backdrop" aria-hidden="true"><img src="${esc(title.background)}" alt=""></div>` : ""}<div class="detail-art poster">${poster(title)}</div><div class="detail-copy"><p class="eyebrow">${esc(title.kind === "movie" ? "Movie" : title.kind === "anime" ? "Anime" : "Series")} ${esc(title.year)}</p><h1>${esc(title.name)}</h1>${metadataHtml(title)}<p class="muted">${esc(title.description)}</p><div class="actions">${primary ? button(primary.available ? title.resumable ? "Resume " + episodeLabel(primary) : primary.state.completed ? "Replay" : "Play " + episodeLabel(primary) : "Find a release", primary.available ? "play" : "release", `data-item="${primary.id}" data-title="${title.id}"`, "primary") : ""}${title.kind !== "movie" && title.readyCount ? button("Shuffle episodes", "shuffle", `data-title="${title.id}"`) : ""}${button(title.tags.includes("watchlist") ? "In My List" : "Add to My List", "tag", `data-tag="watchlist" data-active="${!title.tags.includes("watchlist")}"`)}${button(title.tags.includes("favorite") ? "Favorited" : "Favorite", "tag", `data-tag="favorite" data-active="${!title.tags.includes("favorite")}"`)}${button("Collections", "add-collection")}</div><p class="meta">${title.readyCount} downloaded${((_a = title.genres) == null ? void 0 : _a.length) ? " \xB7 " + esc(title.genres.join(" / ")) : ""}</p></div></div>`;
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
    var _a, _b;
    const b = event.target.closest("[data-action]");
    if (!b) return;
    const actionName = b.dataset.action;
    b.disabled = true;
    try {
      if (actionName === "rail-back" || actionName === "rail-next") {
        const rail = b.closest(".media-shelf").querySelector(".rail");
        rail.scrollBy({
          left: rail.clientWidth * (actionName === "rail-next" ? 0.85 : -0.85),
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
        });
      } else if (actionName.startsWith("feature-")) {
        if (actionName === "feature-save") {
          const title = featuredTitles[featuredIndex];
          const active2 = !title.tags.includes("watchlist");
          await api(`/api/titles/${title.id}/tags`, { tag: "watchlist", active: active2 });
          await route({ quiet: true });
          toast(active2 ? "Added to My List" : "Removed from My List");
          (_a = $('#feature [data-action="feature-save"]')) == null ? void 0 : _a.focus({ preventScroll: true });
        } else {
          featuredIndex = actionName === "feature-select" ? Number(b.dataset.index) : (featuredIndex + (actionName === "feature-next" ? 1 : -1) + featuredTitles.length) % featuredTitles.length;
          $("#feature").innerHTML = featureHtml();
          const selector = actionName === "feature-select" ? `[data-action="feature-select"][data-index="${featuredIndex}"]` : `[data-action="${actionName}"]`;
          (_b = $("#feature").querySelector(selector)) == null ? void 0 : _b.focus({ preventScroll: true });
        }
      } else if (actionName.startsWith("sports-"))
        await sportsAction(b, {
          refresh: () => route({ quiet: true }),
          closeVod: async () => {
            if (playing()) await closePlayer();
          }
        });
      else if (actionName === "refresh") await route();
      else if (actionName === "refresh-metadata") {
        const titleId = currentTitle.id;
        await api(`/api/titles/${titleId}/refresh`, {});
        if ((currentTitle == null ? void 0 : currentTitle.id) === titleId) await route({ quiet: true });
        toast("Metadata refreshed");
      } else if (actionName === "play") {
        closeModal();
        await closeLive();
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
    await closeLive();
    if (playing()) await closePlayer();
    await api("/api/logout", {});
    location.reload();
  }
  async function boot() {
    const auth = await api("/api/auth");
    user = auth.user;
    if (!user) {
      $("#sidebar").hidden = true;
      main().classList.add("auth-page");
      main().innerHTML = `<div class="login"><a class="brand" href="#/">mediawan</a><h1>Sign in</h1>${auth.setupRequired ? "<p>Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 10 characters on the server, then restart Mediawan.</p>" : '<form id="login" class="form"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="primary">Sign in</button><p id="login-error" class="error" role="alert"></p></form>'}</div>`;
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
    $("#avatar").textContent = user.name.slice(0, 1).toUpperCase();
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".account-menu"))
        document.querySelector(".account-menu").removeAttribute("open");
    });
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
        if (document.querySelector(".account-menu").open) {
          document.querySelector(".account-menu").removeAttribute("open");
          document.querySelector(".account-menu summary").focus();
        } else if ($("#dialog").open) {
          e.preventDefault();
          closeModal();
        } else if (livePlaying()) {
          e.preventDefault();
          void closeLive();
        } else if (playing()) {
          e.preventDefault();
          void closePlayer();
        }
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) || ["INPUT", "SELECT", "TEXTAREA", "VIDEO"].includes(document.activeElement.tagName))
        return;
      const root = $("#dialog").open ? $("#dialog") : livePlaying() ? $("#live-player") : playing() ? $("#player") : document;
      const candidates = [...root.querySelectorAll("a,button,input,select,summary")].filter(
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
