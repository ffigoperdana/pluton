import { useId, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SourceAccessHistoryFilter, SourceAccessRequest } from '../../../@types/agentSourceAccess';
import { useSourceAccessHistory } from '../../../services/agentSourceAccess';
import { sourceAccessStatus } from '../../../utils/agentSourceAccess';
import Modal from '../../common/Modal/Modal';
import Button from '../../common/Button/Button';
import Icon from '../../common/Icon/Icon';
import classes from './SourceAccess.module.scss';

const actionLabels = { validate: 'Validation', apply: 'Access change', 'mode-setup': 'Policy change' };
const statuses: SourceAccessRequest['status'][] = [
   'queued',
   'validating',
   'validated',
   'pending-host-approval',
   'pending-host-setup',
   'applied',
   'rejected',
   'cancelled',
];

function RequestRow({ request, renderDetails }: { request: SourceAccessRequest; renderDetails: (request: SourceAccessRequest) => ReactNode }) {
   const [expanded, setExpanded] = useState(false);
   const detailsId = useId();
   const icon = ['applied', 'validated'].includes(request.status)
      ? 'check-circle'
      : ['rejected', 'cancelled'].includes(request.status)
        ? 'error'
        : 'clock';
   return (
      <li className={classes.historyRow}>
         <button
            type="button"
            className={classes.requestSummary}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded(!expanded)}
         >
            <span>{actionLabels[request.kind]}</span>
            <span className={classes.requestStatus}>
               <span aria-hidden="true">
                  <Icon type={icon} size={13} />
               </span>
               {request.status === 'validated'
                  ? 'Validated'
                  : request.status === 'queued'
                    ? 'Queued'
                    : request.status === 'validating'
                      ? 'Validating'
                      : sourceAccessStatus(request.status)}
            </span>
            <time dateTime={request.createdAt}>{new Date(request.createdAt).toLocaleString()}</time>
            <span className={classes.muted}>{expanded ? 'Hide details' : 'Details'}</span>
         </button>
         <div id={detailsId} hidden={!expanded} className={classes.requestDetails}>
            {expanded && renderDetails(request)}
         </div>
      </li>
   );
}

export default function SourceAccessHistory({
   deviceId,
   requests,
   renderDetails,
}: {
   deviceId: string;
   requests: SourceAccessRequest[];
   renderDetails: (request: SourceAccessRequest) => ReactNode;
}) {
   const [open, setOpen] = useState(false);
   const [cursor, setCursor] = useState<string>();
   const [previous, setPrevious] = useState<string[]>([]);
   const [filter, setFilter] = useState<SourceAccessHistoryFilter>({});
   const queryClient = useQueryClient();
   const query = useSourceAccessHistory(deviceId, cursor, filter, open);
   const recent = [...requests]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1))
      .slice(0, 5);
   const reset = () => {
      setCursor(undefined);
      setPrevious([]);
   };
   const rows = (items: SourceAccessRequest[]) => (
      <ul className={classes.requestList}>
         {items.map((request) => (
            <RequestRow key={request.id} request={request} renderDetails={renderDetails} />
         ))}
      </ul>
   );
   return (
      <div className={classes.history}>
         <div className={classes.heading}>
            <h4>Recent requests</h4>
            <Button
               text="View all requests"
               variant="tertiary"
               size="sm"
               onClick={() => {
                  reset();
                  setOpen(true);
               }}
            />
         </div>
         {recent.length ? rows(recent) : <p>No source access requests.</p>}
         {open && (
            <Modal title="Source Access request history" width="760px" stableLayout closeModal={() => setOpen(false)}>
               <div className={classes.historyView}>
                  <div className={classes.historyFilters}>
                     <label>
                        Status
                        <select
                           value={filter.status ?? ''}
                           onChange={(event) => {
                              reset();
                              setFilter({ ...filter, status: (event.target.value || undefined) as SourceAccessHistoryFilter['status'] });
                           }}
                        >
                           <option value="">All statuses</option>
                           {statuses.map((status) => (
                              <option key={status} value={status}>
                                 {sourceAccessStatus(status)}
                              </option>
                           ))}
                        </select>
                     </label>
                     <label>
                        Type
                        <select
                           value={filter.kind ?? ''}
                           onChange={(event) => {
                              reset();
                              setFilter({ ...filter, kind: (event.target.value || undefined) as SourceAccessHistoryFilter['kind'] });
                           }}
                        >
                           <option value="">All types</option>
                           {Object.entries(actionLabels).map(([kind, label]) => (
                              <option key={kind} value={kind}>
                                 {label}
                              </option>
                           ))}
                        </select>
                     </label>
                     <Button
                        text="Refresh history"
                        variant="tertiary"
                        size="sm"
                        disabled={query.isFetching}
                        onClick={() => {
                           reset();
                           void queryClient.invalidateQueries({ queryKey: ['source-access', deviceId] });
                        }}
                     />
                  </div>
                  <p className={classes.muted}>Newest first · 10 per page. Refresh to include newly added requests.</p>
                  <div aria-live="polite" aria-busy={query.isFetching}>
                     {query.isPending && <p role="status">Loading request history…</p>}
                     {query.error && (
                        <p role="alert" className={classes.error}>
                           Could not load request history. Refresh or reconnect your administrator session.
                        </p>
                     )}
                     {!query.isPending && !query.error && query.data && (
                        <>
                           {query.data.requests.length ? rows(query.data.requests) : <p>No requests match this history view.</p>}
                           <nav aria-label="Source Access history pagination" className={classes.historyPagination}>
                              <Button
                                 text="Previous"
                                 variant="tertiary"
                                 size="sm"
                                 disabled={!previous.length || query.isFetching}
                                 onClick={() => {
                                    setCursor(previous[previous.length - 1]);
                                    setPrevious(previous.slice(0, -1));
                                 }}
                              />
                              <span>
                                 Page {previous.length + 1} · {query.data.total} requests
                              </span>
                              <Button
                                 text="Next"
                                 variant="tertiary"
                                 size="sm"
                                 disabled={!query.data.nextCursor || query.isFetching}
                                 onClick={() => {
                                    setPrevious([...previous, query.data!.cursor]);
                                    setCursor(query.data!.nextCursor);
                                 }}
                              />
                           </nav>
                        </>
                     )}
                  </div>
               </div>
            </Modal>
         )}
      </div>
   );
}
