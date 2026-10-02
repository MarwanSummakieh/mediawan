(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value != null ? value : "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const STATUS = { ready: ["Ready", ""], "action-needed": ["Needs attention", "warning"], disabled: ["Disabled", "neutral"] };
  const MODES = { qsv: "Intel Quick Sync", vaapi: "Intel GPU \xB7 VAAPI", software: "Software", unavailable: "Unavailable", disabled: "Disabled", copy: "Direct stream", remux: "Remux", transcode: "Encoding", none: "Software" };
  let pipelineTimer;
  let pipelineBusy = false;
  let pipelineActive = false;
  let firstPipelineResult = true;
  let membersBusy = false;
  let currentUserEmail;
  function feedback(id, message = "") {
    $(id).textContent = message;
    $(id).hidden = !message;
  }
  function confirmDeleteMember(name) {
    return new Promise((resolve) => {
      const previousFocus = document.activeElement;
      const overlay = document.createElement("div");
      overlay.className = "admin-confirm-overlay";
      overlay.innerHTML = `<section class="admin-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-confirm-title" aria-describedby="admin-confirm-detail"><h2 id="admin-confirm-title">Delete ${esc(name)}?</h2><p id="admin-confirm-detail">They will lose access immediately.</p><div class="admin-confirm-actions"><button class="button secondary" type="button" data-close-modal data-tv-key="admin-delete-cancel">Cancel</button><button class="button danger" type="button" data-confirm-delete data-tv-key="admin-delete-confirm">Delete member</button></div></section>`;
      function finish(confirmed) {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        if (previousFocus == null ? void 0 : previousFocus.isConnected) previousFocus.focus();
        resolve(confirmed);
      }
      function onKey(event) {
        if (!document.documentElement.classList.contains("tv") && (event.key === "Escape" || event.key === "Backspace" && !["INPUT", "TEXTAREA"].includes(event.target.tagName) || event.keyCode === 10009)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          finish(false);
        } else if (event.key === "Tab") {
          const buttons = [...overlay.querySelectorAll("button")];
          const first = buttons[0], last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }
      overlay.addEventListener("click", (event) => {
        if (event.target.closest("[data-close-modal]")) finish(false);
        else if (event.target.closest("[data-confirm-delete]")) finish(true);
      });
      document.body.appendChild(overlay);
      document.addEventListener("keydown", onKey, true);
      overlay.querySelector("[data-close-modal]").focus();
    });
  }
  async function request(url, options = {}) {
    var _a;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), (_a = options.timeout) != null ? _a : 3e4);
    const { timeout: _, ...fetchOptions } = options;
    try {
      const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
      let data;
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (response.status === 401) {
        location.href = "/login.html";
        throw new Error("Your session has expired. Sign in again.");
      }
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("The server took too long to respond. Try again.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  function bytes(value) {
    if (value == null || !Number.isFinite(Number(value))) return "Unknown";
    const size = Math.max(0, Number(value));
    if (size === 0) return "0 B";
    const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), 4);
    return `${(size / 1024 ** index).toLocaleString(void 0, { maximumFractionDigits: index ? 1 : 0 })} ${["B", "KiB", "MiB", "GiB", "TiB"][index]}`;
  }
  function duration(value) {
    if (value == null || !Number.isFinite(Number(value))) return "\u2014";
    const seconds = Math.max(0, Math.floor(Number(value)));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  }
  function setStatus(id, key, label) {
    const [defaultLabel, style] = STATUS[key] || ["Unknown", "neutral"];
    $(id).textContent = label || defaultLabel;
    $(id).className = `status ${style}`;
  }
  function renderPipeline(data) {
    var _a, _b, _c;
    if (!data.downloader || !data.encoder || !data.setup || !Array.isArray(data.setup.checks)) throw new Error("The server returned incomplete pipeline status.");
    const { downloader, encoder, setup } = data;
    const cache = downloader.cache || {};
    const downloads = downloader.active || [];
    const sessions = encoder.sessions || [];
    const runningSessions = sessions.filter((session) => !session.exited);
    const attention = setup.checks.filter((check) => check.status !== "ready");
    setStatus("pipeline-status", setup.ready ? "ready" : "action-needed", setup.ready && attention.length ? "Ready with notes" : void 0);
    setStatus("downloader-status", downloader.status);
    setStatus("encoder-status", encoder.status);
    const date = data.checkedAt ? new Date(data.checkedAt) : null;
    $("pipeline-updated").textContent = date && !Number.isNaN(date.valueOf()) ? `Checked ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Status received";
    const configuredBackends = (downloader.backends || []).filter((backend) => backend.configured);
    $("download-backends").textContent = configuredBackends.map((backend) => backend.label || backend.name).join(", ") || "No source configured";
    $("download-limit").textContent = downloader.maxDownloads != null ? `${downloads.length} / ${downloader.maxDownloads}` : String(downloads.length);
    $("cache-usage").textContent = `${bytes(cache.usedBytes)} / ${bytes(cache.budgetBytes)}`;
    const cachePercent = cache.budgetBytes > 0 && cache.usedBytes != null ? Math.min(100, Math.max(0, cache.usedBytes / cache.budgetBytes * 100)) : null;
    $("cache-meter").hidden = cachePercent == null;
    $("cache-meter").setAttribute("aria-valuenow", String(Math.round(cachePercent || 0)));
    $("cache-meter").setAttribute("aria-valuetext", `${bytes(cache.usedBytes)} used of ${bytes(cache.budgetBytes)}`);
    $("cache-meter").firstElementChild.style.width = `${cachePercent || 0}%`;
    $("cache-files").textContent = cache.complete != null ? `${cache.complete} complete \xB7 ${(_a = cache.partial) != null ? _a : 0} partial` : "File count unavailable";
    $("cache-free").textContent = cache.freeBytes != null ? `${bytes(cache.freeBytes)} free on disk` : "";
    $("cache-path").textContent = cache.dir || "";
    $("encoder-mode").textContent = MODES[encoder.mode] || encoder.mode || "Unknown";
    $("encoder-bitrate").textContent = encoder.remoteMbps != null ? `${encoder.remoteMbps} Mbps` : "\u2014";
    $("encoder-sessions").textContent = `${(_b = encoder.activeSessions) != null ? _b : runningSessions.length} / ${(_c = encoder.maxSessions) != null ? _c : "\u2014"}`;
    $("encoder-tools").textContent = `${encoder.ffmpeg ? "Available" : "Unavailable"} / ${encoder.ffprobe ? "Available" : "Unavailable"}`;
    $("encoder-note").textContent = encoder.error || encoder.ffprobeError || (encoder.requestedMode === "qsv" && !encoder.qsv && encoder.enabled !== false ? encoder.mode === "vaapi" ? "Quick Sync is unavailable. Encoding uses the Intel GPU through VAAPI." : encoder.mode === "software" ? "Quick Sync is unavailable. Software encoding uses the server\u2019s CPU." : "Quick Sync is unavailable. Review Server setup." : "");
    $("encoder-note").className = `service-note${encoder.mode === "vaapi" && !encoder.error && !encoder.ffprobeError ? " neutral" : ""}`;
    $("download-count").textContent = String(downloads.length);
    $("download-list").innerHTML = downloads.map((download) => {
      const percent = download.progress != null && Number.isFinite(Number(download.progress)) ? Math.min(100, Math.max(0, Number(download.progress))) : null;
      const total = download.total > 0 ? ` / ${bytes(download.total)}` : "";
      return `<article class="activity-item"><p class="activity-name">${esc(download.title || download.key || "Source file")}</p><div class="activity-meta"><span>${esc(bytes(download.bytes))}${esc(total)}</span><span>${percent == null ? "Downloading" : `${Math.round(percent)}%`}</span></div>${percent == null ? "" : `<div class="download-progress" role="progressbar" aria-label="Download progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}"><span style="width:${percent}%"></span></div>`}</article>`;
    }).join("") || `<p class="empty-state">${downloader.enabled === false ? "Downloads are disabled." : downloader.configured ? "No downloads in progress." : "Add a download source in Server setup."}</p>`;
    if (downloader.failed > 0) $("download-list").insertAdjacentHTML("beforeend", `<p class="service-note">${esc(downloader.failed)} failed cache ${downloader.failed === 1 ? "entry" : "entries"}. Check the server logs for the cause.</p>`);
    $("session-count").textContent = String(runningSessions.length);
    $("session-list").innerHTML = sessions.map((session) => `<article class="activity-item"><p class="activity-name">${esc(session.title || session.key || `Session ${session.id}`)}</p><div class="activity-meta"><span>${esc(MODES[session.mode] || session.mode || "Encoding")}${session.softwareFallback ? " \xB7 software fallback" : ""}</span><span>${session.exited ? "Finished" : `Running ${esc(duration(session.ageSec))}`}</span></div></article>`).join("") || `<p class="empty-state">${encoder.enabled === false ? "Encoding is disabled." : "No encoding sessions in progress."}</p>`;
    $("setup-summary").textContent = attention.length ? `${attention.length} ${attention.length === 1 ? "item" : "items"} to review` : "All checks passed";
    $("setup-checks").innerHTML = setup.checks.map((check) => {
      const kind = check.status === "ready" ? "" : check.status === "warning" ? "warning" : "error";
      const symbol = check.status === "ready" ? "\u2713" : "!";
      return `<li><span class="check-label"><span class="check-result ${kind}" aria-label="${esc(check.status)}">${symbol}</span>${esc(check.label)}</span><span class="check-detail">${esc(check.detail || "")}</span></li>`;
    }).join("") || `<li class="empty-state">No setup checks returned.</li>`;
    if (firstPipelineResult && !setup.ready) $("setup-details").open = true;
    firstPipelineResult = false;
    pipelineActive = downloads.length > 0 || runningSessions.length > 0;
  }
  function schedulePipeline() {
    clearTimeout(pipelineTimer);
    if (pipelineActive && !document.hidden) pipelineTimer = setTimeout(loadPipeline, 5e3);
  }
  async function loadPipeline() {
    if (pipelineBusy) return;
    clearTimeout(pipelineTimer);
    pipelineBusy = true;
    $("pipeline-refresh").disabled = true;
    $("pipeline-refresh").textContent = "Refreshing\u2026";
    $("pipeline-overview").setAttribute("aria-busy", "true");
    feedback("pipeline-error");
    try {
      renderPipeline(await request("/api/admin/pipeline"));
      $("pipeline-overview").hidden = false;
      $("pipeline-activity").hidden = false;
      $("setup-details").hidden = false;
    } catch (error) {
      pipelineActive = false;
      setStatus("pipeline-status", "unknown", "Status unavailable");
      $("pipeline-updated").textContent = "";
      $("pipeline-overview").hidden = true;
      $("pipeline-activity").hidden = true;
      $("setup-details").hidden = true;
      feedback("pipeline-error", `Could not load downloader and encoder status. ${error.message} Use Refresh status to try again.`);
    } finally {
      pipelineBusy = false;
      $("pipeline-overview").setAttribute("aria-busy", "false");
      $("pipeline-refresh").disabled = false;
      $("pipeline-refresh").textContent = "Refresh status";
      schedulePipeline();
    }
  }
  const PROV_LABELS = { ok: "Serving", "no-sources": "No sources for test title", "no-match": "Test title not found", blocked: "Blocked", "rate-limited": "Rate limited", "upstream-down": "Unreachable", error: "Error", unknown: "Not checked" };
  const PROV_HINTS = { blocked: "The source is blocking requests. Configure another source.", "rate-limited": "Requests are paused before retrying.", "upstream-down": "The source could not be reached.", "no-match": "Try another title to check availability." };
  const TIER_LABELS = { quality: "Release files", floor: "Instant streaming" };
  const SETUP_HINTS = { debrid: "Set REAL_DEBRID_TOKEN or PREMIUMIZE_API_KEY in the server\u2019s .env.", torrentio: "Configure a debrid account to play these releases.", vidlink: "See VIDLINK in .env.example to enable this optional source." };
  function renderSources(data) {
    const providers = data.providers || [];
    const serving = providers.filter((provider) => provider.configured !== false && provider.status === "ok");
    const configured = providers.filter((provider) => provider.configured !== false);
    const checked = configured.some((provider) => provider.status && provider.status !== "unknown");
    setStatus("rs-status", !checked ? "unknown" : serving.length ? "ready" : "action-needed", !checked ? "Not checked" : serving.length ? "Available" : "Needs attention");
    $("rs-detail").textContent = checked ? `${serving.length} of ${configured.length} configured sources serving. Checks use a sample title.` : "Check sources to test playback availability.";
    $("rs-providers").innerHTML = providers.map((provider) => {
      const unset = provider.configured === false;
      const label = unset ? "Not configured" : PROV_LABELS[provider.status] || provider.status || "Not checked";
      const state = unset || provider.status === "unknown" ? "neutral" : provider.status === "ok" ? "" : "warning";
      const details = [!unset && provider.lastError ? String(provider.lastError).slice(0, 200) : "", !unset && provider.breakerOpen ? `Paused for ${Math.max(0, Math.round(provider.opensInMs / 1e3))}s.` : "", unset ? SETUP_HINTS[provider.name] || "Configure this source in the server\u2019s .env." : PROV_HINTS[provider.status] || ""].filter(Boolean).join(" ");
      return `<div class="source-row"><div>${esc(provider.label || provider.name)}<span class="source-tier">${esc(TIER_LABELS[provider.tier] || provider.tier || "")}</span></div><span class="status ${state}">${esc(label)}</span><p class="source-detail">${esc(details)}</p></div>`;
    }).join("") || `<p class="empty-state">No streaming sources returned by the server.</p>`;
    const indexes = data.indexes || [];
    $("rs-indexes").innerHTML = !indexes.length ? "" : `<h3>Release indexes</h3>${indexes.map((index) => `<div class="index-row ${index.stale ? "stale" : ""}"><strong>${esc(index.indexer)}</strong><span>${index.newestAt ? `Latest release ${esc(String(index.newestAt).slice(0, 10))}${index.ageDays != null ? ` \xB7 ${esc(index.ageDays)} days ago` : ""}` : "No release timestamps yet"}${index.stale ? " \xB7 Index may be stale" : ""}</span></div>`).join("")}`;
  }
  async function loadSources(probe = false) {
    const button = $("rs-btn");
    button.disabled = true;
    button.textContent = probe ? "Checking sources\u2026" : "Loading\u2026";
    feedback("sources-error");
    try {
      renderSources(await request("/api/admin/sources", probe ? { method: "POST", timeout: 12e4 } : {}));
    } catch (error) {
      setStatus("rs-status", "unknown", "Status unavailable");
      $("rs-detail").textContent = "";
      $("rs-providers").textContent = "";
      $("rs-indexes").textContent = "";
      feedback("sources-error", `Could not check streaming sources. ${error.message} Use Check sources to retry.`);
    } finally {
      button.disabled = false;
      button.textContent = "Check sources";
    }
  }
  async function loadMembers() {
    if (membersBusy) return;
    membersBusy = true;
    $("members-refresh").disabled = true;
    feedback("members-error");
    try {
      const data = await request("/api/admin/users");
      const users = data.users || [];
      const invites = (data.invites || []).filter((invite) => !invite.used);
      $("member-count").textContent = String(users.length);
      $("invite-count").textContent = String(invites.length);
      $("users").innerHTML = users.map((user) => `<tr><td>${esc(user.name)}${String(user.email).toLowerCase() === currentUserEmail ? ' <span class="count">(you)</span>' : ""}</td><td class="member-email">${esc(user.email)}</td><td>${user.role === "admin" ? "Admin" : "Member"}</td><td><span class="status ${user.active ? "" : "neutral"}">${user.active ? "Active" : "Disabled"}</span></td><td><div class="member-actions"><button class="button text-button" type="button" data-action="toggle" data-tv-key="admin-member-toggle-${esc(user.id)}" data-id="${esc(user.id)}" data-active="${user.active ? 0 : 1}" aria-label="${user.active ? "Disable" : "Enable"} ${esc(user.name)}">${user.active ? "Disable" : "Enable"}</button><button class="button text-button danger" type="button" data-action="delete" data-tv-key="admin-member-delete-${esc(user.id)}" data-id="${esc(user.id)}" data-name="${esc(user.name)}" aria-label="Delete ${esc(user.name)}">Delete</button></div></td></tr>`).join("") || `<tr><td colspan="5" class="empty-state">No members found.</td></tr>`;
      $("invites").innerHTML = invites.map((invite) => `<tr><td>${esc(invite.name)}</td><td class="member-email">${esc(invite.email)}</td><td>${invite.role === "admin" ? "Admin" : "Member"}</td><td><a class="table-link" data-tv-key="admin-invite-${esc(invite.token)}" href="/invite.html?token=${encodeURIComponent(invite.token)}" aria-label="Open invite for ${esc(invite.name)}">Open invite</a></td></tr>`).join("") || `<tr><td colspan="4" class="empty-state">No pending invites.</td></tr>`;
    } catch (error) {
      feedback("members-error", `Could not load members and invites. ${error.message} Use Refresh members to retry.`);
      $("member-count").textContent = "\u2014";
      $("invite-count").textContent = "\u2014";
      $("users").innerHTML = `<tr><td colspan="5" class="empty-state">Member list unavailable.</td></tr>`;
      $("invites").innerHTML = `<tr><td colspan="4" class="empty-state">Invite list unavailable.</td></tr>`;
    } finally {
      membersBusy = false;
      $("members-refresh").disabled = false;
    }
  }
  $("users").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const { action, id, active, name } = button.dataset;
    if (action === "delete" && !await confirmDeleteMember(name)) return;
    const buttons = [...button.closest("tr").querySelectorAll("button")];
    buttons.forEach((item) => {
      item.disabled = true;
    });
    feedback("members-error");
    try {
      await request(`/api/admin/user/${encodeURIComponent(id)}${action === "toggle" ? "/active" : ""}`, action === "toggle" ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: Number(active) }) } : { method: "DELETE" });
      await loadMembers();
    } catch (error) {
      feedback("members-error", `Could not ${action === "delete" ? "delete" : active === "1" ? "enable" : "disable"} member. ${error.message}`);
    } finally {
      buttons.forEach((item) => {
        item.disabled = false;
      });
    }
  });
  $("invite-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = { name: $("i-name").value.trim(), email: $("i-email").value.trim(), role: $("i-role").value };
    if (!body.name || !body.email) {
      feedback("invite-error", "Enter a name and email address.");
      return;
    }
    $("i-btn").disabled = true;
    $("i-btn").textContent = "Creating\u2026";
    feedback("invite-error");
    $("i-out").hidden = true;
    try {
      const { url } = await request("/api/admin/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!url) throw new Error("The server did not return an invite link.");
      $("invite-url").value = new URL(url, location.origin).href;
      $("invite-recipient").textContent = `Invite link for ${body.name}`;
      $("invite-feedback").textContent = "Share this link with the invited member. It has not been sent by email.";
      $("invite-copy").textContent = "Copy link";
      $("i-out").hidden = false;
      $("invite-form").reset();
      await loadMembers();
    } catch (error) {
      feedback("invite-error", `Could not create invite. ${error.message}`);
    } finally {
      $("i-btn").disabled = false;
      $("i-btn").textContent = "Create invite link";
    }
  });
  $("invite-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("invite-url").value);
      $("invite-copy").textContent = "Copied";
      $("invite-feedback").textContent = "Invite link copied.";
    } catch {
      $("invite-url").focus();
      $("invite-url").select();
      $("invite-feedback").textContent = "Copy the selected link using your browser\u2019s copy command.";
    }
  });
  $("pipeline-refresh").addEventListener("click", loadPipeline);
  $("rs-btn").addEventListener("click", () => loadSources(true));
  $("members-refresh").addEventListener("click", loadMembers);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(pipelineTimer);
    else if (pipelineActive) loadPipeline();
  });
  async function init() {
    try {
      const me = await request("/api/me");
      if (me.role !== "admin") {
        location.href = "/";
        return;
      }
      currentUserEmail = String(me.email).toLowerCase();
      await Promise.all([loadPipeline(), loadSources(), loadMembers()]);
    } catch (error) {
      feedback("page-error", `Could not verify your admin access. ${error.message} Reload this page to try again.`);
    }
  }
  init();
})();
