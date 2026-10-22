"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { verifyRuntime, verifyNodeRuntime } = require("../verify-runtime-release-boundaries.cjs");
const root = path.resolve(__dirname, "../..");
test("runtime gate refuses an unpatched or different Node release", () => {
  assert.doesNotThrow(() => verifyNodeRuntime("v24.22.1"));
  for (const version of ["v24.16.0", "v22.18.0", "v24.22.0", "v25.0.0"])
    assert.throws(() => verifyNodeRuntime(version), /Patched Server runtime/);
});

test("all source image stages and Server CI use the reviewed security release", () => {
  const app = fs.readFileSync(path.join(root, "Dockerfile.source"), "utf8");
  assert.match(app, /^ARG NODE_IMAGE=node:24\.22\.1-alpine3\.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53$/m);
  assert.deepEqual([...app.matchAll(/^FROM \$\{NODE_IMAGE\} AS (.+)$/gm)].map(m => m[1]),
    ["build", "production-dependencies", "production"]);
  assert.match(app.split("USER pluton")[1], /RUN test "\$\(node --version\)" = v24\.22\.1/);
  const worker = fs.readFileSync(path.join(root, "Dockerfile.mysql-recovery-worker"), "utf8");
  assert.equal((worker.match(/^FROM node:24\.22\.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS (?:build|production)\r?$/gm) || []).length, 2);
  assert.match(worker, /RUN test "\$\(node --version\)" = v24\.22\.1 && node \.\/verify\.mjs/);
  for (const name of ["ci-backend", "container", "release-assets", "release-please"]) {
    const workflow = fs.readFileSync(path.join(root, `.github/workflows/${name}.yml`), "utf8");
    const versions = [...workflow.matchAll(/node-version: "([^"]+)"/g)].map(m => m[1]);
    assert(versions.length > 0);
    assert(versions.every(v => v === "24.22.1"));
  }
});

function fixture(t) {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "pluton-release-test-"),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true }));
  for (const name of [
    "backend/dist",
    "backend/public",
    "drizzle",
    "node_modules",
  ])
    fs.mkdirSync(path.join(temporary, name), { recursive: true });
  fs.writeFileSync(path.join(temporary, "LICENSE"), "Apache-2.0");
  fs.writeFileSync(path.join(temporary, "backend/dist/index.js"), "export {};");
  fs.writeFileSync(
    path.join(temporary, "drizzle/0015_reviewed.sql"),
    "CREATE TABLE example(id TEXT);",
  );
  return temporary;
}
test("release accepts compiled app, public UI and intended SQL migrations", (t) => {
  assert.equal(verifyRuntime(fixture(t)), 2);
});
test("release rejects fixture, local state, credential-file and developer-path payloads", (t) => {
  const temporary = fixture(t);
  for (const name of [
    "backend/public/.env",
    "backend/public/synthetic.sql",
    "backend/dist/local.db",
    "backend/dist/private.key",
    "backend/dist/automatic-recovery-vm-debug.cjs",
  ]) {
    const file = path.join(temporary, name);
    fs.writeFileSync(file, "not production data");
    assert.throws(() => verifyRuntime(temporary));
    fs.unlinkSync(file);
  }
  const file = path.join(temporary, "backend/dist/debug.js");
  for (const value of [
    "C:/Users/example/.ssh/key",
    "C:\\laragon\\www\\example",
    "/srv/pluton-fixture/lifecycle-lab-" + "a".repeat(32),
    "fixture_admin",
  ]) {
    fs.writeFileSync(file, value);
    assert.throws(() => verifyRuntime(temporary));
  }
});
test("CI hard-gates frontend interaction tests and non-root read-only runtime artifact verification", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/container.yml"),
    "utf8",
  );
  const frontend = workflow
    .split(
      "- name: Test frontend state, polling, accessibility and recovery regressions",
    )[1]
    .split("- name:")[0];
  assert.match(
    frontend,
    /node --experimental-strip-types --test frontend\/__tests__\/\*\.test\.ts/,
  );
  assert.doesNotMatch(frontend, /continue-on-error/);
  assert.match(workflow, /automaticRecoveryRequests\.test\.cjs/);
  const artifact = workflow
    .split(
      "- name: Verify release excludes test fixtures, host operators and local state",
    )[1]
    .split("- name:")[0];
  assert.match(artifact, /--network none --read-only --user 10001:10001/);
  assert.match(
    artifact,
    /--cap-drop ALL --security-opt no-new-privileges:true/,
  );
  assert.match(
    artifact,
    /--memory 256m --memory-swap 256m --cpus 1 --pids-limit 32/,
  );
  assert.match(artifact, /verify-runtime-release-boundaries\.cjs/);
  assert.doesNotMatch(artifact, /continue-on-error|docker\.sock|--privileged/);
  assert.match(
    fs.readFileSync(path.join(root, ".dockerignore"), "utf8"),
    /^scripts\/automatic-recovery-vm-\*$/m,
  );
});
