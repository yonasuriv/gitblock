import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolatedEnv, makeTempRepo, runCli } from './helpers.mjs';

const git = (repo, ...args) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  return r.stdout.trim();
};

test('--uninstall --global unsets hooksPath only', async (t) => {
  const { base } = await makeTempRepo(t);
  const target = path.join(base, 'opt', 'gitblock', 'hooks');
  runCli(['--install', target, '--yolo'], { env: isolatedEnv(base) });
  const r = runCli(['--uninstall', '--global', '--yolo'], { env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);
  const after = spawnSync('git', ['config', '--global', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
    env: { ...process.env, ...isolatedEnv(base) },
  });
  assert.notEqual(after.status, 0);
});

test('--uninstall --local removes ours, keeps foreign and config.yaml', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  runCli(['--install', '--local', '--yolo'], { cwd: repo, env: isolatedEnv(base) });
  await writeFile(path.join(repo, '.githooks', 'commit-msg'), 'FOREIGN\n');
  const r = runCli(['--uninstall', '--local', '--yolo'], { cwd: repo, env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(repo, 'config', '--local', '--get', 'core.hooksPath'), '');
  const left = await readdir(path.join(repo, '.githooks'));
  assert.deepEqual(left.sort(), ['commit-msg', 'config.yaml']);
});

test('--uninstall --local removes .githooks when only ours existed', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  runCli(['--install', '--local', '--yolo'], { cwd: repo, env: isolatedEnv(base) });
  const r = runCli(['--uninstall', '--local', '--yolo'], { cwd: repo, env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);
  await assert.rejects(readdir(path.join(repo, '.githooks')));
});
