import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AWK_STRIP_TRAILERS, stripTrailers } from '../gitblock.mjs';

const FIXTURES = [
  ['subject\n\nCo-authored-by: B <b@x.y>\n', 'subject\n'],
  ['chore: update deps\n', 'chore: update deps\n'],
  ['subject\n\nbody\nSigned-off-by: X <x@y.z>\n', 'subject\n\nbody\nSigned-off-by: X <x@y.z>\n'],
  ['s1\n\nA: b\nC: d\n\n\n', 's1\n'],
  ['just a subject\n', 'just a subject\n'],
  ['subject only\n', 'subject only\n'],
  [
    'subject\n\nCo-authored-by: A <a@x.y>\n\tcontinued value\nSigned-off-by: X <x@y.z>\n',
    'subject\n',
  ],
  ['subject\r\n\r\nCo-authored-by: B <b@x.y>\r\n', 'subject\r\n'],
  ['subject\n\nbody without trailers\n', 'subject\n\nbody without trailers\n'],
];

let filterFile;

before(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gb-awk-'));
  filterFile = path.join(dir, 'strip.awk');
  await writeFile(filterFile, AWK_STRIP_TRAILERS);
});

function runAwk(input) {
  return spawnSync('awk', ['-f', filterFile], { input, encoding: 'utf8' }).stdout;
}

test('awk filter matches stripTrailers on all fixtures', () => {
  for (const [input, expected] of FIXTURES) {
    assert.equal(runAwk(input), expected, JSON.stringify(input));
  }
});

test('awk filter agrees with stripTrailers on every fixture', () => {
  for (const [input] of FIXTURES) {
    assert.equal(runAwk(input), stripTrailers(input), JSON.stringify(input));
  }
});
