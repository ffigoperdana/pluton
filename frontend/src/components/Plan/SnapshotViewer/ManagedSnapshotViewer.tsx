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
import type { SnapshotViewerProps } from './SnapshotViewer';
import classes from '../../common/SnapshotBrowser/SnapshotBrowser.module.scss';

/** Only the current page is retained. Managed metadata never enters Dexie. */
export default function ManagedSnapshotViewer({
   backup,
   planId,
   onClose,
   selection,
}: SnapshotViewerProps & {
   selection?: { includes: string[]; excludes: string[]; onChange: (includes: string[], excludes: string[]) => void };
}) {
   const [directory, setDirectory] = useState('');
   const [search, setSearch] = useState('');
   const [debouncedSearch, setDebouncedSearch] = useState('');
   const [offset, setOffset] = useState(0);
   const [sort, setSort] = useState<ManagedSnapshotQuery['sort']>('name');
   const [order, setOrder] = useState<ManagedSnapshotQuery['order']>('asc');
   const [selected, setSelected] = useState<FileItem | null>(null);
   const content = useRef<HTMLDivElement>(null);
   const restore = useRestoreBackup();
   const navigate = useNavigate();
   useEffect(() => {
      const timer = setTimeout(() => {
         setDebouncedSearch(search);
         setOffset(0);
      }, 300);
      return () => clearTimeout(timer);
   }, [search]);
   const query = useQuery({
      queryKey: ['managed-snapshot-page', backup.id, directory, debouncedSearch, offset, sort, order],
      queryFn: ({ signal }) =>
         fetchManagedSnapshotPage(API_URL, backup.id, { path: directory, search: debouncedSearch, offset, limit: 200, sort, order }, signal),
      gcTime: 0,
      staleTime: 30_000,
      retry: false,
      refetchInterval: (state) => (state.state.status !== 'error' && state.state.data?.status === 'indexing' ? 1000 : false),
   });
   const page = query.data?.status === 'ready' ? query.data : null;
   const openDirectory = (value: string) => {
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
   const breadcrumbs = directory
      .split('/')
      .filter(Boolean)
      .map((_, index, parts) => `/${parts.slice(0, index + 1).join('/')}`);
   const gridColumns = '1fr 120px minmax(100px, auto) 120px';
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
      <div className={classes.snapshotBrowser}>
         <SnapshotBrowserToolbar
            search={search}
            onSearchChange={setSearch}
            isLoading={query.isFetching}
            leftContent={
               <div className={classes.stats}>
                  <Icon type="box" />
                  <strong>backup-{backup.id}</strong> • {formatBytes(backup.totalSize)}
               </div>
            }
         />
         <nav aria-label="Snapshot directory" style={{ display: 'flex', gap: 10, padding: 12, flexWrap: 'wrap' }}>
            <button onClick={() => openDirectory('')}>Snapshot root</button>
            {breadcrumbs.map((value) => (
               <button key={value} onClick={() => openDirectory(value)}>
                  {value.split('/').pop()}
               </button>
            ))}
         </nav>
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
         {query.isError ? (
            <div className={classes.errorState} role="alert">
               <p>{query.error.message}</p>
               <button onClick={() => void query.refetch()}>Retry indexing</button>
            </div>
         ) : !page ? (
            <div className={classes.loadingState} role="status">
               <Icon type="loading" size={24} />
               <p>{query.data?.status === 'indexing' ? 'Indexing snapshot metadata…' : 'Loading snapshot metadata…'}</p>
               <small>You can close this view and return while indexing finishes.</small>
            </div>
         ) : (
            <>
               <div className={classes.browserContent}>
                  <div className={`${classes.content} styled__scrollbar`} ref={content}>
                     <SnapshotBrowserFileList
                        files={files}
                        selectedFolder={directory}
                        height={content.current?.clientHeight ? content.current.clientHeight - 50 : 520}
                        itemSize={isMobile() ? 65 : 46}
                        gridTemplateColumns={gridColumns}
                        isLoading={query.isFetching}
                        headerContent={
                           <>
                              <button onClick={() => changeSort('name')}>Name {sort === 'name' ? (order === 'asc' ? '↑' : '↓') : ''}</button>
                              <button onClick={() => changeSort('modifiedAt')}>Last modified</button>
                              <button onClick={() => changeSort('size')}>Size</button>
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
                  </div>
               </div>
               <div aria-label="Snapshot pages" style={{ display: 'flex', gap: 16, padding: 12, alignItems: 'center' }}>
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
