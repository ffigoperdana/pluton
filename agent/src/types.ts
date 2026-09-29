export type AgentCommandType = 'PING' | 'INVENTORY_REFRESH';

export type AgentCapabilities = {
	filesystemRootsConfigured: boolean;
	commandTypes: AgentCommandType[];
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
};

export type StoredCommandCompletion = {
	commandId: string;
	sequence: number;
	success: boolean;
	error?: string;
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
