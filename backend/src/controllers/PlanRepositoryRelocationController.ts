import type { Request, Response } from 'express';
import { z } from 'zod';
import { PlanRepositoryRelocationService } from '../services/PlanRepositoryRelocationService';
import { AppError } from '../utils/AppError';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const relocationId = z.string().regex(/^[a-f0-9]{24}$/);
const start = z
	.object({ planId: id, storageId: id, storagePath: z.string().min(1).max(4096) })
	.strict();
const deletion = z.object({ confirmTitle: z.string().min(1).max(1024) }).strict();

export type RelocationAction =
	| 'overview'
	| 'start'
	| 'get'
	| 'cancel'
	| 'switch'
	| 'revert'
	| 'delete-source';

export class PlanRepositoryRelocationController {
	constructor(private readonly service: PlanRepositoryRelocationService) {}

	async handle(req: Request, res: Response, action: RelocationAction) {
		res.setHeader('Cache-Control', 'private, no-store');
		try {
			if (action !== 'overview' && Object.keys(req.query).length)
				throw new AppError(400, 'Query overrides are not allowed.');
			let result: unknown;
			if (action === 'overview') {
				const query = z.object({ planId: id }).strict().parse(req.query);
				result = await this.service.overview(query.planId);
			} else if (action === 'start') {
				result = await this.service.start(start.parse(req.body));
			} else {
				const target = relocationId.parse(req.params.id);
				if (action === 'delete-source') {
					result = await this.service.deleteSourceCopy(
						target,
						deletion.parse(req.body).confirmTitle
					);
				} else {
					if (Object.keys(req.body || {}).length)
						throw new AppError(400, 'This operation accepts no overrides.');
					result =
						action === 'get'
							? await this.service.get(target)
							: action === 'cancel'
								? await this.service.cancel(target)
								: action === 'switch'
									? await this.service.switch(target)
									: await this.service.revert(target);
				}
			}
			const accepted = ['start', 'switch', 'revert', 'delete-source'].includes(action);
			res.status(accepted ? 202 : 200).json({ success: true, result });
		} catch (error) {
			res
				.status(
					error instanceof z.ZodError ? 400 : error instanceof AppError ? error.statusCode : 500
				)
				.json({
					success: false,
					error:
						error instanceof z.ZodError
							? 'Invalid repository relocation request.'
							: error instanceof AppError
								? error.message
								: 'Repository relocation request failed safely.',
				});
		}
	}
}
