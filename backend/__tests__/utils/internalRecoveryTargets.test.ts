import {
	assertInternalResources,
	InternalRecoveryTargets,
	mysqlWorkerReadiness,
} from '../../src/utils/internalRecoveryTargets';
import { recoveryPolicySchema } from '../../src/utils/recoveryTestPolicy';
const MiB = 1024 ** 2;
const healthy = {
	total: 8192 * MiB,
	available: 4096 * MiB,
	swapUsed: 0,
	pressure: 0,
	limit: 2048 * MiB,
	used: 512 * MiB,
	cgroupSwap: 0,
	diskAvailable: 10240 * MiB,
};
describe('internal recovery admission and safe public configuration', () => {
	it('admits a bounded artifact only with measured host/server headroom', () => {
		expect(() => assertInternalResources(healthy, 272 * MiB, 384 * MiB)).not.toThrow();
	});
	for (const change of [
		{ total: 3072 * MiB },
		{ available: 2048 * MiB },
		{ swapUsed: 129 * MiB },
		{ pressure: 1.1 },
		{ cgroupSwap: 1 },
		{ limit: 512 * MiB },
		{ limit: 0 },
		{ used: 1900 * MiB },
		{ diskAvailable: 1024 * MiB },
		{ available: NaN },
		{ pressure: -1 },
	]) {
		it(`refuses insufficient or unknown ${Object.keys(change)[0]}`, () => {
			expect(() =>
				assertInternalResources({ ...healthy, ...change }, 272 * MiB, 384 * MiB)
			).toThrow('internal-resources-insufficient');
		});
	}
	for (const [bytes, cap] of [
		[0, 128],
		[-1, 128],
		[129 * MiB, 128 * MiB],
		[449 * MiB, 512 * MiB],
		[1.5, 128 * MiB],
	])
		it(`rejects invalid/oversized SQL budget ${bytes}`, () => {
			expect(() => assertInternalResources(healthy, bytes, cap)).toThrow(
				'internal-resources-insufficient'
			);
		});
	it('defaults to Custom and rejects MySQL Internal and arbitrary target options', () => {
		expect(
			recoveryPolicySchema.parse({ enabled: false, databaseImport: 'required' }).targetModes
		).toBeUndefined();
		expect(
			recoveryPolicySchema.safeParse({
				enabled: false,
				databaseImport: 'required',
				targetModes: { mysql: 'internal' },
			}).success
		).toBe(false);
		expect(
			recoveryPolicySchema.safeParse({
				enabled: false,
				databaseImport: 'required',
				targetModes: { mariadb: 'internal', postgresql: 'custom' },
			}).success
		).toBe(true);
	});
	it('missing administrator provisioning returns no credentials and never probes resources', async () => {
		const sample = jest.fn(),
			probe = jest.fn();
		const result = await new InternalRecoveryTargets(sample, probe).readiness();
		expect(result).toEqual(
			['mariadb', 'postgresql'].map(engine => ({
				engine,
				status: 'not_provisioned',
				mode: 'operator-managed',
			}))
		);
		expect(sample).not.toHaveBeenCalled();
		expect(probe).not.toHaveBeenCalled();
	});
	it('worker unavailable is explicit and independent of ordinary backups', async () => {
		const old = process.env.PLUTON_MYSQL_WORKER;
		delete process.env.PLUTON_MYSQL_WORKER;
		try {
			expect(await mysqlWorkerReadiness()).toBe('unavailable');
		} finally {
			if (old) process.env.PLUTON_MYSQL_WORKER = old;
		}
	});
});
