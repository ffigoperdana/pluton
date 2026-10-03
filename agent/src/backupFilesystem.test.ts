import assert from "node:assert/strict";
import test from "node:test";
import { parseBackupFilesystemPayload } from "./backupFilesystem.js";

const validPayload = {
  version: 1,
  backupId: "backup-01",
  planId: "plan-01",
  sourcePath: "/srv/example-app",
  excludes: [],
  repository: {
    remoteName: "pluton",
    path: "managed-repositories/example",
    initialize: true,
  },
  rclone: {
    type: "sftp",
    options: {
      host: "sftp.example.internal",
      port: "22",
      user: "backup-user",
      pass: "this-is-a-test-only-password-value",
    },
  },
  repositoryPassword: "test-only-repository-password-value",
};

test("accepts the fixed BACKUP_FILESYSTEM envelope", () => {
  const parsed = parseBackupFilesystemPayload(validPayload);
  assert.equal(parsed.sourcePath, "/srv/example-app");
  assert.deepEqual(parsed.rclone.options, validPayload.rclone.options);
});

test("refuses external-SSH and generic-command SFTP options", () => {
  assert.throws(
    () =>
      parseBackupFilesystemPayload({
        ...validPayload,
        rclone: {
          ...validPayload.rclone,
          options: {
            ...validPayload.rclone.options,
            ssh: "ssh -o ProxyCommand=unsafe",
          },
        },
      }),
    /unsupported option/,
  );
});

test("refuses traversal, control characters, and unexpected command fields", () => {
  assert.throws(
    () =>
      parseBackupFilesystemPayload({
        ...validPayload,
        repository: { ...validPayload.repository, path: "managed/../other" },
      }),
    /traversal/,
  );
  assert.throws(
    () =>
      parseBackupFilesystemPayload({
        ...validPayload,
        sourcePath: "/srv/example\u0000app",
      }),
    /invalid/,
  );
  assert.throws(
    () =>
      parseBackupFilesystemPayload({
        ...validPayload,
        arbitraryShell: "never",
      }),
    /unsupported fields/,
  );
});
