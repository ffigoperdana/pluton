#!/usr/bin/env node
// Pluton S3 replica readback probe. Read-only by construction: it only runs
// `rclone version`, `rclone lsjson` and `rclone cat`. It never needs the Restic
// password and never prints credentials, endpoints, bucket names or raw provider
// text. Usage and interpretation: docs/REPLICA_READBACK_PROBE.md
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOOL = 'pluton-replica-readback-probe/1';
const ALLOWED_SUBCOMMANDS = new Set(['version', 'lsjson', 'cat']);
const ORDER = ['config', 'keys', 'snapshots', 'index', 'data'];
const MiB = 1024 * 1024;

const USAGE = `Usage (inside the Pluton container):
  node replica-readback-probe.mjs --endpoint https://<s3-endpoint> --path <bucket>/<replica-prefix> [options]

Options:
  --credentials prompt|managed-export|env  Where the S3 key pair comes from (default: prompt, hidden input).
                                           managed-export uses MANAGED_EXPORT_ACCESS_KEY_ID/SECRET from the
                                           container; env uses PROBE_ACCESS_KEY_ID/PROBE_SECRET_ACCESS_KEY.
  --region <name>             S3 region if the storage defines one.
  --ca <file>                 PEM CA bundle (default: PLUTON_STORAGE_CA_FILE when set).
  --only <dir>[,<dir>]        Limit to config,keys,snapshots,index,data (default: all).
  --objects <key>[,<key>]     Only these object keys, relative to --path (e.g. data/ab/ab12...).
  --timeout <seconds>         Rclone I/O idle timeout per request (default: 60).
  --ranges <n>                Range reads per data/index object after a good full read (default: 3).
  --range-bytes <n>           Bytes per range read (default: 262144).
  --limit <n>                 Stop after n objects.
  --report <file>             JSON report path (default: /tmp/pluton-replica-probe-<time>.json).
  --rclone <file>             Rclone binary (default: /usr/local/bin/rclone).
  --show-errors               Also print a redacted error excerpt (review before sharing).
  --allow-loopback-http       Test fixtures only: permit http://127.0.0.1 or http://localhost.`;

function fail(message, code = 1) {
	process.stderr.write(`\n${message}\n`);
	process.exit(code);
}

function parseArgs(argv) {
	const opts = {
		credentials: 'prompt',
		region: '',
		ca: process.env.PLUTON_STORAGE_CA_FILE || '',
		only: [],
		objects: [],
		timeout: 60,
		ranges: 3,
		rangeBytes: 256 * 1024,
		limit: 0,
		report: '',
		rclone: '/usr/local/bin/rclone',
		showErrors: false,
		allowLoopbackHttp: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = () => {
			const next = argv[++i];
			if (next === undefined || next.startsWith('--')) fail(`Missing value for ${flag}\n\n${USAGE}`);
			return next;
		};
		const int = (min, max) => {
			const n = Number(value());
			if (!Number.isInteger(n) || n < min || n > max) fail(`${flag} must be an integer from ${min} to ${max}`);
			return n;
		};
		switch (flag) {
			case '--endpoint': opts.endpoint = value(); break;
			case '--path': opts.path = value(); break;
			case '--credentials': opts.credentials = value(); break;
			case '--region': opts.region = value(); break;
			case '--ca': opts.ca = value(); break;
			case '--only': opts.only = value().split(',').filter(Boolean); break;
			case '--objects': opts.objects = value().split(',').filter(Boolean); break;
			case '--timeout': opts.timeout = int(2, 900); break;
			case '--ranges': opts.ranges = int(0, 16); break;
			case '--range-bytes': opts.rangeBytes = int(1, 16 * MiB); break;
			case '--limit': opts.limit = int(1, 1_000_000); break;
			case '--report': opts.report = value(); break;
			case '--rclone': opts.rclone = value(); break;
			case '--show-errors': opts.showErrors = true; break;
			case '--allow-loopback-http': opts.allowLoopbackHttp = true; break;
			case '-h':
			case '--help': process.stdout.write(USAGE + '\n'); process.exit(0);
			default: fail(`Unknown option ${flag}\n\n${USAGE}`);
		}
	}
	if (opts.credentials === 'managed-export' && !opts.endpoint) opts.endpoint = process.env.MANAGED_EXPORT_ENDPOINT;
	if (opts.credentials === 'managed-export' && !opts.ca && process.env.MANAGED_EXPORT_CA_FILE)
		opts.ca = process.env.MANAGED_EXPORT_CA_FILE;
	if (!opts.endpoint || !opts.path) fail(USAGE);
	let endpoint;
	try {
		endpoint = new URL(opts.endpoint);
	} catch {
		fail('--endpoint is not a valid URL');
	}
	const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
	if (endpoint.protocol !== 'https:' && !(opts.allowLoopbackHttp && loopback && endpoint.protocol === 'http:'))
		fail('--endpoint must use https://');
	opts.path = opts.path.replace(/^\/+|\/+$/g, '');
	if (!opts.path || opts.path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\0-\x1f\x7f]/.test(opts.path))
		fail('--path must look like <bucket>/<prefix> without "..", backslashes or control characters');
	if (!['prompt', 'managed-export', 'env'].includes(opts.credentials)) fail('--credentials must be prompt, managed-export or env');
	for (const dir of opts.only) if (!ORDER.includes(dir)) fail(`--only accepts ${ORDER.join(',')}`);
	for (const key of opts.objects)
		if (key.split('/').some(part => !part || part === '..') || /[\\\0-\x1f\x7f]/.test(key)) fail(`Invalid object key in --objects`);
	if (opts.ca && (!path.isAbsolute(opts.ca) || !fs.existsSync(opts.ca))) fail('--ca must be an existing absolute file');
	if (!path.isAbsolute(opts.rclone) || !fs.existsSync(opts.rclone)) fail('--rclone must be an existing absolute file');
	return opts;
}

function hiddenPrompt(question) {
	if (!process.stdin.isTTY) fail('Hidden input needs a terminal. Run docker exec with -it, or use --credentials env.');
	return new Promise(resolve => {
		process.stdout.write(question);
		const stdin = process.stdin;
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding('utf8');
		let value = '';
		const onData = chunk => {
			for (const ch of chunk) {
				if (ch === '\r' || ch === '\n') {
					stdin.setRawMode(false);
					stdin.pause();
					stdin.off('data', onData);
					process.stdout.write('\n');
					resolve(value.trim());
					return;
				}
				if (ch === '\u0003') {
					stdin.setRawMode(false);
					process.stdout.write('\n');
					process.exit(130);
				}
				if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
				else value += ch;
			}
		};
		stdin.on('data', onData);
	});
}

async function credentials(mode) {
	if (mode === 'managed-export')
		return {
			id: process.env.MANAGED_EXPORT_ACCESS_KEY_ID || '',
			secret: process.env.MANAGED_EXPORT_SECRET_ACCESS_KEY || '',
			token: process.env.MANAGED_EXPORT_SESSION_TOKEN || '',
		};
	if (mode === 'env')
		return {
			id: process.env.PROBE_ACCESS_KEY_ID || '',
			secret: process.env.PROBE_SECRET_ACCESS_KEY || '',
			token: process.env.PROBE_SESSION_TOKEN || '',
		};
	const id = await hiddenPrompt('S3 access key ID (hidden): ');
	const secret = await hiddenPrompt('S3 secret access key (hidden): ');
	return { id, secret, token: '' };
}

const fmtBytes = n =>
	n >= MiB ? `${(n / MiB).toFixed(2)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`;
const fmtMs = ms => (ms === undefined ? '-' : ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const shortKey = key => key.replace(/([0-9a-f]{16})[0-9a-f]{48}$/, '$1…');

function classify(text) {
	const status =
		/StatusCode:\s*(\d{3})/i.exec(text)?.[1] ||
		/status code:?\s*(\d{3})/i.exec(text)?.[1] ||
		/\bHTTP\/[\d.]+\s+(\d{3})/.exec(text)?.[1];
	const category = /x509|certificate/i.test(text)
		? 'tls-certificate'
		: /i\/o timeout|deadline exceeded|Client\.Timeout|timed out/i.test(text)
			? 'timeout'
			: /connection reset/i.test(text)
				? 'connection-reset'
				: /no such host|connection refused|network is unreachable|no route to host/i.test(text)
					? 'network-unavailable'
					: /AccessDenied|SignatureDoesNotMatch|InvalidAccessKeyId|\b403\b/i.test(text)
						? 'access-denied'
						: /NoSuchKey|NoSuchBucket|object not found|directory not found|\b404\b/i.test(text)
							? 'not-found'
							: /unexpected EOF|\bEOF\b/.test(text)
								? 'unexpected-eof'
								: status
									? 'http-error'
									: text.trim()
										? 'other'
										: 'none';
	return { category, ...(status ? { httpStatus: Number(status) } : {}) };
}

function makeRedactor(opts, creds) {
	const host = new URL(opts.endpoint).host;
	const exact = [creds.secret, creds.id, creds.token, opts.endpoint, host, opts.path, opts.path.split('/')[0]].filter(
		value => value && value.length >= 3
	);
	return text => {
		let out = text;
		for (const value of exact) out = out.split(value).join('<redacted>');
		return out
			.replace(/https?:\/\/\S+/g, '<url>')
			.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
			.replace(/\[[0-9a-f:]+\](?::\d+)?/gi, '<ip>')
			.replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\b/gi, '<host>');
	};
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pluton-replica-probe-'));
	fs.chmodSync(work, 0o700);
	const children = new Set();
	const cleanup = () => {
		for (const child of children) child.kill('SIGKILL');
		fs.rmSync(work, { recursive: true, force: true });
	};
	let report;
	const finish = code => {
		if (report) {
			report.finishedAt = new Date().toISOString();
			try {
				fs.writeFileSync(report.file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
				process.stdout.write(`\nReport: ${report.file}\n`);
			} catch (error) {
				process.stderr.write(`Could not write report: ${error.code || 'error'}\n`);
			}
		}
		cleanup();
		process.exit(code);
	};
	process.on('SIGINT', () => {
		process.stdout.write('\nInterrupted. Writing the partial report.\n');
		if (report) report.interrupted = true;
		finish(130);
	});
	process.on('SIGTERM', () => finish(143));

	return run(opts, work, children, value => (report = value), finish).catch(error => {
		process.stderr.write(`\nProbe failed: ${error.message}\n`);
		finish(1);
	});
}

async function run(opts, work, children, setReport, finish) {
	const creds = await credentials(opts.credentials);
	if (!creds.id || !creds.secret) fail('S3 access key ID and secret are required.');
	const redact = makeRedactor(opts, creds);
	const env = {
		PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
		HOME: work,
		RCLONE_CONFIG: process.platform === 'win32' ? 'NUL' : '/dev/null',
		RCLONE_CACHE_DIR: path.join(work, 'cache'),
		// Same process limits Pluton uses for its replica sessions.
		GOMAXPROCS: '2',
		GOMEMLIMIT: '256MiB',
		RCLONE_TRANSFERS: '2',
		RCLONE_BUFFER_SIZE: '4M',
		RCLONE_MULTI_THREAD_STREAMS: '0',
		RCLONE_CONFIG_PROBE_TYPE: 's3',
		RCLONE_CONFIG_PROBE_PROVIDER: 'Other',
		RCLONE_CONFIG_PROBE_ENDPOINT: opts.endpoint,
		RCLONE_CONFIG_PROBE_ACCESS_KEY_ID: creds.id,
		RCLONE_CONFIG_PROBE_SECRET_ACCESS_KEY: creds.secret,
		RCLONE_CONFIG_PROBE_FORCE_PATH_STYLE: 'true',
		RCLONE_CONFIG_PROBE_NO_CHECK_BUCKET: 'true',
		...(creds.token ? { RCLONE_CONFIG_PROBE_SESSION_TOKEN: creds.token } : {}),
		...(opts.region ? { RCLONE_CONFIG_PROBE_REGION: opts.region } : {}),
		...(opts.ca ? { SSL_CERT_FILE: opts.ca, RCLONE_CA_CERT: opts.ca } : {}),
	};
	const network = ['--timeout', `${opts.timeout}s`, '--contimeout', '15s', '--low-level-retries', '1', '--retries', '1'];
	const wallMs = (opts.timeout * 3 + 30) * 1000;
	const root = `probe:${opts.path}`;

	function rclone(args, { onData, wall = wallMs, stderrLimit = 256 * 1024, label } = {}) {
		if (!ALLOWED_SUBCOMMANDS.has(args[0])) throw new Error('refusing a non-read-only rclone command');
		return new Promise(resolve => {
			const started = performance.now();
			const child = spawn(opts.rclone, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
			children.add(child);
			let stderr = '';
			let bytes = 0;
			let firstByteMs;
			let lastByteMs;
			let wallKilled = false;
			const heartbeat = label
				? setInterval(() => {
						const now = performance.now() - started;
						const idle = lastByteMs === undefined ? now : now - lastByteMs;
						process.stdout.write(
							`      ... ${label}: ${fmtBytes(bytes)} after ${fmtMs(now)}, no data for ${fmtMs(idle)}\n`
						);
					}, 15_000)
				: undefined;
			const timer = setTimeout(() => {
				wallKilled = true;
				child.kill('SIGTERM');
				setTimeout(() => child.kill('SIGKILL'), 5000).unref();
			}, wall);
			child.stdout.on('data', chunk => {
				const at = performance.now() - started;
				if (firstByteMs === undefined) firstByteMs = at;
				lastByteMs = at;
				bytes += chunk.length;
				onData?.(chunk);
			});
			child.stderr.on('data', chunk => {
				if (stderr.length < stderrLimit) stderr += chunk.toString('utf8');
			});
			child.on('close', (code, signal) => {
				clearTimeout(timer);
				if (heartbeat) clearInterval(heartbeat);
				children.delete(child);
				resolve({ code, signal, wallKilled, stderr, bytes, firstByteMs, lastByteMs, elapsedMs: performance.now() - started });
			});
			child.on('error', error => {
				clearTimeout(timer);
				if (heartbeat) clearInterval(heartbeat);
				children.delete(child);
				resolve({ code: -1, signal: null, wallKilled, stderr: String(error.code || error.message), bytes, elapsedMs: 0 });
			});
		});
	}

	const errorOf = result => ({
		...classify(result.stderr),
		...(result.wallKilled ? { stoppedByProbeWallClock: true } : {}),
		...(opts.showErrors && result.stderr.trim() ? { excerpt: redact(result.stderr.trim()).slice(-400) } : {}),
	});

	// Re-read once with header dumps and keep only safe facts: method, status,
	// Content-Length/Content-Range and timing. Raw dump text never leaves memory.
	async function headerTrace(key) {
		const result = await rclone(
			['cat', ...network, '-vv', '--dump', 'headers', '--log-format', 'date,time,microseconds', `${root}/${key}`],
			{ stderrLimit: 4 * MiB, label: 'header trace' }
		);
		const requests = new Map();
		let current;
		let first;
		for (const line of result.stderr.split('\n')) {
			const stamp = /^(\d{4})\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{6})/.exec(line);
			const at = stamp
				? Date.UTC(+stamp[1], +stamp[2] - 1, +stamp[3], +stamp[4], +stamp[5], +stamp[6]) + +stamp[7] / 1000
				: undefined;
			if (at !== undefined && first === undefined) first = at;
			const marker = /HTTP (REQUEST|RESPONSE) \(req (0x[0-9a-f]+)\)/.exec(line);
			if (marker) {
				const entry = requests.get(marker[2]) || { id: requests.size + 1 };
				requests.set(marker[2], entry);
				current = { entry, kind: marker[1] };
				if (marker[1] === 'RESPONSE' && at !== undefined) entry.responseAtMs = Math.round(at - first);
				if (marker[1] === 'REQUEST' && at !== undefined) entry.sentAtMs = Math.round(at - first);
				continue;
			}
			if (!current) continue;
			const body = line.replace(/^\S+ \S+ DEBUG : /, '');
			if (current.kind === 'REQUEST' && !current.entry.method) {
				const request = /^(GET|HEAD|PUT|POST|DELETE) /.exec(body);
				if (request) current.entry.method = request[1];
			}
			if (/^Range:/i.test(body)) current.entry.range = body.split(':')[1].trim();
			if (current.kind === 'RESPONSE') {
				const status = /^HTTP\/[\d.]+ (\d{3})/.exec(body);
				if (status) current.entry.status = Number(status[1]);
				const length = /^Content-Length:\s*(\d+)/i.exec(body);
				if (length) current.entry.contentLength = Number(length[1]);
				const contentRange = /^Content-Range:\s*(bytes [\d*\-/]+)/i.exec(body);
				if (contentRange) current.entry.contentRange = contentRange[1];
			}
		}
		return {
			result: result.code === 0 && !result.wallKilled ? 'completed' : 'failed',
			bytes: result.bytes,
			elapsedMs: Math.round(result.elapsedMs),
			error: result.code === 0 ? undefined : errorOf(result),
			requests: [...requests.values()].map(entry => ({
				method: entry.method,
				range: entry.range,
				sentAtMs: entry.sentAtMs,
				responseAtMs: entry.responseAtMs,
				status: entry.status ?? 'no-response-headers',
				contentLength: entry.contentLength,
				contentRange: entry.contentRange,
			})),
		};
	}

	let versionText = '';
	await rclone(['version'], { wall: 30_000, onData: chunk => (versionText += chunk) });
	const versionLine = /rclone v[\w.\-]+/.exec(versionText)?.[0] || 'unknown';
	const startedAt = new Date().toISOString();
	const report = {
		tool: TOOL,
		startedAt,
		rclone: versionLine,
		node: process.version,
		settings: {
			credentials: opts.credentials,
			customCa: Boolean(opts.ca),
			ioTimeoutSeconds: opts.timeout,
			lowLevelRetries: 1,
			rangesPerObject: opts.ranges,
			rangeBytes: opts.rangeBytes,
		},
		file: opts.report || path.join(os.tmpdir(), `pluton-replica-probe-${startedAt.replace(/[:.]/g, '-')}.json`),
		objects: [],
	};
	setReport(report);

	process.stdout.write(
		`${TOOL}\nRead-only: rclone lsjson and cat only. ${versionLine}, I/O timeout ${opts.timeout}s, ` +
			`1 low-level retry, custom CA: ${opts.ca ? 'yes' : 'no'}.\n\nListing replica objects...\n`
	);
	let listingText = '';
	const listing = await rclone(
		['lsjson', '-R', '--files-only', '--no-mimetype', '--no-modtime', ...network, root],
		{ onData: chunk => (listingText += chunk), wall: Math.max(wallMs, 600_000), label: 'listing' }
	);
	if (listing.code !== 0 || listing.wallKilled) {
		report.listing = { result: 'failed', elapsedMs: Math.round(listing.elapsedMs), error: errorOf(listing) };
		process.stdout.write(`Listing FAILED: ${JSON.stringify(report.listing.error)}\n`);
		finish(2);
		return;
	}
	let entries;
	try {
		entries = JSON.parse(listingText).map(item => ({ key: item.Path, size: item.Size }));
	} catch {
		report.listing = { result: 'invalid-output' };
		finish(2);
		return;
	}
	const top = key => key.split('/')[0];
	const counts = {};
	for (const entry of entries) {
		const group = ORDER.includes(top(entry.key)) ? top(entry.key) : 'other';
		counts[group] = counts[group] || { objects: 0, bytes: 0 };
		counts[group].objects++;
		counts[group].bytes += entry.size;
	}
	report.listing = { result: 'ok', elapsedMs: Math.round(listing.elapsedMs), counts };
	process.stdout.write(
		`Listed ${entries.length} objects in ${fmtMs(listing.elapsedMs)}: ` +
			Object.entries(counts)
				.map(([group, value]) => `${group} ${value.objects} (${fmtBytes(value.bytes)})`)
				.join(', ') +
			'\n'
	);
	if (!entries.some(entry => entry.key === 'config'))
		process.stdout.write('WARNING: no "config" object here. Check that --path points at the replica repository root.\n');

	let selected = entries.filter(entry => ORDER.includes(top(entry.key)) || entry.key === 'config');
	if (opts.only.length) selected = selected.filter(entry => opts.only.includes(top(entry.key)));
	if (opts.objects.length) {
		const wanted = new Set(opts.objects);
		selected = selected.filter(entry => wanted.has(entry.key));
		for (const key of wanted)
			if (!selected.some(entry => entry.key === key)) process.stdout.write(`WARNING: ${key} is not in the listing.\n`);
	}
	selected.sort((a, b) => ORDER.indexOf(top(a.key)) - ORDER.indexOf(top(b.key)) || a.key.localeCompare(b.key));
	if (opts.limit) selected = selected.slice(0, opts.limit);
	process.stdout.write(`Reading ${selected.length} objects one at a time...\n\n`);

	let index = 0;
	for (const entry of selected) {
		index++;
		const hash = crypto.createHash('sha256');
		const keep = ['data', 'index'].includes(top(entry.key)) && opts.ranges > 0 && entry.size <= 64 * MiB;
		const chunks = [];
		const label = `[${index}/${selected.length}] ${shortKey(entry.key)}`;
		const full = await rclone(['cat', ...network, `${root}/${entry.key}`], {
			label,
			onData: chunk => {
				hash.update(chunk);
				if (keep) chunks.push(chunk);
			},
		});
		const digest = hash.digest('hex');
		const named = /^[0-9a-f]{64}$/.test(path.posix.basename(entry.key));
		const record = {
			key: entry.key,
			size: entry.size,
			bytesRead: full.bytes,
			firstByteMs: full.firstByteMs === undefined ? undefined : Math.round(full.firstByteMs),
			elapsedMs: Math.round(full.elapsedMs),
		};
		if (full.code !== 0 || full.wallKilled) {
			record.result = full.bytes > 0 && full.bytes < entry.size ? 'STALLED-OR-CUT' : 'READ-FAILED';
			record.error = errorOf(full);
		} else if (full.bytes !== entry.size) record.result = 'SIZE-MISMATCH';
		else if (named && digest !== path.posix.basename(entry.key)) record.result = 'HASH-MISMATCH';
		else record.result = 'OK';
		if (named && full.code === 0 && !full.wallKilled && full.bytes === entry.size)
			record.sha256MatchesName = digest === path.posix.basename(entry.key);

		if (record.result === 'OK' && keep) {
			const buffer = Buffer.concat(chunks);
			const length = Math.min(opts.rangeBytes, entry.size);
			const positions = [...new Set(
				Array.from({ length: opts.ranges }, (_, i) =>
					opts.ranges === 1 ? 0 : Math.floor(((entry.size - length) * i) / (opts.ranges - 1))
				)
			)];
			record.ranges = [];
			for (const offset of positions) {
				const parts = [];
				const ranged = await rclone(
					['cat', ...network, '--offset', String(offset), '--count', String(length), `${root}/${entry.key}`],
					{ label: `${label} range @${offset}`, onData: chunk => parts.push(chunk) }
				);
				const ok =
					ranged.code === 0 && !ranged.wallKilled && Buffer.concat(parts).equals(buffer.subarray(offset, offset + length));
				record.ranges.push({
					offset,
					length,
					result: ok ? 'OK' : ranged.code === 0 && !ranged.wallKilled ? 'CONTENT-MISMATCH' : 'READ-FAILED',
					bytesRead: ranged.bytes,
					elapsedMs: Math.round(ranged.elapsedMs),
					...(ok || (ranged.code === 0 && !ranged.wallKilled) ? {} : { error: errorOf(ranged) }),
				});
			}
			if (record.ranges.some(range => range.result !== 'OK')) record.result = 'RANGE-FAILED';
		}
		if (record.result !== 'OK') {
			process.stdout.write(`      tracing headers for ${shortKey(entry.key)} once...\n`);
			record.headerTrace = await headerTrace(entry.key);
		}
		report.objects.push(record);

		const rate = full.elapsedMs > 0 ? fmtBytes((full.bytes / full.elapsedMs) * 1000) + '/s' : '-';
		process.stdout.write(
			`${label} ${fmtBytes(entry.size)}  first byte ${fmtMs(record.firstByteMs)}  total ${fmtMs(record.elapsedMs)}  ${rate}  ` +
				`${record.result}` +
				(record.error ? ` ${JSON.stringify(record.error)}` : '') +
				(record.ranges ? `  ranges ${record.ranges.filter(r => r.result === 'OK').length}/${record.ranges.length}` : '') +
				'\n'
		);
		if (record.result !== 'OK') {
			process.stdout.write(`      bytes read ${fmtBytes(full.bytes)} of ${fmtBytes(entry.size)}\n`);
			for (const request of record.headerTrace.requests)
				process.stdout.write(`      trace: ${JSON.stringify(request)}\n`);
			process.stdout.write(`      trace result: ${record.headerTrace.result}, ${fmtBytes(record.headerTrace.bytes)} in ${fmtMs(record.headerTrace.elapsedMs)}\n`);
		}
	}

	const bad = report.objects.filter(object => object.result !== 'OK');
	const slowest = [...report.objects].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 5);
	report.summary = {
		objectsRead: report.objects.length,
		ok: report.objects.length - bad.length,
		anomalies: bad.map(object => ({ key: object.key, result: object.result, error: object.error })),
		slowest: slowest.map(object => ({ key: object.key, size: object.size, elapsedMs: object.elapsedMs, firstByteMs: object.firstByteMs })),
	};
	process.stdout.write(
		`\nSummary: ${report.summary.ok}/${report.summary.objectsRead} objects OK, ${bad.length} anomalies.\n` +
			(bad.length ? bad.map(object => `  ${object.result}: ${object.key}`).join('\n') + '\n' : '') +
			`Slowest: ${slowest.map(object => `${shortKey(object.key)} ${fmtMs(object.elapsedMs)}`).join(', ')}\n`
	);
	finish(bad.length ? 2 : 0);
}

main();
