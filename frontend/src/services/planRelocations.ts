import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL } from '../utils/constants';
import { mutationResponse, parseApiResponse } from '../utils/httpResponse';
import { relocationPolling } from '../utils/planRelocation';
import type { PlanRelocation, PlanRelocationOverview } from '../@types/planRelocations';

async function request<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
   const options: RequestInit = {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
   };
   const url = `${API_URL}/plan-relocations${route}`;
   const data =
      method === 'GET'
         ? await parseApiResponse<{ result: T }>(await fetch(url, options))
         : await mutationResponse<{ result: T }>(url, options);
   return data.result;
}

export function usePlanRelocations(planId: string, enabled = true) {
   return useQuery({
      queryKey: ['planRelocations', planId],
      queryFn: () => request<PlanRelocationOverview>(`?planId=${encodeURIComponent(planId)}`),
      enabled: enabled && !!planId,
      retry: false,
      refetchInterval: (query) => (query.state.error ? false : relocationPolling(query.state.data)),
   });
}

export type RelocationActionInput =
   | { action: 'start'; storageId: string; storagePath: string }
   | { action: 'cancel' | 'switch' | 'revert'; id: string }
   | { action: 'delete-source'; id: string; confirmTitle: string };

export function usePlanRelocationAction(planId: string) {
   const queries = useQueryClient();
   return useMutation({
      retry: false,
      mutationFn: (input: RelocationActionInput) => {
         if (input.action === 'start')
            return request<PlanRelocation>('', 'POST', {
               planId,
               storageId: input.storageId,
               storagePath: input.storagePath,
            });
         const target = `/${encodeURIComponent(input.id)}`;
         if (input.action === 'delete-source')
            return request<PlanRelocation>(`${target}/source-copy`, 'DELETE', { confirmTitle: input.confirmTitle });
         return request<PlanRelocation>(`${target}/${input.action}`, 'POST');
      },
      onSettled: () => queries.invalidateQueries({ queryKey: ['planRelocations', planId] }),
   });
}
