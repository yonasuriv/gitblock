import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, VERSION } from '../gitblock.mjs';
import { runCli } from './helpers.mjs';

test('VERSION is valid semver', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('--version prints gitblock <semver>', () => {
  const r = runCli(['--version']);
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^gitblock \d+\.\d+\.\d+$/);
});

test('new flags default to false', () => {
  const o = parseArgs([]);
  for (const k of ['global', 'local', 'force', 'uninstall', 'versionFlag', 'checkUpdate', 'update']) {
    assert.equal(o[k], false, k);
  }
});

test('scope and modifier flags parse', () => {
  const o = parseArgs(['--install', '--local', '--force']);
  assert.equal(o.install, true);
  assert.equal(o.local, true);
  assert.equal(o.force, true);
});

test('--uninstall --global parses', () => {
  const o = parseArgs(['--uninstall', '--global']);
  assert.equal(o.uninstall, true);
  assert.equal(o.global, true);
});
