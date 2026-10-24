import { useQuery } from '@tanstack/react-query';
import { API_URL } from '../utils/constants';
import { mutationResponse, parseApiResponse } from '../utils/httpResponse';
import type { McpGrant } from '../utils/mcp';

export type McpPage<T> = { items: T[]; hasMore: boolean; limit: number; offset: number };
export type McpOverview = {
   enabled: boolean;
   disabledTools: string[];
   endpoint: string | null;
   configured: boolean;
   health: string;
   configuredClients: number;
   recentlyActive: number | null;
   protocols: string[];
   transport: string;
   pendingApprovals: number;
   scopes: string[];
   nativeTokensEnabled: boolean;
   oauthEnabled: boolean;
};
export type McpTool = {
   name: string;
   description: string;
   scope: string;
   enabled: boolean;
   classification: string;
   approvalRequired: boolean;
   implicit?: boolean;
};
export type McpActivity = {
   id: number;
   timestamp: number;
   principal: string;
   clientId: string | null;
   operation: string;
   target: string | null;
   outcome: string;
   durationMs: number | null;
   traceId: string;
};
export async function mcpRequest<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
   const url = `${API_URL}/mcp-admin/${route}`;
   const options: RequestInit = {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
   };
   const value =
      method === 'GET' ? await parseApiResponse<{ result: T }>(await fetch(url, options)) : await mutationResponse<{ result: T }>(url, options);
   return value.result;
}
export function useMcpOverview() {
   return useQuery({ queryKey: ['mcp', 'overview'], queryFn: () => mcpRequest<McpOverview>('overview'), retry: false });
}
export function useMcpTools() {
   return useQuery({ queryKey: ['mcp', 'tools'], queryFn: () => mcpRequest<McpTool[]>('tools'), retry: false });
}
export function useMcpClients(offset: number) {
   return useQuery({
      queryKey: ['mcp', 'clients', offset],
      queryFn: () => mcpRequest<McpPage<McpGrant>>(`clients?limit=20&offset=${offset}`),
      retry: false,
   });
}
export function useMcpActivity(offset: number, clientId: string, outcome: string) {
   const query = new URLSearchParams({ limit: '20', offset: String(offset), ...(clientId ? { clientId } : {}), ...(outcome ? { outcome } : {}) });
   return useQuery({
      queryKey: ['mcp', 'activity', offset, clientId, outcome],
      queryFn: () => mcpRequest<McpPage<McpActivity>>(`activity?${query}`),
      retry: false,
   });
}
