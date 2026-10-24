import { Router, type Request, type Response, type RequestHandler } from 'express';
import { z } from 'zod';
import { McpFault, pageInput, parse, resourceId } from './contracts';
import type { McpStore } from './McpStore';
import type { McpConfig } from './authorization';
import type { McpActionService } from './McpActionService';

/** Mounted only behind the browser administrator and same-origin guard. */
export function createV2AdminRouter(
	store: McpStore,
	config?: McpConfig,
	actions?: McpActionService
): Router {
	const router = Router();
	const actor = (res: Response) => res.locals.mcpAdministrator as string;
	const id = (req: Request) => parse(resourceId, req.params.id);
	const empty = (req: Request) => parse(z.object({}).strict(), req.body);
	const enabled = () => {
		if (!config?.nativeTokens) throw new McpFault(409, 'native_tokens_not_configured');
	};
	const service = () => {
		if (!actions) throw new McpFault(409, 'actions_unavailable');
		return actions;
	};
	const route =
		(run: (req: Request, res: Response) => unknown, status = 200): RequestHandler =>
		async (req, res) => {
			try {
				const result = await run(req, res);
				res.status(status).json({ schemaVersion: '1', success: true, result });
			} catch (error) {
				res
					.status(error instanceof McpFault ? error.status : 500)
					.json({
						schemaVersion: '1',
						success: false,
						error: error instanceof McpFault ? error.code : 'internal_error',
						traceId: res.locals.traceId,
					});
			}
		};
	router.get(
		'/tokens',
		route(req => {
			const args = parse(pageInput, req.query);
			return store.nativeTokens.list(args.limit, args.offset);
		})
	);
	router.post(
		'/tokens',
		route((req, res) => {
			enabled();
			return store.nativeTokens.create(req.body, actor(res));
		}, 201)
	);
	router.put(
		'/tokens/:id',
		route((req, res) => {
			enabled();
			return store.nativeTokens.edit(id(req), req.body, actor(res));
		})
	);
	router.post(
		'/tokens/:id/revoke',
		route((req, res) => {
			empty(req);
			store.nativeTokens.revoke(id(req), actor(res));
			return { revoked: true };
		})
	);
	router.post(
		'/tokens/:id/state',
		route((req, res) => {
			const args = parse(z.object({ disabled: z.boolean() }).strict(), req.body);
			store.nativeTokens.setDisabled(id(req), args.disabled, actor(res));
			return { disabled: args.disabled };
		})
	);
	router.post(
		'/tokens/:id/rotate',
		route((req, res) => {
			enabled();
			const args = parse(
				z.object({ ttlHours: z.number().int().min(1).max(2160) }).strict(),
				req.body
			);
			return store.nativeTokens.rotate(id(req), args.ttlHours, actor(res));
		}, 201)
	);
	router.post(
		'/tokens/revoke-all',
		route((req, res) => {
			parse(z.object({ confirm: z.literal('REVOKE ALL NATIVE TOKENS') }).strict(), req.body);
			store.nativeTokens.revokeAll(actor(res));
			return { revoked: true };
		})
	);
	router.get(
		'/resources',
		route(req => {
			const args = parse(
				pageInput.extend({ kind: z.enum(['plans', 'agents', 'storages']) }).strict(),
				req.query
			);
			return store.resources(args.kind, args.limit, args.offset);
		})
	);
	router.get(
		'/actions',
		route(req => {
			const args = parse(
				pageInput.extend({ pending: z.enum(['true', 'false']).optional() }).strict(),
				req.query
			);
			return service().list(args.limit, args.offset, args.pending === 'true');
		})
	);
	router.post(
		'/actions/:id/approve',
		route((req, res) => {
			enabled();
			const args = parse(
				z.object({ argumentsHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
				req.body
			);
			return service().approve(id(req), actor(res), args.argumentsHash);
		})
	);
	router.post(
		'/actions/:id/reject',
		route((req, res) => {
			empty(req);
			return service().reject(id(req), actor(res));
		})
	);
	router.post(
		'/actions/:id/reconcile',
		route((req, res) => {
			parse(z.object({ confirm: z.literal('RECONCILED') }).strict(), req.body);
			return service().reconcile(id(req), actor(res));
		})
	);
	return router;
}
