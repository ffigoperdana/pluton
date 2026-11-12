import { validateReplicationSettings } from '../../src/utils/managedReplicationPolicy';
import { planUpdateSchema } from '../../src/db/schema/plans';
const replicas = {
	enabled: true,
	concurrent: false,
	recoveryPolicy: 'assisted',
	storages: [
		{
			replicationId: 'replica-01',
			storageId: 'mirror-01',
			storagePath: 'bucket-01/managed/plan-01',
		},
	],
};
describe('opt-in recovery source policy validation', () => {
	it.each([undefined, 'primary-only'])('leaves the existing default %s valid', recoveryPolicy => {
		expect(() =>
			validateReplicationSettings({
				enabled: false,
				concurrent: false,
				storages: [],
				recoveryPolicy,
			})
		).not.toThrow();
	});
	it.each(['auto', 'unsafe', 'Automatic', true, null])('rejects unsupported policy %s', recoveryPolicy => {
		expect(() => validateReplicationSettings({ ...replicas, recoveryPolicy })).toThrow(
			'Invalid recovery source policy'
		);
	});
	describe.each([
		['assisted', 'Assisted Failover'],
		['automatic', 'Automatic Failover'],
	])('%s policy', (recoveryPolicy, label) => {
		const settings = { ...replicas, recoveryPolicy };
		it.each([{ enabled: false }, { storages: [] }])('requires enabled replicas %j', patch => {
			expect(() => validateReplicationSettings({ ...settings, ...patch })).toThrow(
				`${label} requires enabled`
			);
		});
		it.each([
			{ sourceType: 'device', sourceId: 'main', method: 'backup' },
			{ sourceType: 'local', sourceId: 'app-01', method: 'backup' },
			{ sourceType: 'device', sourceId: 'app-01', method: 'sync' },
		])('refuses unsupported plan scope %j', scope => {
			expect(() => validateReplicationSettings(settings, scope)).toThrow(
				`${label} requires a managed remote filesystem`
			);
		});
		it('accepts the managed scope and preserves policy through JSON schema validation', () => {
			expect(() =>
				validateReplicationSettings(settings, {
					sourceType: 'device',
					sourceId: 'app-01',
					method: 'backup',
				})
			).not.toThrow();
			expect(planUpdateSchema.parse({ settings: { replication: settings } }).settings).toMatchObject({
				replication: { recoveryPolicy },
			});
		});
	});
});
