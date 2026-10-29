import type { Storage } from '../../db/schema/storages';
import { decryptStorageCredentials, isS3Storage } from '../storageSecurity';
import { TemporaryExportError, type ExportConfig } from './ExportPolicy';

/** Conservative bucket AND credential isolation, even across endpoint aliases.
 * No export operation reads, provisions or changes a registered repository. */
export function assertExportIsolation(
	config: ExportConfig,
	storages: Pick<Storage, 'type' | 'credentials' | 'settings'>[]
) {
	try {
		for (const storage of storages) {
			if (!isS3Storage(storage.type)) continue;
			const credentials = decryptStorageCredentials(storage);
			if (credentials.bucket === config.bucket || credentials.access_key_id === config.accessKeyId)
				throw new Error();
		}
	} catch {
		throw new TemporaryExportError('destination-not-isolated');
	}
}
