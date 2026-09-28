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
console.log('Apps Script bundle loads without Node globals; all entrypoints are available.');
