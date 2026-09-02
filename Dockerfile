# Single-image deployment: Hono API serves the built SPA from apps/web/dist.
FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/adapter/package.json packages/adapter/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4-slim AS runtime
ARG VERSION=0.1.0
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
# Set explicitly: otherwise source / revision / created are inherited from the oven/bun base image.
LABEL org.opencontainers.image.title="tsmyadmin" \
      org.opencontainers.image.description="MySQL / PostgreSQL web administration (phpMyAdmin-style)" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/ip-san/tsmyadmin" \
      org.opencontainers.image.url="https://github.com/ip-san/tsmyadmin" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production API_PORT=3100
COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/packages ./packages
# --ignore-scripts: the root "prepare" script installs husky, a dev-only tool that is absent in production.
RUN bun install --frozen-lockfile --production --ignore-scripts
# Session store (SESSION_STORE=sqlite, the production default) lives here; mount a volume to keep logins across restarts.
RUN mkdir -p /app/data && chown bun:bun /app/data
VOLUME ["/app/data"]
EXPOSE 3100
USER bun
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["bun", "-e", "fetch('http://127.0.0.1:3100/readyz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["bun", "apps/api/src/index.ts"]
