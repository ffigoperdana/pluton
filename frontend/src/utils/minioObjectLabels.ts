import type { MinioDataDirectory, MinioObjectItem, MinioProgress, MinioStatus } from './minioObjects.ts';

const STATUS_LABELS: Record<MinioStatus, string> = {
   supported: 'Available',
   'delete-marker': 'Deleted',
   directory: 'Folder object',
   'legacy-version': 'Legacy version',
   encrypted: 'Encrypted (SSE)',
   transitioned: 'Remote tier',
   'erasure-multi-drive': 'Multi-drive',
   'unknown-layout': 'Unknown layout',
   'unknown-compression': 'Unknown compression',
   'etag-unverifiable': 'Unverifiable',
   'metadata-invalid': 'Damaged metadata',
   'metadata-too-large': 'Metadata too large',
   'legacy-format': 'xl.json format',
};

export function minioStatusLabel(item: Pick<MinioObjectItem, 'status'>): string {
   return STATUS_LABELS[item.status];
}

/** A short description of how an available version is stored. */
export function minioStorageLabel(item: Pick<MinioObjectItem, 'status' | 'inline' | 'compressed' | 'parts'>): string {
   if (item.status !== 'supported') return '';
   const parts = [item.inline ? 'inline' : item.parts > 1 ? `${item.parts} parts` : 'single part'];
   if (item.compressed) parts.push('S2');
   return parts.join(' · ');
}

export function minioProgressText(progress: MinioProgress, bytes: (value: number) => string): string {
   switch (progress.phase) {
      case 'snapshot-index':
         return `Indexing the snapshot · ${progress.indexedEntries.toLocaleString()} entries so far`;
      case 'waiting':
         return 'Waiting for another bucket list to finish…';
      case 'metadata-restore':
         return `Restoring the object metadata: ${progress.metadataFiles.toLocaleString()} xl.meta files (${bytes(progress.metadataBytes)})`;
      case 'parsing':
         return `Reading object metadata: ${progress.parsed.toLocaleString()} of ${progress.metadataFiles.toLocaleString()}`;
   }
}

/** Why a data folder cannot be browsed, or null when it can. */
export function minioDataDirectoryProblem(dataDir: Pick<MinioDataDirectory, 'format' | 'drives' | 'supported'>): string | null {
   if (dataDir.supported) return null;
   if (dataDir.format === 'xl')
      return `This MinIO deployment spreads objects over ${dataDir.drives || 'several'} drives (erasure coding). Restore every drive and read the objects with MinIO.`;
   if (dataDir.format === 'fs') return 'This data folder uses the MinIO FS mode, which stores objects as ordinary files. Use the Files view.';
   return 'The format of this MinIO data folder is unknown.';
}
