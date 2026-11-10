// Synthetic review page for every Assisted Recovery state and Mirror Details.
// Real components, real ThemeProvider; GET responses are fixtures and every
// mutation is refused, so nothing is approved, restored or cancelled here.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useTheme } from '../../src/context/ThemeContext';
import AssistedRecovery from '../../src/components/Restore/AssistedRecovery/AssistedRecovery';
import MirrorDetails from '../../src/components/Plan/Mirrors/MirrorDetails';
import type { AssistedRecoveryJob } from '../../src/utils/assistedRecovery';
import '../../src/styles/global.scss';

const now = Date.now();
const snapshot = (seed: string) => seed.repeat(64 / seed.length).slice(0, 64);
const candidates: AssistedRecoveryJob['candidates'] = [
   {
      replicationId: 'replica-1',
      position: 1,
      state: 'passed',
      destinationSnapshotId: snapshot('b1'),
      replicaVerified: true,
      recoveryPreflight: 'passed',
      recoveryTested: false,
   },
   {
      replicationId: 'replica-2',
      position: 2,
      state: 'failed',
      code: 'replica-snapshot-missing',
      replicaVerified: false,
      recoveryPreflight: 'not-run',
      recoveryTested: false,
   },
];
const base: AssistedRecoveryJob = {
   id: 'recovery-example-0001',
   planId: 'example-plan',
   planName: 'Example App Files',
   backupId: 'example-0237',
   status: 'checking',
   phase: 'primary-check',
   createdAt: now - 60000,
   expiresAt: now + 15 * 60000,
   expired: false,
   sourceSnapshotId: snapshot('a7'),
   primary: { state: 'unavailable', code: 'primary-repository-unreachable' },
   candidates: [],
   target: 'private-staging',
   operation: 'restore-files',
   includes: ['/srv/example-app/uploads'],
   excludes: [],
   cleanupPending: false,
   audit: [
      { at: now - 60000, event: 'requested' },
      { at: now - 55000, event: 'primary-checked', code: 'primary-repository-unreachable' },
   ],
};
const states: Record<string, AssistedRecoveryJob> = {
   checking: { ...base, id: 'job-checking', status: 'checking', primary: undefined },
   'awaiting-approval': { ...base, id: 'job-awaiting', status: 'awaiting-approval', phase: 'awaiting-approval', candidates },
   running: { ...base, id: 'job-running', status: 'running', phase: 'restoring', candidates, selected: 'replica-1' },
   completed: {
      ...base,
      id: 'job-completed',
      status: 'completed',
      phase: 'verified',
      candidates: candidates.map((c) => (c.state === 'passed' ? { ...c, recoveryTested: true } : c)),
      selected: 'replica-1',
      stats: { files: 1284, bytes: 734003200 },
   },
   failed: {
      ...base,
      id: 'job-failed',
      status: 'failed',
      phase: 'replica-check',
      failureCode: 'all-replicas-unavailable',
      candidates: [candidates[1]],
   },
   'cleanup-pending': { ...base, id: 'job-cleanup', status: 'cancelled', phase: 'cleanup', cleanupPending: true },
   uncertain: { ...base, id: 'job-uncertain', status: 'uncertain', phase: 'restoring', candidates, selected: 'replica-1' },
};
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
   const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href);
   if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
   if ((init?.method || 'GET') !== 'GET') throw new Error('Mutation refused: synthetic recovery preview.');
   if (url.pathname === '/api/assisted-recovery') {
      const job = states[url.searchParams.get('backupId') || ''];
      return Response.json({ success: true, result: job ? [job] : [] });
   }
   throw new Error(`Unmapped synthetic API: ${url.pathname}`);
};
const mirrors = [
   {
      replicationId: 'replica-1',
      storageId: 's3-primary-copy',
      storageName: 'Example S3 Replica',
      storagePath: 'example-app',
      storageType: 's3',
      status: 'completed' as const,
      started: now / 1000 - 300,
      ended: now / 1000 - 240,
      size: 734003200,
      snapshotId: snapshot('b1'),
      sourceSnapshotId: snapshot('a7'),
      attempts: 1,
      verifiedAt: now - 230000,
   },
   {
      replicationId: 'replica-2',
      storageId: 's3-secondary-copy',
      storageName: 'Example S3 Archive',
      storagePath: 'example-app',
      storageType: 's3',
      status: 'failed' as const,
      attempts: 3,
      lastErrorCode: 'replica-snapshot-missing',
      error: 'Synthetic replication failure: destination snapshot was not found.',
   },
];

function Preview() {
   const { theme, setTheme } = useTheme();
   const [view, setView] = useState<'states' | 'mirrors'>('states');
   return (
      <div style={{ padding: 24, display: 'grid', gap: 24, maxWidth: 760, margin: '0 auto' }}>
         <div style={{ fontSize: 12 }}>
            Synthetic · {theme} <button onClick={() => setTheme('light')}>Light</button> <button onClick={() => setTheme('dark')}>Dark</button>{' '}
            <button onClick={() => setView('states')}>Recovery states</button> <button onClick={() => setView('mirrors')}>Mirror Details</button>
         </div>
         {view === 'states' ? (
            Object.keys(states).map((name) => (
               <div key={name} data-state={name} style={{ background: 'var(--content-background-color)', padding: 20, borderRadius: 8 }}>
                  <AssistedRecovery planId="example-plan" backupId={name} manual close={() => {}} />
               </div>
            ))
         ) : (
            <MirrorDetails
               mirrors={mirrors}
               managedAgent
               replicationSettings={{ enabled: true, recoveryPolicy: 'assisted', storages: [] } as never}
               backupId="awaiting-approval"
               planId="example-plan"
               close={() => setView('states')}
            />
         )}
      </div>
   );
}
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
createRoot(document.getElementById('root')!).render(
   <QueryClientProvider client={queryClient}>
      <ThemeProvider>
         <Preview />
      </ThemeProvider>
   </QueryClientProvider>,
);
