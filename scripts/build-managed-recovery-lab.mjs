/** Build only disposable fixture code against the production image's compiled modules. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../backend/package.json', import.meta.url));
const { build } = require('esbuild');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'tmp', 'managed-recovery-runtime-fixture');
await fs.mkdir(output, { recursive: true });
for (const name of ['lab', 'restart']) {
   await build({
      entryPoints: [path.join(root, 'backend', '__tests__', 'integration', `managedDownloadRecovery.${name}.ts`)],
      outfile: path.join(output, `managedDownloadRecovery.${name}.mjs`),
      bundle: true, platform: 'node', format: 'esm', packages: 'external',
      plugins: [{
         name: 'production-runtime-fixture',
         setup(builder) {
            builder.onResolve({ filter: /^(?:\.\.\/)+src\// }, args => ({
               path: `/app/backend/dist/${args.path.replace(/^(?:\.\.\/)+src\//, '')}.js`, external: true,
            }));
            builder.onLoad({ filter: /managedDownloadRecovery\.(lab|restart)\.ts$/ }, async args => {
               const original = await fs.readFile(args.path, 'utf8');
               const contents = original.replace(/(assert\.equal\(\s*process\.getuid\?\.\(\),\s*)1000\b/, (_match, prefix) => `${prefix}10001`)
                  .replaceAll('managedDownloadRecovery.restart.ts', 'managedDownloadRecovery.restart.mjs');
               if (contents === original) throw new Error('Runtime fixture UID assertion was not adapted.');
               return { contents, loader: 'ts' };
            });
         },
      }],
   });
}
console.log('Built disposable UID-10001 fixtures; application modules remain external compiled production imports.');
