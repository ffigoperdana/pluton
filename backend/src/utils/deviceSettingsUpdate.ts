import { z } from 'zod';
import { Device } from '../db/schema/devices';
import { DeviceSettings } from '../types/devices';
import { AppError } from './AppError';

const hasControls = (value: string) =>
	[...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const text = z
	.string()
	.max(4096)
	.refine(value => !hasControls(value));
// Empty optional inputs mean "leave unchanged", not "reset the host configuration".
const number = z.union([z.number().int().nonnegative().max(2147483647), z.literal('')]);
const settingsSchema = z
	.object({
		general: z.object({ tempDir: text.optional() }).strict().optional(),
		restic: z
			.object({
				maxProcessor: number.optional(),
				cacheDir: text.optional(),
				tmpDir: text.optional(),
				readConcurrency: number.optional(),
				packSize: text.optional(),
			})
			.strict()
			.optional(),
		rclone: z
			.object({
				tempDir: text.optional(),
				cacheDir: text.optional(),
				bwlimit: text.optional(),
				timeout: text.optional(),
				retries: number.optional(),
				lowLevelRetries: number.optional(),
				transfers: number.optional(),
				checkers: number.optional(),
				bufferSize: text.optional(),
				multiThreadStream: number.optional(),
				configPass: text.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

const updateSchema = z
	.object({
		name: z
			.string()
			.refine(value => !hasControls(value))
			.transform(value => value.trim())
			.pipe(z.string().min(1).max(100))
			.optional(),
		settings: settingsSchema.nullable().optional(),
		tags: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
	})
	.strict();

/** Only metadata is writable here. Identity, telemetry and source approvals are not request fields. */
export function deviceSettingsUpdate(
	input: unknown,
	existing: Device
): {
	updates: Pick<Partial<Device>, 'name' | 'settings' | 'tags'>;
	settingsChanged: boolean;
} {
	const parsed = updateSchema.safeParse(input);
	if (!parsed.success)
		throw new AppError(
			400,
			'Invalid device update. Use a non-empty name of at most 100 characters and valid optional settings.'
		);
	const { name, tags, settings } = parsed.data;
	const updates: Pick<Partial<Device>, 'name' | 'settings' | 'tags'> = {};
	if (name !== undefined) updates.name = name;
	if (tags !== undefined) updates.tags = tags;
	const merged = { ...existing.settings };
	let settingsChanged = false;
	for (const section of ['general', 'restic', 'rclone'] as const) {
		const supplied = settings?.[section];
		if (!supplied) continue;
		const values: Record<string, unknown> = { ...existing.settings?.[section] };
		for (const [key, value] of Object.entries(supplied)) {
			if (value === undefined || (typeof value === 'string' && value.trim() === '')) continue;
			if (values[key] !== value) {
				values[key] = value;
				settingsChanged = true;
			}
		}
		if (Object.keys(values).length) Object.assign(merged, { [section]: values });
	}
	if (settingsChanged) updates.settings = merged as DeviceSettings;
	return { updates, settingsChanged };
}
