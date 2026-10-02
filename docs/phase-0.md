# Phase 0 — decisions and preflight

Companion to the build plan. Everything here is either a decision that later
phases read, or a host fact that had to be checked before phase 01. Update the
status column as checks land; nothing in phase 01 starts until every row is
✅ or a deliberate ⏭️.

Started 2026-09-02.

## Status

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | VPN provider with port forwarding | ⬜ decision needed | See "VPN" below. Buy, generate a WireGuard config, put the key in `.env` as `WG_PRIVATE_KEY`. |
| 2 | NAS can run gluetun | ⬜ run preflight | Needs a root shell on the NAS. `sudo sh scripts/phase0-preflight.sh /path/to/library` |
| 3 | Jellyfin inventory | ⬜ blocked | Not found on the LAN (see "Findings"). Need its address, or start it. Then: version, config path, library roots, real-time monitoring, API key. |
| 4 | One filesystem for library and torrents | ⬜ run preflight | The script tests a real hardlink, not just device ids. |
| 5 | Policy written down | ✅ | Below. `lib/policy.mjs` in phase 02 is a transcription of it. |
| 6 | Budget written down | ✅ | Below. |

## Host preflight

Run the preflight on your own NAS to check service availability, Docker
capabilities, library paths and filesystem support. Keep host addresses,
network scans and SSH account details in local setup notes.

If Jellyfin is not available, record its location in your local configuration
or bring it up before proceeding with the library inventory.

## The policy

Applied to every release **before** ranking, for Movies and TV. Anime gets its
own object in phase 06.

```
resolution     1080 or 2160                 (from the release name; verified by probe on arrival)
source         WEB-DL                       (WEBRip only when WEBRIP_FALLBACK=true)
audio          English required             (release tag now; ffprobe language tag on arrival;
                                             a file that arrives without an English track is
                                             rejected and the next candidate tried)
codec          any                          (H.264, HEVC, AV1 all fine — Jellyfin handles playback)
hdr            allowed, never required
max size       1080p: 12 GB per movie, 4 GB per episode
               2160p: 40 GB per movie, 12 GB per episode
seeder floor   3 known seeders, or unknown  (unknown means "try it", matching looksFetchable today)
```

Why WEB-DL only: they are untouched service encodes, so they are the smallest
files at a given quality and the fastest to download. REMUX and BluRay encodes
are excluded on size and speed, not on quality.

Why a size cap: one mis-tagged 2160p "WEB-DL" that is really an 80 GB remux
would evict a dozen films to make room. The cap catches it before the swarm.

## The budget

```
CACHE_BUDGET_BYTES     16492674416640     (15 TiB)
reserve                300 GiB below the budget — a download is refused, and
                       eviction runs, when projected usage would cross it
counting               by unique inode across /volume1/media/library and
                       /volume1/media/torrents (hardlinks count once)
seeding                stop at ratio 2.0 or 7 days, whichever first;
                       the file stays until eviction
eviction order         1. never played, oldest added first
                       2. then least-recently played across all users,
                          play count as tiebreak
never evict            any user's Jellyfin favourite, anything in an active
                       session, anything still downloading
```

Room for anime, torrents in flight and Jellyfin's own metadata comes out of the
remaining 5 TB on the array, not the budget.

## VPN

Requirements: WireGuard, port forwarding, a gluetun-native provider entry so
the compose file stays declarative.

| Provider | Port forwarding | gluetun | Notes |
|----------|-----------------|---------|-------|
| ProtonVPN | yes, on P2P servers | native | Recommended. Port changes on reconnect, so the port hook in phase 01 is required. |
| AirVPN | yes, static per device | native | Static port means no hook, but the provider has fewer servers near NL. |
| Mullvad | no (removed 2023) | native | Works, but incoming peers cannot connect; expect slower thin swarms. |

Decision: **ProtonVPN** unless you already hold an AirVPN account. Record the
choice here when made.

## Directory layout the rest of the plan assumes

```
/volume1/media/                 one bind mount, same path in every container
  library/
    Movies/
    Shows/
    Anime/                      phase 06
  torrents/
    incomplete/                 qBittorrent temp path; never scanned by Jellyfin
    complete/                   qBittorrent save path; library files are hardlinks into here
/volume1/docker/mediawan/       repo checkout + .env (unchanged)
/volume1/docker/mediawan/data/  sqlite, qbittorrent config, jellyfin config
```

If the existing Jellyfin library is elsewhere on `/volume1`, moving it under
`library/` is a same-volume `mv` and takes seconds. If it is on another volume,
that is a real copy and needs to be scheduled.

## Commands to run on the NAS

```bash
# 1. copy the script over (from the dev box)
scp scripts/phase0-preflight.sh <nas-user>@<NAS_IP>:/tmp/

# 2. on the NAS
sudo sh /tmp/phase0-preflight.sh /volume1/path/to/jellyfin/library
```

Paste the output under "Findings" and flip the status rows.
