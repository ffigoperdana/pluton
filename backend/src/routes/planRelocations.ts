import { Router } from 'express';
import authM from '../middlewares/authMiddleware';
import { PlanRepositoryRelocationController } from '../controllers/PlanRepositoryRelocationController';

export function createPlanRelocationRouter(controller: PlanRepositoryRelocationController): Router {
	const router = Router();
	router.get('/', authM, (req, res) => controller.handle(req, res, 'overview'));
	router.post('/', authM, (req, res) => controller.handle(req, res, 'start'));
	router.get('/:id', authM, (req, res) => controller.handle(req, res, 'get'));
	router.post('/:id/cancel', authM, (req, res) => controller.handle(req, res, 'cancel'));
	router.post('/:id/switch', authM, (req, res) => controller.handle(req, res, 'switch'));
	router.post('/:id/revert', authM, (req, res) => controller.handle(req, res, 'revert'));
	router.delete('/:id/source-copy', authM, (req, res) =>
		controller.handle(req, res, 'delete-source')
	);
	return router;
}
