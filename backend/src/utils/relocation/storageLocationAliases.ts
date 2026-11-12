import path from 'path';
import { locationsOverlap, normalizeLocationPath } from './repositoryInventory';

export type StorageEndpointRecord = {
	id: string;
	type?: string | null;
	settings?: Record<string, unknown> | null;
};
export type StorageLocation = { storageId: string | null; storagePath: string };
type SftpEndpoint = { server: string; user: string };

/** `host:port` (host case-insensitive, default port 22) and the login user of an SFTP Storage. */
export function sftpEndpoint(storage?: StorageEndpointRecord): SftpEndpoint | undefined {
	if (!storage || storage.type !== 'sftp') return undefined;
	const settings = storage.settings || {};
	const host = typeof settings.host === 'string' ? settings.host.trim().toLowerCase() : '';
	if (!host) return undefined;
	const rawPort = settings.port;
	const port =
		(typeof rawPort === 'number' && rawPort > 0) || (typeof rawPort === 'string' && rawPort.trim())
			? String(rawPort).trim()
			: '22';
	const user = typeof settings.user === 'string' ? settings.user.trim() : '';
	return { server: `${host.replace(/^\[|\]$/g, '')}:${port}`, user };
}

/**
 * Two Storage records can name the same SFTP server (same host and port). Overlap
 * checks that only compare Storage IDs would then miss a repository stored there
 * through the other record. This compares locations by server instead:
 * - absolute paths on the same server are compared for any user (conservative:
 *   chrooted users may in fact be isolated, which only causes a refusal);
 * - relative paths are compared for the same user, and are also compared as
 *   `/home/<user>/<path>` (`/root/<path>` for root), the usual SFTP start folder.
 * A different host name for the same machine (DNS alias versus IP) is not detected.
 */
export class StorageLocationAliases {
	private readonly endpoints = new Map<string, SftpEndpoint | undefined>();

	constructor(storages: StorageEndpointRecord[]) {
		for (const storage of storages) this.endpoints.set(storage.id, sftpEndpoint(storage));
	}

	overlaps(a: StorageLocation, b: StorageLocation): boolean {
		if (!a.storageId || !b.storageId) return false;
		if (a.storageId === b.storageId) return locationsOverlap(a.storagePath, b.storagePath);
		const left = this.endpoints.get(a.storageId);
		const right = this.endpoints.get(b.storageId);
		if (!left || !right || left.server !== right.server) return false;
		const leftForms = forms(a.storagePath, left.user);
		const rightForms = forms(b.storagePath, right.user);
		return leftForms.some(x =>
			rightForms.some(
				y =>
					x.absolute === y.absolute &&
					(x.absolute || x.user === y.user) &&
					locationsOverlap(x.path, y.path)
			)
		);
	}
}

function forms(storagePath: string, user: string) {
	const normalized = normalizeLocationPath(storagePath || '');
	if (normalized.startsWith('/')) return [{ absolute: true, user, path: normalized }];
	const result = [{ absolute: false, user, path: normalized }];
	if (user && !user.includes('/'))
		result.push({
			absolute: true,
			user,
			path: path.posix.join(user === 'root' ? '/root' : `/home/${user}`, normalized || '.'),
		});
	return result;
}
