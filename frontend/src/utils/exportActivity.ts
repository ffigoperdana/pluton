import type { DownloadMode } from './downloadPreparation';
import { downloadFailure, DownloadFailure } from './downloadFailure';
import { exportJson, reliableActive, reliableRequest, validateReliableJob, type ReliableJob } from './reliableDownload';

export type ReadinessFailure = { operation: string; category: string; providerCategory: string; httpStatus?: number };
export type ExportReadiness = {
   configured: boolean;
   admissionAllowed: boolean;
   preflight: 'GO' | 'NO-GO';
   reason: string;
   sharedNamespaceEnabled?: boolean;
   keyringConfigured?: boolean;
   exportMode?: string;
   expiresAt?: number;
   cleanupPending?: boolean;
   latest?: {
      id: string;
      state: string;
      cleanupPending: boolean;
      expiresAt?: number;
      preflightFailure?: ReadinessFailure;
      cleanupFailure?: ReadinessFailure;
   };
};
export type ExportActivity = { backupId: string; planId: string; job: ReliableJob };
export const readinessMessages: Record<string, string> = {ready: 'A fresh destination-bound preflight GO is recorded. Admission still rechecks all security requirements.',
   'preflight-required': 'Configuration is present, but a successful capability preflight GO is required. No export has been created.',
   'preflight-expired': 'The preflight GO has expired. An operator must explicitly renew it after reviewing diagnostics.',
   'preflight-superseded': 'A newer preflight superseded the previous GO. Review its result and cleanup before authorizing another preflight.',
   'preflight-running': 'An operator preflight is still running. Wait for its verified result and cleanup.',
   'cleanup-pending': 'Preflight cleanup is pending. Review ownership-safe diagnostics and verify cleanup before another preflight.',
   'provider-checks-failed': 'The provider capability checks failed. Review the recorded diagnostics; do not bypass the security gates.',
   'destination-mismatch': 'The recorded preflight does not match the current destination or capability binding. Operator review is required.',
   'not-configured': 'Reliable Download is not enabled or configured. Standard Download remains available.',
   'configuration-invalid': 'Reliable Download configuration could not be verified. Ask the operator to review it.',
   'destination-not-isolated': 'Export destination isolation could not be verified. Operator review is required.',
   'checked-during-export': 'This configuration performs its mandatory capability checks during each export. Static configuration is not a GO.',};
export const activityKey = (backupId: string, mode: DownloadMode) => JSON.stringify([backupId, mode]);
type Snapshot = {
   jobs: ExportActivity[];
   readiness?: ExportReadiness;
   loaded: boolean;
   checking: boolean;
   observedAt: number;
   error?: DownloadFailure;
   pending: string[];
   denials: Record<string, DownloadFailure>;
};
const invalid = () => new DownloadFailure('Activity response could not be verified.', 'protocol', false);
function diagnostic(value: unknown): ReadinessFailure | undefined {
   if (!value || typeof value !== 'object') return;
   const d = value as Record<string, unknown>;
   const operation =
      typeof d.operation === 'string' &&
      [
         'GetBucketVersioning',
         'PutObject',
         'HeadObject',
         'GetObject',
         'GetObjectAcl',
         'CreateMultipartUpload',
         'UploadPart',
         'CompleteMultipartUpload',
         'AbortMultipartUpload',
         'ListParts',
         'ListObjectsV2',
         'ListMultipartUploads',
         'DeleteObject',
         'creation-response',
         'ownership-proof',
         'configuration',
      ].includes(d.operation)
         ? d.operation
         : 'unknown';
   const category =
      typeof d.category === 'string' &&
      ['tls-validation', 'access-denied', 'unsupported-api', 'unexpected-response', 'network-or-deadline', 'cleanup-failed'].includes(d.category)
         ? d.category
         : 'unexpected-response';
   const providerCategory =
      typeof d.providerCategory === 'string' &&
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
         'not-recorded',
      ].includes(d.providerCategory)
         ? d.providerCategory
         : 'service-error';
   return {operation,
      category,
      providerCategory,
      httpStatus: Number.isInteger(d.httpStatus) && Number(d.httpStatus) >= 100 && Number(d.httpStatus) <= 599 ? Number(d.httpStatus) : undefined,};
}
export async function readExportActivity(api: string, signal: AbortSignal) {
   const response = await fetch(api + '/managed-exports/activity', { credentials: 'include', redirect: 'error', signal });
   const body = await exportJson(response, signal, 256 * 1024);
   const value = body.result,
      r = value?.readiness;
   if (
      !Array.isArray(value?.jobs) ||
      value.jobs.length > 64 ||
      !r ||
      typeof r.configured !== 'boolean' ||
      typeof r.admissionAllowed !== 'boolean' ||
      !['GO', 'NO-GO'].includes(r.preflight) ||
      typeof r.reason !== 'string' ||
      (r.expiresAt !== undefined && (!Number.isSafeInteger(r.expiresAt) || r.expiresAt < 0))
   )
      throw invalid();
   const ids = new Set<string>();
   const jobs: ExportActivity[] = value.jobs.map((item: ExportActivity) => {
      if (
         ![item.backupId, item.planId].every((v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)) ||
         !['full', 'regular-files'].includes(item.job?.mode)
      )
         throw invalid();
      const job = validateReliableJob(item.job, item.backupId, item.job.mode);
      if (ids.has(job.id)) throw invalid();
      ids.add(job.id);
      return { backupId: item.backupId, planId: item.planId, job };
   });
   const readiness: ExportReadiness = {configured: r.configured,
      admissionAllowed: r.admissionAllowed,
      preflight: r.preflight,
      reason: Object.prototype.hasOwnProperty.call(readinessMessages, r.reason) ? r.reason : 'configuration-invalid',
      sharedNamespaceEnabled: r.sharedNamespaceEnabled === true,
      keyringConfigured: r.keyringConfigured === true,
      exportMode: r.exportMode === 'application-encrypted-hcp' ? r.exportMode : 'auto',
      expiresAt: r.expiresAt,
      cleanupPending: r.cleanupPending === true,
      latest:
         r.latest && /^[a-f0-9-]{36}$/.test(r.latest.id)
            ? {id: r.latest.id,
                 state: ['queued', 'validating', 'ready', 'failed', 'cancelled', 'expired'].includes(r.latest.state) ? r.latest.state : 'failed',
                 cleanupPending: r.latest.cleanupPending === true,
                 preflightFailure: diagnostic(r.latest.preflightFailure),
                 ...(r.latest.failureSummary && !r.latest.preflightFailure ? {preflightFailure: diagnostic({ ...r.latest.failureSummary, operation: 'unknown', providerCategory: 'not-recorded' }),} : {}),
                 cleanupFailure: diagnostic(r.latest.cleanupFailure),}
            : undefined,};
   return { jobs, readiness };
}

/** One authenticated app lifetime, no persistent client job/proof/credential cache.
 * All discovery is GET. Only an explicit user action may call admit/cancel. */
export class ExportActivityManager {
   private value: Snapshot = { jobs: [], loaded: false, checking: false, pending: [], denials: {}, observedAt: 0 };
   private listeners = new Set<() => void>();
   private timer?: ReturnType<typeof setTimeout>;
   private controller?: AbortController;
   private flight?: Promise<boolean>;
   private actions = new Map<string, AbortController>();
   private active = false;
   private epoch = 0;
   private failures = 0;
   private revision = 0;
   private retryAt = 0;
   private uncertainAdmissions = new Map<string, { until: number; knownIds: Set<string> }>();
   constructor(
      private api: string,
      private notify = () => {},
      private read = readExportActivity,
      private request = reliableRequest,
   ) {}
   snapshot = () => this.value;
   subscribe = (listener: () => void) => {
      this.listeners.add(listener);
      return () => {
         this.listeners.delete(listener);
      };
   };
   private publish(value: Partial<Snapshot>) {
      this.value = { ...this.value, ...value };
      this.listeners.forEach((fn) => fn());
   }
   start() {
      this.active = true;
      void this.refresh();
   }
   stop() {
      this.active = false;
      this.epoch++;
      clearTimeout(this.timer);
      this.controller?.abort();
      this.actions.forEach((c) => c.abort());
      this.actions.clear();
      this.flight = undefined;
      this.retryAt = 0;
      this.failures = 0;
      this.uncertainAdmissions.clear();
      this.publish({ jobs: [], readiness: undefined, loaded: false, error: undefined, pending: [], denials: {}, checking: false });
   }
   private schedule(ms: number) {
      clearTimeout(this.timer);
      if (this.active) this.timer = setTimeout(() => void this.refresh(), Math.min(2147483647, Math.max(1000, ms)));
   }
   /** A tab/focus notification can arrive after a server action while an older
    * GET is still in flight. Discard that response and perform a fresh GET. */
   invalidate = () => {
      this.revision++;
      return this.refresh();
   };
   refresh = (): Promise<boolean> => {
      if (!this.active) return Promise.resolve(false);
      if (this.flight) return this.flight;
      if (Date.now() < this.retryAt) return Promise.resolve(false);
      clearTimeout(this.timer);
      const stop = new AbortController(),
         epoch = this.epoch,
         revision = this.revision;
      this.controller = stop;
      const deadline = setTimeout(() => stop.abort(), 30000);
      this.publish({ checking: true });
      this.flight = (async () => {
         try {
            const result = await this.read(this.api, stop.signal);
            if (!this.active || epoch !== this.epoch) return false;
            if (stop.signal.aborted) throw new DOMException('Status request timed out.', 'TimeoutError');
            if (revision !== this.revision) {
               this.schedule(1000);
               return false;
            }
            this.failures = 0;
            this.retryAt = 0;
            for (const [key, pending] of this.uncertainAdmissions) {
               if (Date.now() >= pending.until || result.jobs.some(item =>
                  activityKey(item.backupId, item.job.mode) === key && !pending.knownIds.has(item.job.id)))
                  this.uncertainAdmissions.delete(key);
            }
            this.publish({ ...result, loaded: true, error: undefined, observedAt: Date.now() });
            if (result.jobs.some(({ job }) => reliableActive(job) || job.cleanupPending)) this.schedule(2000);
            else if (this.uncertainAdmissions.size) this.schedule(2000);
            else {
               // Ready exports need one refresh at expiry, not perpetual terminal polling.
               const expiries = result.jobs
                  .filter(({ job }) => job.state === 'ready' && job.expiresAt! > Date.now())
                  .map(({ job }) => job.expiresAt!);
               if (expiries.length) this.schedule(Math.min(...expiries) - Date.now() + 1000);
            }
            return true;
         } catch (error) {
            if (!this.active || epoch !== this.epoch) return false;
            const failure = downloadFailure(error);
            if (failure.kind === 'authentication' || failure.kind === 'permission') {
               this.revision++;
               this.actions.forEach((c) => c.abort());
               this.actions.clear();
               this.publish({ jobs: [], readiness: undefined, pending: [], denials: {} });
            }
            this.publish({ error: failure });
            if (failure.transient) {
               this.retryAt = Math.max(failure.retryAt, Date.now() + Math.min(30000, 2000 * 2 ** Math.min(this.failures++, 4)));
               this.schedule(this.retryAt - Date.now());
            }
            return false;
         } finally {
            clearTimeout(deadline);
            if (this.active && epoch === this.epoch) {
               this.flight = undefined;
               this.publish({ checking: false });
            }
         }
      })();
      return this.flight;
   };
   find(backupId: string, mode: DownloadMode, id?: string) {
      const matching = this.value.jobs.filter((j) => j.backupId === backupId && j.job.mode === mode);
      return (
         id
            ? matching.find((j) => j.job.id === id)
            : matching.find((j) => reliableActive(j.job) || (j.job.state === 'ready' && j.job.expiresAt! > Date.now())) || matching.at(-1)
      )?.job;
   }
   private async act(key: string, operation: (signal: AbortSignal) => Promise<void>) {
      if (!this.active || this.actions.has(key)) return;
      if ((this.value.denials[key]?.retryAt || 0) > Date.now()) return;
      const stop = new AbortController(),
         epoch = this.epoch;
      this.actions.set(key, stop);
      const denials = { ...this.value.denials };
      delete denials[key];
      this.publish({ pending: [...this.actions.keys()], denials });
      const deadline = setTimeout(() => stop.abort(), 30000);
      try {
         await operation(stop.signal);
      } catch (error) {
         if (this.active && epoch === this.epoch && this.actions.get(key) === stop) {
            const failure = downloadFailure(error);
            if (failure.kind === 'authentication' || failure.kind === 'permission') {
               this.revision++;
               this.publish({ jobs: [], readiness: undefined, error: failure });
            }
            this.publish({ denials: Object.fromEntries([...Object.entries(this.value.denials).filter(([entry]) => entry !== key), [key, failure]].slice(-64)) });
         }
      } finally {
         clearTimeout(deadline);
         if (this.active && epoch === this.epoch && this.actions.get(key) === stop) {
            this.actions.delete(key);
            this.publish({ pending: [...this.actions.keys()] });
            this.notify();
            void this.refresh(); // GET only, even after a lost POST/DELETE response.
         }
      }
   }
   admit(backupId: string, mode: DownloadMode) {
      const key = activityKey(backupId, mode);
      return this.act(key, async (signal) => {
         if (!(await this.refresh()))
            throw this.value.error || new DownloadFailure('Check server activity before preparing an export.', 'protocol', false);
         if (signal.aborted) return;
         const existing = this.find(backupId, mode);
         if (existing && (reliableActive(existing) || (existing.state === 'ready' && existing.expiresAt! > Date.now()))) return;
         if (!this.value.readiness?.admissionAllowed)
            throw new DownloadFailure(
               readinessMessages[this.value.readiness?.reason || 'preflight-required'],
               'policy',
               false,
               409,
               'security-capability-missing',
            );
         const knownIds = new Set(this.value.jobs.map(item => item.job.id));
         let job: ReliableJob;
         try { job = await this.request(this.api, backupId, mode, undefined, false, signal); }
         catch (error) {
            // The server can commit after a lost response and after our first GET.
            // Discovery remains read-only; an uncertain admission is never a job.
            if (this.active && this.actions.get(key)?.signal === signal && downloadFailure(error).kind === 'transport') {
               this.uncertainAdmissions.set(key, { until: Date.now() + 30000, knownIds });
               if (this.uncertainAdmissions.size > 64) this.uncertainAdmissions.delete(this.uncertainAdmissions.keys().next().value!);
            }
            throw error;
         }
         if (signal.aborted) return;
         this.revision++;
         this.publish({ jobs: [...this.value.jobs.filter((j) => j.job.id !== job.id), { backupId, planId: '', job }] });
      });
   }
   cancel(backupId: string, mode: DownloadMode, id: string) {
      return this.act(activityKey(backupId, mode), async (signal) => {
         const job = await this.request(this.api, backupId, mode, id, true, signal);
         if (signal.aborted) return;
         this.revision++;
         this.publish({ jobs: this.value.jobs.map((item) => (item.job.id === id ? { ...item, job } : item)) });
      });
   }
}
