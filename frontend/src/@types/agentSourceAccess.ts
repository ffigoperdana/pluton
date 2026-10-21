export type SourceAccessValidation = {
   requestedPath: string;
   canonicalPath?: string;
   status: 'approved' | 'pending-host-approval' | 'rejected';
   code?: string;
};

export type SourceAuthorizationMode = 'host-approved' | 'server-managed';

export type SourceAccessReport = {
   version: 1;
   hostPolicyRevision: string;
   effectiveVersion: number;
   approvedRoots: string[];
   effectiveRoots: string[];
   rootStatuses: { path: string; status: 'readable' | 'unreadable' | 'missing' | 'rejected'; code?: string }[];
   lastAppliedRequestId?: string;
   policyError?: string;
   receivedAt?: string;
   authorizationMode?: SourceAuthorizationMode;
   delegatedRoots?: string[];
   lastModeSetupRequestId?: string;
};

export type SourceAccessRequest = {
   id: string;
   requestId: string;
   kind: 'validate' | 'apply' | 'mode-setup';
   status: 'queued' | 'validating' | 'validated' | 'pending-host-approval' | 'pending-host-setup' | 'applied' | 'rejected' | 'cancelled';
   requestedMode?: SourceAuthorizationMode;
   setupExpiresAt?: string;
   roots: string[];
   expectedVersion: number;
   expectedHostPolicyRevision: string;
   validation?: SourceAccessValidation[];
   resultCode?: string;
   createdAt: string;
   completedAt?: string | null;
};

export type SourceAccessPlan = { id: string; title: string; isActive: boolean; sourcePath: string };

export type SourceAccessView = {
   supported: boolean;
   online: boolean;
   reportFresh: boolean;
   report?: SourceAccessReport;
   requests: SourceAccessRequest[];
   affectedPlans: SourceAccessPlan[];
   modeSetupSupported?: boolean;
   modeChangePlans?: SourceAccessPlan[];
   modeChangeBlocked?: boolean;
   activeOperationCount?: number;
};

export type SourceAccessPayload = {
   expectedVersion: number;
   expectedHostPolicyRevision: string;
   roots: string[];
   confirmedAffectedPlanIds?: string[];
};

export type SourceAccessAccepted = { requestId: string; status: SourceAccessRequest['status'] };

export type SourceAccessHistoryPage = {
   requests: SourceAccessRequest[];
   total: number;
   pageSize: number;
   cursor: string;
   nextCursor?: string;
};

export type SourceAccessHistoryFilter = { status?: SourceAccessRequest['status']; kind?: SourceAccessRequest['kind'] };

export type SourceModeSetupPayload = SourceAccessPayload & { authorizationMode: SourceAuthorizationMode };
