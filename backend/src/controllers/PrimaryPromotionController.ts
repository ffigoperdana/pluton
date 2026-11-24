import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PrimaryPromotionService } from '../services/PrimaryPromotionService';
import { AppError } from '../utils/AppError';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const promotionId = z.string().regex(/^[a-f0-9]{24}$/);
const start = z.object({ planId: id, replicationId: id }).strict();

export type PromotionAction = 'overview' | 'start' | 'get' | 'cancel';

/** Stage 4 promotion API (docs/PRIMARY_PROMOTION.md). */
export class PrimaryPromotionController {
	constructor(private readonly service: PrimaryPromotionService) {}

	async handle(req: Request, res: Response, action: PromotionAction) {
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
				const target = promotionId.parse(req.params.id);
				if (Object.keys(req.body || {}).length)
					throw new AppError(400, 'This operation accepts no overrides.');
				result =
					action === 'get' ? await this.service.get(target) : await this.service.cancel(target);
			}
			res.status(action === 'start' ? 202 : 200).json({ success: true, result });
		} catch (error) {
			res
				.status(
					error instanceof z.ZodError ? 400 : error instanceof AppError ? error.statusCode : 500
				)
				.json({
					success: false,
					error:
						error instanceof z.ZodError
							? 'Invalid replica promotion request.'
							: error instanceof AppError
								? error.message
								: 'Replica promotion request failed safely.',
				});
		}
	}
}
