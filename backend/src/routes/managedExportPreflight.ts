import { Router } from 'express';
import auth from '../middlewares/authMiddleware';
import { ManagedExportController } from '../controllers/ManagedExportController';
export function createManagedExportPreflightRouter(controller: ManagedExportController): Router {
	const router = Router();
	router.get('/configuration', auth, controller.configuration.bind(controller));
	router.get('/readiness', auth, controller.readiness.bind(controller));
	router.get('/activity', auth, controller.activity.bind(controller));
	router.post('/inventory-checks', auth, controller.inventory.bind(controller));
	router.get('/inventory-checks/:preflightId', auth, controller.preflightStatus.bind(controller));
	router.delete(
		'/inventory-checks/:preflightId',
		auth,
		controller.cancelPreflight.bind(controller)
	);
	router.post('/preflights', auth, controller.preflight.bind(controller));
	router.get(
		'/preflights/:preflightId/diagnostics',
		auth,
		controller.inspectPreflight.bind(controller)
	);
	router.get('/preflights/:preflightId', auth, controller.preflightStatus.bind(controller));
	router.delete('/preflights/:preflightId', auth, controller.cancelPreflight.bind(controller));
	return router;
}
