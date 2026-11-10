import path from 'path';
import { httpsS3Endpoint } from '../storageSecurity';
import {
	ManagedSftpRepositorySession,
	ManagedRepositoryAccessError,
	type ManagedSftpAccess,
} from './ManagedSftpRepositorySession';

/** Read/staging-only operations inherited from the fixed repository session.
 * No init/copy/tag/unlock/forget/prune/delete command is exposed. */
export class ManagedS3RecoverySession extends ManagedSftpRepositorySession {
	constructor(private readonly trust: Record<string, string> = {}) {
		super();
	}
	protected validateAccess(access: ManagedSftpAccess) {
		const allowed = new Set([
			'type',
			'provider',
			'access_key_id',
			'secret_access_key',
			'session_token',
			'region',
			'endpoint',
			'force_path_style',
			'env_auth',
			'no_check_bucket',
			'acl',
			'storage_class',
			'location_constraint',
			'server_side_encryption',
			'sse_kms_key_id',
			'sse_customer_algorithm',
			'sse_customer_key',
			'sse_customer_key_base64',
			'sse_customer_key_md5',
			'bucket_acl',
			'requester_pays',
			'disable_http2',
			'list_version',
			'list_chunk',
		]);
		const bad = (value: string) =>
			typeof value !== 'string' ||
			[...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
		if (
			!access.password ||
			access.options.type !== 's3' ||
			Object.keys(access.options).some(k => !allowed.has(k)) ||
			Object.values(access.options).some(bad) ||
			!access.options.access_key_id ||
			!access.options.secret_access_key ||
			access.options.env_auth === 'true' ||
			access.options.force_path_style !== 'true' ||
			!access.repositoryPath ||
			access.repositoryPath.includes(String.fromCharCode(92)) ||
			bad(access.repositoryPath) ||
			access.repositoryPath.split('/').some(p => !p || p === '.' || p === '..')
		)
			throw new ManagedRepositoryAccessError('configuration-invalid');
		try {
			httpsS3Endpoint(access.options.endpoint);
		} catch {
			throw new ManagedRepositoryAccessError('configuration-invalid');
		}
		for (const [key, value] of Object.entries(this.trust))
			if (
				!['SSL_CERT_FILE', 'RCLONE_CA_CERT'].includes(key) ||
				!path.isAbsolute(value) ||
				bad(value)
			)
				throw new ManagedRepositoryAccessError('configuration-invalid');
	}
	protected async connectionConfiguration(
		access: ManagedSftpAccess
	): Promise<{ contents: string; environment: NodeJS.ProcessEnv }> {
		return {
			contents:
				'[pluton]\n' +
				Object.entries(access.options)
					.map(([key, value]) => key + ' = ' + value)
					.join('\n') +
				'\n',
			environment: {
				...this.trust,
				GOMAXPROCS: '2',
				GOMEMLIMIT: '256MiB',
				RCLONE_TRANSFERS: '2',
				RCLONE_BUFFER_SIZE: '4M',
				RCLONE_MULTI_THREAD_STREAMS: '0',
			},
		};
	}
}
