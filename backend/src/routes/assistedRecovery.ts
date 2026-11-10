import { Router } from 'express';
import authM from '../middlewares/authMiddleware';
import { AssistedRecoveryController } from '../controllers/AssistedRecoveryController';
export function createAssistedRecoveryRouter(controller: AssistedRecoveryController): Router {
	const router = Router();
	router.post('/', authM, (req, res) => controller.handle(req, res, 'start'));
	router.get('/', authM, (req, res) => controller.handle(req, res, 'list'));
	router.get('/:id', authM, (req, res) => controller.handle(req, res, 'get'));
	router.post('/:id/approve', authM, (req, res) => controller.handle(req, res, 'approve'));
	router.post('/:id/cancel', authM, (req, res) => controller.handle(req, res, 'cancel'));
	return router;
}
