import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchManagedSnapshotPage, type ManagedSnapshotPage } from '../../../utils/managedSnapshotBrowse';
import { API_URL } from '../../../utils/constants';
import SnapshotBrowserDirectories from '../../common/SnapshotBrowser/SnapshotBrowserDirectories';
import classes from '../../common/SnapshotBrowser/SnapshotBrowser.module.scss';

type Ready = Extract<ManagedSnapshotPage, { status: 'ready' }>;
type Branch = { page?: Ready; loading?: boolean; error?: string; offset: number };
const TREE_LIMITS = { nodes: 4096, branches: 512, requests: 8 } as const;

/** Only expanded directory pages are requested; neither files nor the whole tree enter this cache. */
export default function ManagedSnapshotDirectories({backupId,
   selectedFolder,
   onDirectoryClick,}: {
   backupId: string;
   selectedFolder: string;
   onDirectoryClick: (path: string) => void;
}) {
   const [branches, setBranches] = useState<Map<string, Branch>>(new Map());
   const [expanded, setExpanded] = useState<Set<string>>(new Set());
   const state = useRef(branches);
   const requests = useRef(new Map<string, AbortController>());
   const update = useCallback((parent: string, branch: Branch) => {
      const next = new Map(state.current);
      next.delete(parent);
      next.set(parent, branch);
      let nodes = [...next.values()].reduce((n, value) => n + (value.page?.files.length || 0), 0);
      for (const [key, value] of next) {
         if (nodes <= TREE_LIMITS.nodes && next.size <= TREE_LIMITS.branches) break;
         // Keep the current ancestry intact. Other evicted pages can be reloaded explicitly.
         if (key === '' || key === parent || parent.startsWith(`${key}/`) || requests.current.has(key)) continue;
         next.delete(key);
         nodes -= value.page?.files.length || 0;
      }
      if (nodes > TREE_LIMITS.nodes || next.size > TREE_LIMITS.branches) {
         next.delete(parent);
         next.set('', { ...next.get(''), offset: 0, error: 'Directory tree limit reached. Collapse other folders and retry.' });
      }
      state.current = next;
      setBranches(next);
   }, []);
   const load = useCallback(
      async (parent: string, offset = 0, retry = false) => {
         if (requests.current.has(parent)) return;
         if (requests.current.size >= TREE_LIMITS.requests) {
            update(parent, { offset, error: 'Directory loading is busy. Retry shortly.' });
            return;
         }
         const controller = new AbortController();
         requests.current.set(parent, controller);
         update(parent, { offset, loading: true });
         try {
            // Index polling is normally owned by the file panel; this also handles cache expiry.
            for (;;) {
               const page = await fetchManagedSnapshotPage(
                  API_URL,
                  backupId,
                  {path: parent,
                     offset,
                     limit: 200,
                     search: '',
                     sort: 'name',
                     order: 'asc',
                     directoriesOnly: true,
                     ...(retry ? { retry: true } : {}),},
                  controller.signal,
               );
               retry = false;
               if (controller.signal.aborted) return;
               if (page.status === 'ready') {
                  update(parent, { page, offset });
                  return;
               }
               await new Promise<void>((resolve, reject) => {
                  const stop = () => {
                     clearTimeout(timer);
                     reject(new Error('cancelled'));
                  };
                  const timer = setTimeout(() => {
                     controller.signal.removeEventListener('abort', stop);
                     resolve();
                  }, page.retryAfterMs);
                  controller.signal.addEventListener('abort', stop, { once: true });
                  if (controller.signal.aborted) stop();
               });
            }
         } catch (error) {
            if (!controller.signal.aborted) update(parent, { offset, error: error instanceof Error ? error.message : 'Directory loading failed.' });
         } finally {
            if (requests.current.get(parent) === controller) requests.current.delete(parent);
         }
      },
      [backupId, update],
   );
   useEffect(() => {
      void load('');
      const pending = requests.current;
      return () => {
         for (const controller of pending.values()) controller.abort();
         pending.clear();
      };
   }, [load]);
   useEffect(() => {
      if (!selectedFolder) return;
      const parts = selectedFolder.split('/').filter(Boolean);
      const ancestors = parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`);
      setExpanded((previous) => new Set([...previous, ...ancestors].slice(-TREE_LIMITS.branches)));
      // Ancestors already loaded by normal navigation are reused, including empty folders.
      for (const parent of ancestors) if (!state.current.has(parent)) void load(parent);
   }, [selectedFolder, load]);
   const toggle = (parent: string) => {
      if (expanded.has(parent)) {
         setExpanded((previous) => {
            const next = new Set(previous);
            next.delete(parent);
            return next;
         });
         requests.current.get(parent)?.abort();
         requests.current.delete(parent);
         if (state.current.get(parent)?.loading) update(parent, { offset: 0 });
      } else {
         setExpanded((previous) => new Set([...previous, parent].slice(-TREE_LIMITS.branches)));
         if (!state.current.get(parent)?.page) void load(parent);
      }
   };
   const controls = (parent: string) => {
      const branch = branches.get(parent);
      return (
         <div className={classes.treeControls} style={{ paddingLeft: Math.min(80, parent.split('/').length * 12) }}>
            {branch?.loading ? (
               <span role="status">Loading folders…</span>
            ) : branch?.error ? (
               <>
                  <span role="alert">{branch.error}</span>
                  <button onClick={() => void load(parent, branch.offset, true)}>Retry folders</button>
               </>
            ) : !branch?.page ? (
               <button onClick={() => void load(parent)}>Load folders</button>
            ) : (
               <>
                  {!branch.page.total && <span>No subfolders</span>}
                  {branch.page.total > 200 && (
                     <>
                        <button
                           aria-label={`Previous folders in ${parent || '/'}`}
                           disabled={!branch.offset}
                           onClick={() => void load(parent, branch.offset - 200)}
                        >
                           Previous folders
                        </button>
                        <span>
                           {branch.offset + 1}–{branch.offset + branch.page.files.length} of {branch.page.total}
                        </span>
                        <button
                           aria-label={`Next folders in ${parent || '/'}`}
                           disabled={branch.page.nextOffset === null}
                           onClick={() => void load(parent, branch.page!.nextOffset!)}
                        >
                           Next folders
                        </button>
                     </>
                  )}
               </>
            )}
         </div>
      );
   };
   const directories: string[] = [];
   // A selected table row may belong to another sidebar page. Pin only its
   // bounded ancestry, so selection stays visible without fetching sibling pages.
   const selectedChildren = new Map<string, string>();
   let parentPath = '';
   for (const part of selectedFolder.split('/').filter(Boolean)) {
      const child = `${parentPath}/${part}`;
      selectedChildren.set(parentPath, child);
      parentPath = child;
   }
   const visit = (parent: string) => {
      const paths = (branches.get(parent)?.page?.files || []).map(file => file.path);
      const selectedChild = selectedChildren.get(parent);
      if (selectedChild && !paths.includes(selectedChild)) paths.unshift(selectedChild);
      for (const path of paths) {
         directories.push(path);
         if (expanded.has(path)) visit(path);
      }
   };
   visit('');
   return (
      <SnapshotBrowserDirectories
         directories={directories}
         selectedFolder={selectedFolder}
         expandedFolders={expanded}
         onDirectoryClick={onDirectoryClick}
         onToggleFolder={toggle}
         isVisible={() => true}
         hasSubdirectories={(parent) => !branches.get(parent)?.page || !!branches.get(parent)?.page?.total}
         headerContent={<h4>Directories</h4>}
         rootContent={
            <>
               <button className={`${classes.treeRoot} ${!selectedFolder ? classes.selected : ''}`} onClick={() => onDirectoryClick('')}>
                  All files
               </button>
               {controls('')}
            </>
         }
         renderAfterDirectory={controls}
      />
   );
}
