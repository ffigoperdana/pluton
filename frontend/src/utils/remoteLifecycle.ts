import type { RemoteBackupLifecycle } from '../@types/plans';

/** UX only; server and agent enforce independent, stricter execution boundaries. */
export function remoteLifecycleValidation(value?: RemoteBackupLifecycle): string | undefined {
   if (!value) return;
   const db = value.database;
   if (db) {
      if (!db.host || !db.database || !db.username || (!db.password && !db.passwordConfigured))
         return 'Database host, name, username and password are required.';
      if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(db.database) || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}\.sql$/.test(db.dumpFilename))
         return 'Use a safe database name and a simple .sql filename (no directories).';
      if (db.tls === 'local' && !['localhost', '127.0.0.1', '::1'].includes(db.host))
         return 'Unencrypted database transport is limited to loopback hosts.';
      if (
         !Number.isInteger(db.port) ||
         db.port < 1 ||
         db.port > 65535 ||
         !Number.isInteger(db.timeoutSeconds) ||
         db.timeoutSeconds < 1 ||
         db.timeoutSeconds > 3600 ||
         db.maxDumpBytes < 1024 ||
         db.maxDumpBytes > 100 * 1024 ** 3
      )
         return 'Database port, timeout or dump size limit is invalid.';
   }
   for (const hook of [value.preHook, value.postHook]) {
      if (!hook) continue;
      if (
         !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/.test(hook.id) ||
         hook.timeoutSeconds < 1 ||
         hook.timeoutSeconds > 300 ||
         hook.args.length > 16 ||
         hook.args.some(
            (arg) => !/^[A-Za-z0-9_.,:@/+ =-]{0,128}$/.test(arg) || arg.startsWith('-') || arg.startsWith('/') || arg.split('/').includes('..'),
         )
      )
         return 'Use a deployed hook identifier, safe fixed arguments and a timeout of 1–300 seconds.';
   }
}
