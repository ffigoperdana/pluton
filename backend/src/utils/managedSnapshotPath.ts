import { AppError } from './AppError';

/** Managed metadata is already decoded JSON, not a URL or a host path.
 * Preserve literal POSIX ':' and '%' characters; never decode or normalize them.
 * Keep the existing length/encoding/portable-separator safety boundary. Legacy
 * repositories and caller-selected staging subfolders retain their own policy.
 */
export function managedSnapshotPath(value: unknown): string {
	if (
		typeof value !== 'string' ||
		value.length > 1025 ||
		!value.startsWith('/') ||
		value.includes('\\') ||
		value.includes('\uFFFD') ||
		[...value].some(
			character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f
		) ||
		value
			.slice(1)
			.split('/')
			.some(part => !part || part === '.' || part === '..')
	)
		throw new AppError(400, 'Snapshot path must be an exact safe absolute POSIX path.');
	return value;
}

/** A POSIX archive may contain names that a Windows staging filesystem aliases.
 * Refuse those only for host materialization, never reject the Linux archive.
 */
export function assertManagedRestorePath(value: string, platform = process.platform): void {
	managedSnapshotPath(value);
	if (
		platform === 'win32' &&
		value
			.slice(1)
			.split('/')
			.some(
				part =>
					/[<>:"|?*]|[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
			)
	)
		throw new AppError(409, 'Snapshot filenames require a POSIX restore destination.');
}
