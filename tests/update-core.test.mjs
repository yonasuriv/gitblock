import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { detectChannel, isNewerVersion, fetchLatestVersion } from '../gitblock.mjs';

const base = path.join(os.homedir(), '.local', 'opt', 'gitblock');

test('binary channel when argv[1] is execPath', () => {
  assert.equal(detectChannel('/usr/local/bin/gitblock', '/usr/local/bin/gitblock', base), 'binary');
});

test('npm channel under node_modules', () => {
  assert.equal(
    detectChannel('/home/u/.npm-global/lib/node_modules/gitblock/gitblock.mjs', '/usr/bin/node', base),
    'npm',
  );
});

test('manual channel under the opt layout', () => {
  assert.equal(detectChannel(path.join(base, 'bin', 'gitblock.mjs'), '/usr/bin/node', base), 'manual');
});

test('sibling directory of install base is not manual', () => {
  assert.equal(
    detectChannel(path.join(`${base}-old`, 'bin', 'gitblock.mjs'), '/usr/bin/node', base),
    'source',
  );
});

test('source channel otherwise', () => {
  assert.equal(detectChannel('/work/gitblock/gitblock.mjs', '/usr/bin/node', base), 'source');
});

test('semver compare', () => {
  assert.equal(isNewerVersion('1.1.0', '1.0.0'), true);
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
  assert.equal(isNewerVersion('0.9.9', '1.0.0'), false);
  assert.equal(isNewerVersion('2.0.0', '1.99.99'), true);
});

test('fetchLatestVersion parses registry response', async () => {
  const fake = async () => ({ ok: true, status: 200, json: async () => ({ version: '9.9.9' }) });
  assert.equal(await fetchLatestVersion(fake), '9.9.9');
});

test('fetchLatestVersion returns null on failure', async () => {
  const fake = async () => { throw new Error('down'); };
  assert.equal(await fetchLatestVersion(fake), null);
});
