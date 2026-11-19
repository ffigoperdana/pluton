import type { AttachmentCatalogItem, AttachmentCatalogPage } from './attachmentCatalog.ts';

const KNOWN_TYPES: Record<string, string> = {
   'application/pdf': 'PDF',
   'application/msword': 'DOC',
   'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
   'application/vnd.ms-excel': 'XLS',
   'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
   'application/vnd.ms-powerpoint': 'PPT',
   'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
   'application/zip': 'ZIP',
   'application/xml': 'XML',
   'text/plain': 'TXT',
   'text/csv': 'CSV',
   'text/html': 'HTML',
   'image/png': 'PNG',
   'image/jpeg': 'JPEG',
   'image/gif': 'GIF',
   'image/webp': 'WEBP',
   'image/svg+xml': 'SVG',
};

/** A short type label: the known MIME type, else the name's extension, else the MIME subtype. */
export function attachmentTypeLabel(item: Pick<AttachmentCatalogItem, 'mimetype' | 'name'>): string {
   const mime = item.mimetype?.toLowerCase().split(';')[0].trim();
   if (mime && KNOWN_TYPES[mime]) return KNOWN_TYPES[mime];
   const extension = /\.([A-Za-z0-9]{1,8})$/.exec(item.name)?.[1];
   if (extension) return extension.toUpperCase();
   if (mime) return mime.split('/').pop()!.slice(0, 16).toUpperCase();
   return '—';
}

type Progress = Extract<AttachmentCatalogPage, { status: 'indexing' }>['progress'];

export function catalogProgressText(progress: Progress, bytes: (value: number) => string): string {
   switch (progress.phase) {
      case 'waiting':
         return 'Waiting for another attachment list to finish…';
      case 'database-dump': {
         const read = bytes(progress.dumpBytes);
         return `Reading the database dump: ${read}${progress.dumpTotal ? ` of at most ${bytes(progress.dumpTotal)}` : ''} · ${progress.attachments.toLocaleString()} attachments found`;
      }
      case 'filestore-index':
         return `Indexing the filestore snapshot · ${progress.attachments.toLocaleString()} attachments to match`;
      case 'matching':
         return `Matching attachments with the snapshot: ${progress.matched.toLocaleString()} of ${progress.attachments.toLocaleString()}`;
   }
}
