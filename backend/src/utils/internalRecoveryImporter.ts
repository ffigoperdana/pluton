import type { RecoveryTestStore } from '../stores/RecoveryTestStore';
import type { RecoveryImportLease } from '../db/schema/recoveryTests';
import { WorkerRecoveryDatabaseImporter } from './mysqlRecoveryWorkerClient';
import { RecoveryDatabaseImporter } from './recoveryDatabaseImport';
import { InternalRecoveryTargets } from './internalRecoveryTargets';
import { RecoveryTestError } from './recoveryValidation';
import { runRecoveryProcess } from './recoveryProcess';
import { detectRecoveryClient } from './recoveryDatabaseClients';

/** Custom/native and Oracle worker paths stay unchanged. Only irt_ activations use the pinned internal CA. */
export class InternalRecoveryImporter extends WorkerRecoveryDatabaseImporter {
	constructor(
		private readonly internalStore: RecoveryTestStore,
		private readonly internal: InternalRecoveryTargets,
		private readonly nativeRun = runRecoveryProcess
	) {
		super(internalStore);
	}
	private async native(id: string, cleanup = false) {
		const session = await this.internalStore.internalSession(id);
		if (!session || session.releasedAt)
			throw new RecoveryTestError('database-target-preflight', 'internal-target-unsafe');
		return new RecoveryDatabaseImporter(
			this.internalStore,
			this.nativeRun,
			detectRecoveryClient,
			() => this.internal.trust(session, cleanup)
		);
	}
	override async importDatabase(input: Parameters<RecoveryDatabaseImporter['importDatabase']>[0]) {
		if (!input.targetId.startsWith('irt_')) return super.importDatabase(input);
		if (input.target.engine === 'mysql')
			throw new RecoveryTestError('database-target-preflight', 'internal-target-unsafe');
		return (await this.native(input.targetId)).importDatabase(input);
	}
	override async cleanup(lease: RecoveryImportLease, directory: string) {
		return lease.targetId.startsWith('irt_')
			? (await this.native(lease.targetId, true)).cleanup(
					lease,
					directory,
					(await this.internalStore.internalSession(lease.targetId))?.engine === 'postgresql'
				)
			: super.cleanup(lease, directory);
	}
	override async verifyEmptyTarget(
		target: Parameters<RecoveryDatabaseImporter['verifyEmptyTarget']>[0],
		directory: string
	) {
		return (await this.native(target.id, true)).verifyEmptyTarget(target, directory);
	}
}
