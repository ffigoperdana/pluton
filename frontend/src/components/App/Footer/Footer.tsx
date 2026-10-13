import { Link } from 'react-router';
import { buildIdentity } from '../../../utils/buildIdentity';
import classes from './Footer.module.scss';

interface FooterProps {
   version?: string;
   revision?: string;
   /** Deprecated compatibility props: never drive upstream calls or upsells. */
   edition?: string;
   latestVersion?: string;
   hideUpgradeLink?: boolean;
   changeLogUrl?: string;
   installType?: string;
}
const Footer = ({ version, revision }: FooterProps) => (
   <footer className={classes.footer}>
      <span>Pluton</span> <i className="pipe">|</i> <Link to="/docs">Documentation</Link> <i className="pipe">|</i>{' '}
      <Link to="/docs/changelog">Changelog</Link> <i className="pipe">|</i>{' '}
      <Link to="/docs/reference/version" title="Installed local build metadata">
         {buildIdentity(version, revision)}
      </Link>{' '}
      <i className="pipe">|</i> <Link to="/docs/reference/acknowledgements">About</Link>
   </footer>
);
export default Footer;
