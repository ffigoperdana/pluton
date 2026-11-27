import { trustEnvironment } from '../storageSecurity';
import { ManagedS3RecoverySession } from './ManagedS3RecoverySession';
import {
	ManagedSftpRepositorySession,
	type ManagedRepositorySession,
	type ManagedRepositorySessionOptions,
	type ManagedRepositorySessionProvider,
	type ManagedSftpAccess,
} from './ManagedSftpRepositorySession';

/**
 * docs/S3_AGENT_REPOSITORY_DESIGN.md 6.1.3 and section 9: repository access is built per
 * storage type, not per service instance. S3 access always carries `type: 's3'`
 * (storageRcloneOptions, RemoteBackupService.getRepositoryAccessOptions); SFTP access
 * never carries `type`, and each session refuses the other's options.
 */
export type ManagedRepositoryAccessType = 'sftp' | 's3';
export type ManagedRepositorySessionFactory = (
	type: ManagedRepositoryAccessType
) => ManagedRepositorySessionProvider;

export function managedRepositoryAccessType(access: ManagedSftpAccess): ManagedRepositoryAccessType {
	return access.options.type === 's3' ? 's3' : 'sftp';
}

/** Operator trust is read per session, as the replica resolver reads it per resolution. */
export const managedRepositorySessionFactory =
	(options: ManagedRepositorySessionOptions = {}): ManagedRepositorySessionFactory =>
	type =>
		type === 's3'
			? new ManagedS3RecoverySession(trustEnvironment(), options)
			: new ManagedSftpRepositorySession(options);

export const defaultManagedRepositorySessionFactory: ManagedRepositorySessionFactory =
	managedRepositorySessionFactory();

export class ManagedRepositorySessionRouter implements ManagedRepositorySessionProvider {
	constructor(
		private readonly factory: ManagedRepositorySessionFactory = defaultManagedRepositorySessionFactory
	) {}

	async withSession<T>(
		access: ManagedSftpAccess,
		consume: (session: ManagedRepositorySession) => Promise<T>,
		signal?: AbortSignal,
		limits?: { restoreTimeoutMs: number; temporaryRoot?: string; cleanupWarning?: () => void }
	): Promise<T> {
		return this.factory(managedRepositoryAccessType(access)).withSession(
			access,
			consume,
			signal,
			limits
		);
	}
}
