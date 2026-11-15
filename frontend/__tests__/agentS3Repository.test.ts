import assert from 'node:assert/strict';
import test from 'node:test';
import {
   AGENT_S3_HIDDEN_NOTICE,
   AGENT_S3_REPLICATION_NOTICE,
   agentRepositoryCanMove,
   agentRepositoryStorageTypes,
   agentS3HiddenNotice,
   agentSupportsS3Repository,
   isAgentS3Primary,
   managedDestinationNotice,
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

test('choosing an S3 primary turns replication off and leaves it untouched otherwise', () => {
   const replication: PlanReplicationSettings = {
      enabled: true,
      concurrent: false,
      recoveryPolicy: 'assisted',
      storages: [{ replicationId: 'replica-01', storageId: 'storage-02', storagePath: 'bucket-01/mirror', storageType: 's3compatible', addedAt: 1 }],
   };
   assert.deepEqual(replicationForAgentPrimary(replication, true), { enabled: false, concurrent: false, recoveryPolicy: 'primary-only', storages: [] });
   assert.equal(replicationForAgentPrimary(replication, false), replication);
   const off: PlanReplicationSettings = { enabled: false, concurrent: false, storages: [] };
   assert.equal(replicationForAgentPrimary(off, true), off);
   assert.equal(replicationForAgentPrimary(undefined, true), undefined);
   const assistedOff: PlanReplicationSettings = { enabled: false, concurrent: false, recoveryPolicy: 'assisted', storages: [] };
   assert.deepEqual(replicationForAgentPrimary(assistedOff, true), { enabled: false, concurrent: false, recoveryPolicy: 'primary-only', storages: [] });
   assert.equal(replicationForAgentPrimary(assistedOff, false), assistedOff);
});

test('destination wording covers both repository types and states what the Agent receives', () => {
   assert.match(managedDestinationNotice(false), /SFTP or S3 primary repository/);
   assert.doesNotMatch(managedDestinationNotice(false), /use SFTP\./);
   assert.match(managedDestinationNotice(true), /writes this plan directly to S3/);
   assert.match(managedDestinationNotice(true), /never any replica key/);
   assert.match(AGENT_S3_REPLICATION_NOTICE, /S3-to-SFTP replication is the next stage/);
});

test('Move Repository stays SFTP to SFTP', () => {
   assert.equal(agentRepositoryCanMove('sftp'), true);
   assert.equal(agentRepositoryCanMove('s3'), false);
   assert.equal(agentRepositoryCanMove('s3compatible'), false);
   assert.equal(agentRepositoryCanMove(undefined), false);
});
