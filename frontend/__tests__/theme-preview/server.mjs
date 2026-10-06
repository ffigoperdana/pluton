// Run from frontend: node __tests__/theme-preview/server.mjs
// No backend is started; all APIs are synthetic and unknown requests fail closed.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { comlink } from 'vite-plugin-comlink';
import { fileURLToPath } from 'node:url';

const server = await createServer({
   configFile: false,
   root: fileURLToPath(new URL('../../', import.meta.url)),
   mode: 'production',
   plugins: [
      react(),
      comlink(),
      {
         name: 'synthetic-theme-preview',
         resolveId(id) {
            if (id === 'virtual:pwa-register/react') return '\0theme-preview-pwa';
         },
         load(id) {
            if (id === '\0theme-preview-pwa')
               return 'export const useRegisterSW = () => ({ offlineReady: [false, () => {}], needRefresh: [false, () => {}], updateServiceWorker: () => {} });';
         },
         configureServer(vite) {
            vite.middlewares.use('/api', (_request, response) => {
               response.statusCode = 501;
               response.setHeader('Content-Type', 'application/json');
               response.end(JSON.stringify({ success: false, error: 'No live API is available in the synthetic theme preview.' }));
            });
         },
      },
   ],
   server: { host: '127.0.0.1', port: 5188, strictPort: true },
});
await server.listen();
console.log('Synthetic theme preview: http://127.0.0.1:5188/__tests__/theme-preview/index.html');
