import crypto from "node:crypto";
import { AgentOperationError } from "./errors.js";
import {
  AgentTransport,
  AgentHttpError,
  AgentTransportError,
} from "./transport.js";
import { CommandStatusError, type CommandStatusCode } from "./commandStatus.js";
import { signRequest, verifyCommandDetailed } from "./protocol.js";
import type {
  AgentCommandEnvelope,
  AgentConfig,
  AgentInventory,
  StoredAgentIdentity,
} from "./types.js";

type ApiResponse<T> = { success: boolean; result: T; error?: string };

export class AgentClient {
  private readonly transport: AgentTransport;
  private readonly statusInFlight = new Map<
    string,
    Promise<{ cancelled: boolean }>
  >();
  private readonly leaseDeadlines = new Map<string, number>();

  constructor(
    private readonly config: AgentConfig,
    private readonly identity?: StoredAgentIdentity,
    transport?: AgentTransport,
  ) {
    this.transport = transport || new AgentTransport(config);
  }

  async enroll(
    token: string,
    inventory: AgentInventory,
  ): Promise<{
    deviceId: string;
    agentId: string;
    secret: string;
    pollIntervalSeconds: number;
  }> {
    return this.postUnsigned("/api/agent/enroll", { token, inventory });
  }

  async heartbeat(inventory: AgentInventory): Promise<void> {
    await this.postSigned("/api/agent/heartbeat", inventory);
  }

  async poll(): Promise<AgentCommandEnvelope | null> {
    const result = await this.postSigned<{
      command: AgentCommandEnvelope | null;
    }>("/api/agent/poll", {});
    if (!result.command) return null;
    if (!this.identity) {
      throw new AgentOperationError(
        "verify-command",
        "agent identity is unavailable",
      );
    }
    const verification = verifyCommandDetailed(
      this.identity.secret,
      result.command,
    );
    if (!verification.valid) {
      throw new AgentOperationError("verify-command", verification.reason);
    }
    this.leaseDeadlines.set(
      result.command.id,
      Date.parse(result.command.leaseExpiresAt || ""),
    );
    return result.command;
  }

  async acknowledge(commandId: string, leaseToken: string): Promise<void> {
    await this.postSigned(
      `/api/agent/commands/${encodeURIComponent(commandId)}/ack`,
      { leaseToken },
    );
  }

  async event(
    commandId: string,
    leaseToken: string,
    sequence: number,
    event?: Record<string, unknown>,
  ): Promise<void> {
    await this.postSigned(
      `/api/agent/commands/${encodeURIComponent(commandId)}/events`,
      {
        leaseToken,
        sequence,
        ...(event ? { event } : {}),
      },
    );
  }

  async complete(
    commandId: string,
    leaseToken: string,
    completion: {
      sequence: number;
      success: boolean;
      error?: string;
      failureStage?: string;
      failureCode?: string;
      databaseId?: string;
      engine?: "mysql" | "mariadb" | "postgresql";
      result?: Record<string, unknown>;
      cancelled?: boolean;
    },
  ): Promise<void> {
    const {
      sequence,
      success,
      error,
      failureStage,
      failureCode,
      databaseId,
      engine,
      result,
      cancelled,
    } = completion;
    await this.postSigned(
      `/api/agent/commands/${encodeURIComponent(commandId)}/complete`,
      {
        leaseToken,
        sequence,
        success,
        ...(error ? { error } : {}),
        ...(failureStage ? { failureStage } : {}),
        ...(failureCode ? { failureCode } : {}),
        ...(databaseId ? { databaseId, engine } : {}),
        ...(result ? { result } : {}),
        ...(cancelled ? { cancelled: true } : {}),
      },
    );
  }

  commandStatus(
    commandId: string,
    leaseToken: string,
  ): Promise<{ cancelled: boolean }> {
    const key = commandId + ":" + leaseToken;
    const pending = this.statusInFlight.get(key);
    if (pending) return pending;
    const check = this.readCommandStatus(commandId, leaseToken).finally(() =>
      this.statusInFlight.delete(key),
    );
    this.statusInFlight.set(key, check);
    return check;
  }

  private async readCommandStatus(
    commandId: string,
    leaseToken: string,
  ): Promise<{ cancelled: boolean }> {
    // Three attempts maximum; total 15s and the known authorization deadline are
    // hard ceilings. Each retry gets a fresh signed nonce. Never retry a refusal.
    const budget = Date.now() + 15_000;
    for (let attempt = 0; attempt < 3; attempt++) {
      const lease = this.leaseDeadlines.get(commandId);
      if (
        lease !== undefined &&
        (!Number.isFinite(lease) || lease <= Date.now())
      )
        throw new CommandStatusError("command-lease-unavailable");
      const timeout = Math.min(
        5000,
        budget - Date.now(),
        (lease ?? Infinity) - Date.now(),
      );
      if (timeout <= 0) throw new CommandStatusError("control-plane-timeout");
      const started = Date.now();
      try {
        const result = await this.postSigned<unknown>(
          `/api/agent/commands/${encodeURIComponent(commandId)}/status`,
          { leaseToken },
          timeout,
        );
        if (
          !result ||
          typeof result !== "object" ||
          Array.isArray(result) ||
          typeof (result as { cancelled?: unknown }).cancelled !== "boolean"
        )
          throw new CommandStatusError("control-plane-response-invalid");
        const status = result as {
          cancelled: boolean;
          leaseExpiresAt?: unknown;
        };
        if (
          !status.cancelled &&
          status.leaseExpiresAt !== undefined &&
          (typeof status.leaseExpiresAt !== "string" ||
            !Number.isFinite(Date.parse(status.leaseExpiresAt)) ||
            Date.parse(status.leaseExpiresAt) <= Date.now())
        )
          throw new CommandStatusError("command-lease-unavailable");
        // Older servers return only cancelled. Their established renewal is 60s;
        // use request START, never receive time, as the conservative lower bound.
        this.leaseDeadlines.set(
          commandId,
          status.leaseExpiresAt
            ? Date.parse(status.leaseExpiresAt as string)
            : Math.floor(started / 1000) * 1000 + 60_000,
        );
        return { cancelled: status.cancelled };
      } catch (error) {
        const code: CommandStatusCode =
          error instanceof CommandStatusError
            ? error.code
            : error instanceof AgentHttpError
              ? error.statusCode === 429
                ? "control-plane-rate-limited"
                : error.statusCode >= 500 && error.statusCode <= 599
                  ? "control-plane-unavailable"
                  : [401, 403].includes(error.statusCode)
                    ? "command-authorization-rejected"
                    : [404, 409, 410].includes(error.statusCode)
                      ? "command-lease-unavailable"
                      : "control-plane-response-invalid"
              : error instanceof AgentTransportError
                ? error.code === "timeout"
                  ? "control-plane-timeout"
                  : error.code === "network"
                    ? "control-plane-network-failed"
                    : "control-plane-response-invalid"
                : "control-plane-unexpected";
        if (
          attempt === 2 ||
          ![
            "control-plane-rate-limited",
            "control-plane-unavailable",
            "control-plane-timeout",
            "control-plane-network-failed",
          ].includes(code)
        )
          throw new CommandStatusError(code);
        const delay = attempt === 0 ? 250 : 750;
        if (Date.now() + delay >= Math.min(budget, lease ?? Infinity))
          throw new CommandStatusError(code);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new CommandStatusError("control-plane-unexpected");
  }

  private async postUnsigned<T>(
    pathname: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const raw = JSON.stringify(body);
    const response = await this.transport.post<ApiResponse<T>>(pathname, raw);
    if (!response.success)
      throw new Error(response.error || "Server rejected the agent request.");
    return response.result;
  }

  private async postSigned<T>(
    pathname: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.identity)
      throw new Error("Agent identity is required. Enroll this agent first.");
    const raw = JSON.stringify(body);
    const timestamp = Date.now().toString();
    const nonce = crypto.randomBytes(24).toString("base64url");
    const signature = signRequest(
      this.identity.secret,
      timestamp,
      nonce,
      "POST",
      pathname,
      raw,
    );
    const response = await this.transport.post<ApiResponse<T>>(
      pathname,
      raw,
      {
        "x-pluton-agent-id": this.identity.agentId,
        "x-pluton-agent-timestamp": timestamp,
        "x-pluton-agent-nonce": nonce,
        "x-pluton-agent-signature": signature,
      },
      timeoutMs,
    );
    if (!response || response.success !== true)
      throw new AgentTransportError("response-invalid");
    return response.result;
  }
}
