#!/usr/bin/env node
// Pluton serve-restic range sweep. Reproduces the exact path Restic uses to read a
// replica pack (Restic -> `rclone serve restic` -> S3) without the Restic password:
// it starts a private `rclone serve restic` on loopback with a random password and
// sends only GET/HEAD requests through it. Compares the object size from listing
// (LIST) and from HEAD, then sweeps Range reads across the pack and checks every
// response against the full object. See docs/REPLICA_READBACK_PROBE.md.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const TOOL = 'pluton-serve-restic-range-sweep/1';
const MiB = 1024 * 1024;
const USAGE = `Usage (inside the Pluton container, or a temporary container with --network host):
  node serve-restic-range-sweep.mjs --endpoint https://<s3-endpoint> --path <bucket>/<replica-prefix> [options]

  --credentials prompt|managed-export|env   As in replica-readback-probe.mjs (default: prompt).
  --object <data/xx/id>   Pack to test (default: the largest data/ object).
  --step <bytes>          Distance between sweep offsets (default: 16384).
  --length <bytes>        Bytes per sweep request (default: 24576).
  --range <offset>:<len>  Only test this one range (with --repeat) instead of the sweep.
  --repeat <n>            Repetitions for --range (default: 3).
  --accept-gzip on|off    Force rclone's Accept-Encoding: gzip on or off (default: rclone default).
  --region <name>  --ca <file>  --timeout <seconds>  --report <file>  --rclone <file>
  --allow-loopback-http   Test fixtures only.

Every failed range is read once more directly with header dumps; only the status,
Content-Length, Content-Range, Content-Encoding, Content-Type and a byte classification
are printed.`;

function fail(message) {
	process.stderr.write(`\n${message}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const opts = {
		credentials: 'prompt', region: '', ca: process.env.PLUTON_STORAGE_CA_FILE || '', object: '',
		step: 16384, length: 24576, timeout: 60, report: '', rclone: '/usr/local/bin/rclone', allowLoopbackHttp: false,
		range: undefined, repeat: 3, acceptGzip: '',
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
		if (flag === '--endpoint') opts.endpoint = value();
		else if (flag === '--path') opts.path = value();
		else if (flag === '--credentials') opts.credentials = value();
		else if (flag === '--region') opts.region = value();
		else if (flag === '--ca') opts.ca = value();
		else if (flag === '--object') opts.object = value();
		else if (flag === '--step') opts.step = int(512, 16 * MiB);
		else if (flag === '--length') opts.length = int(1, 16 * MiB);
		else if (flag === '--timeout') opts.timeout = int(2, 900);
		else if (flag === '--report') opts.report = value();
		else if (flag === '--rclone') opts.rclone = value();
		else if (flag === '--allow-loopback-http') opts.allowLoopbackHttp = true;
		else if (flag === '--repeat') opts.repeat = int(1, 20);
		else if (flag === '--accept-gzip') {
			opts.acceptGzip = value();
			if (!['on', 'off'].includes(opts.acceptGzip)) fail('--accept-gzip must be on or off');
		} else if (flag === '--range') {
			const match = /^(\d+):(\d+)$/.exec(value());
			if (!match || Number(match[2]) < 1) fail('--range must look like <offset>:<length>');
			opts.range = [Number(match[1]), Number(match[2])];
		} else if (flag === '-h' || flag === '--help') {
			process.stdout.write(USAGE + '\n');
			process.exit(0);
		} else fail(`Unknown option ${flag}\n\n${USAGE}`);
	}
	if (opts.credentials === 'managed-export' && !opts.endpoint) opts.endpoint = process.env.MANAGED_EXPORT_ENDPOINT;
	if (opts.credentials === 'managed-export' && !opts.ca && process.env.MANAGED_EXPORT_CA_FILE) opts.ca = process.env.MANAGED_EXPORT_CA_FILE;
	if (!opts.endpoint || !opts.path) fail(USAGE);
	let endpoint;
	try {
		endpoint = new URL(opts.endpoint);
	} catch {
		fail('--endpoint is not a valid URL');
	}
	const loopback = ['127.0.0.1', 'localhost'].includes(endpoint.hostname);
	if (endpoint.protocol !== 'https:' && !(opts.allowLoopbackHttp && loopback && endpoint.protocol === 'http:'))
		fail('--endpoint must use https://');
	opts.path = opts.path.replace(/^\/+|\/+$/g, '');
	if (!opts.path || opts.path.split('/').some(p => !p || p === '.' || p === '..') || /[\\\0-\x1f\x7f]/.test(opts.path))
		fail('--path must look like <bucket>/<prefix>');
	if (opts.object && !/^data\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(opts.object)) fail('--object must look like data/xx/<64 hex>');
	if (!['prompt', 'managed-export', 'env'].includes(opts.credentials)) fail('--credentials must be prompt, managed-export or env');
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
		return { id: process.env.MANAGED_EXPORT_ACCESS_KEY_ID || '', secret: process.env.MANAGED_EXPORT_SECRET_ACCESS_KEY || '', token: process.env.MANAGED_EXPORT_SESSION_TOKEN || '' };
	if (mode === 'env')
		return { id: process.env.PROBE_ACCESS_KEY_ID || '', secret: process.env.PROBE_SECRET_ACCESS_KEY || '', token: process.env.PROBE_SESSION_TOKEN || '' };
	return { id: await hiddenPrompt('S3 access key ID (hidden): '), secret: await hiddenPrompt('S3 secret access key (hidden): '), token: '' };
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

function request(port, auth, method, key, range, timeoutMs, agent) {
	return new Promise(resolve => {
		const started = performance.now();
		const req = http.request(
			{
				host: '127.0.0.1',
				port,
				method,
				path: '/' + key.replace(/^data\/[0-9a-f]{2}\//, 'data/'),
				agent,
				headers: { Authorization: auth, Accept: 'application/vnd.x.restic.rest.v2', ...(range ? { Range: range } : {}) },
				timeout: timeoutMs,
			},
			res => {
				const chunks = [];
				const headers = {
					status: res.statusCode,
					contentLength: res.headers['content-length'] === undefined ? undefined : Number(res.headers['content-length']),
					contentRange: res.headers['content-range'],
					contentEncoding: res.headers['content-encoding'],
				};
				let settled = false;
				const settle = extra => {
					if (settled) return;
					settled = true;
					resolve({ ...headers, body: Buffer.concat(chunks), ms: Math.round(performance.now() - started), ...extra });
				};
				res.on('data', chunk => chunks.push(chunk));
				res.on('end', () => settle(res.complete ? {} : { error: 'incomplete' }));
				res.on('aborted', () => settle({ error: 'aborted' }));
				res.on('error', error => settle({ error: error.code || 'response-error' }));
				res.on('close', () => settle(res.complete ? {} : { error: 'closed-early' }));
			}
		);
		req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
		req.on('error', error => resolve({ error: error.code || 'request-error', body: Buffer.alloc(0), ms: Math.round(performance.now() - started) }));
		req.end();
	});
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const creds = await credentials(opts.credentials);
	if (!creds.id || !creds.secret) fail('S3 access key ID and secret are required.');
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pluton-range-sweep-'));
	fs.chmodSync(work, 0o700);
	const env = {
		PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
		HOME: work,
		RCLONE_CONFIG: '/dev/null',
		RCLONE_CACHE_DIR: path.join(work, 'cache'),
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
		...(opts.acceptGzip ? { RCLONE_CONFIG_PROBE_USE_ACCEPT_ENCODING_GZIP: opts.acceptGzip === 'on' ? 'true' : 'false' } : {}),
	};
	const redact = (() => {
		const host = new URL(opts.endpoint).host;
		const exact = [creds.secret, creds.id, creds.token, opts.endpoint, host, opts.path, opts.path.split('/')[0]].filter(v => v && v.length >= 3);
		return text => {
			let out = text;
			for (const value of exact) out = out.split(value).join('<redacted>');
			return out
				.replace(/https?:\/\/\S+/g, '<url>')
				.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
				.replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\b/gi, '<host>');
		};
	})();
	const network = ['--timeout', `${opts.timeout}s`, '--contimeout', '15s', '--low-level-retries', '1', '--retries', '1'];
	const root = `probe:${opts.path}`;
	let server;
	const cleanup = () => {
		if (server) server.kill('SIGKILL');
		fs.rmSync(work, { recursive: true, force: true });
	};
	process.on('SIGINT', () => {
		cleanup();
		process.exit(130);
	});
	const run = (args, keepStderr = false) =>
		new Promise(resolve => {
			if (!['lsjson', 'cat'].includes(args[0])) throw new Error('refusing a non-read-only rclone command');
			const child = spawn(opts.rclone, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
			const chunks = [];
			let stderr = '';
			child.stdout.on('data', c => chunks.push(c));
			child.stderr.on('data', c => {
				if (keepStderr && stderr.length < 4 * MiB) stderr += c.toString('utf8');
			});
			child.on('close', code => {
				const buffer = Buffer.concat(chunks);
				resolve({ code, out: buffer.toString('utf8'), buffer, stderr });
			});
		});
	// Classify bytes without printing them: gzip magic, text-likeness and where (if
	// anywhere) they occur in the stored object.
	const classifyBytes = (body, reference) => {
		const printable = body.length ? [...body.subarray(0, 4096)].filter(b => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)).length / Math.min(body.length, 4096) : 0;
		const probe = body.subarray(0, Math.min(64, body.length));
		return {
			bytes: body.length,
			gzipMagic: body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b,
			textLike: printable > 0.95,
			foundInStoredObjectAt: probe.length >= 16 ? reference.indexOf(probe) : undefined,
			...(printable > 0.95 ? { textPreview: redact(body.subarray(0, 240).toString('utf8')).replace(/\s+/g, ' ') } : {}),
		};
	};
	// Direct read of one range with header dumps; keeps only safe response facts.
	const traceRange = async (key, offset, length, reference) => {
		const result = await run(['cat', ...network, '--offset', String(offset), '--count', String(length), '-vv', '--dump', 'headers', `${root}/${key}`], true);
		const responses = [];
		let current;
		let kind;
		for (const line of result.stderr.split('\n')) {
			const marker = /HTTP (REQUEST|RESPONSE) \(req 0x[0-9a-f]+\)/.exec(line);
			if (marker) {
				kind = marker[1];
				if (kind === 'RESPONSE') responses.push((current = {}));
				else current = undefined;
				continue;
			}
			// Dumped header lines end in CR; strip it so the field patterns can anchor at the end.
			const body = line.replace(/\r$/, '').replace(/^\S+ \S+ DEBUG : /, '');
			if (kind === 'REQUEST' && /^Accept-Encoding:/i.test(body)) responses.acceptEncoding = body.split(':')[1].trim();
			if (kind !== 'RESPONSE' || !current) continue;
			const status = /^HTTP\/[\d.]+ (\d{3})/.exec(body);
			if (status) current.status = Number(status[1]);
			for (const [name, field] of [['Content-Length', 'contentLength'], ['Content-Range', 'contentRange'], ['Content-Encoding', 'contentEncoding'], ['Content-Type', 'contentType'], ['Transfer-Encoding', 'transferEncoding']]) {
				const match = new RegExp(`^${name}:\\s*(.+)$`, 'i').exec(body);
				if (match) current[field] = match[1].trim();
			}
		}
		return {
			exit: result.code,
			requestAcceptEncoding: responses.acceptEncoding,
			responses,
			received: classifyBytes(result.buffer, reference),
			matchesStored: result.buffer.equals(reference.subarray(offset, offset + length)),
		};
	};
	const report = {
		tool: TOOL,
		startedAt: new Date().toISOString(),
		settings: { step: opts.step, length: opts.length, ioTimeoutSeconds: opts.timeout, range: opts.range, repeat: opts.repeat, acceptGzip: opts.acceptGzip || 'rclone-default' },
	};
	const finish = code => {
		report.finishedAt = new Date().toISOString();
		const file = opts.report || path.join(os.tmpdir(), `pluton-range-sweep-${report.startedAt.replace(/[:.]/g, '-')}.json`);
		try {
			fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
			process.stdout.write(`Report: ${file}\n`);
		} catch {
			process.stderr.write('Could not write the report.\n');
		}
		cleanup();
		process.exit(code);
	};

	process.stdout.write(`${TOOL}\nRead-only: rclone lsjson, plus GET/HEAD through a private loopback rclone serve restic.\n\n`);
	const listing = await run(['lsjson', '-R', '--files-only', '--no-mimetype', '--no-modtime', ...network, `${root}/data`]);
	if (listing.code !== 0) {
		process.stdout.write(`Listing failed (rclone exit ${listing.code}).\n`);
		finish(2);
		return;
	}
	const packs = JSON.parse(listing.out).map(item => ({ key: 'data/' + item.Path, size: item.Size }));
	const target = opts.object ? packs.find(p => p.key === opts.object) : [...packs].sort((a, b) => b.size - a.size)[0];
	if (!target) {
		process.stdout.write('The requested data object is not in the listing.\n');
		finish(2);
		return;
	}
	const id = path.posix.basename(target.key);
	const stat = await run(['lsjson', '--stat', '--no-mimetype', '--no-modtime', ...network, `${root}/${target.key}`]);
	const headSize = stat.code === 0 ? JSON.parse(stat.out).Size : undefined;
	report.object = { key: target.key, listSize: target.size, headSize };
	process.stdout.write(
		`Pack ${id.slice(0, 16)}…  size from LIST ${target.size}  size from HEAD ${headSize ?? 'unavailable'}` +
			(headSize !== undefined && headSize !== target.size ? '  <-- DIFFERENT' : '') +
			'\n'
	);

	const port = await freePort();
	const user = 'probe-' + crypto.randomBytes(6).toString('hex');
	const pass = crypto.randomBytes(24).toString('base64url');
	server = spawn(opts.rclone, ['serve', 'restic', '--addr', `127.0.0.1:${port}`, '--user', user, '--pass', pass, ...network, root], {
		env,
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	server.stderr.on('data', () => undefined);
	const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
	const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
	let ready = false;
	for (let i = 0; i < 60 && !ready; i++) {
		await new Promise(r => setTimeout(r, 250));
		ready = await new Promise(resolve => {
			const socket = net.connect(port, '127.0.0.1', () => {
				socket.destroy();
				resolve(true);
			});
			socket.on('error', () => resolve(false));
		});
	}
	if (!ready) {
		process.stdout.write('rclone serve restic did not start.\n');
		finish(2);
		return;
	}
	// Reference bytes come from a direct read checked against the content hash, so a
	// faulty serve path cannot also corrupt the expected values.
	const direct = await run(['cat', ...network, `${root}/${target.key}`]);
	const reference = direct.buffer;
	if (direct.code !== 0 || reference.length !== target.size || crypto.createHash('sha256').update(reference).digest('hex') !== id) {
		process.stdout.write('The direct reference read failed or does not match the content hash; run replica-readback-probe.mjs first.\n');
		finish(2);
		return;
	}
	const timeoutMs = (opts.timeout * 2 + 15) * 1000;
	const full = await request(port, auth, 'GET', target.key, undefined, timeoutMs, agent);
	const fullOk = full.status === 200 && full.body.equals(reference);
	const head = await request(port, auth, 'HEAD', target.key, undefined, timeoutMs, agent);
	report.serve = {
		fullGet: { status: full.status, contentLength: full.contentLength, bytes: full.body.length, ok: fullOk, ms: full.ms, error: full.error },
		headContentLength: head.contentLength,
	};
	process.stdout.write(
		`Through serve restic: full GET ${full.status ?? full.error}, ${full.body.length} bytes, ${fullOk ? 'OK' : 'NOT OK'}; HEAD Content-Length ${head.contentLength}\n`
	);

	const ranges = [];
	if (opts.range) {
		if (opts.range[0] + opts.range[1] > target.size) {
			process.stdout.write('--range lies beyond the end of the pack.\n');
			finish(2);
			return;
		}
		for (let i = 0; i < opts.repeat; i++) ranges.push(opts.range);
		process.stdout.write(`Repeating bytes=${opts.range[0]}-${opts.range[0] + opts.range[1] - 1} ${opts.repeat} times (Accept-Encoding gzip: ${opts.acceptGzip || 'rclone default'})...\n`);
	} else {
		for (let offset = 0; offset < target.size; offset += opts.step) ranges.push([offset, Math.min(opts.length, target.size - offset)]);
		for (const tail of [1, 16, 512, 4096, 8192, 15360, 16384, 24576, 32768, 65536])
			if (tail <= target.size) ranges.push([target.size - tail, tail]);
		process.stdout.write(`Sweeping ${ranges.length} Range reads of ${opts.length} bytes every ${opts.step} bytes, plus tail ranges (Accept-Encoding gzip: ${opts.acceptGzip || 'rclone default'})...\n`);
	}
	const failures = [];
	let done = 0;
	for (const [offset, length] of ranges) {
		const range = `bytes=${offset}-${offset + length - 1}`;
		const res = await request(port, auth, 'GET', target.key, range, timeoutMs, agent);
		const expected = reference.subarray(offset, offset + length);
		const ok = (res.status === 206 || res.status === 200) && res.body.length === length && res.contentLength === length && res.body.equals(expected);
		if (!ok) {
			const sameStart = res.body.length > 0 && res.body.equals(reference.subarray(offset, offset + res.body.length));
			const received = classifyBytes(res.body, reference);
			failures.push({
				offset,
				length,
				status: res.status,
				contentLength: res.contentLength,
				contentRange: res.contentRange,
				contentEncoding: res.contentEncoding,
				bytes: res.body.length,
				bytesMatchStoredObject: sameStart,
				received,
				error: res.error,
				ms: res.ms,
			});
			process.stdout.write(
				`  FAIL ${range}: status ${res.status ?? '-'}, Content-Length ${res.contentLength ?? '-'}, received ${res.body.length}` +
					`${res.error ? `, stream ${res.error}` : ''}, prefix matches stored bytes: ${sameStart}, gzip magic: ${received.gzipMagic}` +
					`${received.foundInStoredObjectAt !== undefined ? `, found in stored object at: ${received.foundInStoredObjectAt}` : ''}\n`
			);
		}
		if (++done % 40 === 0) process.stdout.write(`  ${done}/${ranges.length} done, ${failures.length} failed\n`);
	}
	report.sweep = { requests: ranges.length, failures };
	const traced = new Set();
	report.traces = [];
	for (const failure of failures) {
		const key = `${failure.offset}:${failure.length}`;
		if (traced.has(key) || traced.size >= 3) continue;
		traced.add(key);
		process.stdout.write(`\nDirect read with header trace for bytes=${failure.offset}-${failure.offset + failure.length - 1}:\n`);
		const trace = await traceRange(target.key, failure.offset, failure.length, reference);
		report.traces.push({ offset: failure.offset, length: failure.length, ...trace });
		process.stdout.write(`  request Accept-Encoding: ${trace.requestAcceptEncoding ?? '(none)'}\n`);
		for (const response of trace.responses) process.stdout.write(`  response: ${JSON.stringify(response)}\n`);
		process.stdout.write(`  received: ${JSON.stringify(trace.received)}, matches stored bytes: ${trace.matchesStored}, rclone exit ${trace.exit}\n`);
	}
	process.stdout.write(
		`\nSummary: ${ranges.length - failures.length}/${ranges.length} range reads OK, ${failures.length} failed; ` +
			`full GET through serve restic ${fullOk ? 'OK' : 'NOT OK'}; LIST ${target.size} vs HEAD ${headSize ?? 'n/a'}.\n`
	);
	finish(failures.length || !fullOk ? 2 : 0);
}

main().catch(error => {
	process.stderr.write(`Sweep failed: ${error.message}\n`);
	process.exit(1);
});
