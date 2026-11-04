/** Invalidation only. Never send a token, owner identifier or job state across tabs. */
export function exportSessionChanged() {
   window.dispatchEvent(new Event('pluton-export-session'));
   try {
      const channel = new BroadcastChannel('pluton-export-activity');
      channel.postMessage('session-changed');
      channel.close();
   } catch {
      /* Visibility/focus rediscovery remains available. */
   }
}
