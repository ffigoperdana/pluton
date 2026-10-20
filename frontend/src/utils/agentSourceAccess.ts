import type {
   SourceAccessPlan,
   SourceAccessReport,
   SourceAccessRequest,
   SourceAccessValidation,
   SourceAccessView,
} from '../@types/agentSourceAccess.ts';

const broadRoots = new Set([
   '/',
   '/home',
   '/srv',
   '/var',
   '/var/www',
   '/opt',
   '/mnt',
   '/media',
   '/run',
   '/usr',
   '/usr/local',
   '/usr/share',
   '/usr/lib',
   '/bin',
   '/sbin',
   '/lib',
   '/lib64',
   '/var/lib',
   '/var/log',
   '/var/cache',
   '/tmp',
   '/var/tmp',
   '/run/user',
   '/lost+found',
]);
const protectedRoots = [
   '/etc',
   '/proc',
   '/sys',
   '/dev',
   '/boot',
   '/root',
   '/var/lib/pluton-agent',
   '/var/lib/pluton-agent-upgrades',
   '/opt/pluton-agent',
];

/** Early input feedback only. The server and agent independently enforce policy. */
export function sourcePathError(value: string, allowExistingRoot = false): string | undefined {
   if (
      !value.startsWith('/') ||
      value.includes('//') ||
      value.length > 1024 ||
      /[\\,]/.test(value) ||
      Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
   )
      return 'Enter an absolute Linux path without control characters, commas or backslashes (maximum 1024 characters).';
   if (value.split('/').some((part) => part === '..' || part === '.')) return 'Use an absolute path without . or .. components.';
   const normalized = value.replace(/\/+$/, '') || '/';
   if (!allowExistingRoot && value.split('/').some((part) => ['.ssh', '.aws', '.gnupg', '.kube'].includes(part)))
      return 'Credential and private key directories cannot be requested or delegated.';
   if (!allowExistingRoot && (broadRoots.has(normalized) || protectedRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`))))
      return 'Choose a specific application directory; broad and system roots cannot be requested.';
   return undefined;
}

export function parseSourceRoots(value: string): { roots: string[]; error?: string } {
   const roots = value
      .split(/\r?\n/)
      .map((item) => item.trim().replace(/\/+$/, '') || (item.trim() ? '/' : ''))
      .filter(Boolean);
   if (!roots.length) return { roots, error: 'Enter at least one absolute Linux path, one per line.' };
   if (roots.length > 32) return { roots, error: 'At most 32 source roots can be submitted at once.' };
   for (const root of roots) {
      const error = sourcePathError(root);
      if (error) return { roots, error };
   }
   if (new Set(roots).size !== roots.length) return { roots, error: 'Remove duplicate source roots.' };
   if (roots.some((root, index) => roots.some((other, otherIndex) => otherIndex !== index && sourceInsideRoot(root, other))))
      return { roots, error: 'Source roots overlap. Keep the parent root or its individual children.' };
   return { roots };
}

export const sourceInsideRoot = (source: string, root: string) =>
   source === root || source.startsWith(root === '/' ? '/' : `${root.replace(/\/+$/, '')}/`);

export const sourceAuthorizationMode = (report?: SourceAccessReport) =>
   report?.authorizationMode === 'server-managed' ? 'server-managed' : 'host-approved';
export const sourceAuthorizationLabel = (report?: SourceAccessReport) =>
   sourceAuthorizationMode(report) === 'server-managed' ? 'Server-Managed' : 'Host-Approved';

export function sourceWithinDelegation(path: string, report?: SourceAccessReport): boolean {
   return sourceAuthorizationMode(report) === 'server-managed' && Boolean(report?.delegatedRoots?.some((root) => sourceInsideRoot(path, root)));
}

export function sourceMaximumRoots(report?: SourceAccessReport): string[] {
   return [
      ...new Set([...(report?.approvedRoots || []), ...(sourceAuthorizationMode(report) === 'server-managed' ? report?.delegatedRoots || [] : [])]),
   ];
}

/** Validation must match the current Agent report and the exact still-visible input. */
export function currentSourceValidation(
   view: SourceAccessView | undefined,
   requestId: string,
   requestedRoots: string[],
): SourceAccessValidation[] | undefined {
   const request = view?.requests.find((item) => item.requestId === requestId);
   if (
      !view?.report ||
      !request ||
      request.kind !== 'validate' ||
      request.status !== 'validated' ||
      request.expectedVersion !== view.report.effectiveVersion ||
      request.expectedHostPolicyRevision !== view.report.hostPolicyRevision ||
      request.validation?.length !== requestedRoots.length
   )
      return undefined;
   if (request.roots.length !== requestedRoots.length || !request.roots.every((root, index) => root === requestedRoots[index])) return undefined;
   if (!request.validation.every((item) => requestedRoots.includes(item.requestedPath))) return undefined;
   return request.validation;
}

export function affectedSourcePlans(plans: SourceAccessPlan[], roots: string[]): SourceAccessPlan[] {
   return plans.filter((plan) => !roots.some((root) => sourceInsideRoot(plan.sourcePath, root)));
}

export function sourceAccessReady(view: SourceAccessView | undefined): boolean {
   return Boolean(view?.supported && view.online && view.reportFresh && view.report && !view.report.policyError);
}

export function effectiveSourceRoots(view: SourceAccessView | undefined): string[] {
   if (!sourceAccessReady(view)) return [];
   return view!.report!.effectiveRoots.filter((root) => view!.report!.rootStatuses.some((item) => item.path === root && item.status === 'readable'));
}

/** Permission failure does not silently deselect a root in the host policy. */
export function selectedSourceRoots(view: SourceAccessView | undefined): string[] {
   return [...new Set([...(view?.report?.rootStatuses.map((item) => item.path) || []), ...(view?.report?.effectiveRoots || [])])];
}

export function sourceAccessStatus(status: SourceAccessRequest['status'] | SourceAccessValidation['status']): string {
   return {
      queued: 'Queued — awaiting agent',
      validating: 'Validating paths',
      validated: 'Validated — no policy changed',
      'pending-host-approval': 'Pending host approval',
      'pending-host-setup': 'Pending host setup',
      applied: 'Applied',
      approved: 'Approved',
      rejected: 'Rejected',
      cancelled: 'Cancelled',
   }[status];
}

export function sourceAccessProblem(code?: string): string | undefined {
   const messages: Record<string, string> = {
      'source-outside-delegated-scope': 'Outside host-delegated scope. Ask the host administrator to review a separate scope change.',
      'source-root-not-readable': 'The agent account cannot read this directory or traverse its parent directories.',
      'source-parent-not-traversable': 'The agent account cannot traverse a parent directory.',
      'source-missing': 'The directory is missing or inaccessible.',
      'source-sensitive-root': 'Protected system or credential directories cannot be enabled.',
      'source-canonical-path-required': 'Use the exact canonical directory returned by validation.',
      'source-host-approval-changed': 'Host approval changed. Review and apply the selected directory again.',
      'source-host-approval-revoked': 'Host approval was revoked. This directory is unavailable.',
      'source-policy-stale': 'The host policy changed. Refresh and validate the paths again.',
   };
   return code ? messages[code] : undefined;
}

export const sourceRequestPending = (request: SourceAccessRequest) => request.status === 'queued' || request.status === 'validating';

export const sourceModeSetupPending = (view?: SourceAccessView) =>
   view?.requests.some((request) => request.kind === 'mode-setup' && (sourceRequestPending(request) || request.status === 'pending-host-setup')) ===
   true;

export const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

export function hostApprovalCommand(agentId: string, revision: string, roots: string[]): string {
   return [
      'sudo /opt/pluton-agent/runtime/bin/node /opt/pluton-agent/app/dist/index.js source-access approve',
      '  --config-file /etc/pluton-agent.env',
      '  --agent-id ' + shellQuote(agentId),
      '  --expected-host-policy-revision ' + shellQuote(revision),
      ...roots.map((root) => '  --root ' + shellQuote(root)),
   ].join(' \\\n');
}

export function hostModeSetupCommand(agentId: string, request: SourceAccessRequest): string {
   const delegated = request.requestedMode === 'server-managed';
   return [
      `sudo /opt/pluton-agent/runtime/bin/node /opt/pluton-agent/app/dist/index.js source-access ${delegated ? 'delegate' : 'host-approved'}`,
      '  --config-file /etc/pluton-agent.env',
      '  --agent-id ' + shellQuote(agentId),
      '  --expected-host-policy-revision ' + shellQuote(request.expectedHostPolicyRevision),
      '  --request-id ' + shellQuote(request.requestId),
      ...(delegated ? ['  --confirm-delegation'] : []),
      '  --confirm-drained',
      ...(delegated ? request.roots.map((root) => '  --root ' + shellQuote(root)) : []),
   ].join(' \\\n');
}

export function buildAgentInstallCommand(serverUrl: string, roots: string[], insecureHttp: boolean, token?: string): string {
   const args = [
      'sudo ./installers/install-agent.sh',
      '  --server ' + shellQuote(serverUrl),
      ...(token ? ['  --token ' + shellQuote(token)] : []),
      ...roots.map((root) => '  --allowed-root ' + shellQuote(root)),
      ...(insecureHttp ? ['  --allow-insecure-http'] : []),
   ];
   return args.join(' \\\n');
}
