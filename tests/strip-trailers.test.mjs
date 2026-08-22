import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTrailers } from '../gitblock.mjs';

test('strips a trailer block', () => {
  assert.equal(stripTrailers('add thing\n\nCo-authored-by: Bob <b@x.y>\n'), 'add thing\n');
});

test('preserves body when trailer not separated by blank line', () => {
  const msg = 'subject\n\nbody line\nSigned-off-by: X <x@y.z>\n';
  assert.equal(stripTrailers(msg), msg);
});

test('subject-only conventional commit is kept', () => {
  const msg = 'chore: update deps\n';
  assert.equal(stripTrailers(msg), msg);
});
