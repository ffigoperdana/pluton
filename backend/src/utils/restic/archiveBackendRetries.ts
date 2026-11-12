/**
 * Reduces Restic/Rclone stderr from a native archive read to a closed, bounded summary of
 * backend retries. Restic 0.19.1 reports retries as
 *   `Load(<data/0123456789>, 15360, 2605056) returned error, retrying after 1.5s: <error>`
 * and forwards Rclone `serve restic` errors as `rclone: <date> <time> ERROR : <path>: ...`.
 * Only fixed categories and numbers leave this module: no raw provider text, URLs, hosts,
 * addresses, object paths beyond a 10-hex pack prefix, or credentials.
 */

export type BackendErrorClass =
	| 'http-status'
	| 'partial-read'
	| 'unexpected-eof'
	| 'stream-reset'
	| 'timeout'
	| 'connection-reset'
	| 'dns-not-found'
	| 'tls'
	| 'not-found'
	| 'other';

export type BackendRetryLoad = {
	objectType: 'data' | 'index' | 'snapshot' | 'key' | 'lock' | 'config';
	/** At most 10 hex characters, exactly as Restic prints the handle. */
	packPrefix: string;
	length?: number;
	offset?: number;
	attempts: number;
	lastErrorClass: BackendErrorClass;
	httpStatus?: number;
};

export type ArchiveBackendRetrySummary = {
	/** `returned error, retrying after` lines. */
	retryCount: number;
	/** `failed:` lines: Restic gave up on that request. */
	gaveUpCount: number;
	/** `operation successful after N retries` lines. */
	recoveredCount: number;
	/** Rclone `ERROR :` lines. */
	serverErrorCount: number;
	errorClasses: Partial<Record<BackendErrorClass, number>>;
	/** Distinct retried requests, most recent last, at most MAX_LOADS. */
	loads: BackendRetryLoad[];
	lastRetryAfterMs?: number;
	/** From Rclone `wrote X/Y bytes` on the last server error that reported it. */
	lastServedBytes?: number;
	lastExpectedBytes?: number;
	/** Set when lines were skipped because a bound was reached. */
	truncated?: true;
};

const MAX_LINE = 4096;
const MAX_LINES = 20_000;
const MAX_LOADS = 4;
const MAX_NUMBER = Number.MAX_SAFE_INTEGER;
const OBJECT_TYPES = new Set(['data', 'index', 'snapshot', 'key', 'lock', 'config']);

const bounded = (value: string | undefined) => {
	if (value === undefined || !/^\d{1,16}$/.test(value)) return undefined;
	const number = Number(value);
	return Number.isSafeInteger(number) && number <= MAX_NUMBER ? number : undefined;
};

/** Go duration text (`720.38ms`, `1m2.5s`, `1h0m0s`) to whole milliseconds, capped at one day. */
export function goDurationMs(text: string): number | undefined {
	if (!/^(?:\d+(?:\.\d+)?(?:h|m|s|ms|us|µs|ns))+$/.test(text)) return undefined;
	const factor: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 0.001, µs: 0.001, ns: 0.000001 };
	let total = 0;
	for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/g))
		total += Number(amount) * factor[unit];
	return Number.isFinite(total) ? Math.min(24 * 60 * 60_000, Math.round(total)) : undefined;
}

/** Closed classification of a native error text; the text itself is discarded by callers. */
export function classifyBackendError(text: string): { errorClass: BackendErrorClass; httpStatus?: number } {
	const rest = /unexpected HTTP response \((\d{3})\)/.exec(text);
	const status = rest?.[1] ?? /StatusCode:\s*(\d{3})/.exec(text)?.[1] ?? /\bstatus code:?\s*(\d{3})/i.exec(text)?.[1];
	const httpStatus = status ? Number(status) : undefined;
	// A response whose length differs from the request: Restic's own check, the Go HTTP client
	// (`server replied with more than declared Content-Length`) or Rclone's serving side.
	if (/partial out of bounds read|more than (?:the )?declared Content-Length/i.test(text))
		return { errorClass: 'partial-read', httpStatus };
	if (/x509|certificate|tls:/i.test(text)) return { errorClass: 'tls', httpStatus };
	if (/no such host/i.test(text)) return { errorClass: 'dns-not-found', httpStatus };
	if (/does not exist|NoSuchKey|object not found/i.test(text)) return { errorClass: 'not-found', httpStatus };
	if (/i\/o timeout|deadline exceeded|timed out|Client\.Timeout/i.test(text)) return { errorClass: 'timeout', httpStatus };
	if (/connection reset/i.test(text)) return { errorClass: 'connection-reset', httpStatus };
	if (/stream error|RST_STREAM|INTERNAL_ERROR|http2: response body closed/i.test(text))
		return { errorClass: 'stream-reset', httpStatus };
	if (/unexpected EOF|\bEOF\b/.test(text)) return { errorClass: 'unexpected-eof', httpStatus };
	if (httpStatus !== undefined) return { errorClass: 'http-status', httpStatus };
	return { errorClass: 'other' };
}

const RESTIC_LINE =
	/^([A-Z][A-Za-z]{1,15})\((.{0,200}?)\) (?:returned error, retrying after (\S{1,32}): (.*)|failed: (.*)|operation successful after (\d{1,9}) retries)$/;
const RESTIC_HANDLE = /^<([a-z]{3,8})\/([0-9a-f]{1,10})>(?:, (\d{1,16}), (\d{1,16}))?$/;
// Restic forwards its Rclone child's stderr with an `rclone: ` prefix.
const RCLONE_ERROR = /^(?:rclone: )?\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d(?:\.\d{1,9})? ERROR : (.*)$/;

export class ArchiveBackendRetries {
	private summary: ArchiveBackendRetrySummary = {
		retryCount: 0,
		gaveUpCount: 0,
		recoveredCount: 0,
		serverErrorCount: 0,
		errorClasses: {},
		loads: [],
	};
	private carry = '';
	private lines = 0;
	/** performance.now() of the last retry, give-up or server error line. */
	lastEventAt?: number;

	constructor(private readonly now: () => number = () => performance.now()) {}

	write(chunk: Buffer | string) {
		const text = this.carry + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
		const parts = text.split(/\r?\n/);
		this.carry = parts.pop() ?? '';
		// An unterminated line beyond the bound is dropped rather than buffered without limit.
		if (this.carry.length > MAX_LINE) {
			this.carry = '';
			this.summary.truncated = true;
		}
		for (const line of parts) this.line(line);
	}

	/** Parse a final unterminated line once the stream has ended. */
	end() {
		if (this.carry) this.line(this.carry);
		this.carry = '';
	}

	private count(errorClass: BackendErrorClass) {
		this.summary.errorClasses[errorClass] = Math.min(MAX_NUMBER, (this.summary.errorClasses[errorClass] ?? 0) + 1);
	}

	private line(raw: string) {
		if (this.lines >= MAX_LINES) {
			this.summary.truncated = true;
			return;
		}
		this.lines++;
		const line = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw.trimEnd();
		const restic = RESTIC_LINE.exec(line);
		if (restic) {
			const [, , target, delay, retryError, failedError, recovered] = restic;
			if (recovered !== undefined) {
				this.summary.recoveredCount = Math.min(MAX_NUMBER, this.summary.recoveredCount + 1);
				return;
			}
			const { errorClass, httpStatus } = classifyBackendError(retryError ?? failedError ?? '');
			this.count(errorClass);
			this.lastEventAt = this.now();
			if (retryError !== undefined) {
				this.summary.retryCount = Math.min(MAX_NUMBER, this.summary.retryCount + 1);
				const retryAfterMs = goDurationMs(delay);
				if (retryAfterMs !== undefined) this.summary.lastRetryAfterMs = retryAfterMs;
			} else this.summary.gaveUpCount = Math.min(MAX_NUMBER, this.summary.gaveUpCount + 1);
			const handle = RESTIC_HANDLE.exec(target);
			if (!handle || !OBJECT_TYPES.has(handle[1])) return;
			const load: Omit<BackendRetryLoad, 'attempts' | 'lastErrorClass' | 'httpStatus'> = {
				objectType: handle[1] as BackendRetryLoad['objectType'],
				packPrefix: handle[2],
				length: bounded(handle[3]),
				offset: bounded(handle[4]),
			};
			const index = this.summary.loads.findIndex(
				item =>
					item.objectType === load.objectType &&
					item.packPrefix === load.packPrefix &&
					item.length === load.length &&
					item.offset === load.offset
			);
			const previous = index >= 0 ? this.summary.loads.splice(index, 1)[0] : undefined;
			this.summary.loads.push({
				...load,
				attempts: Math.min(MAX_NUMBER, (previous?.attempts ?? 0) + 1),
				lastErrorClass: errorClass,
				...(httpStatus !== undefined ? { httpStatus } : {}),
			});
			if (this.summary.loads.length > MAX_LOADS) this.summary.loads.shift();
			return;
		}
		const server = RCLONE_ERROR.exec(line);
		if (server) {
			this.summary.serverErrorCount = Math.min(MAX_NUMBER, this.summary.serverErrorCount + 1);
			this.count(classifyBackendError(server[1]).errorClass);
			this.lastEventAt = this.now();
			const wrote = /wrote (\d{1,16})\/(\d{1,16}) bytes/.exec(server[1]);
			const served = bounded(wrote?.[1]);
			const expected = bounded(wrote?.[2]);
			if (served !== undefined && expected !== undefined) {
				this.summary.lastServedBytes = served;
				this.summary.lastExpectedBytes = expected;
			}
		}
		// Every other line (progress, provider text, configuration echoes) is discarded.
	}

	/** True once any retry, give-up or server error line has been seen. */
	get active() {
		return this.summary.retryCount + this.summary.gaveUpCount + this.summary.serverErrorCount > 0;
	}

	/** A copy for diagnostics, or undefined when nothing backend-related was reported. */
	snapshot(): ArchiveBackendRetrySummary | undefined {
		if (!this.active && !this.summary.recoveredCount) return undefined;
		return {
			...this.summary,
			errorClasses: { ...this.summary.errorClasses },
			loads: this.summary.loads.map(load => ({ ...load })),
		};
	}
}
