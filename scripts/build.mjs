import { build } from 'esbuild';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { buildMetadata, metadataBanner } from './metadata.mjs';

const metadata = buildMetadata(JSON.parse(await readFile('package.json', 'utf8')));

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/runtime.ts'],
  outfile: 'dist/Code.js',
  bundle: true,
  format: 'iife',
  globalName: 'Bot',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  target: 'es2020',
  banner: { js: metadataBanner(metadata) },
  define: { __BUILD_METADATA__: JSON.stringify(metadata) },
  footer: { js: `
function doPost(e) { return Bot.doPost(e); }
function setup() { return Bot.setup(); }
function flushPending() { return Bot.flushPending(); }
function webhookStatus() { return Bot.webhookStatus(); }
function recoverAdmin() { return Bot.recoverAdmin(); }
` },
});
await copyFile('appsscript.json', 'dist/appsscript.json');
await copyFile('.claspignore', 'dist/.claspignore');
