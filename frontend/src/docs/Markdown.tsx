import { createElement, Fragment, useState } from 'react';
import { Link } from 'react-router';
import { safeDocUrl, type DocToken } from './model';
import classes from './Docs.module.scss';

function CodeBlock({ text, language }: { text: string; language?: string }) {
   const [status, setStatus] = useState('Salin');
   const copy = async () => {
      try {
         if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
         else {
            // Trusted-LAN HTTP can lack Clipboard API. Only copy static bundled text.
            const field = document.createElement('textarea');
            field.value = text;
            field.style.position = 'fixed';
            field.style.opacity = '0';
            document.body.appendChild(field);
            try {
               field.select();
               if (!document.execCommand('copy')) throw new Error('Unavailable');
            } finally {
               field.remove();
            }
         }
         setStatus('Tersalin');
      } catch {
         setStatus('Pilih teks untuk menyalin');
      }
   };
   return (
      <div className={classes.code}>
         <div>
            <span>{language || 'text'}</span>
            <button type="button" onClick={copy} aria-label="Salin contoh kode">
               {status}
            </button>
         </div>
         <pre>
            <code>{text}</code>
         </pre>
         <span className={classes.srOnly} aria-live="polite">
            {status}
         </span>
      </div>
   );
}
/** React constructs every element; Markdown HTML is displayed as text, never executed. */
export default function Markdown({ tokens }: { tokens: DocToken[] }) {
   const children = (token: DocToken) => (token.tokens ? <Markdown tokens={token.tokens} /> : token.text || '');
   return (
      <>
         {tokens.map((token, i) => {
            switch (token.type) {
               case 'space':
                  return null;
               case 'heading':
                  return createElement(
                     `h${Math.min(6, Math.max(1, token.depth || 2))}`,
                     { id: token.anchor, key: i, tabIndex: -1 },
                     children(token),
                     <a href={'#' + token.anchor} aria-label={`Tautan bagian ${token.text}`} className={classes.headingLink}>
                        {' '}
                        #
                     </a>,
                  );
               case 'paragraph':
                  return <p key={i}>{children(token)}</p>;
               case 'text':
                  return <Fragment key={i}>{children(token)}</Fragment>;
               case 'strong':
                  return <strong key={i}>{children(token)}</strong>;
               case 'em':
                  return <em key={i}>{children(token)}</em>;
               case 'del':
                  return <del key={i}>{children(token)}</del>;
               case 'codespan':
                  return <code key={i}>{token.text}</code>;
               case 'code':
                  return <CodeBlock key={i} text={token.text || ''} language={token.lang} />;
               case 'br':
                  return <br key={i} />;
               case 'hr':
                  return <hr key={i} />;
               case 'blockquote':
                  return <blockquote key={i}>{children(token)}</blockquote>;
               case 'list':
                  return createElement(
                     token.ordered ? 'ol' : 'ul',
                     { key: i, start: token.ordered ? token.start : undefined },
                     token.items?.map((item, j) => (
                        <li key={j}>
                           {item.task && <input type="checkbox" checked={!!item.checked} disabled aria-label="Checklist dokumentasi" />}
                           <Markdown tokens={item.tokens || []} />
                        </li>
                     )),
                  );
               case 'link': {
                  const href = safeDocUrl(token.href);
                  if (!href) return <Fragment key={i}>{children(token)}</Fragment>;
                  return href.startsWith('/docs') ? (
                     <Link key={i} to={href}>
                        {children(token)}
                     </Link>
                  ) : (
                     <a key={i} href={href} rel="noopener noreferrer">
                        {children(token)}
                     </a>
                  );
               }
               case 'image': {
                  const src = safeDocUrl(token.href, true);
                  return src ? <img key={i} src={src} alt={token.text || ''} loading="lazy" /> : <span key={i}>{token.text}</span>;
               }
               case 'table':
                  return (
                     <div className={classes.table} key={i}>
                        <table>
                           <thead>
                              <tr>
                                 {token.header?.map((cell, j) => (
                                    <th key={j} scope="col">
                                       <Markdown tokens={cell.tokens} />
                                    </th>
                                 ))}
                              </tr>
                           </thead>
                           <tbody>
                              {token.rows?.map((row, j) => (
                                 <tr key={j}>
                                    {row.map((cell, k) => (
                                       <td key={k}>
                                          <Markdown tokens={cell.tokens} />
                                       </td>
                                    ))}
                                 </tr>
                              ))}
                           </tbody>
                        </table>
                     </div>
                  );
               default:
                  return <Fragment key={i}>{token.raw || token.text || ''}</Fragment>;
            }
         })}
      </>
   );
}
