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
    if (!response.ok)
      throw Object.assign(new Error(data.error || "Request failed"), {
        status: response.status,
        reason: data.reason || null
      });
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
  function card(title, mode = "library", { canStream: canStream2 = false } = {}) {
    const item = mode === "resume" ? title.resumable : mode === "next" ? title.next : null;
    const streams = !!item && !item.available && canStream2;
    const actionName = (item == null ? void 0 : item.available) ? "play" : streams ? "stream-play" : "release";
    const actionLabel = mode === "resume" && ((item == null ? void 0 : item.available) || streams) ? "Resume" : (item == null ? void 0 : item.available) ? "Play next" : streams ? "Stream next" : "Not downloaded";
    const remaining = (item == null ? void 0 : item.state.duration) ? `${Math.ceil(Math.max(0, item.state.duration - item.state.position) / 60)} min left` : "";
    return `<article class="card"><a class="poster" href="#/title/${esc(title.id)}" aria-label="Open ${esc(title.name)}">${poster(title, mode !== "library")}${item ? `<span class="badge">${esc(episodeLabel(item))}</span>` : title.readyCount ? '<span class="badge">Downloaded</span>' : ""}</a>${item ? progress(item.state) : ""}<a class="card-name" href="#/title/${esc(title.id)}">${esc(title.name)}</a><p class="meta">${esc(item ? mode === "resume" ? remaining : item.name : [title.year, title.kind === "movie" ? "Movie" : title.kind === "anime" ? "Anime" : "Series"].filter(Boolean).join(" \xB7 "))}</p>${item ? `<div class="resume-actions"><button class="card-action ${mode === "resume" ? "primary" : ""}" data-action="${actionName}" data-item="${esc(item.id)}" data-title="${esc(title.id)}"${streams ? ` data-warm="${esc(item.id)}"` : ""}>${item.available || streams ? icon("play") : ""}${actionLabel}</button>${mode === "resume" ? `<button class="menu-button" data-action="resume-menu" data-title="${esc(title.id)}" data-item="${esc(item.id)}" aria-label="More actions for ${esc(title.name)}">\u2022\u2022\u2022</button>` : ""}</div>` : ""}</article>`;
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
    let context, receiver, grant, controller, remote, selection, disposed = false, busy = false;
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
      var _a;
      if (disposed || !grant) return;
      const current = receiver == null ? void 0 : receiver.getMediaSession();
      if (((_a = current == null ? void 0 : current.media) == null ? void 0 : _a.contentId) && !ownsReceiver()) {
        void stop(false);
        return;
      }
      if ((current == null ? void 0 : current.playerState) === "IDLE" && current.idleReason) {
        void stop(
          false,
          current.idleReason === "ERROR" ? "The TV could not play this stream. Try casting again or choose another channel." : "TV playback ended."
        );
        return;
      }
      pauseButton.textContent = remote.isPaused ? "Play on TV" : "Pause TV";
      const state = current == null ? void 0 : current.playerState;
      const action2 = remote.isPaused ? "Paused" : state === "PLAYING" ? "Playing" : "Buffering";
      message(`${action2} on ${receiver.getCastDevice().friendlyName}`);
    };
    const disconnected = (event) => {
      const states = framework().SessionState;
      if ([states.SESSION_STARTED, states.SESSION_RESUMED].includes(event.sessionState))
        selection == null ? void 0 : selection.ready();
      if ([states.SESSION_START_FAILED, states.SESSION_ENDED].includes(event.sessionState))
        selection == null ? void 0 : selection.fail({ code: "session_error" });
      if (event.sessionState === framework().SessionState.SESSION_ENDED && grant) void stop(false);
    };
    function selectReceiver() {
      const ready = () => {
        const states = framework().SessionState;
        return [states.SESSION_STARTED, states.SESSION_RESUMED].includes(context.getSessionState()) ? context.getCurrentSession() : null;
      };
      if (ready()) return Promise.resolve(ready());
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (value, error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer2);
          if (selection === attempt) selection = null;
          if (error) reject(error);
          else resolve(value);
        };
        const timer2 = setTimeout(() => finish(null, { code: "timeout" }), 12e4);
        const attempt = {
          ready: () => {
            const value = ready();
            if (value) finish(value);
          },
          fail: (error) => finish(null, error)
        };
        selection = attempt;
        try {
          context.requestSession().then(
            () => attempt.ready(),
            (error) => attempt.fail(error)
          );
        } catch (error) {
          attempt.fail(error);
        }
      });
    }
    async function stop(endReceiver = true, reason = "") {
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
        onStop();
        message(reason);
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
      message("Select your TV in Chrome\u2019s Cast panel.");
      let pending;
      let stage = "connect";
      try {
        receiver = await selectReceiver();
        if (disposed) return;
        stage = "prepare";
        message(`Preparing the stream for ${receiver.getCastDevice().friendlyName}\u2026`);
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
        stage = "load";
        message(`Loading on ${receiver.getCastDevice().friendlyName}\u2026`);
        const load = new media.LoadRequest(info);
        load.autoplay = true;
        await receiver.loadMedia(load);
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
        const code = typeof error === "string" ? error : error == null ? void 0 : error.code;
        message(
          code === "cancel" ? "Casting cancelled." : stage === "prepare" ? error.message || "The TV stream could not be prepared. Try again." : stage === "load" ? "Could not cast: the TV could not load the stream. Check that it can reach this site, then try again." : "Could not cast: no TV connected. Check Chrome\u2019s local network permission and use the same Wi-Fi as your TV."
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
      get connecting() {
        return busy;
      },
      async close() {
        disposed = true;
        selection == null ? void 0 : selection.fail({ code: "cancel" });
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
  async function sportsPage(url, user3) {
    void prepareLiveCast().catch(() => {
    });
    const date = url.searchParams.get("date") || dateKey();
    schedule = await api(`/api/sports?${new URLSearchParams({ date, timezone: timezone() })}`);
    const sport = url.searchParams.get("sport") || "", status = url.searchParams.get("status") || "", query = url.searchParams.get("q") || "";
    const admin = user3.role === "admin";
    const matching = schedule.events.filter(
      (e) => (!sport || e.sport === sport) && `${e.title} ${e.competition}`.toLowerCase().includes(query.toLowerCase())
    );
    const filtered = matching.filter((e) => !status || e.status === status);
    const browseInline = !filtered.length && schedule.channels > 0;
    if (browseInline) await loadChannels();
    const count = (value) => matching.filter((e) => !value || e.status === value).length;
    let html = heading(
      "Live sports",
      "",
      admin ? '<div class="actions"><button data-action="sports-add">Add event</button><button class="quiet" data-action="sports-manage">Manage live TV</button></div>' : ""
    ).replace("page-heading", "page-heading sports-heading");
    html += `<div class="sports-datebar"><div class="actions"><a class="sports-day" href="${esc(sportsUrl({ date: dateOffset(date, -1) }))}" aria-label="Previous day">\u2190</a><h2>${esc(dateLabel(date))}</h2><a class="sports-day" href="${esc(sportsUrl({ date: dateOffset(date, 1) }))}" aria-label="Next day">\u2192</a></div><div class="actions"><a class="sports-day ${date === dateKey() ? "selected" : ""}" href="${esc(sportsUrl({ date: "" }))}">Today</a><label class="sports-date-label">Date<input id="sports-date" type="date" value="${esc(date)}" required></label></div></div>`;
    if (schedule.events.length)
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
    if (browseInline)
      html += `<p class="meta">${schedule.events.length ? "No matching events." : "No events listed for this day."}</p>`;
    else if (!filtered.length)
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
    html += browseInline ? `<section class="sports-channels section" aria-label="Live channels"><h2>Live channels</h2>${channelBrowser()}</section>` : `<section class="sports-channels section"><button data-action="sports-channels">Browse channels (${schedule.channels})</button><p class="meta">Times shown in ${esc(schedule.timezone)}. \u201COn now\u201D follows the scheduled broadcast time.</p></section>`;
    return html;
  }
  function dateLabel(date) {
    return `${date === dateKey() ? "Today \xB7 " : ""}${dayLabel(date)}`;
  }
  function bindSportsFilters() {
    $("#sports-date").onchange = (e) => {
      if (e.target.value) location.hash = sportsUrl({ date: e.target.value });
    };
    const filter = $("#sports-filter");
    if (filter) {
      filter.onsubmit = (e) => {
        e.preventDefault();
        const data = new FormData(e.target);
        location.hash = sportsUrl({ sport: data.get("sport"), q: data.get("q") });
      };
      $("#sports-filter select").onchange = () => $("#sports-filter").requestSubmit ? $("#sports-filter").requestSubmit() : $("#sports-filter").dispatchEvent(new Event("submit", { cancelable: true }));
    }
    if ($("#channel-search")) bindChannelBrowser();
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
  function channelBrowser() {
    return '<label class="section">Find a channel<input id="channel-search" type="search" placeholder="Name, language or quality" autocomplete="off" aria-controls="channel-results"></label><p id="channel-count" class="meta" role="status"></p><div id="channel-results" class="sports-channel-list"></div><button id="channel-more" class="quiet" hidden>Show more channels</button>';
  }
  function bindChannelBrowser() {
    let visible = 100;
    const render = () => {
      const words = $("#channel-search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const found = channels.filter((c) => {
        const text = [c.name, c.language, c.quality].filter(Boolean).join(" ").toLowerCase();
        return words.every((word) => text.includes(word));
      });
      $("#channel-results").innerHTML = channelButtons(found.slice(0, visible)) || '<p class="meta">No channels match your search.</p>';
      $("#channel-count").textContent = found.length > visible ? `${visible.toLocaleString()} of ${found.length.toLocaleString()} channels` : `${found.length.toLocaleString()} channel${found.length === 1 ? "" : "s"}`;
      $("#channel-more").hidden = found.length <= visible;
    };
    $("#channel-search").oninput = () => {
      visible = 100;
      render();
    };
    $("#channel-more").onclick = () => {
      visible += 100;
      render();
    };
    render();
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
      modal(`<h2>Live channels</h2>${channelBrowser()}`);
      bindChannelBrowser();
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
    if (document.fullscreenElement && (player == null ? void 0 : player.contains(document.fullscreenElement)))
      await document.exitFullscreen().catch(() => {
      });
    player == null ? void 0 : player.remove();
    restore == null ? void 0 : restore.focus();
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
    player.innerHTML = '<header><button id="live-close">Back to sports</button><strong id="live-channel-name">Opening channel\u2026</strong><span class="sports-status live">Live TV</span></header><div id="live-screen"><video id="live-video" controls controlslist="nofullscreen noremoteplayback" disableremoteplayback playsinline></video><div class="live-player-controls" role="toolbar" aria-label="Live playback controls"><button id="live-cast" disabled>Cast to TV</button><button id="live-cast-pause" hidden>Pause TV</button><button id="live-cast-stop" hidden>Stop casting</button><button id="live-fullscreen" aria-label="Enter fullscreen" title="Enter fullscreen"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg></button></div></div><p id="live-player-status" role="status">Starting live playback\u2026</p>';
    document.body.appendChild(player);
    $("#live-close").onclick = closeLive;
    $("#live-close").focus();
    const screen = $("#live-screen"), fullscreen = $("#live-fullscreen");
    fullscreen.hidden = !screen.requestFullscreen;
    screen.onfullscreenchange = () => {
      const label = document.fullscreenElement === screen ? "Exit fullscreen" : "Enter fullscreen";
      fullscreen.setAttribute("aria-label", label);
      fullscreen.title = label;
    };
    fullscreen.onclick = async () => {
      try {
        if (document.fullscreenElement === screen) await document.exitFullscreen();
        else await screen.requestFullscreen();
      } catch {
        toast("Fullscreen could not open.");
      }
    };
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
        if (!(casting == null ? void 0 : casting.active) && !(casting == null ? void 0 : casting.connecting)) $("#live-player-status").textContent = "";
      };
      video2.onwaiting = () => {
        if (!(casting == null ? void 0 : casting.active) && !(casting == null ? void 0 : casting.connecting))
          $("#live-player-status").textContent = "Buffering\u2026";
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
    <label class="check"><input type="checkbox" name="rejectUnknown" ${r.rejectUnknown ? "checked" : ""}>Reject unknown seed count or size</label><p class="meta">Timeouts stop the selected torrent and retain partial data. They never choose another release automatically. Uploads can continue until the ratio or time limit is reached.</p>
    <h3>Streaming filter</h3>
    <label class="check"><input type="checkbox" name="trustedOnly" ${r.trustedOnly ? "checked" : ""}>Trusted releases only</label>
    <label class="check"><input type="checkbox" name="requireSubtitles" ${r.requireSubtitles ? "checked" : ""}>Require confirmed subtitles in the preferred subtitle language (English when none is set)</label>
    <label>Trusted release groups<textarea name="trustedGroups" rows="3" spellcheck="false">${esc((r.trustedGroups || []).join(", "))}</textarea></label>
    <p class="meta">A stream tries releases from these groups first, then reads each file's subtitle tracks before playback and moves on when the language is missing. When nothing passes, the best release still plays with a warning.</p><button class="primary">Save torrent rules</button><button type="button" id="torrent-health">Test connection</button><p id="torrent-status" role="status"></p></form></section>`;
  }
  function bindTorrentRules() {
    const form = $("#torrent-rules");
    if (!form) return;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = new FormData(form), payload = {};
      const flags = ["rejectUnknown", "trustedOnly", "requireSubtitles"];
      for (const [key, value] of data)
        if (!["resolutions", "trustedGroups", ...flags].includes(key)) payload[key] = Number(value);
      for (const flag of flags) payload[flag] = data.has(flag);
      payload.trustedGroups = String(data.get("trustedGroups") || "").split(/[\s,]+/).filter(Boolean);
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

  // public/streaming.js
  var RESOLUTIONS = [1080, 2160];
  var KNOWN_RESOLUTIONS = [480, 720, 1080, 2160];
  var HEAD_TAIL_BYTES = 10 * 1024 * 1024;
  var resolutionLabel = (resolution) => {
    const value = Number(resolution);
    return value >= 2160 ? "4K" : value >= 1080 ? "1080p" : value >= 720 ? "720p" : "SD";
  };
  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1e9) return `${(value / 1e9).toFixed(value >= 1e10 ? 0 : 1)} GB`;
    if (value >= 1e6) return `${Math.round(value / 1e6)} MB`;
    return `${Math.max(0, Math.round(value / 1e3))} KB`;
  }
  function formatSpeed(bytesPerSecond) {
    const value = Number(bytesPerSecond) || 0;
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB/s`;
    return `${Math.round(value / 1e3)} KB/s`;
  }
  var plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  var FAILED_CODECS = "mediawan.stream.failedCodecs.2";
  function failedCodecs(env) {
    try {
      const list = JSON.parse(env && env.localStorage.getItem(FAILED_CODECS) || "[]");
      return Array.isArray(list) ? list.filter((c) => c === "hevc" || c === "hevc10") : [];
    } catch {
      return [];
    }
  }
  function codecKey(info) {
    if (!info || info.video !== "hevc") return null;
    return /10/.test(String(info.pixelFormat || "")) || info.hdr ? "hevc10" : "hevc";
  }
  function rememberDecodeFailure(env, info) {
    const codec = codecKey(info);
    if (!codec) return false;
    try {
      const list = /* @__PURE__ */ new Set([...failedCodecs(env), codec, ...codec === "hevc" ? ["hevc10"] : []]);
      env.localStorage.setItem(FAILED_CODECS, JSON.stringify([...list]));
    } catch {
    }
    return true;
  }
  function detectCapabilities(env) {
    const source2 = env && env.MediaSource;
    const mse = (type) => {
      try {
        return !!source2 && !!source2.isTypeSupported && source2.isTypeSupported(type);
      } catch {
        return false;
      }
    };
    const video2 = [
      mse('video/mp4; codecs="avc1.640028"') && "h264",
      mse('video/mp4; codecs="hvc1.1.6.L150.B0"') && "hevc",
      mse('video/mp4; codecs="hvc1.2.4.L153.B0"') && "hevc10"
    ].filter(Boolean);
    for (const failed of failedCodecs(env)) {
      const at = video2.indexOf(failed);
      if (at >= 0) video2.splice(at, 1);
    }
    if (!video2.includes("h264")) video2.unshift("h264");
    let uhd = null;
    try {
      const info = env && env.webapis && env.webapis.productinfo;
      if (info && typeof info.isUdPanelSupported === "function") uhd = !!info.isUdPanelSupported();
    } catch {
    }
    if (uhd == null) {
      const screen = env && env.screen || {};
      const ratio = Number(env && env.devicePixelRatio) || 1;
      uhd = Math.max(Number(screen.width) || 0, Number(screen.height) || 0) * ratio >= 3e3;
    }
    return {
      video: video2,
      maxHeight: uhd ? 2160 : 1080,
      audioChannels: surroundOutput(env) ? 6 : 2,
      dolbyVision: false
    };
  }
  function surroundOutput(env) {
    const Context = env && (env.AudioContext || env.webkitAudioContext);
    if (!Context) return false;
    let context = null;
    try {
      context = new Context();
      return Number(context.destination && context.destination.maxChannelCount) >= 6;
    } catch {
      return false;
    } finally {
      try {
        if (context && context.close) context.close().catch(() => {
        });
      } catch {
      }
    }
  }
  function requiredCodec(release) {
    if (!release || !release.hevc) return "h264";
    return release.hdr || release.dolbyVision ? "hevc10" : "hevc";
  }
  function streamPlan(option3, capabilities2) {
    const caps = capabilities2 || { video: ["h264"], maxHeight: 1080 };
    const label = resolutionLabel(option3 && option3.resolution);
    if (!option3 || !option3.available)
      return {
        selectable: false,
        note: unavailableNote(option3 && option3.reason, label),
        warning: ""
      };
    const release = option3.release || {};
    const uhd = option3.resolution >= 2160;
    if (uhd && caps.maxHeight < 2160)
      return {
        selectable: false,
        note: "This screen shows up to 1080p, so 4K would only take longer to load.",
        warning: ""
      };
    const codec = requiredCodec(release);
    const decodes = (caps.video || ["h264"]).includes(codec);
    const dolbyOnly = release.dolbyVisionOnly && !caps.dolbyVision;
    if (uhd && (!decodes || dolbyOnly))
      return {
        selectable: false,
        note: dolbyOnly ? "This 4K copy is Dolby Vision only, which this device cannot show correctly." : `This device cannot decode this 4K video (${codec === "hevc10" ? "HEVC 10-bit" : "HEVC"}).`,
        warning: ""
      };
    if (!decodes || dolbyOnly)
      return {
        selectable: true,
        note: "",
        warning: `The server converts this for your device: it starts a little slower${release.hdr ? " and HDR shows as SDR" : ""}.`
      };
    return { selectable: true, note: "", warning: "" };
  }
  function unavailableNote(reason, label) {
    const text = String(reason || "");
    const best = text.match(/Best:\s*(.+)$/);
    if (best)
      return `No ${label} release meets your rules right now (closest: ${lowerFirst(best[1])}).`;
    return text.replace(/\b2160p\b/g, "4K") || `No ${label} release is available.`;
  }
  var lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);
  function releaseFacts(release) {
    if (!release) return [];
    const facts = [formatBytes(release.sizeBytes)];
    if (release.service) facts.push(release.service);
    if (release.source === "disc") facts.push("Blu-ray");
    if (release.source === "remux") facts.push("Blu-ray remux");
    if (release.dolbyVision) facts.push(release.hdr ? "Dolby Vision \xB7 HDR" : "Dolby Vision");
    else if (release.hdr) facts.push("HDR");
    return facts;
  }
  function releaseDetail(release) {
    if (!release) return "";
    const parts = [release.hevc ? "HEVC" : "H.264"];
    if (release.group) parts.push(release.group);
    if (release.seeders != null) parts.push(plural(release.seeders, "seeder"));
    if (release.seasonPack) parts.push("season pack");
    if (release.trusted === true) parts.push("trusted group");
    if (release.trusted === false) parts.push("untrusted group");
    if (release.subtitles === true) parts.push("subtitles confirmed");
    if (release.subtitles === false) parts.push("no subtitles in your language");
    return parts.join(" \xB7 ");
  }
  function chooseResolution(options, remembered, capabilities2) {
    const list = options && options.resolutions || [];
    const works = (resolution) => {
      const option3 = list.find((o) => o.resolution === resolution);
      return !!option3 && streamPlan(option3, capabilities2).selectable;
    };
    const standard = list.find((o) => o.resolution < 2160);
    for (const candidate of [
      Number(remembered) === 1080 && standard ? standard.resolution : Number(remembered),
      options && options.defaultResolution,
      ...list.map((o) => o.resolution)
    ])
      if (works(candidate)) return candidate;
    return null;
  }
  var resolutionKey = (userId) => `mw:stream-resolution:${userId || "anonymous"}`;
  function rememberedResolution(userId, storage2) {
    try {
      const value = Number(storage2 && storage2.getItem(resolutionKey(userId)));
      return RESOLUTIONS.includes(value) ? value : null;
    } catch {
      return null;
    }
  }
  function rememberResolution(userId, resolution, storage2) {
    try {
      if (KNOWN_RESOLUTIONS.includes(Number(resolution)))
        storage2.setItem(resolutionKey(userId), String(Number(resolution) >= 2160 ? 2160 : 1080));
    } catch {
    }
  }
  function startupView(status, { elapsedMs = 0 } = {}) {
    if (!status) return { stage: "sources", title: "Finding sources", detail: "", progress: null };
    const peers = Number(status.peers) || 0;
    const speed = status.downloadSpeed ? formatSpeed(status.downloadSpeed) : "";
    const live = [plural(peers, "peer"), speed].filter(Boolean).join(" \xB7 ");
    const state = status.state;
    if (state === "failed")
      return { stage: "failed", title: status.message, detail: "", progress: null };
    if (state === "stopped")
      return { stage: "stopped", title: status.message || "Stopped", detail: "", progress: null };
    if (status.conversion && status.conversion.state === "ready" && state !== "buffering")
      return { stage: "playing", title: "Playing", detail: live, progress: 1 };
    if (state === "finding-peers") {
      const trying = (status.attempts || []).filter((a) => a.state === "trying").length;
      const slow = elapsedMs >= 1e4;
      return {
        stage: "sources",
        title: "Finding sources",
        detail: slow ? `Still looking${trying > 1 ? ` across ${trying} releases` : ""}. Quiet releases can take up to 45 seconds.` : trying > 1 ? `Trying ${trying} releases` : "Looking for people sharing this release",
        progress: null
      };
    }
    if (state === "fetching-metadata")
      return {
        stage: "connecting",
        title: "Connecting",
        detail: `${live} \xB7 getting the file list`,
        progress: null
      };
    if (state === "probing") {
      const file = status.file;
      const target = file ? Math.min(file.size || HEAD_TAIL_BYTES, HEAD_TAIL_BYTES) : HEAD_TAIL_BYTES;
      const done = file ? Math.min(target, file.downloaded || 0) : 0;
      const reading = done >= target * 0.98;
      return {
        stage: "buffering",
        title: "Buffering",
        detail: reading ? `Reading the video \xB7 ${live}` : `${formatBytes(done)} of ${formatBytes(target)} \xB7 ${live}`,
        progress: Math.min(0.95, done / target * 0.95)
      };
    }
    if (state === "buffering") {
      const ahead = Number(status.buffer && status.buffer.convertedAheadSeconds) || 0;
      return {
        stage: "buffering",
        title: "Buffering",
        detail: live,
        progress: Math.min(1, ahead / 6)
      };
    }
    return { stage: "buffering", title: "Starting playback", detail: live, progress: 0.97 };
  }
  function fallbackNote(status) {
    const fallback = status && status.fallback;
    if (!fallback || !fallback.to) return "";
    const to = fallback.to;
    const name = [to.service, to.group].filter(Boolean).join(" \xB7 ") || formatBytes(to.sizeBytes);
    if (fallback.kind === "subtitles")
      return `${fallback.reason} This plays a different copy that has them (${name}).`;
    return `The first choice was slow to answer, so this plays a different copy (${name}).`;
  }
  function filterWarnings(status) {
    return status && Array.isArray(status.warnings) && status.warnings || [];
  }
  function failureView(reason, message, context = {}) {
    const other = context.other && context.other.available ? context.other.resolution : null;
    const switchTo = other ? [{ id: "other-resolution", label: `Try ${resolutionLabel(other)}`, resolution: other }] : [];
    const download = context.canDownload === false ? [] : [{ id: "download", label: "Download instead" }];
    const retry = [{ id: "retry", label: "Try again" }];
    switch (reason) {
      case "vpn":
        return {
          title: "Connect the VPN to stream",
          body: context.guardMessage || message || "Streaming waits for the VPN so peers never see this server\u2019s address.",
          actions: [{ id: "retry", label: "Check again" }, ...download]
        };
      case "unavailable":
        return {
          title: `No ${resolutionLabel(context.resolution)} release right now`,
          body: unavailableNote(message, resolutionLabel(context.resolution)),
          actions: [...switchTo, ...download]
        };
      // Every release at this quality was checked and is another film with the same name.
      case "wrong-film":
        return {
          title: "Only a different film is available",
          body: message || "The releases listed at this quality are a different film with the same name.",
          actions: [...switchTo, ...download]
        };
      case "no-peers":
      case "no-release":
        return {
          title: "Nobody is sharing this right now",
          body: "None of the releases answered in time. This often changes within a few minutes.",
          actions: [...retry, ...switchTo, ...download]
        };
      case "disk":
        return {
          title: "Not enough free space to stream",
          body: message || "The server needs more free disk space for this stream.",
          actions: [
            ...other && other < (context.resolution || 0) ? [
              {
                id: "other-resolution",
                label: `Try ${resolutionLabel(other)} (smaller)`,
                resolution: other
              }
            ] : [],
            ...retry
          ]
        };
      // Only this player's own sessions may be stopped from here; other devices keep playing.
      case "limit":
        return context.ownOthers ? {
          title: "Too many streams at once",
          body: "This device still holds other streams. Stop them to start this one; your other devices keep playing.",
          actions: [{ id: "stop-others", label: "Stop the others on this device" }, ...retry]
        } : {
          title: "Too many streams at once",
          body: "Your other devices are using all of this account\u2019s streams. Stop playback on one of them, then try again.",
          actions: [...retry, ...download]
        };
      // The video did not play here (decoder or player error). Converting it on the server
      // for this device is the next step, unless that is what just failed.
      case "playback":
        return {
          title: "This video did not play on this device",
          body: context.compatible ? "Even the converted version did not play. Try again, or download it instead." : "Compatibility playback converts it on the server for this device. It starts a little slower.",
          actions: [
            ...context.compatible ? [] : [{ id: "compatibility", label: "Use compatibility playback" }],
            ...retry,
            ...switchTo,
            ...download
          ]
        };
      case "stopped":
        return {
          title: "The stream stopped",
          body: message && message !== "Stopped" ? message : "The server closed this stream.",
          actions: [{ id: "retry", label: "Resume" }, ...switchTo, ...download]
        };
      case "permission":
        return {
          title: "This account cannot stream",
          body: "Ask an administrator to allow downloads for your account.",
          actions: [{ id: "close", label: "Back" }]
        };
      default:
        return {
          title: "Playback could not start",
          body: message || "Something went wrong while starting the stream.",
          actions: [...retry, ...switchTo, ...download]
        };
    }
  }
  function failureReason(statusOrError) {
    if (!statusOrError) return "failed";
    if (statusOrError.error && typeof statusOrError.error === "object")
      return statusOrError.error.reason || "failed";
    return statusOrError.reason || "failed";
  }

  // public/stream-ui.js
  var playerKey = (() => {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let id = "";
    try {
      const bytes = new Uint8Array(12);
      window.crypto.getRandomValues(bytes);
      for (let i = 0; i < bytes.length; i++) id += chars[bytes[i] % chars.length];
    } catch {
      id = (Math.random().toString(36) + Math.random().toString(36)).replace(/[^a-z0-9]/g, "");
    }
    return `web-${id.slice(0, 16)}`;
  })();
  var playerId = () => playerKey;
  var user = null;
  var capabilities = null;
  function configureStreaming(account) {
    user = account;
    capabilities = detectCapabilities(window);
  }
  var canStream = () => !!(user == null ? void 0 : user.canDownload);
  var deviceCapabilities = () => capabilities || (capabilities = detectCapabilities(window));
  function decodeFailed(info) {
    if (rememberDecodeFailure(window, info)) capabilities = detectCapabilities(window);
  }
  var storage = () => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };
  var preferredResolution = (options) => chooseResolution(options, rememberedResolution(user == null ? void 0 : user.id, storage()), deviceCapabilities());
  var lastResolution = () => rememberedResolution(user == null ? void 0 : user.id, storage());
  var saveResolution = (resolution) => rememberResolution(user == null ? void 0 : user.id, resolution, storage());
  var optionsCache = /* @__PURE__ */ new Map();
  function streamOptions(itemId, { refresh = false } = {}) {
    const hit = optionsCache.get(itemId);
    if (!refresh && hit && Date.now() - hit.at < 6e4) return hit.promise;
    const entry = { at: Date.now(), data: (hit == null ? void 0 : hit.data) || null, promise: null };
    entry.promise = api(`/api/items/${itemId}/stream-options${refresh ? "?refresh=1" : ""}`).then(
      (data) => entry.data = data
    );
    entry.promise.catch(() => optionsCache.get(itemId) === entry && optionsCache.delete(itemId));
    optionsCache.set(itemId, entry);
    return entry.promise;
  }
  var cachedOptions = (itemId) => {
    var _a;
    return ((_a = optionsCache.get(itemId)) == null ? void 0 : _a.data) || null;
  };
  var prepared = /* @__PURE__ */ new Map();
  function prepareStream(itemId, resolution) {
    const key = `${itemId}:${resolution}`, hit = prepared.get(key);
    if (hit && Date.now() - hit.at < 4e4) return hit.promise;
    const entry = {
      at: Date.now(),
      promise: api(`/api/items/${itemId}/stream/prepare`, { resolution, player: playerKey })
    };
    entry.promise.catch(() => prepared.get(key) === entry && prepared.delete(key));
    prepared.set(key, entry);
    return entry.promise;
  }
  var forgetPrepared = (itemId) => {
    for (const key of [...prepared.keys()]) if (key.startsWith(`${itemId}:`)) prepared.delete(key);
  };
  var stoppedAt = /* @__PURE__ */ new Map();
  function streamStopped(itemId) {
    if (!itemId) return;
    forgetPrepared(itemId);
    stoppedAt.set(itemId, Date.now());
  }
  var recentlyStopped = (itemId) => Date.now() - (stoppedAt.get(itemId) || 0) < 3e4;
  async function warmStream(itemId, resolution) {
    var _a;
    if (!canStream() || !itemId) return null;
    try {
      const options = await streamOptions(itemId);
      if (!options.canStream || !((_a = options.guard) == null ? void 0 : _a.ok)) return null;
      const chosen = resolution || preferredResolution(options);
      return chosen ? await prepareStream(itemId, chosen) : null;
    } catch {
      return null;
    }
  }
  function bindWarmUp(root) {
    let timer2 = null, target = null;
    const schedule2 = (element, delay) => {
      var _a;
      const warm = (_a = element == null ? void 0 : element.closest) == null ? void 0 : _a.call(element, "[data-warm]");
      if (warm === target) return;
      clearTimeout(timer2);
      target = warm;
      if (warm) timer2 = setTimeout(() => void warmStream(warm.dataset.warm), delay);
    };
    root.addEventListener("focusin", (event) => schedule2(event.target, 250));
    root.addEventListener("mouseover", (event) => schedule2(event.target, 500));
    root.addEventListener("mouseleave", () => schedule2(null, 0));
    root.addEventListener("focusout", () => schedule2(null, 0));
  }
  var checkIcon = '<svg class="stream-option-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
  function optionCards(options, selected) {
    if (!options)
      return RESOLUTIONS.map(
        (resolution) => `<div class="stream-option loading" aria-hidden="true"><span class="stream-option-head"><strong>${resolutionLabel(resolution)}</strong></span><span class="stream-option-facts">Checking releases\u2026</span><span class="stream-option-detail">&nbsp;</span></div>`
      ).join("");
    return options.resolutions.map((option3) => {
      const resolution = option3.resolution;
      const plan = streamPlan(option3, deviceCapabilities());
      const pressed = plan.selectable && resolution === selected;
      const facts = plan.selectable ? releaseFacts(option3.release).join(" \xB7 ") : "Not available";
      const detail = plan.note || plan.warning || releaseDetail(option3.release);
      const label = `${resolutionLabel(resolution)}: ${facts}. ${detail}`;
      return `<button type="button" class="stream-option${plan.warning ? " warns" : ""}" data-stream-resolution="${resolution}" aria-pressed="${pressed}" aria-label="${esc(label)}" ${plan.selectable ? "" : "disabled"}><span class="stream-option-head"><strong>${resolutionLabel(resolution)}</strong>${checkIcon}</span><span class="stream-option-facts">${esc(facts)}</span><span class="stream-option-detail">${esc(detail)}</span></button>`;
    }).join("");
  }
  function readinessText(status) {
    var _a;
    if (!status) return "";
    if (status.state === "failed") {
      const view2 = failureView(failureReason(status), ((_a = status.error) == null ? void 0 : _a.message) || status.message, {
        resolution: status.resolution
      });
      return `${view2.title}. You can still try, or pick the other quality.`;
    }
    if (status.state === "ready" || status.conversion) return "Ready: starts instantly";
    const view = startupView(status);
    if (view.stage === "buffering" && view.progress != null)
      return `Getting ready: buffering ${Math.round(view.progress / 0.95 * 100)}%`;
    if (view.stage === "connecting") return `Getting ready: connected to ${status.peers || 0} peers`;
    return "Getting ready: finding sources";
  }
  function readinessWatcher(element, onGone, onStatus = () => {
  }) {
    let events = null, sessionId = null;
    const close = () => {
      events == null ? void 0 : events.close();
      events = null;
      sessionId = null;
    };
    const gone = () => {
      close();
      if (!element.isConnected) return;
      element.classList.remove("ready");
      element.textContent = "";
      onGone();
    };
    return {
      close,
      follow(status) {
        if (!(status == null ? void 0 : status.id) || status.id === sessionId) return;
        close();
        sessionId = status.id;
        element.classList.remove("ready");
        element.textContent = "Getting ready\u2026";
        const show = (next) => {
          if (!element.isConnected) return close();
          if (next.state === "stopped") return gone();
          element.classList.toggle("ready", next.state === "ready" || !!next.conversion);
          element.textContent = readinessText(next);
          onStatus(next);
        };
        if (!window.EventSource) {
          api(`/api/streams/${status.id}`).then(show, gone);
          return;
        }
        const source2 = events = new EventSource(`/api/streams/${status.id}/events`);
        source2.addEventListener("status", (event) => {
          if (events !== source2) return;
          try {
            show(JSON.parse(event.data));
          } catch {
          }
        });
        source2.onerror = () => {
          if (events === source2 && source2.readyState === 2) gone();
        };
      }
    };
  }
  function bindChooser(root, itemId, { onChange = () => {
  }, auto = false } = {}) {
    const cards = root.querySelector(".stream-options"), readiness = root.querySelector(".stream-readiness");
    let synced = null;
    const verify = (status) => {
      var _a, _b, _c;
      const shown = options == null ? void 0 : options.resolutions.find((o) => o.resolution === status.resolution);
      const wrongFilm = ((_a = status.error) == null ? void 0 : _a.reason) === "wrong-film";
      const hash = status.state === "ready" ? (_b = status.release) == null ? void 0 : _b.hash : null;
      if (!wrongFilm && (!hash || hash === ((_c = shown == null ? void 0 : shown.release) == null ? void 0 : _c.hash))) return;
      const key = `${status.id}:${hash || "none"}`;
      if (synced === key) return;
      synced = key;
      streamOptions(itemId, { refresh: true }).then((data) => {
        var _a2;
        if (!root.isConnected) return;
        options = data;
        const focused = root.contains(document.activeElement) ? document.activeElement.dataset.streamResolution : null;
        render();
        if (focused) (_a2 = root.querySelector(`[data-stream-resolution="${focused}"]`)) == null ? void 0 : _a2.focus();
      }).catch(() => {
      });
    };
    const watcher = readinessWatcher(readiness, () => forgetPrepared(itemId), verify);
    let options = cachedOptions(itemId), selected = options ? preferredResolution(options) : lastResolution(), picked = false;
    const state = {
      // True once the viewer has chosen a card; only such a choice is remembered.
      get picked() {
        return picked;
      },
      get selected() {
        return selected;
      },
      get options() {
        return options;
      },
      close: watcher.close
    };
    const prepare = (intent = !auto) => {
      var _a;
      if (!(options == null ? void 0 : options.canStream) || !((_a = options.guard) == null ? void 0 : _a.ok) || !selected) return;
      if (!intent && recentlyStopped(itemId)) return;
      readiness.classList.remove("ready");
      readiness.textContent = "Getting ready\u2026";
      prepareStream(itemId, selected).then((status) => {
        if (root.isConnected && status.resolution === selected) watcher.follow(status);
      }).catch((error) => {
        if (!root.isConnected) return;
        readiness.classList.remove("ready");
        readiness.textContent = failureView(error.reason, error.message, {
          resolution: selected
        }).title;
      });
    };
    const render = () => {
      var _a, _b;
      cards.innerHTML = optionCards(options, selected);
      if (!options) {
        readiness.textContent = "Checking what can be streamed\u2026";
        return;
      }
      if (!options.canStream) {
        readiness.textContent = failureView("permission").body;
      } else if (!((_a = options.guard) == null ? void 0 : _a.ok)) {
        readiness.classList.remove("ready");
        readiness.innerHTML = `<span>${esc(((_b = options.guard) == null ? void 0 : _b.message) || "Connect the VPN to stream.")}</span> <button type="button" class="text-button stream-recheck">Check again</button>`;
      } else if (!selected) {
        readiness.textContent = "Nothing here can play on this device right now. You can download it instead.";
      } else if (/^Checking/.test(readiness.textContent)) readiness.textContent = "";
      onChange(selected, options);
    };
    root.addEventListener("click", (event) => {
      var _a;
      const card2 = event.target.closest("[data-stream-resolution]");
      if (card2 && !card2.disabled) {
        const resolution = Number(card2.dataset.streamResolution);
        if (resolution === selected) return;
        selected = resolution;
        picked = true;
        watcher.close();
        render();
        (_a = root.querySelector(`[data-stream-resolution="${resolution}"]`)) == null ? void 0 : _a.focus();
        prepare(true);
        return;
      }
      if (event.target.closest(".stream-recheck")) {
        readiness.textContent = "Checking the VPN\u2026";
        streamOptions(itemId, { refresh: true }).then((data) => {
          var _a2, _b;
          options = data;
          selected = preferredResolution(options);
          render();
          prepare(true);
          if (!((_a2 = options.guard) == null ? void 0 : _a2.ok)) (_b = root.querySelector(".stream-recheck")) == null ? void 0 : _b.focus();
        }).catch((error) => readiness.textContent = error.message);
      }
    });
    render();
    if (options) prepare();
    streamOptions(itemId).then((data) => {
      var _a;
      if (!root.isConnected) return;
      const first = !options;
      options = data;
      if (first) selected = preferredResolution(options);
      else if (!streamPlan(
        options.resolutions.find((o) => o.resolution === selected),
        deviceCapabilities()
      ).selectable)
        selected = preferredResolution(options);
      const focused = root.contains(document.activeElement) ? document.activeElement.dataset.streamResolution : null;
      render();
      if (focused) (_a = root.querySelector(`[data-stream-resolution="${focused}"]`)) == null ? void 0 : _a.focus();
      if (first) prepare();
    }).catch((error) => {
      if (!root.isConnected) return;
      cards.innerHTML = "";
      readiness.textContent = `${error.message} You can download it instead.`;
      onChange(null, null);
    });
    return state;
  }
  var artwork = (...urls) => urls.find((url) => /^https?:\/\//.test(url || "")) || "";
  function openStreamSheet({ item, title, onPlay, onDownload }) {
    var _a, _b;
    const image = artwork(item.thumbnail, title.background, title.poster);
    const resumable = ((_a = item.state) == null ? void 0 : _a.position) >= 10 && !((_b = item.state) == null ? void 0 : _b.completed);
    const subtitle = title.kind === "movie" ? title.year || "Movie" : `${episodeLabel(item)}${item.name ? " \xB7 " + item.name : ""}`;
    modal(
      `<div class="stream-sheet"><div class="stream-sheet-head">${image ? `<img class="stream-sheet-art" src="${esc(image)}" alt="">` : ""}<div class="stream-sheet-title"><p class="eyebrow">Stream now</p><h2>${esc(title.name)}</h2><p class="meta">${esc(subtitle)}</p></div></div><div class="stream-options" role="group" aria-label="Stream quality"></div><p class="stream-readiness" role="status" aria-live="polite"></p><div class="actions stream-sheet-actions"><button type="button" class="primary stream-play" data-sheet-play>${icon("play")}<span>${resumable ? `Resume from ${clockTime(item.state.position)}` : "Play"}</span></button>${resumable ? '<button type="button" data-sheet-restart>From the beginning</button>' : ""}<button type="button" class="quiet" data-sheet-download>Download instead</button></div></div>`
    );
    const root = $("#dialog-content .stream-sheet");
    const play2 = root.querySelector("[data-sheet-play]");
    const chooser = bindChooser(root, item.id, {
      onChange: (resolution, options) => {
        var _a2, _b2;
        play2.disabled = !!options && (!options.canStream || !((_a2 = options.guard) == null ? void 0 : _a2.ok) || !resolution);
        if (play2.disabled && document.activeElement === play2)
          (_b2 = root.querySelector(".stream-recheck, [data-sheet-download]")) == null ? void 0 : _b2.focus();
      }
    });
    setTimeout(() => (play2.disabled ? root.querySelector("[data-sheet-download]") : play2).focus(), 0);
    $("#dialog").addEventListener("close", chooser.close, { once: true });
    $("#dialog-content").onclick = (event) => {
      const start = event.target.closest("[data-sheet-play], [data-sheet-restart]");
      if (start && !start.disabled) {
        chooser.close();
        if (chooser.picked && chooser.selected) saveResolution(chooser.selected);
        onPlay({ resolution: chooser.selected, replay: start.hasAttribute("data-sheet-restart") });
      } else if (event.target.closest("[data-sheet-download]")) {
        chooser.close();
        onDownload();
      }
    };
  }
  var streamPanelHtml = (item) => `<div class="stream-panel" data-stream-panel="${esc(item.id)}"><p class="stream-panel-label">Stream quality</p><div class="stream-options" role="group" aria-label="Stream quality"></div><p class="stream-readiness" role="status" aria-live="polite"></p></div>`;
  var panelState = null;
  function closeStreamPanel() {
    panelState == null ? void 0 : panelState.close();
  }
  function bindStreamPanel(item) {
    panelState == null ? void 0 : panelState.close();
    panelState = null;
    const root = document.querySelector(`[data-stream-panel="${item.id}"]`);
    if (!root) return;
    const button2 = document.querySelector(`[data-action="stream-play"][data-item="${item.id}"]`);
    panelState = bindChooser(root, item.id, {
      auto: true,
      onChange: (resolution, options) => {
        var _a;
        if (!button2) return;
        if (resolution) button2.dataset.resolution = String(resolution);
        else delete button2.dataset.resolution;
        button2.dataset.picked = String(!!(panelState == null ? void 0 : panelState.picked));
        button2.disabled = !!options && (!options.canStream || !((_a = options.guard) == null ? void 0 : _a.ok) || !resolution);
      }
    });
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
    var _a;
    subtitleRenderer == null ? void 0 : subtitleRenderer.detach();
    for (const track of Array.from(video().textTracks || [])) track.mode = "disabled";
    video().querySelectorAll("track").forEach((t) => {
      if (t.dataset.blob) URL.revokeObjectURL(t.dataset.blob);
      t.remove();
    });
    if (active == null ? void 0 : active.stream) {
      clearTimeout((_a = active.stream.subtitle) == null ? void 0 : _a.retry);
      active.stream.subtitle = null;
    }
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
    if (!active || loading || !active.session) return;
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
    const stream = active == null ? void 0 : active.stream;
    if (stream) detachStream(stream);
    hideStartup();
    const owner = active;
    const stopped = report("stop");
    loading = true;
    video().pause();
    $("#player").hidden = true;
    document.body.classList.remove("player-open");
    releaseSubtitleFile();
    if (stream) stopStream(stream);
    await stopped;
    if (active !== owner) return;
    $("#shell").removeAttribute("inert");
    await releaseConversion();
    video().removeAttribute("src");
    video().load();
    active = null;
    clearTimeout(controlsTimer);
    closeSettings();
    closeSubtitles();
    queue = null;
    loading = false;
    window.dispatchEvent(new Event("library-changed"));
  }
  async function play(itemId, titleId, { replay = false, queueId = null, stream = null } = {}) {
    var _a;
    if (stream) return playStream(itemId, titleId, { replay, queueId, ...stream });
    closeStreamPanel();
    await closeLive();
    clearInterval(timer);
    cancelNext();
    const previousStream = active == null ? void 0 : active.stream;
    if (previousStream) detachStream(previousStream);
    hideStartup();
    await report("stop");
    loading = true;
    video().pause();
    releaseSubtitleFile();
    if (previousStream) stopStream(previousStream);
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
      renderQuality();
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
      const { supportedSubtitles, preferred } = populateMenus(info, preferences);
      if (info.direct && (!preferred || preferred.index === ((_a = info.audio[0]) == null ? void 0 : _a.index)))
        await source(`/api/items/${itemId}/file`, session.position);
      else await convert(session.position);
      applyPreferredSubtitles(supportedSubtitles, preferences);
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
  var textSubtitleCodecs = ["subrip", "ass", "ssa", "webvtt", "mov_text"];
  function populateMenus(info, preferences) {
    $("#audio").innerHTML = info.audio.map(
      (t) => `<option value="${t.index}">${esc(t.language)} \xB7 ${esc(t.title || t.codec)} ${t.channels || ""}</option>`
    ).join("");
    const supportedSubtitles = info.subtitles.filter((t) => textSubtitleCodecs.includes(t.codec));
    $("#subtitles").innerHTML = '<option value="">Off</option>' + supportedSubtitles.map(
      (t) => `<option value="${t.index}">${esc(subtitleLanguageLabel(t.language))} \xB7 ${esc(t.title || t.codec)}</option>`
    ).join("");
    if (!supportedSubtitles.length)
      $("#subtitle-status").textContent = info.subtitles.length ? "This file only has image subtitles. Find online subtitles or open an SRT/VTT file." : "No subtitles in this file. Find online subtitles or open an SRT/VTT file.";
    updateQueueButtons();
    const preferred = info.audio.find(
      (t) => preferences.audioLanguage && t.language === preferences.audioLanguage
    );
    if (preferred) $("#audio").value = String(preferred.index);
    return { supportedSubtitles, preferred };
  }
  function updateQueueButtons() {
    var _a, _b;
    if (!active) return;
    $("#previous").disabled = !queue || queue.index <= 0;
    $("#next").disabled = !queue || queue.index >= queue.items.length - 1;
    $("#player-queue").disabled = !queue;
    $("#previous").hidden = $("#next").hidden = $("#player-queue").hidden = !queue;
    $("#chapters").hidden = !((_a = active.info.chapters) == null ? void 0 : _a.length);
    $("#chapters").disabled = !((_b = active.info.chapters) == null ? void 0 : _b.length);
  }
  function applyPreferredSubtitles(supportedSubtitles, preferences) {
    if (preferences.subtitleMode !== "preferred") return;
    const track = supportedSubtitles.find(
      (t) => t.language === preferences.subtitleLanguage || isArabic(t.language) && isArabic(preferences.subtitleLanguage)
    );
    if (track) {
      $("#subtitles").value = String(track.index);
      setSubtitles();
    }
  }
  function renderTitle() {
    const { title, item } = active;
    $("#player-title").textContent = title.name || "";
    $("#player-episode").textContent = title.kind === "movie" || !item.episode ? "" : `${episodeLabel(item)}${item.name ? " \xB7 " + item.name : ""}`;
  }
  var artworkUrl = (...urls) => urls.find((url) => /^https?:\/\//.test(url || "")) || "";
  var absolutePosition = () => active ? playbackPosition(video().currentTime, active.offset, active.info.duration) : 0;
  var newStream = (fields) => ({
    id: null,
    itemId: null,
    resolution: null,
    // Compatibility playback: every start/convert of this stream asks for an H.264 transcode.
    forceTranscode: false,
    // Conversions this player has already used or seen on the session. A start always makes
    // a new one, but the first status after it may still describe the previous attempt.
    seen: /* @__PURE__ */ new Set(),
    status: null,
    startedAt: Date.now(),
    sourced: false,
    probed: false,
    failed: null,
    closing: false,
    stale: false,
    events: null,
    heartbeat: null,
    tick: null,
    switching: null,
    nextPrepared: false,
    conversionSubtitles: [],
    subtitle: null,
    recoveredAt: 0,
    ...fields
  });
  var streamCapabilities = (stream) => stream.forceTranscode ? { ...deviceCapabilities(), forceTranscode: true } : deviceCapabilities();
  var freshConversion = (stream, status) => status.conversion && !stream.seen.has(status.conversion.id) ? status.conversion : null;
  function streamEvents(owner, id, handler) {
    const gone = (error) => {
      if (error.status === 404 && active === owner)
        handler({ id, state: "stopped", message: "The stream ended. It may have expired." });
    };
    if (!window.EventSource) {
      const poll2 = setInterval(() => api(`/api/streams/${id}`).then(handler, gone), 500);
      return { close: () => clearInterval(poll2) };
    }
    const events = new EventSource(`/api/streams/${id}/events`);
    events.addEventListener("status", (event) => {
      if (active !== owner) return events.close();
      let status;
      try {
        status = JSON.parse(event.data);
      } catch {
        return;
      }
      handler(status);
    });
    events.onerror = () => {
      if (events.readyState === 2 && active === owner) api(`/api/streams/${id}`).then(handler, gone);
    };
    return events;
  }
  function detachStream(stream) {
    var _a, _b;
    (_a = stream.events) == null ? void 0 : _a.close();
    stream.events = null;
    clearInterval(stream.heartbeat);
    clearInterval(stream.tick);
    const switching = stream.switching;
    if (switching) {
      (_b = switching.events) == null ? void 0 : _b.close();
      clearTimeout(switching.timer);
    }
  }
  function stopStream(stream) {
    var _a;
    detachStream(stream);
    if (stream.closing) return;
    stream.closing = true;
    const ids = [stream.id, (_a = stream.switching) == null ? void 0 : _a.id].filter(Boolean);
    stream.switching = null;
    for (const id of ids) api(`/api/streams/${id}`, {}, "DELETE").catch(() => {
    });
    if (ids.length) streamStopped(stream.itemId);
  }
  function heartbeat2(owner) {
    var _a, _b;
    const stream = owner.stream;
    if (active !== owner || !stream.id || stream.failed || stream.closing) return;
    const position = Math.max(0, (_a = owner.pendingPosition) != null ? _a : absolutePosition());
    api(`/api/streams/${stream.id}/heartbeat`, { position }).catch((error) => {
      if (error.status === 404 && active === owner && owner.stream === stream && !stream.closing)
        void showStreamFailure(owner, "stopped", "The stream ended on the server.");
    });
    const subtitle = stream.subtitle;
    const c = (_b = stream.status) == null ? void 0 : _b.conversion;
    const written = c && c.id === conversion ? c.offset + (c.convertedSeconds || 0) : Infinity;
    if (subtitle && subtitle.loaded && !subtitle.complete && !subtitle.fetching && !loading && $("#subtitles").value === String(subtitle.index) && written > subtitle.until + 20 && (position > subtitle.until - 60 || Date.now() - subtitle.loadedAt > 45e3))
      refreshStreamSubtitle(owner, subtitle);
  }
  function hideStartup() {
    $("#stream-start").hidden = true;
    $("#stream-start").classList.remove("failed");
    $("#player").classList.remove("stream-starting");
  }
  function showStartupShell(owner) {
    const image = artworkUrl(owner.title.background, owner.item.thumbnail, owner.title.poster);
    const art = $("#stream-start-art");
    if (image && art.getAttribute("src") !== image) art.src = image;
    if (!image) art.removeAttribute("src");
    art.hidden = !image;
    $("#stream-start").hidden = false;
    $("#player").classList.add("stream-starting");
  }
  var startupSteps = ["sources", "connecting", "buffering"];
  function renderStartup(owner, status) {
    const stream = owner.stream;
    if (active !== owner || stream.failed) return;
    const view = startupView(status, { elapsedMs: Date.now() - stream.startedAt });
    const panel = $("#stream-start");
    panel.classList.remove("failed");
    $("#stream-start-title").textContent = view.title;
    $("#stream-start-detail").textContent = view.detail;
    const current = startupSteps.indexOf(view.stage);
    panel.querySelectorAll("[data-step]").forEach((step, index) => {
      step.classList.toggle("done", index < current || view.stage === "playing");
      step.classList.toggle("current", index === current);
    });
    $("#stream-start-meter").classList.toggle("indeterminate", view.progress == null);
    $("#stream-start-bar").style.width = view.progress == null ? "" : `${Math.round(view.progress * 100)}%`;
    const resolution = (status == null ? void 0 : status.resolution) || stream.resolution;
    $("#stream-start-quality").textContent = [
      resolution ? resolutionLabel(resolution) : "",
      ...releaseFacts(status == null ? void 0 : status.release)
    ].filter(Boolean).join(" \xB7 ");
    $("#stream-start-note").textContent = [
      fallbackNote(status) || (owner.stream.forceTranscode ? "This device cannot play the original video, so the server is converting it." : ""),
      ...filterWarnings(status)
    ].filter(Boolean).join(" ");
    $("#stream-start-actions").innerHTML = "";
  }
  function showStreamFailure(owner, reason, message) {
    var _a;
    const stream = owner.stream;
    if (active !== owner || stream.closing) return;
    stream.failed = { reason, message };
    if (stream.sourced) stream.failedAt = Math.max(0, (_a = owner.pendingPosition) != null ? _a : absolutePosition());
    clearInterval(stream.tick);
    if (stream.switching) cancelSwitch(owner);
    loading = false;
    owner.pendingPosition = null;
    video().pause();
    closeSettings();
    closeSubtitles();
    if (reason === "playback" && !stream.forceTranscode) {
      decodeFailed(owner.info);
      void restartStream(owner, { forceTranscode: true });
      return;
    }
    let ownOthers = 0;
    const render = () => {
      var _a2, _b;
      if (active !== owner || owner.stream !== stream || !stream.failed) return;
      const options = cachedOptions(owner.item.id);
      const option3 = (options == null ? void 0 : options.resolutions.find((o) => o.resolution !== stream.resolution)) || null;
      const otherResolution = option3 ? option3.resolution : stream.resolution === 2160 ? 1080 : 2160;
      const view = failureView(reason, message, {
        resolution: stream.resolution,
        other: option3 && {
          resolution: otherResolution,
          available: streamPlan(option3, deviceCapabilities()).selectable
        },
        canDownload: canStream(),
        ownOthers,
        compatible: stream.forceTranscode
      });
      $("#stream-start").classList.add("failed");
      $("#stream-start-title").textContent = view.title;
      $("#stream-start-detail").textContent = view.body;
      $("#stream-start-note").textContent = "";
      const focused = (_b = (_a2 = document.activeElement) == null ? void 0 : _a2.dataset) == null ? void 0 : _b.streamAction;
      $("#stream-start-actions").innerHTML = view.actions.map(
        (action2, index) => `<button type="button" class="${index ? "" : "primary"}" data-stream-action="${action2.id}" ${action2.resolution ? `data-resolution="${action2.resolution}"` : ""}>${esc(action2.label)}</button>`
      ).join("");
      const target = focused && $(`#stream-start-actions [data-stream-action="${focused}"]`) || $("#stream-start-actions button");
      target == null ? void 0 : target.focus();
    };
    showStartupShell(owner);
    render();
    streamOptions(owner.item.id).then(render, () => {
    });
    if (reason === "limit")
      ownStreams(owner).then(
        (list) => {
          ownOthers = list.length;
          render();
        },
        () => {
        }
      );
    updateTransport();
    showControls();
  }
  function restartStream(owner, { resolution = owner.stream.resolution, forceTranscode = owner.stream.forceTranscode } = {}) {
    var _a;
    const position = owner.stream.sourced ? (_a = owner.stream.failedAt) != null ? _a : absolutePosition() : void 0;
    return playStream(owner.item.id, owner.title.id, {
      queueId: queue == null ? void 0 : queue.id,
      resolution,
      position,
      forceTranscode,
      hint: { title: owner.title, item: owner.item }
    });
  }
  async function ownStreams(owner) {
    var _a;
    const { items } = await api("/api/streams");
    const keep = [owner.stream.id, (_a = owner.stream.switching) == null ? void 0 : _a.id];
    return items.filter((s) => s.player === playerId() && !keep.includes(s.id));
  }
  async function stopOtherStreams(owner) {
    const mine = await ownStreams(owner);
    await Promise.all(mine.map((s) => api(`/api/streams/${s.id}`, {}, "DELETE").catch(() => {
    })));
  }
  async function playStream(itemId, titleId, {
    replay = false,
    queueId = null,
    resolution = null,
    hint = null,
    position,
    forceTranscode = false
  } = {}) {
    var _a, _b, _c, _d;
    clearInterval(timer);
    cancelNext();
    closeStreamPanel();
    const previous = active;
    const previousStream = (previous == null ? void 0 : previous.stream) || null;
    if (previousStream) detachStream(previousStream);
    void report("stop");
    loading = true;
    video().pause();
    releaseSubtitleFile();
    let released = Promise.resolve();
    if (previousStream) {
      if (hls2) hls2.destroy();
      hls2 = null;
      conversion = null;
    } else released = releaseConversion();
    video().removeAttribute("src");
    video().load();
    const title = (hint == null ? void 0 : hint.title) || (((_a = previous == null ? void 0 : previous.title) == null ? void 0 : _a.id) === titleId ? previous.title : { id: titleId, name: "" });
    const item = (hint == null ? void 0 : hint.item) || ((_b = title.items) == null ? void 0 : _b.find((i) => i.id === itemId)) || { id: itemId };
    active = {
      item,
      title,
      info: { duration: 0, audio: [], subtitles: [], chapters: [] },
      preferences: (previous == null ? void 0 : previous.preferences) || {},
      session: null,
      seq: 0,
      offset: 0,
      pendingPosition: replay ? 0 : position != null ? position : item.state && !item.state.completed ? item.state.position || 0 : 0,
      subtitleDelay: 0,
      onlineSubtitles: [],
      stream: newStream({
        itemId,
        resolution: resolution || null,
        forceTranscode,
        // A retry reuses this player's session: the earlier attempts' conversions are stale.
        seen: new Set(
          previousStream ? [...previousStream.seen, (_d = (_c = previousStream.status) == null ? void 0 : _c.conversion) == null ? void 0 : _d.id].filter(Boolean) : []
        )
      })
    };
    const owner = active, stream = owner.stream;
    const releasePrevious = (keepId) => {
      var _a2;
      if ((previousStream == null ? void 0 : previousStream.id) && previousStream.id !== keepId && previousStream.id !== ((_a2 = active == null ? void 0 : active.stream) == null ? void 0 : _a2.id))
        stopStream(previousStream);
    };
    queue = null;
    try {
      const saved = Number(localStorage.getItem(`mw:subsync:${itemId}`));
      if (Number.isFinite(saved)) owner.subtitleDelay = Math.max(-120, Math.min(120, saved));
    } catch {
    }
    $("#subtitle-delay").value = String(owner.subtitleDelay);
    $("#subtitle-status").textContent = "";
    $("#subtitle-find").disabled = false;
    $("#player-subtitles-toggle").classList.remove("subtitles-active");
    $("#audio").innerHTML = "";
    $("#subtitles").innerHTML = '<option value="">Off</option>';
    scrubbing = false;
    $("#player").hidden = false;
    document.body.classList.add("player-open");
    closeSettings();
    closeSubtitles();
    $("#shell").setAttribute("inert", "");
    renderTitle();
    $("#player-message").textContent = "";
    updateQueueButtons();
    showStartupShell(owner);
    renderStartup(owner, null);
    stream.tick = setInterval(() => {
      if (!stream.sourced) renderStartup(owner, stream.status);
    }, 1e3);
    renderQuality();
    updateTransport();
    $("#player-close").focus();
    showControls();
    try {
      const titleRequest = api(`/api/titles/${titleId}`);
      titleRequest.catch(() => {
      });
      const teardown = Promise.all([closeLive().catch(() => {
      }), released.catch(() => {
      })]);
      const start = async () => {
        let chosen = resolution;
        if (!chosen) {
          const options = await streamOptions(itemId).catch(() => null);
          if (active !== owner) return null;
          chosen = options ? preferredResolution(options) : null;
          if (options && !chosen) {
            const fallback = options.resolutions[0];
            throw Object.assign(new Error((fallback == null ? void 0 : fallback.reason) || ""), { reason: "unavailable" });
          }
          stream.resolution = chosen;
          renderStartup(owner, null);
        }
        const body = { capabilities: streamCapabilities(stream), player: playerId() };
        if (chosen) body.resolution = chosen;
        if (replay) body.position = 0;
        else if (position != null) body.position = Math.max(0, position);
        return api(`/api/items/${itemId}/stream`, body);
      };
      const [status] = await Promise.all([start(), teardown]);
      if (!status) return releasePrevious();
      releasePrevious(status.id);
      const fresh = await titleRequest.catch((error) => {
        api(`/api/streams/${status.id}`, {}, "DELETE").catch(() => {
        });
        throw error;
      });
      if (active !== owner) {
        if (!active || active.item.id !== itemId)
          api(`/api/streams/${status.id}`, {}, "DELETE").catch(() => {
          });
        return;
      }
      owner.title = fresh;
      owner.item = fresh.items.find((i) => i.id === itemId) || item;
      stream.id = status.id;
      stream.resolution = status.resolution;
      renderTitle();
      showStartupShell(owner);
      renderQuality();
      stream.events = streamEvents(owner, status.id, (next) => onStreamStatus(owner, next));
      stream.heartbeat = setInterval(() => heartbeat2(owner), 3e3);
      stream.setup = (async () => {
        const [preferences2, q2] = await Promise.all([
          api("/api/preferences"),
          queueId ? api(`/api/queues/${queueId}`) : fresh.kind !== "movie" ? api("/api/queues", { titleId, startItem: itemId }) : null
        ]);
        const session2 = await api("/api/playback", { itemId, replay, queueId: q2 == null ? void 0 : q2.id });
        return { preferences: preferences2, q: q2, session: session2 };
      })();
      onStreamStatus(owner, status);
      const { preferences, q, session } = await stream.setup;
      if (active !== owner) return;
      owner.preferences = preferences;
      owner.session = session;
      queue = q;
      updateQueueButtons();
      timer = setInterval(() => void report(), 1e4);
    } catch (error) {
      releasePrevious();
      if (active === owner) showStreamFailure(owner, failureReason(error), error.message);
    }
  }
  function onStreamStatus(owner, status) {
    var _a, _b, _c;
    const stream = owner.stream;
    if (active !== owner || status.id !== stream.id || stream.closing) return;
    stream.status = status;
    if (status.playback && !stream.probed) {
      stream.probed = true;
      owner.info = status.playback;
      populateMenus(owner.info, owner.preferences || {});
    }
    const fresh = stream.sourced ? status.conversion : freshConversion(stream, status);
    const staleFailure = ((_a = status.error) == null ? void 0 : _a.reason) === "conversion" && status.conversion && !fresh && !stream.sourced;
    if ((fresh == null ? void 0 : fresh.audio) != null && !stream.sourced) $("#audio").value = String(fresh.audio);
    if (status.state === "failed" && !staleFailure)
      return showStreamFailure(owner, failureReason(status), ((_b = status.error) == null ? void 0 : _b.message) || status.message);
    if (status.state === "stopped") return showStreamFailure(owner, "stopped", status.message);
    if (stream.failed) return;
    const warnings = filterWarnings(status).filter((w) => !(stream.warned || (stream.warned = /* @__PURE__ */ new Set())).has(w));
    if (warnings.length && status.playback) {
      warnings.forEach((w) => stream.warned.add(w));
      toast(warnings.join(" "));
    }
    stream.stale = ((_c = status.conversion) == null ? void 0 : _c.state) === "stopped";
    if (!stream.sourced) {
      if ((fresh == null ? void 0 : fresh.requested) != null) owner.pendingPosition = fresh.requested;
      else if (status.resumePosition != null) owner.pendingPosition = status.resumePosition;
      renderStartup(
        owner,
        staleFailure || status.conversion && !fresh ? { ...status, state: "starting", conversion: null, error: null } : status
      );
      if ((fresh == null ? void 0 : fresh.state) === "ready" && fresh.url) void beginPlayback(owner, fresh);
    }
    updateTransport();
  }
  async function beginPlayback(owner, c) {
    const stream = owner.stream;
    stream.sourced = true;
    stream.seen.add(c.id);
    clearInterval(stream.tick);
    try {
      const { preferences } = await stream.setup;
      if (active !== owner || owner.stream !== stream || stream.failed) return;
      conversion = c.id;
      owner.offset = c.offset;
      stream.conversionSubtitles = c.subtitles || [];
      await source(c.url, Math.max(0, (c.requested || 0) - c.offset), true);
      if (active !== owner || owner.stream !== stream) return;
      hideStartup();
      applyPreferredSubtitles(
        owner.info.subtitles.filter((t) => textSubtitleCodecs.includes(t.codec)),
        preferences
      );
      loading = false;
      owner.pendingPosition = null;
      updateTransport();
      if (preferences.subtitleMode === "preferred" && preferences.subtitleLanguage && $("#subtitles").value === "")
        void findSubtitles(true);
      showControls();
    } catch (error) {
      if (active === owner && owner.stream === stream)
        showStreamFailure(owner, failureReason(error), error.message);
    }
  }
  async function convertStream(owner, position, autoplay) {
    let stream = owner.stream;
    if (stream.switching) {
      if (stream.switching.latest) stream = promoteSwitch(owner, stream, stream.switching, true);
      else cancelSwitch(owner);
    }
    if (hls2) hls2.destroy();
    hls2 = null;
    let result;
    try {
      result = await api(`/api/streams/${stream.id}/convert`, {
        position,
        audio: Number($("#audio").value) || void 0,
        capabilities: streamCapabilities(stream)
      });
    } catch (error) {
      if (active === owner && owner.stream === stream) {
        owner.pendingPosition = position;
        showStreamFailure(owner, failureReason(error), error.message);
      }
      return;
    }
    if (active !== owner || owner.stream !== stream) return;
    conversion = result.id;
    stream.seen.add(result.id);
    owner.offset = result.offset;
    stream.conversionSubtitles = result.subtitles || [];
    stream.stale = false;
    try {
      await source(result.url, Math.max(0, position - result.offset), autoplay);
    } catch (error) {
      if (active === owner && owner.stream === stream) {
        owner.pendingPosition = position;
        showStreamFailure(owner, "playback", error.message);
      }
      return;
    }
    setSubtitles();
    $("#player-message").textContent = "";
  }
  function renderQuality() {
    var _a, _b;
    const group = $("#stream-quality"), stream = active == null ? void 0 : active.stream;
    group.hidden = !stream;
    if (!stream) return;
    const options = cachedOptions(active.item.id);
    const focused = group.contains(document.activeElement) ? document.activeElement.dataset.streamResolution : null;
    $("#stream-quality-options").innerHTML = optionCards(
      options,
      ((_a = stream.switching) == null ? void 0 : _a.resolution) || stream.resolution
    );
    if (focused) (_b = $(`#stream-quality-options [data-stream-resolution="${focused}"]`)) == null ? void 0 : _b.focus();
    streamOptions(active.item.id).then(
      (fresh) => (active == null ? void 0 : active.stream) === stream && fresh !== options && renderQuality(),
      () => {
      }
    );
  }
  var switchMessageTimer = null;
  function switchMessage(text, clearAfter = 0) {
    clearTimeout(switchMessageTimer);
    $("#stream-quality-status").textContent = text;
    $("#player-message").textContent = text;
    if (clearAfter)
      switchMessageTimer = setTimeout(() => {
        if ($("#player-message").textContent === text) $("#player-message").textContent = "";
        if ($("#stream-quality-status").textContent === text)
          $("#stream-quality-status").textContent = "";
      }, clearAfter);
  }
  function cancelSwitch(owner) {
    var _a;
    const switching = owner.stream.switching;
    if (!switching) return;
    owner.stream.switching = null;
    (_a = switching.events) == null ? void 0 : _a.close();
    clearTimeout(switching.timer);
    if (switching.id) api(`/api/streams/${switching.id}`, {}, "DELETE").catch(() => {
    });
    renderQuality();
  }
  async function changeResolution(resolution) {
    var _a, _b;
    const owner = active, stream = owner == null ? void 0 : owner.stream;
    if (!(stream == null ? void 0 : stream.id) || resolution === (((_a = stream.switching) == null ? void 0 : _a.resolution) || stream.resolution)) return;
    saveResolution(resolution);
    if (!stream.sourced || stream.failed) {
      closeSettings();
      return void restartStream(owner, { resolution });
    }
    cancelSwitch(owner);
    if (resolution === stream.resolution) {
      switchMessage(`Staying in ${resolutionLabel(resolution)}`, 4e3);
      return;
    }
    const label = resolutionLabel(resolution);
    const switching = { resolution, id: null, events: null, latest: null, readyAt: 0, timer: null };
    stream.switching = switching;
    renderQuality();
    switchMessage(`Switching to ${label}. Playback continues meanwhile.`);
    try {
      const status = await api(`/api/streams/${stream.id}/resolution`, {
        resolution,
        position: Math.max(0, absolutePosition()),
        capabilities: streamCapabilities(stream)
      });
      if (active !== owner || owner.stream !== stream || stream.switching !== switching) {
        if (status.id !== ((_b = active == null ? void 0 : active.stream) == null ? void 0 : _b.id))
          api(`/api/streams/${status.id}`, {}, "DELETE").catch(() => {
          });
        return;
      }
      switching.id = status.id;
      switching.events = streamEvents(
        owner,
        status.id,
        (next) => onSwitchStatus(owner, stream, switching, next)
      );
      onSwitchStatus(owner, stream, switching, status);
    } catch (error) {
      if (stream.switching !== switching) return;
      stream.switching = null;
      renderQuality();
      const view = failureView(failureReason(error), error.message, { resolution });
      switchMessage(`${view.title}. Still playing in ${resolutionLabel(stream.resolution)}.`, 8e3);
    }
  }
  function onSwitchStatus(owner, stream, switching, status) {
    var _a;
    if (active !== owner || owner.stream !== stream || stream.switching !== switching) return;
    if (status.id !== switching.id) return;
    const label = resolutionLabel(switching.resolution);
    if (status.state === "failed" || status.state === "stopped") {
      cancelSwitch(owner);
      const view2 = failureView(failureReason(status), ((_a = status.error) == null ? void 0 : _a.message) || status.message, {
        resolution: switching.resolution
      });
      switchMessage(`${view2.title}. Still playing in ${resolutionLabel(stream.resolution)}.`, 8e3);
      return;
    }
    switching.latest = status;
    const c = status.conversion;
    if ((c == null ? void 0 : c.state) === "ready" && c.url) {
      if (!switching.readyAt) {
        switching.readyAt = Date.now();
        switching.timer = setTimeout(() => void swapStream(owner, stream, switching), 8e3);
      }
      if (video().paused || c.offset + (c.convertedSeconds || 0) >= absolutePosition() + 3)
        void swapStream(owner, stream, switching);
      else switchMessage(`Switching to ${label}: almost ready.`);
      return;
    }
    const view = startupView(status);
    switchMessage(
      `Switching to ${label}: ${view.title.toLowerCase()}${view.progress != null && status.state === "probing" ? ` ${Math.round(view.progress / 0.95 * 100)}%` : ""}. Playback continues meanwhile.`
    );
  }
  function promoteSwitch(owner, old, switching, stopOld) {
    var _a, _b, _c, _d, _e;
    old.switching = null;
    (_a = switching.events) == null ? void 0 : _a.close();
    clearTimeout(switching.timer);
    detachStream(old);
    const status = switching.latest;
    const next = newStream({
      id: status.id,
      itemId: old.itemId,
      resolution: switching.resolution,
      forceTranscode: old.forceTranscode,
      seen: new Set(status.conversion ? [status.conversion.id] : []),
      status,
      sourced: true,
      probed: !!status.playback,
      // Next Up is prepared again at the new resolution.
      nextPrepared: false,
      conversionSubtitles: ((_b = status.conversion) == null ? void 0 : _b.subtitles) || []
    });
    owner.stream = next;
    next.events = streamEvents(owner, status.id, (s) => onStreamStatus(owner, s));
    next.heartbeat = setInterval(() => heartbeat2(owner), 3e3);
    if (status.playback) {
      const choice = $("#subtitles").value;
      const language = (_c = owner.info.subtitles.find((t) => String(t.index) === choice)) == null ? void 0 : _c.language;
      owner.info = status.playback;
      populateMenus(owner.info, owner.preferences || {});
      if (((_d = status.conversion) == null ? void 0 : _d.audio) != null) $("#audio").value = String(status.conversion.audio);
      addOnlineSubtitles(owner.onlineSubtitles);
      if (owner.subtitleFile) addFileOption(((_e = owner.subtitleUpload) == null ? void 0 : _e.name) || "Subtitle file");
      const same = language && owner.info.subtitles.find((t) => t.language === language);
      $("#subtitles").value = choice.startsWith("online:") || choice === "file" ? choice : same ? String(same.index) : "";
    }
    if (stopOld) stopStream(old);
    renderQuality();
    return next;
  }
  async function swapStream(owner, old, switching) {
    if (active !== owner || owner.stream !== old || old.switching !== switching) return;
    if (loading) {
      clearTimeout(switching.timer);
      switching.timer = setTimeout(() => void swapStream(owner, old, switching), 500);
      return;
    }
    const position = absolutePosition(), resume = !video().paused;
    const next = promoteSwitch(owner, old, switching, false);
    const c = switching.latest.conversion;
    loading = true;
    owner.pendingPosition = position;
    updateTransport();
    if (hls2) hls2.destroy();
    hls2 = null;
    conversion = c.id;
    owner.offset = c.offset;
    try {
      await source(c.url, Math.max(0, position - c.offset), resume);
      if (active !== owner || owner.stream !== next) return;
      setSubtitles();
      switchMessage(`Now streaming in ${resolutionLabel(next.resolution)}.`, 4e3);
    } catch (error) {
      if (active === owner && owner.stream === next)
        showStreamFailure(owner, "playback", error.message);
    } finally {
      stopStream(old);
      if (active === owner) {
        loading = false;
        owner.pendingPosition = null;
        updateTransport();
        showControls();
      }
    }
  }
  async function source(url, seek = 0, autoplay = true) {
    clearSubtitleTrack();
    return new Promise((resolve, reject) => {
      var _a;
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          Object.assign(new Error("Playback could not start. Try compatibility playback."), {
            reason: "playback"
          })
        );
      }, 25e3);
      const error = () => {
        cleanup();
        reject(
          Object.assign(new Error("This format needs compatibility playback."), {
            reason: "playback"
          })
        );
      };
      const cleanup = () => {
        clearTimeout(timeout);
        video().removeEventListener("error", error);
        video().onloadedmetadata = null;
      };
      let settled = false;
      video().addEventListener("error", error, { once: true });
      video().onloadedmetadata = () => {
        cleanup();
        settled = true;
        if (seek > 0) video().currentTime = seek;
        if (autoplay)
          video().play().catch(() => {
            $("#player-message").textContent = "Press Play to begin.";
          });
        resolve();
      };
      if (url.includes(".m3u8") && ((_a = window.Hls) == null ? void 0 : _a.isSupported())) {
        const instance = hls2 = new window.Hls({ startPosition: 0, lowLatencyMode: false });
        hls2.loadSource(url);
        hls2.attachMedia(video());
        hls2.on(window.Hls.Events.ERROR, (_, data) => {
          if (!data.fatal || hls2 !== instance) return;
          const owner = active, stream = owner == null ? void 0 : owner.stream;
          if (!settled) {
            cleanup();
            if (!stream)
              $("#player-message").textContent = "Playback failed. Try compatibility playback again.";
            reject(
              Object.assign(
                new Error(
                  stream ? "The video could not be played." : "Compatibility playback failed"
                ),
                { reason: "playback" }
              )
            );
            return;
          }
          if (!stream) {
            $("#player-message").textContent = "Playback failed. Try compatibility playback again.";
            return;
          }
          if (!loading && Date.now() - stream.recoveredAt > 15e3) {
            stream.recoveredAt = Date.now();
            void convert(absolutePosition(), !video().paused).catch((e) => toast(e.message));
          } else showStreamFailure(owner, "playback", "Playback kept failing on this device.");
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
      if (owner.stream) return await convertStream(owner, position, autoplay);
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
  function syncFor(owner, track, external) {
    const originals = /* @__PURE__ */ new WeakMap();
    return () => {
      if (active !== owner || !track.isConnected) return;
      shiftSubtitleCues(
        track.track.cues,
        active.subtitleDelay,
        external ? active.offset : 0,
        originals
      );
      subtitleRenderer.render();
    };
  }
  function setSubtitles() {
    var _a, _b, _c;
    clearSubtitleTrack();
    const index = $("#subtitles").value;
    $("#player-subtitles-toggle").classList.toggle("subtitles-active", index !== "");
    if (index === "" || !active) return;
    const owner = active;
    const label = ((_a = $("#subtitles").selectedOptions[0]) == null ? void 0 : _a.textContent) || "Subtitles";
    const language = index.startsWith("online:") ? (_b = active.onlineSubtitles.find((t) => t.id === index.slice(7))) == null ? void 0 : _b.language : (_c = active.info.subtitles.find((t) => String(t.index) === index)) == null ? void 0 : _c.language;
    const srclang = language ? isArabic(language) ? "ar" : language : "";
    const external = index.startsWith("online:") || index === "file";
    if (!external && active.stream) {
      if (!active.stream.conversionSubtitles.includes(Number(index))) {
        $("#subtitles").value = "";
        $("#player-subtitles-toggle").classList.remove("subtitles-active");
        $("#subtitle-status").textContent = "This track is not available while streaming. Find online subtitles instead.";
        return;
      }
      active.stream.subtitle = {
        index: Number(index),
        label,
        srclang,
        until: 0,
        complete: false,
        loadedAt: 0,
        loaded: false,
        fetching: false,
        attempts: 0,
        retry: null
      };
      return loadStreamSubtitle(owner, active.stream.subtitle);
    }
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = label;
    if (srclang) track.srclang = srclang;
    track.src = index === "file" ? active.subtitleFile : index.startsWith("online:") ? `/api/items/${active.item.id}/subtitles/online/${encodeURIComponent(index.slice(7))}` : `/api/items/${active.item.id}/subtitles/${index}?offset=${active.offset}`;
    track.default = true;
    active.syncSubtitles = syncFor(owner, track, external);
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
  function loadStreamSubtitle(owner, state) {
    const stream = owner.stream;
    const current = () => active === owner && owner.stream === stream && stream.subtitle === state && $("#subtitles").value === String(state.index);
    const failed = () => {
      state.fetching = false;
      if (!current() || state.loaded) return;
      $("#subtitle-status").textContent = "These subtitles could not be loaded. Choose another track or open a subtitle file.";
      toast("These subtitles could not be loaded");
    };
    state.fetching = true;
    fetch(`/api/streams/${stream.id}/subtitles/embedded/${state.index}`).then(async (response) => {
      if (response.status === 409 && current() && ++state.attempts < 30) {
        state.fetching = false;
        state.retry = setTimeout(() => current() && loadStreamSubtitle(owner, state), 1500);
        return;
      }
      if (!response.ok) throw new Error("Subtitles unavailable");
      const text = await response.text();
      if (!current()) return;
      const url = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.label = state.label;
      if (state.srclang) track.srclang = state.srclang;
      track.dataset.blob = url;
      track.src = url;
      track.addEventListener(
        "load",
        () => {
          if (!current() || !track.isConnected) {
            URL.revokeObjectURL(url);
            return track.remove();
          }
          state.until = Number(response.headers.get("X-Subtitle-Until")) || 0;
          state.complete = response.headers.get("X-Subtitle-Complete") === "true";
          state.loadedAt = Date.now();
          state.loaded = true;
          state.fetching = false;
          subtitleRenderer.attach(track);
          active.syncSubtitles = syncFor(owner, track, false);
          active.syncSubtitles();
          video().querySelectorAll("track").forEach((old) => {
            if (old === track) return;
            if (old.dataset.blob) URL.revokeObjectURL(old.dataset.blob);
            old.remove();
          });
          $("#subtitle-status").textContent = "";
        },
        { once: true }
      );
      track.addEventListener("error", () => {
        URL.revokeObjectURL(url);
        track.remove();
        failed();
      });
      video().appendChild(track);
      track.track.mode = "hidden";
    }).catch(failed);
  }
  function refreshStreamSubtitle(owner, state) {
    state.loadedAt = Date.now();
    loadStreamSubtitle(owner, state);
  }
  function addOnlineSubtitles(tracks) {
    var _a;
    (_a = $("#subtitles-online")) == null ? void 0 : _a.remove();
    if (!tracks.length) return;
    const group = document.createElement("optgroup");
    group.id = "subtitles-online";
    group.label = "Online \xB7 OpenSubtitles";
    group.innerHTML = tracks.map((t) => `<option value="online:${esc(t.id)}">${esc(t.label)}</option>`).join("");
    $("#subtitles").appendChild(group);
  }
  function addFileOption(name) {
    var _a;
    (_a = $("#subtitle-file-option")) == null ? void 0 : _a.remove();
    const option3 = document.createElement("option");
    option3.id = "subtitle-file-option";
    option3.value = "file";
    option3.textContent = name;
    $("#subtitles").appendChild(option3);
  }
  async function findSubtitles(selectPreferred = false) {
    if (!active || $("#subtitle-find").disabled) return;
    const owner = active;
    $("#subtitle-find").disabled = true;
    $("#subtitle-status").textContent = "Finding subtitles\u2026";
    try {
      const tracks = await api(`/api/items/${owner.item.id}/subtitles`);
      if (active !== owner) return;
      const selection = $("#subtitles").value;
      active.onlineSubtitles = tracks;
      addOnlineSubtitles(tracks);
      if (tracks.length) {
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
    var _a, _b;
    if (!queue || loading) return;
    cancelNext();
    const stopped = report("stop");
    const wasPlaying = !video().paused;
    loading = true;
    video().pause();
    updateTransport();
    await stopped;
    try {
      queue = await api(
        `/api/queues/${queue.id}`,
        { revision: queue.revision, index: queue.index + delta },
        "PATCH"
      );
      const next = await api(`/api/queues/${queue.id}`);
      const item = next.entries[next.index];
      if (!item.available && !canStream())
        throw new Error("This queued episode is unavailable. Download it, or use Queue to skip it.");
      await play(item.id, item.title_id, {
        queueId: queue.id,
        replay: item.available && queue.mode === "shuffle",
        stream: item.available ? null : { resolution: ((_a = active == null ? void 0 : active.stream) == null ? void 0 : _a.resolution) || lastResolution(), hint: { item } }
      });
    } catch (error) {
      if (loading && active && !((_b = active.stream) == null ? void 0 : _b.failed)) {
        loading = false;
        updateTransport();
        if (wasPlaying)
          video().play().catch(() => {
          });
      }
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
      `<h2>${esc(data.name)} \xB7 ${data.mode === "shuffle" ? "Shuffle" : "Queue"}</h2><div class="actions"><button data-queue-clear>Clear queue</button></div>${data.entries.map((item, index) => `<div class="row ${index === data.index ? "queue-current" : ""}"><div class="row-main"><strong>${index + 1}. ${esc(item.name)}</strong><p class="meta">${esc(episodeLabel(item))} \xB7 ${item.available ? "Downloaded" : canStream() ? "Not downloaded" : "Unavailable"}</p></div><button data-queue-play="${index}" ${item.available || canStream() ? "" : "disabled"}>${item.available || !canStream() ? "Play" : "Stream"}</button><button data-queue-up="${index}" ${index === 0 ? "disabled" : ""} aria-label="Move ${esc(item.name)} up">\u2191</button><button data-queue-remove="${index}" aria-label="Remove ${esc(item.name)}">Remove</button></div>`).join("") || "<p>Queue is empty.</p>"}`
    );
    $("#dialog-content").onclick = async (event) => {
      var _a;
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
            replay: item.available && data.mode === "shuffle" && index !== data.index,
            stream: item.available ? null : { resolution: ((_a = active == null ? void 0 : active.stream) == null ? void 0 : _a.resolution) || lastResolution(), hint: { item } }
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
    $("#player-time").textContent = duration ? `${clockTime(shown)} / ${clockTime(duration)}` : clockTime(shown);
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
    const stream = active.stream;
    const waiting = loading || !video().paused && video().readyState < 3;
    $("#player-buffering").textContent = loading ? (stream == null ? void 0 : stream.sourced) ? `Buffering at ${clockTime(position)}` : "Preparing\u2026" : waiting ? "Buffering\u2026" : "";
    const live = (stream == null ? void 0 : stream.sourced) && waiting && stream.status ? startupView(stream.status) : null;
    $("#player-buffer-detail").textContent = (live == null ? void 0 : live.detail) || "";
    $("#player-buffer-meter").hidden = !(live && live.progress != null && (stream.status.state === "buffering" || stream.status.state === "probing"));
    if ((live == null ? void 0 : live.progress) != null)
      $("#player-buffer-bar").style.width = `${Math.round(live.progress * 100)}%`;
    $("#player-loading").hidden = !$("#player-buffering").textContent || !$("#stream-start").hidden;
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
        addFileOption(file.name);
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
      var _a;
      if (video().paused && ((_a = active == null ? void 0 : active.stream) == null ? void 0 : _a.stale) && !loading)
        return void convert(absolutePosition(), true).catch((e) => toast(e.message));
      if (video().paused)
        video().play().catch((e) => toast(e.message));
      else video().pause();
    };
    $("#stream-start-actions").onclick = (event) => {
      const button2 = event.target.closest("[data-stream-action]");
      const owner = active;
      if (!button2 || !(owner == null ? void 0 : owner.stream)) return;
      const action2 = button2.dataset.streamAction;
      if (action2 === "close") return void closePlayer();
      if (action2 === "download") {
        const itemId = owner.item.id;
        return void closePlayer().then(() => releases(itemId));
      }
      button2.disabled = true;
      if (action2 === "stop-others")
        return void stopOtherStreams(owner).then(() => active === owner && restartStream(owner)).catch((e) => {
          button2.disabled = false;
          toast(e.message);
        });
      const resolution = action2 === "other-resolution" ? Number(button2.dataset.resolution) : owner.stream.resolution;
      if (action2 === "other-resolution") saveResolution(resolution);
      void restartStream(owner, {
        resolution,
        forceTranscode: owner.stream.forceTranscode || action2 === "compatibility"
      });
    };
    $("#stream-quality-options").onclick = (event) => {
      const card2 = event.target.closest("[data-stream-resolution]");
      if (card2 && !card2.disabled) void changeResolution(Number(card2.dataset.streamResolution));
    };
    video().addEventListener("timeupdate", () => {
      const stream = active == null ? void 0 : active.stream;
      const duration = active == null ? void 0 : active.info.duration;
      if (!(stream == null ? void 0 : stream.id) || stream.nextPrepared || loading || !duration) return;
      if (!queue || queue.index >= queue.items.length - 1) return;
      if (absolutePosition() < duration * 0.8) return;
      stream.nextPrepared = true;
      api(`/api/streams/${stream.id}/prepare-next`, {}).catch(() => {
      });
    });
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
    const restartConversion = () => convert((video().currentTime || 0) + ((active == null ? void 0 : active.offset) || 0), !video().paused).catch(
      (e) => toast(e.message)
    );
    $("#convert").onclick = () => {
      if (active == null ? void 0 : active.stream) active.stream.forceTranscode = true;
      return restartConversion();
    };
    $("#audio").onchange = restartConversion;
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
      var _a;
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
      const following = (_a = active.title.items) == null ? void 0 : _a.find((i) => i.id === queue.items[queue.index + 1]);
      const offerStream = !active.stream && following && !following.available && canStream();
      $("#up-next").hidden = false;
      let seconds = 10;
      $("#up-next-label").textContent = offerStream ? "The next episode is not downloaded" : "Next episode is ready";
      $("#up-next-play").textContent = offerStream ? "Stream it" : "Play now";
      if (active.preferences.autoplay && !offerStream)
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
    window.addEventListener("pagehide", () => {
      var _a, _b, _c;
      void report("stop", true);
      const ids = [(_a = active == null ? void 0 : active.stream) == null ? void 0 : _a.id, (_c = (_b = active == null ? void 0 : active.stream) == null ? void 0 : _b.switching) == null ? void 0 : _c.id].filter(Boolean);
      for (const id of ids)
        fetch(`/api/streams/${id}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          keepalive: true
        }).catch(() => {
        });
    });
  }

  // public/app.js
  var user2 = null;
  var generation = 0;
  var poll = null;
  var currentTitle = null;
  var discoverResults = [];
  var locationKey = "";
  var returnPositions = {};
  var featuredTitles = [];
  var featuredIndex = 0;
  var homeTitles = /* @__PURE__ */ new Map();
  var main = () => $("#main");
  var button = (label, action2, attrs = "", style = "") => `<button class="${style}" data-action="${action2}" ${attrs}>${esc(label)}</button>`;
  var option2 = (value, label, current) => `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(label)}</option>`;
  var grid = (items) => `<div class="grid">${items.map((t) => card(t)).join("")}</div>`;
  function shelf(label, items, mode = "landscape") {
    return items.length ? `<section class="section media-shelf"><div class="section-heading"><h2>${esc(label)}</h2><div class="rail-controls"><button data-action="rail-back" aria-label="Scroll ${esc(label)} left">${icon("left")}</button><button data-action="rail-next" aria-label="Scroll ${esc(label)} right">${icon("right")}</button></div></div><div class="rail ${mode === "resume" || mode === "next" ? "resume-rail" : ""}" aria-label="${esc(label)}">${items.map((t) => card(t, mode, { canStream: canStream() })).join("")}</div></section>` : "";
  }
  function featureHtml() {
    const title = featuredTitles[featuredIndex];
    if (!title) return "";
    const artwork2 = [title.background, title.poster].find((url) => /^https?:\/\//.test(url || ""));
    const item = title.primary;
    const saved = title.tags.includes("watchlist");
    return `<div class="hero-art ${title.background ? "" : "hero-poster"}" aria-hidden="true">${artwork2 ? `<img src="${esc(artwork2)}" alt="" fetchpriority="high">` : '<span class="hero-monogram">m.</span>'}</div><div class="hero-shade"></div><div class="hero-copy"><p class="hero-label">Featured in your library</p><h2>${esc(title.name)}</h2><p class="hero-facts">${esc([title.year, title.kind === "movie" ? "Movie" : title.kind === "anime" ? "Anime" : "Series", ...(title.genres || []).slice(0, 2)].filter(Boolean).join(" \xB7 "))}</p>${title.description ? `<p class="hero-description">${esc(title.description)}</p>` : ""}<div class="hero-actions">${(item == null ? void 0 : item.available) ? `<button class="hero-play" data-action="play" data-item="${esc(item.id)}" data-title="${esc(title.id)}">${icon("play")}${title.resumable ? "Resume watching" : "Watch now"}</button>` : `<a class="hero-play" href="#/title/${esc(title.id)}">View title</a>`}<a class="hero-round" href="#/title/${esc(title.id)}" aria-label="Details for ${esc(title.name)}" title="Title details">${icon("info")}</a><button class="hero-round" data-action="feature-save" data-title="${esc(title.id)}" aria-label="${saved ? "Remove from" : "Add to"} My List" aria-pressed="${saved}" title="${saved ? "Remove from" : "Add to"} My List">${icon(saved ? "check" : "plus")}</button></div>${title.readyCount ? `<p class="hero-availability">${icon("check")}Available in your library</p>` : ""}</div>${featuredTitles.length > 1 ? `<div class="feature-controls"><button class="feature-arrow" data-action="feature-prev" aria-label="Previous featured title">${icon("left")}</button><div class="feature-dots" role="group" aria-label="Featured titles">${featuredTitles.map((t, i) => `<button class="feature-dot" data-action="feature-select" data-index="${i}" aria-label="Feature ${esc(t.name)}" aria-pressed="${i === featuredIndex}"></button>`).join("")}</div><button class="feature-arrow" data-action="feature-next" aria-label="Next featured title">${icon("right")}</button></div>` : ""}`;
  }
  async function route({ quiet = false } = {}) {
    var _a;
    if (!user2) return;
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
        const html = await sportsPage(url, user2);
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
        homeTitles = /* @__PURE__ */ new Map();
        for (const items of Object.values(data)) for (const t of items) homeTitles.set(t.id, t);
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
            canStream() ? "Find a title in Discover, then stream it right away or download it." : "Find a title in Discover to add it to your library.",
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
        if (title.primary && !title.primary.available && canStream()) bindStreamPanel(title.primary);
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
        const admin = user2.role === "admin" ? await api("/api/admin") : null;
        draw(
          heading("Settings") + torrentRulesForm(admin) + `<form id="preferences" class="form"><h2>Playback</h2><label class="check section"><input type="checkbox" name="autoplay" ${prefs.autoplay ? "checked" : ""}>Play the next episode automatically</label><label>Preferred audio language<input name="audioLanguage" placeholder="eng, dan, jpn\u2026" maxlength="20" value="${esc(prefs.audioLanguage)}"></label><label>Preferred subtitle language<input name="subtitleLanguage" maxlength="20" placeholder="eng, dan\u2026" value="${esc(prefs.subtitleLanguage)}"></label><label>Subtitles<select name="subtitleMode">${option2("off", "Off", prefs.subtitleMode)}${option2("preferred", "Use preferred language", prefs.subtitleMode)}</select></label><button class="primary">Save preferences</button></form>${admin ? `<section class="section"><h2>Server</h2><p class="meta">Real-Debrid: ${admin.debridConfigured ? "Configured" : "Not configured"}</p><p class="meta">Import folders: ${esc(admin.importRoots.join(", ") || "None configured")}</p></section><section class="section"><div class="section-heading"><h2>People</h2>${button("Add person", "add-user")}</div>${admin.users.map((u) => `<div class="row"><div class="row-main"><h3>${esc(u.name)}</h3><p class="meta">${esc(u.email)} \xB7 ${u.active ? "Active" : "Disabled"} \xB7 ${u.role === "admin" || u.can_download ? "Downloads allowed" : "Viewing only"}</p></div>${u.id !== user2.id ? button(u.can_download ? "Disable downloads" : "Allow downloads", "user-permission", `data-id="${u.id}" data-active="${!!u.active}" data-allowed="${!u.can_download}"`) : ""}</div>`).join("")}</section>` : ""}<section class="section">${button("Sign out", "logout")}</section>`
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
  var partlyWatched = (item) => item.state.position >= 10 && !item.state.completed;
  function primaryActions(title, primary) {
    if (!primary) return "";
    const attrs = `data-item="${primary.id}" data-title="${title.id}"`;
    if (primary.available)
      return button(
        title.resumable ? "Resume " + episodeLabel(primary) : primary.state.completed ? "Replay" : "Play " + episodeLabel(primary),
        "play",
        attrs,
        "primary"
      );
    if (!canStream()) return button("Find a release", "release", attrs, "primary");
    const what = title.kind === "movie" ? "" : " " + episodeLabel(primary);
    return button(
      partlyWatched(primary) ? `Resume${what}` : what ? `Stream${what}` : "Stream now",
      "stream-play",
      `${attrs} data-warm="${primary.id}"`,
      "primary"
    ) + button("Download", "release", attrs, "quiet");
  }
  function episodeActions(title, item) {
    const attrs = `data-item="${item.id}" data-title="${title.id}"`;
    const label = partlyWatched(item) ? "Resume" : null;
    if (item.available) return button(label || "Play", "play", attrs);
    if (!canStream()) return button("Download", "release", attrs, "quiet");
    return button(label || "Stream", "stream", `${attrs} data-warm="${item.id}"`) + button("Download", "release", attrs, "quiet");
  }
  function detailHtml(title) {
    var _a;
    const primary = title.primary;
    let html = `<div class="detail">${/^https?:\/\//.test(title.background || "") ? `<div class="detail-backdrop" aria-hidden="true"><img src="${esc(title.background)}" alt=""></div>` : ""}<div class="detail-art poster">${poster(title)}</div><div class="detail-copy"><p class="eyebrow">${esc(title.kind === "movie" ? "Movie" : title.kind === "anime" ? "Anime" : "Series")} ${esc(title.year)}</p><h1>${esc(title.name)}</h1>${metadataHtml(title)}<p class="muted">${esc(title.description)}</p><div class="actions">${primaryActions(title, primary)}${title.kind !== "movie" && title.readyCount ? button("Shuffle episodes", "shuffle", `data-title="${title.id}"`) : ""}${button(title.tags.includes("watchlist") ? "In My List" : "Add to My List", "tag", `data-tag="watchlist" data-active="${!title.tags.includes("watchlist")}"`)}${button(title.tags.includes("favorite") ? "Favorited" : "Favorite", "tag", `data-tag="favorite" data-active="${!title.tags.includes("favorite")}"`)}${button("Collections", "add-collection")}</div>${primary && !primary.available && canStream() ? streamPanelHtml(primary) : ""}<p class="meta">${title.readyCount} downloaded${((_a = title.genres) == null ? void 0 : _a.length) ? " \xB7 " + esc(title.genres.join(" / ")) : ""}</p></div></div>`;
    const seasons = [...new Set(title.items.map((i) => i.season))];
    for (const season of seasons) {
      const items = title.items.filter((i) => i.season === season);
      html += `<section><div class="season-header"><h2>${title.kind === "movie" ? "Your copy" : season ? `Season ${season}` : title.kind === "anime" ? "Episodes" : "Specials"}</h2><div class="actions">${title.kind !== "movie" && user2.canDownload && items.some((i) => !i.available) ? button(title.kind === "anime" && !season ? "Download all episodes" : "Download season", "download-season", `data-season="${season}"`) : ""}${title.kind !== "movie" && items.some((i) => i.available) ? button("Shuffle season", "shuffle", `data-title="${title.id}" data-season="${season}"`) : ""}${button(items.every((i) => i.state.completed) ? "Mark unwatched" : "Mark watched", "bulk-watched", `data-season="${season}" data-watched="${!items.every((i) => i.state.completed)}"`)}</div></div>${items.map((i) => `<div class="episode"><span class="episode-number">${i.episode || "\u2014"}</span><div class="episode-body">${i.thumbnail ? `<img class="episode-thumbnail" src="${esc(i.thumbnail)}" alt="" loading="lazy">` : ""}<h3>${esc(i.name || episodeLabel(i))}</h3><p class="meta">${i.available ? "Downloaded" : "Not downloaded"} \xB7 ${i.state.completed ? "Watched" : i.state.position >= 10 ? "In progress" : "Unwatched"}${i.released ? " \xB7 " + esc(String(i.released).slice(0, 10)) : ""}</p>${episodeMetadata(i)}${progress(i.state)}</div><div class="actions">${episodeActions(title, i)}${button("More", "item-menu", `data-item="${i.id}"`)}</div></div>`).join("")}</section>`;
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
    var _a, _b, _c;
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
      } else if (actionName === "stream") {
        const title = currentTitle, item = title.items.find((i) => i.id === b.dataset.item);
        openStreamSheet({
          item,
          title,
          onPlay: ({ resolution, replay }) => {
            closeModal();
            void play(item.id, title.id, { replay, stream: { resolution, hint: { title, item } } });
          },
          onDownload: () => void releases(item.id)
        });
      } else if (actionName === "stream-play") {
        closeModal();
        const title = (currentTitle == null ? void 0 : currentTitle.id) === b.dataset.title ? currentTitle : homeTitles.get(b.dataset.title);
        const item = ((_c = title == null ? void 0 : title.items) == null ? void 0 : _c.find((i) => i.id === b.dataset.item)) || [title == null ? void 0 : title.resumable, title == null ? void 0 : title.next, title == null ? void 0 : title.primary].find((i) => (i == null ? void 0 : i.id) === b.dataset.item);
        const resolution = Number(b.dataset.resolution) || null;
        if (resolution && b.dataset.picked === "true") saveResolution(resolution);
        void play(b.dataset.item, b.dataset.title, {
          replay: b.dataset.replay === "true",
          stream: { resolution, hint: title && { title, item } }
        });
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
          `<h2>${esc(item.name || episodeLabel(item))}</h2><div class="actions">${button(item.state.completed ? "Mark unwatched" : "Mark watched", "watched", `${attrs} data-watched="${!item.state.completed}"`)}${item.available ? button("Play from beginning", "play", `${attrs} data-title="${currentTitle.id}" data-replay="true"`) + button("Add to queue", "enqueue", attrs) + button("Play next", "enqueue", `${attrs} data-next="true"`) : canStream() && partlyWatched(item) ? button("Stream from the beginning", "stream-play", `${attrs} data-title="${currentTitle.id}" data-replay="true"`) : ""}${user2.role === "admin" ? button("Import local file", "import", attrs) : ""}</div>`
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
    user2 = auth.user;
    if (!user2) {
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
    $("#account").textContent = user2.name;
    $("#avatar").textContent = user2.name.slice(0, 1).toUpperCase();
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".account-menu"))
        document.querySelector(".account-menu").removeAttribute("open");
    });
    $("#signout").onclick = logout;
    $("#dialog-close").onclick = closeModal;
    main().onclick = action;
    configureStreaming(user2);
    bindWarmUp(main());
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
