import { readFileSync } from 'fs';

let stage = 'module-loading';
try {
	// Keep module-evaluation failures inside the same redacted startup boundary.
	const { assertRecoveryClientPath } = await import('../utils/recoveryDatabaseClients');
	const { startMysqlWorker } = await import('./server');
	const { workerConfigSchema } = await import('./protocol');
	stage = 'configuration';
	const config = workerConfigSchema.parse(
		JSON.parse(
			readFileSync(assertRecoveryClientPath('/run/pluton-mysql-config/target.json', false), 'utf8')
		)
	);
	// Internal-only workers have no static Custom target or CA; authority is
	// independently read from per-operation root proof, never from caller paths.
	stage = 'trust';
	const ca = config.host
		? assertRecoveryClientPath('/run/pluton-mysql-config/ca.pem', false)
		: undefined;
	const worker = await startMysqlWorker(
		config,
		() => {
			if (!ca) throw new Error('Custom trust not configured.');
			return ca;
		},
		value => {
			stage = value;
		}
	);
	process.stdout.write(
		JSON.stringify({ event: 'mysql-worker-startup', stage: 'ready', status: 'ready' }) + '\n'
	);
	for (const event of ['SIGTERM', 'SIGINT'] as const)
		process.once(event, () => {
			void worker.stop().finally(() => process.exit(0));
		});
} catch {
	process.stderr.write(
		JSON.stringify({ event: 'mysql-worker-startup', stage, status: 'refused' }) + '\n'
	);
	process.exitCode = 1;
}
