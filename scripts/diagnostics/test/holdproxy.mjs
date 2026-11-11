// Test-only TCP proxy: forwards everything, but once it sees a GET for the target
// object it passes the response headers plus 64 KiB, then holds. By default only a
// non-Range GET is held; pass "any" as the fourth argument to hold Range GETs too.
import net from 'node:net';

const [listenPort, upstreamPort, target, mode] = process.argv.slice(2);
net
	.createServer(client => {
		const upstream = net.connect(Number(upstreamPort), '127.0.0.1');
		let holding = false;
		let budget = Infinity;
		let request = '';
		client.on('data', chunk => {
			request = (request + chunk.toString('latin1')).slice(-8192);
			const get = /GET [^\r\n]*\/data\/[0-9a-f]{2}\/([0-9a-f]{64})[^\r\n]* HTTP\/1\.1\r\n([\s\S]*?)\r\n\r\n/.exec(request);
			if (get && get[1] === target && (mode === 'any' || !/\r\nRange:/i.test('\r\n' + get[2]))) {
				budget = mode === 'any' ? 0 : 64 * 1024 + 2048;
				request = '';
			}
			upstream.write(chunk);
		});
		upstream.on('data', chunk => {
			if (holding) return;
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
