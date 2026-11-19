import type { Plan, RemoteDatabaseBackup } from '../@types/plans';

/** PostgreSQL database entries (with an ID) of a plan's database backup settings. */
export function catalogDatabaseOptions(plan: Pick<Plan, 'settings'>): (RemoteDatabaseBackup & { databaseId: string })[] {
   const lifecycle = plan.settings?.remoteLifecycle;
   const entries = lifecycle ? (lifecycle.version === 2 ? lifecycle.databases || [] : lifecycle.database ? [lifecycle.database] : []) : [];
   return entries.filter((entry): entry is RemoteDatabaseBackup & { databaseId: string } => entry.engine === 'postgresql' && !!entry.databaseId);
}

/** Managed Agent backup plans other than this one that dump a PostgreSQL database. */
export function catalogPlanOptions(plans: Plan[], currentPlanId?: string): Plan[] {
   return plans.filter(
      (plan) =>
         plan.id !== currentPlanId &&
         plan.sourceType === 'device' &&
         plan.sourceId !== 'main' &&
         plan.method === 'backup' &&
         catalogDatabaseOptions(plan).length > 0,
   );
}
