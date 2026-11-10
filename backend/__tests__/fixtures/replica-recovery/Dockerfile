# Test-only development dependencies on the reviewed runtime; never publish/deploy.
ARG BUILD_IMAGE=pluton-replica-build:local
ARG RUNTIME_IMAGE=pluton-recovery-ci:local
FROM ${BUILD_IMAGE} AS dependencies
FROM ${RUNTIME_IMAGE}
USER root
COPY --from=dependencies --chown=1000:1000 /workspace/node_modules /app/node_modules
COPY --from=dependencies --chown=1000:1000 /workspace/backend/node_modules /app/backend/node_modules
USER 1000:1000
