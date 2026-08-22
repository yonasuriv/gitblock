import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from './helpers.mjs';

test('cli prints usage with no args', () => {
  const r = runCli([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});
