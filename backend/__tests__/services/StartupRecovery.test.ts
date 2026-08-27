import { StartupRecovery } from '../../src/services/StartupRecovery';
import { PlanService } from '../../src/services/PlanService';

const mockWarn = jest.fn();
const mockError = jest.fn();
jest.mock('../../src/utils/logger', () => ({
	planLogger: jest.fn().mockReturnValue({
		info: jest.fn(),
		error: (...args: any[]) => mockError(...args),
		warn: (...args: any[]) => mockWarn(...args),
	}),
}));

describe('StartupRecovery', () => {
	let recovery: StartupRecovery;
	let mockPlanService: jest.Mocked<Pick<PlanService, 'clearOrphanedInProgress'>>;

	beforeEach(() => {
		jest.clearAllMocks();
		mockPlanService = {
			clearOrphanedInProgress: jest
				.fn()
				.mockResolvedValue({ backups: [], restores: [], plans: [] }),
		};
		recovery = new StartupRecovery(mockPlanService as unknown as PlanService);
	});

	it('delegates the sweep to PlanService', async () => {
		await recovery.run();
		expect(mockPlanService.clearOrphanedInProgress).toHaveBeenCalledTimes(1);
	});

	it('writes a warning for each swept backup, restore and plan', async () => {
		mockPlanService.clearOrphanedInProgress = jest.fn().mockResolvedValue({
			backups: [{ id: 'b1', planId: 'p1' }],
			restores: [{ id: 'r1', planId: 'p1', backupId: 'b1' }],
			plans: [{ id: 'p1' }],
		});

		await recovery.run();

		expect(mockWarn).toHaveBeenCalledTimes(3);
	});

	it('does nothing when there are no orphans', async () => {
		await recovery.run();
		expect(mockWarn).not.toHaveBeenCalled();
	});

	it('never throws when the sweep fails', async () => {
		mockPlanService.clearOrphanedInProgress = jest
			.fn()
			.mockRejectedValue(new Error('db locked'));

		await expect(recovery.run()).resolves.toBeUndefined();
		expect(mockError).toHaveBeenCalledWith(
			expect.stringContaining('Startup recovery process failed')
		);
	});
});
