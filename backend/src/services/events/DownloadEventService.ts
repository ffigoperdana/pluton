import { BackupStore } from '../../stores/BackupStore';
import { planLogger } from '../../utils/logger';
import { DownloadCompleteEvent, DownloadErrorEvent, DownloadStartEvent } from '../../types/events';
import { BaseSnapshotManager } from '../../managers/BaseSnapshotManager';
import { eventSec } from '../../utils/eventTime';

export class DownloadEventService {
	constructor(
		protected backupStore: BackupStore,
		protected localAgent?: BaseSnapshotManager
	) {}

	async onDownloadStart(eventPayload: DownloadStartEvent) {
		const { backupId, planId } = eventPayload;
		try {
			const currentTime = Math.floor(new Date().getTime() / 1000);
			await this.backupStore.update(backupId, {
				download: {
					status: 'started',
					started: currentTime,
				},
			});
			planLogger('download', planId, backupId).info(
				`Download generation started for backup ${backupId}`
			);
		} catch (error: any) {
			console.log('[error] onDownloadStart :', error);
			planLogger('download', planId, backupId).error(
				`Failed to handle download generation start for backup ${backupId}: ${error.message}`
			);
		}
	}

	async onDownloadError(eventPayload: DownloadErrorEvent) {
		const { backupId, planId, error } = eventPayload;
		try {
			const backup = await this.backupStore.getById(backupId);
			// A cancel cleared the download. Do not rebuild it from a late
			// failure report, or the killed run looks like a real failure.
			if (!backup?.download) {
				return;
			}

			await this.backupStore.update(backupId, {
				download: {
					...backup.download,
					status: 'failed',
					error: error,
					ended: eventSec((eventPayload as { occurredAt?: number }).occurredAt),
				},
			});

			planLogger('download', planId, backupId).error(
				`Failed to complete download generation for backup ${backupId}. Reason: ${error || 'Unknown'}`
			);
		} catch (error: any) {
			console.log('[error] onDownloadError :', error);
			planLogger('download', planId, backupId).error(
				`Failed to handle download generation error for backup ${backupId}: ${error.message}`
			);
		}
	}

	async onDownloadComplete(eventPayload: DownloadCompleteEvent) {
		const { backupId, planId, success } = eventPayload;
		try {
			const backup = await this.backupStore.getById(backupId);
			// A cancel cleared the download, so there is nothing to complete.
			if (!backup?.download) {
				return;
			}

			await this.backupStore.update(backupId, {
				download: {
					...backup.download,
					status: 'complete',
					error: '',
					ended: eventSec((eventPayload as { occurredAt?: number }).occurredAt),
				},
			});

			planLogger('download', planId, backupId).info(
				`Download generation completed for backup ${backupId}`
			);
		} catch (error: any) {
			console.log('[error] onDownloadComplete :', error);
			planLogger('download', planId, backupId).error(
				`Failed to handle download completion for backup ${backupId}. Reason: ${error?.message || 'Unknown'}`
			);
		}
	}
}
