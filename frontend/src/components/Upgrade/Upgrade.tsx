import { useState } from 'react';
import { createPortal } from 'react-dom';
import classes from './Upgrade.module.scss';
import Icon from '../common/Icon/Icon';

interface UpgradeProps {
   focus?: string;
   onClose: () => void;
}

const Upgrade = ({ focus, onClose }: UpgradeProps) => {
   const [tab, setTab] = useState(focus || 'sync');
   const [snapshotsTab, setSnapshotsTab] = useState('comparison');

   const closeOnBGClick = (e: React.SyntheticEvent) => {
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      if (e.target === e.currentTarget) {
         onClose();
      }
   };

   return createPortal(
      <div className={classes.upgrade} onClick={closeOnBGClick}>
         <div className={classes.content}>
            <div className={classes.container}>
               <div className={classes.sidePanel}>
                  <h1>
                     <Icon type="bolt" size={20} color="#FF9800" /> Pluton PRO
                  </h1>
                  <ul>
                     <li className={tab === 'sync' ? classes.active : ''} onClick={() => setTab('sync')}>
                        <Icon type="sync" size={14} /> Sync Backups
                     </li>
                     <li className={tab === 'storage-sync' ? classes.active : ''} onClick={() => setTab('storage-sync')}>
                        <Icon type="storages" size={14} /> Storage Sync
                     </li>
                     <li className={tab === 'remote' ? classes.active : ''} onClick={() => setTab('remote')}>
                        <Icon type="computer-remote" size={14} /> Backup Remote Machines
                     </li>
                     <li className={tab === 'recovery' ? classes.active : ''} onClick={() => setTab('recovery')}>
                        <Icon type="integrity" size={14} /> Automated Recovery Check
                     </li>
                     <li className={tab === 'snapshot' ? classes.active : ''} onClick={() => setTab('snapshot')}>
                        <Icon type="box" size={14} /> Advanced Snapshot Features
                     </li>
                     <li className={tab === 'rescue' ? classes.active : ''} onClick={() => setTab('rescue')}>
                        <Icon type="linux" size={14} /> Linux Server Backup
                     </li>
                     <li className={tab === 'email' ? classes.active : ''} onClick={() => setTab('email')}>
                        <Icon type="email" size={14} /> Email Report Digest
                     </li>
                  </ul>
                  <a href="https://usepluton.com/pricing" target="_blank" rel="noopener noreferrer" className={classes.upgradeButton}>
                     Upgrade
                  </a>
               </div>
               <div className={classes.tabs}>
                  <button className={classes.close} onClick={onClose}>
                     <Icon type="close" size={24} />
                  </button>
                  {tab === 'sync' && (
                     <div className={classes.tab}>
                        <h3>
                           <Icon type="sync" size={18} /> Unlock Real-Time Sync for Instant Access, Everywhere
                        </h3>
                        <ul>
                           <li>
                              <Icon type="check-circle" size={14} /> Every change is mirrored the moment it happens
                           </li>
                           <li>
                              <Icon type="check-circle" size={14} /> No encryption or compression. Quickly Access your files anywhere
                           </li>
                           <li>
                              <Icon type="check-circle" size={14} /> Auto sync your files to multiple storages at once with Sync Replication
                           </li>
                           <li>
                              <Icon type="check-circle" size={14} /> Sync to Google Drive, Dropbox, Backblaze, and 70+ other storages
                           </li>
                        </ul>
                        <div className={classes.tabImage}>
                           <img src="https://pluton.b-cdn.net/upgrade/features_pro_sync.webp" />
                        </div>
                     </div>
                  )}
                  {tab === 'storage-sync' && (
                     <div className={classes.tab}>
                        <h3>
                           <Icon type="storages" size={18} /> Unlock Cloud-to-Cloud Storage Sync
                        </h3>
                        <ul>
                           <li>
                              <Icon type="check-circle" size={14} /> Sync one cloud storage directly to another, with no local copy
                           </li>
                           <li>
                              <Icon type="check-circle" size={14} /> Keep a second provider up to date, so one provider is never a single point of
                              failure
                           </li>
                           <li>
                              <Icon type="check-circle" size={14} /> File revisions, exclude patterns, and integrity checks work the same as a device
                              sync
                           </li>
                           <li>
                              <Icon type="check-circle" size={14} /> Restore files back to the source storage at any time
                           </li>
                        </ul>
                        <div className={classes.tabImage}>
                           <img src="https://pluton.b-cdn.net/upgrade/features_pro_storage_sync.webp" />
                        </div>
                     </div>
                  )}
                  {tab === 'remote' && (
                     <div className={classes.tab}>
                        <h3>
                           <Icon type="computer-remote" size={18} /> Unlock Centralized Remote Machine Backup
                        </h3>
                        <ul>
                           <li>
                              <Icon type="check-circle" size={14} /> Backup multiple remote machines from a single dashboard
                           </li>
                           <li>
                              <Icon type="check-circle" size={14} /> Lightweight agent-based backup runs backup autonomously
                           </li>
                           <li>
                              <Icon type="check-circle" size={14} /> Backup content of any device, anywhere
                           </li>
                        </ul>
                        <div className={classes.tabImage}>
                           <img src="https://pluton.b-cdn.net/upgrade/feature_infrastructure.webp" style={{ right: '-120px', marginTop: '-25px' }} />
                        </div>
                     </div>
                  )}
                  {tab === 'recovery' && (
                     <div className={classes.tab}>
                        <h3>
                           <Icon type="integrity" size={18} /> Unlock Automated Recovery Check
                        </h3>
                        <ul>
                           <li>
                              <Icon type="check-circle" size={14} /> Continuous automated backup recovery testing to catch corruptions
                           </li>
                           <li>
                              <Icon type="check-circle" size={14} /> Immediate notifications with clear steps for corrective action
                           </li>
                           <li>
                              <Icon type="check-circle" size={14} /> Ensure your snapshots are 100% ready for a genuine emergency
                           </li>
                        </ul>
                        <div className={classes.tabImage}>
                           <img src="https://pluton.b-cdn.net/upgrade/features_pro_auto_recovery.png" style={{ right: '-100px' }} />
                        </div>
                     </div>
                  )}
                  {tab === 'snapshot' && (
                     <div className={classes.tab}>
                        <h3>
                           <Icon type="box" size={18} /> Unlock Advanced Snapshot Management
                        </h3>
                        <ul className={classes.snapshotTabs}>
                           <li onClick={() => setSnapshotsTab('comparison')} className={snapshotsTab === 'comparison' ? classes.active : ''}>
                              <Icon type="check-circle" size={14} />
                              View Changes
                           </li>
                           <li onClick={() => setSnapshotsTab('preview')} className={snapshotsTab === 'preview' ? classes.active : ''}>
                              <Icon type="check-circle" size={14} />
                              Preview Files
                           </li>
                           <li onClick={() => setSnapshotsTab('download')} className={snapshotsTab === 'download' ? classes.active : ''}>
                              <Icon type="check-circle" size={14} />
                              Download Files
                           </li>
                           <li onClick={() => setSnapshotsTab('search')} className={snapshotsTab === 'search' ? classes.active : ''}>
                              <Icon type="check-circle" size={14} /> Search Snapshot
                           </li>
                        </ul>
                        <div className={classes.snapshotTabsMobile}>
                           <select value={snapshotsTab} onChange={(e) => setSnapshotsTab(e.target.value)}>
                              <option value="comparison">View Changes</option>
                              <option value="preview">Preview Files</option>
                              <option value="download">Download Files</option>
                              <option value="search">Search Snapshot</option>
                           </select>
                        </div>
                        <div className={classes.snapshotTabsContent}>
                           {snapshotsTab === 'comparison' && (
                              <div className={classes.snapshotTab}>
                                 <div className={classes.snapshotImage}>
                                    <img src="https://pluton.b-cdn.net/upgrade/snapshot_compare.png" />
                                 </div>
                                 <img className={classes.glowImage} src="https://pluton.b-cdn.net/upgrade/glow4.svg" />
                                 <p>Utilize the integrated comparison UI to view exactly what has changed between snapshots.</p>
                              </div>
                           )}
                           {snapshotsTab === 'preview' && (
                              <div className={classes.snapshotTab}>
                                 <div className={classes.snapshotImage}>
                                    <img src="https://pluton.b-cdn.net/upgrade/snapshot_view_files.png" />
                                 </div>
                                 <img className={classes.glowImage} src="https://pluton.b-cdn.net/upgrade/glow4.svg" />
                                 <p>View the content of various file types without downloading the entire snapshot.</p>
                              </div>
                           )}
                           {snapshotsTab === 'download' && (
                              <div className={classes.snapshotTab}>
                                 <div className={classes.snapshotImage}>
                                    <img src="https://pluton.b-cdn.net/upgrade/snapshot_file_download.png" />
                                 </div>
                                 <img className={classes.glowImage} src="https://pluton.b-cdn.net/upgrade/glow4.svg" />
                                 <p>Easily download specific files or folders directly from a snapshot.</p>
                              </div>
                           )}
                           {snapshotsTab === 'search' && (
                              <div className={classes.snapshotTab}>
                                 <div className={classes.snapshotImage}>
                                    <img src="https://pluton.b-cdn.net/upgrade/snapshot_search.png" />
                                 </div>
                                 <img className={classes.glowImage} src="https://pluton.b-cdn.net/upgrade/glow4.svg" />
                                 <p>Quickly find specific files within any snapshot across various versions.</p>
                              </div>
                           )}
                        </div>
                     </div>
                  )}
                  {tab === 'rescue' && (
                     <div className={classes.tab}>
                        <h3>
                           <Icon type="linux" size={16} /> Unlock Full Linux Server Backup
                        </h3>
                        <ul>
                           <li>
                              <Icon type="check-circle" size={14} /> Capture your entire Linux OS, kernel, and configurations
                           </li>
                           <li>
                              <Icon type="check-circle" size={14} /> Powered by ReaR for reliable, bare-metal restoration
                           </li>
                           <li>
                              <Icon type="check-circle" size={14} /> Boot from your ISO to return your server to its previous state
                           </li>
                        </ul>
                        <div className={classes.tabImage}>
                           <img src="https://pluton.b-cdn.net/upgrade/features_pro_linux_server.webp" />
                        </div>
                     </div>
                  )}
                  {tab === 'email' && (
                     <div className={classes.tab}>
                        <h3>
                           <Icon type="email" size={18} /> Unlock Global Backup Email Report Digest
                        </h3>
                        <ul>
                           <li>
                              <Icon type="check-circle" size={14} /> Receive consolidated daily, weekly, or monthly digest emails
                           </li>
                           <li>
                              <Icon type="check-circle" size={14} /> Stay informed about your entire backup ecosystem without logging into Pluton
                           </li>
                        </ul>
                        <div className={`${classes.tabImage} ${classes.emailTabImage}`}>
                           <img src="https://pluton.b-cdn.net/upgrade/pro_global_email.webp" />
                           <img className={classes.glowImage} src="https://pluton.b-cdn.net/upgrade/glow4.svg" />
                        </div>
                     </div>
                  )}
               </div>
               <div className={classes.mobileNav}>
                  <ul>
                     {['sync', 'storage-sync', 'remote', 'recovery', 'snapshot', 'rescue', 'email'].map((item) => (
                        <li key={item} className={tab === item ? classes.active : ''} onClick={() => setTab(item)}>
                           <Icon
                              type={
                                 item === 'sync'
                                    ? 'sync'
                                    : item === 'storage-sync'
                                      ? 'storages'
                                      : item === 'remote'
                                        ? 'computer-remote'
                                        : item === 'recovery'
                                          ? 'integrity'
                                          : item === 'snapshot'
                                            ? 'box'
                                            : item === 'rescue'
                                              ? 'linux'
                                              : 'email'
                              }
                              size={24}
                           />
                        </li>
                     ))}
                  </ul>
               </div>
            </div>
         </div>
      </div>,
      document.body,
   );
};

export default Upgrade;
