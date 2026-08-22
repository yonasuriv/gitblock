// tests/scope-detect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isolatedEnv, makeTempRepo, runCli } from './helpers.mjs';

test('config auto-targets local install when present', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  runCli(['--install', '--local', '--yolo'], { cwd: repo, env: isolatedEnv(base) });
  const r = runCli(['config', 'logging', 'true'], { cwd: repo, env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);
  const cfg = await import('node:fs/promises').then((fs) =>
    fs.readFile(path.join(repo, '.githooks', 'config.yaml'), 'utf8'),
  );
  assert.match(cfg, /^logging: true$/m);
});

test('--verify reports OK against a local install', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  runCli(['--install', '--local', '--yolo'], { cwd: repo, env: isolatedEnv(base) });
  const r = runCli(['--verify'], { cwd: repo, env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /status: OK/);
});

test('config falls back to global when no local install', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  const target = path.join(base, 'opt', 'gitblock', 'hooks');
  runCli(['--install', target, '--yolo'], { env: isolatedEnv(base) });
  const r = runCli(['config'], { cwd: repo, env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /enabled: true/);
});
