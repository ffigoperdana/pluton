import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
   SourceAccessAccepted,
   SourceAccessPayload,
   SourceAccessView,
   SourceModeSetupPayload,
   SourceAccessHistoryPage,
   SourceAccessHistoryFilter,
} from '../@types/agentSourceAccess';
import { API_URL } from '../utils/constants';
import { ApiResponseError, mutationResponse, parseApiResponse } from '../utils/httpResponse';

const endpoint = (id: string) => `${API_URL}/agent-admin/devices/${encodeURIComponent(id)}/source-access`;

export async function getSourceAccess(id: string): Promise<SourceAccessView> {
   const response = await fetch(endpoint(id), { credentials: 'include', redirect: 'error' });
   const data = await parseApiResponse<{ result: SourceAccessView }>(response);
   return data.result;
}

export function useSourceAccess(id: string, enabled = true) {
   return useQuery({
      queryKey: ['source-access', id],
      queryFn: () => getSourceAccess(id),
      enabled: Boolean(id) && enabled,
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: (query) => {
         const error = query.state.error;
         if (error instanceof ApiResponseError && [401, 403, 404].includes(error.status)) return false;
         if (query.state.fetchFailureCount >= 4) return false;
         return error || query.state.data?.online === false || query.state.data?.supported === false ? 10000 : 3000;
      },
      refetchIntervalInBackground: false,
   });
}

export async function getSourceAccessHistory(
   id: string,
   cursor: string | undefined,
   filter: SourceAccessHistoryFilter,
): Promise<SourceAccessHistoryPage> {
   const query = new URLSearchParams({ limit: '10', ...(cursor ? { cursor } : {}) });
   if (filter.status) query.set('status', filter.status);
   if (filter.kind) query.set('kind', filter.kind);
   const response = await fetch(`${endpoint(id)}/requests?${query}`, { credentials: 'include', redirect: 'error' });
   const data = await parseApiResponse<{ result: SourceAccessHistoryPage }>(response);
   return data.result;
}

export function useSourceAccessHistory(id: string, cursor: string | undefined, filter: SourceAccessHistoryFilter, enabled: boolean) {
   return useQuery({
      queryKey: ['source-access', id, 'history', cursor ?? 'latest', filter],
      queryFn: () => getSourceAccessHistory(id, cursor, filter),
      enabled: Boolean(id) && enabled,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
   });
}

export async function submitSourceAccess(id: string, kind: 'validate' | 'requests', payload: SourceAccessPayload): Promise<SourceAccessAccepted> {
   const data = await mutationResponse<{ result: SourceAccessAccepted }>(`${endpoint(id)}/${kind}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
   });
   return data.result;
}

export function useSourceAccessMutation(id: string, kind: 'validate' | 'requests') {
   const queryClient = useQueryClient();
   return useMutation({
      mutationFn: (payload: SourceAccessPayload) => submitSourceAccess(id, kind, payload),
      retry: false,
      onSuccess: () => {
         queryClient.invalidateQueries({ queryKey: ['source-access', id] });
         queryClient.invalidateQueries({ queryKey: ['device', id] });
      },
   });
}

export function useRefreshSourceAccess(id: string) {
   const queryClient = useQueryClient();
   return useMutation({
      retry: false,
      mutationFn: () => mutationResponse(`${endpoint(id)}/refresh`, { method: 'POST', credentials: 'include' }),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['source-access', id] }),
   });
}

export function useCancelSourceAccess(id: string) {
   const queryClient = useQueryClient();
   return useMutation({
      retry: false,
      mutationFn: (requestId: string) =>
         mutationResponse(`${endpoint(id)}/requests/${encodeURIComponent(requestId)}/cancel`, { method: 'POST', credentials: 'include' }),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['source-access', id] }),
   });
}

export function useSourceModeSetup(id: string) {
   const queryClient = useQueryClient();
   return useMutation({
      retry: false,
      mutationFn: async (payload: SourceModeSetupPayload) => {
         const data = await mutationResponse<{ result: SourceAccessAccepted }>(`${endpoint(id)}/mode-setup`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload),
         });
         return data.result;
      },
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['source-access', id] }),
   });
}
