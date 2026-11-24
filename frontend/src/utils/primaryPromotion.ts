import type { PrimaryPromotion, PrimaryPromotionOverview } from '../@types/primaryPromotions';

const ACTIVE = ['catching-up', 'switching'];

/** The promotion the dialog follows: the active one, else the most recent. */
export function currentPromotion(overview?: PrimaryPromotionOverview): PrimaryPromotion | undefined {
   return overview?.active || overview?.history?.[0];
}

export const promotionIsActive = (promotion?: PrimaryPromotion) => !!promotion && ACTIVE.includes(promotion.status);

/** Poll only while the server is working; settled states need no traffic. */
export function promotionPolling(overview?: PrimaryPromotionOverview): number | false {
   return promotionIsActive(overview?.active) ? 5000 : false;
}

const STATUS: Record<string, string> = {
   'catching-up': 'Copying the backups the replica does not hold yet',
   switching: 'Final copy, verification and switch (plan paused)',
   switched: 'Promoted',
   failed: 'Failed, nothing was switched',
   cancelled: 'Cancelled, nothing was switched',
};
export const promotionStatusLabel = (status: string) => STATUS[status] || status;

/** "SFTP" or "S3" for a storage type. */
export function storageKindLabel(type?: string): string {
   if (type === 'sftp') return 'SFTP';
   if (type === 's3' || type === 's3compatible') return 'S3';
   return type || 'Storage';
}

export function promotionProgressText(promotion: PrimaryPromotion): string {
   if (!promotion.totalBackups) return '';
   const parts = [`${promotion.copiedBackups} of ${promotion.totalBackups} backups in the replica`];
   if (promotion.leftBehind.length) parts.push(`${promotion.leftBehind.length} cannot be copied and will stay in the current primary`);
   return parts.join(' · ');
}

const FAILURES: Record<string, string> = {
   'replication-uncertain': 'A replica copy of this plan is uncertain. Check it in the backup mirror details, then promote again.',
   'repository-identity-mismatch': 'The replica is not the repository Pluton verified earlier.',
   'snapshot-identity-mismatch': 'A snapshot in the replica does not match its verified receipt.',
   'replica-unreachable': 'Pluton could not read the replica. Promote again when it is reachable.',
   'verification-stopped': 'Verifying the replica took too long or the server stopped.',
   'binding-changed': 'The plan, its primary or its replica changed during the promotion.',
   'receipt-mismatch': 'A replica receipt no longer matches its backup.',
   'pause-failed': 'The plan could not be paused for the final step.',
   'credentials-unavailable': 'The repository password could not be read on the server.',
   cancelled: 'The promotion was cancelled.',
};

export function promotionFailureText(code?: string | null): string {
   return (code && FAILURES[code]) || 'The promotion stopped safely.';
}

/** What happens, in order, shown before the operator confirms. */
export function promotionSteps(input: { replicaName: string; replicaType?: string; primaryName: string }): string[] {
   const replica = `${input.replicaName} (${storageKindLabel(input.replicaType)})`;
   return [
      `Pluton copies every backup that ${replica} does not hold yet. Backups keep running meanwhile.`,
      'The plan then pauses briefly: Pluton copies what finished meanwhile, checks the replica repository and every snapshot, and switches.',
      `${replica} becomes the primary. ${input.primaryName} becomes the replica. Nothing is deleted.`,
      `The Agent writes the next backup to ${input.replicaName} and uploads only changed data.` +
         (storageKindLabel(input.replicaType) === 'S3' ? ' An S3 primary needs Agent 0.8.0 or later.' : ''),
      'Backups the replica cannot receive stay in the current primary and are listed afterwards.',
      'To switch back later, promote the other side again.',
   ];
}
