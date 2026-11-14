import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ManagedReplicationExecutor, ManagedReplicationError, replicationTempRoot, type ReplicationSource } from '../../src/utils/restic/ManagedReplicationExecutor';
import { appPaths } from '../../src/utils/AppPaths';

jest.mock('../../src/utils/binaryPathResolver', () => ({ getBinaryPath: (name: string) => `/synthetic/bin/${name}` }));

const snapshotId = 'a'.repeat(64);
const sourceTree = 'b'.repeat(64);
function fixture() {
	const source: ReplicationSource = { access: { options: { host: 'sftp.example.internal', user: 'fixture', pass: 'synthetic-source-password' }, password: 'synthetic-repository-password', repositoryPath: 'managed/plan-01' }, planId: 'plan-01', backupId: 'backup-01', snapshotId, artifacts: [] };
	const snapshot = { id: snapshotId, tree: sourceTree, tags: ['pluton-plan-plan-01', 'pluton-backup-backup-01'], paths: ['/srv/example-app'] };
	const proof = { repositoryConfigId: 'c'.repeat(64), snapshot };
	const destination = { options: { type: 's3', endpoint: 'https://s3.example.internal', access_key_id: 'synthetic-access', secret_access_key: 'synthetic-secret', no_check_bucket: 'true' }, repositoryPath: 'bucket-01/owned-prefix', environment: { RCLONE_CA_CERT: '/operator/ca.pem' } };
	const tempRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pluton-replication-test-')), 'replication');
	const executor = new ManagedReplicationExecutor({ tempRoot });
	let existing = true;
	let initialized = false;
	const events: string[] = [];
	const command = jest.spyOn(executor as any, 'command').mockImplementation(async (binary: any, args: any, env: any, signal: any, input: any, long: any, stream: any) => {
		if (signal?.aborted) throw new ManagedReplicationError('cancelled');
		if (binary === 'rclone' && args[0] === 'obscure') return 'synthetic_obscured';
		if (binary === 'rclone' && args[0] === 'lsf') return '';
		const sourceRepository = args[args.indexOf('--repo') + 1].startsWith('rclone:source:');
		if (args.includes('cat')) {
			if (!sourceRepository && !existing && !initialized) throw new ManagedReplicationError('repository-unavailable');
			return JSON.stringify({ id: (sourceRepository ? 'c' : 'd').repeat(64) });
		}
		if (args.includes('init')) { events.push('init'); initialized = true; return ''; }
		if (args.includes('copy')) { events.push('copy'); return 'snapshot copied'; }
		if (args.includes('snapshots')) return JSON.stringify([sourceRepository ? snapshot : { ...snapshot, id: 'e'.repeat(64), original: snapshotId }]);
		if (args.includes('dump')) { stream(Buffer.from('SELECT 1;')); return ''; }
		throw new Error('Unexpected synthetic command');
	});
	const beginInitialization = jest.fn(async () => { events.push('durable-init'); });
	const bindRepository = jest.fn(async () => { events.push('durable-bind'); });
	const run = (state: any = { initialization: 'ready', repositoryConfigId: 'd'.repeat(64) }, signal?: AbortSignal) => executor.copy({ source, proof, destination, state, beginInitialization, bindRepository, signal });
	return { executor, source, snapshot, proof, destination, command, events, beginInitialization, bindRepository, run, tempRoot, absent: () => { existing = false; } };
}

describe('Managed replication fixed Restic executor', () => {
	it('copies only the immutable full snapshot and verifies original/tree/tags on destination', async () => {
		const f = fixture(); await expect(f.run()).resolves.toMatchObject({ snapshotId: 'e'.repeat(64), repositoryConfigId: 'd'.repeat(64) });
		const calls = f.command.mock.calls;
		const copy = calls.find(([, args]: any) => args.includes('copy'))!;
		expect(copy[1]).toContain(snapshotId); expect(copy[1]).not.toContain('--tag'); expect(copy[1]).not.toContain('--no-lock');
		expect(copy[2]).toMatchObject({ RESTIC_PASSWORD: 'synthetic-repository-password', RESTIC_FROM_PASSWORD: 'synthetic-repository-password', RCLONE_CONFIG_DESTINATION_SECRET_ACCESS_KEY: 'synthetic-secret', RCLONE_CA_CERT: '/operator/ca.pem', GOMAXPROCS: '2', RCLONE_TRANSFERS: '2' });
		expect(JSON.stringify(calls.map(([, args]) => args))).not.toContain('synthetic-secret');
		expect(calls.some(([, args]: any) => args.includes('unlock') || args.includes('forget') || args.includes('prune') || args.includes('purge'))).toBe(false);
	});
	it('never lets copy or Range-based artifact verification request gzip from the replica', async () => {
		const f = fixture();
		(f.destination.options as Record<string, string>).use_accept_encoding_gzip = 'true';
		f.source.artifacts = [{ path: '/pluton/database/app-01.sql', bytes: 9, sha256: crypto.createHash('sha256').update('SELECT 1;').digest('hex') }];
		await expect(f.run()).resolves.toMatchObject({ snapshotId: 'e'.repeat(64) });
		const destinationCalls = f.command.mock.calls.filter(([binary, args]: any) => binary === 'restic' && args.includes('--repo') && args[args.indexOf('--repo') + 1].startsWith('rclone:destination:'));
		expect(destinationCalls.some(([, args]: any) => args.includes('copy'))).toBe(true);
		expect(destinationCalls.some(([, args]: any) => args.includes('dump'))).toBe(true);
		for (const [, , env] of destinationCalls as any) expect(env.RCLONE_CONFIG_DESTINATION_USE_ACCEPT_ENCODING_GZIP).toBe('false');
	});
	it('durably declares initialization and identity before copying to an empty prefix', async () => {
		const f = fixture(); f.absent(); await f.run({ initialization: 'uninitialized', repositoryConfigId: null });
		expect(f.events).toEqual(['durable-init', 'init', 'durable-bind', 'copy']);
		expect(f.bindRepository).toHaveBeenCalledWith('d'.repeat(64));
	});
	it('refuses an unknown existing repository without adopting or modifying it', async () => {
		const f = fixture(); await expect(f.run({ initialization: 'uninitialized', repositoryConfigId: null })).rejects.toMatchObject({ code: 'destination-unowned' });
		expect(f.events).toEqual([]); expect(f.bindRepository).not.toHaveBeenCalled();
	});
	it('refuses existing data when the destination config is absent', async () => {
		const f = fixture(); f.absent(); const previous = f.command.getMockImplementation()!;
		f.command.mockImplementation(async (...args: any[]) => args[0] === 'rclone' && args[1][0] === 'lsf' ? 'application-data/' : previous(...args));
		await expect(f.run({ initialization: 'uninitialized', repositoryConfigId: null })).rejects.toMatchObject({ code: 'destination-not-empty' });
		expect(f.events).toEqual([]);
	});
	it.each(['initializing', 'uncertain'])('refuses uncertain %s before any mutation', async initialization => {
		const f = fixture(); await expect(f.run({ initialization, repositoryConfigId: null })).rejects.toMatchObject({ code: 'initialization-uncertain' });
		expect(f.command).not.toHaveBeenCalled();
	});
	it('does not start initialization if the durable pre-mutation write fails', async () => {
		const f = fixture(); f.absent(); f.beginInitialization.mockRejectedValue(new ManagedReplicationError('claim-lost'));
		await expect(f.run({ initialization: 'uninitialized', repositoryConfigId: null })).rejects.toMatchObject({ code: 'claim-lost' });
		expect(f.events).toEqual([]);
	});
	it('does not copy if initialization identity could not be committed', async () => {
		const f = fixture(); f.absent(); f.bindRepository.mockRejectedValue(new ManagedReplicationError('claim-lost'));
		await expect(f.run({ initialization: 'uninitialized', repositoryConfigId: null })).rejects.toMatchObject({ code: 'claim-lost' });
		expect(f.events).toEqual(['durable-init', 'init']);
	});
	it.each(['id', 'tree', 'tags'])('rejects changed source snapshot %s before copy', async changed => {
		const f = fixture();
		if (changed === 'id') f.snapshot.id = 'f'.repeat(64);
		if (changed === 'tree') f.proof.repositoryConfigId = 'f'.repeat(64);
		if (changed === 'tags') f.snapshot.tags.push('pluton-plan-other');
		await expect(f.run()).rejects.toBeInstanceOf(ManagedReplicationError); expect(f.events).toEqual([]);
	});
	it('rejects changed destination repository identity', async () => {
		const f = fixture(); await expect(f.run({ initialization: 'ready', repositoryConfigId: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'destination-binding-changed' });
		expect(f.events).toEqual([]);
	});
	it('verifies full synthetic SQL bytes/checksum from primary and replica', async () => {
		const f = fixture(); const sql = 'SELECT 1;';
		f.source.artifacts = [{ path: '/pluton/database/fixture.sql', bytes: Buffer.byteLength(sql), sha256: crypto.createHash('sha256').update(sql).digest('hex') }];
		await f.run();
		const dumps = f.command.mock.calls.filter(([, args]: any) => args.includes('dump'));
		expect(dumps).toHaveLength(2); expect(dumps[0][1]).toContain(snapshotId); expect(dumps[1][1]).toContain('e'.repeat(64));
	});
	it('refuses a SQL checksum mismatch before destination mutation', async () => {
		const f = fixture(); f.source.artifacts = [{ path: '/pluton/database/fixture.sql', bytes: 9, sha256: '0'.repeat(64) }];
		await expect(f.run()).rejects.toMatchObject({ code: 'artifact-checksum-mismatch' }); expect(f.events).toEqual([]);
	});
	it('never confirms success with an unrelated destination snapshot', async () => {
		const f = fixture(); const previous = f.command.getMockImplementation()!;
		f.command.mockImplementation(async (...args: any[]) => args[1].includes('snapshots') && args[1].includes('rclone:destination:bucket-01/owned-prefix') ? JSON.stringify([{ ...f.snapshot, id: 'e'.repeat(64), original: 'f'.repeat(64) }]) : previous(...args));
		await expect(f.run()).rejects.toMatchObject({ code: 'destination-snapshot-unverified' });
	});
	it('gives every Restic call of a copy a private temporary directory outside /tmp and removes it afterwards', async () => {
		const f = fixture();
		await f.run();
		const copy = f.command.mock.calls.find(([, args]: any) => args.includes('copy'))!;
		const workspace = (copy[2] as NodeJS.ProcessEnv).TMPDIR!;
		expect(path.dirname(workspace)).toBe(f.tempRoot);
		expect(path.basename(workspace)).toMatch(/^job-/);
		for (const [, , env] of f.command.mock.calls as any) expect(env.TMPDIR).toBe(workspace);
		expect(fs.existsSync(workspace)).toBe(false);
		expect(fs.readdirSync(f.tempRoot)).toEqual([]);
	});
	it('places the default temporary root on the data volume, never under the app temp directory', () => {
		// In Docker appPaths.getTempDir() is /tmp/pluton, the container's 64 MiB tmpfs.
		expect(replicationTempRoot()).toBe(path.join(appPaths.getDataDir(), 'tmp', 'replication'));
		expect(path.relative(appPaths.getTempDir(), replicationTempRoot()).startsWith('..')).toBe(true);
	});
	it('removes the temporary directory when the copy fails', async () => {
		const f = fixture(); const previous = f.command.getMockImplementation()!;
		f.command.mockImplementation(async (...args: any[]) => { if (args[1].includes('copy')) throw new ManagedReplicationError('no-space-left'); return previous(...args); });
		await expect(f.run()).rejects.toMatchObject({ code: 'no-space-left', detail: { step: 'copy' } });
		expect(fs.readdirSync(f.tempRoot)).toEqual([]);
	});
	it('refuses to start when the temporary directory cannot be created', async () => {
		const f = fixture();
		fs.mkdirSync(path.dirname(f.tempRoot), { recursive: true });
		fs.writeFileSync(f.tempRoot, 'not a directory');
		await expect(f.run()).rejects.toMatchObject({ code: 'workspace-unavailable', detail: { step: 'workspace' } });
		expect(f.command).not.toHaveBeenCalled();
	});
	it.each([
		['cat', 'source', 'source-config'],
		['snapshots', 'source', 'source-snapshot'],
		['dump', 'source', 'source-artifact'],
		['cat', 'destination', 'destination-config'],
		['snapshots', 'destination', 'destination-snapshot'],
		['dump', 'destination', 'destination-artifact'],
	])('records the failing step when %s on the %s repository fails', async (command, side, step) => {
		const f = fixture(); const previous = f.command.getMockImplementation()!;
		f.source.artifacts = [{ path: '/pluton/database/fixture.sql', bytes: 9, sha256: crypto.createHash('sha256').update('SELECT 1;').digest('hex') }];
		f.command.mockImplementation(async (...args: any[]) => {
			const repo = args[1].includes('--repo') ? args[1][args[1].indexOf('--repo') + 1] : '';
			if (args[1].includes(command) && repo.startsWith(`rclone:${side}:`)) throw new ManagedReplicationError('execution-failed', { exitCode: 1 });
			return previous(...args);
		});
		await expect(f.run()).rejects.toMatchObject({ code: 'execution-failed', detail: { step, exitCode: 1 } });
	});
	it('cancels without a copy', async () => {
		const f = fixture(); const controller = new AbortController(); controller.abort();
		await expect(f.run(undefined, controller.signal)).rejects.toMatchObject({ code: 'cancelled' }); expect(f.events).toEqual([]);
	});
});
