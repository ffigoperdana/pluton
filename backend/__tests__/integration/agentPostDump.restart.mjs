import { runOnce } from '../../../agent/dist/runtime.js';
process.once('message', async config => {
	try {
		await runOnce({ ...config, serverUrl: new URL(config.serverUrl) });
		process.send?.({ complete: true });
	} catch {
		process.send?.({ complete: false });
		process.exitCode = 1;
	} finally {
		process.disconnect();
	}
});
