// tests/install-global.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isolatedEnv, makeTempRepo, runCli } from './helpers.mjs';

const rd = (p) => readFile(p, 'utf8');

test('fresh global install sets hooksPath and copies exactly HOOK_FILES', async (t) => {
  const { base } = await makeTempRepo(t);
  const target = path.join(base, 'opt', 'gitblock', 'hooks');
  const r = runCli(['--install', target, '--yolo'], { env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const f of ['commit-msg', 'prepare-commit-msg', 'validate-commit.mjs']) {
    assert.match(await rd(path.join(target, f)), /./);
  }
  assert.match(await rd(path.join(path.dirname(target), 'config.yaml')), /enabled:/);
});

test('foreign hook file aborts without --force, untouched', async (t) => {
  const { base } = await makeTempRepo(t);
  const target = path.join(base, 'opt', 'gitblock', 'hooks');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'commit-msg'), '#!/bin/sh\necho custom\n');
  const r = runCli(['--install', target, '--yolo'], { env: isolatedEnv(base) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /commit-msg/);
  assert.match(r.stderr, /--force/);
  assert.equal(await rd(path.join(target, 'commit-msg')), '#!/bin/sh\necho custom\n');
});

test('--force overwrites foreign file with timestamped backup', async (t) => {
  const { base } = await makeTempRepo(t);
  const target = path.join(base, 'opt', 'gitblock', 'hooks');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'commit-msg'), '#!/bin/sh\necho custom\n');
  const r = runCli(['--install', target, '--yolo', '--force'], { env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok((await readdir(target)).some((f) => /^commit-msg\.bak-\d+$/.test(f)));
});

test('reinstall over our own files is silent and idempotent', async (t) => {
  const { base } = await makeTempRepo(t);
  const target = path.join(base, 'opt', 'gitblock', 'hooks');
  assert.equal(runCli(['--install', target, '--yolo'], { env: isolatedEnv(base) }).status, 0);
  const r = runCli(['--install', target, '--yolo'], { env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/\.bak-/.test(r.stdout));
});
