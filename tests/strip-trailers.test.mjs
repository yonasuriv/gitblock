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

// --- agent-attribution stripping ---

test('strips Generated-with attribution line and co-author without separator', () => {
  assert.equal(
    stripTrailers('feat: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\nCo-Authored-By: Claude <noreply@anthropic.com>\n'),
    'feat: x\n',
  );
});

test('strips Claude session trailers anywhere as their own line', () => {
  assert.equal(
    stripTrailers('feat: x\n\nbody text\nClaude-Session: https://claude.ai/code/session_abc\n'),
    'feat: x\n\nbody text\n',
  );
});

test('strips bare claude.ai URL lines', () => {
  assert.equal(
    stripTrailers('fix: y\n\nhttps://claude.ai/code/session_xyz\n'),
    'fix: y\n',
  );
});

test('keeps ordinary body prose mentioning claude in a sentence', () => {
  const msg = 'docs: explain tooling\n\nWe evaluated claude and other agents before choosing this approach.\n';
  assert.equal(stripTrailers(msg), msg);
});

test('attribution removal composes with trailer-block stripping', () => {
  assert.equal(
    stripTrailers('add thing\n\nbody\n\nReviewed-by: R <r@x.y>\n🤖 Generated with [Claude Code](https://claude.com)\n'),
    'add thing\n\nbody\n',
  );
});
