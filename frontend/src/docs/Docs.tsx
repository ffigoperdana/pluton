import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { docCategories, supportLabels } from './manifest';
import { docsIndex } from './content';
import { resolveDoc, searchDocs } from './model';
import Markdown from './Markdown';
import { useTheme } from '../context/ThemeContext';
import Footer from '../components/App/Footer/Footer';
import classes from './Docs.module.scss';

export default function Docs() {
   const location = useLocation();
   const metadata = resolveDoc(location.pathname);
   const article = docsIndex.find((item) => item.slug === metadata?.slug);
   const [query, setQuery] = useState('');
   const [menu, setMenu] = useState(false);
   const { theme, setTheme } = useTheme();
   const results = searchDocs(docsIndex, query);
   const home = location.pathname.replace(/\/$/, '') === '/docs';
   const ordinal = docsIndex.findIndex((item) => item.slug === article?.slug);
   useEffect(() => {
      const previous = document.title;
      document.title = `${article?.title || 'Documentation'} · Pluton`;
      setMenu(false);
      setQuery('');
      return () => {
         document.title = previous;
      };
   }, [location.pathname, article?.title]);
   useEffect(() => {
      try {
         const id = decodeURIComponent(location.hash.slice(1));
         if (id) document.getElementById(id)?.scrollIntoView();
         else window.scrollTo(0, 0);
      } catch {
         /* Malformed URL fragment must not blank the page. */
      }
   }, [location.pathname, location.hash]);
   return (
      <div className={classes.docs} lang="id">
         <a className={classes.skip} href="#doc-content">
            Lewati navigasi
         </a>
         <header className={classes.header}>
            <Link to="/docs" className={classes.brand}>
               Pluton <span>Documentation</span>
            </Link>
            <Link to="/">Buka aplikasi</Link>
            <button type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Ganti tema">
               {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
            <button className={classes.menuButton} type="button" aria-expanded={menu} aria-controls="docs-sidebar" onClick={() => setMenu(!menu)}>
               Menu
            </button>
         </header>
         <div className={classes.layout}>
            <aside id="docs-sidebar" className={`${classes.sidebar} ${menu ? classes.open : ''}`}>
               <nav aria-label="Kategori dokumentasi">
                  <Link to="/docs">Beranda dokumentasi</Link>
                  {docCategories.map((category) => (
                     <details key={category.id} open={category.id === article?.categoryId}>
                        <summary>{category.title}</summary>
                        <ul>
                           {category.articles.map((item) => (
                              <li key={item.slug}>
                                 <NavLink to={'/docs/' + item.slug} end>
                                    {item.title}
                                 </NavLink>
                              </li>
                           ))}
                        </ul>
                     </details>
                  ))}
               </nav>
            </aside>
            <main id="doc-content" className={classes.article} tabIndex={-1}>
               <div className={classes.search}>
                  <label htmlFor="docs-search">Cari dokumentasi lokal</label>
                  <input
                     id="docs-search"
                     type="search"
                     value={query}
                     maxLength={120}
                     onChange={(event) => setQuery(event.target.value)}
                     placeholder="Contoh: parent snapshot, SMTP, privilege"
                  />
                  <div aria-live="polite">{query.trim() && `${results.length} hasil`}</div>
                  {query.trim() && (
                     <ul className={classes.searchResults}>
                        {results.map(({ article: result, excerpt }) => (
                           <li key={result.slug}>
                              <Link to={'/docs/' + result.slug} onClick={() => setQuery('')}>
                                 {result.title}
                              </Link>
                              <p>{excerpt}</p>
                           </li>
                        ))}
                        {!results.length && <li>Tidak ditemukan. Coba istilah UI atau error code yang lebih singkat.</li>}
                     </ul>
                  )}
               </div>
               {home ? (
                  <>
                     <h1>Dokumentasi Pluton self-hosted</h1>
                     <p>
                        Panduan operasional Bahasa Indonesia untuk fork mandiri: backup, agent, database, staged restore, Recovery Test, dan
                        notifikasi. Semua artikel berada dalam build ini; tidak memerlukan layanan search, CDN, atau server docs lain.
                     </p>
                     <p>
                        Dokumentasi statis tersedia sebelum login. Konfigurasi, inventory, dan API aplikasi tetap memerlukan autentikasi. Hasil uji
                        otomatis bukan sertifikasi production.
                     </p>
                     <div className={classes.cards}>
                        {docCategories.map((category) => (
                           <Link key={category.id} to={'/docs/' + category.articles[0].slug}>
                              <h2>{category.title}</h2>
                              <span>{category.articles.length} artikel</span>
                           </Link>
                        ))}
                     </div>
                  </>
               ) : article ? (
                  <>
                     <nav aria-label="Breadcrumb" className={classes.breadcrumb}>
                        <Link to="/docs">Documentation</Link> /{' '}
                        <Link to={'/docs/' + docCategories.find((c) => c.id === article.categoryId)!.articles[0].slug}>{article.categoryTitle}</Link>{' '}
                        / <span aria-current="page">{article.title}</span>
                     </nav>
                     <p className={classes.support}>{supportLabels[article.support]}</p>
                     <Markdown key={article.slug} tokens={article.tokens} />
                     <nav className={classes.previousNext} aria-label="Artikel sebelumnya dan berikutnya">
                        {ordinal > 0 && <Link to={'/docs/' + docsIndex[ordinal - 1].slug}>← Sebelumnya: {docsIndex[ordinal - 1].title}</Link>}
                        {ordinal < docsIndex.length - 1 && (
                           <Link to={'/docs/' + docsIndex[ordinal + 1].slug}>Berikutnya: {docsIndex[ordinal + 1].title} →</Link>
                        )}
                     </nav>
                  </>
               ) : (
                  <>
                     <h1>Artikel tidak ditemukan</h1>
                     <p>URL dokumentasi ini tidak terdaftar. Gunakan pencarian atau kategori di samping.</p>
                     <Link to="/docs">Kembali ke beranda dokumentasi</Link>
                  </>
               )}
            </main>
            <aside className={classes.toc}>
               <nav aria-label="Daftar isi artikel">
                  {article && (
                     <>
                        <h2>Di halaman ini</h2>
                        <ul>
                           {article.headings
                              .filter((h) => h.depth > 1)
                              .map((h) => (
                                 <li key={h.id} className={h.depth > 2 ? classes.nested : ''}>
                                    <a href={'#' + h.id}>{h.text}</a>
                                 </li>
                              ))}
                        </ul>
                     </>
                  )}
               </nav>
            </aside>
         </div>
         <Footer
            version={typeof window === 'undefined' ? undefined : (window as any).plutonVersion}
            revision={typeof window === 'undefined' ? undefined : (window as any).plutonRevision}
         />
      </div>
   );
}
