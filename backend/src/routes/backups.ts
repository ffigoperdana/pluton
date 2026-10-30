import { Router } from 'express';
import { BackupController } from '../controllers/BackupController';
import authM from '../middlewares/authMiddleware';

export function createBackupRouter(
	controller: BackupController,
	router: Router = Router()
): Router {
	router.delete('/:id', authM, controller.deleteBackup.bind(controller));
	router.post('/:id/', authM, controller.updateBackup.bind(controller));
	router.get('/:id/files', authM, controller.getSnapshotFiles.bind(controller));
	router.get('/:id/details', authM, controller.snapshotDetails.bind(controller));
	router.get('/:id/comparison', authM, controller.snapshotComparison.bind(controller));
	router.post('/:id/comparison', authM, controller.snapshotComparison.bind(controller));
	router.delete('/:id/comparison', authM, controller.snapshotComparison.bind(controller));
	router.get('/:id/files/page', authM, controller.getSnapshotPage.bind(controller));
	router.get('/:id/progress', authM, controller.getBackupProgress.bind(controller));
	router.post('/:id/action/cancel', authM, controller.cancelBackup.bind(controller));
	router.get('/:id/action/download', authM, controller.getBackupDownload.bind(controller));
	router.get(
		'/:id/download-preparations/:jobId/manifest',
		authM,
		controller.getExportManifest.bind(controller)
	);
	router.get(
		'/:id/download-preparations/:jobId',
		authM,
		controller.downloadPreparation.bind(controller)
	);
	router.delete(
		'/:id/download-preparations/:jobId',
		authM,
		controller.downloadPreparation.bind(controller)
	);
	router.post('/:id/action/download', authM, controller.generateBackupDownload.bind(controller));
	router.delete('/:id/action/download', authM, controller.cancelBackupDownload.bind(controller));
	router.post(
		'/:id/action/replication-retry',
		authM,
		controller.retryFailedReplications.bind(controller)
	);

	return router;
}
