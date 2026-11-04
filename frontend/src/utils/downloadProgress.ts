import type { ReliableJob } from './reliableDownload';

export function downloadBytes(value: number) {
   if (!Number.isFinite(value) || value < 0) return 'Unavailable';
   const gib = value >= 1024 ** 3;
   return `${(value / 1024 ** (gib ? 3 : 2)).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${gib ? 'GiB' : 'MiB'}`;
}
export function downloadDuration(ms: number) {
   if (!Number.isFinite(ms) || ms < 0) return 'Unavailable';
   const seconds = Math.floor(ms / 1000);
   return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
export function uploadPercent(job?: ReliableJob) {
   if (
      !job ||
      !Number.isFinite(job.totalBytes) ||
      !job.totalBytes ||
      job.totalBytes < 1 ||
      !Number.isFinite(job.uploadedBytes) ||
      job.uploadedBytes < 0
   )
      return undefined;
   if (job.state === 'ready' && job.integrity === 'verified') return 100;
   return Math.max(0, Math.min(99, Math.floor((job.uploadedBytes * 100) / job.totalBytes)));
}
export function downloadStep(job?: ReliableJob) {
   if (job?.state === 'ready' && job.integrity === 'verified') return 4;
   if (job?.state === 'verifying' || job?.performance?.phase === 'publication' || job?.performance?.phase === 'verification') return 3;
   if (job?.state === 'uploading') return 2;
   if (job?.state === 'exporting' || job?.performance?.phase === 'archive-validation') return 1;
   return 0;
}
