# Mediawan media navigation and playback plan

Date: 2026-10-08
Status: Proposed implementation plan; no application changes made.

## Objective and scope

Make Mediawan a complete everyday interface for browsing, resuming, and playing a personal media library. Keep its existing search, Real-Debrid acquisition, permanent local storage, and player. Implement the requested Jellyfin-style conveniences within Mediawan without requiring Jellyfin, Sonarr, or Radarr.

Prioritize downloaded media while preserving existing on-demand playback. A finished local copy should be usable even when external discovery or Real-Debrid is unavailable. Provider credentials and resolved download URLs remain on the server.

This plan is based on inspection of the current working tree, including its existing uncommitted library work. It is not a screenshot audit or confirmation of the deployed NAS version. Before implementation, establish which of these existing changes have reached the deployed image. Treat the current changes as the baseline and preserve them.

## Current implementation and gaps

| Capability | Evidence in current source | Work required |
| --- | --- | --- |
| Continue Watching | `server.mjs:continueWatchingFor`; `public/app.js:continueRowHtml` | Complete and consolidate. A row exists, but it mixes resume and next-episode selection and has different local/legacy paths. Verify why it is absent or ineffective on the user's deployment. |
| Per-episode progress and watched state | `lib/library/store.mjs:setItemState`; library state routes; player progress reports | Consolidate legacy and library writes, preserve final progress, support rewatching, and handle concurrent sessions. |
| Play next episode | `public/library.js:play`; `public/app.js:setStreamNav`, `showUpNext`, TV season navigation | Existing previous/next controls and end-of-episode countdown should be reused. Add one consistent selection policy and a persistent queue. |
| Dedicated Next Up shelf | Current home exposes `continueWatching`; some next-item selection is folded into it | Add a distinct shelf for the next episode of an active series. |
| Shuffle episodes | No implementation found in reviewed library/player paths | Add season/show scope and a stable randomized queue. |
| Favorites, watchlist, collections | Library APIs cover all three media types; home still uses legacy anime-oriented lists | Surface mixed media consistently; preserve existing lists and ownership. |
| Library browsing | Saved library has query, library, type, and list filters | Add watched status, sort, pagination, season grouping, and durable navigation state. |
| Audio/subtitle and quality controls | Existing player menus, preferences, and delivery logic | Reuse controls; add account-level preference synchronization and predictable fallback rules. |
| Intro/outro skipping | Existing anime AniSkip path in `public/app.js` | Preserve it. General episode markers and chapter browsing are later work. |
| TV controls and casting | `public/tv.js`, TV build, existing casting and watch-together paths | Extend existing controls; verify queue/progress behavior on these paths rather than rebuilding them. |

Code-level issues to address early:

- `continueWatchingFor` chooses either nonempty library results or legacy results instead of explicitly merging eligible records. Its next-item selection can stop at an unavailable or already watched episode.
- `seen` is set before a candidate is fully validated. Candidate selection and series deduplication should happen in a deliberate order.
- `setItemState` preserves an existing watched flag during normal progress updates. A rewatch requires a separate active session/cursor policy.
- Saved playback reports use a normal `fetch` even when the caller requests an unload-safe report. A page close can lose the final update.
- Library detail selects the first ready unwatched item, which is different from resuming the most relevant in-progress episode.
- Store access often reads and filters whole record sets. New shelves and queues must avoid repeated full scans per card.

These are findings from source inspection, not reproduced production incidents.

## Product behavior

### Home and navigation

Use the existing navigation framework with these destinations: Home, Discover, Library, My List, and Downloads. Keep existing Live TV and account/admin access. Movies, TV, and Anime remain easily accessible filters within discovery and the library; preserve old deep links.

Home order: Continue Watching, Next Up, Recently Added, My List, then discovery/recommendation sections. Hide empty shelves. Personal shelves must render from the local database without waiting for external catalog calls. Keep discovery useful without letting it push unfinished viewing below the fold.

Use common title and episode cards across these surfaces. Cards show only useful state: episode identity, remaining time/progress, watched state, and local availability. Primary actions use explicit labels such as `Resume S2 E4` or `Play S2 E5`. Keep secondary actions in an accessible menu.

Apply the existing styling and Scandinavian UI skill: concise labels, restrained surfaces, readable hierarchy, existing spacing/type tokens, and visible focus. This is a functional extension, not a visual rebrand.

### Continue Watching

- Show unfinished movies and episodes, ordered by last actual playback activity; at most one card per series.
- Proposed initial resume eligibility: at least 10 seconds played, not completed. Continue using 95% as the initial completion threshold to preserve current behavior; expose thresholds as server policy rather than duplicate literals.
- Unknown duration must not cause automatic completion. Retain a valid position and offer resume without fabricated percentages.
- Clicking the primary action resumes directly. Secondary actions: Open details, Play from beginning, Mark watched, and Remove from Continue Watching.
- Removing a card hides the title until the user intentionally plays it again. It does not delete files, history, or mark the title watched. A delayed heartbeat must not unhide it.
- An explicit replay creates a new viewing attempt while retaining historical completion. Partially watched replays can appear in this shelf.
- Refresh after pause/stop, watched actions, returning to Home, and app foregrounding. Cross-device changes become visible on refresh or a lightweight refresh while Home is visible.
- Prefer the local copy when the identity matches. If a different cut/runtime makes the old timestamp unreliable, offer restart instead of silently resuming at the wrong scene.

### Next Up and season browsing

- Show one next episode for a series the user has begun. Suppress its Next Up card while an eligible Continue Watching card exists.
- Use a sequential-viewing cursor, independent from random shuffle activity. Default candidate is the next unwatched regular episode after that cursor; keep earlier unwatched gaps visible in the episode list.
- Continue across season boundaries. Place specials in a separate group and exclude them from automatic sequential playback unless included explicitly.
- Keep anime identity rules: separate AniList season entries are linked only through verified metadata, never guessed from titles. Preserve absolute numbering when supplied.
- For local playback, stop at a missing sequential episode and show `Not downloaded` with an explicit download action. Do not silently jump past a story gap. An explicit skip action can select a later available episode.
- Recently acquired next episodes reappear automatically after acquisition completes. Download completion updates availability, not viewing history.
- Do not label on-demand catalog episodes as locally ready. Existing on-demand playback remains an explicit option outside a local-only queue.
- Detail pages group episodes by season and show episode title, available artwork/runtime, watched/progress state, and availability. Resume takes precedence over Play next; completed series offer Replay.

### Shuffle and play queues

- Provide `Shuffle episodes` on a show and `Shuffle season` on a season. Offer All episodes (default) or Unwatched only. Specials are excluded by default.
- Initial shuffle uses accessible, completed local files. Downloading, missing, and unauthorized assets are excluded. Shuffle never starts downloads implicitly.
- Shuffle creates one randomized permutation without replacement, persists the order, and advances through it. Next/Previous use that same order; do not draw another random episode on every click.
- Start shuffled episodes from the beginning. Preserve historical watched state and record progress on the episode being played. A shuffle session does not replace the normal sequential Next Up cursor.
- Preserve queue order and current item across reloads and server restarts. Resuming a queue starts playback only after an explicit user action.
- Allow Play next, Add to queue, Remove, Reorder, and Clear queue. Reordering has keyboard/remote alternatives to dragging.
- Queues are owned by a user and a playback session. Separate devices do not unexpectedly take control of each other's queues. Explicitly loading a saved queue on another device starts a new session.
- Recheck access and file availability before each item. Offer retry/skip for a missing shuffle item; stop on a missing sequential episode. Report when the queue is exhausted and never loop indefinitely.
- Use the existing end-of-playback overlay for Play now/Cancel and an account preference for automatic advancement. Do not skip credits solely because an item reached the watched threshold.

### Library, lists, and preferences

- Add library sorting by title, recently added, year, and last watched; filters for watched/unwatched/in progress, genre, type, and availability. Unknown metadata stays unknown and sorts predictably.
- Persist filters in the URL, plus scroll/focus by route. Back returns to the same shelf/card or episode.
- Define `addedAt` as the first successful library import/acquisition time, distinct from metadata refresh time, to keep Recently Added stable.
- Add individual and bulk watched/unwatched actions for seasons and shows with affected counts and undo. Bulk operations apply to the selected known episodes, not future episodes.
- Use the existing mixed-media favorites/watchlist/collections store everywhere. Collections group titles; later playlists store an ordered set of specific movie/episode items.
- Give Downloads its own view with progress, retry/cancel, and `Ready to watch`; retain contextual status on title pages.
- Sync autoplay and audio/subtitle language/mode preferences to the account. Store language/role preferences rather than track numbers because indices differ between files. Explicit per-play choices override preferences. Device capability and quality limits remain device-specific.

## Implementation architecture

Extend the existing Express, SQLite, and browser JavaScript application. Extract narrowly scoped modules from `server.mjs` and the large player as each feature is added; avoid a simultaneous framework rewrite.

| Module | Responsibility |
| --- | --- |
| `lib/library/store.mjs` (existing) | Canonical title/item/asset identity, aliases, personal tags, collections, and migrations. |
| `lib/library/history.mjs` (new) | Playback session events, progress/completion policy, replay attempts, dismissals, and sequential cursor. |
| `lib/library/navigation.mjs` (new) | Continue Watching, Next Up, Recently Added, detail primary action, and access-filtered availability. |
| `lib/library/queues.mjs` (new) | Sequential and shuffle snapshots, cursor, edits, ownership, revisions, and availability checks. |
| `lib/library/preferences.mjs` (new) | Per-user playback and library view defaults. |
| `lib/library/routes.mjs` (existing) | Authenticated API adapters; keep business rules in independently testable services. |
| `public/library.js`, `public/app.js` (existing) | Wire existing screens/player into shared navigation responses and queue APIs. |
| `public/playback-queue.js`, `public/media-cards.js` (new if extraction warrants) | Shared queue client and common media-card/actions rendering. |
| `public/tv.js`, CSS, `scripts/build-tv-assets.mjs` | TV focus, dialogs, responsive styles, and generated asset packaging. |

Suggested additive API contracts, finalized in phase 1:

- `GET /api/library/home`: independent `continueWatching`, `nextUp`, `recentlyAdded`, and personal-list shelves with stable IDs, availability, and explicit primary actions.
- `POST /api/library/playback-sessions`: start a viewing attempt from an authorized item and optional queue; return session ID and state revision.
- `POST /api/library/playback-sessions/:id/events`: start/progress/pause/seek/ended/stop events with a monotonically increasing sequence number and media position.
- `POST /api/library/titles/:id/continue-watching`: explicit hide/restore action.
- Extend item-state routes for explicit watched/replay semantics; add a bounded, transactional bulk-state endpoint.
- `POST /api/library/queues`, `GET /api/library/queues/:id`, `PATCH /api/library/queues/:id`: build/read/edit user-owned queues with revision checks.
- `GET/PATCH /api/library/preferences`: validated preferences for the authenticated user.
- Extend library list/detail responses with pagination, sort/filter state, grouped episodes, and `primaryAction`.

API responses never accept a client-supplied user identity as authorization. Validate permissions on reads, queue edits, playback start, and advancement. Use the existing authenticated stream endpoint to resolve the current file; store item IDs in queues, never expiring media URLs.

### Data and migration rules

Keep the existing canonical `titleId` and `itemId`. Preserve provider aliases so a catalog title and its saved copy share viewing state. Assets remain separate from the episode/movie identity.

Add versioned SQLite structures for user/item playback state, per-session progress sequence, title dismissal/sequential cursor, queues/entries, and preferences. Add indexed access by user, item/title, last activity, and queue position. Use additive migrations and reuse existing identifiers rather than replacing the catalog schema.

Separate fields for position/duration, historical completion, current viewing attempt, and last playback time. Metadata refreshes and bulk watched actions must not impersonate playback activity. For competing sessions, the newest explicitly started viewing attempt owns the resume pointer; delayed reports from an older attempt can update its own history but not roll back the active pointer. Deliberate backwards seeks remain valid.

Legacy `/api/progress` and item-state callers should become adapters into this service. Backfill existing rows transactionally and idempotently, selecting the best existing per-item state and preserving explicit watched state. The old title-level table cannot recover episodes it overwrote; do not invent missing history. During transition, expose a compatibility projection for legacy readers rather than maintaining two independent sources of truth.

Capture progress every 10 seconds and on pause, seek completion, end, navigation, and page hiding. Flush before advancing the queue. Use `sendBeacon` or `fetch(..., {keepalive:true})` as appropriate, and deduplicate by session/event sequence. No browser can guarantee a final report after a process crash; acceptance allows loss of at most the periodic reporting window when the final flush cannot run.

Bound shelf queries and queue sizes; batch availability joins rather than walking all assets once per card. Define cache invalidation for progress, dismissal, permission changes, and library additions/removals. Cross-tab events may accelerate refresh, but the server remains authoritative.

## Delivery sequence and acceptance gates

| Phase | Deliverable | Dependency | Acceptance gate |
| --- | --- | --- | --- |
| 1. Baseline and history | Reproduce deployed gaps, fixtures, canonical history service, migration, final progress reporting | Existing library work | Existing progress survives upgrade/restart; local and on-demand copies share identity; two users stay isolated; stale events cannot overwrite a newer viewing attempt. |
| 2. Resume and navigation | Continue Watching, dedicated Next Up, consistent detail action, dismissal and replay, Recently Added | Phase 1 | Stop an episode, reload, resume within reporting tolerance; finish it and get the correct next episode; missing/special episodes obey policy; external outage does not block local shelves. |
| 3. Shuffle and queues | Season/show shuffle, persistent sequential queue, Next/Previous, queue editor, autoplay preference | Phases 1–2 | Every eligible episode appears once in a shuffle; order/cursor survive restart; random viewing leaves sequential cursor intact; permissions and missing files are rechecked. |
| 4. Library navigation | Season layout, filters/sort/pagination, mixed-media lists/collections, Downloads view, bulk watched actions | Phases 1–2; use phase 3 for Play all | Navigate with a remote, play an item, go Back to the same place; movie/TV/anime list actions agree on all screens; bulk actions can be undone. |
| 5. Preferences and polish | Account audio/subtitle defaults, queue/history affordances, cross-device refresh | Phases 2–4 | Preferences survive sign-in on another device; unavailable languages fall back clearly; existing casting and watch-together still work. |
| Later extensions | Ordered playlists, chapter browser/thumbnails, general intro/credits markers, optional home customization | Stable core and metadata support | Each ships with real metadata support and dedicated behavior tests; none blocks Continue Watching or shuffle. |

The first useful release is phases 1–3: dependable resume, Next Up, and shuffle. Phase 4 completes the everyday browsing experience. These are implementation slices, not promises of elapsed time; estimate after reproducing the live gap and confirming the deploy baseline.

## Verification plan

Use isolated fixture databases and locally generated short media; never test migrations or progress writes against the personal production database.

Automated coverage:

- History/navigation: movie vs episode, all media types, partial replay, zero/unknown duration, completion boundary, dismiss/replay, timestamp ties, stale/out-of-order reports, deliberate backwards seeking, and concurrent devices.
- Next Up: season boundary, watched later episodes, missing earlier episode, specials, separate anime seasons, newly downloaded next episode, unavailable local asset, and no duplicate series card.
- Queue: zero/one/many items, deterministic injected randomness, no duplicates, refresh/restart, Next/Previous, reorder/remove current item, stale revisions, revoked permission, missing file, and no implicit downloads.
- Migration: old title-only records, current per-item records, mixed lists/collections, idempotence, transactional failure, and unavailable metadata providers.
- API integration: authentication and cross-user/cross-library isolation on shelves, state, bulk actions, preferences, and queues.
- Client integration: progress flush before transition, direct resume, cancel autoplay, optimistic action failure recovery, focus restoration, and offline provider independence for saved files.

Extend `test/progress.test.mjs`, `test/library-store.test.mjs`, `test/library-routes.test.mjs`, `test/library-client.test.mjs`, and existing TV/watch-together tests. Add focused history/navigation/queue tests as those services appear. Run relevant tests per slice, then `npm test` and `npm run build:tv` for the release. Generated `public/tv-build` files come from the build script rather than hand edits.

Manual acceptance: desktop, narrow mobile, TV mode at 1280×720, 1920×1080, and 3840×2160; keyboard and remote focus; readable labels and non-color status cues; cancel/Back from every menu; real pause/seek/resume on direct and HLS playback. Validate real Tizen hardware, casting progress, and watch-together host authority before claiming support. For shared rooms, host queue order governs advancement; followers must not run independent shuffle/countdown decisions. If a path is not supported in the first slice, disable its new action explicitly.

Final end-to-end scenario: save one movie and several episodes through the existing Real-Debrid flow, finish acquisition, temporarily disable external providers, resume the movie from Home, play through a season transition, shuffle the saved episodes, restart Mediawan, and resume the same queue with the expected per-user history.

## Rollout and limits

Back up SQLite consistently and retain the deployed image digest before a production migration. Introduce history/navigation and queue changes behind temporary independent flags. Switch legacy callers only after fixture comparisons pass, then remove compatibility code in a later release. Do not delete legacy state tables in the initial migration. Rolling back schema-dependent code requires a compatible database/image pair; preserve new data separately before restoring an older backup.

Follow-series monitoring and automatic new-release acquisition remain a separate follow-on to this navigation work. The new `available locally` and `addedAt` signals provide its integration points. This plan does not add Jellyfin API compatibility, a plugin ecosystem, DVR, or additional native clients.

## Reference grounding

Jellyfin is a feature reference, not a new runtime dependency. Its source exposes separate resumable-item and next-up APIs, while its web client includes shuffle, queue, collection, and playlist controls. The detailed behaviors above are proposed Mediawan decisions rather than assertions that every Jellyfin client behaves identically.

- [Jellyfin resumable items API source](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/ItemsController.cs)
- [Jellyfin Next Up API source](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/TvShowsController.cs)
- [Jellyfin web feature labels](https://github.com/jellyfin/jellyfin-web/blob/master/src/strings/en-us.json)
- [Current Mediawan permanent library](library.md)
- [Current Mediawan TV navigation](tv-navigation.md)
- [Current Mediawan watch-together behavior](watch-together.md)
