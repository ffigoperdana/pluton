import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'react-toastify';
import ActionModal from '../../components/common/ActionModal/ActionModal';
import Icon from '../../components/common/Icon/Icon';
import Modal from '../../components/common/Modal/Modal';
import NotFound from '../../components/common/NotFound/NotFound';
import PageHeader from '../../components/common/PageHeader/PageHeader';
import {
   useDeleteLegacyRepository,
   useLegacyRepository,
   useLegacyRepositorySnapshots,
   useLegacyRepositoryStats,
   useValidateLegacyRepository,
} from '../../services/legacyRepositories';
import type { LegacyRepositorySnapshotFilters, LegacyRepositorySnapshot } from '../../@types/legacyRepositories';
import { formatBytes, formatDateTime } from '../../utils/helpers';
import classes from './LegacyRepositories.module.scss';

const LegacyRepositoryDetail = () => {
   const { id } = useParams();
   const navigate = useNavigate();
   const [filters, setFilters] = useState<LegacyRepositorySnapshotFilters>({});
   const [draftFilters, setDraftFilters] = useState<LegacyRepositorySnapshotFilters>({});
   const [selectedSnapshot, setSelectedSnapshot] = useState<LegacyRepositorySnapshot>();
   const [showDelete, setShowDelete] = useState(false);
   const { data: repositoryData, isLoading: repositoryLoading, error: repositoryError } = useLegacyRepository(id);
   const { data: snapshotsData, isLoading: snapshotsLoading, error: snapshotsError } = useLegacyRepositorySnapshots(id, filters);
   const { data: statsData, isLoading: statsLoading, error: statsError } = useLegacyRepositoryStats(id);
   const validateMutation = useValidateLegacyRepository();
   const deleteMutation = useDeleteLegacyRepository();
   const repository = repositoryData?.result;
   const snapshots = snapshotsData?.result || [];
   const stats = statsData?.result;

   if (!id || (repositoryError && !repositoryLoading)) {
      return <NotFound name="Legacy repository" link="/legacy-repositories" linkText="All Legacy Repositories" />;
   }

   const applyFilters = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setFilters({
         tag: draftFilters.tag?.trim() || undefined,
         path: draftFilters.path?.trim() || undefined,
         host: draftFilters.host?.trim() || undefined,
      });
   };

   const clearFilters = () => {
      setDraftFilters({});
      setFilters({});
   };

   const validateAccess = () => {
      validateMutation.mutate(id, {
         onSuccess: () => toast.success('Repository access checked successfully.', { autoClose: 5000 }),
         onError: (error: Error) => toast.error(error.message),
      });
   };

   const deleteRegistration = () => {
      deleteMutation.mutate(id, {
         onSuccess: () => {
            toast.success('Legacy repository registration removed. The repository was not modified.', { autoClose: 5000 });
            navigate('/legacy-repositories');
         },
         onError: (error: Error) => toast.error(error.message),
      });
   };

   return (
      <div className={classes.page}>
         <Link className={classes.backLink} to="/legacy-repositories">← Legacy Repositories</Link>
         {repositoryLoading || !repository ? (
            <div className="loadingScreen"><Icon size={45} type="loading" /></div>
         ) : (
            <>
               <PageHeader
                  title={repository.displayName}
                  pageTitle={repository.displayName}
                  icon="storages"
                  rightSection={
                     <>
                        <button className={classes.secondaryButton} onClick={validateAccess} disabled={validateMutation.isPending}>
                           <Icon type={validateMutation.isPending ? 'loading' : 'verify'} size={14} /> Check access
                        </button>
                        <button className={classes.dangerButton} onClick={() => setShowDelete(true)}>
                           <Icon type="trash" size={14} /> Remove registration
                        </button>
                     </>
                  }
               />
               <div className={classes.readOnlyNotice}>
                  <Icon type="lock" size={17} />
                  <div>
                     <strong>READ ONLY</strong>
                     <p>No backup, restore, retention, prune, repair, migration, initialization, or lock cleanup is available for this repository.</p>
                  </div>
               </div>
               <section className={classes.summaryGrid}>
                  <div className={classes.summaryCard}>
                     <span>Repository path</span>
                     <strong className={classes.pathValue}>{repository.repositoryPath}</strong>
                  </div>
                  <div className={classes.summaryCard}>
                     <span>Status</span>
                     <strong className={`${classes.status} ${classes[repository.validationStatus]}`}>{repository.validationStatus}</strong>
                     <small>{repository.lastValidatedAt ? `Last checked ${formatDateTime(repository.lastValidatedAt)}` : 'Not checked yet'}</small>
                  </div>
                  <div className={classes.summaryCard}>
                     <span>Backend</span>
                     <strong>Local filesystem</strong>
                     <small>Registered {formatDateTime(repository.createdAt)}</small>
                  </div>
               </section>
               <section className={classes.section}>
                  <div className={classes.sectionHeader}>
                     <div>
                        <h3>Safe repository statistics</h3>
                        <p>Read-only metadata reported by Restic when supported.</p>
                     </div>
                  </div>
                  {statsLoading && <Icon type="loading" size={20} />}
                  {statsError && <p className={classes.safeError}>{(statsError as Error).message}</p>}
                  {stats && (
                     <div className={classes.statsGrid}>
                        <div><span>Snapshots</span><strong>{stats.snapshotCount}</strong></div>
                        <div><span>Stored size</span><strong>{formatBytes(stats.totalSize)}</strong></div>
                        <div><span>Uncompressed size</span><strong>{formatBytes(stats.totalUncompressedSize)}</strong></div>
                        <div><span>Compression</span><strong>{stats.compressionRatio.toFixed(2)}×</strong></div>
                     </div>
                  )}
               </section>
               <section className={classes.section}>
                  <div className={classes.sectionHeader}>
                     <div>
                        <h3>Snapshots</h3>
                        <p>Existing snapshot metadata only. Selecting a snapshot does not browse or restore its files.</p>
                     </div>
                  </div>
                  <form className={classes.filters} onSubmit={applyFilters}>
                     <input aria-label="Filter by tag" value={draftFilters.tag || ''} onChange={(event) => setDraftFilters({ ...draftFilters, tag: event.target.value })} placeholder="Tag" />
                     <input aria-label="Filter by path" value={draftFilters.path || ''} onChange={(event) => setDraftFilters({ ...draftFilters, path: event.target.value })} placeholder="Exact path" />
                     <input aria-label="Filter by host" value={draftFilters.host || ''} onChange={(event) => setDraftFilters({ ...draftFilters, host: event.target.value })} placeholder="Host" />
                     <button className={classes.secondaryButton} type="submit">Apply filters</button>
                     <button className={classes.textButton} type="button" onClick={clearFilters}>Clear</button>
                  </form>
                  {snapshotsError && <p className={classes.safeError}>{(snapshotsError as Error).message}</p>}
                  {snapshotsLoading && <Icon type="loading" size={20} />}
                  {!snapshotsLoading && !snapshotsError && snapshots.length === 0 && <p className={classes.emptyText}>No snapshots match the current filters.</p>}
                  <div className={classes.snapshotList}>
                     {snapshots.map((snapshot) => (
                        <button className={classes.snapshotRow} type="button" key={snapshot.id} onClick={() => setSelectedSnapshot(snapshot)}>
                           <div><strong>{snapshot.shortId}</strong><span>{formatDateTime(snapshot.time)}</span></div>
                           <div><span>{snapshot.hostname || 'Unknown host'}</span><span>{snapshot.tags.length ? snapshot.tags.join(', ') : 'No tags'}</span></div>
                           <span>{snapshot.paths.length} path{snapshot.paths.length === 1 ? '' : 's'}</span>
                        </button>
                     ))}
                  </div>
               </section>
            </>
         )}
         {selectedSnapshot && (
            <Modal title={`Snapshot ${selectedSnapshot.shortId}`} width="600px" closeModal={() => setSelectedSnapshot(undefined)}>
               <div className={classes.snapshotMetadata}>
                  <div><span>Snapshot ID</span><code>{selectedSnapshot.id}</code></div>
                  <div><span>Time</span><strong>{formatDateTime(selectedSnapshot.time)}</strong></div>
                  <div><span>Host</span><strong>{selectedSnapshot.hostname || 'Unknown host'}</strong></div>
                  <div><span>Tags</span><strong>{selectedSnapshot.tags.length ? selectedSnapshot.tags.join(', ') : 'No tags'}</strong></div>
                  <div><span>Paths</span>{selectedSnapshot.paths.length ? selectedSnapshot.paths.map((path) => <code key={path}>{path}</code>) : <strong>No paths reported</strong>}</div>
                  {selectedSnapshot.parent && <div><span>Parent snapshot</span><code>{selectedSnapshot.parent}</code></div>}
               </div>
            </Modal>
         )}
         {showDelete && repository && (
            <ActionModal
               title="Remove legacy repository registration"
               message={<>This removes only Pluton's local registration for <strong>{repository.displayName}</strong>. The repository and its snapshots will not be changed.</>}
               closeModal={() => setShowDelete(false)}
               primaryAction={{
                  title: 'Remove registration',
                  type: 'danger',
                  icon: 'trash',
                  isPending: deleteMutation.isPending,
                  action: deleteRegistration,
               }}
            />
         )}
      </div>
   );
};

export default LegacyRepositoryDetail;
