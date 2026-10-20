import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createAgentConfig } from "./config.js";
import { saveIdentity } from "./identity.js";
import { SourceAccessPolicy } from "./sourceAccessPolicy.js";
import { runOnce } from "./runtime.js";
import type { AgentCommandEnvelope } from "./types.js";

const linux =
  process.platform === "linux" && process.getuid?.() !== 0 ? test : test.skip;
linux(
  "real unprivileged Linux runtime signs/leases bounded policy commands; durable receipt loss and stale replay never re-enable roots",
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "source-access-runtime-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = path.join(root, "source"),
      dataDir = path.join(root, "state");
    await mkdir(source);
    const secret = "synthetic-agent-protocol-secret";
    await saveIdentity(dataDir, {
      agentId: "agent-01",
      deviceId: "app-01",
      secret,
      pollIntervalSeconds: 5,
      completedCommands: [],
    });
    const completions: {
      success: boolean;
      result?: {
        sourceAccess?: { effectiveVersion: number; effectiveRoots: string[] };
      };
    }[] = [];
    let command: AgentCommandEnvelope | undefined;
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url?.endsWith("/complete")) completions.push(JSON.parse(raw));
        res.end(
          JSON.stringify({
            success: true,
            result: req.url === "/api/agent/poll" ? { command } : {},
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const config = createAgentConfig({
      serverUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
      dataDir,
      allowedRoots: source,
      allowInsecureHttp: true,
      sourcePolicyFile: path.join(root, "absent-local-host-policy.json"),
    });
    const initial = await new SourceAccessPolicy({
      config,
      agentId: "agent-01",
    }).report();
    assert.equal(initial.policyError, undefined);
    const payload = {
      version: 1,
      requestId: "explicit_request_0001",
      expectedVersion: 0,
      expectedHostPolicyRevision: initial.hostPolicyRevision,
      roots: [] as string[],
    };
    const setCommand = (id: string, body = payload) => {
      const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
      const signatureTimestamp = Date.now().toString(),
        leaseToken = "lease-token-for-source-policy-0001";
      const canonical = [
        "command",
        signatureTimestamp,
        id,
        "SOURCE_ACCESS_APPLY",
        JSON.stringify(body),
        id,
        leaseToken,
        Date.parse(leaseExpiresAt).toString(),
      ].join("\n");
      command = {
        id,
        type: "SOURCE_ACCESS_APPLY",
        payload: body,
        idempotencyKey: id,
        leaseExpiresAt,
        leaseToken,
        signatureTimestamp,
        signature: crypto
          .createHmac("sha256", secret)
          .update(canonical)
          .digest("base64"),
      };
    };
    setCommand("command_0001");
    await runOnce(config);
    assert.equal(completions[0].success, true);
    assert.deepEqual(completions[0].result?.sourceAccess?.effectiveRoots, []);
    // A new mailbox/command with the identical explicit request cannot create v2.
    setCommand("command_0002");
    await runOnce(config);
    assert.equal(completions[1].success, true);
    assert.equal(completions[1].result?.sourceAccess?.effectiveVersion, 1);
    setCommand("command_0003", {
      ...payload,
      requestId: "different_request_0002",
      roots: [source],
    });
    await runOnce(config);
    assert.equal(completions[2].success, false);
    const final = await new SourceAccessPolicy({
      config,
      agentId: "agent-01",
    }).report();
    assert.equal(final.effectiveVersion, 1);
    assert.deepEqual(final.effectiveRoots, []);
    const identity = JSON.parse(
      await readFile(path.join(dataDir, "identity.json"), "utf8"),
    );
    assert.equal(identity.agentId, "agent-01");
    assert.equal(identity.deviceId, "app-01");
    assert.equal(identity.secret, secret);
  },
);
