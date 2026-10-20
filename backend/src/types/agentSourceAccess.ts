export type SourceAccessRootStatus = {
	path: string;
	status: 'readable' | 'unreadable' | 'missing' | 'rejected';
	code?: string;
};

export type SourceAccessReport = {
	version: 1;
	authorizationMode?: 'host-approved' | 'server-managed';
	delegatedRoots?: string[];
	lastModeSetupRequestId?: string;
	hostPolicyRevision: string;
	effectiveVersion: number;
	approvedRoots: string[];
	effectiveRoots: string[];
	rootStatuses: SourceAccessRootStatus[];
	lastAppliedRequestId?: string;
	policyError?: string;
};

export type SourceAccessValidation = {
	requestedPath: string;
	canonicalPath?: string;
	status: 'approved' | 'pending-host-approval' | 'rejected';
	code?: string;
};

export type SourceAccessRequestStatus =
	| 'queued'
	| 'validating'
	| 'validated'
	| 'pending-host-approval'
	| 'pending-host-setup'
	| 'applied'
	| 'rejected'
	| 'cancelled';

export type SourceAccessRequest = {
	id: string;
	requestId: string;
	kind: 'validate' | 'apply' | 'mode-setup';
	requestedMode?: 'host-approved' | 'server-managed';
	setupExpiresAt?: Date;
	status: SourceAccessRequestStatus;
	roots: string[];
	expectedVersion: number;
	expectedHostPolicyRevision: string;
	validation?: SourceAccessValidation[];
	resultCode?: string;
	createdAt: Date;
	completedAt: Date | null;
};

export type SourceAccessPlan = {
	id: string;
	title: string;
	isActive: boolean;
	sourcePath: string;
};

export type SourceAccessView = {
	supported: boolean;
	modeSetupSupported?: boolean;
	modeChangePlans?: SourceAccessPlan[];
	modeChangeBlocked?: boolean;
	activeOperationCount?: number;
	online: boolean;
	reportFresh: boolean;
	report?: SourceAccessReport & { receivedAt: Date };
	requests: SourceAccessRequest[];
	affectedPlans: SourceAccessPlan[];
};

export type SourceAccessCommandPayload = {
	version: 1;
	requestId: string;
	expectedVersion: number;
	expectedHostPolicyRevision: string;
	roots: string[];
};

export type SourceAccessCommandResult = {
	sourceAccess: SourceAccessReport;
	validation?: SourceAccessValidation[];
	modeSetup?: {
		requestId: string;
		authorizationMode: 'host-approved' | 'server-managed';
		delegatedRoots: string[];
		expiresAt: number;
	};
};
