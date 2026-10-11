# syntax=docker/dockerfile:1
FROM oven/bun:1.2 AS build
WORKDIR /app
COPY package.json bun.lock* ./
COPY packages/core/package.json packages/core/
COPY apps/cli/package.json apps/cli/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run --cwd apps/web build

FROM oven/bun:1.2
RUN apt-get update && apt-get install -y --no-install-recommends git git-crypt openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/cli ./apps/cli
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && git config --global --add safe.directory '*'
ENV KB_ROOT=/data/kb DATA_DIR=/data/app WEB_DIST=/app/apps/web/dist PORT=8787
EXPOSE 8787
ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "run", "apps/api/src/main.ts"]
