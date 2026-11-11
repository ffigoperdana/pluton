// Test-only TCP proxy in front of a loopback S3 server, for the diagnostics harnesses.
// Modes (fourth argument), all scoped to the target object:
//   (none)     after a non-Range GET, pass the headers plus 64 KiB, then hold silently
//   any        hold any GET (Range or not) before the first response byte
//   shorthead  report a Content-Length 8 KiB smaller than the real size on HEAD
import net from 'node:net';

const [listenPort, upstreamPort, target, mode] = process.argv.slice(2);
net
	.createServer(client => {
		const upstream = net.connect(Number(upstreamPort), '127.0.0.1');
		let holding = false;
		let budget = Infinity;
		let rewriteHead = false;
		let request = '';
		client.on('data', chunk => {
			request = (request + chunk.toString('latin1')).slice(-8192);
			const get = /GET [^\r\n]*\/data\/[0-9a-f]{2}\/([0-9a-f]{64})[^\r\n]* HTTP\/1\.1\r\n([\s\S]*?)\r\n\r\n/.exec(request);
			const head = /HEAD [^\r\n]*\/data\/[0-9a-f]{2}\/([0-9a-f]{64})[^\r\n]* HTTP\/1\.1\r\n[\s\S]*?\r\n\r\n/.exec(request);
			if (mode === 'shorthead') {
				if (head && head[1] === target) {
					rewriteHead = true;
					request = '';
				} else if (get) request = '';
			} else if (get && get[1] === target && (mode === 'any' || !/\r\nRange:/i.test('\r\n' + get[2]))) {
				budget = mode === 'any' ? 0 : 64 * 1024 + 2048;
				request = '';
			}
			upstream.write(chunk);
		});
		upstream.on('data', chunk => {
			if (holding) return;
			if (rewriteHead) {
				rewriteHead = false;
				client.write(
					Buffer.from(
						chunk.toString('latin1').replace(/Content-Length:\s*(\d+)/i, (_, n) => `Content-Length: ${Number(n) - 8192}`),
						'latin1'
					)
				);
				return;
			}
			if (chunk.length <= budget) {
				budget -= chunk.length;
				client.write(chunk);
				return;
			}
			client.write(chunk.subarray(0, budget));
			holding = true; // keep the socket open and silent, like the production stall
		});
		const close = () => {
			client.destroy();
			upstream.destroy();
		};
		client.on('error', close);
		upstream.on('error', close);
		client.on('close', close);
		upstream.on('close', () => !holding && close());
	})
	.listen(Number(listenPort), '127.0.0.1');
