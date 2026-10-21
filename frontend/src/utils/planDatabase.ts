import type { PlanSettings } from '../@types/plans';

/** Configuration only. Never infer dump inclusion or recovery from a plan or job status. */
export function planDatabaseSummary(settings?: Pick<PlanSettings, 'remoteLifecycle'>) {
   const lifecycle = settings?.remoteLifecycle;
   const databases = lifecycle?.version === 2 ? lifecycle.databases || [] : lifecycle?.database ? [lifecycle.database] : [];
   const labels = { mysql: 'MySQL', mariadb: 'MariaDB', postgresql: 'PostgreSQL' };
   const engines = [...new Set(databases.map((database) => labels[database.engine]).filter(Boolean))];
   const count = databases.length;
   return {
      count,
      card: count ? `DB · ${engines.length === 1 ? engines[0] : `${count} configured`}` : '',
      detail: count ? `${engines.join(' + ')} · ${count} configured` : 'Not configured',
   };
}
