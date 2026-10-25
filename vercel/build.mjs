// Builds the web app for Vercel's Build Output API (https://vercel.com/docs/build-output-api):
// the Vite pages as static files, and the /api routes as one bundled Node function.
// Run by `vercel build` (see vercel.json) and by every push to main.
//
// One repository, two Vercel projects: anchorcare (this web app) and anchorcare-agent
// (the voice agent), which sets ANCHORCARE_APP=agent so a push deploys each its own app.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

if (process.env.ANCHORCARE_APP === 'agent') {
  await import('./agent-build.mjs');
  process.exit(0);
}

const out = '.vercel/output';
rmSync(out, { recursive: true, force: true });

execSync('npx vite build', { stdio: 'inherit' });
cpSync('dist', `${out}/static`, { recursive: true });

const fn = `${out}/functions/api.func`;
mkdirSync(fn, { recursive: true });
await build({
  entryPoints: ['vercel/handler.ts'], outfile: `${fn}/index.mjs`,
  bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'info',
  // The MongoDB driver's optional add-ons, and the dev server, are never loaded here.
  external: ['vite', 'kerberos', 'snappy', 'aws4', 'socks', 'mongodb-client-encryption', '@mongodb-js/zstd', '@aws-sdk/credential-providers'],
  // Bundled CommonJS packages still call require() for Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
writeFileSync(`${fn}/.vc-config.json`, JSON.stringify({
  runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false,
  maxDuration: 120,                        // a checked answer can take up to 90 s
  regions: ['lhr1'],                       // beside the Atlas cluster (GCP europe-west2, London)
  supportsResponseStreaming: true,
}, null, 2));
writeFileSync(`${fn}/package.json`, JSON.stringify({ type: 'module' }));

const security = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" };
writeFileSync(`${out}/config.json`, JSON.stringify({
  version: 3,
  routes: [
    { src: '/api(?:/.*)?', dest: '/api' },
    { src: '/(.*)', headers: security, continue: true },
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/index.html' },              // the React app routes its own pages
  ],
}, null, 2));
console.log(`Vercel output written to ${out}`);
