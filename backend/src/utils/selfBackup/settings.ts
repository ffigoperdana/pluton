import { z } from 'zod';
import { AppSettings, SelfBackupSettings } from '../../types/settings';
import { BRAND_NAME } from '../brand';

export const SELF_BACKUP_DEFAULTS: SelfBackupSettings = {
	enabled: false,
	storageId: '',
	storageName: '',
	path: '',
	intervalHours: 12,
	retention: 10,
	notifyOnFailure: false,
};

/**
 * The drizzle-zod `settingsUpdateSchema` treats the settings JSON column as opaque and
 * validates nothing inside it, so the self-backup block needs its own schema.
 */
export const selfBackupSettingsSchema = z
	.object({
		enabled: z.boolean(),
		storageId: z.string(),
		storageName: z.string(),
		path: z.string(),
		intervalHours: z.number().int().positive(),
		retention: z.number().int().positive(),
		notifyOnFailure: z.boolean().optional().default(false),
	})
	// Empty storage fields are valid while disabled (that is the default state), but an
	// enabled config with no storage would only fail later, at run time.
	.refine(v => !v.enabled || (v.storageId !== '' && v.storageName !== ''), {
		message: `A storage must be selected to enable ${BRAND_NAME} self-backup.`,
		path: ['storageId'],
	});

/**
 * `initSetup` short-circuits on `.setup_complete`, so `selfBackup` is undefined on every
 * pre-existing install. Backend and UI both resolve through here so defaults live in one place.
 */
export function resolveSelfBackup(appSettings?: AppSettings | null): SelfBackupSettings {
	return { ...SELF_BACKUP_DEFAULTS, ...(appSettings?.selfBackup ?? {}) };
}
