// tests/install-local.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolatedEnv, makeTempRepo, runCli } from './helpers.mjs';

const rd = (p) => readFile(p, 'utf8');
const git = (repo, ...args) =>
  spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim();

test('local install creates .githooks, config.yaml, sets local hooksPath', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  const r = runCli(['--install', '--local', '--yolo'], {
    cwd: repo,
    env: isolatedEnv(base),
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const f of ['commit-msg', 'prepare-commit-msg', 'validate-commit.mjs', 'config.yaml']) {
    assert.match(await rd(path.join(repo, '.githooks', f)), /./);
  }
  assert.equal(git(repo, 'config', '--local', '--get', 'core.hooksPath'), '.githooks');
});

test('hooks fire on commit in a locally-installed repo (trailers stripped)', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  runCli(['--install', '--local', '--yolo'], { cwd: repo, env: isolatedEnv(base) });
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@x.y');
  await writeFile(path.join(repo, 'a.txt'), 'x');
  spawnSync('git', ['add', 'a.txt'], { cwd: repo });
  const c = spawnSync(
    'git',
    ['commit', '-m', 'subject line\n\nCo-authored-by: Bob <b@x.y>'],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(c.status, 0, c.stderr);
  // `git log` trims away trailing newlines via the helper, so compare against
  // the bare subject; the point is that the trailer block was stripped.
  assert.equal(git(repo, 'log', '-1', '--format=%B'), 'subject line');
  assert.doesNotMatch(git(repo, 'log', '-1', '--format=%B'), /Co-authored-by/);
});

test('foreign file in empty .githooks aborts; --force backs up', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  await mkdir(path.join(repo, '.githooks'), { recursive: true });
  await writeFile(path.join(repo, '.githooks', 'commit-msg'), '#!/bin/sh\necho custom\n');
  let r = runCli(['--install', '--local', '--yolo'], { cwd: repo, env: isolatedEnv(base) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /commit-msg/);
  r = runCli(['--install', '--local', '--yolo', '--force'], { cwd: repo, env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);
});

test('existing .githooks/config.yaml is never overwritten', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  await mkdir(path.join(repo, '.githooks'), { recursive: true });
  await writeFile(path.join(repo, '.githooks', 'config.yaml'), 'enabled: false\n');
  runCli(['--install', '--local', '--yolo'], { cwd: repo, env: isolatedEnv(base) });
  assert.equal(await rd(path.join(repo, '.githooks', 'config.yaml')), 'enabled: false\n');
});

test('outside a repo exits 1 with a clear error', async (t) => {
  const { base } = await makeTempRepo(t);
  const outside = path.join(base, 'not-a-repo');
  await mkdir(outside, { recursive: true });
  const r = runCli(['--install', '--local', '--yolo'], { cwd: outside, env: isolatedEnv(base) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not inside a Git repository/i);
});
