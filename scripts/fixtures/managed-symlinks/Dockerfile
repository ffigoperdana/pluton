# Test-only derivative of the existing local Restic/Rclone/tsx fixture image.
# Never published or used as a production application/Agent image.
ARG FIXTURE_BASE=pluton-phase5-real-db:local
FROM ${FIXTURE_BASE}
USER 0
RUN apk add --no-cache tar && tar --version | head -1
USER 1000:1000
