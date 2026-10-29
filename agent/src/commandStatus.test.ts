import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { AgentClient } from "./client.js";
import { AgentTransport, AgentHttpError } from "./transport.js";
import { CommandStatusError } from "./commandStatus.js";
import { toBackupFilesystemError } from "./backupFilesystem.js";
import { ProgressDelivery } from "./progressDelivery.js";
import type { AgentConfig } from "./types.js";

const identity = {
  agentId: "agent-01",
  deviceId: "device-01",
  secret: "synthetic-test-identity",
  pollIntervalSeconds: 5,
  completedCommands: [],
};
const config: AgentConfig = {
  serverUrl: new URL("http://127.0.0.1"),
  dataDir: "unused",
  allowedRoots: [],
  allowInsecureHttp: true,
};
for (const [status, code] of [
  [429, "control-plane-rate-limited"],
  [502, "control-plane-unavailable"],
  [503, "control-plane-unavailable"],
  [401, "command-authorization-rejected"],
  [403, "command-authorization-rejected"],
  [404, "command-lease-unavailable"],
  [409, "command-lease-unavailable"],
] as const)
  test(`status HTTP ${status} is bounded and classified without provider text`, async () => {
    let calls = 0;
    const nonces = new Set();
    const client = new AgentClient(config, identity, {
      post: async (_path: string, _body: string, headers: any) => {
        calls++;
        assert(!nonces.has(headers["x-pluton-agent-nonce"]));
        nonces.add(headers["x-pluton-agent-nonce"]);
        throw new AgentHttpError(status, "synthetic-private-provider-text");
      },
    } as unknown as AgentTransport);
    await assert.rejects(
      client.commandStatus("command-01", "a".repeat(32)),
      (error: any) => {
        assert(error instanceof CommandStatusError);
        assert.equal(error.code, code);
        assert(!error.message.includes("synthetic-private-provider-text"));
        return true;
      },
    );
    assert.equal(calls, [429, 502, 503].includes(status) ? 3 : 1);
  });
test("single-flight status checks retry transient failure and accept older boolean-only responses", async () => {
  let calls = 0;
  const client = new AgentClient(config, identity, {
    post: async () => {
      if (++calls === 1) throw new AgentHttpError(503, "private");
      return { success: true, result: { cancelled: false } };
    },
  } as unknown as AgentTransport);
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: 20 }, () =>
        client.commandStatus("command-01", "a".repeat(32)),
      ),
    ),
    Array(20).fill({ cancelled: false }),
  );
  assert.equal(calls, 2);
  assert.equal(
    (client as any).leaseDeadlines.get("command-01") % 1000,
    0,
    "Legacy renewal respects SQLite second precision.",
  );
  await client.commandStatus("command-01", "a".repeat(32));
  assert.equal(
    calls,
    3,
    "Settled results are never cached across the post-dump boundary.",
  );
});
for (const [result, expected] of [
  [{ cancelled: true }, undefined],
  [{ cancelled: "false" }, "control-plane-response-invalid"],
  [{}, "control-plane-response-invalid"],
  [null, "control-plane-response-invalid"],
  [
    { cancelled: false, leaseExpiresAt: new Date(0).toISOString() },
    "command-lease-unavailable",
  ],
] as const)
  test(`strict status result ${JSON.stringify(result)}`, async () => {
    let calls = 0;
    const client = new AgentClient(config, identity, {
      post: async () => {
        calls++;
        return { success: true, result };
      },
    } as unknown as AgentTransport);
    if (expected)
      await assert.rejects(client.commandStatus("command-01", "a".repeat(32)), {
        code: expected,
      });
    else
      assert.deepEqual(
        await client.commandStatus("command-01", "a".repeat(32)),
        { cancelled: true },
      );
    assert.equal(calls, 1);
  });
test("expired local lease is refused before an outbound call", async () => {
  let calls = 0;
  const client = new AgentClient(config, identity, {
    post: async () => {
      calls++;
      throw new Error("private");
    },
  } as unknown as AgentTransport);
  (client as any).leaseDeadlines.set("command-01", Date.now() - 1);
  await assert.rejects(client.commandStatus("command-01", "a".repeat(32)), {
    code: "command-lease-unavailable",
  });
  assert.equal(calls, 0);
});
for (const fault of [
  "timeout",
  "network",
  "invalid-json",
  "invalid-envelope",
] as const)
  test(`real transport ${fault} is classified and bounded`, async () => {
    let calls = 0;
    const server = http.createServer((req, res) => {
      calls++;
      req.resume();
      if (fault === "timeout") return;
      if (fault === "network") {
        req.socket.destroy();
        return;
      }
      res.writeHead(200);
      res.end(
        fault === "invalid-json"
          ? "{"
          : JSON.stringify({ success: false, error: "private provider text" }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const local = {
      ...config,
      serverUrl: new URL(`http://127.0.0.1:${(server.address() as any).port}`),
    };
    try {
      await assert.rejects(
        new AgentClient(
          local,
          identity,
          new AgentTransport(local, 25),
        ).commandStatus("command-01", "a".repeat(32)),
        {
          code:
            fault === "timeout"
              ? "control-plane-timeout"
              : fault === "network"
                ? "control-plane-network-failed"
                : "control-plane-response-invalid",
        },
      );
      assert.equal(calls, ["timeout", "network"].includes(fault) ? 3 : 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
test("control-plane exceptions identify the check, not a completed dump; unknown application exceptions remain closed", async () => {
  const failure = new CommandStatusError("control-plane-unavailable");
  assert.equal(
    toBackupFilesystemError(failure, "post-dump-status-check").stage,
    "post-dump-status-check",
  );
  assert.equal(
    toBackupFilesystemError(failure, "database-dump").stage,
    "command-status-check",
  );
  const client = new AgentClient(config, identity, {
    post: async () => {
      throw new Error("synthetic private provider details");
    },
  } as unknown as AgentTransport);
  await assert.rejects(client.commandStatus("command-01", "a".repeat(32)), {
    code: "control-plane-unexpected",
  });
});
test("fast event bursts are throttled/coalesced and a throwing diagnostic callback cannot fail flush", async () => {
  const times: number[] = [],
    sent: any[] = [];
  const delivery = new ProgressDelivery(
    async (event) => {
      times.push(Date.now());
      sent.push(event);
      throw new Error("private");
    },
    () => {
      throw new Error("diagnostics failed");
    },
    30,
  );
  delivery.enqueue({ phase: "start" });
  await new Promise((r) => setTimeout(r, 5));
  for (let n = 0; n < 100; n++) {
    delivery.enqueue({ phase: "running", progress: { bytesProcessed: n } });
    await Promise.resolve();
  }
  await delivery.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].progress.bytesProcessed, 99);
  assert(times[1] - times[0] >= 29);
});
