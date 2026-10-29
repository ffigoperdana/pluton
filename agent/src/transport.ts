import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import type { AgentConfig } from "./types.js";

export class AgentHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class AgentTransportError extends Error {
  constructor(readonly code: "timeout" | "network" | "response-invalid") {
    super(
      code === "timeout"
        ? "Agent request timed out."
        : code === "response-invalid"
          ? "Agent response was invalid or exceeded the safe size limit."
          : "Agent network transport failed.",
    );
    this.name = "AgentTransportError";
  }
}

/** Outbound-only JSON transport. It starts no listener and supports future mTLS material. */
export class AgentTransport {
  private readonly client: typeof http | typeof https;
  private readonly tls: https.RequestOptions;

  constructor(
    private readonly config: AgentConfig,
    private readonly timeoutMs = 10_000,
    private readonly maxResponseBytes = 2 * 1024 * 1024,
  ) {
    this.client = config.serverUrl.protocol === "https:" ? https : http;
    this.tls =
      config.serverUrl.protocol === "https:"
        ? {
            ca: config.caFile ? readFileSync(config.caFile) : undefined,
            cert: config.clientCertFile
              ? readFileSync(config.clientCertFile)
              : undefined,
            key: config.clientKeyFile
              ? readFileSync(config.clientKeyFile)
              : undefined,
            rejectUnauthorized: true,
          }
        : {};
  }

  async post<T>(
    pathname: string,
    body: string,
    headers: Record<string, string> = {},
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const url = new URL(pathname, this.config.serverUrl);
    const response = await new Promise<{ statusCode: number; body: string }>(
      (resolve, reject) => {
        const abort = (error: Error) => {
          clearTimeout(deadline);
          reject(error);
          request.destroy();
        };
        const deadline = setTimeout(
          () => abort(new AgentTransportError("timeout")),
          Math.max(1, Math.min(this.timeoutMs, timeoutMs)),
        );
        const request = this.client.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body).toString(),
              ...headers,
            },
            ...this.tls,
          },
          (res) => {
            let raw = "";
            let received = 0;
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              received += Buffer.byteLength(chunk);
              if (received > this.maxResponseBytes)
                abort(new AgentTransportError("response-invalid"));
              else raw += chunk;
            });
            res.once("error", () => abort(new AgentTransportError("network")));
            res.once("aborted", () =>
              abort(new AgentTransportError("network")),
            );
            res.on("end", () => {
              clearTimeout(deadline);
              resolve({ statusCode: res.statusCode || 0, body: raw });
            });
          },
        );
        request.once("error", () => {
          clearTimeout(deadline);
          reject(new AgentTransportError("network"));
        });
        request.end(body);
      },
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new AgentHttpError(
        response.statusCode,
        "Server rejected the agent request.",
      );
    }
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new AgentTransportError("response-invalid");
    }
  }
}
