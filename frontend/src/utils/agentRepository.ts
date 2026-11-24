import type { AgentInfo } from '../@types/devices';
import type { PlanReplicationSettings } from '../@types/plans';

/** UI gating for an S3 primary on Managed Agent plans (docs/S3_AGENT_REPOSITORY_DESIGN.md 6.4).
 * The server enforces the same rules; the UI only explains them early. */
export const AGENT_S3_STORAGE_TYPES = ['s3', 's3compatible'];

export const AGENT_S3_HIDDEN_NOTICE =
   'S3 storages are not offered for this machine because its Agent does not report S3 repository support. Update the Agent to 0.8.0 or later to back up directly to S3.';

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

/** Replica storage types a Managed Agent primary may use: the other type (S3_PRIMARY_REPLICATION.md). */
export function managedReplicaStorageTypes(primaryStorageType: string | undefined): string[] {
   if (primaryStorageType === 'sftp') return [...AGENT_S3_STORAGE_TYPES];
   if (AGENT_S3_STORAGE_TYPES.includes(primaryStorageType || '')) return ['sftp'];
   return [];
}

/** Switching the primary between SFTP and S3 drops replicas of the type the new primary cannot use. */
export function replicationForAgentPrimary(
   replication: PlanReplicationSettings | undefined,
   managedAgent: boolean,
   primaryStorageType: string | undefined,
): PlanReplicationSettings | undefined {
   if (!managedAgent || !replication) return replication;
   const allowed = managedReplicaStorageTypes(primaryStorageType);
   const storages = replication.storages.filter((storage) => allowed.includes(storage.storageType));
   if (storages.length === replication.storages.length) return replication;
   return storages.length
      ? { ...replication, storages }
      : { ...replication, enabled: false, storages: [], recoveryPolicy: 'primary-only', backupFailover: 'off' };
}

export function managedDestinationNotice(s3Primary: boolean): string {
   return s3Primary
      ? "The Agent writes this plan directly to S3. For each backup it receives this storage's S3 key in sealed form, and never any replica key. Use a dedicated prefix inside the bucket: the Agent refuses a prefix that already contains data. Optional SFTP replicas are copied by the Pluton server after snapshot verification. Database dumps and constrained hooks can be configured under Advanced → Database & Hooks. Agent prune and arbitrary scripts remain unavailable."
      : 'Remote managed backups write to an SFTP or S3 primary repository; S3 needs an Agent that reports S3 support. Database dumps and constrained hooks can be configured under Advanced → Database & Hooks. Optional replicas (S3 for an SFTP primary, SFTP for an S3 primary) are copied by the Pluton server after snapshot verification, and replica credentials stay on the server. Native database recovery continues to use the trusted primary repository. Agent prune and arbitrary scripts remain unavailable.';
}

/** Move Repository copies SFTP to SFTP only; the server refuses other primaries. */
export function agentRepositoryCanMove(storageType: string | undefined): boolean {
   return storageType === 'sftp';
}
