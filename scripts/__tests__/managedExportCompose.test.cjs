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
  assert.equal(keys.length, 11);
  assert.match(compose, /MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE: "\$\{MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE:-false\}"/);
  for (const key of keys) assert(compose.includes(`${key}: "\${${key}:-`), key);
  assert.match(
    compose,
    /MANAGED_EXPORT_ENABLED: "\$\{MANAGED_EXPORT_ENABLED:-false\}"/,
  );
  assert(!compose.includes("MANAGED_EXPORT_CA_HOST_FILE:"));
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\s+- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert(!/MANAGED_EXPORT_ENABLED:\s*["']?true/.test(compose));
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
