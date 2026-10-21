export type AgentCommandType =
  | "PING"
  | "INVENTORY_REFRESH"
  | "BACKUP_FILESYSTEM"
  | "SOURCE_ACCESS_VALIDATE"
  | "SOURCE_ACCESS_APPLY"
  | "SOURCE_ACCESS_MODE_SETUP";

export type SourceAccessValidation = {
  requestedPath: string;
  canonicalPath?: string;
  status: "approved" | "pending-host-approval" | "rejected";
  code?: string;
};

export type SourceAccessReport = {
  version: 1;
  authorizationMode?: "host-approved" | "server-managed";
  delegatedRoots?: string[];
  lastModeSetupRequestId?: string;
  hostPolicyRevision: string;
  effectiveVersion: number;
  approvedRoots: string[];
  effectiveRoots: string[];
  rootStatuses: {
    path: string;
    status: "readable" | "unreadable" | "missing" | "rejected";
    code?: string;
  }[];
  lastAppliedRequestId?: string;
  policyError?: string;
};

export type AgentCapabilities = {
  backupExclusionsVersion?: 1;
  filesystemRootsConfigured: boolean;
  commandTypes: AgentCommandType[];
  backupLifecycleVersion?: 1 | 2;
  databaseEngines?: ("mysql" | "mariadb" | "postgresql")[];
  hooksConfigured?: boolean;
  sourceAccessVersion?: 1;
  sourceAccessModesVersion?: 1;
};

export type AgentInventory = {
  hostname: string;
  os: string;
  architecture: string;
  agentVersion: string;
  resticVersion?: string;
  rcloneVersion?: string;
  uptimeSeconds?: number;
  capabilities: AgentCapabilities;
  sourceAccess?: SourceAccessReport;
};

export type StoredCommandCompletion = {
  commandId: string;
  sequence: number;
  success: boolean;
  error?: string;
  /** Closed, non-secret diagnostics for BACKUP_FILESYSTEM failures. */
  failureStage?: string;
  failureCode?: string;
  databaseId?: string;
  engine?: "mysql" | "mariadb" | "postgresql";
  /** A bounded, non-secret execution result such as a Restic snapshot ID. */
  result?: Record<string, unknown>;
  cancelled?: boolean;
};

export type StoredAgentIdentity = {
  deviceId: string;
  agentId: string;
  secret: string;
  pollIntervalSeconds: number;
  completedCommands: StoredCommandCompletion[];
};

export type AgentConfig = {
  serverUrl: URL;
  dataDir: string;
  allowedRoots: string[];
  /** Private installer-owned binaries. Never resolve Restic/Rclone from host PATH. */
  binDir?: string;
  /** Administrator-only local configuration; never supplied by a command. */
  hookRoot?: string;
  databaseBinDirs?: string[];
  /** Local administrator-owned maximum. Never accepted from a server command. */
  sourcePolicyFile?: string;
  allowInsecureHttp: boolean;
  caFile?: string;
  clientCertFile?: string;
  clientKeyFile?: string;
};

export type AgentCommandEnvelope = {
  id: string;
  type: AgentCommandType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  leaseExpiresAt: string | null;
  leaseToken: string;
  signatureTimestamp: string;
  signature: string;
};
