import { useEffect, useState, type ReactNode } from 'react';
import { ExportActivityManager } from '../utils/exportActivity';
import { API_URL } from '../utils/constants';
import { ExportActivityContext } from '../hooks/useExportActivity';

export function ExportActivityProvider({ children }: { children: ReactNode }) {
   const [manager] = useState(
      () =>
         new ExportActivityManager(API_URL, () => {
            // Invalidation only: never trust another tab's job state, owner or proofs.
            try {
               const channel = new BroadcastChannel('pluton-export-activity');
               channel.postMessage('refresh');
               channel.close();
            } catch {
               /* Focus refresh remains available. */
            }
         }),
   );
   useEffect(() => {
      manager.start();
      const refresh = () => {
         if (document.visibilityState !== 'hidden') void manager.invalidate();
      };
      const sessionChanged = () => {
         manager.stop();
         manager.start();
      };
      let channel: BroadcastChannel | undefined;
      try {
         channel = new BroadcastChannel('pluton-export-activity');
         channel.onmessage = (event) => {
            if (event.data === 'session-changed') sessionChanged();
            if (event.data === 'refresh') refresh();
         };
      } catch {
         /* Optional browser support. */
      }
      window.addEventListener('focus', refresh);
      window.addEventListener('pluton-export-session', sessionChanged);
      document.addEventListener('visibilitychange', refresh);
      return () => {
         channel?.close();
         window.removeEventListener('focus', refresh);
         window.removeEventListener('pluton-export-session', sessionChanged);
         document.removeEventListener('visibilitychange', refresh);
         manager.stop();
      };
   }, [manager]);
   return <ExportActivityContext.Provider value={manager}>{children}</ExportActivityContext.Provider>;
}
