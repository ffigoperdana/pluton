import type Database from 'better-sqlite3';
import type { Storage } from '../../db/schema/storages';
import { AppError } from '../AppError';
import { normalizeStorageName } from '../helpers';
import type { ExportConfig } from './ExportPolicy';

type Scope = { authority: string; prefix: string };
type NamespaceSecurity = {
	canonicalS3Location: (endpoint: string, bucket: string, repositoryPath: string) => Scope;
	s3RepositoryScope: (
		storage: Storage,
		repositoryPath?: string | null,
		plaintext?: Record<string, string>
	) => Scope;
	decryptStorageCredentials: (storage: Storage) => Record<string, string>;
	isS3Storage: (type: string | null | undefined) => boolean;
};
let security: NamespaceSecurity | undefined;
/** Startup owns credential access. Importing database stores cannot initialize
 * ConfigService, AppPaths or application state (including standalone migrations). */
export function configureExportNamespaceSecurity(value: NamespaceSecurity | undefined): void {
	security = value;
}
const configured = () => {
	if (!security) throw new AppError(503, 'Export namespace verification is not configured.');
	return security;
};
const canonicalS3Location: NamespaceSecurity['canonicalS3Location'] = (...args) =>
	configured().canonicalS3Location(...args);
const s3RepositoryScope: NamespaceSecurity['s3RepositoryScope'] = (...args) =>
	configured().s3RepositoryScope(...args);
const decryptStorageCredentials: NamespaceSecurity['decryptStorageCredentials'] = (...args) =>
	configured().decryptStorageCredentials(...args);
const isS3Storage: NamespaceSecurity['isS3Storage'] = (...args) =>
	configured().isS3Storage(...args);
type Reference = { storageId?: string | null; storagePath?: string | null };
type ResolutionCache = Map<
	string,
	{ storage: Storage; credentials?: Record<string, string>; s3: boolean }
>;
const TABLE = 'managed_export_namespace_reservations';
const EDITS = 'managed_export_storage_edits';
const has = (db: Database.Database, table: string) =>
	typeof db?.prepare === 'function' &&
	!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const rows = (db: Database.Database, table: string): any[] =>
	has(db, table) ? db.prepare(`SELECT * FROM ${table}`).all() : [];
const decode = (value: any) => (typeof value === 'string' ? JSON.parse(value) : value || {});
const storageRow = (value: any): Storage => ({
	...value,
	credentials: decode(value.credentials),
	settings: decode(value.settings),
});

/** Unknown DNS aliases cannot be disproved offline. Treat every identical bucket
 * name as a potential alias, even on a different endpoint. This is deliberately
 * conservative; no DNS resolution, production access or operator alias bypass. */
export function namespaceMayAlias(a: Scope, b: Scope): boolean {
	return new URL(a.authority).pathname === new URL(b.authority).pathname;
}
export const namespaceScopesOverlap = (a: Scope, b: Scope) =>
	namespaceMayAlias(a, b) &&
	(!a.prefix ||
		!b.prefix ||
		a.prefix === b.prefix ||
		a.prefix.startsWith(b.prefix + '/') ||
		b.prefix.startsWith(a.prefix + '/'));
const refused = () =>
	new AppError(
		409,
		'S3 scope overlaps a permanently reserved Reliable Download prefix, or cannot be resolved safely.'
	);

export function initializeExportNamespaceReservations(db: Database.Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(authority TEXT NOT NULL,prefix TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(authority,prefix)) WITHOUT ROWID;
	CREATE TABLE IF NOT EXISTS ${EDITS}(storage_id TEXT PRIMARY KEY,remote_name TEXT UNIQUE NOT NULL,authorities TEXT NOT NULL,created_at INTEGER NOT NULL) WITHOUT ROWID;`);
}
function reservations(db: Database.Database): Scope[] {
	return rows(db, TABLE) as Scope[];
}
export const hasExportNamespaceReservation = (db: Database.Database) => reservations(db).length > 0;
export const exportNamespacePolicyInitialized = (db: Database.Database) => has(db, TABLE);
export function assertExportStorageCreation(db: Database.Database, storage: Storage): void {
	if (!has(db, TABLE)) return;
	const name = normalizeStorageName(storage.name).trim().toLowerCase();
	if (
		!name ||
		rows(db, 'storages').some(
			row => row.id !== storage.id && normalizeStorageName(row.name).trim().toLowerCase() === name
		)
	)
		throw new AppError(409, 'Storage remote name is already registered or ambiguous.');
	if (rows(db, EDITS).some(row => row.storage_id !== storage.id && row.remote_name === name))
		throw new AppError(
			409,
			'Storage remote name is reserved by an active or uncertain configuration edit.'
		);
	if (isS3Storage(storage.type)) {
		const credentials = decryptStorageCredentials(storage);
		s3RepositoryScope(storage, `${credentials.bucket}/scope-placeholder`);
		if (storage.defaultPath && storage.defaultPath.replace(/^\/+|\/+$/g, '') !== credentials.bucket)
			assertExportRepositoryScope(db, s3RepositoryScope(storage, storage.defaultPath));
	}
}
function referenceScope(
	db: Database.Database,
	reference: Reference,
	override?: Storage,
	cache?: ResolutionCache
): Scope | undefined {
	if (!reference.storageId) return;
	const cached = cache?.get(reference.storageId);
	if (cached)
		return cached.s3
			? s3RepositoryScope(cached.storage, reference.storagePath, cached.credentials)
			: undefined;
	const row =
		override?.id === reference.storageId
			? override
			: has(db, 'storages')
				? db.prepare('SELECT * FROM storages WHERE id=?').get(reference.storageId)
				: undefined;
	if (!row) throw refused();
	const storage = storageRow(row);
	const s3 = isS3Storage(storage.type);
	const credentials = s3 ? decryptStorageCredentials(storage) : undefined;
	cache?.set(reference.storageId, { storage, credentials, s3 });
	if (!s3) return;
	return s3RepositoryScope(storage, reference.storagePath, credentials);
}
export function assertExportRepositoryScope(db: Database.Database, candidate: Scope): void {
	if (reservations(db).some(scope => namespaceScopesOverlap(scope, candidate))) throw refused();
}
export function assertExportPlanScope(db: Database.Database, plan: any, override?: Storage): void {
	if (!reservations(db).length) return;
	const settings = decode(plan.settings);
	if (settings.replication?.storages?.some((reference: Reference) => !reference.storageId))
		throw refused();
	for (const reference of [
		{
			storageId: plan.storageId ?? plan.storage_id,
			storagePath: plan.storagePath ?? plan.storage_path,
		},
		...(settings.replication?.storages || []), // Disabled replicas still own a scope.
	]) {
		const candidate = referenceScope(db, reference, override);
		if (candidate) assertExportRepositoryScope(db, candidate);
	}
}
export function assertExportBackupScope(
	db: Database.Database,
	backup: any,
	override?: Storage
): void {
	if (!reservations(db).length) return;
	const mirrors = backup.mirrors ? decode(backup.mirrors) : [];
	if (!Array.isArray(mirrors)) throw refused();
	assertExportPlanScope(
		db,
		{ ...backup, settings: { replication: { storages: mirrors } } },
		override
	);
}
export function assertExportPlanUpdate(db: Database.Database, id: string, updates: any): void {
	if (!reservations(db).length) return;
	const original = db.prepare('SELECT * FROM plans WHERE id=?').get(id) as any;
	if (original)
		assertExportPlanScope(db, {
			...original,
			storageId: original.storage_id,
			storagePath: original.storage_path,
			...updates,
		});
}
export function assertExportSettingsScope(
	db: Database.Database,
	settings: any,
	override?: Storage
): void {
	if (!reservations(db).length || !settings?.selfBackup?.storageId) return;
	const candidate = referenceScope(
		db,
		{ storageId: settings.selfBackup.storageId, storagePath: settings.selfBackup.path },
		override
	);
	if (candidate) assertExportRepositoryScope(db, candidate);
}
export function assertExportStorageUpdate(
	db: Database.Database,
	id: string,
	updates: Partial<Storage>
): void {
	if (!reservations(db).length) return;
	const original = db.prepare('SELECT * FROM storages WHERE id=?').get(id) as any;
	if (!original) return;
	const next = { ...storageRow(original), ...updates };
	for (const plan of rows(db, 'plans')) assertExportPlanScope(db, plan, next);
	for (const table of ['backups', 'remote_managed_repositories', 'retained_managed_repositories'])
		for (const row of rows(db, table)) {
			if (row.storage_id !== id) continue;
			const candidate = referenceScope(db, { storageId: id, storagePath: row.storage_path }, next);
			if (candidate) assertExportRepositoryScope(db, candidate);
		}
	for (const row of rows(db, 'managed_replication_destinations')) {
		if (row.destination_storage_id !== id) continue;
		const candidate = referenceScope(
			db,
			{ storageId: id, storagePath: row.destination_storage_path },
			next
		);
		if (candidate) assertExportRepositoryScope(db, candidate);
	}
	for (const row of rows(db, 'managed_replication_jobs')) {
		for (const kind of ['source', 'destination']) {
			if (row[`${kind}_storage_id`] !== id) continue;
			const candidate = referenceScope(
				db,
				{ storageId: id, storagePath: row[`${kind}_storage_path`] },
				next
			);
			if (candidate) assertExportRepositoryScope(db, candidate);
		}
	}
	for (const row of rows(db, 'settings')) assertExportSettingsScope(db, decode(row.settings), next);
	for (const row of rows(db, 'backups')) assertExportBackupScope(db, row, next);
}

/** Must span remote configuration edits, not just the final DB update. A crash or
 * uncertain edit leaves a durable blocker; never guess that old rclone settings
 * were restored. Only canonical authorities, never credentials, are recorded. */
export function beginExportStorageEdit(
	db: Database.Database,
	id: string,
	next: Storage
): () => void {
	if (!has(db, EDITS)) return () => {};
	assertExportStorageCreation(db, next);
	db.transaction(() => {
		assertExportStorageCreation(db, next);
		assertExportStorageUpdate(db, id, next);
		const authorities: string[] = [];
		const original = db.prepare('SELECT * FROM storages WHERE id=?').get(id);
		// Once reserved, shared namespace configuration is immutable here. Ordinary
		// non-overlapping backup jobs continue, but credentials/aliases need a reviewed maintenance operation.
		for (const storage of [next, db.prepare('SELECT * FROM storages WHERE id=?').get(id)].filter(
			Boolean
		)) {
			const decoded = storageRow(storage);
			if (!isS3Storage(decoded.type)) continue;
			const credentials = decryptStorageCredentials(decoded);
			const candidate = s3RepositoryScope(decoded, `${credentials.bucket}/scope-placeholder`);
			authorities.push(candidate.authority);
			if (original && reservations(db).some(scope => namespaceMayAlias(scope, candidate)))
				throw refused();
		}
		if (db.prepare(`SELECT 1 FROM ${EDITS} WHERE storage_id=?`).get(id))
			throw new AppError(
				409,
				'S3 configuration edit is active or uncertain; operator reconciliation is required.'
			);
		db.prepare(`INSERT INTO ${EDITS} VALUES (?,?,?,?)`).run(
			id,
			normalizeStorageName(next.name).trim().toLowerCase(),
			JSON.stringify(authorities),
			Date.now()
		);
	}).immediate();
	return () => {
		db.prepare(`DELETE FROM ${EDITS} WHERE storage_id=?`).run(id);
	};
}

/** Main DB IMMEDIATE transaction is shared by plan/storage/replica admissions.
 * The reservation is permanent and survives disablement, job cleanup and reboot.
 * It is installed BEFORE any S3 probe or source read. */
export function reserveExportNamespace(db: Database.Database, config: ExportConfig): void {
	try {
		db.transaction(() => {
			const selected = canonicalS3Location(
				config.endpoint,
				config.bucket,
				`${config.bucket}/${config.prefix}`
			);
			if (
				rows(db, EDITS).some(edit =>
					(JSON.parse(edit.authorities) as string[]).some(authority =>
						namespaceMayAlias(selected, { authority, prefix: '' })
					)
				)
			)
				throw refused();
			const names = rows(db, 'storages').map(row =>
				normalizeStorageName(row.name).trim().toLowerCase()
			);
			if (new Set(names).size !== names.length) throw refused();
			// Synchronous transaction-local resolution only: repeated historical
			// references cannot repeat expensive credential derivation or outlive edits.
			const resolution: ResolutionCache = new Map();
			const check = (reference: Reference) => {
				const scope = referenceScope(db, reference, undefined, resolution);
				if (scope && namespaceScopesOverlap(selected, scope)) throw refused();
			};
			for (const plan of rows(db, 'plans')) {
				check({ storageId: plan.storage_id, storagePath: plan.storage_path });
				for (const reference of decode(plan.settings).replication?.storages || []) {
					if (!reference.storageId) throw refused();
					check(reference);
				}
			}
			for (const table of [
				'backups',
				'remote_managed_repositories',
				'retained_managed_repositories',
			])
				for (const row of rows(db, table))
					check({ storageId: row.storage_id, storagePath: row.storage_path });
			for (const backup of rows(db, 'backups')) {
				const mirrors = backup.mirrors ? decode(backup.mirrors) : [];
				if (!Array.isArray(mirrors)) throw refused();
				for (const mirror of mirrors) {
					if (!mirror.storageId) throw refused();
					check(mirror);
				}
			}
			for (const row of rows(db, 'managed_replication_destinations')) {
				if (
					namespaceScopesOverlap(selected, {
						authority: row.destination_authority,
						prefix: row.destination_prefix,
					})
				)
					throw refused();
				check({ storageId: row.destination_storage_id, storagePath: row.destination_storage_path });
			}
			for (const row of rows(db, 'managed_replication_jobs')) {
				check({ storageId: row.destination_storage_id, storagePath: row.destination_storage_path });
				check({ storageId: row.source_storage_id, storagePath: row.source_storage_path });
			}
			for (const row of rows(db, 'settings')) {
				const settings = decode(row.settings);
				if (settings.selfBackup?.storageId)
					check({
						storageId: settings.selfBackup.storageId,
						storagePath: settings.selfBackup.path,
					});
			}
			if (rows(db, 'legacy_repositories').some(row => row.backend !== 'local')) throw refused();
			if (
				!db
					.prepare(`SELECT 1 FROM ${TABLE} WHERE authority=? AND prefix=?`)
					.get(selected.authority, selected.prefix) &&
				reservations(db).length >= 8
			)
				throw refused();
			db.prepare(`INSERT OR IGNORE INTO ${TABLE} VALUES (?,?,?)`).run(
				selected.authority,
				selected.prefix,
				Date.now()
			);
		}).immediate();
	} catch {
		throw new AppError(409, 'Reliable Download unavailable (destination-not-isolated).');
	}
}
