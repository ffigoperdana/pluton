import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
   MinioObjectError,
   downloadMinioObject,
   fetchMinioObjects,
   minioDataDirectoriesUrl,
   minioObjectDownloadUrl,
   minioObjectsUrl,
   nameBelow,
   parseMinioDataDirectories,
   parseMinioObjectPage,
   prefixCrumbs,
   type MinioObjectItem,
   type MinioObjectQuery,
} from '../src/utils/minioObjects.ts';
import { minioDataDirectoryProblem, minioProgressText, minioStatusLabel, minioStorageLabel } from '../src/utils/minioObjectLabels.ts';
const require = createRequire(new URL('../package.json', import.meta.url));
const { JSDOM } = require('jsdom');

const api = 'https://example.internal/api';
const query: MinioObjectQuery = { dataDir: '/srv/example-app/minio', bucket: 'example-bucket', offset: 0, limit: 100 };
const item: MinioObjectItem = {
   id: 4,
   key: 'dokumen/laporan akhir é.txt',
   versionId: 'null',
   latest: true,
   deleteMarker: false,
   size: 37,
   modified: '2026-11-26T22:36:23.419Z',
   etag: 'fd9fa7adc619958cf59f4f98b8d2d29a',
   contentType: 'text/plain',
   parts: 1,
   inline: true,
   compressed: false,
   versions: 1,
   status: 'supported',
   reason: null,
};
const ready = {
   status: 'ready',
   dataDir: query.dataDir,
   bucket: query.bucket,
   prefix: 'dokumen/',
   counts: { objects: 11, deleted: 0, unsupported: 1, versions: 11, bytes: 26_000_000 },
   folders: [{ prefix: 'dokumen/arsip/', objects: 2 }],
   foldersTruncated: false,
   total: 1,
   offset: 0,
   limit: 100,
   nextOffset: null,
   items: [item],
};

test('accepts verified data-folder responses and refuses anything else', () => {
   const dataDirs = {
      status: 'ready',
      dataDirs: [
         {
            path: '/srv/example-app/minio',
            format: 'xl-single',
            drives: 1,
            supported: true,
            bucketsTruncated: false,
            buckets: [{ name: 'example-bucket', objects: 11, metadataBytes: 13_000, legacyObjects: 0 }],
         },
      ],
   };
   assert.deepEqual(parseMinioDataDirectories({ result: dataDirs }), dataDirs);
   const indexing = { status: 'indexing', retryAfterMs: 2000, entries: 100, elapsedMs: 5 };
   assert.deepEqual(parseMinioDataDirectories({ result: indexing }), indexing);
   for (const broken of [
      { ...dataDirs, dataDirs: [{ ...dataDirs.dataDirs[0], path: 'relative' }] },
      { ...dataDirs, dataDirs: [{ ...dataDirs.dataDirs[0], format: 'gateway' }] },
      { ...dataDirs, dataDirs: [{ ...dataDirs.dataDirs[0], buckets: [{ name: '../etc', objects: 1, metadataBytes: 1, legacyObjects: 0 }] }] },
      { ...indexing, retryAfterMs: 0 },
      { status: 'ready' },
   ])
      assert.throws(() => parseMinioDataDirectories({ result: broken }), MinioObjectError);
});

test('accepts a verified object page only for the request it answers', () => {
   const request = { ...query, prefix: 'dokumen/' };
   assert.deepEqual(parseMinioObjectPage({ result: ready }, request), ready);
   const indexing = {
      status: 'indexing',
      retryAfterMs: 2000,
      progress: { phase: 'metadata-restore', metadataFiles: 11, metadataBytes: 13_000, parsed: 0, indexedEntries: 0, elapsedMs: 9 },
   };
   assert.deepEqual(parseMinioObjectPage({ result: indexing }, request), indexing);
   for (const broken of [
      { ...ready, bucket: 'other-bucket' },
      { ...ready, prefix: '' },
      { ...ready, offset: 100 },
      { ...ready, items: [{ ...item, key: 'elsewhere.txt' }] },
      { ...ready, items: [{ ...item, status: 'gateway' }] },
      { ...ready, items: [{ ...item, size: -1 }] },
      { ...ready, folders: [{ prefix: 'dokumen/arsip', objects: 2 }] },
      { ...indexing, progress: { ...indexing.progress, phase: 'mounting' } },
   ])
      assert.throws(() => parseMinioObjectPage({ result: broken }, request), MinioObjectError);
});

test('builds request URLs with only the options that are set', () => {
   assert.equal(minioDataDirectoriesUrl(api, 'backup 01'), `${api}/backups/backup%2001/minio`);
   assert.equal(minioDataDirectoriesUrl(api, 'backup-01', true), `${api}/backups/backup-01/minio?retry=true`);
   const url = new URL(
      minioObjectsUrl(api, 'backup-01', {
         ...query,
         prefix: 'dokumen/',
         search: 'laporan',
         versions: 'all',
         sort: 'size',
         order: 'desc',
         retry: true,
      }),
   );
   assert.equal(url.pathname, '/api/backups/backup-01/minio/objects');
   assert.deepEqual(Object.fromEntries(url.searchParams), {
      dataDir: '/srv/example-app/minio',
      bucket: 'example-bucket',
      offset: '0',
      limit: '100',
      prefix: 'dokumen/',
      search: 'laporan',
      versions: 'all',
      sort: 'size',
      order: 'desc',
      retry: 'true',
   });
   assert.equal(new URL(minioObjectsUrl(api, 'backup-01', { ...query, versions: 'latest' })).searchParams.has('versions'), false);
   assert.equal(
      minioObjectDownloadUrl(api, 'backup-01', query, item),
      `${api}/backups/backup-01/minio/objects/4/download?dataDir=%2Fsrv%2Fexample-app%2Fminio&bucket=example-bucket`,
   );
});

test('passes server refusals through with their status', async () => {
   const old = globalThis.fetch;
   globalThis.fetch = async () =>
      new Response(JSON.stringify({ success: false, error: 'This MinIO deployment spreads objects over 4 drives (erasure coding).' }), {
         status: 409,
      });
   try {
      await assert.rejects(fetchMinioObjects(api, 'backup-01', query), (error: unknown) => {
         assert.ok(error instanceof MinioObjectError);
         assert.equal(error.status, 409);
         assert.match(error.message, /4 drives/);
         return true;
      });
   } finally {
      globalThis.fetch = old;
   }
});

test('downloads only after verifying the object metadata', async () => {
   const dom = new JSDOM('', { url: 'https://example.internal/' }),
      old = globalThis.fetch,
      descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
   Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
   const clicked: string[] = [];
   dom.window.HTMLAnchorElement.prototype.click = function () {
      clicked.push(this.href);
   };
   const head = (disposition: string, length = '37', status = 200) =>
      (globalThis.fetch = async (input, options) => {
         assert.equal(options?.method, 'HEAD');
         assert.equal(new URL(String(input)).pathname, '/api/backups/backup-01/minio/objects/4/download');
         return new Response(null, {
            status,
            headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': length, 'Content-Disposition': disposition },
         });
      });
   try {
      head(`attachment; filename="laporan akhir _.txt"; filename*=UTF-8''laporan%20akhir%20%C3%A9.txt`);
      await downloadMinioObject(api, 'backup-01', query, item, new AbortController().signal);
      assert.deepEqual(clicked, [minioObjectDownloadUrl(api, 'backup-01', query, item)]);
      for (const [disposition, length] of [
         ['attachment; filename="../x"', '37'],
         ['inline; filename="a.txt"', '37'],
         ['attachment; filename="a.txt"', '36'],
      ]) {
         head(disposition, length);
         await assert.rejects(downloadMinioObject(api, 'backup-01', query, item, new AbortController().signal));
      }
      head('attachment; filename="a.txt"', '37', 409);
      await assert.rejects(downloadMinioObject(api, 'backup-01', query, item, new AbortController().signal), /expired/);
      await assert.rejects(
         downloadMinioObject(
            api,
            'backup-01',
            query,
            { ...item, status: 'encrypted', reason: 'This object is encrypted.' },
            new AbortController().signal,
         ),
         /encrypted/,
      );
      assert.equal(clicked.length, 1);
   } finally {
      globalThis.fetch = old;
      if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
      else delete (globalThis as { document?: unknown }).document;
   }
});

test('labels statuses, storage, progress, data folders and paths', () => {
   assert.equal(minioStatusLabel({ status: 'encrypted' }), 'Encrypted (SSE)');
   assert.equal(minioStatusLabel({ status: 'delete-marker' }), 'Deleted');
   assert.equal(minioStorageLabel({ status: 'supported', inline: false, compressed: true, parts: 3 }), '3 parts · S2');
   assert.equal(minioStorageLabel({ status: 'supported', inline: true, compressed: false, parts: 1 }), 'inline');
   assert.equal(minioStorageLabel({ status: 'encrypted', inline: true, compressed: false, parts: 1 }), '');
   const bytes = (value: number) => `${value} B`;
   const progress = { metadataFiles: 11, metadataBytes: 13_000, parsed: 4, indexedEntries: 120, elapsedMs: 0 };
   assert.match(minioProgressText({ ...progress, phase: 'snapshot-index' }, bytes), /120 entries/);
   assert.match(minioProgressText({ ...progress, phase: 'metadata-restore' }, bytes), /11 xl\.meta files \(13000 B\)/);
   assert.match(minioProgressText({ ...progress, phase: 'parsing' }, bytes), /4 of 11/);
   assert.match(minioProgressText({ ...progress, phase: 'waiting' }, bytes), /Waiting/);
   assert.equal(minioDataDirectoryProblem({ format: 'xl-single', drives: 1, supported: true }), null);
   assert.match(minioDataDirectoryProblem({ format: 'xl', drives: 4, supported: false })!, /4 drives/);
   assert.match(minioDataDirectoryProblem({ format: 'fs', drives: 0, supported: false })!, /Files view/);
   assert.deepEqual(prefixCrumbs('docs/2026/'), [
      ['docs/', 'docs'],
      ['docs/2026/', '2026'],
   ]);
   assert.deepEqual(prefixCrumbs(''), []);
   assert.equal(nameBelow('docs/', 'docs/report.pdf'), 'report.pdf');
   assert.equal(nameBelow('folder/', 'folder/'), 'folder/');
});
