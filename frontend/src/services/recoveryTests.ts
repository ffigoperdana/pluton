import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL } from '../utils/constants';
import type { RecoveryPolicy, RecoveryTarget, RecoveryTest } from '../@types/recoveryTests';
async function request<T>(planId: string, route: string, method = 'GET', body?: unknown): Promise<T> {
   const res = await fetch(`${API_URL}/recovery-testing/${encodeURIComponent(planId)}/${route}`, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
   });
   const data = await res.json();
   if (!res.ok || !data.success) throw new Error(data.error || 'Recovery testing request failed.');
   return data.result;
}
export function useRecoveryTests(planId: string, enabled = true, displayedBackups: string[] = []) {
   const backupIds = [...new Set(displayedBackups)].slice(0, 999).sort();
   return useQuery({
      queryKey: ['recoveryTests', planId, backupIds.join(',')],
      queryFn: () =>
         backupIds.length ? request<RecoveryTest[]>(planId, 'tests/lookup', 'POST', { backupIds }) : request<RecoveryTest[]>(planId, 'tests'),
      enabled: enabled && !!planId,
      retry: false,
      refetchInterval: 5000,
   });
}
export function useRecoveryConfiguration(planId?: string) {
   return useQuery({
      queryKey: ['recoveryConfiguration', planId],
      queryFn: () => request<{ policy: RecoveryPolicy; targets: RecoveryTarget[] }>(planId!, 'configuration'),
      enabled: !!planId,
      retry: false,
   });
}
export function useRecoveryAction(planId: string) {
   const queries = useQueryClient();
   return useMutation({
      mutationFn: ({ backupId, cancelId }: { backupId?: string; cancelId?: string }) =>
         cancelId
            ? request<RecoveryTest>(planId, `tests/${encodeURIComponent(cancelId)}/cancel`, 'POST')
            : request<RecoveryTest>(planId, 'tests', 'POST', { backupId }),
      onSuccess: () => queries.invalidateQueries({ queryKey: ['recoveryTests', planId] }),
   });
}
export function useSaveRecoveryPolicy(planId: string) {
   const queries = useQueryClient();
   return useMutation({
      mutationFn: (policy: RecoveryPolicy) => request(planId, 'policy', 'PUT', policy),
      onSuccess: () => queries.invalidateQueries({ queryKey: ['recoveryConfiguration', planId] }),
   });
}
export function useSaveRecoveryTarget(planId: string) {
   const queries = useQueryClient();
   return useMutation({
      mutationFn: (target: Omit<RecoveryTarget, 'passwordConfigured'> & { password?: string }) => request(planId, 'target', 'PUT', target),
      onSuccess: () => queries.invalidateQueries({ queryKey: ['recoveryConfiguration', planId] }),
   });
}
