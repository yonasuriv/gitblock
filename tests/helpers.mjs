import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'gitblock.mjs',
);

// Isolated HOME so installs never touch the developer machine.
export function isolatedEnv(base) {
  return {
    HOME: base,
    GIT_CONFIG_GLOBAL: path.join(base, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

export async function makeTempRepo(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'gitblock-test-'));
  t.after(() => spawnSync('rm', ['-rf', base]));
  const repo = path.join(base, 'repo');
  await mkdir(repo, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  return { base, repo };
}

export function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
  });
}
