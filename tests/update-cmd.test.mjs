import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assetName, swapBinary, VERSION } from '../gitblock.mjs';

test('asset naming includes version, os, arch, .exe on win32', () => {
  assert.equal(assetName('1.2.3', 'linux', 'x64'), 'gitblock-v1.2.3-linux-x64');
  assert.equal(assetName('1.2.3', 'darwin', 'arm64'), 'gitblock-v1.2.3-darwin-arm64');
  assert.equal(assetName('1.2.3', 'win32', 'x64'), 'gitblock-v1.2.3-win-x64.exe');
});

test('assetName maps current VERSION correctly', () => {
  assert.match(assetName(VERSION, process.platform, process.arch), new RegExp(`^gitblock-v${VERSION}`));
});

test('swapBinary replaces target on posix', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gb-swap-'));
  t.after(() => spawnSync('rm', ['-rf', dir]));
  const target = path.join(dir, 'gitblock');
  await writeFile(target, 'old', { mode: 0o755 });
  const fresh = path.join(dir, 'fresh');
  await writeFile(fresh, 'new', { mode: 0o755 });
  swapBinary(target, fresh, 'linux');
  assert.equal(await readFile(target, 'utf8'), 'new');
});
