// CI-only admission readiness. Never retries SQL, changes a measurement or relaxes policy.
export async function waitForFixtureCapacity({
   check, blocked = () => {}, now = Date.now,
   delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
   timeoutMs = 60000,
}) {
   const deadline = now() + timeoutMs;
   for (;;) {
      try {
         await check();
         return;
      } catch (error) {
         if (error?.code !== 'internal-resources-insufficient') throw error;
         blocked();
         if (now() >= deadline) {
            const failure = new Error('Fixture resource admission did not become ready; no import started.');
            failure.code = 'fixture-resource-admission-blocked';
            throw failure;
         }
         // Observe the next real publication (observer cadence is two seconds).
         await delay(Math.min(2000, deadline - now()));
      }
   }
}
