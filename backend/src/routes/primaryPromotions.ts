import { Router } from 'express';
import authM from '../middlewares/authMiddleware';
import { PrimaryPromotionController } from '../controllers/PrimaryPromotionController';

export function createPrimaryPromotionRouter(controller: PrimaryPromotionController): Router {
	const router = Router();
	router.get('/', authM, (req, res) => controller.handle(req, res, 'overview'));
	router.post('/', authM, (req, res) => controller.handle(req, res, 'start'));
	router.get('/:id', authM, (req, res) => controller.handle(req, res, 'get'));
	router.post('/:id/cancel', authM, (req, res) => controller.handle(req, res, 'cancel'));
	return router;
}
