export type ExportFailureDiagnostic = {
   operation: string;
   phase?: string;
   outcome?: string;
   category: string;
   providerCategory: string;
   providerCode?: string;
   responseKind?: string;
   httpStatus?: number;
   attempts?: number;
   elapsedMs?: number;
   phaseElapsedMs?: number;
   wireBytesRead?: number;
   plaintextBytesRead?: number;
   bodyComplete?: boolean;
   abortReason?: string;
};
const operations = [
   'KeyringValidation',
   'ObjectIdentity',
   'HeadObject',
   'GetObject',
   'PlaintextSha256',
   'AnonymousObjectGet',
   'AnonymousListGet',
   'GetBucketVersioning',
   'PutObject',
   'DeleteObject',
   'ListObjectsV2',
   'ListMultipartUploads',
   'ListParts',
   'AbortMultipartUpload',
   'CompleteMultipartUpload',
   'ownership-proof',
   'unknown',
];
/** Fixed categories/counters only; never display arbitrary persisted/provider text. */
export function exportFailureDiagnostic(value: unknown): ExportFailureDiagnostic | undefined {
   if (!value || typeof value !== 'object') return;
   const d = value as Record<string, unknown>;
   const pick = (key: string, allowed: string[], fallback?: string) =>
      typeof d[key] === 'string' && allowed.includes(d[key] as string) ? (d[key] as string) : fallback;
   const n = (key: string, max: number) =>
      Number.isSafeInteger(d[key]) && Number(d[key]) >= 0 && Number(d[key]) <= max ? Number(d[key]) : undefined;
   return {operation: pick('operation', operations, 'unknown')!,
      phase: pick('phase', [
         'keyring-manifest',
         'identity',
         'head',
         'get-headers',
         'ciphertext-body',
         'decrypt',
         'plaintext-body',
         'plaintext-sha256',
         'privacy-object',
         'privacy-list',
      ]),
      outcome: pick('outcome', ['transport', 'provider', 'identity-integrity', 'privacy', 'keyring']),
      category: pick(
         'category',
         ['tls-validation', 'access-denied', 'unsupported-api', 'unexpected-response', 'network-or-deadline', 'cleanup-failed'],
         'unexpected-response',
      )!,
      providerCategory: pick(
         'providerCategory',
         [
            'access-denied',
            'unsupported-api',
            'not-found',
            'precondition-failed',
            'conflict',
            'tls-validation',
            'network',
            'deadline',
            'aborted',
            'invalid-response',
            'service-error',
         ],
         'service-error',
      )!,
      providerCode: pick('providerCode', [
         'AccessDenied',
         'InvalidAccessKeyId',
         'SignatureDoesNotMatch',
         'AuthorizationHeaderMalformed',
         'NotImplemented',
         'MethodNotAllowed',
         'InvalidRequest',
         'InvalidArgument',
         'InvalidObjectState',
         'OperationAborted',
         'SlowDown',
         'InternalError',
         'ServiceUnavailable',
         'PreconditionFailed',
         'unrecognized',
      ]),
      responseKind: pick('responseKind', [
         'invalid-response',
         'embedded-error',
         'sdk-parsing-error',
         'provider-error',
         'transport-error',
         'body-invalid',
         'integrity-error',
         'keyring-error',
      ]),
      httpStatus: Number(d.httpStatus) >= 100 ? n('httpStatus', 599) : undefined,
      attempts: Number(d.attempts) >= 1 ? n('attempts', 100) : undefined,
      elapsedMs: n('elapsedMs', 604800000),
      phaseElapsedMs: n('phaseElapsedMs', 604800000),
      wireBytesRead: n('wireBytesRead', 129 * 1024 ** 3),
      plaintextBytesRead: n('plaintextBytesRead', 128 * 1024 ** 3),
      bodyComplete: d.bodyComplete === true,
      abortReason: pick('abortReason', ['none', 'deadline', 'cancelled']),};
}
