import { Request, Response } from 'express';
import { BackupService } from '../services/BackupServices';
import { AppError } from '../utils/AppError';
import { RetainedRestoreDependencyError } from '../utils/retainedRestoreDependency';
import { z } from 'zod';
import { managedSnapshotPath } from '../utils/managedSnapshotPath';
import { SnapshotIndexError } from '../utils/restic/ManagedSnapshotIndex';
import { ManagedRepositoryAccessError } from '../utils/restic/ManagedSftpRepositorySession';

const pageQuery = z.strictObject({
	path: z.string().max(1025).optional(),
	search: z.string().trim().max(128).optional(),
	offset: z
		.string()
		.regex(/^\d{1,6}$/)
		.transform(Number)
		.pipe(z.number().int().min(0).max(500000))
		.optional(),
	limit: z
		.string()
		.regex(/^\d{1,3}$/)
		.transform(Number)
		.pipe(z.number().int().min(1).max(500))
		.optional(),
	sort: z.enum(['name', 'size', 'modifiedAt']).optional(),
	order: z.enum(['asc', 'desc']).optional(),
	directoriesOnly: z
		.enum(['true', 'false'])
		.transform(value => value === 'true')
		.optional(),
	retry: z
		.enum(['true', 'false'])
		.transform(value => value === 'true')
		.optional(),
});
const failureCode = (error: unknown) =>
	error instanceof SnapshotIndexError
		? { code: error.code, reason: error.reason }
		: error instanceof ManagedRepositoryAccessError
			? { code: error.code }
			: {};

export class BackupController {
	constructor(protected backupService: BackupService) {}

	async getBackupDownload(req: Request, res: Response): Promise<void> {
		if (!req.params.id) {
			res.status(400).json({
				success: false,
				error: 'Backup ID is required',
			});
			return;
		}

		try {
			this.validateDownloadRequest(req, true);
			const downloadResult = req.query.preparationId
				? await this.backupService.getBackupDownload(
						req.params.id,
						req.query.preparationId as string
					)
				: await this.backupService.getBackupDownload(req.params.id);
			if (typeof downloadResult.streamTo === 'function') {
				const request = this.downloadRequest(req, res);
				try {
					await downloadResult.streamTo(res, request.signal, () => {
						res.setHeader('Content-Type', 'application/x-tar');
						res.setHeader(
							'Content-Disposition',
							`attachment; filename="${downloadResult.fileName}"`
						);
						res.setHeader('Cache-Control', 'private, no-store');
					});
					if (!res.destroyed) res.end();
				} catch (error) {
					if (res.headersSent || res.destroyed) {
						if (!res.destroyed) res.destroy(); // never append JSON/provider output to a partial TAR
					} else {
						res.removeHeader('Content-Type');
						res.removeHeader('Content-Disposition');
						res.status(error instanceof AppError ? error.statusCode : 502).json({
							success: false,
							error: error instanceof AppError ? error.message : 'Remote download failed.',
							...failureCode(error),
						});
					}
				} finally {
					request.cleanup();
				}
				return;
			}
			const { fileName, fileStream } = downloadResult;

			// Set headers for streaming
			res.setHeader('Content-Type', 'application/x-tar');
			res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
			res.setHeader('Transfer-Encoding', 'chunked');

			// Pipe the stream directly to response
			fileStream.pipe(res);
			return;
		} catch (error: any) {
			res.status(error instanceof AppError ? error.statusCode : 500).json({
				success: false,
				error: error instanceof AppError ? error.message : 'Failed to get Downloaded file.',
				...failureCode(error),
			});
		}
	}

	async generateBackupDownload(req: Request, res: Response): Promise<void> {
		if (!req.params.id) {
			res.status(400).json({
				success: false,
				error: 'Backup ID is required',
			});
			return;
		}

		const request = this.downloadRequest(req, res);
		try {
			this.validateDownloadRequest(req);
			const replicationId = req.query.replicationId as string | undefined;
			const args: [string, string | undefined, AbortSignal, boolean?] = [
				req.params.id,
				replicationId,
				request.signal,
			];
			if (Object.keys(req.body || {}).length) args.push(true);
			const downloadResult = await this.backupService.generateBackupDownload(...args);

			if (downloadResult?.streaming === true && Object.keys(req.body || {}).length)
				throw new AppError(400, 'Remote downloads support only the complete exact snapshot.');
			if (!res.destroyed) {
				res.setHeader('Cache-Control', 'private, no-store');
				res
					.status(downloadResult?.preparation ? 202 : 200)
					.json({ success: true, result: downloadResult });
			}
		} catch (error: any) {
			if (!res.destroyed)
				res.status(error instanceof AppError ? error.statusCode : 500).json({
					success: false,
					error: error instanceof AppError ? error.message : 'Failed to generate Download Link.',
					...failureCode(error),
				});
		} finally {
			request.cleanup();
		}
	}

	async downloadPreparation(req: Request, res: Response) {
		try {
			if (Object.keys(req.query).length || Object.keys(req.body || {}).length)
				throw new AppError(400, 'Preparation accepts no options.');
			const result = await this.backupService.downloadPreparation(
				req.params.id,
				req.params.jobId,
				req.method === 'DELETE'
			);
			res.setHeader('Cache-Control', 'private, no-store');
			if (result.retryAfterMs) res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000));
			res.json({ success: true, result });
		} catch (error) {
			res
				.status(error instanceof AppError ? error.statusCode : 500)
				.json({
					success: false,
					error: error instanceof AppError ? error.message : 'Preparation status unavailable.',
					...failureCode(error),
				});
		}
	}

	private validateDownloadRequest(req: Request, download = false) {
		// Keep the existing local file-selection shape, never accept client-owned
		// credentials, repository URLs, storage overrides or process/config options.
		const body = req.body;
		if (
			Object.keys(req.query).some(
				key => key !== 'replicationId' && !(download && key === 'preparationId')
			) ||
			(req.query.preparationId !== undefined &&
				!z.string().uuid().safeParse(req.query.preparationId).success) ||
			(body !== undefined &&
				(!body ||
					typeof body !== 'object' ||
					Array.isArray(body) ||
					Object.keys(body).some(key => key !== 'files') ||
					(body.files !== undefined &&
						(!Array.isArray(body.files) ||
							body.files.some((file: unknown) => typeof file !== 'string')))))
		)
			throw new AppError(400, 'Invalid download request.');
	}

	private downloadRequest(req: Request, res: Response) {
		const controller = new AbortController();
		const abort = () => {
			if (!res.writableFinished) controller.abort();
		};
		req.once?.('aborted', abort);
		res.once?.('close', abort);
		if (req.aborted || res.destroyed) controller.abort();
		return {
			signal: controller.signal,
			cleanup: () => {
				req.removeListener?.('aborted', abort);
				res.removeListener?.('close', abort);
			},
		};
	}

	async getSnapshotFiles(req: Request, res: Response): Promise<void> {
		if (!req.params.id) {
			res.status(400).json({
				success: false,
				error: 'Backup ID is required',
			});
			return;
		}

		try {
			if (
				Object.keys(req.query).some(key => key !== 'replicationId') ||
				(req.query.replicationId !== undefined && typeof req.query.replicationId !== 'string')
			)
				throw new AppError(400, 'Invalid snapshot request.');
			const replicationId = req.query.replicationId as string | undefined;
			const snapshotFiles = await this.backupService.getSnapshotFiles(req.params.id, replicationId);

			res.status(200).json({ success: true, result: snapshotFiles });
		} catch (error: any) {
			res.status(error instanceof AppError ? error.statusCode : 500).json({
				success: false,
				error: error instanceof AppError ? error.message : 'Snapshot metadata is unavailable.',
				...failureCode(error),
			});
		}
	}

	async getSnapshotPage(req: Request, res: Response): Promise<void> {
		const request = this.downloadRequest(req, res);
		try {
			const parsed = pageQuery.safeParse(req.query);
			if (!req.params.id || !parsed.success)
				throw new AppError(400, 'Invalid snapshot page request.');
			const query = parsed.data;
			if (query.path) {
				if (!query.path.startsWith('/')) throw new AppError(400, 'Invalid snapshot directory.');
				managedSnapshotPath(query.path);
			}
			if (
				query.search &&
				[...query.search].some(
					character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127
				)
			)
				throw new AppError(400, 'Invalid filename search.');
			const result = await this.backupService.getSnapshotPage(req.params.id, query, request.signal);
			res.setHeader('Cache-Control', 'private, no-store');
			if (result.status === 'indexing') res.setHeader('Retry-After', '1');
			if (!res.destroyed)
				res.status(result.status === 'indexing' ? 202 : 200).json({ success: true, result });
		} catch (error) {
			if (error instanceof SnapshotIndexError && error.statusCode === 429)
				res.setHeader('Retry-After', '2');
			if (!res.destroyed)
				res.status(error instanceof AppError ? error.statusCode : 500).json({
					success: false,
					error: error instanceof AppError ? error.message : 'Snapshot metadata is unavailable.',
					...failureCode(error),
				});
		} finally {
			request.cleanup();
		}
	}

	async cancelBackupDownload(req: Request, res: Response): Promise<void> {
		if (!req.params.id) {
			res.status(400).json({
				success: false,
				error: 'Backup ID is required',
			});
			return;
		}

		try {
			const downloadResult = await this.backupService.cancelBackupDownload(
				req.query.planId as string,
				req.params.id
			);
			res.status(200).json({ success: true, result: downloadResult });
		} catch (error: any) {
			res.status(500).json({
				success: false,
				error: 'Failed to cancel Download Generation. ' + (error.message || ''),
			});
		}
	}

	async deleteBackup(req: Request, res: Response): Promise<void> {
		try {
			if (!req.params.id) {
				res.status(400).json({
					success: false,
					error: 'Backup ID is required',
				});
				return;
			}
			const removeSnapshot = true; //req.params.rs ? true : false;
			await this.backupService.deleteBackup(req.params.id, removeSnapshot);
			res.status(200).json({ success: true, result: 'Removed' });
		} catch (error: any) {
			res.status(error instanceof AppError ? error.statusCode : 500).json({
				success: false,
				error: error?.message || 'Failed to delete backup',
				...(error instanceof RetainedRestoreDependencyError && { code: error.code }),
			});
			return;
		}
	}

	async getBackupProgress(req: Request, res: Response): Promise<void> {
		if (!req.params.id || !req.query.sourceId || !req.query.sourceType) {
			res.status(400).json({
				success: false,
				error: 'Backup ID or Device ID is required',
			});
			return;
		}

		try {
			const progressRes = await this.backupService.getBackupProgress(req.params.id);
			res.setHeader('Cache-Control', 'private, no-store');
			res.status(200).json(progressRes);
		} catch (error: any) {
			res.status(500).json({
				success: false,
				error: error?.message || 'Failed to retrieve Backup Progress',
			});
			return;
		}
	}

	async cancelBackup(req: Request, res: Response): Promise<void> {
		if (!req.params.id || !req.query.planId) {
			res.status(400).json({
				success: false,
				error: 'Backup ID is required',
			});
			return;
		}
		try {
			const cancelResult = await this.backupService.cancelBackup(
				req.query.planId as string,
				req.params.id
			);
			res.status(200).json(cancelResult);
			return;
		} catch (error: any) {
			console.log('[error] cancelBackupRestore :', error);
			res.status(500).json({
				success: false,
				error: error.message || 'Unknown Error',
			});
			return;
		}
	}

	async updateBackup(req: Request, res: Response): Promise<void> {
		if (!req.params.id) {
			res.status(400).json({
				success: false,
				error: 'Backup ID is required',
			});
			return;
		}

		if (!req.body || Object.keys(req.body).length === 0) {
			res.status(400).json({
				success: false,
				error: 'Update data is required',
			});
			return;
		}
		try {
			const updatedBackup = await this.backupService.updateBackup(req.params.id, req.body);
			res.status(200).json({ success: true, result: updatedBackup });
		} catch (error: any) {
			res.status(500).json({
				success: false,
				error: error?.message || 'Failed to update backup',
			});
		}
	}

	async retryFailedReplications(req: Request, res: Response): Promise<void> {
		if (!req.params.id) {
			res.status(400).json({
				success: false,
				error: 'Backup ID is required',
			});
			return;
		}
		try {
			const result = await this.backupService.retryFailedReplications(
				req.params.id,
				req.query.replicationId as string
			);
			res.status(200).json({ success: true, result });
		} catch (error: any) {
			res.status(error.statusCode || 500).json({
				success: false,
				error: error?.message || 'Failed to retry replications',
			});
		}
	}
}
