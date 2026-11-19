import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Writable } from 'stream';
import { AppError } from '../../src/utils/AppError';
import {
	ATTACHMENT_CATALOG_LIMITS,
	AttachmentCatalogService,
} from '../../src/services/AttachmentCatalogService';
import { validateAttachmentCatalogSettings } from '../../src/utils/attachmentCatalog/config';

// Real PostgreSQL 12 pg_dump output (synthetic data); see the fixture README in the parser test.
const dump = fs.readFileSync(
	path.join(__dirname, '../fixtures/attachmentCatalog/odoo-ir-attachment.pg12.sql')
);
const snapshot = (n: string) => n.repeat(64);
const database = {
	databaseId: 'db_example01',
	engine: 'postgresql' as const,
	host: 'localhost',
	port: 5432,
	tls: 'local' as const,
	database: 'example_odoo',
	username: 'backup_reader',
	dumpFilename: 'example-odoo.sql',
	timeoutSeconds: 900,
	maxDumpBytes: 1024 ** 3,
	includeRoutines: false,
	includeEvents: false,
	passwordConfigured: true,
};
const catalog = { version: 1, adapter: 'odoo', databasePlanId: 'plan-db', databaseId: 'db_example01' };
const filesPlan = {
	id: 'plan-files',
	title: 'example-files',
	sourceType: 'device',
	sourceId: 'device-01',
	method: 'backup',
	sourceConfig: { includes: ['/srv/example-filestore'], excludes: [] },
	settings: { attachmentCatalog: catalog },
};
const dbPlan = {
	id: 'plan-db',
	title: 'example-db',
	sourceType: 'device',
	sourceId: 'device-02',
	method: 'backup',
	sourceConfig: { includes: ['/srv/example-db'], excludes: [] },
	settings: { remoteLifecycle: { version: 2, databases: [database] } },
};
const at = new Date('2026-11-19T18:15:00Z');
const filesBackup = {
	id: 'backup-files',
	planId: 'plan-files',
	status: 'completed',
	completionStats: { snapshot_id: snapshot('a') },
	started: new Date(at.getTime() - 600_000),
	ended: at,
	createdAt: at,
};
const dbBackup = (id: string, minutes: number, artifact = true) => ({
	id,
	planId: 'plan-db',
	status: 'completed',
	completionStats: {
		snapshot_id: snapshot('b'),
		lifecycle: artifact
			? {
					databases: [
						{
							databaseId: 'db_example01',
							engine: 'postgresql',
							database: 'example_odoo',
							path: '/pluton/database/example-odoo.sql',
							bytes: dump.length,
							sha256: snapshot('c'),
						},
					],
				}
			: { databases: [] },
	},
	started: new Date(at.getTime() + minutes * 60_000 - 60_000),
	ended: new Date(at.getTime() + minutes * 60_000),
	createdAt: new Date(at.getTime() + minutes * 60_000),
});

// Present in the filestore snapshot: everything except the spreadsheet (0d/...).
const present = new Map([
	['/srv/example-filestore/3f/3f9c2a81e0b7d4c1f2a3b4c5d6e7f8091a2b3c4d', 421888],
	['/srv/example-filestore/a7/a71be09d44aabbccddeeff00112233445566778899', 30720],
	['/srv/example-filestore/b1/b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0', 2048],
	['/srv/example-filestore/c4/c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3', 51200],
]);

describe('AttachmentCatalogService', () => {
	let root: string;
	let service: AttachmentCatalogService;
	let plans: Map<string, any>;
	let near: any[];
	let written: number;
	let source: Buffer;
	const recovery = {
		downloadItem: jest.fn(
			async (_backupId: string, _item: string, output: Writable, signal: AbortSignal) => {
				for (let offset = 0; offset < source.length; offset += 256) {
					if (signal.aborted) throw new AppError(409, 'cancelled');
					await new Promise<void>((resolve, reject) =>
						output.write(source.subarray(offset, offset + 256), error => (error ? reject(error) : resolve()))
					);
					written = Math.min(source.length, offset + 256);
				}
			}
		),
		withSnapshotIndex: jest.fn(async (_backupId: string, consume: (index: any) => unknown) =>
			consume({
				get: (item: string) =>
					present.has(item) ? { type: 'file', size: present.get(item) } : undefined,
			})
		),
	};
	const ready = async (backupId = 'backup-files', query = {}) => {
		for (let i = 0; i < 200; i++) {
			const page = await service.page(backupId, query);
			if (page.status === 'ready') return page;
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		throw new Error('catalog never became ready');
	};

	beforeEach(async () => {
		root = await fsp.mkdtemp(path.join(os.tmpdir(), 'attachment-catalog-'));
		plans = new Map<string, any>([
			['plan-files', filesPlan],
			['plan-db', dbPlan],
		]);
		near = [dbBackup('backup-db-near', 15), dbBackup('backup-db-far', -24 * 60), dbBackup('backup-db-nodump', 1, false)];
		written = 0;
		source = dump;
		recovery.downloadItem.mockClear();
		recovery.withSnapshotIndex.mockClear();
		service = new AttachmentCatalogService(
			{ getById: async id => plans.get(id) || null },
			{
				getById: async id => (id === 'backup-files' ? (filesBackup as any) : null),
				completedNear: async () => near,
			},
			recovery,
			root
		);
	});
	afterEach(async () => {
		await service.close();
		await fsp.rm(root, { recursive: true, force: true });
	});

	it('names filestore attachments from the nearest database dump and marks what the snapshot holds', async () => {
		const first = await service.page('backup-files', {});
		expect(first.status).toBe('indexing');
		const page = await ready();
		expect(page.pairing).toEqual({
			adapter: 'odoo',
			databasePlanId: 'plan-db',
			databasePlanName: 'example-db',
			databaseBackupId: 'backup-db-near',
			databaseBackupCompleted: near[0].ended.toISOString(),
			database: 'example_odoo',
			filestoreRoot: '/srv/example-filestore',
		});
		expect(page.counts).toEqual({ attachments: 5, present: 4, missing: 1, notInFilestore: 2, invalid: 0 });
		expect(page.items.map(item => item.name)).toEqual([
			'C:\\Users\\example\\Surat "Resmi".docx',
			'Faktur_Januari.pdf',
			'image_1920',
			'Laporan Tab Baris.xlsx',
			'Ringkasan rapat – Q3 ✓.pdf',
		]);
		expect(page.items.find(item => item.name === 'Faktur_Januari.pdf')).toMatchObject({
			model: 'account.move',
			recordId: 18342,
			mimetype: 'application/pdf',
			present: true,
			snapshotSize: 421888,
		});
		expect(page.models[0]).toEqual({ model: 'account.move', count: 1 });
		// The dump is read through the verified item stream of the paired database backup.
		expect(recovery.downloadItem).toHaveBeenCalledWith(
			'backup-db-near',
			'/pluton/database/example-odoo.sql',
			expect.anything(),
			expect.anything(),
			expect.any(Function)
		);
		expect(recovery.withSnapshotIndex).toHaveBeenCalledWith('backup-files', expect.any(Function), expect.anything());
	});

	it('stops reading the dump once the attachment table ends', async () => {
		source = Buffer.concat([dump, Buffer.from('-- filler\n'.repeat(50_000))]);
		await ready();
		expect(written).toBeLessThan(dump.length);
	});

	it('searches, filters by model and status, sorts and pages', async () => {
		await ready();
		const search = await ready('backup-files', { search: 'faktur' });
		expect(search.items.map(item => item.name)).toEqual(['Faktur_Januari.pdf']);
		// LIKE wildcards in the search are literal.
		expect((await ready('backup-files', { search: '%' })).total).toBe(0);
		expect((await ready('backup-files', { model: 'product.template' })).items[0].field).toBe('image_1920');
		const missing = await ready('backup-files', { status: 'missing' });
		expect(missing.items.map(item => item.name)).toEqual(['Laporan Tab Baris.xlsx']);
		const bySize = await ready('backup-files', { sort: 'size', order: 'desc', limit: 2 });
		expect(bySize.items.map(item => item.size)).toEqual([421888, 90112]);
		expect(bySize).toMatchObject({ total: 5, offset: 0, limit: 2, nextOffset: 2 });
		expect((await ready('backup-files', { offset: 4, limit: 2 })).nextOffset).toBeNull();
	});

	it('resolves a download to the exact snapshot path and the original name', async () => {
		await expect(service.attachmentDownload('backup-files', 1)).rejects.toMatchObject({ statusCode: 409 });
		await ready();
		await expect(service.attachmentDownload('backup-files', 4)).resolves.toEqual({
			itemPath: '/srv/example-filestore/b1/b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0',
			names: { ascii: 'Ringkasan rapat _ Q3 _.pdf', utf8: 'Ringkasan rapat – Q3 ✓.pdf' },
		});
		await expect(service.attachmentDownload('backup-files', 2)).rejects.toMatchObject({ statusCode: 404 });
		await expect(service.attachmentDownload('backup-files', 999)).rejects.toMatchObject({ statusCode: 404 });
		await expect(service.attachmentDownload('backup-files', -1)).rejects.toMatchObject({ statusCode: 400 });
	});

	it('refuses an unconfigured plan, an unfinished snapshot and a database plan without the dump', async () => {
		plans.set('plan-files', { ...filesPlan, settings: {} });
		await expect(service.page('backup-files', {})).rejects.toMatchObject({ statusCode: 404 });
		plans.set('plan-files', filesPlan);
		near = [dbBackup('backup-db-nodump', 1, false)];
		await expect(service.page('backup-files', {})).rejects.toMatchObject({
			statusCode: 409,
			message: expect.stringContaining('No completed backup of the paired database plan'),
		});
		plans.set('plan-db', { ...dbPlan, settings: {} });
		await expect(service.page('backup-files', {})).rejects.toMatchObject({ statusCode: 409 });
		await expect(service.page('backup-missing', {})).rejects.toMatchObject({ statusCode: 404 });
	});

	it('reports a dump without ir_attachment and builds again only on an explicit retry', async () => {
		source = Buffer.from('COPY public.res_partner (id, name) FROM stdin;\n1\tx\n\\.\n');
		await service.page('backup-files', {});
		let failure: unknown;
		for (let i = 0; i < 200 && !failure; i++) {
			await service.page('backup-files', {}).catch(error => (failure = error));
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		expect(failure).toMatchObject({ statusCode: 422, message: expect.stringContaining('no ir_attachment table') });
		expect(recovery.downloadItem).toHaveBeenCalledTimes(1);
		await expect(service.page('backup-files', {})).rejects.toMatchObject({ statusCode: 422 });
		expect(recovery.downloadItem).toHaveBeenCalledTimes(1);
		source = dump;
		await service.page('backup-files', { retry: true });
		await expect(ready()).resolves.toMatchObject({ counts: { attachments: 5 } });
		expect(recovery.downloadItem).toHaveBeenCalledTimes(2);
	});

	it('reports disk limits as 507: too little free space to start, or the catalog filling up', async () => {
		const failure = async () => {
			for (let i = 0; i < 400; i++) {
				const error = await service.page('backup-files', {}).then(
					() => undefined,
					value => value
				);
				if (error) return error;
				await new Promise(resolve => setTimeout(resolve, 5));
			}
		};
		const disk = jest
			.spyOn(fsp, 'statfs')
			.mockResolvedValue({ bavail: (150 * 1024 ** 2) / 4096, bsize: 4096 } as any);
		await expect(failure()).resolves.toMatchObject({
			statusCode: 507,
			message: expect.stringContaining('needs more free disk space'),
		});
		// 200 MiB free is enough to start (128 MiB plus the reserve), well below the 512 MiB cap.
		disk.mockResolvedValue({ bavail: (200 * 1024 ** 2) / 4096, bsize: 4096 } as any);
		await service.page('backup-files', { retry: true });
		await expect(ready()).resolves.toMatchObject({ counts: { attachments: 5 } });
		disk.mockRestore();

		// A catalog that reaches its page cap fails closed with the same status.
		await service.close();
		const rows = Array.from({ length: 5000 }, (_, n) => `${n + 1}\tfile-${n}.pdf\tab/${String(n).padStart(40, '0')}`);
		source = Buffer.from(
			`COPY public.ir_attachment (id, name, store_fname) FROM stdin;\n${rows.join('\n')}\n\\.\n`
		);
		service = new AttachmentCatalogService(
			{ getById: async id => plans.get(id) || null },
			{
				getById: async id => (id === 'backup-files' ? (filesBackup as any) : null),
				completedNear: async () => near,
			},
			recovery,
			root,
			{ ...ATTACHMENT_CATALOG_LIMITS, maxBytes: 64 * 1024, startBytes: 64 * 1024 }
		);
		await expect(failure()).resolves.toMatchObject({
			statusCode: 507,
			message: expect.stringContaining('ran out of disk space or reached its size limit'),
		});
	});

	it('keeps catalogs bounded and removes generated directories on restart', async () => {
		await fsp.mkdir(path.join(root, `catalog-${'d'.repeat(24)}`), { recursive: true });
		await fsp.writeFile(path.join(root, 'unrelated.txt'), 'keep');
		await ready();
		const names = await fsp.readdir(root);
		expect(names).toContain('unrelated.txt');
		expect(names.filter(name => name.startsWith('catalog-'))).toHaveLength(1);
		expect(ATTACHMENT_CATALOG_LIMITS.maxCatalogs).toBeGreaterThan(0);
	});
});

describe('attachment catalog settings', () => {
	const lookup = { getById: async (id: string) => (id === 'plan-db' ? (dbPlan as any) : null) };
	const plan = filesPlan as any;

	it('accepts a pairing with a PostgreSQL database of another Managed Agent plan', async () => {
		await expect(validateAttachmentCatalogSettings(catalog, plan, lookup)).resolves.toEqual(catalog);
		await expect(
			validateAttachmentCatalogSettings({ ...catalog, filestoreRoot: '/srv/example-filestore/odoo/' }, plan, lookup)
		).resolves.toMatchObject({ filestoreRoot: '/srv/example-filestore/odoo' });
		await expect(validateAttachmentCatalogSettings(null, plan, lookup)).resolves.toBeUndefined();
	});

	it.each([
		['an unknown field', { ...catalog, extra: true }, 'invalid'],
		['another adapter', { ...catalog, adapter: 'moodle' }, 'invalid'],
		['a missing database plan', { ...catalog, databasePlanId: 'plan-missing' }, 'not found'],
		['an unknown database entry', { ...catalog, databaseId: 'db_other' }, 'no PostgreSQL database'],
		['itself as the database plan', { ...catalog, databasePlanId: 'plan-files' }, 'different database plan'],
		['a relative filestore folder', { ...catalog, filestoreRoot: 'srv/files' }, 'absolute snapshot path'],
		['a traversing filestore folder', { ...catalog, filestoreRoot: '/srv/../etc' }, 'absolute snapshot path'],
	])('refuses %s', async (_label, value, message) => {
		await expect(validateAttachmentCatalogSettings(value, plan, lookup)).rejects.toThrow(message);
	});

	it('refuses a plan that is not a Managed Agent backup plan', async () => {
		await expect(
			validateAttachmentCatalogSettings(catalog, { ...plan, sourceId: 'main' }, lookup)
		).rejects.toThrow('Managed Agent backup plan');
		await expect(
			validateAttachmentCatalogSettings(catalog, { ...plan, method: 'sync' }, lookup)
		).rejects.toThrow('Managed Agent backup plan');
	});
});
