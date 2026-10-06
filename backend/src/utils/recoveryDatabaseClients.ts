import { spawnSync } from 'child_process';
import { accessSync, constants, lstatSync, readdirSync, realpathSync } from 'fs';
import path from 'path';
import type { RecoveryEngine } from '../types/recoveryTests';
import { RecoveryTestError } from './recoveryValidation';

export function assertRecoveryClientPath(value: string, executable = true): string {
	if (process.platform !== 'linux' || process.getuid?.() === 0)
		throw new RecoveryTestError('database-target-preflight', 'recovery-target-unsafe');
	const real = realpathSync(value);
	let current = real;
	while (true) {
		const stat = lstatSync(current);
		if (stat.uid !== 0 || stat.isSymbolicLink() || stat.mode & 0o6022) throw new Error('unsafe');
		if (current === path.dirname(current)) break;
		current = path.dirname(current);
	}
	if (!lstatSync(real).isFile()) throw new Error('unsafe');
	accessSync(real, executable ? constants.X_OK : constants.R_OK);
	return real;
}

/** Fixed administrator-controlled paths only; no PATH lookup or UI-selected executable. */
export function detectRecoveryClient(engine: RecoveryEngine): string {
	if (process.platform !== 'linux' || process.getuid?.() === 0)
		throw new RecoveryTestError('database-target-preflight', 'recovery-target-unsafe');
	const candidates =
		engine === 'postgresql'
			? ['/usr/bin/psql']
			: engine === 'mysql'
				? ['/usr/bin/mysql']
				: ['/usr/bin/mariadb', '/usr/bin/mysql'];
	let incompatible = false;
	if (engine === 'postgresql') {
		try {
			candidates.push(
				...readdirSync('/usr/lib/postgresql')
					.filter(value => /^\d+$/.test(value))
					.sort((a, b) => Number(b) - Number(a))
					.map(value => `/usr/lib/postgresql/${value}/bin/psql`)
			);
		} catch {
			/* Not a Debian-style install. */
		}
	}
	for (const candidate of candidates) {
		try {
			const binary = assertRecoveryClientPath(candidate);
			incompatible = true;
			const probe = spawnSync(
				binary,
				engine === 'postgresql'
					? ['--version']
					: [
							'--no-defaults',
							'--binary-mode',
							'--local-infile=0',
							...(engine === 'mariadb' ? ['--sandbox'] : []),
							'--version',
						],
				{
					shell: false,
					timeout: 2000,
					maxBuffer: 4096,
					encoding: 'utf8',
					env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
				}
			);
			if (probe.status !== 0 || probe.error) continue;
			if (engine === 'mariadb' && /MariaDB/i.test(probe.stdout)) return binary;
			if (
				engine === 'mysql' &&
				/MySQL|mysql.*Ver\s+8/i.test(probe.stdout) &&
				!/MariaDB/i.test(probe.stdout)
			)
				return binary;
			if (engine === 'postgresql') {
				const version = /psql \(PostgreSQL\) (\d+)\.(\d+)/.exec(probe.stdout);
				// \restrict security fixes: 13.22 / 14.19 / 15.14 / 16.10 / 17.6 / 18+.
				if (
					version &&
					(Number(version[1]) >= 18 ||
						Number(version[2]) >=
							({ 13: 22, 14: 19, 15: 14, 16: 10, 17: 6 } as Record<number, number>)[
								Number(version[1])
							])
				)
					return binary;
			}
		} catch {
			/* Missing/unsafe executables are not executed. */
		}
	}
	throw new RecoveryTestError(
		'database-target-preflight',
		incompatible ? 'database-client-incompatible' : 'database-client-missing'
	);
}

export function recoveryTrustFile() {
	try {
		return assertRecoveryClientPath('/etc/ssl/certs/ca-certificates.crt', false);
	} catch {
		throw new RecoveryTestError('database-target-preflight', 'database-tls-failed');
	}
}
