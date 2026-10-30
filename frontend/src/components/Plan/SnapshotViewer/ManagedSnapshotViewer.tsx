import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { toast } from 'react-toastify';
import type { FileItem } from '../../../@types/system';
import { API_URL } from '../../../utils/constants';
import { fetchManagedSnapshotPage, snapshotParent, type ManagedSnapshotQuery } from '../../../utils/managedSnapshotBrowse';
import { useRestoreBackup } from '../../../services/restores';
import { formatBytes, isMobile } from '../../../utils/helpers';
import Icon from '../../common/Icon/Icon';
import ActionModal from '../../common/ActionModal/ActionModal';
import SnapshotBrowserToolbar from '../../common/SnapshotBrowser/SnapshotBrowserToolbar';
import SnapshotBrowserFileList from '../../common/SnapshotBrowser/SnapshotBrowserFileList';
import SnapshotViewerFile from './SnapshotViewerFile';
import ManagedSnapshotDirectories from './ManagedSnapshotDirectories';
import type { SnapshotViewerProps } from './SnapshotViewer';
import classes from '../../common/SnapshotBrowser/SnapshotBrowser.module.scss';
import reviewClasses from './SnapshotReview.module.scss';
import { useSnapshotComparison } from '../../../hooks/useSnapshotComparison';
import { snapshotRequest, type ChangeFilter } from '../../../utils/snapshotReview';

const consumeRetry = (request: { current: boolean }) => {
   const retry = request.current;
   request.current = false;
   return retry;
};

type ManagedViewerProps = SnapshotViewerProps & {
   selection?: { includes: string[]; excludes: string[]; onChange: (includes: string[], excludes: string[]) => void };
};
const noReview = {
   query: { data: undefined, isError: false },
   action: { isPending: false, isError: false, mutate: () => {} },
} as unknown as ReturnType<typeof useSnapshotComparison>;
function ComparedViewer(props: ManagedViewerProps) {
   const review = useSnapshotComparison(props.backup.id, !!props.comparison?.enabled);
   return <ManagedViewer {...props} review={review} />;
}
export default function ManagedSnapshotViewer(props: ManagedViewerProps) {
   return props.comparison ? <ComparedViewer {...props} /> : <ManagedViewer {...props} />;
}
/** Only the current page is retained. Managed metadata never enters Dexie. */
function ManagedViewer({
   backup,
   planId,
   onClose,
   comparison,
   selection,
   toolbarLeftContent,
   review = noReview,
}: ManagedViewerProps & { review?: ReturnType<typeof useSnapshotComparison> }) {
   const [directory, setDirectory] = useState('');
   const [search, setSearch] = useState('');
   const [debouncedSearch, setDebouncedSearch] = useState('');
   const [offset, setOffset] = useState(0);
   const [sort, setSort] = useState<ManagedSnapshotQuery['sort']>('name');
   const [order, setOrder] = useState<ManagedSnapshotQuery['order']>('asc');
   const [selected, setSelected] = useState<FileItem | null>(null);
   const content = useRef<HTMLDivElement>(null);
   const retryIndex = useRef(false);
   const [treeReady, setTreeReady] = useState(false);
   const [showFolders, setShowFolders] = useState(false);
   const [height, setHeight] = useState(520);
   const [change, setChange] = useState<ChangeFilter>(comparison?.initialFilter || 'all');
   const comparisonReady = review.query.data?.state === 'ready';
   const [elapsed, setElapsed] = useState(0);
   const opened = useRef(Date.now());
   useEffect(() => {
      const timer = setInterval(() => setElapsed(Math.floor((Date.now() - opened.current) / 1000)), 1000);
      return () => clearInterval(timer);
   }, []);
   useEffect(() => {
      if (!content.current || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(([entry]) => setHeight(Math.max(120, entry.contentRect.height - 110)));
      observer.observe(content.current);
      return () => observer.disconnect();
   }, []);
   const restore = useRestoreBackup();
   const navigate = useNavigate();
   useEffect(() => {
      // Only an actual filter change may reset pagination. An initial/no-op
      // debounce can otherwise fire after the user has already changed pages.
      if (search === debouncedSearch) return;
      const timer = setTimeout(() => {
         setDebouncedSearch(search);
         setOffset(0);
      }, 300);
      return () => clearTimeout(timer);
   }, [search, debouncedSearch]);
   const query = useQuery({
      queryKey: ['managed-snapshot-page', backup.id, directory, debouncedSearch, offset, sort, order, comparisonReady, change],
      meta: { retryIndex },
      queryFn: async ({ signal, meta }) => {
         const retry = consumeRetry(meta!.retryIndex as { current: boolean });
         if (comparisonReady) {
            const params = new URLSearchParams({
               view: 'files',
               path: directory,
               search: debouncedSearch,
               offset: String(offset),
               limit: '200',
               sort: sort!,
               order: order!,
               ...(change === 'all' ? {} : { change }),
               ...(!directory && change !== 'all' ? { recursive: 'true' } : {}),
            });
            const value = await snapshotRequest<any>(API_URL, backup.id, `comparison?${params}`, signal);
            setTreeReady(true);
            return {
               ...value,
               snapshotId: value.currentSnapshotId,
               entries: value.entries,
            } as import('../../../utils/managedSnapshotBrowse').ManagedSnapshotPage;
         }
         const result = await fetchManagedSnapshotPage(
            API_URL,
            backup.id,
            { path: directory, search: debouncedSearch, offset, limit: 200, sort, order, ...(retry ? { retry: true } : {}) },
            signal,
         );
         if (result.status === 'ready') setTreeReady(true);
         return result;
      },
      gcTime: 0,
      staleTime: 30_000,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchInterval: (state) => (state.state.status !== 'error' && state.state.data?.status === 'indexing' ? state.state.data.retryAfterMs : false),
   });
   const page = query.data?.status === 'ready' ? query.data : null;
   const openDirectory = (value: string) => {
      setShowFolders(false);
      setDirectory(value);
      setOffset(0);
      setSearch('');
      setDebouncedSearch('');
   };
   const changeSort = (value: ManagedSnapshotQuery['sort']) => {
      setSort(value);
      setOrder(sort === value && order === 'asc' ? 'desc' : 'asc');
      setOffset(0);
   };
   const goUp = () => openDirectory(snapshotParent(directory));
   const files = page
      ? directory
         ? [{ isGoUp: true as const, path: '..', name: '..', isDirectory: true as const }, ...page.files]
         : page.files
      : [];
   const gridColumns = comparison ? 'minmax(180px,1fr) 120px 100px 110px 120px' : '1fr 120px minmax(100px, auto) 120px';
   const toggleSelection = (file: FileItem, exclude = false) => {
      if (!selection) return;
      const field = exclude ? selection.excludes : selection.includes;
      const updated = field.includes(file.path) ? field.filter((path) => path !== file.path) : [...field, file.path];
      if (updated.length > 1024) {
         toast.error('Select at most 1,024 paths.');
         return;
      }
      selection.onChange(exclude ? selection.includes : updated, exclude ? updated : selection.excludes);
   };
   return (
      <div className={`${classes.snapshotBrowser} ${classes.managedBrowser}`}>
         <SnapshotBrowserToolbar
            search={search}
            onSearchChange={setSearch}
            isLoading={query.isFetching}
            rightContent={
               <div className={classes.mobileSort}>
                  <select aria-label="Sort files" value={sort} onChange={(event) => changeSort(event.target.value as ManagedSnapshotQuery['sort'])}>
                     <option value="name">Name</option>
                     <option value="modifiedAt">Last Modified</option>
                     <option value="size">Size</option>
                  </select>
                  <button
                     aria-label="Reverse file sort"
                     onClick={() => {
                        setOrder((value) => (value === 'asc' ? 'desc' : 'asc'));
                        setOffset(0);
                     }}
                  >
                     {order === 'asc' ? '↑' : '↓'}
                  </button>
               </div>
            }
            leftContent={
               toolbarLeftContent || (
                  <div className={classes.stats}>
                     <Icon type="box" />
                     <strong>backup-{backup.id}</strong> • {formatBytes(backup.totalSize)}
                  </div>
               )
            }
         />
         <div className={classes.managedNavigation}>
            <button
               className={classes.folderToggle}
               disabled={!treeReady}
               aria-expanded={showFolders}
               onClick={() => setShowFolders((value) => !value)}
            >
               Folders
            </button>
            <nav className={reviewClasses.breadcrumbs} aria-label="Snapshot path">
               <button onClick={() => openDirectory('')}>All files</button>
               {directory
                  .split('/')
                  .filter(Boolean)
                  .map((part, index, parts) => (
                     <button key={index} onClick={() => openDirectory('/' + parts.slice(0, index + 1).join('/'))}>
                        {part}
                     </button>
                  ))}
            </nav>
         </div>
         {comparison?.enabled && (
            <div className={reviewClasses.comparison}>
               <span>
                  {comparisonReady
                     ? `Compared with ${review.query.data?.previousSnapshotId}`
                     : review.query.data?.state === 'preparing'
                       ? `Comparing snapshots · ${review.query.data.processedEntries?.toLocaleString() || 0} metadata entries · ${Math.floor((review.query.data.elapsedMs || 0) / 1000)}s`
                       : 'Not compared'}
               </span>
               {review.query.data?.state === 'preparing' ? (
                  <button disabled={review.action.isPending} onClick={() => review.action.mutate('cancel')}>
                     Cancel comparison
                  </button>
               ) : (
                  <button disabled={review.action.isPending} onClick={() => review.action.mutate('start')}>
                     {review.query.data?.state === 'failed' ? 'Retry comparison' : 'Compare with previous'}
                  </button>
               )}
               <label>
                  Changes{' '}
                  <select
                     aria-label="Filter changes"
                     disabled={!comparisonReady}
                     value={change}
                     onChange={(event) => {
                        setChange(event.target.value as ChangeFilter);
                        setOffset(0);
                     }}
                  >
                     {['all', 'added', 'modified', 'unchanged', 'deleted'].map((value) => (
                        <option key={value} value={value}>
                           {value[0].toUpperCase() + value.slice(1)}
                        </option>
                     ))}
                  </select>
               </label>
               {(review.query.isError || review.action.isError) && <span role="alert">Comparison unavailable. Ordinary browsing is available.</span>}
               {change === 'deleted' && comparisonReady && (
                  <>
                     <strong>Historical results from the previous snapshot. Restore is unavailable here.</strong>
                     <button onClick={() => comparison.onPrevious?.(review.query.data!.previousBackupId!)}>Browse previous snapshot</button>
                  </>
               )}
            </div>
         )}
         {selection && (
            <div style={{ padding: 12 }}>
               <button onClick={() => selection.onChange([], [])}>Recover entire snapshot</button>{' '}
               <span>
                  {selection.includes.length ? `${selection.includes.length} included paths` : 'Entire snapshot selected'} •{' '}
                  {selection.excludes.length} exclusions
               </span>
               <p>
                  Include files or directories to recover a selection. Exclusions apply within that selection. The preview validates the complete
                  selection.
               </p>
            </div>
         )}
         <div className={`${classes.browserContent} ${classes.managedContent} ${showFolders ? classes.showFolders : ''}`}>
            {treeReady && (
               <ManagedSnapshotDirectories key={backup.id} backupId={backup.id} selectedFolder={directory} onDirectoryClick={openDirectory} />
            )}
            <div className={`${classes.content} styled__scrollbar`} ref={content}>
               {query.isError ? (
                  <div className={classes.errorState} role="alert">
                     <p>{query.error.message}</p>
                     <button
                        onClick={() => {
                           retryIndex.current = true;
                           void query.refetch();
                        }}
                     >
                        Retry indexing
                     </button>
                  </div>
               ) : !page ? (
                  <div className={classes.loadingState} role="status">
                     <Icon type="loading" size={24} />
                     <p>{query.data?.status === 'indexing' ? 'Indexing snapshot metadata…' : 'Loading snapshot metadata…'}</p>
                     {query.data?.status === 'indexing' && (
                        <small>
                           {(query.data as { indexedEntries?: number })?.indexedEntries?.toLocaleString() || '0'} entries indexed ·{' '}
                           {Math.floor(((query.data as { elapsedMs?: number })?.elapsedMs || elapsed * 1000) / 1000)}s elapsed
                        </small>
                     )}
                     <small>You can close this view and return while indexing finishes.</small>
                  </div>
               ) : (
                  <>
                     <SnapshotBrowserFileList
                        files={files}
                        selectedFolder={directory}
                        height={height}
                        itemSize={isMobile() ? 65 : 46}
                        gridTemplateColumns={gridColumns}
                        isLoading={query.isFetching}
                        headerContent={
                           <>
                              <button onClick={() => changeSort('name')}>Name {sort === 'name' ? (order === 'asc' ? '↑' : '↓') : ''}</button>
                              <button onClick={() => changeSort('modifiedAt')}>Last modified</button>
                              <button onClick={() => changeSort('size')}>Size</button>
                              {comparison && <div>Change status</div>}
                              <div>Actions</div>
                           </>
                        }
                        renderRow={({ index, style }) => (
                           <SnapshotViewerFile
                              style={style}
                              file={files[index]}
                              gridColumns={gridColumns}
                              onGoUp={goUp}
                              onDirectoryClick={openDirectory}
                              onRestore={selection ? (file) => toggleSelection(file) : setSelected}
                              showRestoreAction={!selection}
                              changeStatus={comparison ? (files[index] as FileItem & { change?: string }).change || 'not-compared' : undefined}
                              historical={change === 'deleted' && comparisonReady}
                              renderFileActions={
                                 selection
                                    ? (file) => (
                                         <>
                                            <button onClick={() => toggleSelection(file)}>
                                               {selection.includes.includes(file.path) ? 'Included' : 'Include'}
                                            </button>
                                            <button onClick={() => toggleSelection(file, true)}>
                                               {selection.excludes.includes(file.path) ? 'Excluded' : 'Exclude'}
                                            </button>
                                         </>
                                      )
                                    : undefined
                              }
                           />
                        )}
                     />
                     <div aria-label="Snapshot pages" className={classes.managedPages}>
                        <button disabled={!offset || query.isFetching} onClick={() => setOffset(Math.max(0, offset - 200))}>
                           Previous
                        </button>
                        <span>
                           {page.total ? `${offset + 1}–${offset + page.files.length} of ${page.total.toLocaleString()}` : 'No matching files'} •{' '}
                           {page.entries.toLocaleString()} snapshot entries
                        </span>
                        <button disabled={page.nextOffset === null || query.isFetching} onClick={() => setOffset(page.nextOffset!)}>
                           Next
                        </button>
                     </div>
                  </>
               )}
            </div>
         </div>
         {selected && !selection && (
            <ActionModal
               title={`Restore ${selected.isDirectory ? 'Directory' : 'File'}`}
               width="600px"
               message={
                  <>
                     <p>{selected.path}</p>
                     <p>Restore into a new private staging workspace on the Pluton server. The remote source is never modified.</p>
                  </>
               }
               closeModal={() => setSelected(null)}
               primaryAction={{
                  title: 'Restore to staging',
                  type: 'default',
                  isPending: restore.isPending,
                  action: () =>
                     restore.mutate(
                        { backupId: backup.id, planId, target: '', includes: [selected.path], overwrite: 'never', deleteOption: false },
                        {
                           onSuccess: () => {
                              toast.success('Staged restoration started.');
                              navigate(`/plan/${planId}`);
                              onClose();
                           },
                           onError: (error) => toast.error(error.message),
                           onSettled: () => setSelected(null),
                        },
                     ),
               }}
            />
         )}
      </div>
   );
}
