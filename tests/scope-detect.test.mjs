// tests/scope-detect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { isolatedEnv, makeTempRepo, runCli } from './helpers.mjs';

test('config auto-targets local install when present', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  runCli(['--install', '--local', '--yolo'], { cwd: repo, env: isolatedEnv(base) });
  const r = runCli(['config', 'trailer', 'true'], { cwd: repo, env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);
  // Default ships trailer:false, so an exact match proves the write happened
  // here and nowhere else.
  const cfg = await readFile(path.join(repo, '.githooks', 'config.yaml'), 'utf8');
  assert.equal(cfg, 'enabled: true\nlogging: false\ntrailer: true\nverbose: false\n');
});

test('config global disable targets the global config, not the local one', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  runCli(['--install', '--local', '--yolo'], { cwd: repo, env: isolatedEnv(base) });

  const r = runCli(['config', 'global', 'disable'], { cwd: repo, env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);

  const g = spawnSync('git', ['config', '--global', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
    env: { ...process.env, ...isolatedEnv(base) },
  });
  assert.notEqual(g.status, 0);
  assert.equal(g.stdout.trim(), '');

  // The local YAML must stay untouched.
  const localCfg = await readFile(path.join(repo, '.githooks', 'config.yaml'), 'utf8');
  assert.match(localCfg, /^enabled: true$/m);

  // The disable lands in the global (default-base) config instead.
  const globalCfg = await readFile(
    path.join(base, '.local', 'opt', 'gitblock', 'config.yaml'),
    'utf8',
  );
  assert.match(globalCfg, /^enabled: false$/m);
});

test('--verify reports OK against a local install', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  runCli(['--install', '--local', '--yolo'], { cwd: repo, env: isolatedEnv(base) });
  const r = runCli(['--verify'], { cwd: repo, env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /status: OK/);
});

test('linked worktrees of a locally-installed repo resolve as local scope', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  runCli(['--install', '--local', '--yolo'], { cwd: repo, env: isolatedEnv(base) });
  // Absolute hooksPath so the linked worktree resolves to the same existing
  // hooks directory.
  spawnSync('git', ['config', 'core.hooksPath', path.join(repo, '.githooks')], { cwd: repo });

  await writeFile(path.join(repo, 'f'), 'x');
  spawnSync('git', ['add', 'f'], { cwd: repo });
  const c = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'],
    { cwd: repo },
  );
  assert.equal(c.status, 0);

  const wt = path.join(base, 'wt');
  const w = spawnSync('git', ['worktree', 'add', wt], { cwd: repo, encoding: 'utf8' });
  assert.equal(w.status, 0, w.stderr);

  // Origin lives in <repo>/.git/config, not <wt>/.git/config; scope detection
  // must compare against `git rev-parse --git-path config`.
  const r = runCli(['config', 'trailer', 'true'], { cwd: wt, env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);
  const cfg = await readFile(path.join(wt, '.githooks', 'config.yaml'), 'utf8');
  assert.match(cfg, /^trailer: true$/m);
});

test('config falls back to global when no local install', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  const target = path.join(base, 'opt', 'gitblock', 'hooks');
  runCli(['--install', target, '--yolo'], { env: isolatedEnv(base) });
  const r = runCli(['config'], { cwd: repo, env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /enabled: true/);
});
