import crypto from 'crypto';
import { AppError } from '../AppError';
import { managedSnapshotPath } from '../managedSnapshotPath';
import { recoveryArtifacts } from '../recoveryValidation';
import type { ManagedSnapshotIndex } from './ManagedSnapshotIndex';
import type { ManagedSnapshot } from './ManagedSftpRepositorySession';

export type ComparisonDiagnostic =
	| 'repository-binding-changed'
	| 'historical-source-scope-mismatch'
	| 'snapshot-root-path-incompatible'
	| 'snapshot-ownership-mismatch'
	| 'snapshot-identity-missing'
	| 'previous-snapshot-unavailable'
	| 'historical-metadata-incomplete'
	| 'restic-diff-unavailable'
	| 'snapshot-index-verification'
	| 'comparison-context-changed'
	| 'diff-identity-mismatch';
export type ComparisonStage =
	| 'pair-selection'
	| 'current-index'
	| 'previous-index'
	| 'snapshot-verification'
	| 'root-validation'
	| 'comparison-indexing'
	| 'restic-diff'
	| 'final-revalidation';
const messages: Record<ComparisonDiagnostic, string> = {
	'repository-binding-changed': 'The managed repository binding is unavailable or has changed.',
	'historical-source-scope-mismatch': 'Recorded filesystem source scopes are incompatible.',
	'snapshot-root-path-incompatible':
		'Snapshot root paths are incompatible with verified source and database evidence.',
	'snapshot-ownership-mismatch': 'Snapshot does not belong to this backup and managed repository.',
	'snapshot-identity-missing': 'This backup has no complete, unambiguous snapshot ID.',
	'previous-snapshot-unavailable': 'The selected previous snapshot is unavailable.',
	'historical-metadata-incomplete': 'Historical comparison metadata is incomplete or invalid.',
	'restic-diff-unavailable': 'Verified Restic diff is unavailable for this repository adapter.',
	'snapshot-index-verification': 'Snapshot index verification failed.',
	'comparison-context-changed': 'The managed repository binding has changed. Retry the operation.',
	'diff-identity-mismatch': 'Snapshot comparison identity mismatch.',
};
/** Fixed public codes only. No paths, credentials or raw upstream messages. */
export class SnapshotComparisonError extends AppError {
	constructor(
		readonly diagnostic: ComparisonDiagnostic,
		status = 409
	) {
		super(status, messages[diagnostic]);
		Object.setPrototypeOf(this, new.target.prototype);
	}
}
export type ComparisonEvidence = {
	sources: string[];
	artifacts: { path: string; bytes: number; sha256: string }[];
	fingerprint: string;
};
export function comparisonEvidence(value: {
	completionStats?: { sourcePaths?: string[]; lifecycle?: unknown } | null;
	sourceConfig?: { includes?: string[] } | null;
}): ComparisonEvidence {
	try {
		const sources = value.completionStats?.sourcePaths || value.sourceConfig?.includes || [];
		if (
			!Array.isArray(sources) ||
			!sources.length ||
			sources.length > 1024 ||
			new Set(sources).size !== sources.length
		)
			throw new Error();
		for (const source of sources) managedSnapshotPath(source);
		const artifacts = recoveryArtifacts(value.completionStats?.lifecycle)
			.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		const sorted = [...sources].sort();
		return {
			sources: sorted,
			artifacts,
			fingerprint: crypto
				.createHash('sha256')
				.update(JSON.stringify([sorted, artifacts]))
				.digest('hex'),
		};
	} catch {
		throw new SnapshotComparisonError('historical-metadata-incomplete');
	}
}
export const sameFilesystemScope = (a: ComparisonEvidence, b: ComparisonEvidence) =>
	JSON.stringify(a.sources) === JSON.stringify(b.sources);
type EvidenceIndex = Pick<ManagedSnapshotIndex, 'get' | typeof Symbol.iterator>;
function roots(snapshot: ManagedSnapshot) {
	try {
		if (
			!snapshot.paths.length ||
			snapshot.paths.length > 1032 ||
			new Set(snapshot.paths).size !== snapshot.paths.length
		)
			throw new Error();
		return snapshot.paths.map(managedSnapshotPath).sort();
	} catch {
		throw new SnapshotComparisonError('snapshot-root-path-incompatible');
	}
}
function sourceRoots(paths: string[], index: EvidenceIndex, evidence: ComparisonEvidence) {
	for (const source of evidence.sources)
		if (!paths.includes(source) || !['dir', 'file'].includes(index.get(source)?.type || ''))
			throw new SnapshotComparisonError('historical-source-scope-mismatch');
}
/** Native ls proves canonical tree entries; snapshot.paths alone cannot prove an alias. */
async function databaseRoots(
	paths: string[],
	index: EvidenceIndex,
	evidence: ComparisonEvidence,
	signal: AbortSignal
) {
	const remaining = new Set(evidence.artifacts.map(a => a.path));
	let workspace: string | undefined;
	for (const root of paths) {
		if (evidence.sources.includes(root)) continue;
		const artifact = evidence.artifacts.find(a => root === a.path || root.endsWith(a.path));
		if (!artifact)
			throw new SnapshotComparisonError(
				evidence.artifacts.length
					? 'snapshot-root-path-incompatible'
					: 'historical-metadata-incomplete'
			);
		if (!remaining.delete(artifact.path))
			throw new SnapshotComparisonError('snapshot-root-path-incompatible');
		const node = index.get(artifact.path);
		if (node?.type !== 'file' || node.size !== artifact.bytes)
			throw new SnapshotComparisonError('historical-metadata-incomplete');
		if (root !== artifact.path) {
			const prefix = root.slice(0, -artifact.path.length);
			// Agent's existing bounded job-token layout (also used by parent verification).
			// Current mkdtemp tokens and historical job tokens still require all receipt/tree proofs.
			if (
				!/\/jobs\/job-[A-Za-z0-9_-]{1,160}$/.test(prefix) ||
				index.get(root) ||
				evidence.sources.some(
					s => prefix === s || prefix.startsWith(s + '/') || s.startsWith(prefix + '/')
				) ||
				(workspace !== undefined && workspace !== prefix)
			)
				throw new SnapshotComparisonError('snapshot-root-path-incompatible');
			workspace = prefix;
		}
	}
	if (remaining.size) throw new SnapshotComparisonError('historical-metadata-incomplete');
	// Complete tree coverage prevents a recognized suffix from hiding other roots.
	// The iterator is SQLite-backed; no complete snapshot array/content read.
	let n = 0;
	for (const entry of index) {
		signal.throwIfAborted();
		const allowed =
			evidence.sources.some(
				s =>
					entry.path === s ||
					entry.path.startsWith(s + '/') ||
					(entry.type === 'dir' && s.startsWith(entry.path + '/'))
			) ||
			evidence.artifacts.some(
				a => entry.path === a.path || (entry.type === 'dir' && a.path.startsWith(entry.path + '/'))
			);
		if (!allowed) throw new SnapshotComparisonError('snapshot-root-path-incompatible');
		if (++n % 512 === 0) await new Promise<void>(resolve => setImmediate(resolve));
	}
}
export async function verifyComparisonRoots(
	current: ManagedSnapshot,
	previous: ManagedSnapshot,
	currentIndex: EvidenceIndex,
	previousIndex: EvidenceIndex,
	currentEvidence: ComparisonEvidence,
	previousEvidence: ComparisonEvidence,
	signal: AbortSignal
) {
	if (!sameFilesystemScope(currentEvidence, previousEvidence))
		throw new SnapshotComparisonError('historical-source-scope-mismatch');
	const a = roots(current),
		b = roots(previous);
	sourceRoots(a, currentIndex, currentEvidence);
	sourceRoots(b, previousIndex, previousEvidence);
	const exact = JSON.stringify(a) === JSON.stringify(b);
	if (!exact) {
		await databaseRoots(a, currentIndex, currentEvidence, signal);
		await databaseRoots(b, previousIndex, previousEvidence, signal);
	}
	return {
		mode: exact ? ('exact-roots' as const) : ('verified-database-roots' as const),
		currentDatabaseArtifacts: currentEvidence.artifacts.length,
		previousDatabaseArtifacts: previousEvidence.artifacts.length,
	};
}
export function comparisonDiagnostic(error: unknown): ComparisonDiagnostic | undefined {
	if (error instanceof SnapshotComparisonError) return error.diagnostic;
	const code = (error as { code?: unknown })?.code;
	if (
		typeof code === 'string' &&
		[
			'index-resource-limit',
			'index-unavailable',
			'metadata-invalid',
			'unsupported-snapshot-file',
			'snapshot-indexing',
		].includes(code)
	)
		return 'snapshot-index-verification';
}
