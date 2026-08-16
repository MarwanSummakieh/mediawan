# Mediawan on Samsung TV (Tizen)

Mediawan's frontend is a web app, so a Samsung TV runs it as a `.wgt` package.
The backend stays on the NAS behind the Cloudflare tunnel; the TV app just talks
to it over the network.

**This folder is a complete, buildable Tizen app.** What's left needs your
Samsung account and the TV itself — see [Build, sign, install](#build-sign-install).

```
tizen/
  README.md              this file (deliberately outside the package)
  Mediawan/              the widget project — everything here ships
    config.xml           Tizen TV manifest (landscape, internet, Back key)
    index.html           loads https://your-domain.example/?tv=1
    icon.png             512×512 launcher icon (npm run tizen-icon)
    tizen_web_project.yaml   tz project descriptor (file list, profile, api)
    .project .tproject   Tizen project metadata
```

```bash
npm run tv-build
```

```bash
npm run tv-install -- 192.168.1.42
```

Both wrap the Tizen CLI (`tz`), which lives inside the VS Code Tizen extension
rather than on `PATH`; the scripts find it there or in a full Tizen Studio
install. Output lands in `tizen/Mediawan/Debug/Mediawan.wgt` (add `--release`
for a Release build). The package is ~8 kB: manifest, icon, loader, signatures.

---

## A. Hosted build (this is what's set up)

The package is a few hundred bytes: it opens your live site with `?tv=1`, which
switches on the remote-control navigation in `public/tv.js`. Because it loads
the real domain, login cookies are first-party and there is **no CORS or auth
work at all**.

Change the host in one place — `APP_URL` in `index.html` — if the tunnel
hostname ever moves.

> The TV shows whatever the NAS is serving, so deploy `public/` before
> installing, and after any frontend change. No re-install needed for those.

## B. Packaged build (self-contained, only if you want offline chrome)

Bundle the SPA into the `.wgt` instead of loading it remotely:

1. Copy `public/*` into `Mediawan/`, alongside `config.xml`, and add the new
   files to the `files:` list in `tizen_web_project.yaml`.
2. Replace `config.js` with `window.API_BASE = "https://your-domain.example";`
   The client already absolutises API and media URLs from `API_BASE` (see
   `media()` and the `fetch` shim in `public/app.js`).
3. **Extra server work this mode needs** (hosted needs none): CORS headers for
   the TV origin, and — because cross-origin cookies are unreliable in TV
   webviews — a bearer token for the TV client instead of the session cookie.

Every frontend change then means a rebuild and re-install. Stick with A.

---

## Signing

`npm run tv-build` signs with a local profile called **mediawan**:

| | |
|---|---|
| Author cert | `~/.tizen-extension-platform/server/sdktools/sdk-data/keystore/author/mediawan-author.p12` |
| Password | `mediawan` |
| Distributor cert | the SDK's `tizen-distributor-signer.p12` (public) |

The author half is a self-signed identity generated with `tz cert` — no Samsung
account involved. Recreate or rename it any time:

```bash
tz cert -n "Your Name" -p <password> -f my-author
```

**This was enough** — verified installing on a QE65Q70TA (2020 Q70T, Tizen
5.5) in Developer Mode. No Samsung account, no DUID registration. A sideloaded
app is tied to Developer Mode staying on, though, and dev signatures expire
eventually; re-run `tv-build` + `tv-install` if the TV starts refusing it.

If a different set *does* reject the signature, that's when you need a Samsung
distributor certificate: **Certificate Manager** → new **Samsung** profile
(signs in to your Samsung account, wants the TV's DUID, so connect the TV
first). The Store route needs a partner certificate plus review — skip it.

> **`--profile` does not work with this `tz`.** `tz pack -s <name>` is silently
> ignored — so is `-p <profiles.xml>`. It always signs with whatever profile
> `profiles.xml` names in its `active="…"` attribute; passing a profile name
> that does not exist at all produces no error and the same package. Verified
> 2026-07-31. **Select a profile by setting `active="<name>"`** in
> `~/.tizen-extension-platform/server/sdktools/sdk-data/profile/profiles.xml`,
> then check the `Distributor cert :` line the build prints — that line, not
> the flag you passed, is the truth about what signed the package.

### Tizen 6+ sets need a real Samsung certificate

The 2024 Odyssey OLED G8 (LS34DG850SUXEN, **Tizen 9.0**) refuses the
self-signed setup above with:

```
install failed[118, -12], reason: Check certificate error :
  :Invalid certificate chain with certificate in signature.:<-3>
```

This is **not** fixable from the SDK's own certificates. Both of the generic
distributor certs were tried and both are rejected:

| cert | validity | result on Tizen 9.0 |
|---|---|---|
| `tizen-distributor-signer.p12` (Tizen Test CA) | **expired Nov 2012** | rejected |
| `tizen-distributor-signer-new.p12` (Tizen Studio Public) | valid to Oct 2032 | rejected |

Expiry was the obvious suspect and it was the wrong one — a current public
Tizen chain fails identically. Samsung retail sets from Tizen 6 up trust only a
Samsung-issued chain tied to the target's DUID, which means Certificate Manager
and a Samsung account. Tizen 5.5 sets (the Q70T) validate none of this, which
is why the same `.wgt` still installs there.

## Developer Mode + install

On the TV: **Apps** screen → press `12345` on the remote → Developer Mode
**on** → enter this PC's IP → **reboot the TV**. Then:

```bash
npm run tv-install -- <tv-ip>
```

which runs `sdb connect`, installs the `.wgt` and launches it. The app also
stays on the TV's Apps row.

The TV accepts the TCP connection on port 26101 whether or not it trusts you,
so a `sdb connect` that fails at the handshake while the port is open means
Developer Mode is off, the host IP doesn't match, or the TV hasn't been
rebooted since. `sdb shell` returns nothing on retail sets — that's normal, not
a failed install; trust the installer's own `install completed`.

### config.xml rules the TV enforces

Break either of these and the install dies with a bare `Parsing error`
(`install failed[118, -19]`), which says nothing about the cause:

- `package` must be **exactly 10 alphanumeric characters** (`MediawanTV`), and
  `tizen:application id` must be `<package>.<name>`.
- `<access origin="*"/>` takes no `subdomains` attribute.

---

## The 10-foot UI

`public/tv.css` holds every TV-only rule, scoped to `html.tv` — desktop loads
the file and matches nothing in it.

The webview is **1920×1080 whatever the panel is** (the TV upscales to 4K), so
this is not "4K styling": it's a 1920 canvas read from across a room on a 65"
screen. Roughly double the desktop scale — 22px base text, 280px posters,
30px row titles, six cards across, a 60px safe-area inset for overscan. A
`min-width: 2400px` branch doubles it again in case a newer set really does
hand us a 3840 viewport, and a `max-width: 1400px` branch covers older 1280
webviews.

That file also carries the **flexbox `gap` fallbacks**. `gap` only works in
flexbox from Chromium 84; styles.css has 49 gap declarations and every one is
inert on a 2020 set, so cards would sit flush and the player controls would
jam together. Each affected container gets `gap: 0` plus `> * + *` margins —
zeroed deliberately so a desktop browser in TV mode lays out *identically* to
the television instead of adding gap and margin together.

Watch for these when touching styles.css, all silently dropped on Chromium 69:
`min()`/`max()`/`clamp()` (79), `inset` shorthand (87), flex `gap` (84),
`aspect-ratio` (88), `:has()` (105). The two `min()` widths that mattered now
carry a plain-px fallback declaration ahead of them.

## Driving it with the remote

`public/tv.js` activates in TV mode (Tizen webview, `?tv=1`, or
`localStorage.tv=1`) and leaves desktop behaviour untouched.

**Browsing** — arrows move the highlight between cards, episodes, buttons and
schedule rows; **OK** activates; **Back** closes the open menu, then the detail
modal. The highlight stays put while the row scrolls underneath it, and vertical
moves remember the column you were on, so dropping into the next row and coming
back returns you to the same card. Holding a direction snaps instead of
animating, so the highlight can't run ahead of the picture.

**In the player** the arrows belong to the video, so the control bar is entered
explicitly — the same model every TV player uses:

| Key | Video | Control bar | Menu / drawer open |
|---|---|---|---|
| **Up** | enter the control bar | ‹ back button | move |
| **Down** | — | leave the control bar | move |
| **Left / Right** | seek ±5s | walk the buttons | move |
| **OK** | play / pause | activate | activate |
| **Back** | close the player | back to the video | close this layer |

Everything the player can open is reachable this way: Servers, Quality, Speed,
Subtitles, Audio and the episode list. The highlight lands on whatever the panel
is currently *on* — the playing server, the selected quality, this episode —
and returns to the control bar when a panel closes. While the remote is on the
control bar the chrome stops auto-hiding, and panel text is sized up for 10-foot
viewing.

## Old TVs need a down-levelled frontend

Samsung's 2020 sets run **Tizen 5.5 = Chromium 69** (the Q70T reports
`69.0.3497.106`). That predates optional chaining (`?.`), nullish coalescing
(`??`) and the CSS `inset` shorthand — all of which `public/` uses heavily. On
those TVs `app.js` is a **syntax error**: nothing parses, nothing boots, and
the screen is black with no console, no logs and no clue.

```bash
npm run build:tv
```

writes Chromium-69 copies of `app.js`, `tv.js`, `config.js` and `styles.css`
into `public/tv-build/`, and `server.mjs` serves those to Tizen user agents
(`Vary: User-Agent`) while every other browser gets the untouched originals.
**Re-run it whenever you change those four files, and before deploying** — the
server prints a warning at startup if `public/tv-build/` is missing, and logs
one line the first time a TV is served.

esbuild lowers *syntax*, not missing runtime methods, so anything newer than
Chromium 69 that isn't syntax has to be avoided by hand — `Array.prototype.at`
was the one offender and is already rewritten. The build fails loudly if a
banned construct survives into the output.

### Testing against a dev server

Prod is HTTPS behind the tunnel, but for a hardware test you can point the
widget at your machine:

```bash
npm run tv-build -- --url http://<your-lan-ip>:8787/?tv=1
```

`config.xml` is rewritten for the pack and restored afterwards, so the file on
disk always stays pointed at production.

## Debugging a set that gives you nothing

A retail TV has no console, no `dlog` and no Web Inspector — `sdb capability`
works and almost nothing else does. So in TV mode the app reports on itself to
`POST /api/tv-log`, which prints in the server log (authenticated, rate-limited,
deduplicated, newline-stripped):

- `[tv-error] error/rejection/resource` — uncaught failures.
- `[tv-error] player` — a status the player showed and gave up on. Playback
  failures are *handled*, so an error hook alone would miss them entirely.
- `[tv] caps` — hls.js, MediaSource, native HLS, codecs, viewport size.
- `[tv] playing` — resolution and duration once a frame actually reaches the
  screen. "No errors" is not the same as "playing".
- `[tv] layers` — `elementFromPoint` at three positions, which is how the black
  video was diagnosed: it proved the player *was* on top and the fault was
  compositing, not z-index.

`npm run tv-build -- --url http://<lan-ip>:8787/movie/tt0816692?tv=1` deep-links
the widget straight at a route, so a failure can be reproduced without touching
the remote. Add a changing `&r=N` — the TV will happily resume a running app
instead of reloading it.

### Known follow-ups

- **AVPlay**: playback uses `hls.js`, which works in Tizen's webview. If a
  particular set stutters, switch the player to Samsung's native
  `webapis.avplay` — the privilege is already declared in `config.xml`.
- Test on the real TV. The verification here drives synthetic D-pad events in a
  desktop browser at 1920×1080; it proves the navigation graph, not the decoder.
