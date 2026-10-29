import { Writable } from 'stream';
import { observeTransfer, transferReason } from '../../src/utils/managedExport/TransferTelemetry';

describe('bounded sanitized transfer telemetry', () => {
	test('counts completed socket writes, real backpressure and first-byte timing once', async () => {
		let time = 0;
		const records: Record<string, unknown>[] = [];
		const response = Object.assign(
			new Writable({
				highWaterMark: 1,
				write(_chunk, _encoding, done) {
					setImmediate(() => {
						time += 100;
						done();
					});
				},
			}),
			{ statusCode: 200 }
		);
		const meter = observeTransfer(
			response as any,
			'standard',
			r => records.push(r),
			() => time
		);
		for (let n = 0; n < 3; n++)
			await new Promise<void>((resolve, reject) =>
				meter.output.write(Buffer.alloc(1024), error => (error ? reject(error) : resolve()))
			);
		meter.finish('origin-stream-complete');
		meter.finish('must-not-repeat');
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			originAcceptedBytes: 3072,
			timeToFirstByteMs: 100,
			elapsedMs: 300,
			backpressureMs: 300,
			reason: 'origin-stream-complete',
		});
		expect(records[0].averageBytesPerSecond).toBe(10240);
		expect(JSON.stringify(records)).not.toContain('must-not-repeat');
		response.destroy();
	});
	test('peer close destroys the bounded destination and raw failure details are never copied', () => {
		const response = Object.assign(
				new Writable({
					write(_chunk, _encoding, done) {
						done();
					},
				}),
				{ statusCode: 200 }
			),
			records: Record<string, unknown>[] = [];
		const meter = observeTransfer(response as any, 'reliable-proxy', r => records.push(r));
		response.emit('close');
		expect(meter.output.destroyed).toBe(true);
		meter.finish('peer-closed');
		expect(
			transferReason({ message: 'captured-provider-contents', code: 'untrusted-provider-value' })
		).toBe('archive-interrupted');
		expect(JSON.stringify(records)).not.toMatch(/captured-provider|untrusted-provider/);
		response.destroy();
	});
});
