// Actual routes/components and actual ThemeProvider. No pilot data, live API,
// stored credentials, or filesystem operations are used by this preview.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Link } from 'react-router';
import { AppRoutes } from '../../src/router';
import { ThemeProvider, useTheme } from '../../src/context/ThemeContext';
import { DEFAULT_PLAN_SETTINGS } from '../../src/utils/constants';
import sftpFields from '../../../backend/src/utils/providers/sftp';
import '../../src/styles/global.scss';

const now = Date.now();
const backups = ['completed', 'failed', 'cancelled'].map((status, index) => ({
   id: `example-backup-${index}`,
   title: `Example backup ${index + 1}`,
   snapshotId: index ? '' : 'a'.repeat(64),
   started: now - (index + 1) * 3600000,
   ended: now - (index + 1) * 3600000 + 60000,
   duration: 60,
   status,
   inProgress: false,
   totalFiles: 12,
   totalSize: 2048,
   active: status === 'completed',
   changes: { new: 3, modified: 2, removed: 1 },
   errorMsg: status === 'failed' ? 'Synthetic backup failure.' : '',
}));
const storage = {
   id: 'example-storage',
   name: 'Example SFTP',
   type: 'sftp',
   storageTypeName: 'SFTP',
   storageFields: sftpFields,
   authType: 'password',
   defaultPath: '',
   tags: ['example'],
   usedSize: 2048,
   settings: { disable_hashcheck: false, known_hosts_file: '', path_override: '', key_use_agent: false, use_insecure_cipher: false },
   credentials: { host: '192.0.2.20', port: 22, user: 'example_reader', pass: '' },
   plans: [],
   createdAt: new Date().toISOString(),
};
const device = {
   id: 'example-agent',
   ip: '192.0.2.10',
   name: 'app-01',
   type: 'device',
   connected: true,
   createdAt: new Date().toISOString(),
   agentId: 'example-agent-identity',
   versions: { agent: '1.0.0', restic: '0.19.1', rclone: '1.75.1' },
   host: null,
   port: null,
   hostname: 'app-01',
   os: 'linux',
   platform: 'linux',
   disks: [],
   status: 'active',
   isRemote: true,
   lastSeen: new Date().toISOString(),
   plans: [],
   tags: [],
   metrics: null,
   settings: {},
   agent: {
      agentId: 'example-agent-identity',
      deviceId: 'example-agent',
      status: 'online',
      hostname: 'app-01',
      os: 'linux',
      architecture: 'x64',
      agentVersion: '1.0.0',
      resticVersion: '0.19.1',
      rcloneVersion: '1.75.1',
      capabilities: { filesystemRootsConfigured: true, commandTypes: ['BACKUP_FILESYSTEM'] },
      lastSeen: new Date().toISOString(),
      createdAt: new Date().toISOString(),
   },
};
const plan = {
   ...structuredClone(DEFAULT_PLAN_SETTINGS),
   id: 'example-plan',
   title: 'Example remote backup',
   description: 'Synthetic theme review',
   isActive: true,
   inProgress: false,
   createdAt: new Date().toISOString(),
   lastBackupTime: new Date().toISOString(),
   lastUpdated: null,
   sourceId: device.id,
   sourceType: 'device',
   storageId: storage.id,
   storage,
   storagePath: 'example-repo',
   device,
   sourceConfig: { includes: ['/srv/example-app'], excludes: [] },
   verified: { status: 'completed', result: {}, startedAt: now, endedAt: now, hasError: false },
   stats: { size: 2048, snapshots: ['a'.repeat(64)] },
   backups,
   restores: [
      {
         id: 'example-restore',
         backupId: 'example-backup-0',
         status: 'completed',
         inProgress: false,
         started: now - 1800000,
         ended: now - 1740000,
         createdAt: now - 1800000,
         config: { target: '/srv/example-staging', overwrite: 'never' },
         taskStats: { files_restored: 3, bytes_restored: 2048, total_bytes: 2048, total_files: 3 },
         completionStats: { files_restored: 3, bytes_restored: 2048, total_bytes: 2048, total_files: 3, seconds_elapsed: 60 },
      },
   ],
};
plan.settings.remoteLifecycle = {
   version: 2,
   databases: ['one', 'two'].map((name, index) => ({
      databaseId: `db_example_${name}`,
      engine: index ? 'postgresql' : 'mariadb',
      host: 'localhost',
      port: index ? 5432 : 3306,
      tls: 'local',
      database: `example_${name}`,
      username: 'example_reader',
      dumpFilename: `${name}.sql`,
      timeoutSeconds: 60,
      maxDumpBytes: 1024 ** 3,
      includeRoutines: false,
      includeEvents: false,
      passwordConfigured: true,
   })),
   preHook: { id: 'example-prepare', args: [], timeoutSeconds: 60 },
   postHook: { id: 'example-cleanup', args: [], timeoutSeconds: 60 },
};
const localPlan = {
   ...plan,
   id: 'example-local-plan',
   title: 'Example local backup',
   sourceId: 'main',
   device: { ...device, id: 'main', name: 'Main device' },
};
const files = [
   {
      name: 'srv',
      path: '/srv',
      type: 'dir',
      isDirectory: true,
      size: 0,
      mode: 493,
      permissions: 'drwxr-xr-x',
      owner: 'root',
      modifiedAt: new Date().toISOString(),
   },
   {
      name: 'example-app',
      path: '/srv/example-app',
      type: 'dir',
      isDirectory: true,
      size: 0,
      mode: 493,
      permissions: 'drwxr-xr-x',
      owner: 'root',
      modifiedAt: new Date().toISOString(),
   },
   {
      name: 'example.txt',
      path: '/srv/example-app/example.txt',
      type: 'file',
      isDirectory: false,
      size: 2048,
      mode: 420,
      permissions: '-rw-r--r--',
      owner: 'root',
      modifiedAt: new Date().toISOString(),
   },
];
const settings = { id: 'example-settings', settings: { integration: {}, smtp: {}, maxConcurrentBackups: 2 }, integration: {}, smtp: {} };
const requests: string[] = [];
let failures = 0;
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
   const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href);
   if (!url.pathname.startsWith('/api/')) {
      if (url.origin !== window.location.origin) throw new Error('External requests are blocked in the theme fixture.');
      return realFetch(input, init);
   }
   const path = url.pathname.slice(4);
   const method = init?.method || 'GET';
   requests.push(`${method} ${path}`);
   let result: unknown;
   if (method === 'POST' && path === '/agent-admin/enrollments') {
      result = {
         id: 'example-enrollment',
         token: 'EXAMPLE-NOT-A-REAL-TOKEN',
         expiresAt: new Date(Date.now() + 600000).toISOString(),
         deviceName: 'app-02',
         serverUrl: 'http://192.0.2.10',
         insecureHttpAllowed: true,
      };
   } else if (method === 'POST' && path === '/restores/action/dryrestore') {
      // UI-only preview; this does not start Restic or write a staging directory.
      result = { stats: plan.restores[0].taskStats, files: files.map((file) => ({ ...file, action: 'restored' })) };
   } else if (method !== 'GET') {
      throw new Error('Mutation refused: this theme preview has no backend.');
   } else if (path === '/user/validate') result = { username: 'example_reader' };
   else if (path === '/settings/version/latest') result = { latestVersion: 'dev' };
   else if (path === '/settings') result = settings;
   else if (path === '/plans') result = [plan, localPlan];
   else if (path === '/plans/example-plan') result = plan;
   else if (path === '/plans/example-local-plan') result = localPlan;
   else if (path.endsWith('/checkactive')) result = { backups: [], restores: [] };
   else if (path.endsWith('/logs'))
      result = [
         { time: new Date().toISOString(), level: 'info', type: 'info', message: 'Synthetic backup started.' },
         { time: new Date().toISOString(), level: 'warn', type: 'warn', message: 'Synthetic warning.' },
         { time: new Date().toISOString(), level: 'error', type: 'error', message: 'Synthetic error.' },
      ];
   else if (path === '/devices') result = [device, { ...device, id: 'main', name: 'Main device', agent: null, isRemote: false }];
   else if (path.startsWith('/devices/')) result = { device, plans: [plan], storages: [storage] };
   else if (path === '/storages/available') result = { sftp: { name: 'SFTP', authTypes: ['password'], settings: sftpFields } };
   else if (path === '/storages') result = [storage];
   else if (path === '/storages/example-storage') result = { ...storage, authTypes: ['password'] };
   else if (path.startsWith('/backups/') && path.endsWith('/files')) result = files;
   else if (path.startsWith('/backups/')) result = backups[0];
   else if (path === '/restores') result = plan.restores;
   else throw new Error(`Unmapped synthetic API: ${method} ${path}`);
   return new Response(JSON.stringify({ success: true, result }), {
      headers: { 'content-type': 'application/json', 'x-app-version': 'dev', 'x-install-type': 'dev', 'x-server-os': 'linux' },
   });
};
window.addEventListener('error', () => {
   failures++;
});
window.addEventListener('unhandledrejection', () => {
   failures++;
});

function PreviewControls() {
   const { theme, setTheme } = useTheme();
   const [diagnostics, setDiagnostics] = useState('');
   return (
      <aside
         style={{
            position: 'fixed',
            left: 8,
            bottom: 8,
            zIndex: 2147483647,
            background: 'var(--content-background-color)',
            color: 'var(--content-text-color)',
            border: '1px solid var(--line-color)',
            padding: 8,
            borderRadius: 6,
         }}
      >
         <strong>Synthetic · {theme}</strong> <button onClick={() => setTheme('light')}>Light</button>{' '}
         <button onClick={() => setTheme('dark')}>Dark</button> <button onClick={() => setTheme('auto')}>Auto</button>
         {' · '}
         <Link to="/">Plans</Link>
         {' · '}
         <Link to="/plan/example-plan">Remote plan</Link>
         {' · '}
         <Link to="/plan/example-local-plan">Local plan</Link>
         {' · '}
         <Link to="/storages">Storages</Link>
         {' · '}
         <Link to="/sources">Machines</Link>{' '}
         <button
            onClick={() =>
               setDiagnostics(
                  `Browser exceptions: ${failures}\nSynthetic requests: ${requests.length}\nStored theme: ${localStorage.getItem('themeSetting')}\nApplied theme: ${document.documentElement.dataset.theme}`,
               )
            }
         >
            Diagnostics
         </button>
         {diagnostics && <output style={{ display: 'block', whiteSpace: 'pre-line' }}>{diagnostics}</output>}
      </aside>
   );
}
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
createRoot(document.getElementById('root')!).render(
   <QueryClientProvider client={queryClient}>
      <ThemeProvider>
         <MemoryRouter>
            <PreviewControls />
            <AppRoutes />
         </MemoryRouter>
      </ThemeProvider>
   </QueryClientProvider>,
);
