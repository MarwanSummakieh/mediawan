FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY public ./public
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY server.mjs ./
COPY scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=build /app/public ./public
RUN mkdir -p /data /media/library /runtime && chown -R node:node /data /media /runtime /app
ENV MEDIAWAN_DB=/data/mediawan-v2.sqlite LIBRARY_DIR=/media/library TRANSCODE_DIR=/runtime
ARG APP_REVISION
ENV APP_REVISION=$APP_REVISION
USER node
EXPOSE 8787 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
