import { startLinkFixture, type LinkFixtureConfig } from './managedSymlinkRecovery.runtime';
let application: Awaited<ReturnType<typeof startLinkFixture>> | undefined;
process.on('message', async (message: { config?: LinkFixtureConfig; stop?: boolean }) => {
	try {
		if (message.config) {
			application = await startLinkFixture(message.config);
			process.send?.({ ready: true, base: application.base });
		}
		if (message.stop) {
			await application?.close();
			process.send?.({ closed: true });
			process.disconnect();
		}
	} catch {
		process.send?.({ failed: true });
		process.exitCode = 1;
		process.disconnect();
	}
});
