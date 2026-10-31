import { EventEmitter } from 'events';
import fs from 'fs/promises';
import pino from 'pino';
import { appPaths } from '../../src/utils/AppPaths';
import { closeLoggers, initializeLogger, logger, planLogger } from '../../src/utils/logger';

test('drains real main and plan workers, including immediate shutdown before readiness, and can reinitialize', async () => {
	initializeLogger();
	const main = logger,
		plan = planLogger('lifecycle-test', 'fixture-plan');
	const mainStream = (main as any)[pino.symbols.streamSym];
	const planStream = (plan as any)[pino.symbols.streamSym];
	main.info('Synthetic main lifecycle record');
	plan.info('Synthetic plan lifecycle record');
	await closeLoggers();
	expect(mainStream.closed).toBe(true);
	expect(planStream.closed).toBe(true);
	expect(await fs.readFile(`${appPaths.getLogsDir()}/app.log`, 'utf8')).toContain(
		'Synthetic main lifecycle record'
	);
	expect(await fs.readFile(`${appPaths.getLogsDir()}/plan-fixture-plan.log`, 'utf8')).toContain(
		'Synthetic plan lifecycle record'
	);
	await closeLoggers();
	initializeLogger();
	expect(logger).not.toBe(main);
});

test('shutdown awaits every owned stream, reports a sanitized failure and removes close/error listeners', async () => {
	// Real streams are closed first; only disposable stream doubles are substituted.
	await closeLoggers();
	initializeLogger();
	const main = logger,
		plan = planLogger('lifecycle-test', 'fixture-error-plan');
	const planOwner = Object.getPrototypeOf(plan);
	const realMain = (main as any)[pino.symbols.streamSym],
		realPlan = (plan as any)[pino.symbols.streamSym];
	const failing = Object.assign(new EventEmitter(), {
		end: jest.fn(() =>
			queueMicrotask(() => failing.emit('error', new Error('captured private provider contents')))
		),
	});
	let finish!: () => void;
	const delayed = Object.assign(new EventEmitter(), {
		end: jest.fn(() => {
			finish = () => delayed.emit('close');
		}),
	});
	(main as any)[pino.symbols.streamSym] = failing;
	planOwner[pino.symbols.streamSym] = delayed;
	try {
		let settled = false;
		const work = closeLoggers().finally(() => {
			settled = true;
		});
		const failure = expect(work).rejects.toThrow('Logger transport shutdown failed.');
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(settled).toBe(false);
		finish();
		await failure;
		for (const stream of [failing, delayed]) {
			expect(stream.listenerCount('close')).toBe(0);
			expect(stream.listenerCount('error')).toBe(0);
			expect(stream.end).toHaveBeenCalledTimes(1);
		}
	} finally {
		await Promise.all(
			[realMain, realPlan].map(
				stream =>
					new Promise<void>(resolve => {
						if (stream.closed || stream.destroyed) return resolve();
						stream.once('close', resolve);
						stream.end();
					})
			)
		);
	}
});
