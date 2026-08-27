import fs from 'fs';
import { checkDestinationSpace } from '../../src/utils/checkDestinationSpace';

describe('checkDestinationSpace', () => {
	let statfsSpy: jest.SpyInstance;

	// statfs reports free bytes as bavail * bsize; use bsize = 1 so bavail is the byte count.
	const statfsWithAvailable = (available: number) =>
		({ bsize: 1, bavail: available, blocks: 10 * 1024 * 1024 * 1024, bfree: available } as any);

	beforeEach(() => {
		statfsSpy = jest.spyOn(fs.promises, 'statfs');
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('skips when there is no target path', async () => {
		await expect(
			checkDestinationSpace({ targetPath: '', estimatedBytes: 1000 })
		).resolves.toBeUndefined();
		expect(statfsSpy).not.toHaveBeenCalled();
	});

	it('skips when the estimate is zero', async () => {
		await expect(
			checkDestinationSpace({ targetPath: 'C:\\backups', estimatedBytes: 0 })
		).resolves.toBeUndefined();
		expect(statfsSpy).not.toHaveBeenCalled();
	});

	it('skips when the measurement fails', async () => {
		statfsSpy.mockRejectedValue(new Error('ENOENT'));
		await expect(
			checkDestinationSpace({ targetPath: 'C:\\backups', estimatedBytes: 1000 })
		).resolves.toBeUndefined();
	});

	it('passes when the space is sufficient', async () => {
		statfsSpy.mockResolvedValue(statfsWithAvailable(5 * 1024 * 1024 * 1024));
		await expect(
			checkDestinationSpace({ targetPath: 'C:\\backups', estimatedBytes: 500 * 1024 * 1024 })
		).resolves.toBeUndefined();
	});

	it('throws a non-retryable error when the space is insufficient', async () => {
		statfsSpy.mockResolvedValue(statfsWithAvailable(100 * 1024 * 1024));
		await expect(
			checkDestinationSpace({ targetPath: 'C:\\backups', estimatedBytes: 500 * 1024 * 1024 })
		).rejects.toMatchObject({ retryable: false });
	});

	it('uses the label in the error message', async () => {
		statfsSpy.mockResolvedValue(statfsWithAvailable(1));
		await expect(
			checkDestinationSpace({ targetPath: '/mnt/data', estimatedBytes: 1000, label: 'restore' })
		).rejects.toThrow(/The restore needs about/);
	});
});
