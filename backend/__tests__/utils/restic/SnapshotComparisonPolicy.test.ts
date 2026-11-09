import {
	comparisonEvidence,
	sameFilesystemScope,
	verifyComparisonRoots,
	SnapshotComparisonError,
} from '../../../src/utils/restic/SnapshotComparisonPolicy';
const source = '/srv/example-app';
const artifact = (name = 'app.sql', bytes = 10) => ({
	path: '/pluton/database/' + name,
	bytes,
	sha256: 'c'.repeat(64),
});
const row = (sources = [source], artifacts: ReturnType<typeof artifact>[] = []) => ({
	completionStats: {
		sourcePaths: sources,
		lifecycle: artifacts.length
			? {
					databases: artifacts.map((a, i) => ({
						...a,
						databaseId: 'db_' + i,
						engine: 'mariadb',
						database: 'app',
					})),
				}
			: undefined,
	},
});
const evidence = (artifacts: ReturnType<typeof artifact>[] = []) =>
	comparisonEvidence(row([source], artifacts));
const node = (path: string, type = 'file', size = 10) => ({ path, type, size });
const index = (entries: ReturnType<typeof node>[]) =>
	({
		get: (p: string) => entries.find(e => e.path === p),
		[Symbol.iterator]: () => entries[Symbol.iterator](),
	}) as any;
const nodes = (artifacts: ReturnType<typeof artifact>[] = []) => [
	node('/srv', 'dir', 0),
	node(source, 'dir', 0),
	node(source + '/unchanged.txt'),
	...(artifacts.length
		? [
				node('/pluton', 'dir', 0),
				node('/pluton/database', 'dir', 0),
				...artifacts.map(a => node(a.path, 'file', a.bytes)),
			]
		: []),
];
const snapshot = (roots: string[]) => ({ id: 'a'.repeat(64), tags: [], paths: roots });
const alias = (name = 'app.sql', job = 'ABC123') =>
	'/var/lib/example-agent/jobs/job-' + job + '/pluton/database/' + name;
const verify = (
	a: string[],
	b: string[],
	ca: ReturnType<typeof artifact>[] = [],
	pa: ReturnType<typeof artifact>[] = [],
	cn = nodes(ca),
	pn = nodes(pa)
) =>
	verifyComparisonRoots(
		snapshot(a),
		snapshot(b),
		index(cn),
		index(pn),
		evidence(ca),
		evidence(pa),
		new AbortController().signal
	);
describe('database snapshot root compatibility evidence', () => {
	test('exact filesystem roots and complete historical source configuration require no inferred artifact aliases', async () => {
		expect((await verify([source], [source])).mode).toBe('exact-roots');
		expect(comparisonEvidence({ sourceConfig: { includes: [source] } }).sources).toEqual([source]);
	});
	test('the production-style raw roots differ, but canonical receipt-backed SQL belongs to the same filesystem scope', async () => {
		const a = [source, alias('app.sql', 'NEW123')],
			b = [source, alias('app.sql', 'OLD123')];
		expect(JSON.stringify(a.sort())).not.toBe(JSON.stringify(b.sort()));
		expect(await verify(a, b, [artifact()], [artifact()])).toMatchObject({
			mode: 'verified-database-roots',
			currentDatabaseArtifacts: 1,
			previousDatabaseArtifacts: 1,
		});
	});
	test.each(['rename', 'added', 'removed', 'canonical-history', 'multi-db'])(
		'independently proven artifact set may change: %s',
		async scenario => {
			let ca = [artifact()],
				pa = [artifact()];
			if (scenario === 'rename') ca = [artifact('renamed.sql')];
			if (scenario === 'added') pa = [];
			if (scenario === 'removed') ca = [];
			if (scenario === 'multi-db') ca = [artifact(), artifact('logs.sql')];
			const roots = (items: typeof ca, job: string) => [
				source,
				...items.map(a => alias(a.path.split('/').pop()!, job)),
			];
			const previous =
				scenario === 'canonical-history' ? [source, artifact().path] : roots(pa, 'OLD123');
			expect((await verify(roots(ca, 'NEW123'), previous, ca, pa)).mode).toBe(
				'verified-database-roots'
			);
		}
	);
	test('historical bounded job tokens use the same proof, never an arbitrary staging suffix', async () => {
		expect(
			(
				await verify(
					[source, alias('app.sql', 'historical_job_01')],
					[source, alias('app.sql', 'OLD123')],
					[artifact()],
					[artifact()]
				)
			).mode
		).toBe('verified-database-roots');
		await expect(
			verify(
				[source, alias('app.sql', 'A'.repeat(161))],
				[source, alias('app.sql', 'OLD123')],
				[artifact()],
				[artifact()]
			)
		).rejects.toMatchObject({ diagnostic: 'snapshot-root-path-incompatible' });
	});
	test('filesystem scope is exact and source metadata is copied, not aliased', () => {
		const input = row();
		const captured = comparisonEvidence(input);
		input.completionStats.sourcePaths.push('/srv/other');
		expect(captured.sources).toEqual([source]);
		expect(sameFilesystemScope(captured, comparisonEvidence(row(['/srv/other'])))).toBe(false);
	});
	test.each([
		{ completionStats: {} },
		{ completionStats: { sourcePaths: [] } },
		{ completionStats: { sourcePaths: [source, source] } },
		{ completionStats: { sourcePaths: ['/srv/../escape'] } },
		{
			completionStats: {
				sourcePaths: [source],
				lifecycle: { database: { path: artifact().path, bytes: 10, sha256: 'missing' } },
			},
		},
	])('incomplete or unsafe recorded evidence is not guessed: %j', input => {
		expect(() => comparisonEvidence(input)).toThrow(SnapshotComparisonError);
	});
	test.each([
		'missing-receipt',
		'wrong-size',
		'missing-file',
		'symlink',
		'foreign-extra-root',
		'unsafe-workspace',
		'different-workspaces',
		'extra-tree-entry',
	])('alias remains fail-closed: %s', async scenario => {
		let ca = [artifact()],
			cn = nodes(ca),
			roots = [source, alias()];
		if (scenario === 'missing-receipt') ca = [];
		if (scenario === 'wrong-size') cn = nodes([artifact('app.sql', 11)]);
		if (scenario === 'missing-file') cn = cn.filter(n => n.path !== artifact().path);
		if (scenario === 'symlink')
			cn = cn.map(n => (n.path === artifact().path ? { ...n, type: 'symlink' } : n));
		if (scenario === 'foreign-extra-root') roots.push('/etc/foreign');
		if (scenario === 'unsafe-workspace')
			roots = [source, '/tmp/job-ABC123/pluton/database/app.sql'];
		if (scenario === 'different-workspaces') {
			ca = [artifact(), artifact('logs.sql')];
			cn = nodes(ca);
			roots.push(alias('logs.sql', 'DEF456'));
		}
		if (scenario === 'extra-tree-entry') cn.push(node('/etc/foreign'));
		await expect(
			verify(roots, [source, alias('app.sql', 'OLD123')], ca, [artifact()], cn)
		).rejects.toBeInstanceOf(SnapshotComparisonError);
	});
	test('genuine source scope change and a root missing from its exact index are refused', async () => {
		await expect(
			verifyComparisonRoots(
				snapshot([source]),
				snapshot(['/srv/other']),
				index(nodes()),
				index(nodes()),
				evidence(),
				comparisonEvidence(row(['/srv/other'])),
				new AbortController().signal
			)
		).rejects.toMatchObject({ diagnostic: 'historical-source-scope-mismatch' });
		await expect(verify([source], [source], [], [], [], nodes())).rejects.toMatchObject({
			diagnostic: 'historical-source-scope-mismatch',
		});
	});
	test('stable exact roots support missing legacy DB receipts without broadening any path mapping', async () => {
		expect(
			(
				await verify(
					[source, artifact().path],
					[source, artifact().path],
					[],
					[],
					nodes([artifact()]),
					nodes([artifact()])
				)
			).mode
		).toBe('exact-roots');
	});
});
