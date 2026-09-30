import { AgentClient } from './client.js';
import { AgentOperationError, atAgentStage, formatAgentFailure } from './errors.js';
import { resolveAllowedRoots } from './filesystemPolicy.js';
import { loadIdentity, saveIdentity } from './identity.js';
import { collectInventory } from './inventory.js';
import type { AgentConfig, StoredAgentIdentity } from './types.js';

const SAFE_COMMANDS = new Set(['PING', 'INVENTORY_REFRESH']);

function rememberCompletion(identity: StoredAgentIdentity, completion: StoredAgentIdentity['completedCommands'][number]): void {
	identity.completedCommands = [...identity.completedCommands.filter(item => item.commandId !== completion.commandId), completion].slice(-100);
}

export async function runOnce(config: AgentConfig): Promise<void> {
	const identity = await atAgentStage('load-identity', () => loadIdentity(config.dataDir));
	const roots = await atAgentStage('resolve-allowed-roots', () => resolveAllowedRoots(config.allowedRoots));
	const client = new AgentClient(config, identity);
	const inventory = collectInventory({
		filesystemRootsConfigured: roots.length > 0,
		commandTypes: ['PING', 'INVENTORY_REFRESH'],
	});

	await atAgentStage('heartbeat', () => client.heartbeat(inventory));
	const command = await atAgentStage('poll', () => client.poll());
	if (!command) return;
	if (!SAFE_COMMANDS.has(command.type)) {
		throw new AgentOperationError('validate-command', 'server returned an unsupported command type');
	}

	const prior = identity.completedCommands.find(item => item.commandId === command.id);
	if (prior) {
		await atAgentStage('complete', () => client.complete(command.id, command.leaseToken, prior));
		return;
	}

	await atAgentStage('acknowledge', () => client.acknowledge(command.id, command.leaseToken));
	await atAgentStage('record-event', () => client.event(command.id, command.leaseToken, 1));
	// PING and INVENTORY_REFRESH are deliberate no-ops; neither can execute a shell or access files.
	const completion = { commandId: command.id, sequence: 2, success: true };
	// Persist before acknowledging completion so a retry cannot execute future non-idempotent work twice.
	rememberCompletion(identity, completion);
	await atAgentStage('save-identity', () => saveIdentity(config.dataDir, identity));
	await atAgentStage('complete', () => client.complete(command.id, command.leaseToken, completion));
}

export async function run(config: AgentConfig): Promise<void> {
	const identity = await atAgentStage('load-identity', () => loadIdentity(config.dataDir));
	let stopped = false;
	let running = false;
	const execute = async () => {
		if (stopped || running) return;
		running = true;
		try {
			await runOnce(config);
		} catch (error) {
			console.error(`[pluton-agent] ${formatAgentFailure(error)}`);
		} finally {
			running = false;
		}
	};
	const timer = setInterval(execute, Math.max(5, identity.pollIntervalSeconds) * 1_000);
	const stop = () => {
		stopped = true;
		clearInterval(timer);
	};
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
	await execute();
	await new Promise<void>(resolve => {
		const wait = () => (stopped ? resolve() : setTimeout(wait, 250));
		wait();
	});
}
