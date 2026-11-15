# Disposable lab image for scripts/validate-agent-s3-probe.py. Synthetic data only.
# An Ubuntu host like a future Agent host (curl, the system CA store, unzip) plus
# the Rclone release the Agent installer pins, checked against the same SHA-256.
ARG BASE_IMAGE=ubuntu:22.04
FROM ${BASE_IMAGE}
ARG RCLONE_VERSION=1.75.1
ARG RCLONE_LINUX_AMD64_SHA256=982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab
RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl openssl unzip \
	&& rm -rf /var/lib/apt/lists/*
RUN set -eu; \
	curl --disable --silent --show-error --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
		--output /tmp/rclone.zip "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-amd64.zip"; \
	printf '%s  %s\n' "${RCLONE_LINUX_AMD64_SHA256}" /tmp/rclone.zip | sha256sum --check --status -; \
	unzip -q /tmp/rclone.zip -d /tmp/rclone; \
	install -d -m 0755 /opt/lab; \
	install -m 0755 "/tmp/rclone/rclone-v${RCLONE_VERSION}-linux-amd64/rclone" /opt/lab/rclone; \
	rm -rf /tmp/rclone /tmp/rclone.zip; \
	/opt/lab/rclone version | head -n 1
# /opt/lab exists already: COPY --chmod would also apply the mode to directories it creates.
COPY --chmod=0755 pki.sh serve-fixture.sh run-probe.sh rclone-recording.sh rclone-cat-fails.sh rclone-cat-interrupted.sh rclone-delete-interrupted.sh /opt/lab/
