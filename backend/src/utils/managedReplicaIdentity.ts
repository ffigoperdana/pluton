import { createHash } from 'crypto';
import type { Storage } from '../db/schema/storages';
import { AppError } from './AppError';
import { replicaStorageKind } from './replicaStorageKind';
import {
	canonicalS3RepositoryIdentity,
	decryptStorageCredentials,
	s3RepositoryScope,
} from './storageSecurity';

/**
 * Managed replica repository identities (docs/S3_PRIMARY_REPLICATION.md section 3).
 * An SFTP primary replicates to S3 and an S3 primary replicates to SFTP; both kinds share the
 * ownership, overlap and fingerprint rules of the managed replication store.
 */
export type ReplicaRepositoryIdentity = { authority: string; prefix: string; fingerprint: string };

export { replicaStorageKind, requiredReplicaKind, type ReplicaStorageKind } from './replicaStorageKind';

type StorageConfiguration = Pick<Storage, 'type' | 'credentials' | 'settings'>;

const hasControl = (value: string): boolean =>
	Array.from(value).some(
		character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
	);

/** Host, port and account of an SFTP storage; secrets other than these never leave here. */
function sftpAuthority(storage: StorageConfiguration, plaintext?: Record<string, string>): string {
	const credentials = plaintext || decryptStorageCredentials(storage);
	const settings = (storage.settings || {}) as Record<string, unknown>;
	const read = (key: string) => {
		const value = credentials[key] ?? settings[key];
		return value === undefined || value === null ? '' : String(value).trim();
	};
	const host = read('host').toLowerCase();
	const user = read('user');
	const port = read('port') || '22';
	if (
		!host ||
		!user ||
		hasControl(host) ||
		hasControl(user) ||
		/[\s/@\\]/.test(host) ||
		!/^[0-9]{1,5}$/.test(port) ||
		Number(port) < 1 ||
		Number(port) > 65_535
	)
		throw new AppError(400, 'The SFTP storage needs a valid host, port and username.');
	return `sftp://${encodeURIComponent(user)}@${host}:${Number(port)}`;
}

/**
 * Normalized SFTP location. Relative paths start in the account's home directory, which the
 * server cannot resolve, so absolute (`/`) and home-relative (`/~`) paths are separate
 * authorities. The prefix never has a leading, trailing or empty segment.
 */
function sftpLocation(
	storage: StorageConfiguration,
	repositoryPath: string | null | undefined,
	allowRoot: boolean,
	plaintext?: Record<string, string>
): { authority: string; prefix: string } {
	const raw = (repositoryPath || '').trim();
	const parts = raw.split('/').filter(part => part !== '' && part !== '.');
	if (
		hasControl(raw) ||
		raw.includes('\\') ||
		parts.some(part => part === '..') ||
		(!allowRoot && parts.length === 0)
	)
		throw new AppError(
			400,
			'Use a dedicated SFTP repository folder; the account root, traversal and backslashes are forbidden.'
		);
	const base = sftpAuthority(storage, plaintext);
	return { authority: base + (raw.startsWith('/') ? '/' : '/~'), prefix: parts.join('/') };
}

export function sftpRepositoryIdentity(
	storage: StorageConfiguration,
	repositoryPath: string,
	plaintext?: Record<string, string>
): ReplicaRepositoryIdentity {
	if (storage.type !== 'sftp') throw new AppError(400, 'SFTP storage is required.');
	const { authority, prefix } = sftpLocation(storage, repositoryPath, false, plaintext);
	return {
		authority,
		prefix,
		fingerprint: createHash('sha256')
			.update(JSON.stringify([authority, prefix]))
			.digest('hex'),
	};
}

/** Scope of any plan reference; an empty or root path owns its whole namespace. */
export function sftpRepositoryScope(
	storage: StorageConfiguration,
	repositoryPath?: string | null
): { authority: string; prefix: string } {
	return sftpLocation(storage, repositoryPath, true);
}

export function replicaRepositoryIdentity(
	storage: StorageConfiguration,
	repositoryPath: string,
	plaintext?: Record<string, string>
): ReplicaRepositoryIdentity {
	const kind = replicaStorageKind(storage.type);
	if (kind === 's3') return canonicalS3RepositoryIdentity(storage, repositoryPath, plaintext);
	if (kind === 'sftp') return sftpRepositoryIdentity(storage, repositoryPath, plaintext);
	throw new AppError(400, 'Managed replicas use S3 or SFTP storage.');
}

/** Resolver for managedReplicationPolicy: S3 and SFTP scopes, nothing else. */
export function replicaRepositoryScope(
	storage: Storage,
	repositoryPath?: string | null
): { authority: string; prefix: string } {
	return replicaStorageKind(storage.type) === 'sftp'
		? sftpRepositoryScope(storage, repositoryPath)
		: s3RepositoryScope(storage, repositoryPath);
}

/** The managed overlap rule; an empty prefix owns everything under its authority. */
export function replicaScopesOverlap(
	a: { authority: string; prefix: string },
	b: { authority: string; prefix: string }
): boolean {
	return (
		a.authority === b.authority &&
		(!a.prefix ||
			!b.prefix ||
			a.prefix === b.prefix ||
			a.prefix.startsWith(`${b.prefix}/`) ||
			b.prefix.startsWith(`${a.prefix}/`))
	);
}
