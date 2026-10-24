import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import express from 'express';
import request from 'supertest';
import { McpStore } from '../../src/mcp/McpStore';
import { McpActionService } from '../../src/mcp/McpActionService';
import { OperationalReadService, toolCatalog } from '../../src/mcp/OperationalReadService';
import { actionNames, actionSchemas } from '../../src/mcp/v2Contracts';
import { createMcpGateway, createMcpAdminRouter, isMcpMachineRequest } from '../../src/mcp/gateway';
import { mcpConfig } from '../../src/mcp/authorization';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const config = { resource: 'https://backup.example.internal/mcp', nativeTokens: true };
const writeInput = {
	name: 'Synthetic client',
	purpose: 'Disposable test',
	mode: 'write',
	tools: actionNames.map(name => `pluton_request_${name}`),
	planIds: ['plan-01'],
	agentIds: ['agent-01'],
	storageIds: ['storage-01'],
	ttlHours: 1,
};
const args = { planId: 'plan-01', idempotencyKey: 'intent-example-0001' };
function fixture() {
	const db = new Database(':memory:');
	migrate(drizzle(db), { migrationsFolder: path.resolve('drizzle') });
	const store = new McpStore(db);
	store.setPolicy(true, [], 'administrator');
	db.prepare(
		"INSERT INTO storages(id,name,credentials,settings) VALUES('storage-01','Example storage','{}','{}')"
	).run();
	db.prepare("INSERT INTO devices(id,name) VALUES('device-01','app-01')").run();
	db.prepare(
		'INSERT INTO plans(id,title,source_id,source_config,storage_id,storage_path,settings) VALUES(?,?,?,?,?,?,?)'
	).run(
		'plan-01',
		'Example plan',
		'device-01',
		'{"includes":["/srv/example-app"],"excludes":[]}',
		'storage-01',
		'example-app',
		'{"interval":{"type":"daily","time":"01:00AM","timeZone":"Asia/Jakarta"}}'
	);
	db.prepare(
		'INSERT INTO agent_identities(agent_id,device_id,encrypted_secret,hostname,os,architecture,agent_version,capabilities) VALUES(?,?,?,?,?,?,?,?)'
	).run('agent-01', 'device-01', 'synthetic', 'app-01', 'linux', 'x64', '0.7.0', '{}');
	db.prepare('INSERT INTO agent_source_access_state VALUES(?,?,?,?,?)').run(
		'agent-01',
		'{"effectiveVersion":1}',
		'[]',
		1,
		1
	);
	db.prepare(
		'INSERT INTO backups(id,plan_id,source_id,method,status,success,in_progress) VALUES(?,?,?,?,?,?,?)'
	).run('backup-01', 'plan-01', 'device-01', 'backup', 'completed', 1, 0);
	const calls: { method: string; args: unknown[] }[] = [];
	let fail = false;
	const fn =
		(method: string, result?: unknown) =>
		async (...params: unknown[]) => {
			calls.push({ method, args: params });
			if (fail) throw new Error('synthetic private service message');
			return result;
		};
	const services = {
		plans: {
			performBackup: fn('backup', 'accepted'),
			pauseBackup: fn('pause'),
			resumeBackup: fn('resume'),
			updatePlan: fn('update'),
			createPlan: fn('create', { id: 'created-plan-01' }),
		},
		backups: { cancelBackup: fn('cancel') },
		recovery: { enqueue: fn('recovery', { id: 'recovery-01' }) },
	};
	const actions = new McpActionService(db, store, services as never);
	const issued = store.nativeTokens.create(writeInput, 'administrator');
	const principal = store.nativeTokens.authenticate(issued.token);
	const app = express();
	app.set('trust proxy', 'loopback');
	const gateway = createMcpGateway(
		store,
		new OperationalReadService(drizzle(db) as never),
		config,
		undefined,
		actions
	);
	app.use((req, res, next) => (isMcpMachineRequest(req) ? gateway(req, res, next) : next()));
	app.use(express.json());
	app.use(
		'/api/mcp-admin',
		createMcpAdminRouter(
			store,
			(req, res, next) => {
				if (req.headers['x-test-admin'] !== 'yes') {
					res.sendStatus(401);
					return;
				}
				res.locals.mcpAdministrator = 'administrator';
				next();
			},
			config,
			actions
		)
	);
	app.get('/mcp', (_req, res) => res.type('html').send('<html>Dashboard</html>'));
	return {
		db,
		store,
		actions,
		calls,
		issued,
		principal,
		app,
		services,
		fail: () => {
			fail = true;
		},
		close: () => db.close(),
	};
}
const fault = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
function rpc(f: ReturnType<typeof fixture>, name: string, arguments_: unknown = {}) {
	return request(f.app)
		.post('/mcp')
		.set('Host', 'backup.example.internal')
		.set('X-Forwarded-Proto', 'https')
		.set('Accept', 'application/json, text/event-stream')
		.set('Authorization', `Bearer ${f.issued.token}`)
		.send({
			jsonrpc: '2.0',
			id: 1,
			method: name === 'tools/list' ? name : 'tools/call',
			...(name === 'tools/list' ? {} : { params: { name, arguments: arguments_ } }),
		});
}

test('official SDK native read-write flow requests, receives human approval and polls only its action', async () => {
	const f = fixture();
	const client = new Client({ name: 'synthetic-sdk-client', version: '2' });
	try {
		const issued = f.store.nativeTokens.create(
			{
				...writeInput,
				mode: 'read_write',
				tools: [...writeInput.tools, ...toolCatalog.map(tool => tool.name)],
			},
			'administrator'
		);
		const bridge: typeof fetch = async (url, init) => {
			const headers = new Headers(init?.headers);
			const pending = (request(f.app) as any)
				[(init?.method || 'GET').toLowerCase()](new URL(String(url)).pathname)
				.set('Host', 'backup.example.internal')
				.set('X-Forwarded-Proto', 'https');
			headers.forEach((value, name) => pending.set(name, value));
			const response = await (init?.body ? pending.send(String(init.body)) : pending);
			return new Response(response.status === 204 ? null : response.text, {
				status: response.status,
				headers: response.headers as Record<string, string>,
			});
		};
		await client.connect(
			new StreamableHTTPClientTransport(new URL(config.resource), {
				fetch: bridge,
				requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
			})
		);
		assert.equal(
			(await client.listTools()).tools.length,
			toolCatalog.length + actionNames.length + 1
		);
		assert.equal(
			(await client.callTool({ name: 'pluton_get_plan', arguments: { id: 'plan-01' } })).isError,
			undefined
		);
		const requested = await client.callTool({ name: 'pluton_request_backup_now', arguments: args });
		const own = requested.structuredContent as { id: string; status: string };
		assert.equal(own.status, 'pending_approval');
		assert.equal(f.calls.length, 0);
		const record = f.actions.list(20, 0).items[0];
		assert.equal(
			(
				await request(f.app)
					.post(`/api/mcp-admin/actions/${own.id}/approve`)
					.set('x-test-admin', 'yes')
					.send({ argumentsHash: record.argumentsHash })
			).body.result.status,
			'dispatched'
		);
		const status = await client.callTool({
			name: 'pluton_get_action_status',
			arguments: { id: own.id },
		});
		assert.equal((status.structuredContent as { status: string }).status, 'dispatched');
		assert.equal(f.calls.length, 1);
		f.store.nativeTokens.revoke(issued.metadata.id, 'administrator');
		await assert.rejects(client.listTools());
	} finally {
		await client.close();
		f.close();
	}
});

test('native token verifier, copy-once metadata, permissions and lifecycle', () => {
	const f = fixture();
	try {
		assert.match(f.issued.token, /^pluton_mcp_[a-f0-9]{24}\.[\w-]{43}$/);
		const serialized = JSON.stringify(f.store.nativeTokens.list(20, 0));
		assert.ok(!serialized.includes(f.issued.token));
		assert.ok(!serialized.includes('verifier'));
		assert.ok(
			!JSON.stringify(f.db.prepare('SELECT * FROM mcp_tokens').all()).includes(f.issued.token)
		);
		assert.ok(!JSON.stringify(f.store.activity(50, 0)).includes(f.issued.token));
		assert.throws(
			() => f.store.nativeTokens.authenticate(f.issued.token + 'x'),
			fault('invalid_token')
		);
		assert.throws(
			() =>
				f.store.nativeTokens.authenticate('pluton_mcp_' + '0'.repeat(24) + '.' + 'a'.repeat(43)),
			fault('invalid_token')
		);
		assert.equal(f.store.nativeTokens.can(f.issued.metadata.id, toolCatalog[0].name), false);
		assert.throws(
			() => f.store.nativeTokens.create({ ...writeInput, mode: 'read' }, 'administrator'),
			fault('invalid_request')
		);
		assert.throws(
			() => f.store.nativeTokens.create({ ...writeInput, planIds: ['*'] }, 'administrator'),
			fault('invalid_request')
		);
		f.store.nativeTokens.setDisabled(f.issued.metadata.id, true, 'administrator');
		assert.throws(() => f.store.nativeTokens.authenticate(f.issued.token), fault('invalid_token'));
		f.store.nativeTokens.setDisabled(f.issued.metadata.id, false, 'administrator');
		const rotated = f.store.nativeTokens.rotate(f.issued.metadata.id, 1, 'administrator');
		assert.throws(() => f.store.nativeTokens.authenticate(f.issued.token), fault('invalid_token'));
		assert.ok(f.store.nativeTokens.authenticate(rotated.token));
		f.db
			.prepare('UPDATE mcp_tokens SET expires_at=? WHERE id=?')
			.run(Date.now() - 1, rotated.metadata.id);
		assert.throws(() => f.store.nativeTokens.authenticate(rotated.token), fault('invalid_token'));
		const fresh = f.store.nativeTokens.create(writeInput, 'administrator');
		f.store.nativeTokens.revokeAll('administrator');
		assert.throws(() => f.store.nativeTokens.authenticate(fresh.token), fault('invalid_token'));
	} finally {
		f.close();
	}
});
test('write-only MCP discovery and own-status access never grant operational reads or approval', async () => {
	const f = fixture();
	try {
		const listed = await rpc(f, 'tools/list');
		assert.equal(listed.status, 200);
		assert.equal(listed.body.result.tools.length, actionNames.length + 1);
		assert.ok(
			listed.body.result.tools.every(
				(tool: { name: string }) =>
					tool.name.startsWith('pluton_request_') || tool.name === 'pluton_get_action_status'
			)
		);
		for (const tool of toolCatalog) assert.ok((await rpc(f, tool.name)).body.error);
		assert.ok((await rpc(f, 'pluton_request_backup_now', { ...args, approved: true })).body.error);
		assert.ok((await rpc(f, 'pluton_approve_action', { ...args })).body.error);
		const result = await rpc(f, 'pluton_request_backup_now', args);
		const action = result.body.result.structuredContent;
		assert.equal(action.status, 'pending_approval');
		assert.equal(f.calls.length, 0);
		assert.equal(
			(await rpc(f, 'pluton_get_action_status', { id: action.id })).body.result.structuredContent
				.id,
			action.id
		);
		const other = f.store.nativeTokens.create(writeInput, 'administrator');
		assert.throws(
			() => f.actions.status(f.store.nativeTokens.authenticate(other.token), action.id),
			fault('not_found')
		);
		assert.equal(
			(
				await request(f.app)
					.post(`/api/mcp-admin/actions/${action.id}/approve`)
					.set('Authorization', `Bearer ${f.issued.token}`)
					.send({ argumentsHash: 'a'.repeat(64) })
			).status,
			401
		);
		assert.equal((await request(f.app).get('/mcp').set('Accept', 'text/html')).type, 'text/html');
		assert.equal(
			(
				await request(f.app)
					.get('/.well-known/oauth-protected-resource/mcp')
					.set('Host', 'backup.example.internal')
					.set('X-Forwarded-Proto', 'https')
			).status,
			404
		);
	} finally {
		f.close();
	}
});
test('immutable approval binding, idempotency, conflicts, concurrent dispatch and no replay', async () => {
	const f = fixture();
	try {
		const action = f.actions.submit(f.principal, 'backup_now', args);
		const record = f.actions.list(20, 0).items[0];
		assert.equal(f.actions.submit(f.principal, 'backup_now', args).id, action.id);
		assert.throws(
			() => f.actions.submit(f.principal, 'pause_plan', args),
			fault('idempotency_conflict')
		);
		assert.throws(
			() =>
				f.actions.submit(f.principal, 'pause_plan', {
					...args,
					idempotencyKey: 'another-intent-0001',
				}),
			fault('plan_action_conflict')
		);
		assert.throws(
			() => f.db.prepare('UPDATE mcp_actions SET arguments=? WHERE id=?').run('{}', action.id),
			/immutable/
		);
		await assert.rejects(
			f.actions.approve(action.id, 'mcp-token:any', record.argumentsHash),
			fault('human_confirmation_required')
		);
		await assert.rejects(
			f.actions.approve(action.id, 'administrator', 'a'.repeat(64)),
			fault('human_confirmation_required')
		);
		const result = await Promise.allSettled([
			f.actions.approve(action.id, 'administrator', record.argumentsHash),
			f.actions.approve(action.id, 'administrator', record.argumentsHash),
		]);
		assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
		assert.equal(f.calls.length, 1);
		assert.deepEqual(f.calls[0], { method: 'backup', args: ['plan-01'] });
		assert.equal(f.actions.submit(f.principal, 'backup_now', args).status, 'dispatched');
		f.actions.recoverInterrupted();
		assert.equal(f.calls.length, 1);
	} finally {
		f.close();
	}
});
test('all actions dispatch through existing domain services with narrowed fields', async t => {
	for (const actionName of actionNames)
		await t.test(actionName, async () => {
			const f = fixture();
			try {
				if (actionName === 'resume_plan')
					f.db.prepare("UPDATE plans SET active=0 WHERE id='plan-01'").run();
				if (actionName === 'cancel_backup')
					f.db
						.prepare("UPDATE backups SET in_progress=1,status='running' WHERE id='backup-01'")
						.run();
				const input = {
					...args,
					...(actionName === 'update_plan' || actionName === 'create_plan'
						? { title: 'Reviewed title' }
						: {}),
					...(actionName === 'recovery_test' || actionName === 'cancel_backup'
						? { backupId: 'backup-01' }
						: {}),
					...(actionName === 'update_exclusions' ? { exclusions: ['cache/**', '*.tmp'] } : {}),
					...(actionName === 'update_schedule'
						? { interval: { type: 'daily', time: '02:00AM', timeZone: 'Asia/Jakarta' } }
						: {}),
				};
				const action = f.actions.submit(f.principal, actionName, input);
				const record = f.actions.list(20, 0).items[0];
				assert.equal(f.calls.length, 0);
				const result = await f.actions.approve(action.id, 'administrator', record.argumentsHash);
				assert.equal(result.status, 'dispatched');
				assert.equal(f.calls.length, 1);
				if (actionName === 'create_plan') {
					assert.deepEqual(f.calls[0].args[1], { runNow: false });
					assert.equal(result.resultId, 'created-plan-01');
					assert.match(
						(f.calls[0].args[0] as { storagePath: string }).storagePath,
						/^example-app-mcp-/
					);
				}
				if (actionName === 'update_exclusions')
					assert.deepEqual(f.calls[0].args[1], {
						sourceConfig: { includes: ['/srv/example-app'], excludes: ['cache/**', '*.tmp'] },
					});
				if (actionName === 'update_schedule')
					assert.deepEqual(Object.keys((f.calls[0].args[1] as { settings: object }).settings), [
						'interval',
					]);
				if (actionName === 'recovery_test')
					assert.deepEqual(f.calls[0].args, ['plan-01', 'backup-01']);
			} finally {
				f.close();
			}
		});
});
test('permission, resource, policy, expiry and rejection boundaries prevent dispatch', async t => {
	for (const change of [
		'revoke',
		'disable',
		'edit',
		'policy',
		'tool',
		'plan',
		'agent',
		'storage',
		'source',
		'expiry',
		'reject',
	])
		await t.test(change, async () => {
			const f = fixture();
			const realNow = Date.now;
			try {
				const action = f.actions.submit(f.principal, 'backup_now', args);
				const row = f.actions.list(20, 0).items[0];
				if (change === 'revoke') f.store.nativeTokens.revoke(f.issued.metadata.id, 'administrator');
				if (change === 'disable')
					f.store.nativeTokens.setDisabled(f.issued.metadata.id, true, 'administrator');
				if (change === 'edit')
					f.store.nativeTokens.edit(f.issued.metadata.id, writeInput, 'administrator');
				if (change === 'policy') f.store.setPolicy(false, [], 'administrator');
				if (change === 'tool')
					f.store.setPolicy(true, ['pluton_request_backup_now'], 'administrator');
				if (change === 'plan')
					f.db.prepare("UPDATE plans SET title='Changed' WHERE id='plan-01'").run();
				if (change === 'agent')
					f.db.prepare("UPDATE agent_identities SET revoked_at=1 WHERE agent_id='agent-01'").run();
				if (change === 'storage')
					f.db.prepare("UPDATE storages SET settings='{} ' WHERE id='storage-01'").run();
				if (change === 'source')
					f.db
						.prepare(
							"UPDATE agent_source_access_state SET selected_roots='[\"/srv/changed\"]' WHERE agent_id='agent-01'"
						)
						.run();
				if (change === 'expiry') Date.now = () => realNow() + 901000;
				if (change === 'reject') f.actions.reject(action.id, 'administrator');
				await assert.rejects(f.actions.approve(action.id, 'administrator', row.argumentsHash));
				assert.equal(f.calls.length, 0);
			} finally {
				Date.now = realNow;
				f.close();
			}
		});
});
test('crash and domain failure remain uncertain until explicit reconciliation; no automatic retry', async () => {
	const f = fixture();
	try {
		const action = f.actions.submit(f.principal, 'backup_now', args);
		const row = f.actions.list(20, 0).items[0];
		f.fail();
		const result = await f.actions.approve(action.id, 'administrator', row.argumentsHash);
		assert.equal(result.status, 'uncertain');
		assert.ok(!JSON.stringify(result).includes('private service'));
		f.actions.recoverInterrupted();
		await assert.rejects(f.actions.approve(action.id, 'administrator', row.argumentsHash));
		assert.equal(f.calls.length, 1);
		f.actions.reconcile(action.id, 'administrator');
		const next = f.actions.submit(f.principal, 'pause_plan', {
			...args,
			idempotencyKey: 'another-intent-0001',
		});
		f.db.prepare("UPDATE mcp_actions SET status='executing' WHERE id=?").run(next.id);
		f.actions.recoverInterrupted();
		assert.equal(f.actions.status(f.principal, next.id).status, 'uncertain');
		assert.equal(f.calls.length, 1);
	} finally {
		f.close();
	}
});
test('audit failure rolls back credential issuance and prevents side effects', async () => {
	const f = fixture();
	try {
		const action = f.actions.submit(f.principal, 'backup_now', args);
		const row = f.actions.list(20, 0).items[0];
		f.db.exec(
			"CREATE TRIGGER fail_audit BEFORE INSERT ON mcp_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END"
		);
		await assert.rejects(f.actions.approve(action.id, 'administrator', row.argumentsHash));
		assert.equal(f.calls.length, 0);
		assert.equal(f.actions.status(f.principal, action.id).status, 'pending_approval');
		assert.throws(() => f.store.nativeTokens.create(writeInput, 'administrator'));
		assert.equal(f.store.nativeTokens.list(20, 0).items.length, 1);
	} finally {
		f.close();
	}
});
test('strict action inputs and resource allowlists reject dangerous or substituted requests', () => {
	const f = fixture();
	try {
		for (const input of [
			{ ...args, path: '/srv/live' },
			{ ...args, overwrite: true },
			{ ...args, skipHooks: true },
		])
			assert.equal(actionSchemas.backup_now.safeParse(input).success, false);
		assert.throws(
			() => f.actions.submit(f.principal, 'backup_now', { ...args, planId: 'plan-02' }),
			fault('insufficient_scope')
		);
		assert.throws(
			() => f.actions.submit(f.principal, 'cancel_backup', { ...args, backupId: 'another-backup' }),
			fault('not_found')
		);
		assert.throws(
			() => f.actions.submit(f.principal, 'update_exclusions', { ...args, exclusions: ['**'] }),
			fault('unsafe_exclusions')
		);
		assert.throws(
			() =>
				f.actions.submit(f.principal, 'update_exclusions', { ...args, exclusions: ['/srv/live'] }),
			fault('invalid_exclusions')
		);
		const limited = f.store.nativeTokens.create({ ...writeInput, storageIds: [] }, 'administrator');
		assert.throws(
			() => f.actions.submit(f.store.nativeTokens.authenticate(limited.token), 'backup_now', args),
			fault('resource_not_granted')
		);
		const read = f.store.nativeTokens.create(
			{ ...writeInput, mode: 'read', tools: [toolCatalog[0].name] },
			'administrator'
		);
		assert.throws(
			() => f.actions.submit(f.store.nativeTokens.authenticate(read.token), 'backup_now', args),
			fault('insufficient_scope')
		);
		f.db.prepare("UPDATE plans SET source_type='legacy-repository' WHERE id='plan-01'").run();
		assert.throws(
			() => f.actions.submit(f.principal, 'backup_now', args),
			fault('eligible_plan_not_found')
		);
		assert.equal(
			mcpConfig({ MCP_RESOURCE_URL: config.resource, MCP_NATIVE_TOKENS_ENABLED: 'true' })
				?.nativeTokens,
			true
		);
		assert.equal(
			mcpConfig({ MCP_RESOURCE_URL: config.resource, MCP_NATIVE_TOKENS_ENABLED: 'false' }),
			undefined
		);
		assert.equal(
			mcpConfig({
				MCP_RESOURCE_URL: 'http://backup.example.internal/mcp',
				MCP_NATIVE_TOKENS_ENABLED: 'true',
			}),
			undefined
		);
	} finally {
		f.close();
	}
});

test('v1-to-v2 additive upgrade preserves OAuth grants and data; restart never replays claimed actions', () => {
	const db = new Database(':memory:');
	try {
		const journal = JSON.parse(readFileSync(path.resolve('drizzle/meta/_journal.json'), 'utf8'));
		for (const entry of journal.entries.filter((entry: { idx: number }) => entry.idx <= 20))
			db.exec(readFileSync(path.resolve(`drizzle/${entry.tag}.sql`), 'utf8'));
		db.prepare(
			"INSERT INTO mcp_authorizations(id,subject,oauth_client_id,configuration,created_at) VALUES('grant-01','example-user','example-client','{}',1)"
		).run();
		const before = db.prepare('SELECT * FROM mcp_authorizations').all();
		db.exec(readFileSync(path.resolve('drizzle/0021_mcp_native_tokens_actions.sql'), 'utf8'));
		assert.deepEqual(db.prepare('SELECT * FROM mcp_authorizations').all(), before);
		assert.equal((db.prepare('SELECT count(*) n FROM mcp_tokens').get() as { n: number }).n, 0);
		assert.equal(
			(db.prepare('SELECT enabled FROM mcp_policy').get() as { enabled: number }).enabled,
			0
		);
		// Normal migrator bookkeeping is separately checked by re-running the real migrator.
		const migrated = new Database(':memory:');
		try {
			const orm = drizzle(migrated);
			migrate(orm, { migrationsFolder: path.resolve('drizzle') });
			migrate(orm, { migrationsFolder: path.resolve('drizzle') });
			assert.equal(
				(migrated.prepare('SELECT count(*) n FROM __drizzle_migrations').get() as { n: number }).n,
				journal.entries.length
			);
		} finally {
			migrated.close();
		}
	} finally {
		db.close();
	}
});
test('native administrator lifecycle uses strict routes and never returns stored credentials', async () => {
	const f = fixture();
	try {
		const send = (method: string, route: string) =>
			(request(f.app) as any)[method](`/api/mcp-admin/${route}`).set('x-test-admin', 'yes');
		assert.equal((await send('get', 'tokens?limit=51')).status, 400);
		const resources = await send('get', 'resources?kind=storages');
		assert.deepEqual(resources.body.result.items, [{ id: 'storage-01', name: 'Example storage' }]);
		assert.ok(!resources.text.includes('credentials'));
		const created = await send('post', 'tokens').send(writeInput);
		assert.equal(created.status, 201);
		assert.ok(created.body.result.token);
		const id = created.body.result.metadata.id;
		assert.equal(
			(await send('put', `tokens/${id}`).send({ ...writeInput, purpose: 'Edited' })).body.result
				.purpose,
			'Edited'
		);
		assert.equal((await send('post', `tokens/${id}/state`).send({ disabled: true })).status, 200);
		assert.equal((await send('post', `tokens/${id}/state`).send({ disabled: false })).status, 200);
		const rotated = await send('post', `tokens/${id}/rotate`).send({ ttlHours: 1 });
		assert.equal(rotated.status, 201);
		assert.notEqual(rotated.body.result.token, created.body.result.token);
		assert.equal(
			(await send('post', `tokens/${rotated.body.result.metadata.id}/revoke`).send({})).status,
			200
		);
		assert.equal((await send('post', 'tokens/revoke-all').send({ confirm: 'yes' })).status, 400);
		assert.equal(
			(await send('post', 'tokens/revoke-all').send({ confirm: 'REVOKE ALL NATIVE TOKENS' }))
				.status,
			200
		);
		const list = await send('get', 'tokens');
		assert.ok(!list.text.includes(created.body.result.token));
		assert.ok(!list.text.includes('verifier'));
	} finally {
		f.close();
	}
});
test('pending limits, active jobs, unavailable services, forged IDs and native namespace conflicts fail closed', async () => {
	const f = fixture();
	try {
		await assert.rejects(
			f.actions.approve('forged-action', 'administrator', 'a'.repeat(64)),
			fault('action_not_pending')
		);
		f.db.prepare("UPDATE plans SET in_progress=1 WHERE id='plan-01'").run();
		assert.throws(
			() => f.actions.submit(f.principal, 'backup_now', args),
			fault('plan_paused_or_busy')
		);
		f.db.prepare("UPDATE plans SET in_progress=0 WHERE id='plan-01'").run();
		const plans = Array.from({ length: 11 }, (_, index) => `plan-${index + 10}`);
		for (const plan of plans)
			f.db
				.prepare(
					"INSERT INTO plans(id,title,source_id,source_config,storage_id,storage_path,settings) SELECT ?,title,source_id,source_config,storage_id,storage_path,settings FROM plans WHERE id='plan-01'"
				)
				.run(plan);
		f.store.nativeTokens.edit(
			f.issued.metadata.id,
			{ ...writeInput, planIds: plans },
			'administrator'
		);
		for (const [index, planId] of plans.slice(0, 10).entries())
			f.actions.submit(f.principal, 'backup_now', {
				planId,
				idempotencyKey: `limited-intent-000${index}`,
			});
		assert.throws(
			() =>
				f.actions.submit(f.principal, 'backup_now', {
					planId: plans[10],
					idempotencyKey: 'limited-intent-0011',
				}),
			fault('pending_action_limit')
		);
		let oauthCalls = 0;
		const app = express();
		app.set('trust proxy', 'loopback');
		app.use(
			createMcpGateway(
				f.store,
				new OperationalReadService(drizzle(f.db) as never),
				{ ...config, nativeTokens: false },
				async () => {
					oauthCalls++;
					return f.principal;
				},
				f.actions
			)
		);
		const response = await request(app)
			.post('/mcp')
			.set('Host', 'backup.example.internal')
			.set('X-Forwarded-Proto', 'https')
			.set('Authorization', `Bearer ${f.issued.token}`)
			.send({});
		assert.equal(response.status, 401);
		assert.equal(oauthCalls, 0);
		assert.equal(f.calls.length, 0);
	} finally {
		f.close();
	}
});

test('linked backup progress is minimal, terminal observation is audited once, and pending actions survive restart', async () => {
	const f = fixture();
	try {
		f.services.plans.performBackup = async () => {
			f.db
				.prepare(
					"INSERT INTO backups(id,plan_id,source_id,method,in_progress) VALUES('backup-new','plan-01','device-01','backup',1)"
				)
				.run();
			return 'accepted';
		};
		const action = f.actions.submit(f.principal, 'backup_now', args);
		const row = f.actions.list(20, 0).items[0];
		f.actions.recoverInterrupted();
		assert.equal(f.actions.status(f.principal, action.id).status, 'pending_approval');
		assert.equal(
			(await f.actions.approve(action.id, 'administrator', row.argumentsHash)).resultId,
			'backup-new'
		);
		assert.deepEqual(f.actions.status(f.principal, action.id).execution, {
			state: 'in_progress',
			terminal: false,
			success: null,
		});
		f.db
			.prepare(
				"UPDATE backups SET in_progress=0,success=1,error_msg='synthetic-private-error' WHERE id='backup-new'"
			)
			.run();
		const status = f.actions.status(f.principal, action.id);
		assert.deepEqual(status.execution, { state: 'finished', terminal: true, success: true });
		assert.ok(!JSON.stringify(status).includes('private-error'));
		f.actions.status(f.principal, action.id);
		assert.equal(
			(
				f.db
					.prepare(
						"SELECT count(*) n FROM mcp_audit WHERE operation='action.job_completion_observed'"
					)
					.get() as { n: number }
			).n,
			1
		);
	} finally {
		f.close();
	}
});

test('schedule errors, replica grants and private credential changes are bound before dispatch', async () => {
	const f = fixture();
	try {
		assert.throws(
			() =>
				f.actions.submit(f.principal, 'update_schedule', {
					...args,
					interval: { type: 'daily', time: '02:00AM', timeZone: 'Invalid/Zone' },
				}),
			fault('invalid_schedule')
		);
		const original = f.db.prepare("SELECT settings FROM plans WHERE id='plan-01'").get() as {
			settings: string;
		};
		f.db.prepare("UPDATE plans SET settings=? WHERE id='plan-01'").run(
			JSON.stringify({
				...JSON.parse(original.settings),
				replication: {
					enabled: true,
					concurrent: false,
					storages: [{ storageId: 'storage-02' }],
				},
			})
		);
		assert.throws(
			() => f.actions.submit(f.principal, 'backup_now', args),
			fault('replication_resource_not_granted')
		);
		f.db.prepare("UPDATE plans SET settings=? WHERE id='plan-01'").run(original.settings);
		const action = f.actions.submit(f.principal, 'backup_now', args);
		const row = f.actions.list(20, 0).items[0];
		f.db
			.prepare(
				"INSERT INTO remote_plan_database_credentials(plan_id,encrypted_password) VALUES('plan-01','synthetic-encrypted-value')"
			)
			.run();
		await assert.rejects(
			f.actions.approve(action.id, 'administrator', row.argumentsHash),
			fault('resource_changed_request_again')
		);
		assert.equal(f.calls.length, 0);
		assert.ok(!JSON.stringify(f.actions.list(20, 0)).includes('synthetic-encrypted-value'));
	} finally {
		f.close();
	}
});

test('saved recovery policy timestamps remain valid and policy edits invalidate approval', async () => {
	const f = fixture();
	try {
		f.db
			.prepare('INSERT INTO recovery_test_policies(plan_id,policy) VALUES(?,?)')
			.run(
				'plan-01',
				JSON.stringify({
					enabled: true,
					databaseImport: 'disabled',
					enabledAt: Date.now(),
					targetModes: { mysql: 'internal' },
				})
			);
		const action = f.actions.submit(f.principal, 'recovery_test', {
			...args,
			backupId: 'backup-01',
		});
		const row = f.actions.list(20, 0).items[0];
		assert.equal((row.preview.after as { databaseImport: string }).databaseImport, 'disabled');
		assert.equal(
			(await f.actions.approve(action.id, 'administrator', row.argumentsHash)).status,
			'dispatched'
		);
		const next = f.actions.submit(f.principal, 'recovery_test', {
			...args,
			backupId: 'backup-01',
			idempotencyKey: 'another-recovery-01',
		});
		const record = f.actions.list(20, 0).items.find(item => item.id === next.id)!;
		f.db
			.prepare("UPDATE recovery_test_policies SET policy=? WHERE plan_id='plan-01'")
			.run(
				JSON.stringify({
					enabled: true,
					databaseImport: 'required',
					enabledAt: Date.now(),
					targetModes: { mysql: 'internal' },
				})
			);
		await assert.rejects(
			f.actions.approve(next.id, 'administrator', record.argumentsHash),
			fault('resource_changed_request_again')
		);
		assert.equal(f.calls.length, 1);
	} finally {
		f.close();
	}
});
