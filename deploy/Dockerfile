# syntax=docker/dockerfile:1
# Keep in step with the local Bun (`bun --version`): bun.lock's format follows the Bun that wrote it.
ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY package.json bun.lock* ./
COPY packages/core/package.json packages/core/
COPY apps/cli/package.json apps/cli/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/collector/package.json apps/collector/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run --cwd apps/web build
# Bundle the API and the kb CLI into single files: the runtime image then needs no node_modules.
# LanceDB (~1 GB with its optional deps) stays external: it is only dynamic-imported for embeddings, which are off in the pod (KB_EMBED=off).
RUN bun build apps/api/src/main.ts --target=bun --external @lancedb/lancedb --outfile dist/api.js \
 && bun build apps/cli/src/main.ts --target=bun --external @lancedb/lancedb --outfile dist/kb.js

FROM oven/bun:${BUN_VERSION}-slim
RUN apt-get update && apt-get install -y --no-install-recommends git git-crypt openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/dist/api.js /app/dist/kb.js ./
COPY --from=build /app/apps/web/dist ./web
COPY deploy/entrypoint.sh /entrypoint.sh
# `kb` on PATH for `kubectl exec ... kb <cmd>`
RUN chmod +x /entrypoint.sh && git config --global --add safe.directory '*' \
 && printf '#!/bin/sh\nexec bun /app/kb.js "$@"\n' > /usr/local/bin/kb && chmod +x /usr/local/bin/kb
ENV KB_ROOT=/data/kb DATA_DIR=/data/app WEB_DIST=/app/web PORT=8787 KB_EMBED=off NODE_ENV=production
EXPOSE 8787
ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "/app/api.js"]
