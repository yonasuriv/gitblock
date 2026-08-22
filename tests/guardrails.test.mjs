// tests/guardrails.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyTarget, backupFile, normalizeContent, SOURCE_HOOKS_DIR } from '../gitblock.mjs';

async function tmp(t) {
  return mkdtemp(path.join(tmpdir(), 'gb-gr-'));
}

test('normalizeContent trims CRLF and trailing whitespace', () => {
  assert.equal(normalizeContent('a\r\nb\r\n'), 'a\nb');
});

test('identical copy classifies as ours', async (t) => {
  const dir = await tmp(t);
  const src = path.join(SOURCE_HOOKS_DIR, 'commit-msg');
  const dest = path.join(dir, 'commit-msg');
  await writeFile(dest, await readFile(src));
  assert.equal(await classifyTarget(dest, src), 'ours');
});

test('edited copy classifies as foreign', async (t) => {
  const dir = await tmp(t);
  const dest = path.join(dir, 'commit-msg');
  await writeFile(dest, '#!/bin/sh\necho mine\n');
  assert.equal(await classifyTarget(dest, path.join(SOURCE_HOOKS_DIR, 'commit-msg')), 'foreign');
});

test('missing file classifies as absent', async (t) => {
  const dir = await tmp(t);
  assert.equal(
    await classifyTarget(path.join(dir, 'commit-msg'), path.join(SOURCE_HOOKS_DIR, 'commit-msg')),
    'absent',
  );
});

test('backupFile writes timestamped copy; null when absent', async (t) => {
  const dir = await tmp(t);
  const dest = path.join(dir, 'commit-msg');
  assert.equal(await backupFile(path.join(dir, 'nope')), null);
  await writeFile(dest, 'mine');
  const bak = await backupFile(dest);
  assert.match(bak, /commit-msg\.bak-\d+$/);
  assert.equal(await readFile(bak, 'utf8'), 'mine');
});
