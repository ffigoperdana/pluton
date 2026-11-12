import { SftpRepositoryTransfer, statsFingerprint } from '../../src/utils/relocation/SftpRepositoryTransfer';

/** The bounded process runner is private; exercise it with Node itself as the child. */
const run = (
	script: string,
	options: Record<string, unknown>,
	signal?: AbortSignal
): Promise<{ stdout: string; missing: boolean }> =>
	(new SftpRepositoryTransfer() as any).run(
		process.execPath,
		['-e', script],
		{ PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
		signal,
		options
	);

describe('relocation process runner', () => {
	it('kills a process that reports no progress (stall) with a closed timeout code', async () => {
		const began = Date.now();
		await expect(
			run('setInterval(() => {}, 1000)', { deadlineMs: 60_000, stallMs: 300 })
		).rejects.toMatchObject({ code: 'timeout' });
		expect(Date.now() - began).toBeLessThan(20_000);
	});

	it('keeps a process alive while it reports progress', async () => {
		const lines: string[] = [];
		let mark = () => {};
		await expect(
			run(
				'let n = 0; const t = setInterval(() => { console.log("line-" + n); if (++n === 8) { clearInterval(t); } }, 100);',
				{
					deadlineMs: 60_000,
					stallMs: 400,
					onActivity: (markActivity: () => void) => (mark = markActivity),
					onStdoutLine: (line: string) => {
						mark();
						lines.push(line);
					},
				}
			)
		).resolves.toMatchObject({ missing: false });
		expect(lines).toHaveLength(8);
	});

	it('maps cancellation, a missing directory and unclassified failures without provider text', async () => {
		const controller = new AbortController();
		const pending = run('setInterval(() => {}, 1000)', { deadlineMs: 60_000 }, controller.signal);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
		await expect(
			run('console.error("ERROR : directory not found"); process.exit(3)', {
				deadlineMs: 60_000,
				missingExitCode: 3,
			})
		).resolves.toEqual({ stdout: '', missing: true });
		const failure = run('console.error("secret-token-value in provider text"); process.exit(2)', {
			deadlineMs: 60_000,
		});
		await expect(failure).rejects.toMatchObject({ code: 'execution-failed' });
		await expect(failure).rejects.not.toThrow('secret-token-value');
		await expect(
			run('console.error("write failed: no space left on device"); process.exit(1)', {
				deadlineMs: 60_000,
			})
		).rejects.toMatchObject({ code: 'destination-full' });
	});

	it('fingerprints only work counters, not elapsed time', () => {
		const line = (bytes: number, elapsedTime: number) =>
			JSON.stringify({ stats: { bytes, checks: 1, transfers: 0, listed: 9, elapsedTime } });
		expect(statsFingerprint(line(5, 1))).toBe(statsFingerprint(line(5, 9)));
		expect(statsFingerprint(line(5, 1))).not.toBe(statsFingerprint(line(6, 1)));
	});
});
