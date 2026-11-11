#!/usr/bin/env node
// Pluton archive stall watcher. Read-only: it only reads /proc and sends DNS
// queries. It never signals, attaches to or modifies any process. Run it inside
// the Pluton container while an archive readback runs. See
// docs/REPLICA_READBACK_PROBE.md ("Stall watcher").
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOOL = 'pluton-archive-stall-watch/1';
const USAGE = `Usage (inside the Pluton container):
  node archive-stall-watch.mjs [--host <s3-hostname>] [--duration <seconds>] [--interval <seconds>]
                               [--report <file>] [--show-ips]

  --host       Hostname to resolve each interval (default: host of MANAGED_EXPORT_ENDPOINT).
  --duration   Stop after this many seconds (default: 900).
  --interval   Seconds between samples (default: 5).
  --report     JSON report path (default: /tmp/pluton-stall-watch-<time>.json).
  --show-ips   Print remote addresses instead of stable labels (node-1, node-2, ...).

It waits for a running "restic ... dump --archive" process, so start it first and
then approve the recovery. Without a dump process it still samples DNS.`;

const STATES = {
	'01': 'ESTABLISHED', '02': 'SYN_SENT', '03': 'SYN_RECV', '04': 'FIN_WAIT1', '05': 'FIN_WAIT2',
	'06': 'TIME_WAIT', '07': 'CLOSE', '08': 'CLOSE_WAIT', '09': 'LAST_ACK', '0A': 'LISTEN', '0B': 'CLOSING',
};

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const opts = { duration: 900, interval: 5, report: '', showIps: false, host: '' };
	try {
		opts.host = process.env.MANAGED_EXPORT_ENDPOINT ? new URL(process.env.MANAGED_EXPORT_ENDPOINT).hostname : '';
	} catch {
		opts.host = '';
	}
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = () => {
			const next = argv[++i];
			if (next === undefined) fail(`Missing value for ${flag}\n\n${USAGE}`);
			return next;
		};
		const int = (min, max) => {
			const n = Number(value());
			if (!Number.isInteger(n) || n < min || n > max) fail(`${flag} must be an integer from ${min} to ${max}`);
			return n;
		};
		if (flag === '--host') opts.host = value();
		else if (flag === '--duration') opts.duration = int(10, 7200);
		else if (flag === '--interval') opts.interval = int(1, 60);
		else if (flag === '--report') opts.report = value();
		else if (flag === '--show-ips') opts.showIps = true;
		else if (flag === '-h' || flag === '--help') {
			process.stdout.write(USAGE + '\n');
			process.exit(0);
		} else fail(`Unknown option ${flag}\n\n${USAGE}`);
	}
	if (opts.host && !/^[a-z0-9.-]+$/i.test(opts.host)) fail('--host must be a plain hostname');
	if (process.platform !== 'linux') fail('This watcher reads /proc and only runs on Linux.');
	return opts;
}

const read = file => {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
};

function stat(pid) {
	const text = read(`/proc/${pid}/stat`);
	if (!text) return undefined;
	const end = text.lastIndexOf(')');
	const fields = text.slice(end + 2).split(' ');
	return {
		comm: text.slice(text.indexOf('(') + 1, end),
		state: fields[0],
		ppid: Number(fields[1]),
		cpuTicks: Number(fields[11]) + Number(fields[12]),
		start: fields[19],
	};
}

function io(pid) {
	const text = read(`/proc/${pid}/io`);
	if (!text) return undefined;
	return {
		rchar: Number(/^rchar:\s*(\d+)$/m.exec(text)?.[1]),
		wchar: Number(/^wchar:\s*(\d+)$/m.exec(text)?.[1]),
	};
}

function processes() {
	const all = [];
	for (const name of fs.readdirSync('/proc')) {
		if (!/^\d+$/.test(name)) continue;
		const info = stat(name);
		if (info) all.push({ pid: Number(name), ...info });
	}
	const dumps = all.filter(proc => {
		if (proc.comm !== 'restic') return false;
		const argv = (read(`/proc/${proc.pid}/cmdline`) || '').split('\0');
		return argv.includes('dump') && argv.includes('--archive');
	});
	return dumps.map(restic => ({
		restic,
		rclone: all.filter(proc => proc.ppid === restic.pid && proc.comm === 'rclone'),
	}));
}

function socketInodes(pid) {
	const inodes = new Set();
	let entries = [];
	try {
		entries = fs.readdirSync(`/proc/${pid}/fd`);
	} catch {
		return inodes;
	}
	for (const fd of entries) {
		try {
			const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
			const match = /^socket:\[(\d+)\]$/.exec(target);
			if (match) inodes.add(match[1]);
		} catch {
			// The descriptor closed between readdir and readlink.
		}
	}
	return inodes;
}

function hexAddress(hex) {
	const [address, port] = hex.split(':');
	if (address.length === 8) {
		const ip = [3, 2, 1, 0].map(i => parseInt(address.slice(i * 2, i * 2 + 2), 16)).join('.');
		return { ip, port: parseInt(port, 16) };
	}
	const words = address.match(/.{8}/g).map(word => word.match(/../g).reverse().join(''));
	const full = words.join('');
	if (full.startsWith('00000000000000000000ffff')) {
		const v4 = full.slice(24);
		return { ip: v4.match(/../g).map(b => parseInt(b, 16)).join('.'), port: parseInt(port, 16) };
	}
	return { ip: full.match(/.{4}/g).join(':'), port: parseInt(port, 16) };
}

function tcpTable(pid) {
	const rows = new Map();
	for (const file of ['tcp', 'tcp6']) {
		const text = read(`/proc/${pid}/net/${file}`);
		if (!text) continue;
		for (const line of text.trim().split('\n').slice(1)) {
			const f = line.trim().split(/\s+/);
			const [tx, rx] = f[4].split(':').map(v => parseInt(v, 16));
			const [timer] = f[5].split(':');
			rows.set(f[9], {
				remote: hexAddress(f[2]),
				state: STATES[f[3]] || f[3],
				txQueue: tx,
				rxQueue: rx,
				timer: Number(timer),
				retransmits: parseInt(f[6], 16),
			});
		}
	}
	return rows;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const started = Date.now();
	const reportFile = opts.report || path.join(os.tmpdir(), `pluton-stall-watch-${new Date(started).toISOString().replace(/[:.]/g, '-')}.json`);
	const labels = new Map();
	const label = ip => {
		if (opts.showIps) return ip;
		if (!labels.has(ip)) labels.set(ip, `node-${labels.size + 1}`);
		return labels.get(ip);
	};
	const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
	const report = { tool: TOOL, startedAt: new Date(started).toISOString(), intervalSeconds: opts.interval, dnsChecked: Boolean(opts.host), samples: [] };
	let previous = new Map();
	let seenDump = false;
	let goneSince;
	let stopping = false;
	const finish = code => {
		report.finishedAt = new Date().toISOString();
		const dnsSamples = report.samples.filter(sample => sample.dns);
		report.summary = {
			samples: report.samples.length,
			samplesWithDump: report.samples.filter(sample => sample.processes.length).length,
			dnsFailures: dnsSamples.filter(sample => !sample.dns.ok).length,
			dnsSlowOver1s: dnsSamples.filter(sample => sample.dns.ms > 1000).length,
			addressLabels: opts.showIps ? undefined : labels.size,
		};
		try {
			fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
		} catch (error) {
			process.stderr.write(`Could not write report: ${error.code || 'error'}\n`);
		}
		const s = report.summary;
		process.stdout.write(
			`\nSummary: ${s.samples} samples, ${s.samplesWithDump} with a dump process, ` +
				`DNS failures ${s.dnsFailures}, DNS slower than 1 s ${s.dnsSlowOver1s}.\nReport: ${reportFile}\n`
		);
		process.exit(code);
	};
	process.on('SIGINT', () => {
		stopping = true;
		finish(130);
	});

	process.stdout.write(
		`${TOOL}\nRead-only: /proc and DNS queries only. Interval ${opts.interval}s, up to ${opts.duration}s. ` +
			`DNS check: ${opts.host ? 'on' : 'off (no --host)'}.\nWaiting for a restic dump --archive process...\n\n`
	);

	while (!stopping && Date.now() - started < opts.duration * 1000) {
		const tick = Date.now();
		const sample = { t: Math.round((tick - started) / 1000), at: new Date(tick).toISOString(), processes: [] };
		if (opts.host) {
			const begin = performance.now();
			try {
				const addresses = await resolver.resolve4(opts.host);
				sample.dns = { ok: true, ms: Math.round(performance.now() - begin), answers: addresses.length };
			} catch (error) {
				sample.dns = { ok: false, ms: Math.round(performance.now() - begin), code: error.code || 'error' };
			}
		}
		const current = new Map();
		for (const group of processes()) {
			const describe = (proc, role) => {
				const counters = io(proc.pid);
				const key = `${proc.pid}:${proc.start}`;
				const before = previous.get(key);
				const now = { ...counters, cpuTicks: proc.cpuTicks };
				current.set(key, now);
				const delta =
					before && counters
						? { read: now.rchar - before.rchar, written: now.wchar - before.wchar, cpuTicks: now.cpuTicks - before.cpuTicks }
						: undefined;
				const entry = { role, state: proc.state, delta, wchan: (read(`/proc/${proc.pid}/wchan`) || '').trim() || undefined };
				if (role === 'rclone') {
					const inodes = socketInodes(proc.pid);
					const table = tcpTable(proc.pid);
					entry.tcp = [...inodes]
						.map(inode => table.get(inode))
						.filter(Boolean)
						.map(row => ({
							remote: `${label(row.remote.ip)}:${row.remote.port}`,
							state: row.state,
							txQueue: row.txQueue,
							rxQueue: row.rxQueue,
							retransmits: row.retransmits,
							timer: row.timer,
						}));
				}
				return entry;
			};
			sample.processes.push([describe(group.restic, 'restic'), ...group.rclone.map(proc => describe(proc, 'rclone'))]);
		}
		previous = current;
		report.samples.push(sample);

		if (sample.processes.length) {
			seenDump = true;
			goneSince = undefined;
		} else if (seenDump && goneSince === undefined) goneSince = tick;

		const dnsText = sample.dns ? (sample.dns.ok ? `dns ok ${sample.dns.ms}ms (${sample.dns.answers})` : `dns FAIL ${sample.dns.code} ${sample.dns.ms}ms`) : '';
		const procText = sample.processes.length
			? sample.processes
					.map(group =>
						group
							.map(entry => {
								const d = entry.delta ? `Δr ${entry.delta.read} Δw ${entry.delta.written} cpu ${entry.delta.cpuTicks}` : 'first sample';
								const tcp = entry.tcp
									? ' tcp[' + (entry.tcp.length ? entry.tcp.map(c => `${c.remote} ${c.state} rx${c.rxQueue} tx${c.txQueue} re${c.retransmits}`).join(', ') : 'none') + ']'
									: '';
								return `${entry.role}(${entry.state}) ${d}${tcp}`;
							})
							.join(' | ')
					)
					.join(' || ')
			: seenDump
				? 'dump process ended'
				: 'no dump process yet';
		process.stdout.write(`t+${String(sample.t).padStart(4)}s  ${procText}  ${dnsText}\n`);

		if (goneSince !== undefined && tick - goneSince >= 10_000) break;
		const wait = opts.interval * 1000 - (Date.now() - tick);
		if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
	}
	finish(0);
}

main();
