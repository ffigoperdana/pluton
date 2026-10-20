import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { upgradeHeld, UPGRADE_PROTOCOL } from "./upgradeGuard.js";
import { createAgentConfig } from "./config.js";
import { runOnce } from "./runtime.js";

test("root installation hold blocks work even if corrupt; deleting only that exact hold releases it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-upgrade-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = createAgentConfig({
    serverUrl: "https://example.invalid",
    binDir: path.join(root, "bin"),
  });
  assert.equal(await upgradeHeld(config), false);
  const hold = path.join(root, UPGRADE_PROTOCOL.holdDirectory);
  await mkdir(hold);
  assert.equal(await upgradeHeld(config), true);
  await rm(hold, { recursive: true });
  await writeFile(hold, "corrupt hold still fails closed");
  assert.equal(await upgradeHeld(config), true);
  await rm(hold);
  assert.equal(await upgradeHeld(config), false);
});

test(
  "Linux runtime holds before identity loading, heartbeat, command polling or Source Access execution",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agent-upgrade-runtime-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = createAgentConfig({
      serverUrl: "https://example.invalid",
      binDir: path.join(root, "bin"),
      dataDir: path.join(root, "absent-state"),
    });
    await mkdir(path.join(root, UPGRADE_PROTOCOL.holdDirectory));
    await runOnce(config); // Would fail loading absent identity or resolving DNS if it did not hold first.
  },
);
