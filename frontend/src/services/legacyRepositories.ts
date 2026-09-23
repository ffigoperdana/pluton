import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL } from '../utils/constants';
import type {
   LegacyRepository,
   LegacyRepositoryRegistration,
   LegacyRepositorySnapshot,
   LegacyRepositorySnapshotFilters,
   LegacyRepositoryStats,
} from '../@types/legacyRepositories';

type ApiResponse<T> = {
   success: boolean;
   result: T;
   error?: string;
   message?: string;
};

async function request<T>(path: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
   const response = await fetch(`${API_URL}/legacy-repositories${path}`, {
      credentials: 'include',
      ...options,
   });
   const data = (await response.json()) as ApiResponse<T>;
   if (!data.success) {
      throw new Error(data.error || 'Legacy repository request failed.');
   }
   return data;
}

export function getLegacyRepositories() {
   return request<LegacyRepository[]>('');
}

export function useLegacyRepositories() {
   return useQuery({
      queryKey: ['legacy-repositories'],
      queryFn: getLegacyRepositories,
      retry: false,
   });
}

export function getLegacyRepository(id: string) {
   return request<LegacyRepository>(`/${encodeURIComponent(id)}`);
}

export function useLegacyRepository(id?: string) {
   return useQuery({
      queryKey: ['legacy-repositories', id],
      queryFn: () => getLegacyRepository(id as string),
      enabled: Boolean(id),
      retry: false,
   });
}

export function getLegacyRepositorySnapshots(id: string, filters: LegacyRepositorySnapshotFilters = {}) {
   const query = new URLSearchParams();
   if (filters.tag) query.set('tag', filters.tag);
   if (filters.path) query.set('path', filters.path);
   if (filters.host) query.set('host', filters.host);
   const suffix = query.toString();
   return request<LegacyRepositorySnapshot[]>(`/${encodeURIComponent(id)}/snapshots${suffix ? `?${suffix}` : ''}`);
}

export function useLegacyRepositorySnapshots(id?: string, filters: LegacyRepositorySnapshotFilters = {}) {
   return useQuery({
      queryKey: ['legacy-repositories', id, 'snapshots', filters],
      queryFn: () => getLegacyRepositorySnapshots(id as string, filters),
      enabled: Boolean(id),
      retry: false,
   });
}

export function getLegacyRepositoryStats(id: string) {
   return request<LegacyRepositoryStats>(`/${encodeURIComponent(id)}/stats`);
}

export function useLegacyRepositoryStats(id?: string) {
   return useQuery({
      queryKey: ['legacy-repositories', id, 'stats'],
      queryFn: () => getLegacyRepositoryStats(id as string),
      enabled: Boolean(id),
      retry: false,
   });
}

export function useRegisterLegacyRepository() {
   const queryClient = useQueryClient();
   return useMutation({
      mutationFn: (registration: LegacyRepositoryRegistration) =>
         request<LegacyRepository>('', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(registration),
         }),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['legacy-repositories'] }),
   });
}

export function useValidateLegacyRepository() {
   const queryClient = useQueryClient();
   return useMutation({
      mutationFn: (id: string) =>
         request<{ validationStatus: LegacyRepository['validationStatus']; lastValidatedAt: string }>(
            `/${encodeURIComponent(id)}/validate`,
            { method: 'POST', headers: { Accept: 'application/json' } }
         ),
      onSuccess: async (_result, id) => {
         await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['legacy-repositories'] }),
            queryClient.invalidateQueries({ queryKey: ['legacy-repositories', id] }),
         ]);
      },
   });
}

export function useDeleteLegacyRepository() {
   const queryClient = useQueryClient();
   return useMutation({
      mutationFn: (id: string) =>
         request<void>(`/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: { Accept: 'application/json' },
         }),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['legacy-repositories'] }),
   });
}
