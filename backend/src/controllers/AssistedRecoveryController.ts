import type { Request, Response } from 'express';
import { z } from 'zod';
import { exportOwner } from './ManagedExportController';
import { AssistedRecoveryService } from '../services/AssistedRecoveryService';
import { AppError } from '../utils/AppError';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const start = z
	.object({
		planId: id,
		backupId: id,
		requestKey: z.string().uuid(),
		mode: z.enum(['prefer-primary', 'manual-replica']),
		includes: z.array(z.string().max(1025)).max(1024).default([]),
		excludes: z.array(z.string().max(1025)).max(1024).default([]),
	})
	.strict();
export class AssistedRecoveryController {
	constructor(private readonly service: AssistedRecoveryService) {}
	async handle(
		req: Request,
		res: Response,
		action: 'start' | 'list' | 'get' | 'approve' | 'cancel'
	) {
		res.setHeader('Cache-Control', 'private, no-store');
		try {
			const owner = exportOwner(req, res);
			if (action !== 'list' && Object.keys(req.query).length)
				throw new AppError(400, 'Query overrides are not allowed.');
			let result: unknown;
			if (action === 'start') result = await this.service.start(owner, start.parse(req.body));
			else if (action === 'list') {
				const query = z.object({ planId: id, backupId: id }).strict().parse(req.query);
				result = this.service.list(owner, query.planId, query.backupId);
			} else {
				const jobId = z
					.string()
					.regex(/^[a-f0-9]{24}$/)
					.parse(req.params.id);
				if (action === 'approve') {
					const body = z.object({ replicationId: id }).strict().parse(req.body);
					result = await this.service.approve(owner, jobId, body.replicationId);
				} else {
					if (Object.keys(req.body || {}).length)
						throw new AppError(400, 'This operation accepts no overrides.');
					result =
						action === 'cancel'
							? await this.service.cancel(owner, jobId)
							: this.service.get(owner, jobId);
				}
			}
			res
				.status(action === 'start' || action === 'approve' ? 202 : 200)
				.json({ success: true, result });
		} catch (error) {
			res
				.status(
					error instanceof z.ZodError ? 400 : error instanceof AppError ? error.statusCode : 500
				)
				.json({
					success: false,
					error:
						error instanceof z.ZodError
							? 'Invalid recovery request.'
							: error instanceof AppError
								? error.message
								: 'Recovery request failed safely.',
				});
		}
	}
}
