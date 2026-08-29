import { sql } from 'drizzle-orm';

/** For integer columns with { mode: 'timestamp' } */
export const eventDate = (occurredAt?: number): any =>
	occurredAt ? new Date(occurredAt * 1000) : (sql`(unixepoch())` as any);

/** For millisecond-epoch values */
export const eventMs = (occurredAt?: number): number =>
	occurredAt ? occurredAt * 1000 : Date.now();

/** For second-epoch values */
export const eventSec = (occurredAt?: number): number =>
	occurredAt ?? Math.floor(Date.now() / 1000);
