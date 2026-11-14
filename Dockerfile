# Mediawan v3 for the N100 NAS.
# Debian trixie ships FFmpeg 7.1 (needed for -readrate_initial_burst) built with Intel VPL,
# and the non-free Intel media driver is what lets the N100 encode H.264 with QuickSync.
FROM python:3.13-slim-trixie

RUN sed -i 's/^Components: main$/Components: main non-free non-free-firmware/' \
        /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
        ffmpeg \
        intel-media-va-driver-non-free \
        libvpl2 \
        libmfx-gen1.2 \
        vainfo \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY mediawan ./mediawan
RUN uv sync --frozen --no-dev

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    MEDIAWAN_DB=/data/mediawan.sqlite \
    TRANSCODE_DIR=/transcode \
    LIBRARY_ROOTS=/media \
    LIBVA_DRIVER_NAME=iHD \
    PORT=8787
RUN mkdir -p /data /transcode /media

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(urllib.request.urlopen('http://127.0.0.1:8787/healthz').status != 200)"
CMD ["mediawan"]
