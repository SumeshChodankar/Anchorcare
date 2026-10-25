// Builds the voice agent's capture page and API for Vercel's Build Output API, as its own
// project (the web app is vercel/build.mjs). Every path goes to one bundled function,
// so the hosted URL behaves like http://127.0.0.1:4319/.
//
//   node vercel/agent-build.mjs
//   npx vercel@65.2.0 deploy --prebuilt --prod --cwd vercel/agent
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const out = 'vercel/agent/.vercel/output';
rmSync(out, { recursive: true, force: true });

const fn = `${out}/functions/agent.func`;
mkdirSync(fn, { recursive: true });
await build({
  entryPoints: ['vercel/agent-handler.js'], outfile: `${fn}/index.mjs`,
  bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'info',
  // The MongoDB driver's optional add-ons are never loaded here.
  external: ['kerberos', 'snappy', 'aws4', 'socks', 'mongodb-client-encryption', '@mongodb-js/zstd', '@aws-sdk/credential-providers'],
  // Bundled CommonJS packages still call require() for Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
// The daemon reads its page and the in-browser voice detector from beside itself.
cpSync('agent/capture.html', `${fn}/capture.html`);
cpSync('agent/voice-capture.js', `${fn}/voice-capture.js`);
writeFileSync(`${fn}/.vc-config.json`, JSON.stringify({
  runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false,
  maxDuration: 300,                        // the page's live event stream reconnects after this
  regions: ['lhr1'],                       // beside the Atlas cluster (GCP europe-west2, London)
  supportsResponseStreaming: true,
}, null, 2));
writeFileSync(`${fn}/package.json`, JSON.stringify({ type: 'module' }));

writeFileSync(`${out}/config.json`, JSON.stringify({
  version: 3,
  routes: [
    { src: '/(.*)', headers: { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' }, continue: true },
    { src: '/(.*)', dest: '/agent' },
  ],
}, null, 2));
console.log(`Vercel output written to ${out}`);
