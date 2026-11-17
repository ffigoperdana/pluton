import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { AgentController } from '../controllers/AgentController';
import { agentAuthMiddleware, agentTransportMiddleware } from '../middlewares/agentAuthMiddleware';
import { AgentService } from '../services/AgentService';
import type { AgentRequest } from '../types/agents';

/**
 * Agent control-plane budgets, kept apart from the browser-oriented `/api/`
 * limiter in createApp. Agents often reach the server from one client IP (a
 * reverse proxy or NAT), and a busy Agent sends about 270 signed requests per
 * window (command status every 10 s, progress every 5 s). Sharing the browser
 * bucket let an open plan page exhaust it, and the Agent then stopped a long
 * backup after its bounded status retries.
 */
export type AgentRateLimits = {
	windowMs: number;
	/** Enrollment per client IP; the same budget the shared `/api/` limiter gave it. */
	enrollPerIp: number;
	/** Signed requests per client IP before authentication, shared by Agents behind it. */
	signedPerIp: number;
	/** Signed requests per verified Agent, so one misbehaving Agent cannot starve others. */
	perAgent: number;
};

export const AGENT_RATE_LIMITS: AgentRateLimits = {
	windowMs: 15 * 60 * 1000,
	enrollPerIp: 1000,
	signedPerIp: 20_000,
	perAgent: 2_000,
};

/** Agent-only HMAC routes. They intentionally do not use authMiddleware. */
export function createAgentRouter(
	controller: AgentController,
	service: AgentService,
	router: Router = Router(),
	limits: AgentRateLimits = AGENT_RATE_LIMITS
): Router {
	const transport = agentTransportMiddleware(service);
	const authenticated = agentAuthMiddleware(service);
	const window = { windowMs: limits.windowMs, standardHeaders: true, legacyHeaders: false };
	const enrollLimit = rateLimit({ ...window, max: limits.enrollPerIp });
	const signedIpLimit = rateLimit({ ...window, max: limits.signedPerIp });
	// Runs only after authentication succeeded, so the key is a verified Agent ID.
	const agentLimit = rateLimit({
		...window,
		max: limits.perAgent,
		keyGenerator: (req: Request) => `agent:${(req as AgentRequest).agent!.agentId}`,
	});
	const signed = [signedIpLimit, authenticated, agentLimit];
	router.post('/enroll', enrollLimit, transport, controller.enroll.bind(controller));
	router.post('/heartbeat', ...signed, controller.heartbeat.bind(controller));
	router.post('/poll', ...signed, controller.poll.bind(controller));
	router.post('/commands/:id/ack', ...signed, controller.acknowledge.bind(controller));
	router.post('/commands/:id/events', ...signed, controller.event.bind(controller));
	router.post('/commands/:id/complete', ...signed, controller.complete.bind(controller));
	router.post('/commands/:id/status', ...signed, controller.commandStatus.bind(controller));
	return router;
}
