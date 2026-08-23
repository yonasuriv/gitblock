import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK = new URL('../hooks/validate-commit.mjs', import.meta.url).pathname;

async function runHook(t, message) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gb-hookattr-'));
  t.after(() => spawnSync('rm', ['-rf', dir]));
  const msg = path.join(dir, 'msg');
  await writeFile(msg, message);
  // Run the hook as an install would: config.yaml beside the hook.
  await copyFile(HOOK, path.join(dir, 'validate-commit.mjs'));
  await writeFile(path.join(dir, 'config.yaml'), 'enabled: true\nlogging: false\ntrailer: false\nverbose: false\n');
  const r = spawnSync(process.execPath, [path.join(dir, 'validate-commit.mjs'), msg], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return readFile(msg, 'utf8');
}

test('hook strips claude attribution block', async (t) => {
  const out = await runHook(
    t,
    'feat: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
  );
  assert.equal(out, 'feat: x\n');
});

test('hook strips session trailer without separator', async (t) => {
  const out = await runHook(t, 'fix: y\n\nbody\nClaude-Session: https://claude.ai/code/s_1\n');
  assert.equal(out, 'fix: y\n\nbody\n');
});

test('hook keeps prose mentioning claude', async (t) => {
  const msg = 'docs: note\n\nWe evaluated claude among other agents.\n';
  assert.equal(await runHook(t, msg), msg);
});

test('hook strips attribution even in keep-trailers mode', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gb-hookkeep-'));
  t.after(() => spawnSync('rm', ['-rf', dir]));
  const msg = path.join(dir, 'msg');
  await writeFile(
    msg,
    'feat: z\n\nSigned-off-by: Human <h@x.y>\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
  );
  await copyFile(HOOK, path.join(dir, 'validate-commit.mjs'));
  await writeFile(path.join(dir, 'config.yaml'), 'enabled: true\nlogging: false\ntrailer: true\nverbose: false\n');
  spawnSync(process.execPath, [path.join(dir, 'validate-commit.mjs'), msg], { encoding: 'utf8' });
  assert.equal(await readFile(msg, 'utf8'), 'feat: z\n\nSigned-off-by: Human <h@x.y>\n');
});
