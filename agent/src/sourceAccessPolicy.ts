import path from "node:path";
import os from "node:os";
import {
  createHash,
  createHmac,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import type {
  AgentConfig,
  SourceAccessReport,
  SourceAccessValidation,
  AgentCommandEnvelope,
} from "./types.js";

const MAX_ROOTS = 32;
const MAX_PATH = 1024;
// Roots also occur as epoch-map keys. Keep the bounded on-disk representation
// large enough for all 32 maximum-size UTF-8 roots without truncating bindings.
const MAX_FILE = 256 * 1024;
const POLICY_FILE = "/etc/pluton-agent/source-access.json";
const SELECTION_FILE = "source-access-selection.json";
const ANCHOR_FILE = "source-access-initialized.json";
const TRANSACTION_FILE = "source-access-pending.json";
const MODE_SETUP_FILE = "source-access-mode-setup.json";
const ACTIVITY_FILE = "source-access-activity.json";
const DENIED_ROOTS = new Set([
  "/",
  "/home",
  "/srv",
  "/var",
  "/var/www",
  "/opt",
  "/mnt",
  "/media",
  "/run",
  "/usr",
  "/usr/local",
  "/usr/share",
  "/usr/lib",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/var/lib",
  "/var/log",
  "/var/cache",
  "/tmp",
  "/var/tmp",
  "/run/user",
  "/lost+found",
]);
const DENIED_TREES = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/root",
  "/var/lib/pluton-agent",
  "/opt/pluton-agent",
  "/var/lib/pluton-agent-upgrades",
];

export class SourcePolicyError extends Error {
  constructor(readonly code: string) {
    super(`Source access refused (${code}).`);
  }
}

export function sourcePathWithin(root: string, candidate: string): boolean {
  return (
    candidate === root || candidate.startsWith(root === "/" ? "/" : `${root}/`)
  );
}

/** Linux lexical validation, independent of the server/Agent process platform. */
export function validateSourcePaths(
  value: unknown,
  allowEmpty = false,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ROOTS ||
    (!allowEmpty && !value.length)
  )
    throw new SourcePolicyError("source-request-invalid");
  return value.map((entry) => {
    if (
      typeof entry !== "string" ||
      !entry.startsWith("/") ||
      entry.startsWith("//") ||
      (entry !== "/" && entry.endsWith("/")) ||
      entry.length > MAX_PATH ||
      /[\x00-\x1f\x7f\\,]/.test(entry) ||
      entry.split("/").some((part) => part === "." || part === "..") ||
      path.posix.normalize(entry) !== entry
    )
      throw new SourcePolicyError("source-request-invalid");
    return entry;
  });
}

export function isNewSourceRootAllowed(candidate: string): boolean {
  return (
    !DENIED_ROOTS.has(candidate) &&
    !DENIED_TREES.some((root) => sourcePathWithin(root, candidate))
  );
}

export function assertNonoverlappingRoots(roots: string[]): void {
  for (let i = 0; i < roots.length; i++) {
    if (roots.some((other, j) => j !== i && sourcePathWithin(other, roots[i])))
      throw new SourcePolicyError("source-roots-overlap");
  }
}

type HostApproval = {
  version: 1 | 2;
  agentId: string;
  hostVersion: number;
  roots: string[];
  rootVersions: Record<string, number>;
  authorizationMode?: "host-approved" | "server-managed";
  delegatedRoots?: string[];
  delegatedRootVersions?: Record<string, number>;
  lastModeSetupRequestId?: string;
};
type Selection = {
  version: 1;
  agentId: string;
  effectiveVersion: number;
  requestId: string;
  hostPolicyRevision: string;
  roots: string[];
  hostRootVersions: Record<string, number>;
};
type SourceRequest = {
  version: 1;
  requestId: string;
  expectedVersion: number;
  expectedHostPolicyRevision: string;
  roots: string[];
};
type ModeSetupRequest = SourceRequest & {
  authorizationMode: "host-approved" | "server-managed";
  expiresAt: number;
};

export function sourcePathContainsPrivateDirectory(candidate: string): boolean {
  return candidate
    .split("/")
    .some((part) => [".ssh", ".aws", ".gnupg", ".kube"].includes(part));
}

function modeRequest(value: unknown): ModeSetupRequest {
  const body = object(value);
  const { authorizationMode, expiresAt, ...base } = body;
  const parsed = request(base);
  if (
    !["host-approved", "server-managed"].includes(
      authorizationMode as string,
    ) ||
    !Number.isSafeInteger(expiresAt) ||
    (expiresAt as number) <= Date.now() ||
    (expiresAt as number) > Date.now() + 15 * 60_000 ||
    (authorizationMode === "host-approved"
      ? parsed.roots.length !== 0
      : parsed.roots.length === 0)
  )
    throw new SourcePolicyError("source-mode-setup-invalid");
  assertNonoverlappingRoots(parsed.roots);
  return { ...parsed, authorizationMode, expiresAt } as ModeSetupRequest;
}

function verifySetupSignature(
  secret: string,
  command: AgentCommandEnvelope,
): boolean {
  try {
    const expires = command.leaseExpiresAt
      ? Date.parse(command.leaseExpiresAt)
      : NaN;
    if (!Number.isFinite(expires)) return false;
    const canonical = [
      "command",
      command.signatureTimestamp,
      command.id,
      command.type,
      JSON.stringify(command.payload),
      command.idempotencyKey,
      command.leaseToken,
      expires.toString(),
    ].join("\n");
    const expected = createHmac("sha256", secret).update(canonical).digest();
    const actual = Buffer.from(command.signature, "base64");
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  } catch {
    return false;
  }
}
type Handle = {
  writeFile: (data: string, options: { encoding: "utf8" }) => Promise<void>;
  readFile: (options: { encoding: "utf8" }) => Promise<string>;
  stat: () => Promise<Stats>;
  sync: () => Promise<void>;
  close: () => Promise<void>;
  chmod: (mode: number) => Promise<void>;
  chown: (uid: number, gid: number) => Promise<void>;
};
/** Injectable filesystem for deterministic permission, TOCTOU and crash-boundary tests. */
export type SourcePolicyIO = {
  lstat: (filename: string) => Promise<Stats>;
  realpath: (filename: string) => Promise<string>;
  access: (filename: string, mode: number) => Promise<void>;
  open: (
    filename: string,
    flags: number | string,
    mode?: number,
  ) => Promise<Handle>;
  mkdir: (filename: string, options: { mode: number }) => Promise<unknown>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  unlink: (filename: string) => Promise<void>;
  chmod: (filename: string, mode: number) => Promise<void>;
};
const defaultIO: SourcePolicyIO = fs;
// runOnce creates a policy object on every poll. A storage failure remains
// latched in that process even when persisting its compensating fence fails.
const uncertaintyLatches = new WeakMap<SourcePolicyIO, Set<string>>();
type PolicyContext = {
  config: AgentConfig;
  agentId: string;
  io?: SourcePolicyIO;
  platform?: string;
  uid?: number;
  operatorUid?: number;
  bootClock?: () => Promise<{ bootId: string; uptimeMs: number }>;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SourcePolicyError("source-policy-state-invalid");
  return value as Record<string, unknown>;
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function request(value: unknown): SourceRequest {
  const body = object(value);
  if (
    Object.keys(body).some(
      (key) =>
        ![
          "version",
          "requestId",
          "expectedVersion",
          "expectedHostPolicyRevision",
          "roots",
        ].includes(key),
    ) ||
    body.version !== 1 ||
    typeof body.requestId !== "string" ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(body.requestId) ||
    !Number.isSafeInteger(body.expectedVersion) ||
    (body.expectedVersion as number) < 0 ||
    typeof body.expectedHostPolicyRevision !== "string" ||
    !/^[a-f0-9]{64}$/.test(body.expectedHostPolicyRevision)
  )
    throw new SourcePolicyError("source-request-invalid");
  return {
    ...body,
    roots: validateSourcePaths(body.roots, true),
  } as SourceRequest;
}
function stableIdentity(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs
  );
}
function stableDirectoryIdentity(a: Stats, b: Stats): boolean {
  // File creation inside a running application is not replacement of its root.
  return (
    a.isDirectory() &&
    b.isDirectory() &&
    !a.isSymbolicLink() &&
    !b.isSymbolicLink() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid
  );
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function safeCode(error: unknown): string {
  if (error instanceof SourcePolicyError) return error.code;
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EACCES" || code === "EPERM"
    ? "source-root-not-readable"
    : code === "ENOENT" || code === "ENOTDIR"
      ? "source-missing"
      : "source-policy-unavailable";
}

export class SourceAccessPolicy {
  private readonly io: SourcePolicyIO;
  private readonly uid: number;
  private readonly platform: string;
  private durabilityUncertain = false;
  private hostWriter = false;
  private hostWriteAttempted = false;
  constructor(private readonly context: PolicyContext) {
    this.io = context.io || defaultIO;
    this.uid = context.uid ?? process.getuid?.() ?? -1;
    this.platform = context.platform || process.platform;
  }

  private requireLinux(): void {
    if (this.platform !== "linux")
      throw new SourcePolicyError("source-policy-linux-required");
  }
  private policyFile(): string {
    return this.context.config.sourcePolicyFile || POLICY_FILE;
  }
  private stateFile(): string {
    return path.posix.join(this.context.config.dataDir, SELECTION_FILE);
  }
  private anchorFile(): string {
    return path.posix.join(this.context.config.dataDir, ANCHOR_FILE);
  }
  private transactionFile(): string {
    return path.posix.join(this.context.config.dataDir, TRANSACTION_FILE);
  }
  private modeSetupFile(): string {
    return path.posix.join(this.context.config.dataDir, MODE_SETUP_FILE);
  }
  private activityFile(): string {
    return path.posix.join(this.context.config.dataDir, ACTIVITY_FILE);
  }

  /** Shared by every Agent execution and the local mode writer. A crash leaves an explicit operator-review fence. */
  async withActivity<T>(operation: () => Promise<T>): Promise<T> {
    this.requireLinux();
    if (uncertaintyLatches.get(this.io)?.has(this.latchKey()))
      throw new SourcePolicyError("source-policy-durability-uncertain");
    await this.stateDirectory();
    let marker: Handle;
    let prepared = false;
    const fence = {
      version: 1,
      agentId: this.context.agentId,
      pid: process.pid,
      operationId: randomUUID(),
    };
    try {
      marker = await this.io.open(
        this.activityFile(),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new SourcePolicyError("source-agent-operation-active");
      throw error;
    }
    try {
      if ((this.context.operatorUid ?? process.getuid?.()) === 0) {
        const owner = await this.io.lstat(this.context.config.dataDir);
        await marker.chown(owner.uid, owner.gid);
      }
      await marker.writeFile(JSON.stringify(fence), { encoding: "utf8" });
      await marker.sync();
      await this.syncDirectory(this.context.config.dataDir);
      prepared = true;
      return await operation();
    } finally {
      await marker.close();
      if (prepared) {
        await this.io.unlink(this.activityFile());
        try {
          await this.syncDirectory(this.context.config.dataDir);
        } catch (error) {
          this.latchUncertainty();
          await this.durableWrite(this.activityFile(), fence).catch(
            () => undefined,
          );
          throw error;
        }
      }
    }
  }
  private latchKey(): string {
    return `${this.context.agentId}:${this.context.config.dataDir}`;
  }
  private async bootClock(): Promise<{ bootId: string; uptimeMs: number }> {
    if (this.context.bootClock) return this.context.bootClock();
    const handle = await this.io.open(
      "/proc/sys/kernel/random/boot_id",
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const bootId = (await handle.readFile({ encoding: "utf8" })).trim();
      if (!/^[a-f0-9-]{36}$/.test(bootId))
        throw new SourcePolicyError("source-mode-clock-invalid");
      return { bootId, uptimeMs: Math.floor(os.uptime() * 1000) };
    } finally {
      await handle.close();
    }
  }
  private async checkReceiptClock(
    receipt: Record<string, unknown>,
  ): Promise<void> {
    const clock = await this.bootClock();
    if (
      receipt.bootId !== clock.bootId ||
      !Number.isSafeInteger(receipt.preparedUptimeMs) ||
      !Number.isSafeInteger(receipt.monotonicExpiresAt) ||
      clock.uptimeMs < Number(receipt.preparedUptimeMs) ||
      clock.uptimeMs >= Number(receipt.monotonicExpiresAt)
    )
      throw new SourcePolicyError("source-mode-setup-expired");
  }
  private latchUncertainty(): void {
    this.durabilityUncertain = true;
    let latches = uncertaintyLatches.get(this.io);
    if (!latches) {
      latches = new Set();
      uncertaintyLatches.set(this.io, latches);
    }
    latches.add(this.latchKey());
  }

  /** Every ancestor of a host authority must be immutable to the Agent account. */
  private async rootOwned(filename: string, directory: boolean): Promise<void> {
    let current = filename;
    for (;;) {
      const info = await this.io.lstat(current);
      if (
        info.isSymbolicLink() ||
        info.uid !== 0 ||
        (info.mode & 0o022) !== 0 ||
        (current === filename && !directory
          ? !info.isFile() || info.nlink !== 1
          : !info.isDirectory())
      )
        throw new SourcePolicyError("source-host-policy-not-protected");
      if (current === path.posix.dirname(current)) break;
      current = path.posix.dirname(current);
    }
  }

  private async stateDirectory(): Promise<void> {
    const filename = this.context.config.dataDir;
    const info = await this.io.lstat(filename);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== this.uid ||
      (info.mode & 0o077) !== 0 ||
      (await this.io.realpath(filename)) !== filename
    )
      throw new SourcePolicyError("source-policy-state-invalid");
    let parent = path.posix.dirname(filename);
    for (;;) {
      const ancestor = await this.io.lstat(parent);
      const trustedSticky =
        ancestor.uid === 0 && (ancestor.mode & 0o1000) !== 0;
      if (
        !ancestor.isDirectory() ||
        ancestor.isSymbolicLink() ||
        (ancestor.uid !== 0 && ancestor.uid !== this.uid) ||
        ((ancestor.mode & 0o022) !== 0 && !trustedSticky)
      )
        throw new SourcePolicyError("source-policy-state-invalid");
      if (parent === path.posix.dirname(parent)) break;
      parent = path.posix.dirname(parent);
    }
  }

  private async readJSON(
    filename: string,
    authority: boolean,
  ): Promise<unknown | undefined> {
    let info: Stats;
    try {
      info = await this.io.lstat(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (authority) await this.rootOwned(filename, false);
    else if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== this.uid ||
      (info.mode & 0o077) !== 0
    )
      throw new SourcePolicyError("source-policy-state-invalid");
    if (!info.isFile() || info.size > MAX_FILE)
      throw new SourcePolicyError("source-policy-state-invalid");
    const handle = await this.io.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      if (!stableIdentity(info, await handle.stat()))
        throw new SourcePolicyError("source-policy-changed");
      const raw = await handle.readFile({ encoding: "utf8" });
      if (
        !stableIdentity(info, await handle.stat()) ||
        !stableIdentity(info, await this.io.lstat(filename))
      )
        throw new SourcePolicyError("source-policy-changed");
      return JSON.parse(raw as string);
    } finally {
      await handle.close();
    }
  }

  private async durableWrite(
    filename: string,
    value: unknown,
    mode = 0o600,
  ): Promise<void> {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    let handle: Handle | undefined;
    try {
      handle = await this.io.open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        mode,
      );
      await handle.chmod(mode);
      if (
        path.posix.dirname(filename) === this.context.config.dataDir &&
        (this.context.operatorUid ?? process.getuid?.()) === 0
      ) {
        const owner = await this.io.lstat(this.context.config.dataDir);
        await handle.chown(owner.uid, owner.gid);
      }
      await handle.writeFile(`${JSON.stringify(value)}\n`, {
        encoding: "utf8",
      });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.io.rename(temporary, filename);
      const directory = await this.io.open(
        path.posix.dirname(filename),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      throw new SourcePolicyError("source-policy-durability-uncertain");
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await this.io.unlink(temporary).catch(() => undefined);
    }
  }

  private async canonicalDirectory(filename: string): Promise<string> {
    validateSourcePaths([filename]);
    const canonical = await this.io.realpath(filename);
    validateSourcePaths([canonical]);
    const before = await this.io.lstat(canonical);
    if (!before.isDirectory() || before.isSymbolicLink())
      throw new SourcePolicyError("source-unsupported-type");
    // Explicit Linux service-user access, without scanning or disclosing children.
    let parent = canonical;
    for (;;) {
      await this.io.access(
        parent,
        parent === canonical ? constants.R_OK | constants.X_OK : constants.X_OK,
      );
      if (parent === path.posix.dirname(parent)) break;
      parent = path.posix.dirname(parent);
    }
    if (
      (await this.io.realpath(filename)) !== canonical ||
      (await this.io.realpath(canonical)) !== canonical ||
      !stableDirectoryIdentity(before, await this.io.lstat(canonical))
    )
      throw new SourcePolicyError("source-symlink-changed");
    return canonical;
  }

  private newRootAllowed(candidate: string): boolean {
    const state = this.context.config.dataDir;
    return (
      isNewSourceRootAllowed(candidate) &&
      !sourcePathWithin(state, candidate) &&
      !sourcePathWithin(candidate, state)
    );
  }

  private async hostPolicy(): Promise<{
    revision: string;
    roots: string[];
    host: HostApproval;
    staticRoots: string[];
  }> {
    this.requireLinux();
    if (!this.hostWriter) {
      try {
        await this.io.lstat(
          path.posix.join(
            path.posix.dirname(this.policyFile()),
            ".source-access.lock",
          ),
        );
        throw new SourcePolicyError("source-host-policy-busy");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const staticRoots: string[] = [];
    for (const entry of this.context.config.allowedRoots) {
      validateSourcePaths([entry]);
      // A maximum is a set of literal canonical approvals, not a requirement
      // that every application is currently mounted/readable. Selected paths
      // are resolved individually below; aliases never move this boundary.
      staticRoots.push(entry);
    }
    const value = await this.readJSON(this.policyFile(), true);
    let host: HostApproval = {
      version: 1,
      agentId: this.context.agentId,
      hostVersion: 0,
      roots: [],
      rootVersions: {},
    };
    if (value !== undefined) {
      const body = object(value);
      if (
        Object.keys(body).some(
          (key) =>
            ![
              "version",
              "agentId",
              "hostVersion",
              "roots",
              "rootVersions",
              "authorizationMode",
              "delegatedRoots",
              "delegatedRootVersions",
              "lastModeSetupRequestId",
            ].includes(key),
        ) ||
        ![1, 2].includes(body.version as number) ||
        body.agentId !== this.context.agentId ||
        !positive(body.hostVersion)
      )
        throw new SourcePolicyError("source-host-policy-invalid");
      const approved = validateSourcePaths(body.roots, true);
      assertNonoverlappingRoots(approved);
      if (approved.some((root) => !this.newRootAllowed(root)))
        throw new SourcePolicyError("source-host-policy-invalid");
      const epochs = object(body.rootVersions);
      if (
        Object.keys(epochs).length !== approved.length ||
        approved.some(
          (root) =>
            !Object.hasOwn(epochs, root) ||
            !positive(epochs[root]) ||
            (epochs[root] as number) > (body.hostVersion as number),
        )
      )
        throw new SourcePolicyError("source-host-policy-invalid");
      host = {
        version: body.version as 1 | 2,
        agentId: this.context.agentId,
        hostVersion: body.hostVersion,
        roots: approved,
        rootVersions: epochs as Record<string, number>,
      };
      if (body.version === 2) {
        if (
          !["host-approved", "server-managed"].includes(
            body.authorizationMode as string,
          ) ||
          typeof body.lastModeSetupRequestId !== "string" ||
          !/^[A-Za-z0-9_-]{8,128}$/.test(body.lastModeSetupRequestId)
        )
          throw new SourcePolicyError("source-host-policy-invalid");
        const delegated = validateSourcePaths(body.delegatedRoots, true);
        const delegatedEpochs = object(body.delegatedRootVersions);
        assertNonoverlappingRoots(delegated);
        if (
          (body.authorizationMode === "host-approved" && delegated.length) ||
          (body.authorizationMode === "server-managed" && !delegated.length) ||
          delegated.some(
            (root) =>
              !this.newRootAllowed(root) ||
              sourcePathContainsPrivateDirectory(root),
          ) ||
          Object.keys(delegatedEpochs).length !== delegated.length ||
          delegated.some(
            (root) =>
              !positive(delegatedEpochs[root]) ||
              (delegatedEpochs[root] as number) > (body.hostVersion as number),
          )
        )
          throw new SourcePolicyError("source-host-policy-invalid");
        host = {
          ...host,
          authorizationMode: body.authorizationMode as
            | "host-approved"
            | "server-managed",
          delegatedRoots: delegated,
          delegatedRootVersions: delegatedEpochs as Record<string, number>,
          lastModeSetupRequestId: body.lastModeSetupRequestId,
        };
      } else if (
        body.authorizationMode !== undefined ||
        body.delegatedRoots !== undefined ||
        body.delegatedRootVersions !== undefined ||
        body.lastModeSetupRequestId !== undefined
      )
        throw new SourcePolicyError("source-host-policy-invalid");
    }
    const approvedRoots = [...new Set([...staticRoots, ...host.roots])].sort();
    const roots = [
      ...new Set([
        ...approvedRoots,
        ...(host.authorizationMode === "server-managed"
          ? host.delegatedRoots || []
          : []),
      ]),
    ].sort();
    if (roots.length > MAX_ROOTS)
      throw new SourcePolicyError("source-root-limit");
    return {
      revision: hash([
        this.context.agentId,
        host.hostVersion,
        roots,
        host.rootVersions,
        ...(host.version === 2
          ? [
              host.authorizationMode,
              host.delegatedRoots,
              host.delegatedRootVersions,
              host.lastModeSetupRequestId,
            ]
          : []),
      ]),
      roots,
      host,
      staticRoots: [...new Set(staticRoots)].sort(),
    };
  }

  private async selection(
    staticRoots: string[],
  ): Promise<Selection | undefined> {
    await this.stateDirectory();
    const anchor = await this.readJSON(this.anchorFile(), false);
    const state = await this.readJSON(this.stateFile(), false);
    if (anchor === undefined && state === undefined) return undefined; // untouched static installations
    const marker = object(anchor);
    if (
      marker.version !== 1 ||
      marker.agentId !== this.context.agentId ||
      state === undefined
    )
      throw new SourcePolicyError("source-policy-state-invalid");
    const body = object(state);
    if (
      Object.keys(body).some(
        (key) =>
          ![
            "version",
            "agentId",
            "effectiveVersion",
            "requestId",
            "hostPolicyRevision",
            "roots",
            "hostRootVersions",
          ].includes(key),
      ) ||
      body.version !== 1 ||
      body.agentId !== this.context.agentId ||
      !positive(body.effectiveVersion) ||
      typeof body.requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(body.requestId) ||
      typeof body.hostPolicyRevision !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.hostPolicyRevision)
    )
      throw new SourcePolicyError("source-policy-state-invalid");
    const roots = validateSourcePaths(body.roots, true);
    assertNonoverlappingRoots(roots);
    if (
      roots.some(
        (root) => !isNewSourceRootAllowed(root) && !staticRoots.includes(root),
      )
    )
      throw new SourcePolicyError("source-policy-state-invalid");
    const bindings = object(body.hostRootVersions);
    if (
      Object.keys(bindings).length !== roots.length ||
      roots.some(
        (root) =>
          !Object.hasOwn(bindings, root) ||
          !Number.isSafeInteger(bindings[root]) ||
          (bindings[root] as number) < 0,
      )
    )
      throw new SourcePolicyError("source-policy-state-invalid");
    return { ...body, roots, hostRootVersions: bindings } as Selection;
  }

  private rootEpoch(
    root: string,
    policy: { staticRoots: string[]; host: HostApproval },
  ): number | undefined {
    if (policy.staticRoots.some((parent) => sourcePathWithin(parent, root)))
      return 0;
    const parent = policy.host.roots.find((parent) =>
      sourcePathWithin(parent, root),
    );
    if (parent) return policy.host.rootVersions[parent];
    const delegated =
      policy.host.authorizationMode === "server-managed"
        ? policy.host.delegatedRoots?.find((parent) =>
            sourcePathWithin(parent, root),
          )
        : undefined;
    return delegated
      ? policy.host.delegatedRootVersions?.[delegated]
      : undefined;
  }

  async report(): Promise<SourceAccessReport> {
    const fallback: SourceAccessReport = {
      version: 1,
      authorizationMode: "host-approved",
      delegatedRoots: [],
      hostPolicyRevision: hash([this.context.agentId, "unavailable"]),
      effectiveVersion: 0,
      approvedRoots: [],
      effectiveRoots: [],
      rootStatuses: [],
    };
    try {
      const policy = await this.hostPolicy();
      fallback.hostPolicyRevision = policy.revision;
      fallback.authorizationMode =
        policy.host.authorizationMode || "host-approved";
      fallback.delegatedRoots =
        policy.host.authorizationMode === "server-managed"
          ? policy.host.delegatedRoots || []
          : [];
      fallback.lastModeSetupRequestId = policy.host.lastModeSetupRequestId;
      fallback.approvedRoots = [
        ...new Set([...policy.staticRoots, ...policy.host.roots]),
      ].sort();
      const selected = await this.selection(policy.staticRoots);
      fallback.effectiveVersion = selected?.effectiveVersion || 0;
      fallback.lastAppliedRequestId = selected?.requestId;
      if (
        this.durabilityUncertain ||
        uncertaintyLatches.get(this.io)?.has(this.latchKey()) ||
        (await this.readJSON(this.transactionFile(), false)) !== undefined
      )
        throw new SourcePolicyError("source-policy-durability-uncertain");
      const roots = selected?.roots || policy.staticRoots;
      for (const root of roots) {
        if (
          fallback.authorizationMode === "server-managed" &&
          sourcePathContainsPrivateDirectory(root)
        ) {
          fallback.rootStatuses.push({
            path: root,
            status: "rejected",
            code: "source-sensitive-root",
          });
          continue;
        }
        if (
          !policy.roots.some((approved) => sourcePathWithin(approved, root))
        ) {
          fallback.rootStatuses.push({
            path: root,
            status: "rejected",
            code: "source-host-approval-revoked",
          });
          continue;
        }
        if (
          selected &&
          selected.hostRootVersions[root] !== this.rootEpoch(root, policy)
        ) {
          fallback.rootStatuses.push({
            path: root,
            status: "rejected",
            code: "source-host-approval-changed",
          });
          continue;
        }
        try {
          if ((await this.canonicalDirectory(root)) !== root)
            throw new SourcePolicyError("source-symlink-changed");
          fallback.effectiveRoots.push(root);
          fallback.rootStatuses.push({ path: root, status: "readable" });
        } catch (error) {
          const code = safeCode(error);
          fallback.rootStatuses.push({
            path: root,
            status:
              code === "source-missing"
                ? "missing"
                : code === "source-root-not-readable"
                  ? "unreadable"
                  : "rejected",
            code,
          });
        }
      }
      return fallback;
    } catch (error) {
      return { ...fallback, effectiveRoots: [], policyError: safeCode(error) };
    }
  }

  async validate(payload: unknown): Promise<{
    sourceAccess: SourceAccessReport;
    validation: SourceAccessValidation[];
  }> {
    const input = request(payload);
    const report = await this.report();
    if (
      report.policyError ||
      input.expectedVersion !== report.effectiveVersion ||
      input.expectedHostPolicyRevision !== report.hostPolicyRevision
    )
      throw new SourcePolicyError(report.policyError || "source-policy-stale");
    const validation: SourceAccessValidation[] = [];
    for (const candidate of input.roots) {
      try {
        if (
          (report.authorizationMode === "server-managed" &&
            sourcePathContainsPrivateDirectory(candidate)) ||
          (!this.newRootAllowed(candidate) &&
            !report.approvedRoots.includes(candidate))
        )
          throw new SourcePolicyError("source-sensitive-root");
        const canonical = await this.canonicalDirectory(candidate);
        if (
          (report.authorizationMode === "server-managed" &&
            sourcePathContainsPrivateDirectory(canonical)) ||
          (!this.newRootAllowed(canonical) &&
            !report.approvedRoots.includes(canonical))
        )
          throw new SourcePolicyError("source-sensitive-root");
        const withinMaximum = [
          ...report.approvedRoots,
          ...(report.authorizationMode === "server-managed"
            ? report.delegatedRoots || []
            : []),
        ].some((root) => sourcePathWithin(root, canonical));
        validation.push({
          requestedPath: candidate,
          canonicalPath: canonical,
          status: withinMaximum
            ? "approved"
            : report.authorizationMode === "server-managed"
              ? "rejected"
              : "pending-host-approval",
          ...(!withinMaximum && report.authorizationMode === "server-managed"
            ? { code: "source-outside-delegated-scope" }
            : {}),
        });
      } catch (error) {
        validation.push({
          requestedPath: candidate,
          status: "rejected",
          code: safeCode(error),
        });
      }
    }
    return { sourceAccess: report, validation };
  }

  async apply(
    payload: unknown,
    authorizationStillValid: () => boolean = () => true,
  ): Promise<{
    success: boolean;
    sourceAccess: SourceAccessReport;
    validation: SourceAccessValidation[];
    error?: string;
  }> {
    let input: SourceRequest;
    try {
      input = request(payload);
    } catch (error) {
      return {
        success: false,
        sourceAccess: await this.report(),
        validation: [],
        error: safeCode(error),
      };
    }
    if (!authorizationStillValid())
      return {
        success: false,
        sourceAccess: await this.report(),
        validation: [],
        error: "source-command-lease-expired",
      };
    const current = await this.report();
    if (
      !current.policyError &&
      current.lastAppliedRequestId === input.requestId &&
      current.effectiveVersion === input.expectedVersion + 1
    ) {
      // A durable request is never applied a second time even after command receipt loss.
      try {
        const policy = await this.hostPolicy(),
          previous = await this.selection(policy.staticRoots);
        if (
          previous?.hostPolicyRevision === input.expectedHostPolicyRevision &&
          JSON.stringify(previous.roots) === JSON.stringify(input.roots)
        )
          return { success: true, sourceAccess: current, validation: [] };
      } catch {
        /* Fail closed below. */
      }
    }
    let validation: SourceAccessValidation[] = [];
    try {
      const checked = await this.validate(input);
      validation = checked.validation;
      if (validation.some((item) => item.status !== "approved"))
        throw new SourcePolicyError(
          validation.some((item) => item.status === "pending-host-approval")
            ? "source-host-approval-required"
            : "source-path-rejected",
        );
      const roots = validation.map((item) => item.canonicalPath!);
      if (JSON.stringify(roots) !== JSON.stringify(input.roots))
        throw new SourcePolicyError("source-canonical-path-required");
      assertNonoverlappingRoots(roots);
      if (input.expectedVersion >= Number.MAX_SAFE_INTEGER - 1)
        throw new SourcePolicyError("source-policy-version-exhausted");
      const before = await this.report();
      if (
        before.policyError ||
        before.hostPolicyRevision !== input.expectedHostPolicyRevision ||
        before.effectiveVersion !== input.expectedVersion
      )
        throw new SourcePolicyError("source-policy-stale");
      if (!authorizationStillValid())
        throw new SourcePolicyError("source-command-lease-expired");
      await this.stateDirectory();
      const policy = await this.hostPolicy();
      if (policy.revision !== input.expectedHostPolicyRevision)
        throw new SourcePolicyError("source-policy-stale");
      const hostRootVersions = Object.fromEntries(
        roots.map((root) => {
          const epoch = this.rootEpoch(root, policy);
          if (epoch === undefined)
            throw new SourcePolicyError("source-host-approval-required");
          return [root, epoch];
        }),
      );
      // Exclusive marker is both a writer lock and a crash boundary. There is no
      // automatic reset/reconstruction when a write did not reach durable commit.
      const marker = await this.io.open(
        this.transactionFile(),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await marker.writeFile(
          `${JSON.stringify({
            version: 1,
            agentId: this.context.agentId,
            requestId: input.requestId,
            expectedVersion: input.expectedVersion,
            hostPolicyRevision: input.expectedHostPolicyRevision,
            roots,
          })}\n`,
          { encoding: "utf8" },
        );
        await marker.sync();
      } finally {
        await marker.close();
      }
      await this.syncDirectory(this.context.config.dataDir);
      // Anchor first: missing/replaced state after initialization cannot reset to static access.
      if ((await this.readJSON(this.anchorFile(), false)) === undefined)
        await this.durableWrite(this.anchorFile(), {
          version: 1,
          agentId: this.context.agentId,
        });
      if (!authorizationStillValid())
        throw new SourcePolicyError("source-command-lease-expired");
      await this.durableWrite(this.stateFile(), {
        version: 1,
        agentId: this.context.agentId,
        effectiveVersion: input.expectedVersion + 1,
        requestId: input.requestId,
        hostPolicyRevision: input.expectedHostPolicyRevision,
        roots,
        hostRootVersions,
      } satisfies Selection);
      if (!authorizationStillValid())
        throw new SourcePolicyError("source-command-lease-expired");
      await this.finishTransaction(
        await this.readJSON(this.transactionFile(), false),
      );
      const after = await this.report();
      if (
        after.policyError ||
        after.lastAppliedRequestId !== input.requestId ||
        after.hostPolicyRevision !== input.expectedHostPolicyRevision
      )
        throw new SourcePolicyError("source-policy-changed");
      return { success: true, sourceAccess: after, validation };
    } catch (error) {
      if (safeCode(error) === "source-policy-durability-uncertain")
        this.latchUncertainty();
      return {
        success: false,
        sourceAccess: await this.report(),
        validation,
        error: safeCode(error),
      };
    }
  }

  /** Store only a signed, bounded server drain receipt. This grants no host authority. */
  async prepareModeSetup(
    command: AgentCommandEnvelope,
    secret: string,
  ): Promise<{
    sourceAccess: SourceAccessReport;
    modeSetup: {
      requestId: string;
      authorizationMode: "host-approved" | "server-managed";
      delegatedRoots: string[];
      expiresAt: number;
    };
  }> {
    const input = modeRequest(command.payload);
    if (
      command.type !== "SOURCE_ACCESS_MODE_SETUP" ||
      !verifySetupSignature(secret, command) ||
      !command.leaseExpiresAt ||
      Date.parse(command.leaseExpiresAt) <= Date.now()
    )
      throw new SourcePolicyError("source-mode-setup-invalid");
    const report = await this.report();
    if (
      report.policyError ||
      report.hostPolicyRevision !== input.expectedHostPolicyRevision ||
      report.effectiveVersion !== input.expectedVersion
    )
      throw new SourcePolicyError("source-policy-stale");
    if (new Set([...report.approvedRoots, ...input.roots]).size > MAX_ROOTS)
      throw new SourcePolicyError("source-root-limit");
    for (const root of input.roots)
      if (
        !this.newRootAllowed(root) ||
        sourcePathContainsPrivateDirectory(root) ||
        (await this.canonicalDirectory(root)) !== root
      )
        throw new SourcePolicyError("source-canonical-path-required");
    const existing = await this.readJSON(this.modeSetupFile(), false);
    if (existing !== undefined) {
      const prior = object(existing);
      if (prior.consumedRequestId === input.requestId)
        throw new SourcePolicyError("source-mode-setup-consumed");
      if (prior.command) {
        const oldCommand = prior.command as AgentCommandEnvelope;
        const oldInput = object(oldCommand.payload);
        if (
          oldInput.requestId !== input.requestId &&
          Number(oldInput.expiresAt) > Date.now()
        )
          throw new SourcePolicyError("source-mode-setup-active");
        if (oldInput.requestId === input.requestId) {
          if (JSON.stringify(oldInput) !== JSON.stringify(input))
            throw new SourcePolicyError("source-mode-setup-invalid");
          await this.checkReceiptClock(prior);
          return {
            sourceAccess: report,
            modeSetup: {
              requestId: input.requestId,
              authorizationMode: input.authorizationMode,
              delegatedRoots: input.roots,
              expiresAt: input.expiresAt,
            },
          };
        }
      }
    }
    const clock = await this.bootClock();
    const remaining = input.expiresAt - Date.now();
    if (remaining <= 0 || remaining > 15 * 60_000)
      throw new SourcePolicyError("source-mode-setup-expired");
    await this.durableWrite(this.modeSetupFile(), {
      version: 1,
      agentId: this.context.agentId,
      command,
      bootId: clock.bootId,
      preparedUptimeMs: clock.uptimeMs,
      monotonicExpiresAt: clock.uptimeMs + remaining,
    });
    return {
      sourceAccess: report,
      modeSetup: {
        requestId: input.requestId,
        authorizationMode: input.authorizationMode,
        delegatedRoots: input.roots,
        expiresAt: input.expiresAt,
      },
    };
  }

  /** Local root opt-in consumes an exact server drain receipt before changing the host-controlled maximum. */
  async changeAuthorizationMode(input: {
    agentId: string;
    expectedRevision: string;
    requestId: string;
    authorizationMode: "host-approved" | "server-managed";
    roots: string[];
    secret: string;
    confirmDelegation: boolean;
    confirmDrained: boolean;
  }): Promise<{
    authorizationMode: "host-approved" | "server-managed";
    delegatedRoots: string[];
    hostPolicyRevision: string;
  }> {
    this.requireLinux();
    if (
      (this.context.operatorUid ?? process.getuid?.()) !== 0 ||
      input.agentId !== this.context.agentId
    )
      throw new SourcePolicyError("source-host-operator-required");
    if (
      !input.confirmDrained ||
      (input.authorizationMode === "server-managed" && !input.confirmDelegation)
    )
      throw new SourcePolicyError("source-mode-confirmation-required");
    return this.withHostWriter(() =>
      this.withActivity(async () => {
        const policy = await this.hostPolicy();
        const selected = await this.selection(policy.staticRoots);
        if (
          policy.revision !== input.expectedRevision ||
          (await this.readJSON(this.transactionFile(), false)) !== undefined
        )
          throw new SourcePolicyError("source-policy-stale");
        const receipt = object(
          await this.readJSON(this.modeSetupFile(), false),
        );
        const command = receipt.command as AgentCommandEnvelope;
        if (
          receipt.version !== 1 ||
          receipt.agentId !== input.agentId ||
          receipt.consumedRequestId ||
          !command ||
          command.type !== "SOURCE_ACCESS_MODE_SETUP" ||
          !verifySetupSignature(input.secret, command)
        )
          throw new SourcePolicyError("source-mode-setup-invalid");
        const setup = modeRequest(command.payload);
        await this.checkReceiptClock(receipt);
        if (
          setup.requestId !== input.requestId ||
          setup.authorizationMode !== input.authorizationMode ||
          setup.expectedHostPolicyRevision !== policy.revision ||
          setup.expectedVersion !== (selected?.effectiveVersion || 0) ||
          JSON.stringify(setup.roots) !==
            JSON.stringify(validateSourcePaths(input.roots, true))
        )
          throw new SourcePolicyError("source-mode-setup-invalid");
        for (const root of setup.roots)
          if (
            !this.newRootAllowed(root) ||
            sourcePathContainsPrivateDirectory(root) ||
            (await this.canonicalDirectory(root)) !== root
          )
            throw new SourcePolicyError("source-canonical-path-required");
        if (
          new Set([...policy.staticRoots, ...policy.host.roots, ...setup.roots])
            .size > MAX_ROOTS ||
          policy.host.hostVersion >= Number.MAX_SAFE_INTEGER
        )
          throw new SourcePolicyError("source-root-limit");
        this.hostWriteAttempted = true;
        await this.durableWrite(this.modeSetupFile(), {
          version: 1,
          agentId: input.agentId,
          consumedRequestId: setup.requestId,
        });
        const hostVersion = policy.host.hostVersion + 1;
        await this.durableWrite(
          this.policyFile(),
          {
            ...policy.host,
            version: 2,
            hostVersion,
            authorizationMode: setup.authorizationMode,
            delegatedRoots: setup.roots,
            delegatedRootVersions: Object.fromEntries(
              setup.roots.map((root) => [root, hostVersion]),
            ),
            lastModeSetupRequestId: setup.requestId,
          } satisfies HostApproval,
          0o644,
        );
        const after = await this.hostPolicy();
        return {
          authorizationMode: setup.authorizationMode,
          delegatedRoots: setup.roots,
          hostPolicyRevision: after.revision,
        };
      }),
    );
  }

  /** Root-only local operation. It never changes server identity or the enabled selection. */
  async changeHostApproval(input: {
    action: "approve" | "revoke";
    agentId: string;
    expectedRevision: string;
    roots: string[];
  }): Promise<{ hostPolicyRevision: string; approvedRoots: string[] }> {
    this.requireLinux();
    if (
      (this.context.operatorUid ?? process.getuid?.()) !== 0 ||
      input.agentId !== this.context.agentId
    )
      throw new SourcePolicyError("source-host-operator-required");
    return this.withHostWriter(async () => {
      const policy = await this.hostPolicy();
      if (policy.revision !== input.expectedRevision)
        throw new SourcePolicyError("source-policy-stale");
      const candidates = validateSourcePaths(input.roots);
      const canonical: string[] = [];
      for (const root of candidates) {
        if (
          !this.newRootAllowed(root) ||
          (input.action === "approve" &&
            (await this.canonicalDirectory(root)) !== root)
        )
          throw new SourcePolicyError("source-canonical-path-required");
        canonical.push(root);
      }
      assertNonoverlappingRoots(canonical);
      let roots: string[];
      const rootVersions: Record<string, number> = {};
      if (input.action === "approve") {
        roots = [...new Set([...policy.host.roots, ...canonical])].sort();
        assertNonoverlappingRoots(roots);
        if (
          canonical.some((root) =>
            policy.staticRoots.some((parent) => sourcePathWithin(parent, root)),
          )
        )
          throw new SourcePolicyError("source-already-host-approved");
      } else {
        if (canonical.some((root) => !policy.host.roots.includes(root)))
          throw new SourcePolicyError(
            "source-static-root-requires-local-config",
          );
        roots = policy.host.roots.filter((root) => !canonical.includes(root));
      }
      for (const root of roots)
        rootVersions[root] =
          policy.host.rootVersions[root] || policy.host.hostVersion + 1;
      if (
        roots.length + policy.staticRoots.length > MAX_ROOTS ||
        policy.host.hostVersion >= Number.MAX_SAFE_INTEGER
      )
        throw new SourcePolicyError("source-root-limit");
      this.hostWriteAttempted = true;
      await this.durableWrite(
        this.policyFile(),
        {
          ...policy.host,
          agentId: this.context.agentId,
          hostVersion: policy.host.hostVersion + 1,
          roots,
          rootVersions,
        } satisfies HostApproval,
        0o644,
      );
      const after = await this.hostPolicy();
      return {
        hostPolicyRevision: after.revision,
        approvedRoots: [
          ...new Set([...after.staticRoots, ...after.host.roots]),
        ].sort(),
      };
    });
  }

  private async withHostWriter<T>(operation: () => Promise<T>): Promise<T> {
    const directory = path.posix.dirname(this.policyFile());
    try {
      await this.rootOwned(directory, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.rootOwned(path.posix.dirname(directory), true);
      await this.io.mkdir(directory, { mode: 0o755 });
      await this.io.chmod(directory, 0o755);
      await this.rootOwned(directory, true);
      await this.syncDirectory(path.posix.dirname(directory));
    }
    const lockPath = path.posix.join(directory, ".source-access.lock");
    let lock: Handle;
    try {
      lock = await this.io.open(
        lockPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new SourcePolicyError("source-host-policy-busy");
      throw error;
    }
    let succeeded = false,
      prepared = false;
    const marker = {
      version: 1,
      agentId: this.context.agentId,
      pid: process.pid,
      operationId: randomUUID(),
    };
    this.hostWriter = true;
    this.hostWriteAttempted = false;
    try {
      await lock.writeFile(`${JSON.stringify(marker)}\n`, { encoding: "utf8" });
      await lock.sync();
      await this.syncDirectory(directory);
      prepared = true;
      const result = await operation();
      succeeded = true;
      return result;
    } finally {
      this.hostWriter = false;
      await lock.close();
      // An interrupted/uncertain host write fences reports as well as writers.
      // Input rejection before mutation may release its own lock normally.
      if (succeeded || (prepared && !this.hostWriteAttempted)) {
        await this.io.unlink(lockPath);
        try {
          await this.syncDirectory(directory);
        } catch (error) {
          try {
            await this.durableWrite(lockPath, marker);
          } catch {
            /* Broken storage requires operator review. */
          }
          throw error;
        }
      }
    }
  }

  private async finishTransaction(fence: unknown): Promise<void> {
    await this.io.unlink(this.transactionFile());
    try {
      await this.syncDirectory(this.context.config.dataDir);
    } catch (error) {
      this.latchUncertainty();
      // Selection was durable before unlink. Restore its exact fence before
      // reporting failure; a later poll/process must not mistake cached unlink
      // visibility for a confirmed commit. A broken-storage failure also stays
      // latched across policy objects in the running Agent process.
      try {
        await this.durableWrite(this.transactionFile(), fence);
      } catch {
        /* Operator recovery is mandatory; never grant from this latch. */
      }
      throw error;
    }
  }

  private async syncDirectory(filename: string): Promise<void> {
    try {
      const handle = await this.io.open(
        filename,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      throw new SourcePolicyError("source-policy-durability-uncertain");
    }
  }

  /** Explicit local operator recovery only; cannot create or widen a selection. */
  async recoverSelection(input: {
    agentId: string;
    expectedRevision: string;
    requestId: string;
  }): Promise<void> {
    this.requireLinux();
    if (
      (this.context.operatorUid ?? process.getuid?.()) !== 0 ||
      input.agentId !== this.context.agentId
    )
      throw new SourcePolicyError("source-host-operator-required");
    const policy = await this.hostPolicy();
    if (policy.revision !== input.expectedRevision)
      throw new SourcePolicyError("source-policy-stale");
    const marker = object(await this.readJSON(this.transactionFile(), false));
    const selected = await this.selection(policy.staticRoots);
    if (
      marker.version !== 1 ||
      marker.agentId !== this.context.agentId ||
      marker.requestId !== input.requestId ||
      !selected ||
      selected.requestId !== input.requestId ||
      selected.effectiveVersion !== Number(marker.expectedVersion) + 1 ||
      selected.hostPolicyRevision !== policy.revision ||
      JSON.stringify(selected.roots) !== JSON.stringify(marker.roots) ||
      selected.roots.some(
        (root) =>
          selected.hostRootVersions[root] !== this.rootEpoch(root, policy) ||
          !policy.roots.some((approved) => sourcePathWithin(approved, root)),
      )
    )
      throw new SourcePolicyError("source-policy-recovery-review-required");
    for (const root of selected.roots)
      if ((await this.canonicalDirectory(root)) !== root)
        throw new SourcePolicyError("source-symlink-changed");
    for (const filename of [this.anchorFile(), this.stateFile()]) {
      const handle = await this.io.open(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await this.syncDirectory(this.context.config.dataDir);
    await this.finishTransaction(marker);
    this.durabilityUncertain = false;
    uncertaintyLatches.get(this.io)?.delete(this.latchKey());
  }
}

/** Parse only installer-style EnvironmentFile literals; never source/evaluate shell text. */
export function parseSourceAccessEnvironment(raw: string): {
  dataDir: string;
  allowedRoots: string[];
  sourcePolicyFile?: string;
} {
  if (Buffer.byteLength(raw) > MAX_FILE)
    throw new SourcePolicyError("source-host-config-invalid");
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const entry =
      /^(PLUTON_AGENT_(?:DATA_DIR|ALLOWED_ROOTS|SOURCE_POLICY_FILE))=(.*)$/.exec(
        line.trim(),
      );
    if (!entry) continue;
    if (values[entry[1]] !== undefined)
      throw new SourcePolicyError("source-host-config-invalid");
    const value = entry[2];
    if (value.startsWith('"')) {
      if (!/^"(?:[^"\\]|\\["\\])*"$/.test(value))
        throw new SourcePolicyError("source-host-config-invalid");
      values[entry[1]] = value.slice(1, -1).replace(/\\(["\\])/g, "$1");
    } else {
      if (/[\s'"\\]/.test(value))
        throw new SourcePolicyError("source-host-config-invalid");
      values[entry[1]] = value;
    }
  }
  const dataDir = values.PLUTON_AGENT_DATA_DIR || "/var/lib/pluton-agent";
  validateSourcePaths([dataDir]);
  const allowedRoots = (values.PLUTON_AGENT_ALLOWED_ROOTS || "")
    .split(",")
    .filter(Boolean);
  validateSourcePaths(allowedRoots, true);
  const sourcePolicyFile = values.PLUTON_AGENT_SOURCE_POLICY_FILE;
  if (sourcePolicyFile) validateSourcePaths([sourcePolicyFile]);
  return { dataDir, allowedRoots, sourcePolicyFile };
}

/** Public helper only for the local CLI: immutable root-owned config read. */
export async function readSourceAccessEnvironment(
  filename: string,
): Promise<ReturnType<typeof parseSourceAccessEnvironment>> {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new SourcePolicyError("source-host-operator-required");
  validateSourcePaths([filename]);
  let current = filename;
  for (;;) {
    const info = await fs.lstat(current);
    if (
      info.uid !== 0 ||
      (info.mode & 0o022) !== 0 ||
      info.isSymbolicLink() ||
      (current === filename
        ? !info.isFile() || info.size > MAX_FILE
        : !info.isDirectory())
    )
      throw new SourcePolicyError("source-host-config-not-protected");
    if (current === path.posix.dirname(current)) break;
    current = path.posix.dirname(current);
  }
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    return parseSourceAccessEnvironment(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}
