import { readFileSync } from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';
import {
	AGENT_RATE_LIMITS,
	createAgentRouter,
	type AgentRateLimits,
} from '../../src/routes/agents';
import { AppError } from '../../src/utils/AppError';

const limits: AgentRateLimits = { windowMs: 60_000, enrollPerIp: 2, signedPerIp: 6, perAgent: 3 };
const ok = (_req: unknown, res: express.Response) => {
	res.json({ success: true });
};

function agentApp(browserMax = 2): { app: Express; authenticate: jest.Mock } {
	const authenticate = jest.fn(async (input: { agentId?: string }) => {
		if (input.agentId === 'agent-revoked') throw new AppError(401, 'Agent authentication failed.');
		return { agentId: input.agentId, deviceId: `device-${input.agentId}`, secret: 'unused' };
	});
	const service = { assertTransportIsAllowed: jest.fn(), authenticate } as any;
	const controller = {
		enroll: ok,
		heartbeat: ok,
		poll: ok,
		acknowledge: ok,
		event: ok,
		complete: ok,
		commandStatus: ok,
	} as any;
	const app = express();
	app.use(express.json());
	// Same order as createApp: Agent routes first, then the shared browser limiter.
	app.use('/api/agent', createAgentRouter(controller, service, express.Router(), limits));
	app.use(
		'/api/',
		rateLimit({ windowMs: 60_000, max: browserMax, standardHeaders: true, legacyHeaders: false })
	);
	app.get('/api/plans', ok);
	return { app, authenticate };
}

const status = (app: Express, agentId: string) =>
	request(app)
		.post('/api/agent/commands/remote-backup-01/status')
		.set('x-pluton-agent-id', agentId)
		.send({});

describe('Agent control-plane rate limits', () => {
	it('keeps Agent status checks working after browser polling exhausts the shared /api budget', async () => {
		const { app } = agentApp();
		await request(app).get('/api/plans').expect(200);
		await request(app).get('/api/plans').expect(200);
		await request(app).get('/api/plans').expect(429);
		await status(app, 'agent-01').expect(200);
		await request(app)
			.post('/api/agent/poll')
			.set('x-pluton-agent-id', 'agent-01')
			.send({})
			.expect(200);
	});

	it('keeps the browser budget intact while Agents are busy', async () => {
		const { app } = agentApp();
		for (let i = 0; i < limits.perAgent; i++) await status(app, 'agent-01').expect(200);
		await request(app).get('/api/plans').expect(200);
	});

	it('limits each verified Agent separately so one busy Agent cannot starve another behind the same IP', async () => {
		const { app } = agentApp();
		for (let i = 0; i < limits.perAgent; i++) await status(app, 'agent-01').expect(200);
		await status(app, 'agent-01').expect(429);
		await status(app, 'agent-02').expect(200);
	});

	it('counts unauthenticated signed-route requests per IP and rejects before authentication', async () => {
		const { app, authenticate } = agentApp();
		for (let i = 0; i < limits.signedPerIp; i++) await status(app, 'agent-revoked').expect(401);
		authenticate.mockClear();
		await status(app, 'agent-02').expect(429);
		expect(authenticate).not.toHaveBeenCalled();
	});

	it('gives enrollment its own per-IP budget, unaffected by signed traffic', async () => {
		const { app } = agentApp();
		for (let i = 0; i < limits.perAgent; i++) await status(app, 'agent-01').expect(200);
		await request(app).post('/api/agent/enroll').send({}).expect(200);
		await request(app).post('/api/agent/enroll').send({}).expect(200);
		await request(app).post('/api/agent/enroll').send({}).expect(429);
		await status(app, 'agent-02').expect(200);
	});

	it('leaves unknown /api/agent paths and /api/agent-admin under the shared limiter', async () => {
		const { app } = agentApp(1);
		app.get('/api/agent-admin/tokens', ok);
		await request(app).get('/api/agent-admin/tokens').expect(200);
		await request(app).get('/api/agent-admin/tokens').expect(429);
		await request(app).post('/api/agent/unknown').send({}).expect(429);
	});

	it('production budgets leave headroom for many busy Agents behind one proxy IP', () => {
		// A busy Agent: one command status every 10 s plus one progress event every 5 s.
		const busyAgentPerWindow =
			AGENT_RATE_LIMITS.windowMs / 10_000 + AGENT_RATE_LIMITS.windowMs / 5_000;
		expect(AGENT_RATE_LIMITS.windowMs).toBe(15 * 60 * 1000);
		expect(AGENT_RATE_LIMITS.perAgent).toBeGreaterThanOrEqual(5 * busyAgentPerWindow);
		expect(AGENT_RATE_LIMITS.signedPerIp).toBeGreaterThanOrEqual(50 * busyAgentPerWindow);
		expect(AGENT_RATE_LIMITS.enrollPerIp).toBeLessThanOrEqual(1000);
	});

	it('createApp mounts the Agent router before the shared /api limiter, exactly once', () => {
		const source = readFileSync(path.join(__dirname, '../../src/createApp.ts'), 'utf8');
		const agentMount = "app.use('/api/agent', createAgentRouter(agentController, agentService));";
		const limiterMount = "app.use('/api/', apiLimiter);";
		expect(source.split(agentMount)).toHaveLength(2);
		expect(source.indexOf(agentMount)).toBeGreaterThan(-1);
		expect(source.indexOf(agentMount)).toBeLessThan(source.indexOf(limiterMount));
	});
});
