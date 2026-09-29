import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

// Apps Script has neither Node's require/process nor an ES module loader.
const source = await readFile('dist/Code.js', 'utf8');
const context = {};
runInNewContext(source, context, { timeout: 3000 });
for (const entrypoint of ['doPost', 'setup', 'flushPending', 'webhookStatus', 'recoverAdmin']) {
  assert.equal(typeof context[entrypoint], 'function', `Missing global entrypoint: ${entrypoint}`);
}
assert.equal(context.require, undefined);
assert.ok(source.startsWith('// Generated file; edit src/'), 'Missing leading generated-file comment');
const helpInfo = context.Bot.projectDetails();
for (const line of source.split('\n')) {
  if (!line.startsWith('//')) break;
  const field = /^\/\/ (?:Project|Description|Version|Revision|Repository): (.*)$/.exec(line);
  if (field) assert.ok(helpInfo.includes(field[1]), 'Bundle banner and bot help metadata differ');
}
console.log('Apps Script bundle loads without Node globals; entrypoints and shared project metadata are verified.');
