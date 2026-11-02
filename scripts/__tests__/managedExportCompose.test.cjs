const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const compose = fs.readFileSync(path.join(root, "deploy/compose.yml"), "utf8");
const policy = fs.readFileSync(
  path.join(root, "backend/src/utils/managedExport/ExportPolicy.ts"),
  "utf8",
);
test("every runtime export environment variable is explicitly forwarded, disabled by default", () => {
  const keys = [
    ...new Set(
      [
        ...policy.matchAll(/(?:env|process\.env)\.(MANAGED_EXPORT_[A-Z_]+)/g),
      ].map((m) => m[1]),
    ),
  ];
  assert.equal(keys.length, 13);
  assert.match(compose, /MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE: "\$\{MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE:-false\}"/);
  for (const key of keys) assert(compose.includes(`${key}: "\${${key}:-`), key);
  assert.match(
    compose,
    /MANAGED_EXPORT_ENABLED: "\$\{MANAGED_EXPORT_ENABLED:-false\}"/,
  );
  assert(!compose.includes("MANAGED_EXPORT_CA_HOST_FILE:"));
  assert(!compose.includes("MANAGED_EXPORT_KEYRING_HOST_FILE:"));
  assert.match(compose, /MANAGED_EXPORT_MODE: "\$\{MANAGED_EXPORT_MODE:-auto\}"/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\s+- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert(!/MANAGED_EXPORT_ENABLED:\s*["']?true/.test(compose));
});
test("application encryption mounts only an explicitly selected private keyring read-only", () => {
  const overlay = fs.readFileSync(path.join(root, "deploy/compose.managed-export-keys.yml"), "utf8");
  assert.match(overlay, /MANAGED_EXPORT_KEYRING_FILE: \/run\/secrets\/pluton-managed-export-keyring\.json/);
  assert.match(overlay, /target: \/run\/secrets\/pluton-managed-export-keyring\.json/);
  assert.match(overlay, /read_only: true/);
  assert.match(overlay, /create_host_path: false/);
  assert(!/privileged:|cap_add:|network_mode:|user:|depends_on:|docker\.sock/.test(overlay));
  assert(!compose.includes("target: /run/secrets/pluton-managed-export-keyring.json"));
});
test("the native application key volume is separate from the S3 TLS lab and mounted read-only", () => {
  const runner = fs.readFileSync(path.join(root, "scripts/validate-managed-resumable.ps1"), "utf8");
  const s3 = runner.slice(runner.indexOf('$minioArguments=@('), runner.indexOf('foreach($entry in $minioEnvironment)'));
  assert(s3.includes('source=$lab,target=/lab,readonly'));
  assert(!s3.includes('source=$keys'));
  assert(runner.includes('source=$keys,target=/run/pluton-export-keys,readonly'));
  assert(!runner.includes('/lab/keys/keyring.json'));
});
test("private CA is an explicit optional single read-only file, with no host directory creation", () => {
  const overlay = fs.readFileSync(
    path.join(root, "deploy/compose.managed-export-ca.yml"),
    "utf8",
  );
  assert.match(
    overlay,
    /MANAGED_EXPORT_CA_FILE: \/run\/secrets\/pluton-managed-export-ca\.pem/,
  );
  assert.match(
    overlay,
    /target: \/run\/secrets\/pluton-managed-export-ca\.pem/,
  );
  assert.match(overlay, /read_only: true/);
  assert.match(overlay, /create_host_path: false/);
  assert(
    !/privileged:|cap_add:|network_mode:|user:|depends_on:|docker\.sock/.test(
      overlay,
    ),
  );
  assert(!compose.includes("pluton-managed-export-ca.pem")); // base-only needs no certificate
});
