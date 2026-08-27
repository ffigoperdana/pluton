import { PlanService } from './PlanService';
import { planLogger } from '../utils/logger';

/**
 * Clears orphaned in-progress rows at startup.
 *
 * The job queue is in memory only, so any backup or restore still marked
 * in-progress when the service starts is the leftover of a stopped or crashed
 * service. The database write is delegated to PlanService; this class only
 * orchestrates the cleanup and records a warning for each cleared row.
 */
export class StartupRecovery {
	constructor(private planService: PlanService) {}

	async run(): Promise<void> {
		try {
			const { backups, restores, plans } = await this.planService.clearOrphanedInProgress();

			for (const backup of backups) {
				planLogger('backup', backup.planId ?? undefined, backup.id).warn(
					"This backup didn't finish because Pluton restarted while it was running. Marked as failed."
				);
			}

			for (const restore of restores) {
				planLogger('restore', restore.planId ?? undefined, restore.backupId ?? undefined).warn(
					"This restore didn't finish because Pluton restarted while it was running. Marked as failed."
				);
			}

			for (const plan of plans) {
				planLogger('backup', plan.id).warn('Cleared a stale "running" state left on this plan.');
			}
		} catch (error: any) {
			planLogger('backup').error(`Startup recovery process failed: ${error?.message}`);
		}
	}
}
