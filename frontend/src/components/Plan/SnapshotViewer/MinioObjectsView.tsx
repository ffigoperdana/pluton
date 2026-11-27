import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import Icon from '../../common/Icon/Icon';
import { API_URL } from '../../../utils/constants';
import { formatBytes } from '../../../utils/helpers';
import {
   MinioObjectError,
   downloadMinioObject,
   fetchMinioObjects,
   nameBelow,
   prefixCrumbs,
   type MinioDataDirectory,
   type MinioObjectItem,
   type MinioObjectPage,
   type MinioObjectQuery,
} from '../../../utils/minioObjects';
import { minioDataDirectoryProblem, minioProgressText, minioStatusLabel, minioStorageLabel } from '../../../utils/minioObjectLabels';
import catalog from './AttachmentCatalogView.module.scss';
import classes from './MinioObjectsView.module.scss';
import review from './SnapshotReview.module.scss';

const PAGE_SIZE = 100;

export default function MinioObjectsView({ backupId, dataDirs }: { backupId: string; dataDirs: MinioDataDirectory[] }) {
   const [dataDirPath, setDataDirPath] = useState(dataDirs[0]?.path || '');
   const dataDir = dataDirs.find((value) => value.path === dataDirPath) || dataDirs[0];
   const [bucket, setBucket] = useState(dataDir?.buckets[0]?.name || '');
   const [prefix, setPrefix] = useState('');
   const [search, setSearch] = useState('');
   const [debounced, setDebounced] = useState('');
   const [versions, setVersions] = useState<'latest' | 'all'>('latest');
   const [sort, setSort] = useState<NonNullable<MinioObjectQuery['sort']>>('key');
   const [order, setOrder] = useState<NonNullable<MinioObjectQuery['order']>>('asc');
   const [offset, setOffset] = useState(0);
   // Sent with exactly one request after Retry: polls must never restart a failed build.
   const retryNext = useRef(false);
   const [downloading, setDownloading] = useState<number | null>(null);
   const [downloadError, setDownloadError] = useState('');

   useEffect(() => {
      const timer = setTimeout(() => setDebounced(search.trim()), 300);
      return () => clearTimeout(timer);
   }, [search]);
   useEffect(() => setOffset(0), [debounced, versions, sort, order, prefix, bucket, dataDirPath]);

   const problem = dataDir ? minioDataDirectoryProblem(dataDir) : 'No MinIO data folder.';
   const query: MinioObjectQuery = {
      dataDir: dataDir?.path || '',
      bucket,
      prefix: prefix || undefined,
      search: debounced || undefined,
      versions,
      sort,
      order,
      offset,
      limit: PAGE_SIZE,
   };
   const objects = useQuery<MinioObjectPage, Error>({
      // The retry flag rides on exactly one request, so it is deliberately not part of the key.
      // eslint-disable-next-line @tanstack/query/exhaustive-deps
      queryKey: ['minio-objects', backupId, query],
      queryFn: ({ signal }) => {
         const retry = retryNext.current;
         retryNext.current = false;
         return fetchMinioObjects(API_URL, backupId, { ...query, retry }, signal);
      },
      enabled: !problem && !!bucket,
      retry: false,
      gcTime: 0,
      refetchOnWindowFocus: false,
      refetchInterval: (state) => (state.state.data?.status === 'indexing' ? state.state.data.retryAfterMs : false),
   });
   const page = objects.data;

   const toggleSort = (column: NonNullable<MinioObjectQuery['sort']>) => {
      if (sort === column) setOrder(order === 'asc' ? 'desc' : 'asc');
      else {
         setSort(column);
         setOrder(column === 'key' ? 'asc' : 'desc');
      }
   };
   const download = async (item: MinioObjectItem) => {
      setDownloadError('');
      setDownloading(item.id);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35_000);
      try {
         await downloadMinioObject(API_URL, backupId, { dataDir: query.dataDir, bucket }, item, controller.signal);
      } catch (error) {
         setDownloadError(error instanceof Error && error.message ? error.message : 'Object download failed.');
      } finally {
         clearTimeout(timer);
         setDownloading(null);
      }
   };

   const toolbar = (
      <div className={catalog.toolbar}>
         {dataDirs.length > 1 && (
            <select
               aria-label="MinIO data folder"
               value={dataDir?.path}
               onChange={(event) => {
                  setDataDirPath(event.target.value);
                  setPrefix('');
                  setBucket(dataDirs.find((value) => value.path === event.target.value)?.buckets[0]?.name || '');
               }}
            >
               {dataDirs.map((value) => (
                  <option key={value.path} value={value.path}>
                     {value.path}
                  </option>
               ))}
            </select>
         )}
         {!problem && (
            <>
               <select
                  aria-label="Bucket"
                  value={bucket}
                  onChange={(event) => {
                     setPrefix('');
                     setBucket(event.target.value);
                  }}
               >
                  {dataDir!.buckets.map((value) => (
                     <option key={value.name} value={value.name}>
                        {value.name} ({value.objects.toLocaleString()} objects)
                     </option>
                  ))}
               </select>
               <input
                  type="search"
                  aria-label="Search object keys"
                  placeholder={prefix ? `Search in ${prefix}` : 'Search keys, e.g. invoices/2026'}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
               />
               <select aria-label="Versions" value={versions} onChange={(event) => setVersions(event.target.value as 'latest' | 'all')}>
                  <option value="latest">Current versions</option>
                  <option value="all">All versions</option>
               </select>
            </>
         )}
      </div>
   );

   const state = (content: ReactNode, alert = false) => (
      <div className={catalog.view}>
         {toolbar}
         <div className={catalog.state} role={alert ? 'alert' : undefined} aria-live={alert ? undefined : 'polite'}>
            {content}
         </div>
      </div>
   );

   if (problem) return state(<span>{problem}</span>, true);
   if (!dataDir!.buckets.length) return state(<span>This MinIO data folder has no buckets.</span>);
   if (objects.error) {
      const failure = objects.error instanceof MinioObjectError ? objects.error : undefined;
      return state(
         <>
            <span>{failure?.message || 'The MinIO object list is unavailable.'}</span>
            {(!failure || failure.status >= 409 || failure.status === 0) && (
               <button
                  type="button"
                  className={review.secondaryButton}
                  onClick={() => {
                     retryNext.current = true;
                     void objects.refetch();
                  }}
               >
                  Retry
               </button>
            )}
         </>,
         true,
      );
   }
   if (!page || page.status === 'indexing')
      return state(
         <>
            <Icon type="loading" size={20} />
            <span>{page ? minioProgressText(page.progress, formatBytes) : 'Preparing the object list…'}</span>
            <span>The first list of a bucket restores its xl.meta files to the server; later views open at once.</span>
         </>,
      );

   const arrow = (column: string) => (sort === column ? (order === 'asc' ? ' ↑' : ' ↓') : '');
   const folders = !debounced && page.offset === 0 ? page.folders : [];
   return (
      <div className={catalog.view}>
         {toolbar}
         <nav className={classes.crumbs} aria-label="Bucket path">
            <button type="button" disabled={!prefix} onClick={() => setPrefix('')}>
               {bucket}
            </button>
            {prefixCrumbs(prefix).map(([value, label]) => (
               <span key={value}>
                  <span>/</span>
                  <button type="button" disabled={value === prefix} onClick={() => setPrefix(value)}>
                     {label}
                  </button>
               </span>
            ))}
         </nav>
         <div className={catalog.meta}>
            <span>
               {page.counts.objects.toLocaleString()} objects · {formatBytes(page.counts.bytes)} available
               {page.counts.deleted ? ` · ${page.counts.deleted.toLocaleString()} deleted` : ''}
               {page.counts.versions !== page.counts.objects + page.counts.deleted ? ` · ${page.counts.versions.toLocaleString()} versions` : ''}
            </span>
            {page.counts.unsupported > 0 && (
               <span className={classes.unavailable}>
                  {page.counts.unsupported.toLocaleString()} cannot be read here (hover the status for the reason)
               </span>
            )}
         </div>
         {downloadError && (
            <p role="alert" className={`${review.alert} ${review.inset}`}>
               {downloadError}
            </p>
         )}
         <div className={catalog.tableWrap}>
            {page.items.length === 0 && folders.length === 0 ? (
               <div className={catalog.state}>{debounced ? 'No object key matches this search.' : 'This folder is empty.'}</div>
            ) : (
               <table className={catalog.table}>
                  <colgroup>
                     <col style={{ width: '44%' }} />
                     <col style={{ width: '11%' }} />
                     <col style={{ width: '17%' }} />
                     <col style={{ width: '9%' }} />
                     <col style={{ width: '14%' }} />
                     <col style={{ width: '5%' }} />
                  </colgroup>
                  <thead>
                     <tr>
                        <th onClick={() => toggleSort('key')}>Key{arrow('key')}</th>
                        <th onClick={() => toggleSort('size')}>Size{arrow('size')}</th>
                        <th onClick={() => toggleSort('modified')}>Last modified (UTC){arrow('modified')}</th>
                        <th>Versions</th>
                        <th>Status</th>
                        <th aria-label="Download" />
                     </tr>
                  </thead>
                  <tbody>
                     {folders.map((folder) => (
                        <tr key={`folder:${folder.prefix}`}>
                           <td colSpan={6}>
                              <button type="button" className={classes.folder} onClick={() => setPrefix(folder.prefix)}>
                                 <Icon type="fm-directory" size={14} />
                                 {nameBelow(prefix, folder.prefix)}
                              </button>
                              <span className={classes.detail}>{folder.objects.toLocaleString()} objects</span>
                           </td>
                        </tr>
                     ))}
                     {page.items.map((item) => (
                        <tr key={item.id}>
                           <td>
                              <span className={`${catalog.name} ${item.deleteMarker ? classes.deleted : ''}`}>
                                 {debounced ? item.key : nameBelow(prefix, item.key)}
                              </span>
                              <span className={classes.detail}>
                                 {[
                                    versions === 'all' || item.versionId !== 'null'
                                       ? `version ${item.versionId}${item.latest ? ' (current)' : ''}`
                                       : '',
                                    item.etag ? `ETag ${item.etag}` : '',
                                    minioStorageLabel(item),
                                 ]
                                    .filter(Boolean)
                                    .join(' · ')}
                              </span>
                           </td>
                           <td>{item.size === null ? '—' : formatBytes(item.size)}</td>
                           <td>{item.modified ? item.modified.replace('T', ' ').replace(/\.\d+Z$/, '') : '—'}</td>
                           <td>{item.versions.toLocaleString()}</td>
                           <td
                              className={
                                 item.status === 'supported' ? catalog.present : item.status === 'delete-marker' ? undefined : classes.unavailable
                              }
                              title={item.reason || undefined}
                           >
                              {minioStatusLabel(item)}
                           </td>
                           <td>
                              <button
                                 type="button"
                                 className={catalog.iconButton}
                                 aria-label={`Download ${item.key}`}
                                 title={
                                    item.status === 'supported'
                                       ? 'Download the original file (verified against its ETag)'
                                       : item.reason || 'Not downloadable'
                                 }
                                 disabled={item.status !== 'supported' || downloading !== null}
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
         {page.foldersTruncated && folders.length > 0 && (
            <div className={classes.notice}>Only the first 1,000 folders are shown. Search to narrow the list.</div>
         )}
         <div className={catalog.pager}>
            <span>
               {page.total === 0 ? '0' : `${(page.offset + 1).toLocaleString()}–${(page.offset + page.items.length).toLocaleString()}`} of{' '}
               {page.total.toLocaleString()}
            </span>
            <button
               type="button"
               className={review.secondaryButton}
               disabled={page.offset === 0}
               onClick={() => setOffset(Math.max(0, page.offset - PAGE_SIZE))}
            >
               Previous
            </button>
            <button
               type="button"
               className={review.secondaryButton}
               disabled={page.nextOffset === null}
               onClick={() => page.nextOffset !== null && setOffset(page.nextOffset)}
            >
               Next
            </button>
         </div>
      </div>
   );
}
