import {
	ArchiveBackendRetries,
	classifyBackendError,
	goDurationMs,
} from '../../../src/utils/restic/archiveBackendRetries';

const retry = (handle: string, length: number, offset: number, delay: string, error: string) =>
	`Load(<data/${handle}>, ${length}, ${offset}) returned error, retrying after ${delay}: ${error}\n`;

describe('archive backend retry summary', () => {
	it('records the exact Restic 0.19.1 retry format as closed fields only', () => {
		let now = 100;
		const parser = new ArchiveBackendRetries(() => now);
		parser.write(
			retry(
				'00e0e0ca8b',
				13960,
				2605056,
				'1.512s',
				'ReadFull(<data/00e0e0ca8b>): unexpected HTTP response (416): partial out of bounds read'
			)
		);
		now = 200;
		parser.write(
			retry('00e0e0ca8b', 13960, 2605056, '1m2.5s', 'ReadFull(<data/00e0e0ca8b>): unexpected EOF')
		);
		expect(parser.lastEventAt).toBe(200);
		expect(parser.snapshot()).toEqual({
			retryCount: 2,
			gaveUpCount: 0,
			recoveredCount: 0,
			serverErrorCount: 0,
			errorClasses: { 'partial-read': 1, 'unexpected-eof': 1 },
			loads: [
				{
					objectType: 'data',
					packPrefix: '00e0e0ca8b',
					length: 13960,
					offset: 2605056,
					attempts: 2,
					lastErrorClass: 'unexpected-eof',
				},
			],
			lastRetryAfterMs: 62_500,
		});
	});

	it('counts give-ups, later success and Rclone server errors with served byte counts', () => {
		const parser = new ArchiveBackendRetries();
		parser.write('Load(<index/abcdef0123>, 0, 0) failed: unexpected HTTP response (503): 503 Service Unavailable\n');
		parser.write('Load(<data/1234567890>, 4096, 0) operation successful after 3 retries\n');
		// Restic forwards Rclone's stderr with an `rclone: ` prefix; the bare form is also accepted.
		parser.write(
			"rclone: 2026/11/12 01:02:03 ERROR : data/00/00e0e0ca8b1eb29c: Didn't finish writing GET request (wrote 2875/13960 bytes): http2: handler wrote more than declared Content-Length\n"
		);
		parser.write('2026/11/12 01:02:04 ERROR : data/00/00e0e0ca8b1eb29c: stream error: stream ID 7; INTERNAL_ERROR\n');
		parser.write("rclone: 2026/11/12 01:02:05 NOTICE: data/00/00e0e0ca8b1eb29c: Not decompressing 'Content-Encoding: gzip' compressed file\n");
		expect(parser.snapshot()).toMatchObject({
			retryCount: 0,
			gaveUpCount: 1,
			recoveredCount: 1,
			serverErrorCount: 2,
			errorClasses: { 'http-status': 1, 'partial-read': 1, 'stream-reset': 1 },
			loads: [{ objectType: 'index', packPrefix: 'abcdef0123', attempts: 1, lastErrorClass: 'http-status', httpStatus: 503 }],
			lastServedBytes: 2875,
			lastExpectedBytes: 13960,
		});
	});

	it('reassembles lines split across chunks and CRLF endings, including a final unterminated line', () => {
		const parser = new ArchiveBackendRetries();
		const line = retry('aaaaaaaaaa', 10, 20, '500ms', 'i/o timeout').trimEnd();
		parser.write(line.slice(0, 17));
		parser.write(line.slice(17, 60));
		parser.write(line.slice(60) + '\r\n' + retry('bbbbbbbbbb', 1, 2, '1s', 'connection reset by peer').trimEnd());
		parser.end();
		const summary = parser.snapshot()!;
		expect(summary.retryCount).toBe(2);
		expect(summary.errorClasses).toEqual({ timeout: 1, 'connection-reset': 1 });
		expect(summary.loads.map(load => load.packPrefix)).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb']);
	});

	it('keeps only the four most recent distinct requests', () => {
		const parser = new ArchiveBackendRetries();
		for (let index = 0; index < 6; index++)
			parser.write(retry(`000000000${index}`, 100, index * 100, '1s', 'unexpected EOF'));
		const summary = parser.snapshot()!;
		expect(summary.retryCount).toBe(6);
		expect(summary.loads.map(load => load.offset)).toEqual([200, 300, 400, 500]);
	});

	it('never retains provider text, hosts, addresses, paths or credentials', () => {
		const parser = new ArchiveBackendRetries();
		const secrets = [
			'synthetic-secret-key',
			'https://tenant.example.internal/bucket-01/managed/plan-01',
			'192.0.2.10',
			'tenant.example.internal',
			'bucket-01',
		];
		parser.write(`raw provider config ${secrets.join(' ')} password=synthetic-secret-key\n`);
		parser.write(
			retry(
				'00e0e0ca8b',
				13960,
				2605056,
				'2s',
				`Get "${secrets[1]}?X-Amz-Signature=deadbeef": dial tcp ${secrets[2]}:443: lookup ${secrets[3]}: no such host`
			)
		);
		parser.write(`2026/11/12 01:02:03 ERROR : ${secrets[1]}: x509: certificate signed by unknown authority ${secrets[0]}\n`);
		parser.write(`Load(<data/${'f'.repeat(64)}>, 1, 1) returned error, retrying after 1s: ${secrets[0]}\n`);
		const serialized = JSON.stringify(parser.snapshot());
		for (const value of [...secrets, 'deadbeef', 'Signature', 'raw provider', 'password'])
			expect(serialized).not.toContain(value);
		expect(parser.snapshot()).toMatchObject({
			retryCount: 2,
			serverErrorCount: 1,
			errorClasses: { 'dns-not-found': 1, tls: 1, other: 1 },
		});
		// A handle longer than Restic's 10-character form is not adopted as an object.
		expect(parser.snapshot()!.loads).toHaveLength(1);
	});

	it('ignores unrelated output and reports nothing when Restic never retried', () => {
		const parser = new ArchiveBackendRetries();
		parser.write('repository 1234abcd opened (version 2, compression level auto)\n');
		parser.write('Load(<data/0123456789>, 1, 1) returned something unexpected\n');
		parser.end();
		expect(parser.snapshot()).toBeUndefined();
		expect(parser.active).toBe(false);
		expect(parser.lastEventAt).toBeUndefined();
	});

	it('bounds an unterminated oversized line and the number of parsed lines', () => {
		const long = new ArchiveBackendRetries();
		long.write('x'.repeat(5000));
		long.write(retry('0123456789', 1, 1, '1s', 'unexpected EOF'));
		expect(long.snapshot()).toMatchObject({ retryCount: 1, truncated: true });

		const many = new ArchiveBackendRetries();
		many.write(retry('0123456789', 1, 1, '1s', 'unexpected EOF').repeat(20_005));
		expect(many.snapshot()).toMatchObject({ retryCount: 20_000, truncated: true });
		expect(many.snapshot()!.loads[0].attempts).toBe(20_000);
	});

	it.each([
		['unexpected HTTP response (416): partial out of bounds read', 'partial-read', 416],
		['net/http: server replied with more than declared Content-Length; truncated', 'partial-read', undefined],
		['http2: handler wrote more than declared Content-Length', 'partial-read', undefined],
		['unexpected HTTP response (500): 500 Internal Server Error', 'http-status', 500],
		['operation error S3: GetObject, https response error StatusCode: 503', 'http-status', 503],
		['ReadFull(<data/0123456789>): unexpected EOF', 'unexpected-eof', undefined],
		['stream error: stream ID 5; INTERNAL_ERROR; received from peer', 'stream-reset', undefined],
		['read tcp 192.0.2.10:443: i/o timeout', 'timeout', undefined],
		['context deadline exceeded', 'timeout', undefined],
		['read: connection reset by peer', 'connection-reset', undefined],
		['dial tcp: lookup tenant.example.internal on 127.0.0.11:53: no such host', 'dns-not-found', undefined],
		['tls: failed to verify certificate: x509: certificate signed by unknown authority', 'tls', undefined],
		['<data/0123456789> does not exist', 'not-found', undefined],
		['something else entirely', 'other', undefined],
	])('classifies %s', (text, errorClass, httpStatus) => {
		expect(classifyBackendError(text)).toEqual({
			errorClass,
			...(httpStatus === undefined ? {} : { httpStatus }),
		});
	});

	it.each([
		['720.383787ms', 720],
		['1.5s', 1500],
		['1m2.5s', 62_500],
		['1h0m0s', 3_600_000],
		['500µs', 1],
		['48h0m0s', 24 * 60 * 60_000],
		['soon', undefined],
		['1.5', undefined],
	])('parses Go duration %s', (text, expected) => {
		expect(goDurationMs(text)).toBe(expected);
	});
});
