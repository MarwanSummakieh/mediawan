# Mediawan production image. Node 22 for the built-in SQLite driver.
#
# Debian, not Alpine, and the reason is QuickSync. The app transcodes locally on
# the NAS so LAN clients can be served untouched remuxes while remote clients
# get a bitrate-capped encode that fits the tunnel. That needs a working VA-API
# stack (intel-media-va-driver + libva), which Debian packages coherently and
# Alpine does not. Getting this wrong is not a build failure — it is a SILENT
# fall back to libx264, which an N100 cannot sustain in real time, so remote
# viewers get stuttering video and nothing logs an error. Check with `vainfo`.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# ffmpeg + Intel VA-API. `vainfo` is installed deliberately: it is the one
# command that answers "is QuickSync actually available inside this container",
# and you want it there when the answer turns out to be no.
#
# The Intel driver lives in Debian's `non-free` component, which this base image
# does not enable — only `main` — so installing it unconditionally fails the
# build with "has no installation candidate". The extra sources line fixes that.
#
# The driver is then installed BEST-EFFORT, with a fallback and a warning. It is
# an optimisation, not a dependency: without it ffmpeg falls back to libx264 and
# the app still runs (slowly, and the startup banner says so). A missing
# accelerator should degrade transcoding, never block a deploy.
#
# The components are added by EDITING the image's existing source definition,
# not by dropping in a second one. A separate classic .list file names the same
# repository without a Signed-By key, and apt refuses the pair outright:
#   "Conflicting values set for option Signed-By regarding source
#    http://deb.debian.org/debian/ bookworm"
# Debian 12 images use the deb822 format (debian.sources); the fallback covers
# an older base that still uses a classic sources.list.
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's/^Components:.*/Components: main contrib non-free non-free-firmware/' \
        /etc/apt/sources.list.d/debian.sources; \
    else \
      sed -i 's/ main\b/ main contrib non-free non-free-firmware/' /etc/apt/sources.list; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends ffmpeg libva2 libva-drm2 vainfo; \
    (apt-get install -y --no-install-recommends intel-media-va-driver-non-free \
      || apt-get install -y --no-install-recommends intel-media-va-driver \
      || echo 'WARNING: no Intel VA-API driver installed — QuickSync will be unavailable and transcoding will fall back to software (an N100 cannot sustain that in real time)'); \
    rm -rf /var/lib/apt/lists/*

# Pin the driver rather than letting libva probe for it.
ENV LIBVA_DRIVER_NAME=iHD

# Install only production deps against the lockfile.
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# The Chromium-69 bundle for old Samsung TVs is generated on the HOST — esbuild
# is a devDependency and this image installs production deps only — so it rides
# in via the COPY above. Warn rather than fail: it's TV-only, and a missing
# bundle shouldn't block a deploy. (See tizen/README.md.)
RUN test -f public/tv-build/app.js || \
    echo "WARNING: public/tv-build missing — run 'npm run build:tv' before docker build or old Samsung TVs will boot to a black screen"

# /data holds the SQLite file; /media holds the source cache. The cache is
# bind-mounted to the array in compose — it grows to terabytes and must not sit
# in a Docker-managed volume.
#
# NOTE: this chown only covers the case where these paths are NOT bind-mounted.
# A bind mount overlays the path entirely, and the HOST directory's ownership is
# what the container sees — so on a real deployment the host dirs must be owned
# by uid 1000. Get that wrong and the app dies at startup with
# "unable to open database file", which looks like a missing file and is really
# a permission denial. scripts/nas-preflight.sh sets this up.
RUN mkdir -p /data /media/cache && chown -R node:node /data /media /app
ENV DB_PATH=/data/data.sqlite
ENV CACHE_DIR=/media/cache

# `video`/`render` own /dev/dri on the host; the compose file adds the node user
# to those groups, otherwise the device is passed through but unopenable.
USER node

# 8787 = tunnel (remote, transcoded). 8788 = LAN (local, full quality).
EXPOSE 8787 8788

# Container healthcheck hits the app's own /healthz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "server.mjs"]
