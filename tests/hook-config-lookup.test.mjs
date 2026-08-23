// tests/hook-config-lookup.test.mjs
// Runs the actual hook script as a subprocess against fixture layouts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK = new URL('../hooks/validate-commit.mjs', import.meta.url).pathname;

async function setupLayout(t, { localConfig, parentConfig }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gb-hookcfg-'));
  t.after(() => spawnSync('rm', ['-rf', dir]));
  const hookDir = path.join(dir, 'hooks');
  await mkdir(hookDir, { recursive: true });
  // The hook resolves its config relative to its own location, so exercise a
  // copy placed in the fixture layout — the same layout a real install has.
  await copyFile(HOOK, path.join(hookDir, 'validate-commit.mjs'));
  if (localConfig) await writeFile(path.join(hookDir, 'config.yaml'), localConfig);
  if (parentConfig) await writeFile(path.join(dir, 'config.yaml'), parentConfig);
  const msg = path.join(dir, 'msg');
  await writeFile(msg, 'subject\n\nReviewed-by: B <b@x.y>\n');
  return { dir, hookDir, msg };
}

function runHook(hookDir, msg) {
  const hookCopy = path.join(hookDir, 'validate-commit.mjs');
  return spawnSync(process.execPath, [hookCopy, msg], {
    encoding: 'utf8',
    env: { ...process.env }, // logging off by default; no side effects expected
  });
}

test('.githooks/config.yaml wins over unrelated repo-root config.yaml', async (t) => {
  const { hookDir, msg } = await setupLayout(t, {
    localConfig: 'trailer: true\n',   // trailers kept -> message unchanged
    parentConfig: 'trailer: false\n', // would strip if wrongly chosen
  });
  runHook(hookDir, msg);
  assert.equal(await readFile(msg, 'utf8'), 'subject\n\nReviewed-by: B <b@x.y>\n');
});

test('parent config still used for the global layout', async (t) => {
  const { hookDir, msg } = await setupLayout(t, {
    localConfig: null,
    parentConfig: 'trailer: true\n',
  });
  runHook(hookDir, msg);
  assert.equal(await readFile(msg, 'utf8'), 'subject\n\nReviewed-by: B <b@x.y>\n');
});
