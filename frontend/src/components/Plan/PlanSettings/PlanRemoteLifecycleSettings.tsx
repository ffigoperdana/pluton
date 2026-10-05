import type { RemoteBackupLifecycle, RemoteDatabaseBackup, RemoteLifecycleHook } from '../../../@types/plans';
import classes from './PlanSettings.module.scss';
import styles from './PlanRemoteLifecycleSettings.module.scss';

const defaultDatabase: RemoteDatabaseBackup = {
   engine: 'mariadb',
   host: 'localhost',
   port: 3306,
   tls: 'verify-identity',
   database: '',
   username: '',
   dumpFilename: 'app.sql',
   timeoutSeconds: 900,
   maxDumpBytes: 10 * 1024 ** 3,
   includeRoutines: false,
   includeEvents: false,
};

export default function PlanRemoteLifecycleSettings({
   value = { version: 1 },
   onUpdate,
}: {
   value?: RemoteBackupLifecycle;
   onUpdate: (value: RemoteBackupLifecycle) => void;
}) {
   const db = value.database;
   const updateDatabase = (patch: Partial<RemoteDatabaseBackup>) => onUpdate({ ...value, database: { ...defaultDatabase, ...db, ...patch } });
   const updateHook = (key: 'preHook' | 'postHook', patch?: Partial<RemoteLifecycleHook>) =>
      onUpdate({ ...value, [key]: patch === undefined ? undefined : { id: '', args: [], timeoutSeconds: 60, ...value[key], ...patch } });
   return (
      <div className={styles.lifecycle}>
         <h3>Database Backup</h3>
         <p>A logical dump and the application files share one snapshot. Dumps use a private job workspace, never the live source.</p>
         <label>
            <input
               type="checkbox"
               checked={!!db}
               onChange={(e) => onUpdate({ ...value, database: e.target.checked ? { ...defaultDatabase } : undefined })}
            />{' '}
            Enable database backup
         </label>
         {db && (
            <div className={styles.grid}>
               <label>
                  Engine
                  <select value={db.engine} onChange={(e) => updateDatabase({ engine: e.target.value as RemoteDatabaseBackup['engine'] })}>
                     <option value="mariadb">MariaDB (mariadb-dump)</option>
                     <option value="mysql">MySQL (mysqldump)</option>
                  </select>
               </label>
               <label>
                  Host
                  <input value={db.host} onChange={(e) => updateDatabase({ host: e.target.value })} />
               </label>
               <label>
                  Port
                  <input type="number" min={1} max={65535} value={db.port} onChange={(e) => updateDatabase({ port: Number(e.target.value) })} />
               </label>
               <label>
                  Database
                  <input value={db.database} autoComplete="off" onChange={(e) => updateDatabase({ database: e.target.value })} />
               </label>
               <label>
                  Username
                  <input value={db.username} autoComplete="off" onChange={(e) => updateDatabase({ username: e.target.value })} />
               </label>
               <label>
                  {db.passwordConfigured ? 'Replace password (blank keeps saved secret)' : 'Password'}
                  <input
                     type="password"
                     autoComplete="new-password"
                     value={db.password || ''}
                     placeholder={db.passwordConfigured ? 'Password saved — never displayed' : 'Required'}
                     onChange={(e) => updateDatabase({ password: e.target.value || undefined })}
                  />
               </label>
               <label>
                  Dump filename
                  <input value={db.dumpFilename} onChange={(e) => updateDatabase({ dumpFilename: e.target.value })} />
               </label>
               <label>
                  Dump timeout (seconds)
                  <input
                     type="number"
                     min={1}
                     max={3600}
                     value={db.timeoutSeconds}
                     onChange={(e) => updateDatabase({ timeoutSeconds: Number(e.target.value) })}
                  />
               </label>
               <label>
                  Maximum dump size (GiB)
                  <input
                     type="number"
                     min={1}
                     max={100}
                     value={db.maxDumpBytes / 1024 ** 3}
                     onChange={(e) => updateDatabase({ maxDumpBytes: Number(e.target.value) * 1024 ** 3 })}
                  />
               </label>
               <label>
                  Database transport
                  <select value={db.tls} onChange={(e) => updateDatabase({ tls: e.target.value as RemoteDatabaseBackup['tls'] })}>
                     <option value="verify-identity">TLS: verify certificate and hostname</option>
                     <option value="local">Loopback-only TCP (localhost / 127.0.0.1 / ::1)</option>
                  </select>
               </label>
               <label>
                  <input type="checkbox" checked={db.includeRoutines} onChange={(e) => updateDatabase({ includeRoutines: e.target.checked })} />{' '}
                  Include routines (extra DB privileges)
               </label>
               <label>
                  <input type="checkbox" checked={db.includeEvents} onChange={(e) => updateDatabase({ includeEvents: e.target.checked })} /> Include
                  events (extra DB privileges)
               </label>
            </div>
         )}
         {db && (
            <p className={classes.fieldNotice}>
               Snapshot path: /pluton/database/{db.dumpFilename}. Single-transaction consistency requires InnoDB and no concurrent schema changes.
               Application files and DB are not an atomic application checkpoint.
            </p>
         )}
         <h3>Lifecycle Hooks</h3>
         <p>
            Optional administrator-deployed executables in /etc/pluton-agent/hooks. No inline shell, sudo, secret arguments, or arbitrary executable
            paths. Hooks run as the agent in its private job workspace.
         </p>
         {(['preHook', 'postHook'] as const).map((key) => (
            <div key={key} className={styles.hook}>
               <label>
                  <input type="checkbox" checked={!!value[key]} onChange={(e) => updateHook(key, e.target.checked ? {} : undefined)} />{' '}
                  {key === 'preHook' ? 'Pre-backup hook (failure blocks backup)' : 'Post-backup hook (always attempted; failures are warnings)'}
               </label>
               {value[key] && (
                  <div className={styles.grid}>
                     <label>
                        Hook identifier
                        <input value={value[key].id} placeholder="prepare-app" onChange={(e) => updateHook(key, { id: e.target.value })} />
                     </label>
                     <label>
                        Fixed non-secret arguments (one per line)
                        <textarea
                           value={value[key].args.join('\n')}
                           onChange={(e) => updateHook(key, { args: e.target.value ? e.target.value.split('\n') : [] })}
                        />
                     </label>
                     <label>
                        Timeout (seconds)
                        <input
                           type="number"
                           min={1}
                           max={300}
                           value={value[key].timeoutSeconds}
                           onChange={(e) => updateHook(key, { timeoutSeconds: Number(e.target.value) })}
                        />
                     </label>
                  </div>
               )}
            </div>
         ))}
         <p>
            Pre and post output is discarded. Post runs after success, failure, or cancellation. Cleanup warnings do not change a completed snapshot
            into a failed backup.
         </p>
      </div>
   );
}
