import fs from 'fs';
import { formatBytes } from './formatter';

export interface DestinationSpaceParams {
	targetPath: string;
	estimatedBytes: number;
	label?: string; // used in the error message, e.g. 'backup' or 'restore'
}

/**
 * Throws a non-retryable error when the target filesystem does not have enough
 * free space for the estimated write. Uses the native fs.statfs, so it needs no
 * external process and works on Windows, Linux, and macOS.
 *
 * It is a silent no-op (returns) when there is nothing to measure or the
 * measurement fails. Never stop an operation because the measurement failed.
 */
export async function checkDestinationSpace({
	targetPath,
	estimatedBytes,
	label = 'backup',
}: DestinationSpaceParams): Promise<void> {
	if (!targetPath || estimatedBytes <= 0) return;

	let available: number;
	try {
		const stats = await fs.promises.statfs(targetPath);
		available = stats.bavail * stats.bsize;
		if (!Number.isFinite(available) || available < 0) return;
	} catch {
		return;
	}

	const MiB = 1024 * 1024;
	const required = estimatedBytes * 1.2 + 256 * MiB; // 256 MiB buffer for temporary files and overhead
	if (available >= required) return;

	const message =
		`Not enough space on the destination "${targetPath}". ` +
		`The ${label} needs about ${formatBytes(required)} but only ${formatBytes(available)} is free.`;

	const spaceError: Error & { retryable?: boolean } = new Error(message);
	spaceError.retryable = false;
	throw spaceError;
}
