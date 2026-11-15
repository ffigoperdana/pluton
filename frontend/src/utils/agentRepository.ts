import type { AgentInfo } from '../@types/devices';
import type { PlanReplicationSettings } from '../@types/plans';

/** UI gating for an S3 primary on Managed Agent plans (docs/S3_AGENT_REPOSITORY_DESIGN.md 6.4).
 * The server enforces the same rules; the UI only explains them early. */
export const AGENT_S3_STORAGE_TYPES = ['s3', 's3compatible'];

export const AGENT_S3_HIDDEN_NOTICE =
   'S3 storages are not offered for this machine because its Agent does not report S3 repository support. Update the Agent to 0.8.0 or later to back up directly to S3.';

export const AGENT_S3_REPLICATION_NOTICE =
   'Replication is not available for an S3 primary repository yet. S3-to-SFTP replication is the next stage.';

type AgentCapabilitiesView = Pick<AgentInfo, 'capabilities'> | null | undefined;

/** Section 10.1: both fields are required; an Agent that omits them is SFTP-only. */
export function agentSupportsS3Repository(agent: AgentCapabilitiesView): boolean {
   const backends = agent?.capabilities?.repositoryBackends;
   return Array.isArray(backends) && backends.includes('s3') && agent?.capabilities?.backupPayloadVersion === 5;
}

export function agentRepositoryStorageTypes(agent: AgentCapabilitiesView): string[] {
   return agentSupportsS3Repository(agent) ? ['sftp', ...AGENT_S3_STORAGE_TYPES] : ['sftp'];
}

export function agentS3HiddenNotice(agent: AgentCapabilitiesView): string | undefined {
   return agentSupportsS3Repository(agent) ? undefined : AGENT_S3_HIDDEN_NOTICE;
}

export function isAgentS3Primary(managedAgent: boolean, storageType: string | undefined): boolean {
   return managedAgent && AGENT_S3_STORAGE_TYPES.includes(storageType || '');
}

/** Stage 1 refuses replication settings for an S3 primary, so choosing one clears them. */
export function replicationForAgentPrimary(
   replication: PlanReplicationSettings | undefined,
   s3Primary: boolean,
): PlanReplicationSettings | undefined {
   if (
      !s3Primary ||
      !replication ||
      (!replication.enabled && !replication.storages.length && (replication.recoveryPolicy ?? 'primary-only') === 'primary-only')
   )
      return replication;
   return { ...replication, enabled: false, storages: [], recoveryPolicy: 'primary-only' };
}

export function managedDestinationNotice(s3Primary: boolean): string {
   return s3Primary
      ? "The Agent writes this plan directly to S3. For each backup it receives this storage's S3 key in sealed form, and never any replica key. Use a dedicated prefix inside the bucket: the Agent refuses a prefix that already contains data. Database dumps and constrained hooks can be configured under Advanced → Database & Hooks. Agent prune and arbitrary scripts remain unavailable."
      : 'Remote managed backups write to an SFTP or S3 primary repository; S3 needs an Agent that reports S3 support. Database dumps and constrained hooks can be configured under Advanced → Database & Hooks. Optional replicas of an SFTP primary are copied by the Pluton server after snapshot verification, and replica credentials stay on the server. Native database recovery continues to use the trusted primary repository. Agent prune and arbitrary scripts remain unavailable.';
}

/** Move Repository copies SFTP to SFTP only; the server refuses other primaries. */
export function agentRepositoryCanMove(storageType: string | undefined): boolean {
   return storageType === 'sftp';
}
