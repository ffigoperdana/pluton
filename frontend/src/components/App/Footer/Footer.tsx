import { buildIdentity } from '../../../utils/buildIdentity';
import classes from './Footer.module.scss';
import { APP_NAME } from '../../../utils/brand';

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
      <span>{APP_NAME}</span> <i className="pipe">|</i> <a href="/docs">Documentation</a> <i className="pipe">|</i>{' '}
      <a href="/docs/changelog">Changelog</a> <i className="pipe">|</i>{' '}
      <a href="/docs/reference/version" title="Installed local build metadata">
         {buildIdentity(version, revision)}
      </a>{' '}
      <i className="pipe">|</i> <a href="/docs/reference/acknowledgements">About</a>
   </footer>
);
export default Footer;
