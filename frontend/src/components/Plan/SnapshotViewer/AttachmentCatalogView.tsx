import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Icon from '../../common/Icon/Icon';
import { API_URL } from '../../../utils/constants';
import { formatBytes } from '../../../utils/helpers';
import {
   AttachmentCatalogError,
   downloadCatalogAttachment,
   fetchAttachmentCatalog,
   type AttachmentCatalogItem,
   type AttachmentCatalogPage,
   type AttachmentCatalogQuery,
} from '../../../utils/attachmentCatalog';
import { attachmentTypeLabel, catalogProgressText } from '../../../utils/attachmentCatalogLabels';
import classes from './AttachmentCatalogView.module.scss';
import review from './SnapshotReview.module.scss';

const PAGE_SIZE = 50;

export default function AttachmentCatalogView({ backupId }: { backupId: string }) {
   const [search, setSearch] = useState('');
   const [debounced, setDebounced] = useState('');
   const [model, setModel] = useState('');
   const [status, setStatus] = useState<AttachmentCatalogQuery['status']>('all');
   const [sort, setSort] = useState<AttachmentCatalogQuery['sort']>('name');
   const [order, setOrder] = useState<AttachmentCatalogQuery['order']>('asc');
   const [offset, setOffset] = useState(0);
   // Sent with exactly one request after Retry: polls must never restart a failed build.
   const retryNext = useRef(false);
   const [downloading, setDownloading] = useState<number | null>(null);
   const [downloadError, setDownloadError] = useState('');

   useEffect(() => {
      const timer = setTimeout(() => setDebounced(search.trim()), 300);
      return () => clearTimeout(timer);
   }, [search]);
   useEffect(() => setOffset(0), [debounced, model, status, sort, order]);

   const query: AttachmentCatalogQuery = {
      search: debounced || undefined,
      model: model || undefined,
      status,
      sort,
      order,
      offset,
      limit: PAGE_SIZE,
   };
   const catalog = useQuery<AttachmentCatalogPage, Error>({
      queryKey: ['attachment-catalog', backupId, query],
      queryFn: ({ signal }) => {
         const retry = retryNext.current;
         retryNext.current = false;
         return fetchAttachmentCatalog(API_URL, backupId, { ...query, retry }, signal);
      },
      retry: false,
      gcTime: 0,
      refetchOnWindowFocus: false,
      refetchInterval: (state) => (state.state.data?.status === 'indexing' ? state.state.data.retryAfterMs : false),
   });
   const page = catalog.data;

   const toggleSort = (column: NonNullable<AttachmentCatalogQuery['sort']>) => {
      if (sort === column) setOrder(order === 'asc' ? 'desc' : 'asc');
      else {
         setSort(column);
         setOrder(column === 'name' ? 'asc' : 'desc');
      }
   };
   const download = async (item: AttachmentCatalogItem) => {
      setDownloadError('');
      setDownloading(item.id);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35_000);
      try {
         await downloadCatalogAttachment(API_URL, backupId, item, controller.signal);
      } catch (error) {
         setDownloadError(error instanceof Error && error.message ? error.message : 'Attachment download failed.');
      } finally {
         clearTimeout(timer);
         setDownloading(null);
      }
   };

   if (catalog.error) {
      const failure = catalog.error instanceof AttachmentCatalogError ? catalog.error : undefined;
      return (
         <div className={classes.view}>
            <div className={classes.state} role="alert">
               <span>{failure?.message || 'The attachment list is unavailable.'}</span>
               {(!failure || failure.status >= 409) && (
                  <button
                     type="button"
                     className={review.secondaryButton}
                     onClick={() => {
                        retryNext.current = true;
                        void catalog.refetch();
                     }}
                  >
                     Retry
                  </button>
               )}
            </div>
         </div>
      );
   }
   if (!page || page.status === 'indexing') {
      return (
         <div className={classes.view}>
            <div className={classes.state} aria-live="polite">
               <Icon type="loading" size={20} />
               <span>{page ? catalogProgressText(page.progress, formatBytes) : 'Preparing the attachment list…'}</span>
               {page && (
                  <span>
                     Names come from {page.pairing.database} in {page.pairing.databasePlanName || 'the database plan'} (backup{' '}
                     {page.pairing.databaseBackupCompleted ? new Date(page.pairing.databaseBackupCompleted).toLocaleString() : page.pairing.databaseBackupId}).
                  </span>
               )}
            </div>
         </div>
      );
   }

   const arrow = (column: string) => (sort === column ? (order === 'asc' ? ' ↑' : ' ↓') : '');
   return (
      <div className={classes.view}>
         <div className={classes.toolbar}>
            <input type="search" aria-label="Search attachment names" placeholder="Faktur_Januari" value={search} onChange={(event) => setSearch(event.target.value)} />
            <select aria-label="Filter by model" value={model} onChange={(event) => setModel(event.target.value)}>
               <option value="">All models</option>
               {page.models.map((entry) => (
                  <option key={entry.model} value={entry.model}>
                     {entry.model} ({entry.count.toLocaleString()})
                  </option>
               ))}
            </select>
            <select aria-label="Filter by snapshot status" value={status} onChange={(event) => setStatus(event.target.value as AttachmentCatalogQuery['status'])}>
               <option value="all">All attachments</option>
               <option value="present">In this snapshot</option>
               <option value="missing">Missing from this snapshot</option>
            </select>
         </div>
         <div className={classes.meta}>
            <span>
               Names from <strong>{page.pairing.database}</strong> · {page.pairing.databasePlanName || 'database plan'} ·{' '}
               {page.pairing.databaseBackupCompleted ? new Date(page.pairing.databaseBackupCompleted).toLocaleString() : page.pairing.databaseBackupId}
            </span>
            <span>
               {page.counts.attachments.toLocaleString()} attachments · {page.counts.present.toLocaleString()} in this snapshot ·{' '}
               <span className={page.counts.missing ? classes.missingCount : undefined}>{page.counts.missing.toLocaleString()} missing</span>
            </span>
         </div>
         {downloadError && (
            <p role="alert" className={`${review.alert} ${review.inset}`}>
               {downloadError}
            </p>
         )}
         <div className={classes.tableWrap}>
            {page.items.length === 0 ? (
               <div className={classes.state}>No attachment matches these filters.</div>
            ) : (
               <table className={classes.table}>
                  <colgroup>
                     <col style={{ width: '36%' }} />
                     <col style={{ width: '10%' }} />
                     <col style={{ width: '10%' }} />
                     <col style={{ width: '20%' }} />
                     <col style={{ width: '12%' }} />
                     <col style={{ width: '8%' }} />
                     <col style={{ width: '4%' }} />
                  </colgroup>
                  <thead>
                     <tr>
                        <th onClick={() => toggleSort('name')}>Original name{arrow('name')}</th>
                        <th>Type</th>
                        <th onClick={() => toggleSort('size')}>Size{arrow('size')}</th>
                        <th>Record</th>
                        <th onClick={() => toggleSort('created')}>Created (UTC){arrow('created')}</th>
                        <th>Status</th>
                        <th aria-label="Download" />
                     </tr>
                  </thead>
                  <tbody>
                     {page.items.map((item) => (
                        <tr key={item.id}>
                           <td>
                              <span className={classes.name}>{item.name}</span>
                              <code className={classes.stored}>{item.storedPath}</code>
                           </td>
                           <td>{attachmentTypeLabel(item)}</td>
                           <td>{item.size === null ? '—' : formatBytes(item.size)}</td>
                           <td>
                              {item.model ? `${item.model}${item.recordId !== null ? ` #${item.recordId}` : ''}` : '—'}
                              {item.field && <code className={classes.stored}>{item.field}</code>}
                           </td>
                           <td>{item.created || '—'}</td>
                           <td className={item.present ? classes.present : classes.absent}>{item.present ? 'In snapshot' : 'Missing'}</td>
                           <td>
                              <button
                                 type="button"
                                 className={classes.iconButton}
                                 aria-label={`Download ${item.name}`}
                                 title={item.present ? 'Download with the original name' : 'Not in this snapshot'}
                                 disabled={!item.present || downloading !== null}
                                 onClick={() => void download(item)}
                              >
                                 <Icon type={downloading === item.id ? 'loading' : 'download'} size={14} />
                              </button>
                           </td>
                        </tr>
                     ))}
                  </tbody>
               </table>
            )}
         </div>
         <div className={classes.pager}>
            <span>
               {page.total === 0 ? '0' : `${(page.offset + 1).toLocaleString()}–${(page.offset + page.items.length).toLocaleString()}`} of{' '}
               {page.total.toLocaleString()}
            </span>
            <button type="button" className={review.secondaryButton} disabled={page.offset === 0} onClick={() => setOffset(Math.max(0, page.offset - PAGE_SIZE))}>
               Previous
            </button>
            <button type="button" className={review.secondaryButton} disabled={page.nextOffset === null} onClick={() => page.nextOffset !== null && setOffset(page.nextOffset)}>
               Next
            </button>
         </div>
      </div>
   );
}
