import { execFile } from 'child_process';
import { killProcessTree, KillableProcess } from '../../src/utils/processTree';

jest.mock('child_process', () => ({
	execFile: jest.fn(),
}));

const mockExecFile = execFile as unknown as jest.Mock;

const originalPlatform = process.platform;

const setPlatform = (platform: NodeJS.Platform) => {
	Object.defineProperty(process, 'platform', { value: platform });
};

const createChild = (pid: number | undefined) =>
	({ pid, kill: jest.fn() } as unknown as KillableProcess & { kill: jest.Mock });

describe('killProcessTree', () => {
	afterEach(() => {
		jest.clearAllMocks();
		Object.defineProperty(process, 'platform', { value: originalPlatform });
	});

	it('does nothing for a null or pid-less process', () => {
		killProcessTree(null);
		killProcessTree(createChild(undefined));
		expect(mockExecFile).not.toHaveBeenCalled();
	});

	it('marks the process as killed before the kill', () => {
		setPlatform('linux');
		const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
		const child = createChild(4321);

		killProcessTree(child);

		expect(child.__plutonKilled).toBe(true);
		killSpy.mockRestore();
	});

	describe('windows', () => {
		beforeEach(() => setPlatform('win32'));

		it('uses taskkill /T /F and also calls child.kill', () => {
			const child = createChild(1234);

			killProcessTree(child);

			expect(mockExecFile).toHaveBeenCalledWith(
				'taskkill',
				['/PID', '1234', '/T', '/F'],
				expect.any(Function)
			);
			expect(child.kill).toHaveBeenCalledTimes(1);
		});
	});

	describe('posix', () => {
		beforeEach(() => {
			setPlatform('linux');
			jest.useFakeTimers();
		});
		afterEach(() => jest.useRealTimers());

		it('kills the process group and escalates to SIGKILL after 1500ms', () => {
			const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
			const child = createChild(555);

			killProcessTree(child, 'SIGTERM');

			expect(killSpy).toHaveBeenCalledWith(-555, 'SIGTERM');
			expect(mockExecFile).not.toHaveBeenCalled();

			jest.advanceTimersByTime(1500);
			expect(killSpy).toHaveBeenCalledWith(-555, 'SIGKILL');

			killSpy.mockRestore();
		});

		it('falls back to child.kill when the group kill throws', () => {
			const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
				throw new Error('ESRCH');
			});
			const child = createChild(777);

			killProcessTree(child, 'SIGTERM');

			expect(child.kill).toHaveBeenCalledWith('SIGTERM');
			killSpy.mockRestore();
		});
	});
});
