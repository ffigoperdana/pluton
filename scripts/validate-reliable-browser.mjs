// Disposable loopback-only Chrome/CDP acceptance. No credentials or provider access.
// Build the production frontend first. CHROME_PATH selects a local Chromium binary.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicPath = path.resolve(root, process.env.PLUTON_BROWSER_DIST || 'frontend/dist');
const chromePath = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium');
await fs.access(chromePath);
await fs.access(path.join(publicPath, 'sw.js'));
const back = createRequire(path.join(root, 'backend/package.json'));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pluton-browser-download-'));
const baseline = process.argv.includes('--expect-baseline-failure');
const fixtureSecret = crypto.randomBytes(32).toString('hex');
Object.assign(process.env, {
  NODE_ENV: 'test', PLUTON_DATA_DIR: path.join(directory, 'data'),
  SECRET: fixtureSecret, APIKEY: crypto.randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: fixtureSecret, PLUTON_ENCRYPTION_KEY: fixtureSecret,
  USER_NAME: 'fixture-user', PLUTON_USER_NAME: 'fixture-user',
  USER_PASSWORD: fixtureSecret, PLUTON_USER_PASSWORD: fixtureSecret,
});
const unregister = back('tsx/cjs/api').register();
const express = back('express'), jwt = back('jsonwebtoken');
const { ManagedExportService } = back('./src/services/ManagedExportService.ts');
const { ManagedExportStore } = back('./src/stores/ManagedExportStore.ts');
const { ManagedExportController } = back('./src/controllers/ManagedExportController.ts');
const { createManagedExportRouter } = back('./src/routes/managedExports.ts');
const { registerSpaFallback } = back('./src/utils/spaFallback.ts');
const { exportConfiguration } = back('./src/utils/managedExport/ExportPolicy.ts');
const { Readable } = await import('node:stream');
// Real synthetic TAR, not an arbitrary blob; native encrypted/TLS lab is separate.
const pack = back('tar-stream').pack(), chunks = [];
pack.entry({ name: 'example.txt', size: 1024 * 1024 }, Buffer.alloc(1024 * 1024, 42));
pack.finalize();
for await (const chunk of pack) chunks.push(chunk);
const data = Buffer.concat(chunks), sha256 = crypto.createHash('sha256').update(data).digest('hex');
const binding = { backupId: 'backup-01', planId: 'plan-01', sourceId: 'app-01', repositoryId: 'repository-01', snapshotId: 'a'.repeat(64), mode: 'full' };
const config = exportConfiguration({ MANAGED_EXPORT_ENABLED: 'true', MANAGED_EXPORT_ENDPOINT: 'https://s3.example.internal',
  MANAGED_EXPORT_BUCKET: 'example-private', MANAGED_EXPORT_ACCESS_KEY_ID: crypto.randomBytes(12).toString('hex'),
  MANAGED_EXPORT_SECRET_ACCESS_KEY: crypto.randomBytes(32).toString('hex') });
const store = new ManagedExportStore(path.join(directory, 'jobs.sqlite'));
const storage = {
  identity: async () => {}, close: () => {},
  get: async (_job, _signal, range) => {
    const m = range && /^bytes=(\d+)-(\d+)$/.exec(range), start = m ? Number(m[1]) : 0, end = m ? Number(m[2]) : data.length - 1;
    return { Body: Readable.from([data.subarray(start, end + 1)]), ContentLength: end - start + 1,
      ContentRange: range ? `bytes ${start}-${end}/${data.length}` : undefined, $metadata: { httpStatusCode: range ? 206 : 200 } };
  },
};
const service = new ManagedExportService(store, { exportBindingFor: async () => binding }, () => config, async () => {}, () => storage);
const job = store.admit(crypto.createHash('sha256').update('fixture-user').digest('hex'), binding, config);
const summary = { version: 1, binding, mode: 'full', includedEntries: 1, excludedEntries: 0, includedByType: { file: 1 }, excludedByType: {},
  manifestSha256: 'b'.repeat(64), archiveSha256: sha256, archiveBytes: data.length };
store.update(job.id, { state: 'ready', integrity: 'verified', integrityMode: 'application-encrypted-hcp',
  versionId: 'synthetic-version', etag: '"synthetic-ciphertext"',
  summary, processedBytes: data.length, uploadedBytes: data.length, totalBytes: data.length, expiresAt: Date.now() + 3600000 });
const app = express(), requests = [];
let fault;
app.use(express.json());
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    requests.push({ method: req.method, path: req.path, status: undefined, location: undefined });
    const record = requests.at(-1);
    res.on('finish', () => { record.status = res.statusCode; record.location = res.getHeader('Location'); });
    if (fault && req.path.endsWith(fault.suffix) && (!fault.method || req.method === fault.method)) {
      if (fault.location) return res.redirect(303, fault.location);
      if (fault.html) return res.status(fault.status).type('html').send('<html>private-gateway-body</html>');
      return res.status(fault.status).json({ success: false, reason: fault.reason });
    }
  }
  next();
});
app.use('/api/backups', createManagedExportRouter(new ManagedExportController(service)));
app.get('/api/managed-exports/activity', async (req, res) => {
  const { exportOwner } = back('./src/controllers/ManagedExportController.ts');
  try { res.json({ success: true, result: await service.activity(exportOwner(req, res)) }); }
  catch { res.status(401).json({ success: false }); }
});
const bundle = await back('esbuild').build({
  stdin: { resolveDir: path.join(root, 'frontend'), loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import Reliable from './src/components/Plan/Backups/ReliableDownload';
    import Tracker from './src/components/App/ExportActivity/ExportActivity';
    import {ExportActivityProvider} from './src/context/ExportActivityContext';
    import {BrowserRouter} from 'react-router';
    import NotFound from './src/routes/NotFoundRoute/NotFoundRoute';
    const api = ${JSON.stringify(`/api/backups/${binding.backupId}/exports/${job.id}`)};
    const apiPage = location.pathname.startsWith('/api/');
    createRoot(document.getElementById('root')).render(<BrowserRouter>{apiPage ? <NotFound/> : <ExportActivityProvider>
      <h1>Disposable download fixture</h1><a id="legacy-link" href={api+'/link'}>Native link redirect</a>
      <Reliable backupId="backup-01" mode="full" initialId=${JSON.stringify(job.id)} close={()=>{}}/><Tracker/>
    </ExportActivityProvider>}</BrowserRouter>);
    navigator.serviceWorker.register('/sw.js');
  ` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
  define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'fixture-style', setup(build) {
    build.onLoad({ filter: /\.scss$/ }, () => ({ loader: 'js', contents: 'export default {}' }));
    build.onLoad({ filter: /[\\/]utils[\\/]constants\.ts$/ }, () => ({ loader: 'js', contents: 'export const API_URL=location.origin+"/api"' }));
    build.onLoad({ filter: /[\\/]Icon\.tsx$/ }, () => ({ loader: 'js', contents: 'export default ()=>null' }));
  } }],
});
app.get('/fixture.js', (_req, res) => res.type('js').send(bundle.outputFiles[0].text));
app.get(['/', '/index.html'], (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script>'));
app.use(express.static(publicPath));
registerSpaFallback(app, publicPath);
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--disable-extensions',
  '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--user-data-dir=' + path.join(directory, 'profile'), 'about:blank'],
  { windowsHide: true, stdio: 'ignore' });
let ws, sequence = 0;
const pending = new Map(), events = [];
async function until(check, label, ms = 20000) {
  const end = Date.now() + ms;
  do { const value = await check(); if (value) return value; await delay(50); } while (Date.now() < end);
  throw new Error('Browser acceptance deadline: ' + label);
}
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP deadline: ' + method)); }, 20000);
    pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
try {
  const port = await until(async () => fs.readFile(path.join(directory, 'profile/DevToolsActivePort'), 'utf8').catch(() => ''), 'Chrome startup');
  const [number, suffix] = port.trim().split('\n');
  ws = new WebSocket(`ws://127.0.0.1:${number}${suffix}`);
  ws.onmessage = ({ data }) => { const m = JSON.parse(data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); if (p) m.error ? p.reject(new Error('CDP request failed')) : p.resolve(m.result); } else events.push(m); };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  const evaluate = async expression => {
    const value = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    assert(!value.exceptionDetails, 'Browser script failed'); return value.result.value;
  };
  await page('Page.enable'); await page('Network.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: path.join(directory, 'downloads'), eventsEnabled: true });
  await page('Network.setCookie', { name: 'token', value: jwt.sign({ user: 'fixture-user' }, process.env.SECRET, { expiresIn: '5m' }), url: origin, httpOnly: true, sameSite: 'Lax' });
  await page('Page.navigate', { url: origin });
  await until(() => evaluate('!!navigator.serviceWorker.controller'), 'controlling production service worker');
  await until(() => evaluate('!!document.getElementById("legacy-link")'), 'fixture mounted');
  const before = requests.length;
  await evaluate('document.getElementById("legacy-link").click()');
  if (baseline) {
    await until(() => evaluate('!!document.querySelector("h1") && document.querySelector("h1").textContent==="404" && document.body.textContent.includes("Page Not Found")'), 'baseline SPA 404');
    assert.equal(requests.slice(before).filter(r => /\/(link|content)$/.test(r.path)).length, 0);
    console.log('PASS baseline reproduced: controlled navigation returned cached SPA 404; zero link/content requests reached backend.');
  } else {
    const completed = await until(() => events.find(e => e.method === 'Browser.downloadProgress' && e.params.state === 'completed'), 'redirect download complete');
    const received = await fs.readFile(path.join(directory, 'downloads', completed.params.guid));
    assert.equal(received.length, data.length); assert.equal(crypto.createHash('sha256').update(received).digest('hex'), sha256);
    const chain = requests.slice(before).filter(r => /\/(link|content)$/.test(r.path));
    assert.equal(chain[0].status, 303); assert.equal(chain[0].location, `/api/backups/backup-01/exports/${job.id}/content`);
    assert.equal(chain[1].status, 200);
    console.log('PASS production service worker + native navigation: authenticated 303 -> content 200; complete TAR size and SHA-256 match.');
    const click = async (label, dialog = false) => {
      await until(() => evaluate(`!![...((${dialog} ? document.querySelector('[role="dialog"]') : document)?.querySelectorAll('button') || [])].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`), 'enabled download action');
      await evaluate(`{ const b=[...((${dialog} ? document.querySelector('[role="dialog"]') : document).querySelectorAll('button'))].find(b=>b.textContent.trim()===${JSON.stringify(label)}); b.click(); b.click(); }`);
    };
    const download = async action => {
      const count = events.length, start = requests.length;
      await action();
      const done = await until(() => events.slice(count).find(e => e.method === 'Browser.downloadProgress' && e.params.state === 'completed'), 'UI download complete');
      const file = await fs.readFile(path.join(directory, 'downloads', done.params.guid));
      assert.equal(file.length, data.length); assert.equal(crypto.createHash('sha256').update(file).digest('hex'), sha256);
      assert.equal(await evaluate('location.pathname'), '/');
      return requests.slice(start);
    };
    const modal = await download(() => click('Download Verified TAR'));
    assert.equal(modal.filter(r => r.path.endsWith('/authorization')).length, 1);
    assert.equal(modal.filter(r => r.method === 'HEAD' && r.path.endsWith('/content')).length, 1);
    assert.equal(modal.filter(r => r.method === 'GET' && r.path.endsWith('/content')).length, 1);
    assert.equal(await evaluate('document.body.textContent.includes("Download requested.")'), true);
    console.log('PASS real Ready component: duplicate click admits no job, authorizes once, checks HEAD, browser saves complete TAR.');
    await page('Page.reload');
    await until(() => evaluate('!![...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Download Verified TAR")'), 'GET rediscovery after refresh');
    await click('Exports · 1');
    await until(() => evaluate('!!document.querySelector("li button strong")'), 'tracker list');
    await evaluate('document.querySelector("li button strong").closest("button").click()');
    const tracker = await download(() => click('Download Verified TAR', true));
    assert.equal(tracker.filter(r => r.path.endsWith('/authorization')).length, 1);
    assert.equal(requests.filter(r => r.method === 'POST' && /\/exports$|\/preflights|\/inventory-checks/.test(r.path)).length, 0);
    console.log('PASS floating tracker and refresh: exact existing Ready job recovered by GET; browser file size/SHA match; no admission/preflight.');
    const renewalStart = requests.length;
    await click('Get or renew resume link', true);
    await until(() => evaluate('!!document.querySelector(\'input[aria-label="Private resume link"]\')'), 'explicit resume-link renewal');
    assert.equal(await evaluate('document.querySelector(\'input[aria-label="Private resume link"]\').value'), `${origin}/api/backups/backup-01/exports/${job.id}/content`);
    assert.equal(requests.slice(renewalStart).filter(r => r.path.endsWith('/authorization')).length, 1);
    assert.equal(requests.slice(renewalStart).filter(r => r.path.endsWith('/content')).length, 0);
    const content = `/api/backups/backup-01/exports/${job.id}/content`;
    const ranges = await evaluate(`(async()=>{
      const head=await fetch(${JSON.stringify(content)},{method:'HEAD'}), etag=head.headers.get('ETag');
      const results=[];
      for(const [range,ifRange] of [['bytes=0-0',etag],['bytes=1-',etag],['bytes=1-','"old"'],['bytes=${data.length}-',etag]]){
        const r=await fetch(${JSON.stringify(content)},{headers:{Range:range,'If-Range':ifRange}});
        results.push({status:r.status,range:r.headers.get('Content-Range'),length:(await r.arrayBuffer()).byteLength});
      }return {head:head.status,results};
    })()`);
    assert.equal(ranges.head, 200);
    assert.deepEqual(ranges.results.map(r => r.status), [206,206,200,416]);
    assert.equal(ranges.results[0].length, 1); assert.equal(ranges.results[1].length, data.length - 1);
    assert.equal(ranges.results[1].range, `bytes 1-${data.length - 1}/${data.length}`);
    console.log('PASS actual browser HEAD, strict Range 206/resume, stale If-Range full 200 and invalid Range 416.');
    for (const f of [
      {status:409,reason:'storage-unavailable',match:'Temporary storage is unavailable'},
      {status:409,reason:'object-mismatch',match:'Object integrity or identity verification failed'},
      {status:410,reason:'expired',match:'The export expired'},
      {status:401,match:'Your session has expired'}, {status:403,match:'Access denied'},
      {status:429,match:'Too many requests'}, {status:409,match:'HTTP 409'},
      {status:405,html:true,match:'HTTP 405'}, {status:503,html:true,match:'HTTP 503'},
      {status:200,html:true,match:'HTTP 200'}, {location:'/login',match:'redirected unexpectedly'},
    ]) {
      fault = {suffix:'/authorization',...f};
      const start = requests.length, count = events.length;
      await click('Download Verified TAR', true);
      await until(() => evaluate(`document.querySelector('[role="dialog"]').textContent.includes(${JSON.stringify(f.match)})`), 'actionable authorization error');
      assert.equal(requests.slice(start).filter(r => r.path.endsWith('/authorization')).length, 1);
      assert.equal(requests.slice(start).filter(r => r.path.endsWith('/content')).length, 0);
      assert(!events.slice(count).some(e => e.method === 'Browser.downloadWillBegin'));
      assert.equal(await evaluate('location.pathname'), '/');
      assert.equal(await evaluate('document.body.textContent.includes("private-gateway-body")'), false);
    }
    for (const f of [{status:503,html:true}, {status:200,html:true}, {location:'/login'}]) {
      fault = {suffix:'/content',...f};
      const start = requests.length, count = events.length;
      await click('Download Verified TAR', true);
      await until(() => evaluate('!!document.querySelector(\'[role="dialog"] [role="alert"]\')'), 'HEAD rejection displayed');
      assert.equal(requests.slice(start).filter(r => r.path.endsWith('/content') && r.method === 'GET').length, 0);
      assert(!events.slice(count).some(e => e.method === 'Browser.downloadWillBegin'));
      assert.equal(await evaluate('location.pathname'), '/');
    }
    fault = undefined;
    await download(() => click('Download Verified TAR', true));
    console.log('PASS 409 reasons, expiry, session/permission, rate limit, HTML, method rejection, ingress redirect and HEAD failures stay actionable; explicit retry succeeds.');
    // A race after a successful HEAD belongs to the native transfer, not a fake UI success.
    fault = { suffix:'/content', method:'GET', status:503, html:true };
    const start = requests.length, count = events.length;
    await click('Download Verified TAR', true);
    await until(() => requests.slice(start).some(r => r.method === 'GET' && r.path.endsWith('/content') && r.status === 503), 'native GET rejection');
    assert.equal(await evaluate('location.pathname'), '/');
    assert.equal(await evaluate('document.querySelector(\'[role="dialog"]\').textContent.includes("cannot confirm that the file has finished downloading")'), true);
    assert(!events.slice(count).some(e => e.method === 'Browser.downloadProgress' && e.params.state === 'completed'));
    assert(!requests.some(r => r.method === 'POST' && !r.path.endsWith('/authorization')));
    console.log('PASS GET failure after HEAD: no false completed transfer; application stays open and points to browser transfer errors.');
  }
} finally {
  if (ws?.readyState === WebSocket.OPEN) { await send('Browser.close').catch(() => {}); ws.close(); }
  chrome.kill();
  await service.shutdown();
  await new Promise(resolve => server.close(resolve));
  unregister();
  // Only remove the exact new temporary fixture; never traverse workspace junctions.
  const actualFixture = await fs.realpath(directory);
  assert.equal(path.dirname(actualFixture), await fs.realpath(os.tmpdir()));
  assert(path.basename(actualFixture).startsWith('pluton-browser-download-'));
  await until(async () => { try { await fs.rm(directory, { recursive: true, force: true }); return true; } catch { return false; } }, 'temporary browser cleanup');
}
