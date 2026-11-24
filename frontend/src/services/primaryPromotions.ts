import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL } from '../utils/constants';
import { mutationResponse, parseApiResponse } from '../utils/httpResponse';
import { promotionPolling } from '../utils/primaryPromotion';
import type { PrimaryPromotion, PrimaryPromotionOverview } from '../@types/primaryPromotions';

async function request<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
   const options: RequestInit = {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
   };
   const url = `${API_URL}/plan-promotions${route}`;
   const data =
      method === 'GET' ? await parseApiResponse<{ result: T }>(await fetch(url, options)) : await mutationResponse<{ result: T }>(url, options);
   return data.result;
}

export function usePrimaryPromotions(planId: string, enabled = true) {
   return useQuery({
      queryKey: ['primaryPromotions', planId],
      queryFn: () => request<PrimaryPromotionOverview>(`?planId=${encodeURIComponent(planId)}`),
      enabled: enabled && !!planId,
      retry: false,
      refetchInterval: (query) => (query.state.error ? false : promotionPolling(query.state.data)),
   });
}

export type PromotionActionInput = { action: 'start'; replicationId: string } | { action: 'cancel'; id: string };

export function usePrimaryPromotionAction(planId: string) {
   const queries = useQueryClient();
   return useMutation({
      retry: false,
      mutationFn: (input: PromotionActionInput) =>
         input.action === 'start'
            ? request<PrimaryPromotion>('', 'POST', { planId, replicationId: input.replicationId })
            : request<PrimaryPromotion>(`/${encodeURIComponent(input.id)}/cancel`, 'POST'),
      onSettled: () => queries.invalidateQueries({ queryKey: ['primaryPromotions', planId] }),
   });
}
