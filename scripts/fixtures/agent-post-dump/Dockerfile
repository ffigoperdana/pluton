# Disposable local test image only. Oracle MySQL client remains unchanged.
ARG TOOL_IMAGE=pluton-phase5-real-db:local
ARG CLIENT_IMAGE=pluton-mysql-startup-fixed:local
FROM ${TOOL_IMAGE} AS tools
FROM ${CLIENT_IMAGE}
USER 0
COPY --from=tools /usr/local/bin/restic /usr/local/bin/restic
COPY --from=tools /usr/local/bin/rclone /usr/local/bin/rclone
USER 10001:10001
