import { readFileSync } from 'fs';
import { assertRecoveryClientPath } from '../utils/recoveryDatabaseClients';
import { startMysqlWorker } from './server';
import { workerConfigSchema } from './protocol';

try {
	const config = workerConfigSchema.parse(
		JSON.parse(
			readFileSync(assertRecoveryClientPath('/run/pluton-mysql-config/target.json', false), 'utf8')
		)
	);
	const ca = assertRecoveryClientPath('/run/pluton-mysql-config/ca.pem', false);
	const worker = await startMysqlWorker(config, () => ca);
	for (const event of ['SIGTERM', 'SIGINT'] as const)
		process.once(event, () => {
			void worker.stop().finally(() => process.exit(0));
		});
} catch {
	process.stderr.write(
		'MySQL recovery worker startup refused; check private IPC, approved target, trust and native client configuration.\n'
	);
	process.exitCode = 1;
}
