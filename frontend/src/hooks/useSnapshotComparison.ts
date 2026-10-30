import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL } from '../utils/constants';
import { snapshotRequest, type ComparisonStatus } from '../utils/snapshotReview';
export function useSnapshotComparison(backupId: string, enabled: boolean) {
   const client = useQueryClient(),
      key = ['snapshot-comparison', backupId];
   const query = useQuery({
      queryKey: key,
      queryFn: ({ signal }) => snapshotRequest<ComparisonStatus>(API_URL, backupId, 'comparison', signal),
      enabled,
      gcTime: 0,
      staleTime: 30_000,
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: (state) => (state.state.status !== 'error' && state.state.data?.state === 'preparing' ? 2000 : false),
   });
   const action = useMutation({
      mutationFn: (operation: 'start' | 'cancel') =>
         snapshotRequest<ComparisonStatus>(
            API_URL,
            backupId,
            'comparison',
            undefined,
            operation === 'start' ? 'POST' : 'DELETE',
            operation === 'start' ? { retry: true } : {},
         ),
      retry: false,
      onSuccess: (value) => client.setQueryData(key, value),
   });
   return { query, action };
}
