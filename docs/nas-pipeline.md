# NAS downloader and encoder

Mediawan is available at https://media.marwansummakieh.me. The previous
`anime.marwansummakieh.me` address remains an alias on the same Cloudflare tunnel,
whose origin is `http://web:8787`.

## Runtime

The built-in downloader saves a release to the NAS when playback starts. Downloads
are bounded by the configured concurrency, cache budget, and free-space reserve.
Active readers and encoder sessions protect their source files from eviction;
a short grace period also protects gaps between browser Range requests.

Use **Admin → Downloader / Encoder** to inspect storage, transfers, GPU readiness,
and active encoding sessions. Provider subscription health is shown under
**Streaming sources**.

The NAS GPU passes real H.264 encoding with VAAPI. Quick Sync fails with an MFX
unsupported error on the installed driver stack, so use:

```yaml
TRANSCODE_HWACCEL: vaapi
TRANSCODE_DEVICE: /dev/dri/renderD128
```

Keep the existing `/dev/dri` mapping and supplemental GPU groups. The application
defaults are two downloads, a 2 TiB cache budget, a 20 GiB free-space reserve,
two encoder sessions, and a 6 Mbps remote video target. Existing NAS environment
overrides take precedence.

## Deployment and rollback

The active UGOS project file is
`Shared Folder/docker/mediawan/docker-compose.yaml`. Its original configuration
was copied to `Shared Folder/docker/mediawan/releases/docker-compose.yaml`
before deployment.

Deploy a tested registry image by digest through the existing UGOS project
editor. Set the web service's `com.centurylinklabs.watchtower.enable` label to
`"false"` while the image is pinned. This prevents automatic web updates until
the release is deliberately advanced. Preserve the other services, environment,
mounts, and GPU permissions.

For rollback, restore the backed-up compose content in the project editor and
redeploy. The backup uses the previous registry image policy; restoring it also
restores automatic updates. Data and media stay in their existing bind mounts.

## Verification

Run these commands inside the web container's Terminal:

```sh
node scripts/check-pipeline.mjs
node scripts/smoke-pipeline.mjs
```

The first checks configuration, storage, and encoder capabilities. The second
generates a short test clip, downloads it over loopback into an isolated cache,
verifies its SHA-256, encodes it with VAAPI into HLS, and checks playback leases
and eviction. Its database and media live in a unique temporary directory that
is removed afterward. It does not download provider media or change the running
server's configuration.
