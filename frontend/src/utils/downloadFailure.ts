export type DownloadFailureKind = 'authentication' | 'permission' | 'policy' | 'rate-limit' | 'transport' | 'protocol';
export class DownloadFailure extends Error {
   readonly kind: DownloadFailureKind;
   readonly transient: boolean;
   readonly status?: number;
   readonly reason?: string;
   readonly retryAt: number;
   constructor(message: string, kind: DownloadFailureKind, transient: boolean, status?: number, reason?: string, retryAt = 0) {
      super(message);
      this.kind = kind;
      this.transient = transient;
      this.status = status;
      this.reason = reason;
      this.retryAt = retryAt;
   }
}
export function retryAfter(response: Response, now = Date.now()) {
   const value = response.headers.get('Retry-After');
   if (!value) return 0;
   const at = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
   return Number.isFinite(at) ? Math.max(now, Math.min(now + 86400000, at)) : 0;
}
export function responseFailure(response: Response, reason?: string, message?: string) {
   const status = response.status,
      retryAt = retryAfter(response);
   if (status === 401)
      return new DownloadFailure('Your session has expired. Sign in again to recover your server exports.', 'authentication', false, status);
   if (status === 403)
      return new DownloadFailure('Access denied (HTTP 403). Check session permissions or the access gateway.', 'permission', false, status);
   if (reason) return new DownloadFailure(message || 'Reliable Download was refused by server policy.', 'policy', false, status, reason, retryAt);
   if (status === 429)
      return new DownloadFailure('Too many requests (HTTP 429). Wait before checking status again.', 'rate-limit', true, status, undefined, retryAt);
   const transient = [408, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(status);
   return new DownloadFailure(
      status === 405
         ? 'Request method rejected (HTTP 405). Check the application route or access gateway.'
         : `Download service response unavailable or invalid (HTTP ${status}).`,
      transient ? 'transport' : 'protocol',
      transient,
      status,
      undefined,
      retryAt,
   );
}
export function downloadFailure(error: unknown): DownloadFailure {
   if (error instanceof DownloadFailure) return error;
   if (error instanceof TypeError || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)))
      return new DownloadFailure('Connection interrupted or status request timed out.', 'transport', true);
   return new DownloadFailure('The server response could not be verified. Check status before taking another action.', 'protocol', false);
}
