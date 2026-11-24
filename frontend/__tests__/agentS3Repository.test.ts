import assert from 'node:assert/strict';
import test from 'node:test';
import {
   AGENT_S3_HIDDEN_NOTICE,
   agentRepositoryCanMove,
   agentRepositoryStorageTypes,
   agentS3HiddenNotice,
   agentSupportsS3Repository,
   isAgentS3Primary,
   managedDestinationNotice,
   managedReplicaStorageTypes,
   replicationForAgentPrimary,
} from '../src/utils/agentRepository.ts';
import type { PlanReplicationSettings } from '../src/@types/plans.ts';

const agent = (capabilities: Record<string, unknown>) => ({ capabilities }) as never;
const s3Agent = agent({ repositoryBackends: ['sftp', 's3'], backupPayloadVersion: 5 });

test('S3 is offered only to an Agent that reports s3 and payload version 5 (section 10.1)', () => {
   assert.equal(agentSupportsS3Repository(s3Agent), true);
   for (const capabilities of [{}, { repositoryBackends: ['sftp', 's3'] }, { repositoryBackends: ['sftp'], backupPayloadVersion: 5 }])
      assert.equal(agentSupportsS3Repository(agent(capabilities)), false, JSON.stringify(capabilities));
   assert.equal(agentSupportsS3Repository(undefined), false);
   assert.equal(agentSupportsS3Repository(null), false);
   assert.deepEqual(agentRepositoryStorageTypes(s3Agent), ['sftp', 's3', 's3compatible']);
   assert.deepEqual(agentRepositoryStorageTypes(agent({})), ['sftp']);
   assert.deepEqual(agentRepositoryStorageTypes(undefined), ['sftp']);
});

test('the form explains why S3 is hidden and says nothing when it is offered', () => {
   assert.equal(agentS3HiddenNotice(agent({})), AGENT_S3_HIDDEN_NOTICE);
   assert.match(AGENT_S3_HIDDEN_NOTICE, /Update the Agent to 0\.8\.0/);
   assert.equal(agentS3HiddenNotice(s3Agent), undefined);
});

test('an S3 primary is an S3 or S3-compatible storage on a managed Agent plan only', () => {
   assert.equal(isAgentS3Primary(true, 's3'), true);
   assert.equal(isAgentS3Primary(true, 's3compatible'), true);
   assert.equal(isAgentS3Primary(true, 'sftp'), false);
   assert.equal(isAgentS3Primary(true, undefined), false);
   assert.equal(isAgentS3Primary(false, 's3'), false);
});

test('a Managed Agent replica uses the other storage type than its primary (stage 2)', () => {
   assert.deepEqual(managedReplicaStorageTypes('sftp'), ['s3', 's3compatible']);
   assert.deepEqual(managedReplicaStorageTypes('s3'), ['sftp']);
   assert.deepEqual(managedReplicaStorageTypes('s3compatible'), ['sftp']);
   assert.deepEqual(managedReplicaStorageTypes(undefined), []);
});

test('switching the primary type drops only replicas the new primary cannot use', () => {
   const s3Replica = { replicationId: 'replica-01', storageId: 'storage-02', storagePath: 'bucket-01/mirror', storageType: 's3compatible', addedAt: 1 };
   const sftpReplica = { replicationId: 'replica-02', storageId: 'storage-03', storagePath: 'replicas/app-01', storageType: 'sftp', addedAt: 2 };
   const replication: PlanReplicationSettings = { enabled: true, concurrent: false, recoveryPolicy: 'assisted', storages: [s3Replica] };
   assert.equal(replicationForAgentPrimary(replication, true, 'sftp'), replication);
   assert.deepEqual(replicationForAgentPrimary(replication, true, 's3compatible'), { enabled: false, concurrent: false, recoveryPolicy: 'primary-only', backupFailover: 'off', storages: [] });
   const mixed: PlanReplicationSettings = { ...replication, storages: [s3Replica, sftpReplica] };
   assert.deepEqual(replicationForAgentPrimary(mixed, true, 's3'), { ...mixed, storages: [sftpReplica] });
   assert.equal(replicationForAgentPrimary(replication, false, 's3compatible'), replication);
   const off: PlanReplicationSettings = { enabled: false, concurrent: false, storages: [] };
   assert.equal(replicationForAgentPrimary(off, true, 's3'), off);
   assert.equal(replicationForAgentPrimary(undefined, true, 's3'), undefined);
});

test('destination wording covers both repository types and states what the Agent receives', () => {
   assert.match(managedDestinationNotice(false), /SFTP or S3 primary repository/);
   assert.doesNotMatch(managedDestinationNotice(false), /use SFTP\./);
   assert.match(managedDestinationNotice(true), /writes this plan directly to S3/);
   assert.match(managedDestinationNotice(true), /never any replica key/);
   assert.match(managedDestinationNotice(true), /Optional SFTP replicas are copied by the Pluton server/);
   assert.match(managedDestinationNotice(false), /S3 for an SFTP primary, SFTP for an S3 primary/);
});

test('Move Repository stays SFTP to SFTP', () => {
   assert.equal(agentRepositoryCanMove('sftp'), true);
   assert.equal(agentRepositoryCanMove('s3'), false);
   assert.equal(agentRepositoryCanMove('s3compatible'), false);
   assert.equal(agentRepositoryCanMove(undefined), false);
});
