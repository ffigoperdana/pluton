import { z } from 'zod';
import { AppError } from '../AppError';
import { lifecycleDatabases, parseRemoteLifecycle } from '../remoteLifecycle';
import { managedSnapshotPath } from '../managedSnapshotPath';
import type { Plan } from '../../db/schema/plans';

/**
 * Pairs a filestore plan with the plan whose database dump describes its files.
 * Version 1 has one adapter: Odoo attachments (ir_attachment in PostgreSQL).
 */
export const attachmentCatalogSettingsSchema = z.strictObject({
	version: z.literal(1),
	adapter: z.literal('odoo'),
	databasePlanId: z.string().min(1).max(64),
	databaseId: z.string().min(1).max(64),
	/** Snapshot path of the Odoo database's filestore folder; defaults to the plan source. */
	filestoreRoot: z.string().min(2).max(1024).optional(),
});
export type AttachmentCatalogSettings = z.infer<typeof attachmentCatalogSettingsSchema>;

type PlanLookup = { getById(id: string): Promise<Plan | null> };

export function planSourceRoot(plan: Pick<Plan, 'sourceConfig'>): string | undefined {
	const includes = plan.sourceConfig?.includes;
	return Array.isArray(includes) && includes.length === 1 && typeof includes[0] === 'string'
		? includes[0].trim().replace(/\/+$/, '') || undefined
		: undefined;
}

/** The PostgreSQL database entry of the database plan that the settings name. */
export function catalogDatabase(databasePlan: Pick<Plan, 'settings'>, databaseId: string) {
	const lifecycle = databasePlan.settings?.remoteLifecycle;
	if (!lifecycle) return undefined;
	return lifecycleDatabases(parseRemoteLifecycle(lifecycle)).find(
		entry => entry.databaseId === databaseId && entry.engine === 'postgresql'
	);
}

/**
 * Validates settings supplied for a plan. Returns the normalized value, or
 * undefined when the catalog is switched off (null or absent).
 */
export async function validateAttachmentCatalogSettings(
	value: unknown,
	plan: Pick<Plan, 'id' | 'sourceType' | 'sourceId' | 'sourceConfig' | 'method'>,
	plans: PlanLookup
): Promise<AttachmentCatalogSettings | undefined> {
	if (value === undefined || value === null) return undefined;
	const parsed = attachmentCatalogSettingsSchema.safeParse(value);
	if (!parsed.success) throw new AppError(400, 'Attachment catalog settings are invalid.');
	const settings = parsed.data;
	// The same rule as RemoteBackupService.isRemoteFilesystemPlan.
	if (plan.sourceType !== 'device' || plan.sourceId === 'main' || plan.method !== 'backup')
		throw new AppError(400, 'An attachment catalog needs a Managed Agent backup plan.');
	if (settings.databasePlanId === plan.id)
		throw new AppError(400, 'Pair the filestore plan with a different database plan.');
	const databasePlan = await plans.getById(settings.databasePlanId);
	if (!databasePlan) throw new AppError(400, 'The database plan of the attachment catalog was not found.');
	if (!catalogDatabase(databasePlan, settings.databaseId))
		throw new AppError(400, 'The database plan has no PostgreSQL database with this entry.');
	const root = settings.filestoreRoot?.replace(/\/+$/, '') || planSourceRoot(plan);
	if (!root) throw new AppError(400, 'Enter the filestore folder of the attachment catalog.');
	try {
		managedSnapshotPath(root);
	} catch {
		throw new AppError(400, 'The filestore folder must be an absolute snapshot path.');
	}
	return { ...settings, ...(settings.filestoreRoot ? { filestoreRoot: root } : {}) };
}
