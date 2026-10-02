window.WatchTogether = /* @__PURE__ */ (() => {
  const find = (id) => document.getElementById(id);
  const STORAGE = "mw.watchTogether";
  let room = null, memberId = null, memberToken = null;
  let initialized = false, poll = null, timer = null, urgent = false;
  let loading = false, applying = false, buffering = false, disconnected = false;
  let requestedMedia = null, receivedAt = 0, playBlocked = false, joining = false;
  let epoch = 0, returnFocus = null, transitioning = false;
  let syncingHost = null, pendingSeek = null, loadedMedia = null, loadPosition = 0;
  const resolving = /* @__PURE__ */ new Set();
  const player = () => window.Player;
  const guest = () => !!room && room.hostId !== memberId;
  const key = (m) => m ? [m.kind, m.id, m.season || "", m.episode || "", m.mode || ""].join(":") : "";
  const sameTitle = (a, b) => {
    var _a, _b, _c, _d;
    return !!a && !!b && a.kind === b.kind && String(a.id) === String(b.id) && String((_a = a.season) != null ? _a : "") === String((_b = b.season) != null ? _b : "") && String((_c = a.episode) != null ? _c : "") === String((_d = b.episode) != null ? _d : "");
  };
  const sharedPlayback = () => guest() || !!syncingHost;
  function catalogMedia(track, title) {
    if (!track) return null;
    const media = { kind: track.kind, id: String(track.id), title: title || track.title || "Video" };
    if (track.episode != null) media.episode = String(track.episode);
    if (track.season != null) media.season = Number(track.season);
    if (track.mode) media.mode = track.mode;
    return media;
  }
  const currentMedia = () => {
    const p = player();
    if (!p || !p.el.classList.contains("show") || !p.meta) return null;
    if (p.movieMode && p._track) return catalogMedia(p._track, p.meta.title);
    if (!p.meta.anilistId || !p.ep) return null;
    return { kind: "anime", id: String(p.meta.anilistId), episode: String(p.ep), mode: p.mode, title: p.meta.title };
  };
  const targetPosition = () => {
    if (!room) return 0;
    const s = room.state;
    const elapsed = Math.max(0, room.serverTime - s.updatedAt + Date.now() - receivedAt) / 1e3;
    return s.position + (s.paused ? 0 : elapsed * s.rate);
  };
  function feedback(message) {
    find("watchFeedback").textContent = message;
    find("watchLobbyFeedback").textContent = message;
  }
  function save() {
    try {
      if (room) sessionStorage.setItem(STORAGE, JSON.stringify({ code: room.code, memberId, memberToken }));
      else sessionStorage.removeItem(STORAGE);
    } catch (_) {
    }
  }
  async function request(path, body, token = memberToken, keepalive = false) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8e3);
    try {
      const response = await fetch("/api/watch-together" + path, {
        method: body === void 0 ? "GET" : "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", ...token ? { "X-Watch-Member": token } : {} },
        body: body === void 0 ? void 0 : JSON.stringify(body),
        signal: controller.signal,
        keepalive
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.error || "Room request failed. Try again.");
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }
  function render() {
    const p = player();
    find("watchSetup").hidden = !!room;
    find("watchRoom").hidden = !room;
    find("pTogether").classList.toggle("in-room", !!room);
    find("pTogether").textContent = room ? `Room \xB7 ${room.members.length}` : "Watch together";
    p.el.classList.toggle("watch-guest", guest());
    ["pPlay", "pBack10", "pFwd10", "pPrev", "pNext", "pSkip", "pEps"].forEach((id) => {
      find(id).disabled = sharedPlayback();
    });
    document.querySelectorAll("#speedList button").forEach((button) => {
      button.disabled = sharedPlayback();
    });
    document.querySelectorAll("#epsDrawerList .p-drawer-ep").forEach((episode) => {
      episode.setAttribute("aria-disabled", String(sharedPlayback()));
      episode.tabIndex = sharedPlayback() ? -1 : 0;
    });
    if (!room) {
      find("watchStart").hidden = true;
      return;
    }
    find("watchRoomCode").textContent = room.code;
    const origin = window.API_BASE || location.origin;
    find("watchLink").value = origin.replace(/\/$/, "") + "/?room=" + room.code;
    const host = room.members.find((m) => m.id === room.hostId);
    find("watchRole").textContent = guest() ? `${host ? host.name : "The host"} controls playback.` : "You control playback for everyone.";
    const list = find("watchMembers");
    const signature = JSON.stringify([room.hostId, room.members]);
    if (list.dataset.members !== signature) {
      list.dataset.members = signature;
      list.textContent = "";
      room.members.forEach((m) => {
        const row = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = m.name + (m.id === memberId ? " (you)" : "");
        const role = document.createElement("span");
        role.className = "watch-member-role";
        role.textContent = m.id === room.hostId ? "Host" : "Viewer";
        row.appendChild(name);
        row.appendChild(role);
        list.appendChild(row);
      });
    }
    find("watchStart").hidden = !guest() || !playBlocked || room.state.paused;
    const status = find("watchFeedback").textContent;
    if (status === "Press Start playback to join the host." && (!playBlocked || room.state.paused)) {
      feedback(playBlocked && room.state.paused ? "Waiting for the host to play." : "");
    } else if (status === "Waiting for the host to play." && playBlocked && !room.state.paused) {
      feedback("Press Start playback to join the host.");
    }
  }
  function open() {
    var _a;
    returnFocus = document.activeElement;
    feedback("");
    if (player().el.classList.contains("show")) {
      player().toggleMenu("#watchMenu", "#pTogether");
      find("pTogether").setAttribute("aria-expanded", String(!find("watchMenu").hidden));
      if (!find("watchMenu").hidden) find("watchClose").focus();
    } else {
      find("watchLobby").classList.add("show");
      document.body.style.overflow = "hidden";
      if (document.documentElement.classList.contains("tv")) (_a = window.TVNav) == null ? void 0 : _a.setFocus(find("watchLobbyCode"));
      else find("watchLobbyCode").focus();
    }
  }
  function closeLobby() {
    find("watchLobby").classList.remove("show");
    if (!player().el.classList.contains("show")) document.body.style.overflow = "";
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  }
  function reset() {
    epoch++;
    clearTimeout(timer);
    timer = null;
    urgent = false;
    room = null;
    memberId = null;
    memberToken = null;
    requestedMedia = null;
    loading = false;
    disconnected = false;
    playBlocked = false;
    syncingHost = null;
    pendingSeek = null;
    loadedMedia = null;
    buffering = false;
    joining = false;
    transitioning = false;
    setBusy(false);
    save();
    render();
  }
  function leave(message = "") {
    if (room) request("/" + room.code + "/leave", {}, memberToken, true).catch(() => {
    });
    reset();
    feedback(message);
  }
  function schedule(delay = 1e3) {
    clearTimeout(timer);
    if (!room || joining) return;
    timer = setTimeout(tick, delay);
  }
  function publishSoon() {
    if (!room) return;
    if (poll && poll.generation === epoch) {
      urgent = true;
      return;
    }
    schedule(80);
  }
  function localState() {
    const p = player();
    if (pendingSeek) return { ...pendingSeek, paused: pendingSeek.paused || buffering };
    return {
      position: loading ? loadPosition : Math.max(0, Number(p.curT()) || 0),
      paused: loading || buffering || p.video.paused || p.video.ended,
      rate: p.video.playbackRate || 1
    };
  }
  function followMedia() {
    if (!room || !sharedPlayback() || resolving.size) return;
    const desired = room.media;
    const current = currentMedia();
    if (requestedMedia === key(desired) || sameTitle(current, desired) && (key(current) === key(desired) || loadedMedia === key(desired))) return;
    requestedMedia = key(desired);
    loading = true;
    playBlocked = false;
    transitioning = true;
    const id = encodeURIComponent(desired.id);
    let path;
    if (desired.kind === "anime") path = `/watch/${id}/${encodeURIComponent(desired.episode)}?mode=${desired.mode || "sub"}`;
    else if (desired.kind === "movie") path = `/moviewatch/${id}`;
    else path = `/tvwatch/${id}/${desired.season}/${encodeURIComponent(desired.episode)}`;
    try {
      window.nav(path, true);
    } finally {
      transitioning = false;
    }
  }
  function apply(force = false) {
    const p = player();
    if (!room || !sharedPlayback() || loading || p._jumping || p.video.readyState < 1 || !p.quality || !p.el.classList.contains("show")) return;
    if (!sameTitle(currentMedia(), room.media)) return;
    const s = syncingHost ? { position: syncingHost.position, paused: true, rate: syncingHost.rate } : room.state;
    const duration = p.durT();
    const target = syncingHost ? syncingHost.position : targetPosition();
    const at = Math.max(0, Number.isFinite(duration) && duration > 0 ? Math.min(duration - 0.1, target) : target);
    const drift = Math.abs(p.curT() - at);
    applying = true;
    try {
      if (force || drift > (s.paused ? 0.3 : 1.5)) {
        p.video.pause();
        p.seekTo(at);
      }
      if (p.video.playbackRate !== s.rate) p.video.playbackRate = s.rate;
      find("valSpeed").textContent = s.rate === 1 ? "Normal" : s.rate + "\xD7";
      if (disconnected || s.paused) p.video.pause();
      else if (!p._jumping && p.video.paused && !playBlocked) {
        const generation = epoch;
        const play = p.video.play();
        if (play && play.catch) play.catch(() => {
          if (generation !== epoch || !guest()) return;
          playBlocked = true;
          render();
          feedback("Press Start playback to join the host.");
          find("watchMenu").hidden = false;
          find("pTogether").setAttribute("aria-expanded", "true");
          p.poke();
        });
      }
      p.syncPlayIcon();
      if (syncingHost && !p._jumping) {
        syncingHost = null;
        pendingSeek = null;
        loadedMedia = key(room.media);
        publishSoon();
      }
    } finally {
      applying = false;
    }
    render();
  }
  function accept(snapshot, inheritHost = false) {
    const previousHost = room && room.hostId;
    room = snapshot;
    receivedAt = Date.now();
    disconnected = false;
    if (room.hostId === memberId && (inheritHost || previousHost && previousHost !== room.hostId)) {
      syncingHost = { position: targetPosition(), rate: room.state.rate };
    }
    if (previousHost && previousHost !== room.hostId) {
      applying = true;
      player().video.pause();
      applying = false;
      feedback(room.hostId === memberId ? "You are now the host. Press play when ready." : "The host changed. Playback is paused.");
    }
    if (syncingHost) {
      applying = true;
      player().video.pause();
      applying = false;
    }
    save();
    render();
    followMedia();
    apply();
  }
  async function tick() {
    if (!room || joining || poll && poll.generation === epoch) return;
    const generation = epoch;
    const operation = { generation };
    poll = operation;
    urgent = false;
    try {
      const p = player();
      const media = currentMedia();
      const data = !guest() && !syncingHost && !disconnected && media && p.el.classList.contains("show") ? await request("/" + room.code + "/state", { media, state: localState() }) : await request("/" + room.code);
      if (generation !== epoch) return;
      const wasDisconnected = disconnected;
      accept(data.room, wasDisconnected && data.room.hostId === memberId);
      if (wasDisconnected) feedback("Reconnected.");
    } catch (error) {
      if (generation !== epoch) return;
      if ([401, 404].includes(error.status)) {
        leave(error.status === 401 ? "Sign in again to join a room." : "This room has ended. Create or join another room.");
        return;
      }
      if (error.status === 403) {
        try {
          const data = await request("/" + room.code);
          if (generation === epoch) accept(data.room);
        } catch (_) {
          if (generation === epoch) leave("Your room session ended. Join again.");
        }
      } else {
        disconnected = true;
        feedback("Reconnecting to the room\u2026");
        if (guest()) player().video.pause();
      }
    } finally {
      if (poll === operation) poll = null;
      if (generation === epoch && room) schedule(urgent ? 80 : 1e3);
    }
  }
  async function enter(code) {
    if (joining) return;
    const normalized = String(code || "").toUpperCase().replace(/[\s-]/g, "");
    if (!/^[A-Z2-9]{8}$/.test(normalized)) {
      feedback("Enter the eight-character room code.");
      return;
    }
    if (room && room.code === normalized) {
      closeLobby();
      open();
      return;
    }
    if (player().casting) {
      feedback("Stop casting before joining a room.");
      return;
    }
    const generation = ++epoch;
    clearTimeout(timer);
    joining = true;
    setBusy(true);
    feedback("Joining room\u2026");
    try {
      const data = await request("/" + normalized + "/join", {}, null);
      if (generation !== epoch) {
        discardMembership(data);
        return;
      }
      adopt(data);
      closeLobby();
      feedback("");
      find("watchMenu").hidden = false;
      find("pTogether").setAttribute("aria-expanded", "true");
      player().poke();
    } catch (error) {
      if (generation === epoch) feedback(error.status === 404 ? "Room not found. Check the code or ask the host for a new room." : error.message);
    } finally {
      if (generation === epoch) {
        joining = false;
        setBusy(false);
        schedule();
      }
    }
  }
  function discardMembership(data) {
    request("/" + data.room.code + "/leave", {}, data.memberToken, true).catch(() => {
    });
  }
  function adopt(data, inheritHost = false) {
    if (room) discardMembership({ room, memberToken });
    room = null;
    requestedMedia = null;
    loadedMedia = null;
    pendingSeek = null;
    syncingHost = null;
    playBlocked = false;
    disconnected = false;
    memberId = data.memberId;
    memberToken = data.memberToken;
    accept(data.room, inheritHost);
  }
  function setBusy(value) {
    find("watchCreate").disabled = value;
    document.querySelectorAll("[data-watch-join] button").forEach((button) => {
      button.disabled = value;
    });
  }
  async function create() {
    if (joining) return;
    const p = player(), media = currentMedia();
    if (!media || !p.quality || p.video.readyState < 1 || p._jumping) {
      feedback("Wait for the title to be ready, then create a room.");
      return;
    }
    if (p.casting) {
      feedback("Stop casting before creating a room.");
      return;
    }
    const generation = ++epoch;
    clearTimeout(timer);
    joining = true;
    setBusy(true);
    feedback("Creating room\u2026");
    try {
      const data = await request("", { media, state: localState() }, null);
      if (generation !== epoch) {
        discardMembership(data);
        return;
      }
      adopt(data);
      feedback("Room created. Share the link or code.");
    } catch (error) {
      if (generation === epoch) feedback(error.message);
    } finally {
      if (generation === epoch) {
        joining = false;
        setBusy(false);
        schedule();
      }
    }
  }
  function controlAllowed() {
    if (!sharedPlayback() || applying) return true;
    feedback(guest() ? "The host controls playback." : "Rejoining the room. Playback will be ready shortly.");
    player().poke();
    return false;
  }
  function installPlayerHooks() {
    const p = player();
    const wrap = (method, handler) => {
      const original = p[method];
      p[method] = function(...args) {
        return handler.call(this, original.bind(this), ...args);
      };
    };
    ["togglePlay", "nudge", "next", "prev", "switchMode", "playNextSeason", "showUpNext"].forEach((method) => wrap(method, (original, ...args) => controlAllowed() ? original(...args) : void 0));
    wrap("seekTo", (original, time) => {
      if (!controlAllowed()) return;
      if (room && !applying && !guest()) pendingSeek = {
        position: Math.max(0, Number(time) || 0),
        paused: p.video.paused,
        rate: p.video.playbackRate || 1
      };
      const result = original(time);
      if (!applying) publishSoon();
      return result;
    });
    wrap("toggleCast", (original) => {
      if (room) {
        feedback("Leave the room before casting.");
        return;
      }
      return original();
    });
    const resumePosition = () => syncingHost ? syncingHost.position : targetPosition();
    wrap("_resumeFor", (original, ep) => sharedPlayback() ? resumePosition() : original(ep));
    wrap("_trackResume", (original) => sharedPlayback() ? Promise.resolve(resumePosition()) : original());
    function begin(media, resume) {
      if (sharedPlayback() && !sameTitle(media, room.media)) return false;
      loading = true;
      buffering = false;
      loadPosition = sharedPlayback() ? resumePosition() : Math.max(0, Number(resume) || 0);
      p.resumeAt = loadPosition;
      pendingSeek = null;
      requestedMedia = key(sharedPlayback() ? room.media : media);
      return true;
    }
    function resolveCall(original, ...args) {
      const operation = {};
      resolving.add(operation);
      const settled = () => {
        resolving.delete(operation);
        followMedia();
      };
      let result;
      try {
        result = original(...args);
      } catch (error) {
        settled();
        throw error;
      }
      if (result && result.then) result.then(settled, settled);
      else settled();
      return result;
    }
    wrap("play", (original, ep, resume = 0) => {
      const media = { kind: "anime", id: String(p.meta.anilistId), episode: String(ep), mode: p.mode, title: p.meta.title };
      if (!begin(media, resume)) return;
      const result = resolveCall(original, ep, sharedPlayback() ? resumePosition() : resume);
      publishSoon();
      return result;
    });
    wrap("launchStream", (original, options) => {
      if (!begin(catalogMedia(options.track, options.title), 0)) return;
      const result = resolveCall(original, options);
      publishSoon();
      return result;
    });
    wrap("playStream", (original, options = {}) => {
      if (!begin(currentMedia(), options.seek || 0)) return;
      const delivery = sharedPlayback() ? { ...options, seek: resumePosition() } : options;
      const result = resolveCall(original, delivery);
      publishSoon();
      return result;
    });
    wrap("_onStreamReady", (original, at, wasPlaying) => {
      original(at, sharedPlayback() ? false : wasPlaying);
      loading = false;
      buffering = false;
      pendingSeek = null;
      if (room && sameTitle(currentMedia(), room.media)) loadedMedia = requestedMedia || loadedMedia || key(currentMedia());
      requestedMedia = null;
      followMedia();
      apply(true);
      publishSoon();
      render();
    });
    wrap("_attemptPlay", (original) => {
      if (syncingHost || guest() && (disconnected || room.state.paused)) return;
      return original();
    });
    wrap("buildSpeedMenu", (original) => {
      const result = original();
      render();
      return result;
    });
    wrap("hide", (original) => {
      if (room && !transitioning) leave();
      return original();
    });
    wrap("_menuOpen", (original) => original() || !find("watchMenu").hidden);
    wrap("hideMenus", (original) => {
      original();
      find("watchMenu").hidden = true;
      find("pTogether").classList.remove("on");
      find("pTogether").setAttribute("aria-expanded", "false");
    });
    ["play", "pause", "seeked", "ratechange", "playing", "waiting"].forEach((event) => p.video.addEventListener(event, () => {
      if (event === "waiting") buffering = true;
      if (event === "playing") buffering = false;
      if (!room || applying || p._closing) return;
      if (guest()) {
        if (["ratechange", "play", "pause", "seeked"].includes(event)) apply();
      } else if (!loading && !syncingHost) {
        if (event === "seeked" && !p._jumping) pendingSeek = null;
        if (pendingSeek && (event === "play" || event === "pause")) pendingSeek.paused = p.video.paused;
        if (pendingSeek && event === "ratechange") pendingSeek.rate = p.video.playbackRate || 1;
        publishSoon();
      }
    }));
    find("scrub").addEventListener("pointerdown", (event) => {
      if (guest()) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    }, true);
  }
  async function init() {
    if (initialized) return;
    initialized = true;
    installPlayerHooks();
    find("pTogether").onclick = open;
    find("watchClose").onclick = () => {
      player().hideMenus();
      find("pTogether").focus();
    };
    find("watchLobbyClose").onclick = closeLobby;
    find("watchCreate").onclick = create;
    find("watchLeave").onclick = () => leave("You left the room.");
    find("watchStart").onclick = () => {
      playBlocked = false;
      apply(true);
    };
    find("watchCopy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(find("watchLink").value);
        feedback("Invite link copied.");
      } catch (_) {
        find("watchLink").focus();
        find("watchLink").select();
        feedback("Copy the selected invite link.");
      }
    };
    document.querySelectorAll("[data-watch-join]").forEach((form) => form.addEventListener("submit", (event) => {
      event.preventDefault();
      enter(form.elements.code.value);
    }));
    find("watchLobby").addEventListener("click", (event) => {
      if (event.target === find("watchLobby")) closeLobby();
    });
    document.addEventListener("keydown", (event) => {
      if (!find("watchLobby").classList.contains("show")) return;
      if (document.documentElement.classList.contains("tv") && event.key === "Escape") return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeLobby();
      }
      if (event.key === "Tab") {
        const controls = [...find("watchLobby").querySelectorAll("button:not(:disabled), input")];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }, true);
    window.addEventListener("online", publishSoon);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) publishSoon();
    });
    const invite = new URLSearchParams(location.search).get("room");
    let saved;
    try {
      saved = JSON.parse(sessionStorage.getItem(STORAGE));
    } catch (_) {
    }
    const savedSession = saved && saved.code && saved.memberToken && saved.memberId;
    if (invite && (!savedSession || saved.code !== invite.toUpperCase().replace(/[\s-]/g, ""))) {
      open();
      find("watchLobbyCode").value = invite;
      return enter(invite);
    }
    if (savedSession) {
      const generation = ++epoch;
      joining = true;
      setBusy(true);
      try {
        const data = await request("/" + saved.code, void 0, saved.memberToken);
        if (generation !== epoch) return;
        adopt({ ...data, memberId: saved.memberId, memberToken: saved.memberToken }, true);
      } catch (_) {
        if (generation === epoch) {
          reset();
          if (invite) {
            open();
            find("watchLobbyCode").value = invite;
            return enter(invite);
          }
        }
      } finally {
        if (generation === epoch) {
          joining = false;
          setBusy(false);
          schedule();
        }
      }
    }
  }
  return { init, open, closeLobby, leave, guest, onRoute() {
    if (room && !transitioning && !/^\/(watch|moviewatch|tvwatch)\//.test(location.pathname)) leave();
  } };
})();
