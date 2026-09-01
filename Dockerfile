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
WORKDIR /app
ENV NODE_ENV=production API_PORT=3100
COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/packages ./packages
RUN bun install --frozen-lockfile --production
EXPOSE 3100
USER bun
CMD ["bun", "apps/api/src/index.ts"]
