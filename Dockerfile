# One image for both services: SERVICE_ROLE=api (default; also serves the two built apps) or SERVICE_ROLE=worker.

FROM node:24-slim AS web
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/field/package.json apps/field/
COPY packages/ui/package.json packages/ui/
COPY packages/api-client/package.json packages/api-client/
COPY packages/config/package.json packages/config/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/web apps/web
COPY apps/field apps/field
RUN pnpm --filter @bide-comply/web build && pnpm --filter @bide-comply/field build

FROM python:3.12-slim
# WeasyPrint (inspection pack PDFs) needs Pango.
RUN apt-get update && apt-get install -y --no-install-recommends libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.12.13 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY apps/api/pyproject.toml apps/api/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY apps/api ./
RUN uv sync --frozen --no-dev
COPY --from=web /repo/apps/web/dist /app/web-dist
COPY --from=web /repo/apps/field/dist /app/field-dist
ENV PATH="/app/.venv/bin:$PATH" WEB_DIST_DIR=/app/web-dist FIELD_DIST_DIR=/app/field-dist
# The app user has no home directory; Fontconfig (WeasyPrint) needs somewhere writable for its font cache.
ENV XDG_CACHE_HOME=/tmp/cache
# Run as an unprivileged user.
RUN useradd --system --uid 10001 app && chown -R app /app
USER app
CMD ["sh", "start.sh"]
