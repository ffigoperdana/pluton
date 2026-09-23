import { useState } from 'react';
import { Link } from 'react-router';
import PageHeader from '../../components/common/PageHeader/PageHeader';
import Icon from '../../components/common/Icon/Icon';
import { useLegacyRepositories } from '../../services/legacyRepositories';
import type { LegacyRepository } from '../../@types/legacyRepositories';
import { formatDateTime } from '../../utils/helpers';
import RegisterLegacyRepository from './RegisterLegacyRepository';
import classes from './LegacyRepositories.module.scss';

const LegacyRepositories = () => {
   const [showRegistration, setShowRegistration] = useState(false);
   const { data, isLoading, error } = useLegacyRepositories();
   const repositories: LegacyRepository[] = data?.result || [];

   return (
      <div className={classes.page}>
         <PageHeader
            title="Legacy Repositories"
            icon="storages"
            buttonTitle="+ Register"
            buttonAction={() => setShowRegistration(true)}
         />
         <div className={classes.readOnlyNotice}>
            <Icon type="lock" size={17} />
            <div>
                  <strong>READ ONLY</strong>
                  <p>Legacy repositories remain outside Pluton's backup and retention lifecycle. This area browses snapshots and restores selected content only to isolated staging.</p>
            </div>
         </div>
         {error && <div className={classes.errorMessage}>{(error as Error).message}</div>}
         {isLoading && (
            <div className="loadingScreen">
               <Icon size={45} type="loading" />
            </div>
         )}
         {!isLoading && repositories.length === 0 && (
            <div className="empty_container">
               <p>
                  No legacy repositories are registered. <button onClick={() => setShowRegistration(true)}>+ Register a repository</button> to inspect its snapshots.
               </p>
            </div>
         )}
         <div className={classes.repositoryList}>
            {repositories.map((repository) => (
               <Link className={classes.repositoryCard} to={`/legacy-repositories/${repository.id}`} key={repository.id}>
                  <div className={classes.repositoryIdentity}>
                     <Icon type="storages" size={22} />
                     <div>
                        <h3>{repository.displayName}</h3>
                        <p>{repository.repositoryPath}</p>
                     </div>
                  </div>
                  <div className={classes.repositoryMeta}>
                     <span className={`${classes.status} ${classes[repository.validationStatus]}`}>{repository.validationStatus}</span>
                     <span className={classes.readOnlyPill}><Icon type="lock" size={12} /> READ ONLY</span>
                     <span>Checked {repository.lastValidatedAt ? formatDateTime(repository.lastValidatedAt) : 'not yet'}</span>
                  </div>
               </Link>
            ))}
         </div>
         {showRegistration && <RegisterLegacyRepository close={() => setShowRegistration(false)} />}
      </div>
   );
};

export default LegacyRepositories;
