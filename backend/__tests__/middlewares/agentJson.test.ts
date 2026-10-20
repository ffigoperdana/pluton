import crypto from 'node:crypto';
import Cryptr from 'cryptr';
import express, { type ErrorRequestHandler, type Express } from 'express';
import request from 'supertest';
import { agentJson } from '../../src/middlewares/agentJson';
import { databaseRestoreInputError } from '../../src/routes/databaseRestores';
import { createAgentRouter } from '../../src/routes/agents';
import { AgentController } from '../../src/controllers/AgentController';
import { AgentService } from '../../src/services/AgentService';
import { AgentSourceAccessService } from '../../src/services/AgentSourceAccessService';
import { signAgentRequest } from '../../src/utils/agentProtocol';
import { sourceAccessResultSchema } from '../../src/utils/agentSourceAccess';
import type { AgentRequest } from '../../src/types/agents';

jest.mock('../../src/services/ConfigService', () => ({
	configService: {
		config: { SECRET: 'synthetic-agent-json-encryption-key', ALLOW_INSECURE_AGENT_HTTP: true },
	},
}));

const encryptionKey = 'synthetic-agent-json-encryption-key';
const agentSecret = 'synthetic-agent-json-hmac-key';
const agentId = 'agent-example-size';
const commandId = 'source-command-example-size';
const completionPath = `/api/agent/commands/${commandId}/complete`;

function maximumCompletion() {
	const roots = Array.from({ length: 32 }, (_, index) => {
		const prefix = `/srv/example-app-${index}/`;
		return prefix + '界'.repeat(1024 - prefix.length);
	});
	return {
		leaseToken: 'l'.repeat(32),
		sequence: 2,
		success: true,
		result: {
			sourceAccess: {
				version: 1,
				hostPolicyRevision: 'a'.repeat(64),
				effectiveVersion: 1,
				approvedRoots: roots,
				effectiveRoots: roots,
				rootStatuses: roots.map(path => ({ path, status: 'readable' })),
				lastAppliedRequestId: 'source-example-size',
			},
			validation: roots.map(path => ({
				requestedPath: path,
				canonicalPath: path,
				status: 'approved',
			})),
		},
	};
}

function signedHeaders(pathname: string, raw: string) {
	const timestamp = Date.now().toString(),
		nonce = crypto.randomBytes(24).toString('base64url');
	return {
		'Content-Type': 'application/json',
		'x-pluton-agent-id': agentId,
		'x-pluton-agent-timestamp': timestamp,
		'x-pluton-agent-nonce': nonce,
		'x-pluton-agent-signature': signAgentRequest(
			agentSecret,
			timestamp,
			nonce,
			'POST',
			pathname,
			raw
		),
	};
}

describe('Agent JSON transport budget', () => {
	let app: Express;
	let sourceStore: { complete: jest.Mock; getRequestForCommand: jest.Mock; getState: jest.Mock };
	let reserveNonce: jest.Mock;
	let capturedRaw: string | undefined;

	beforeEach(() => {
		sourceStore = {
			complete: jest.fn().mockResolvedValue(true),
			getRequestForCommand: jest.fn().mockResolvedValue(null),
			getState: jest.fn().mockResolvedValue(null),
		};
		reserveNonce = jest.fn().mockResolvedValue(true);
		capturedRaw = undefined;
		const agentStore = {
			getAgentById: jest
				.fn()
				.mockResolvedValue({
					agentId,
					deviceId: 'remote-example-size',
					revokedAt: null,
					encryptedSecret: new Cryptr(encryptionKey).encrypt(agentSecret),
				}),
			reserveNonce,
			getCommandForAgent: jest.fn().mockResolvedValue({ type: 'SOURCE_ACCESS_APPLY' }),
		};
		const sourceService = new AgentSourceAccessService(sourceStore as any, agentStore as any);
		const service = new AgentService(
			agentStore as any,
			encryptionKey,
			undefined,
			undefined,
			sourceService
		);
		app = express();
		// Preserve the parser order and limits used by createApp.
		app.use('/api/database-restores', express.json({ limit: '8kb' }));
		app.use(databaseRestoreInputError);
		app.use('/api/agent', agentJson);
		app.use(
			express.json({
				verify: (req, _res, buffer) => {
					(req as AgentRequest).rawBody = buffer.toString('utf8');
				},
			})
		);
		app.use('/api/agent', (req, _res, next) => {
			capturedRaw = (req as AgentRequest).rawBody;
			next();
		});
		app.use('/api/agent', createAgentRouter(new AgentController(service), service));
		app.post('/api/example', (_req, res) => res.json({ success: true }));
		app.post('/api/agent-admin/example', (_req, res) => res.json({ success: true }));
		app.post('/api/database-restores/example', (_req, res) => res.json({ success: true }));
		const inputError: ErrorRequestHandler = (error, _req, res, _next) => {
			res.status(error.type === 'entity.too.large' ? 413 : 400).json({ success: false });
		};
		app.use(inputError);
	});

	it('accepts and HMAC-authenticates the full strict completion at maximum root count and UTF-8 path length', async () => {
		const completion = maximumCompletion();
		expect(completion.result.sourceAccess.approvedRoots.every(root => root.length === 1024)).toBe(
			true
		);
		expect(sourceAccessResultSchema.safeParse(completion.result).success).toBe(true);
		// Deliberate extra whitespace proves the generic parser cannot reserialize the signed body.
		const raw = `\n ${JSON.stringify(completion)} \n`;
		expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(100 * 1024);
		expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(512 * 1024);
		const response = await request(app)
			.post(completionPath)
			.set(signedHeaders(completionPath, raw))
			.send(raw);
		expect(response.status).toBe(200);
		expect(capturedRaw).toBe(raw);
		expect(reserveNonce).toHaveBeenCalledTimes(1);
		expect(sourceStore.complete).toHaveBeenCalledWith(
			expect.objectContaining({ commandId, agentId, result: completion.result })
		);
	});

	it('rejects a maximum-size completion when its exact signed body changes', async () => {
		const raw = JSON.stringify(maximumCompletion());
		const response = await request(app)
			.post(completionPath)
			.set(signedHeaders(completionPath, raw))
			.send(` ${raw}`);
		expect(response.status).toBe(401);
		expect(sourceStore.complete).not.toHaveBeenCalled();
	});

	it('keeps strict Source Access parsing for large authenticated bodies', async () => {
		const completion = maximumCompletion();
		const raw = JSON.stringify({
			...completion,
			result: { ...completion.result, arbitraryFiles: ['synthetic-example'] },
		});
		const response = await request(app)
			.post(completionPath)
			.set(signedHeaders(completionPath, raw))
			.send(raw);
		expect(response.status).toBe(400);
		expect(sourceStore.complete).not.toHaveBeenCalled();
	});

	it('refuses more than 512 KiB on Agent routes before authentication or command completion', async () => {
		const raw = JSON.stringify({ padding: 'x'.repeat(512 * 1024) });
		const response = await request(app)
			.post(completionPath)
			.set(signedHeaders(completionPath, raw))
			.send(raw);
		expect(response.status).toBe(413);
		expect(reserveNonce).not.toHaveBeenCalled();
		expect(sourceStore.complete).not.toHaveBeenCalled();
	});

	it.each(['/api/example', '/api/agent-admin/example'])(
		'retains the default 100 KiB budget at %s',
		async pathname => {
			const raw = JSON.stringify(maximumCompletion());
			expect((await request(app).post(pathname).type('json').send(raw)).status).toBe(413);
			expect(
				(
					await request(app)
						.post(pathname)
						.type('json')
						.send({ padding: 'x'.repeat(90 * 1024) })
				).status
			).toBe(200);
		}
	);

	it('retains the independent 8 KiB database restore budget and safe input error', async () => {
		const pathname = '/api/database-restores/example';
		const refused = await request(app)
			.post(pathname)
			.type('json')
			.send({ padding: 'x'.repeat(9 * 1024) });
		expect(refused.status).toBe(413);
		expect(refused.body).toEqual({
			success: false,
			error: 'Invalid or oversized database restore JSON.',
		});
		expect(
			(
				await request(app)
					.post(pathname)
					.type('json')
					.send({ padding: 'x'.repeat(7 * 1024) })
			).status
		).toBe(200);
	});
});
