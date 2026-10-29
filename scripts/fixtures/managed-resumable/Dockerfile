# Disposable test image; never an application, Agent or production deployment.
ARG FIXTURE_BASE=pluton-symlink-native:local
FROM minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727 AS mc
FROM ${FIXTURE_BASE}
USER 0
COPY --from=mc /usr/bin/mc /usr/local/bin/mc
RUN apk add --no-cache openssl curl && npm install --global pnpm@10.20.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY agent/package.json agent/package.json
COPY documentation/package.json documentation/package.json
ENV CI=true
RUN pnpm install --frozen-lockfile --filter @plutonhq/core-backend --ignore-scripts && pnpm --filter @plutonhq/core-backend rebuild better-sqlite3
USER 1000:1000
