import { randomBytes } from 'node:crypto';
import { NotificationDeliveryStore } from '../stores/NotificationDeliveryStore';
import { deliverNotification } from './outboundDelivery';
import { serverLogger } from '../utils/logger';
import type { Delivery } from '../types/notificationDelivery';

/** Agent liveness for operational notifications (docs/OPERATIONAL_NOTIFICATIONS.md). */
export type AgentWatch = {
	/** The UI offline threshold (AGENT_OFFLINE_TIMEOUT_SECONDS). */
	offline: number;
	/** How long an Agent stays offline before `agent.offline` is sent. */
	grace: number;
};
export const AGENT_OFFLINE_GRACE_MS = 10 * 60_000;
export class NotificationDeliveryManager {
	private timer?: ReturnType<typeof setInterval>;
	private active = new Set<Promise<void>>();
	private stopped = true;
	private watchingSince = Date.now();
	constructor(
		private store: NotificationDeliveryStore,
		private deliver = deliverNotification,
		private agents: AgentWatch = { offline: 90_000, grace: AGENT_OFFLINE_GRACE_MS }
	) {}
	start() {
		if (!this.stopped) return;
		this.stopped = false;
		// Heartbeats missed while this server was down are not an Agent outage.
		this.watchingSince = Date.now();
		this.timer = setInterval(() => this.tick(), 5000);
		this.timer.unref();
		this.tick();
	}
	/** DB projection/claims only; transport promises never block a backup callback. */
	tick() {
		if (this.stopped) return;
		try {
			this.store.reconcile();
			try {
				this.store.reconcileAgents({
					timeoutMs: this.agents.offline,
					graceMs: this.agents.grace,
					watchingSince: this.watchingSince,
				});
			} catch {
				// Agent watching never blocks backup and recovery deliveries.
				serverLogger?.warn(
					{ event: 'notification_agent_watch_failed' },
					'Agent availability could not be evaluated for notifications.'
				);
			}
			this.store.maintenance();
			while (this.active.size < 2) {
				const row = this.store.claim(randomBytes(16).toString('hex'));
				if (!row) break;
				const promise = this.send(row).finally(() => this.active.delete(promise));
				this.active.add(promise);
			}
		} catch {
			serverLogger?.warn(
				{ event: 'notification_worker_failed' },
				'Notification worker state could not be processed; backup and recovery state are unchanged.'
			);
		}
	}
	private async send(row: Delivery) {
		try {
			const channel = this.store.channel(row.channelId);
			if (!channel || !channel.enabled || channel.deleted)
				return this.store.finish(row, { success: false, code: 'channel-disabled' });
			if (channel.revision !== row.revision)
				return this.store.finish(row, { success: false, code: 'channel-changed' });
			const policyError = this.store.deliveryPolicyError(row);
			if (policyError) return this.store.finish(row, { success: false, code: policyError });
			let secret: string | undefined;
			try {
				secret = this.store.channelSecret(row.channelId);
			} catch {
				return this.store.finish(row, { success: false, code: 'credential-invalid' });
			}
			const result = await this.deliver(channel, this.store.payload(row.eventId), secret, {
				canSend: () => {
					const live = this.store.channel(row.channelId);
					return (
						!!live?.enabled &&
						!live.deleted &&
						live.revision === row.revision &&
						!this.store.deliveryPolicyError(row)
					);
				},
			});
			this.store.finish(row, result);
		} catch {
			// No raw exceptions, provider diagnostics, credentials or payload in logs.
			try {
				this.store.finish(row, { success: false, code: 'delivery-failed' });
			} catch {
				/* Lease recovery handles a failed DB write. */
			}
			serverLogger?.warn(
				{ event: 'notification_delivery_failed' },
				'Notification delivery failed; inspect its sanitized history.'
			);
		}
	}
	async shutdown() {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		await Promise.allSettled([...this.active]);
	}
}
