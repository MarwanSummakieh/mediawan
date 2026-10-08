# NAS downloader and encoder

For the current v2 installation's automatic release updates, see
[NAS automatic updates](nas-auto-updates.md). Its NAS-local updater checks every
five minutes and retains image rollback. The Watchtower instructions below
describe the older update setup.

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

For automatic updates, the active UGOS project must use
`ghcr.io/marwansummakieh/mediawan:latest` for `web`, with the web service's
`com.centurylinklabs.watchtower.enable` label set to `"true"`. Apply edits by
redeploying the project so the running container receives the new label.
The repository also sets `pull_policy: always` explicitly for Compose deployments.
Watchtower must also be running and able to access GHCR and the Docker socket.
Preserve the other services, environment, mounts, and GPU permissions.

The initial pipeline rollout pinned a tested image by digest and set that label
to `"false"`. That policy intentionally stops automatic updates. To resume them,
restore `:latest` and the `"true"` label in the active project; editing this
repository's compose file alone does not change the NAS project.

UGOS distinguishes configuration **Redeploy** from image **Update**. Enable
**Docker → Management → Update detection**, then use the project's **Update**
action when it reports newer images. This updates the project's images; see the
[UGREEN Project guide](https://support.ugnas.com/detail/article/en-US/411).

To download only the app image explicitly, use **Docker → Image → Local → New
Image → From package source → By Image Name**, enter
`ghcr.io/marwansummakieh/mediawan:latest`, complete the download, and redeploy
the project; see the
[UGREEN Image guide](https://support.ugnas.com/detail/article/en-US/290).

Alternatively, force a registry pull and recreate only `web` from the NAS project
directory:

```sh
docker compose -f docker-compose.yaml up -d --no-deps --pull always --force-recreate web
```

For a deliberately fixed release, use the tested registry digest and the
`"false"` label until you advance the release manually.

For rollback, restore the backed-up compose content in the project editor and
redeploy. The backup uses the previous registry image policy; restoring it also
restores automatic updates. Data and media stay in their existing bind mounts.

## Verification

`/healthz` reports the running package `version` and Git `revision` for newly
published images. Compare the revision with the merged commit and the image
digest in the GitHub Actions deployment summary. Publishing an image does not
prove that the NAS has pulled and restarted it. The package version is release
metadata; Watchtower detects a changed image digest behind `:latest`.

If `:latest` and the label are correct but updates do not arrive, inspect the
Watchtower container logs. For Docker API errors, compare its configured
`DOCKER_API_VERSION` with the supported range from `docker version` on the NAS.
Do not blindly raise or remove the API override.

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
