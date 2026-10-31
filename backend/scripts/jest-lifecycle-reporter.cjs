// Test diagnostics only. Never inspect environment, arguments, handles, sockets,
// provider output or whole diagnostic reports: those can contain credentials.
const resourceTypes = new Set([
	'Timeout',
	'Immediate',
	'MessagePort',
	'Worker',
	'PipeWrap',
	'TTYWrap',
	'TCPServerWrap',
	'TCPSocketWrap',
	'TLSWrap',
	'ProcessWrap',
	'SignalWrap',
	'FSEventWrap',
	'FSReqCallback',
	'FSReqPromise',
	'DNSCHANNEL',
	'UDPWrap',
]);
function summarizeResources(resources) {
	const counts = {};
	for (const resource of resources.slice(0, 4096)) {
		const type = resourceTypes.has(resource) ? resource : 'Other';
		counts[type] = (counts[type] || 0) + 1;
	}
	return { counts, truncated: resources.length > 4096 };
}
class JestLifecycleReporter {
	emit(phase, results = {}) {
		const count = key =>
			Number.isSafeInteger(results[key]) && results[key] >= 0 ? results[key] : 0;
		process.stderr.write(
			'[jest-lifecycle] ' +
				JSON.stringify({
					phase,
					suites: count('numTotalTestSuites'),
					failedSuites: count('numFailedTestSuites'),
					passedTests: count('numPassedTests'),
					failedTests: count('numFailedTests'),
					resources: summarizeResources(process.getActiveResourcesInfo()),
					hint: 'Use pnpm --filter @plutonhq/core-backend test --runInBand --detectOpenHandles to locate allocation stacks. No forceExit.',
				}) +
				'\n'
		);
	}
	onRunStart() {
		this.deadline = setTimeout(() => this.emit('nine-minutes-still-running'), 9 * 60_000);
		this.deadline.unref();
	}
	onRunComplete(_contexts, results) {
		clearTimeout(this.deadline);
		if (results.numFailedTests || results.numFailedTestSuites || results.wasInterrupted)
			this.emit('assertion-failure-or-interrupted', results);
		this.pendingExit = setTimeout(
			() => this.emit('suites-finished-process-still-active', results),
			5000
		);
		this.pendingExit.unref();
	}
}
module.exports = JestLifecycleReporter;
module.exports.summarizeResources = summarizeResources;
