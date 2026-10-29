import { Router } from 'express';
import auth from '../middlewares/authMiddleware';
import { ManagedExportController } from '../controllers/ManagedExportController';
export function createManagedExportRouter(controller: ManagedExportController): Router {
	const router = Router();
	router.post('/:id/exports', auth, controller.create.bind(controller));
	router.get('/:id/exports/:exportId', auth, controller.status.bind(controller));
	router.delete('/:id/exports/:exportId', auth, controller.cancel.bind(controller));
	router.post(
		'/:id/exports/:exportId/authorization',
		auth,
		controller.authorization.bind(controller)
	);
	router.get('/:id/exports/:exportId/link', auth, controller.authorization.bind(controller));
	router.head('/:id/exports/:exportId/content', auth, controller.content.bind(controller));
	router.get('/:id/exports/:exportId/content', auth, controller.content.bind(controller));
	return router;
}
