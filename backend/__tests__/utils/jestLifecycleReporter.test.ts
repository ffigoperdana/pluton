import { spawnSync } from 'child_process';
import path from 'path';
const Reporter = require('../../scripts/jest-lifecycle-reporter.cjs');
afterEach(() => {
	jest.useRealTimers();
	jest.restoreAllMocks();
});
test('diagnostics expose bounded resource type counts and never unknown contents', () => {
	const report = Reporter.summarizeResources([
		'MessagePort',
		'MessagePort',
		'Timeout',
		'captured private provider output',
	]);
	expect(report).toEqual({ counts: { MessagePort: 2, Timeout: 1, Other: 1 }, truncated: false });
	expect(JSON.stringify(report)).not.toContain('captured private provider output');
	expect(Reporter.summarizeResources(Array(5000).fill('Timeout'))).toEqual({
		counts: { Timeout: 4096 },
		truncated: true,
	});
});
test('post-suite diagnostics distinguish failed assertions from a process that stays alive', () => {
	jest.useFakeTimers();
	const emit = jest.spyOn(Reporter.prototype, 'emit').mockImplementation(() => undefined);
	const reporter = new Reporter();
	reporter.onRunStart();
	reporter.onRunComplete(null, { numFailedTests: 1 });
	expect(emit).toHaveBeenCalledWith('assertion-failure-or-interrupted', { numFailedTests: 1 });
	jest.advanceTimersByTime(5000);
	expect(emit).toHaveBeenCalledWith('suites-finished-process-still-active', { numFailedTests: 1 });
	emit.mockClear();
	jest.advanceTimersByTime(9 * 60000);
	expect(emit).not.toHaveBeenCalled();
});
test('a stuck in-progress run gets a bounded warning before the workflow timeout', () => {
	jest.useFakeTimers();
	const emit = jest.spyOn(Reporter.prototype, 'emit').mockImplementation(() => undefined);
	new Reporter().onRunStart();
	jest.advanceTimersByTime(9 * 60000);
	expect(emit).toHaveBeenCalledWith('nine-minutes-still-running');
});
test('diagnostic timers never keep an otherwise finished Node process alive', () => {
	const moduleFile = path.resolve(__dirname, '../../scripts/jest-lifecycle-reporter.cjs');
	const result = spawnSync(
		process.execPath,
		[
			'-e',
			'const R=require(process.argv[1]);const r=new R();r.onRunStart();r.onRunComplete(null,{numFailedTests:0});',
			moduleFile,
		],
		{ encoding: 'utf8', timeout: 5000 }
	);
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	expect(result.status).toBe(0);
	expect(result.stderr).toBe('');
});
