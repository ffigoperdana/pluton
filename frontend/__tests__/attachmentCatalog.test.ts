import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
   AttachmentCatalogError,
   attachmentCatalogUrl,
   downloadCatalogAttachment,
   fetchAttachmentCatalog,
   parseAttachmentCatalogPage,
   type AttachmentCatalogItem,
   type AttachmentCatalogQuery,
} from '../src/utils/attachmentCatalog.ts';
import { attachmentTypeLabel, catalogProgressText } from '../src/utils/attachmentCatalogLabels.ts';
import { catalogDatabaseOptions, catalogPlanOptions } from '../src/utils/attachmentCatalogSettings.ts';
const require = createRequire(new URL('../package.json', import.meta.url));
const { JSDOM } = require('jsdom');

const query: AttachmentCatalogQuery = { offset: 0, limit: 50 };
const pairing = {
   adapter: 'odoo',
   databasePlanId: 'plan-db',
   databasePlanName: 'example-db',
   databaseBackupId: 'backup-db',
   databaseBackupCompleted: '2026-11-19T18:30:00.000Z',
   database: 'example_odoo',
   filestoreRoot: '/srv/example-filestore',
};
const item: AttachmentCatalogItem = {
   id: 1,
   name: 'Faktur_Januari.pdf',
   mimetype: 'application/pdf',
   size: 421888,
   model: 'account.move',
   recordId: 18342,
   field: null,
   created: '2026-01-05 08:15:00',
   storedPath: '3f/3f9c2a81e0b7d4c1f2a3b4c5d6e7f8091a2b3c4d',
   present: true,
   snapshotSize: 421888,
};
const ready = {
   status: 'ready',
   pairing,
   counts: { attachments: 5, present: 4, missing: 1, notInFilestore: 2, invalid: 0 },
   models: [{ model: 'account.move', count: 1 }],
   total: 1,
   offset: 0,
   limit: 50,
   nextOffset: null,
   items: [item],
};

test('accepts verified ready and indexing catalog pages', () => {
   assert.deepEqual(parseAttachmentCatalogPage({ result: ready }, query), ready);
   const indexing = {
      status: 'indexing',
      retryAfterMs: 2000,
      pairing,
      progress: { phase: 'database-dump', dumpBytes: 10, dumpTotal: 100, attachments: 3, matched: 0, elapsedMs: 5 },
   };
   assert.deepEqual(parseAttachmentCatalogPage({ result: indexing }, query), indexing);
});

test('refuses catalog pages that do not match the request or the contract', () => {
   const refused = [
      { ...ready, offset: 50 },
      { ...ready, items: [{ ...item, present: 'yes' }] },
      { ...ready, items: [{ ...item, name: 'x'.repeat(256) }] },
      { ...ready, items: Array.from({ length: 51 }, () => item) },
      { ...ready, pairing: { ...pairing, filestoreRoot: 'relative' } },
      { ...ready, nextOffset: 0 },
      { status: 'indexing', retryAfterMs: 0, pairing, progress: {} },
      { status: 'other' },
   ];
   for (const result of refused) assert.throws(() => parseAttachmentCatalogPage({ result }, query), AttachmentCatalogError);
});

test('builds the catalog URL with only the filters in use', () => {
   const url = new URL(
      attachmentCatalogUrl('https://example.internal/api', 'backup 01', {
         offset: 50,
         limit: 25,
         search: 'Faktur & co',
         model: 'account.move',
         status: 'all',
         sort: 'size',
         order: 'desc',
         retry: true,
      }),
   );
   assert.equal(url.pathname, '/api/backups/backup%2001/attachments');
   assert.deepEqual(Object.fromEntries(url.searchParams), {
      offset: '50',
      limit: '25',
      search: 'Faktur & co',
      model: 'account.move',
      sort: 'size',
      order: 'desc',
      retry: 'true',
   });
});

test('surfaces the server message and status of a failed catalog request', async () => {
   const old = globalThis.fetch;
   globalThis.fetch = async () =>
      new Response(JSON.stringify({ success: false, error: 'The paired database dump has no ir_attachment table.' }), {
         status: 422,
         headers: { 'Content-Type': 'application/json' },
      });
   try {
      await assert.rejects(fetchAttachmentCatalog('https://example.internal/api', 'backup-01', query), (error: unknown) => {
         assert.ok(error instanceof AttachmentCatalogError);
         assert.equal(error.status, 422);
         assert.match(error.message, /no ir_attachment table/);
         return true;
      });
   } finally {
      globalThis.fetch = old;
   }
});

test('downloads only after verifying the original-name metadata', async () => {
   const dom = new JSDOM('', { url: 'https://example.internal/' }),
      old = globalThis.fetch,
      descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
   Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
   const clicked: string[] = [];
   dom.window.HTMLAnchorElement.prototype.click = function () {
      clicked.push(this.href);
   };
   const head = (disposition: string, length = '421888') =>
      (globalThis.fetch = async (input, options) => {
         assert.equal(options?.method, 'HEAD');
         assert.equal(new URL(String(input)).pathname, '/api/backups/backup-01/attachments/1/download');
         return new Response(null, {
            headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': length, 'Content-Disposition': disposition },
         });
      });
   try {
      head(`attachment; filename="Ringkasan rapat _ Q3 _.pdf"; filename*=UTF-8''Ringkasan%20rapat%20%E2%80%93%20Q3%20%E2%9C%93.pdf`);
      await downloadCatalogAttachment('https://example.internal/api', 'backup-01', item, new AbortController().signal);
      assert.deepEqual(clicked, ['https://example.internal/api/backups/backup-01/attachments/1/download']);
      for (const [disposition, length] of [
         ['attachment; filename="../x"', '421888'],
         ['inline; filename="a.pdf"', '421888'],
         ['attachment; filename="a.pdf"', '1'],
      ]) {
         head(disposition, length);
         await assert.rejects(downloadCatalogAttachment('https://example.internal/api', 'backup-01', item, new AbortController().signal));
      }
      assert.equal(clicked.length, 1);
   } finally {
      globalThis.fetch = old;
      if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
      else delete (globalThis as { document?: unknown }).document;
   }
});

test('labels attachment types and catalog progress', () => {
   assert.equal(attachmentTypeLabel({ mimetype: 'application/pdf', name: 'x' }), 'PDF');
   assert.equal(attachmentTypeLabel({ mimetype: null, name: 'Rekap.xlsx' }), 'XLSX');
   assert.equal(attachmentTypeLabel({ mimetype: 'application/x-custom', name: 'image_1920' }), 'X-CUSTOM');
   assert.equal(attachmentTypeLabel({ mimetype: null, name: 'image_1920' }), '—');
   const bytes = (value: number) => `${value} B`;
   const progress = { dumpBytes: 10, dumpTotal: 100, attachments: 3, matched: 1, elapsedMs: 0 };
   assert.match(catalogProgressText({ ...progress, phase: 'database-dump' }, bytes), /10 B of at most 100 B/);
   assert.match(catalogProgressText({ ...progress, phase: 'matching' }, bytes), /1 of 3/);
   assert.match(catalogProgressText({ ...progress, phase: 'waiting' }, bytes), /Waiting/);
});

test('offers only other Managed Agent plans that dump a PostgreSQL database', () => {
   const postgres = { databaseId: 'db_example01', engine: 'postgresql', database: 'example_odoo', dumpFilename: 'example-odoo.sql' };
   const plan = (id: string, extra: object) =>
      ({ id, title: id, sourceType: 'device', sourceId: 'device-01', method: 'backup', settings: {}, ...extra }) as any;
   const plans = [
      plan('plan-db', { settings: { remoteLifecycle: { version: 2, databases: [postgres] } } }),
      plan('plan-mariadb', { settings: { remoteLifecycle: { version: 2, databases: [{ ...postgres, engine: 'mariadb' }] } } }),
      plan('plan-local', { sourceId: 'main', settings: { remoteLifecycle: { version: 2, databases: [postgres] } } }),
      plan('plan-files', { settings: { remoteLifecycle: { version: 2, databases: [postgres] } } }),
   ];
   assert.deepEqual(
      catalogPlanOptions(plans, 'plan-files').map((entry) => entry.id),
      ['plan-db'],
   );
   assert.deepEqual(
      catalogDatabaseOptions(plans[0]).map((entry) => entry.databaseId),
      ['db_example01'],
   );
});
