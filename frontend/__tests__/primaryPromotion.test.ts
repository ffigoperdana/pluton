import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
   currentPromotion,
   promotionFailureText,
   promotionIsActive,
   promotionPolling,
   promotionProgressText,
   promotionStatusLabel,
   promotionSteps,
   storageKindLabel,
} from '../src/utils/primaryPromotion.ts';
import type { PrimaryPromotion, PrimaryPromotionOverview } from '../src/@types/primaryPromotions.ts';

const promotion = (overrides: Partial<PrimaryPromotion> = {}): PrimaryPromotion => ({
   id: 'a'.repeat(24),
   planId: 'plan-01',
   replicationId: 'replica-01',
   previousStorageId: 'storage-01',
   previousStoragePath: 'backups/app-01',
   previousStorageName: 'SFTP primary',
   promotedStorageId: 'storage-02',
   promotedStoragePath: 'bucket-01/replicas/app-01',
   promotedStorageName: 'S3 replica',
   status: 'catching-up',
   planWasActive: true,
   totalBackups: 0,
   copiedBackups: 0,
   retried: [],
   leftBehind: [],
   lastErrorCode: null,
   createdAt: 1,
   updatedAt: 1,
   switchedAt: null,
   actions: { cancel: true },
   ...overrides,
});

test('the dialog follows the active promotion, else the latest, and polls only while active', () => {
   const done = promotion({ id: 'b'.repeat(24), status: 'switched' });
   const running = promotion({ status: 'switching' });
   const settled: PrimaryPromotionOverview = { supported: true, replicas: [], history: [done] };
   assert.equal(currentPromotion(settled), done);
   assert.equal(promotionPolling(settled), false);
   const busy: PrimaryPromotionOverview = { ...settled, active: running, history: [running, done] };
   assert.equal(currentPromotion(busy), running);
   assert.equal(promotionPolling(busy), 5000);
   assert.equal(promotionIsActive(done), false);
   assert.equal(currentPromotion(undefined), undefined);
});

test('progress counts copied and left-behind backups', () => {
   assert.equal(promotionProgressText(promotion()), '');
   assert.equal(
      promotionProgressText(
         promotion({
            totalBackups: 5,
            copiedBackups: 3,
            leftBehind: [{ backupId: 'backup-01', code: 'artifact-binding-mismatch' }],
         }),
      ),
      '3 of 5 backups in the replica · 1 cannot be copied and will stay in the current primary',
   );
});

test('status and failure wording says nothing was switched on failure', () => {
   assert.match(promotionStatusLabel('switching'), /plan paused/);
   assert.match(promotionStatusLabel('failed'), /nothing was switched/);
   assert.match(promotionFailureText('replica-unreachable'), /could not read the replica/);
   assert.match(promotionFailureText('replication-uncertain'), /uncertain/);
   assert.equal(promotionFailureText('something-new'), 'The promotion stopped safely.');
   assert.equal(promotionFailureText(null), 'The promotion stopped safely.');
});

test('the confirmation lists the steps and the Agent requirement for an S3 primary only', () => {
   assert.equal(storageKindLabel('s3compatible'), 'S3');
   assert.equal(storageKindLabel('sftp'), 'SFTP');
   const toS3 = promotionSteps({ replicaName: 'HCP', replicaType: 's3compatible', primaryName: 'sftp-01' });
   assert.equal(toS3.length, 6);
   assert.match(toS3[2], /HCP \(S3\) becomes the primary\. sftp-01 becomes the replica\. Nothing is deleted\./);
   assert.match(toS3[3], /Agent 0\.8\.0 or later/);
   const toSftp = promotionSteps({ replicaName: 'sftp-01', replicaType: 'sftp', primaryName: 'HCP' });
   assert.doesNotMatch(toSftp[3], /Agent 0\.8\.0/);
   assert.match(toSftp[5], /promote the other side again/);
});

test('the plan page offers Promote Replica only for managed plans with a replica', () => {
   const page = readFileSync(new URL('../src/routes/PlanSingle/PlanSingle.tsx', import.meta.url), 'utf8');
   assert.match(page, /const promotableReplica = remoteManaged && !!settings\.replication\?\.enabled/);
   assert.match(page, /\{promotableReplica && \(/);
   assert.match(page, /<PlanPromotionModal/);
   const modal = readFileSync(new URL('../src/components/Plan/PlanPromotion/PlanPromotionModal.tsx', import.meta.url), 'utf8');
   assert.match(modal, /disabled=\{busy \|\| !replica\.eligible\}/);
   assert.match(modal, /Cancel promotion/);
});
