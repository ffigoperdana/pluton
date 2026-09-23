# Container deployment

This deployment path builds one production Node container that serves the
frontend and backend together. GitHub Actions builds it from public source,
tests it, and publishes it to GitHub Container Registry (GHCR). A Linux VM
only needs Docker Engine, the Docker Compose plugin, the small files in
deploy/, a persistent Docker volume, and a VM-local .env file. It does not
need Git, Node.js, pnpm, TypeScript, or build tools.

The GHCR production image is published for linux/amd64 only, matching the
current x86_64/AMD64 VM deployment target. ARM64 images are not published by
this deployment workflow.

This document applies to the public community fork. It does not change the
read-only guarantees for imported Restic repositories or enable any new backup
operation.

## Image build and release flow

Dockerfile.source is the reproducible source build used by
.github/workflows/container.yml. It installs the pnpm version pinned in
package.json, builds the frontend before the backend, keeps only production
dependencies in the runtime image, and copies pinned Restic and Rclone binaries
from their official versioned container images. The runtime runs as an
unprivileged user, stores all mutable application files under /data, and checks
/api/health.

The existing top-level Dockerfile is retained for the separate release-asset
pipeline that consumes pre-built executable bundles. New VM deployments should
use the GHCR image produced from Dockerfile.source and deploy/compose.yml.
The existing root docker-compose.yml remains for that release-asset path and
now requires an explicit PLUTON_VERSION; it is not the hardened GHCR deployment
configuration described here.

The container workflow has these behaviors:

| Event | Validation | Container result |
| --- | --- | --- |
| Pull request | install, backend lint/tests, both type checks, production builds, whitespace check, and a Docker build | no registry login and no image push |
| Push to main | the same validation | publishes the moving main tag and a commit SHA tag to GHCR |
| Push of vX.Y.Z or a prerelease vX.Y.Z-name | the same validation | publishes both the original v-prefixed tag and the unprefixed version alias |

The workflow uses ghcr.io followed by the GitHub repository context, so no
personal GitHub owner is embedded in source. Published images receive OCI
source, revision, version, and creation labels. Package write permission exists
only on the publishing job.

The frontend ESLint configuration currently has an upstream flat-config
compatibility error. The workflow records that command as a clearly named
non-blocking baseline step; it does not hide or globally disable linting.

Before merging this work, a repository owner must confirm that GitHub Actions
has permission to write packages, choose the GHCR package visibility and pull
access policy, and protect the main branch and release tags. A private package
requires a VM operator to run docker login ghcr.io before the first pull. No
long-lived registry credential is required for the Actions publish job because
it uses the workflow GITHUB_TOKEN.

## Fresh Linux VM install

Install Docker Engine and the Docker Compose plugin using the VM distribution's
normal administration process. The scripts deliberately do not install operating
system packages. The VM needs outbound access to GHCR and, for a new key,
openssl.

Copy the tracked deploy/ directory to the VM by a release artifact, SCP, or
another approved transfer method. The deployment itself does not require a Git
checkout. Configure the VM-local file before the first start:

~~~sh
sudo install -d -m 750 /opt/pluton
sudo cp deploy/.env.example /opt/pluton/.env
sudo chmod 600 /opt/pluton/.env
sudoedit /opt/pluton/.env
~~~

Set PLUTON_IMAGE to the lower-case GHCR repository for this fork, set a strong
USER_PASSWORD, and set APP_URL to the external URL when applicable. Keep
PLUTON_VERSION as the release tag that will be installed. Do not put an actual
password, encryption key, registry token, or production host name in a tracked
file.

Run the installer with an explicit release tag:

~~~sh
sudo sh deploy/install.sh v0.1.0-alpha.1 /opt/pluton
~~~

On a new installation, install.sh copies the deployment files, keeps an
existing .env unchanged, writes a randomly generated ENCRYPTION_KEY only when
the target Docker volume does not already exist, pulls the requested image, and
waits for its health check. It refuses to replace a missing key when a matching
volume already exists. This prevents an accidental key rotation from making
encrypted credentials or repositories unusable.

The application persists SQLite, its WAL sidecars, configuration, logs,
rclone.conf, schedules, and keys.json in the named /data volume. The external
ENCRYPTION_KEY stays in /opt/pluton/.env. Recreating the container therefore
does not discard the database or generated session/API secrets.

## Update, pinning, and rollback

Update with a specific release tag:

~~~sh
sudo sh /opt/pluton/deploy.sh v0.1.0-alpha.2
~~~

deploy.sh validates the tag before using it, pulls it before stopping the
current container, stores the previous image reference, stops the service
gracefully, copies the stopped SQLite database and WAL sidecars to
/opt/pluton/backups/, recreates the container, and waits for /api/health. It
does not remove the previous image. If the new container is unhealthy, it
restores the previous image reference and verifies it before returning failure.

For a digest pin, pass the digest instead of a tag:

~~~sh
sudo sh /opt/pluton/deploy.sh sha256:replace-with-a-64-character-image-digest
~~~

This records an image reference in the form
ghcr.io/owner/repository@sha256:..., which Compose pulls exactly. Production
deployments must use a release tag or digest. The scripts reject latest and
main because both are moving references.

To roll back the image selected by the last successful update:

~~~sh
sudo sh /opt/pluton/rollback.sh
~~~

Rollback preserves the Docker volume and .env. It does not reverse SQLite
migrations, so an older image may be incompatible with a newer database. The
same health check protects the operation: an unhealthy rollback is returned to
the currently recorded image. Restore a database copy only through a separately
reviewed recovery procedure; the deployment scripts never overwrite application
data automatically.

## Verify and troubleshoot

Check the rendered Compose configuration before starting:

~~~sh
sudo docker compose --project-directory /opt/pluton --env-file /opt/pluton/.env -f /opt/pluton/compose.yml config
~~~

Check service health and the public health endpoint:

~~~sh
sudo docker compose --project-directory /opt/pluton --env-file /opt/pluton/.env -f /opt/pluton/compose.yml ps
sudo docker compose --project-directory /opt/pluton --env-file /opt/pluton/.env -f /opt/pluton/compose.yml exec pluton wget -qO- http://127.0.0.1:5173/api/health
~~~

Inspect non-secret image metadata when diagnosing a release:

~~~sh
docker image inspect ghcr.io/owner/repository:v0.1.0-alpha.1 --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
~~~

Do not paste .env contents into issue reports or CI logs. The deployment compose
file has no privileged mode, Docker socket mount, host source mount, or
capability grant; it exposes only the application port and mounts only the
named data volume. Add host paths for backup sources only after reviewing their
read/write requirements and use read-only mounts where possible.

Use the usual repository security checks before a release, including a secret
scanner such as Gitleaks on source changes and an image vulnerability scanner
such as Trivy or Docker Scout on the exact image digest. Verify that the
published GHCR package access policy matches the intended audience.
