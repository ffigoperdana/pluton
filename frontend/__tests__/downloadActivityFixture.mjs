import { fileURLToPath } from 'node:url';
export const activityEntry = {
   contents: `import React from 'react';
import Panel from './src/components/Plan/Backups/DownloadPreparation';
import Tracker from './src/components/App/ExportActivity/ExportActivity';
import {ExportActivityProvider} from './src/context/ExportActivityContext';
export default function Fixture(p) { return <ExportActivityProvider>{p.panelOpen !== false && <Panel {...p}/>}<Tracker/></ExportActivityProvider>; }`,
   resolveDir: fileURLToPath(new URL('../', import.meta.url)),
   loader: 'tsx',
};
export const go = { configured: true, sharedNamespaceEnabled: true, exportMode: 'application-encrypted-hcp',
   keyringConfigured: true, admissionAllowed: true, preflight: 'GO', reason: 'ready' };
// Existing panel tests exercise the new GET discovery boundary through their
// controlled job responder. No fake client state is injected into the manager.
export function activityFetch(fetcher, backupId = 'backup-01') {
   let admitted = false;
   return async (url, options = {}) => {
      if (String(url).endsWith('/managed-exports/activity')) {
         if (!admitted) return Response.json({ success: true, result: { readiness: go, jobs: [] } });
         const result = await fetcher('https://example.internal/api/backups/' + backupId + '/exports/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { ...options, method: 'GET' });
         if (!result.ok) return result;
         const body = await result.json();
         return Response.json({ success: true, result: { readiness: go, jobs: [{ backupId, planId: 'plan-01', job: body.result }] } });
      }
      const result = await fetcher(url, options);
      if (String(url).endsWith('/exports') && options.method === 'POST' && result.ok) admitted = true;
      return result;
   };
}
