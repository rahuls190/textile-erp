import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'ui/out');
mkdirSync(resolve(out, 'engine'), { recursive: true });

const shim = {
  name: 'browser-shims',
  setup(b) {
    const to = (re, file) => b.onResolve({ filter: re }, () => ({ path: resolve(root, file) }));
    to(/^node:crypto$/, 'ui/shims/crypto.ts');
    to(/(^|\/)password(\.js)?$/, 'ui/shims/password.ts');
    to(/(^|\/)migrate(\.js)?$/, 'ui/shims/migrate.ts');
  },
};
const sig = createHash('sha1').update(readFileSync(resolve(root, 'src/db/migrations/001_init.sql'))).update(readFileSync(resolve(root, 'src/db/migrations/002_admin_hr.sql'))).update(readFileSync(resolve(root, 'src/seed/hr-demo.ts'))).update(readFileSync(resolve(root, 'src/seed/demo.ts'))).update(readFileSync(resolve(root, 'src/seed/rbac.ts'))).update(readFileSync(resolve(root, 'src/db/migrations/003_preferences.sql'))).update(readFileSync(resolve(root, 'src/db/migrations/004_owner_escalation.sql'))).update(readFileSync(resolve(root, 'src/seed/owner-demo.ts'))).update(readFileSync(resolve(root, 'src/db/migrations/005_custom_reports.sql'))).update(readFileSync(resolve(root, 'src/db/migrations/006_crm_sales.sql'))).update(readFileSync(resolve(root, 'src/seed/sales-demo.ts'))).update('v7').digest('hex').slice(0, 8);
await build({
  entryPoints: [resolve(root, 'ui/main.ts')],
  outfile: resolve(out, 'app.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none',
  loader: { '.sql': 'text' },
  define: { __BUILD_ID__: JSON.stringify(sig), 'process.env.NODE_ENV': '"production"' },
  plugins: [shim],
  logLevel: 'warning',
});
const pg = resolve(root, 'node_modules/@electric-sql/pglite/dist');
copyFileSync(resolve(root, 'ui/kalyani-logo.png'), resolve(out, 'kalyani-logo.png'));
for (const [f, to] of [['pglite.wasm', 'pglite.wasm'], ['initdb.wasm', 'initdb.wasm'], ['pglite.data', 'pglite-data.ogg']]) copyFileSync(resolve(pg, f), resolve(out, 'engine', to));
import { execFileSync } from 'node:child_process';
execFileSync('npx', ['tsx', 'ui/make-snapshot.ts'], { cwd: root, stdio: 'inherit' });
console.log('built', sig);
