import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

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
