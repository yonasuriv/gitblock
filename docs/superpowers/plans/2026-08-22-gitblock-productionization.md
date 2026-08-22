# gitblock Productionization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship gitblock as an npm package + compiled binaries, with `--global`/`--local` install scopes, conflict guardrails, versioning, and self-update.

**Architecture:** Single-file CLI (`gitblock.mjs`) stays the entry point; new capabilities are focused internal functions driven by a `node:test` suite (TDD). Hooks remain three standalone copied files; the wipe msg-filter becomes an awk script so it works without Node. Release automation lives in two GitHub Actions workflows.

**Tech Stack:** Node.js >=18 built-ins only (zero runtime deps), `node:test`, Bun compile (CI-only), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-22-gitblock-productionization-design.md`

## Global Constraints

- Zero third-party runtime dependencies; Node.js built-ins only.
- `"type": "module"` — all code is ESM (`.mjs`). Engines: `>=18`.
- Version source of truth: `VERSION` constant in `gitblock.mjs`, starting `'1.0.0'`.
- Release asset naming: `gitblock-v<VERSION>-<os>-<arch>` (+ `.exe` win-x64).
- `config.yaml` is never overwritten once it exists.
- Local installs never bake the log path into copied hook files.
- Errors to stderr; exit codes per spec table.
- Test command: `npm test` (= `node --test tests/`).

---

### Task 1: Project scaffold — package.json + test runner

**Files:**
- Create: `package.json`
- Create: `tests/helpers.mjs`
- Create: `tests/smoke.test.mjs`

**Interfaces:**
- Produces: `npm test`; helpers `runCli(args, opts)`, `makeTempRepo(t)` used by all integration tasks.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "gitblock",
  "version": "1.0.0",
  "description": "Zero-dependency Git hook installer for trailer cleanup, plus a history rewriter that wipes trailers and resets authorship.",
  "type": "module",
  "bin": { "gitblock": "./gitblock.mjs" },
  "files": ["gitblock.mjs", "hooks/", "config/default.yaml", "README.md"],
  "engines": { "node": ">=18" },
  "scripts": { "test": "node --test tests/" },
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/yonasuriv/gitblock" }
}
```

- [ ] **Step 2: Create tests/helpers.mjs**

```js
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
```

- [ ] **Step 3: Verify the runner works**

Create `tests/smoke.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from './helpers.mjs';

test('cli prints usage with no args', () => {
  const r = runCli([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});
```

Run: `npm test`
Expected: PASS (1 test)

- [ ] **Step 4: Commit**

```bash
git add package.json tests/
git commit -m "chore: add package.json and node:test scaffold"
```

---

### Task 2: New CLI flags, VERSION constant, --version

**Files:**
- Modify: `gitblock.mjs` (constants ~line 52; `parseArgs` lines 75–118; `main()` line 699)
- Test: `tests/cli-flags.test.mjs`

**Interfaces:**
- Produces: exported `VERSION` (`'1.0.0'`); exported `parseArgs` returning extended opts `{ ..., global, local, force, uninstall, versionFlag, checkUpdate, update }` (all boolean, default false).

- [ ] **Step 1: Write the failing test**

```js
// tests/cli-flags.test.mjs
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
```

Run: `node --test tests/cli-flags.test.mjs`
Expected: FAIL — `parseArgs`/`VERSION` not exported

- [ ] **Step 2: Implement in gitblock.mjs**

1. Add near line 52:

```js
export const VERSION = '1.0.0';
```

2. Extend the `opts` object in `parseArgs` with `global: false, local: false, force: false, uninstall: false, versionFlag: false, checkUpdate: false, update: false`.

3. Add to the flag chain (before the `config` branch):

```js
} else if (arg === '--global') {
  opts.global = true;
} else if (arg === '--local') {
  opts.local = true;
} else if (arg === '--force') {
  opts.force = true;
} else if (arg === '--uninstall') {
  opts.uninstall = true;
} else if (arg === '--version') {
  opts.versionFlag = true;
} else if (arg === '--check-update') {
  opts.checkUpdate = true;
} else if (arg === '--update') {
  opts.update = true;
```

4. Make `parseArgs` exported.

5. In `main()`: extend the nothing-to-do guard with `&& !opts.uninstall && !opts.versionFlag && !opts.checkUpdate && !opts.update`, and add before the verify branch:

```js
if (opts.versionFlag) {
  console.log(`gitblock ${VERSION}`);
  return;
}
```

Run: `node --test tests/cli-flags.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 3: Commit**

```bash
git add gitblock.mjs tests/cli-flags.test.mjs
git commit -m "feat: add scope/uninstall/update flags and --version"
```

---

### Task 3: Unified stripTrailers — port the subject guard

The hook guards subject-only messages; the exported `stripTrailers` used by `--wipe` does not. Port the guard for parity.

**Files:**
- Modify: `gitblock.mjs:547-608` (`stripTrailers`)
- Test: `tests/strip-trailers.test.mjs`

**Interfaces:**
- Produces: same signature; new guarantee — subject-only messages returned unchanged.

- [ ] **Step 1: Write the failing test**

```js
// tests/strip-trailers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTrailers } from '../gitblock.mjs';

test('strips a trailer block', () => {
  assert.equal(stripTrailers('add thing\n\nCo-authored-by: Bob <b@x.y>\n'), 'add thing\n');
});

test('preserves body when trailer not separated by blank line', () => {
  const msg = 'subject\n\nbody line\nSigned-off-by: X <x@y.z>\n';
  assert.equal(stripTrailers(msg), msg);
});

test('subject-only conventional commit is kept', () => {
  const msg = 'chore: update deps\n';
  assert.equal(stripTrailers(msg), msg);
});
```

Run: `node --test tests/strip-trailers.test.mjs`
Expected: FAIL on "subject-only conventional commit is kept"

- [ ] **Step 2: Add the guard in stripTrailers before the separator check (~line 595)**

```js
  // The first line is always the subject, never a trailer. A trailer block
  // reaching back to the start means the subject was misread — keep it.
  if (cursor === 0) {
    return message;
  }
```

Run: `node --test tests/strip-trailers.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 3: Commit**

```bash
git add gitblock.mjs tests/strip-trailers.test.mjs
git commit -m "fix: stripTrailers keeps subject-only messages (hook/wipe parity)"
```

---

### Task 4: Guardrail classifier + backup helper

**Files:**
- Modify: `gitblock.mjs` (new exports after `ensureConfig` ~line 241; export `SOURCE_HOOKS_DIR`)
- Test: `tests/guardrails.test.mjs`

**Interfaces:**
- Produces:
  - `normalizeContent(s): string`
  - `classifyTarget(destPath, srcPath): Promise<'ours'|'foreign'|'absent'>`
  - `backupFile(destPath): Promise<string|null>`

- [ ] **Step 1: Write the failing tests**

```js
// tests/guardrails.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyTarget, backupFile, normalizeContent, SOURCE_HOOKS_DIR } from '../gitblock.mjs';

async function tmp(t) {
  return mkdtemp(path.join(tmpdir(), 'gb-gr-'));
}

test('normalizeContent trims CRLF and trailing whitespace', () => {
  assert.equal(normalizeContent('a\r\nb\r\n'), 'a\nb');
});

test('identical copy classifies as ours', async (t) => {
  const dir = await tmp(t);
  const src = path.join(SOURCE_HOOKS_DIR, 'commit-msg');
  const dest = path.join(dir, 'commit-msg');
  await writeFile(dest, await readFile(src));
  assert.equal(await classifyTarget(dest, src), 'ours');
});

test('edited copy classifies as foreign', async (t) => {
  const dir = await tmp(t);
  const dest = path.join(dir, 'commit-msg');
  await writeFile(dest, '#!/bin/sh\necho mine\n');
  assert.equal(await classifyTarget(dest, path.join(SOURCE_HOOKS_DIR, 'commit-msg')), 'foreign');
});

test('missing file classifies as absent', async (t) => {
  const dir = await tmp(t);
  assert.equal(
    await classifyTarget(path.join(dir, 'commit-msg'), path.join(SOURCE_HOOKS_DIR, 'commit-msg')),
    'absent',
  );
});

test('backupFile writes timestamped copy; null when absent', async (t) => {
  const dir = await tmp(t);
  const dest = path.join(dir, 'commit-msg');
  assert.equal(await backupFile(path.join(dir, 'nope')), null);
  await writeFile(dest, 'mine');
  const bak = await backupFile(dest);
  assert.match(bak, /commit-msg\.bak-\d+$/);
  assert.equal(await readFile(bak, 'utf8'), 'mine');
});
```

Run: `node --test tests/guardrails.test.mjs`
Expected: FAIL — exports missing

- [ ] **Step 2: Implement**

Export `SOURCE_HOOKS_DIR` and add:

```js
export function normalizeContent(content) {
  return content.replace(/\r\n/gu, '\n').replace(/\s+$/u, '');
}

// 'ours' | 'foreign' | 'absent'. Normalized compare keeps reinstalls idempotent.
export async function classifyTarget(destPath, srcPath) {
  let current;
  try {
    current = await readFile(destPath, 'utf8');
  } catch {
    return 'absent';
  }
  const source = await readFile(srcPath, 'utf8');
  return normalizeContent(current) === normalizeContent(source) ? 'ours' : 'foreign';
}

// Copy an existing target aside before overwriting.
export async function backupFile(destPath) {
  try {
    await readFile(destPath);
  } catch {
    return null;
  }
  const backup = `${destPath}.bak-${Math.floor(Date.now() / 1000)}`;
  await copyFile(destPath, backup);
  return backup;
}
```

Run: `node --test tests/guardrails.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 3: Commit**

```bash
git add gitblock.mjs tests/guardrails.test.mjs
git commit -m "feat: add hook-target classifier and timestamped backup helper"
```

---

### Task 5: Global install refactor — exact HOOK_FILES copy + guardrails

**Files:**
- Modify: `gitblock.mjs` (`runInstall` lines 474–541; drop the `readdir` loop)
- Test: `tests/install-global.test.mjs`

**Interfaces:**
- Consumes: `classifyTarget`, `backupFile`.
- Produces: `runInstall(requestedDir, { yolo, force })` — aborts exit 1 listing foreign conflicts without `--force`; backs up with `--force`; copies exactly `HOOK_FILES`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/install-global.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isolatedEnv, makeTempRepo, runCli } from './helpers.mjs';

const rd = (p) => readFile(p, 'utf8');

test('fresh global install sets hooksPath and copies exactly HOOK_FILES', async (t) => {
  const { base } = await makeTempRepo(t);
  const target = path.join(base, 'opt', 'gitblock', 'hooks');
  const r = runCli(['--install', target, '--yolo'], { env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const f of ['commit-msg', 'prepare-commit-msg', 'validate-commit.mjs']) {
    assert.match(await rd(path.join(target, f)), /./);
  }
  assert.match(await rd(path.join(path.dirname(target), 'config.yaml')), /enabled:/);
});

test('foreign hook file aborts without --force, untouched', async (t) => {
  const { base } = await makeTempRepo(t);
  const target = path.join(base, 'opt', 'gitblock', 'hooks');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'commit-msg'), '#!/bin/sh\necho custom\n');
  const r = runCli(['--install', target, '--yolo'], { env: isolatedEnv(base) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /commit-msg/);
  assert.match(r.stderr, /--force/);
  assert.equal(await rd(path.join(target, 'commit-msg')), '#!/bin/sh\necho custom\n');
});

test('--force overwrites foreign file with timestamped backup', async (t) => {
  const { base } = await makeTempRepo(t);
  const target = path.join(base, 'opt', 'gitblock', 'hooks');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'commit-msg'), '#!/bin/sh\necho custom\n');
  const r = runCli(['--install', target, '--yolo', '--force'], { env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok((await readdir(target)).some((f) => /^commit-msg\.bak-\d+$/.test(f)));
});

test('reinstall over our own files is silent and idempotent', async (t) => {
  const { base } = await makeTempRepo(t);
  const target = path.join(base, 'opt', 'gitblock', 'hooks');
  assert.equal(runCli(['--install', target, '--yolo'], { env: isolatedEnv(base) }).status, 0);
  const r = runCli(['--install', target, '--yolo'], { env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/\.bak-/.test(r.stdout));
});
```

Run: `node --test tests/install-global.test.mjs`
Expected: FAIL — no conflict behavior yet

- [ ] **Step 2: Refactor runInstall**

Replace the `readdir` loop (line 490) and prompt section:

```js
async function runInstall(requestedDir, { yolo, force = false }) {
  const installDir = path.resolve(requestedDir ?? DEFAULT_INSTALL_DIR);
  const customGitDir = requestedDir ? path.dirname(installDir) : undefined;
  const configTarget = path.join(path.dirname(installDir), 'config.yaml');

  // Classify first: a foreign conflict aborts before any prompt or write.
  const conflicts = [];
  for (const file of HOOK_FILES) {
    const verdict = await classifyTarget(
      path.join(installDir, file),
      path.join(SOURCE_HOOKS_DIR, file),
    );
    if (verdict === 'foreign') conflicts.push(file);
  }

  if (conflicts.length > 0 && !force) {
    console.error(`Error: refusing to overwrite foreign files in "${installDir}":`);
    for (const file of conflicts) console.error(`  ${file}`);
    console.error('Re-run with --force to back them up and overwrite.');
    process.exitCode = 1;
    return;
  }

  const ok = await askConfirm(`Install Git hooks into "${installDir}"? [Y/n] `, { yolo, defaultYes: true });
  if (!ok) {
    console.log('Installation cancelled.');
    return;
  }

  await mkdir(installDir, { recursive: true });

  for (const file of HOOK_FILES) {
    if (conflicts.includes(file)) {
      const bak = await backupFile(path.join(installDir, file));
      if (bak) console.log(`Backed up ${file} -> ${bak}`);
    }
    await installHookFile(file, installDir, customGitDir);
  }

  // ... rest unchanged (bin copy, symlink, config-if-absent, chmod, hooksPath)
}
```

Update `main()`: `await runInstall(opts.installDir, { yolo: opts.yolo, force: opts.force });`

Run: `node --test tests/install-global.test.mjs && npm test`
Expected: all PASS

- [ ] **Step 3: Commit**

```bash
git add gitblock.mjs tests/install-global.test.mjs
git commit -m "feat: global install copies exact hook set with conflict guardrails"
```

---

### Task 6: Local install (`--install --local`)

**Files:**
- Modify: `gitblock.mjs` (new `runLocalInstall`; dispatch in `main()`)
- Test: `tests/install-local.test.mjs`

**Interfaces:**
- Consumes: `classifyTarget`, `backupFile`, `HOOK_FILES`, `SOURCE_CONFIG`.
- Produces: `runLocalInstall({ yolo, force })` — creates `<repoRoot>/.githooks/`, copies exactly HOOK_FILES (no log baking), writes `.githooks/config.yaml` only if absent, sets repo-local `core.hooksPath = .githooks`. Exports `getRepoRoot(): string|null`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/install-local.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolatedEnv, makeTempRepo, runCli } from './helpers.mjs';

const rd = (p) => readFile(p, 'utf8');
const git = (repo, ...args) =>
  spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim();

test('local install creates .githooks, config.yaml, sets local hooksPath', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  const r = runCli(['--install', '--local', '--yolo'], {
    cwd: repo,
    env: isolatedEnv(base),
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const f of ['commit-msg', 'prepare-commit-msg', 'validate-commit.mjs', 'config.yaml']) {
    assert.match(await rd(path.join(repo, '.githooks', f)), /./);
  }
  assert.equal(git(repo, 'config', '--local', '--get', 'core.hooksPath'), '.githooks');
});

test('hooks fire on commit in a locally-installed repo (trailers stripped)', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  runCli(['--install', '--local', '--yolo'], { cwd: repo, env: isolatedEnv(base) });
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@x.y');
  await writeFile(path.join(repo, 'a.txt'), 'x');
  spawnSync('git', ['add', 'a.txt'], { cwd: repo });
  const c = spawnSync(
    'git',
    ['commit', '-m', 'subject line\n\nCo-authored-by: Bob <b@x.y>'],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(c.status, 0, c.stderr);
  assert.equal(git(repo, 'log', '-1', '--format=%B'), 'subject line\n');
});

test('foreign file in empty .githooks aborts; --force backs up', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  await mkdir(path.join(repo, '.githooks'), { recursive: true });
  await writeFile(path.join(repo, '.githooks', 'commit-msg'), '#!/bin/sh\necho custom\n');
  let r = runCli(['--install', '--local', '--yolo'], { cwd: repo, env: isolatedEnv(base) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /commit-msg/);
  r = runCli(['--install', '--local', '--yolo', '--force'], { cwd: repo, env: isolatedEnv(base) });
  assert.equal(r.status, 0, r.stderr);
});

test('existing .githooks/config.yaml is never overwritten', async (t) => {
  const { base, repo } = await makeTempRepo(t);
  await mkdir(path.join(repo, '.githooks'), { recursive: true });
  await writeFile(path.join(repo, '.githooks', 'config.yaml'), 'enabled: false\n');
  runCli(['--install', '--local', '--yolo'], { cwd: repo, env: isolatedEnv(base) });
  assert.equal(await rd(path.join(repo, '.githooks', 'config.yaml')), 'enabled: false\n');
});

test('outside a repo exits 1 with a clear error', async (t) => {
  const { base } = await makeTempRepo(t);
  const outside = path.join(base, 'not-a-repo');
  const r = runCli(['--install', '--local', '--yolo'], { cwd: outside, env: isolatedEnv(base) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not inside a Git repository/i);
});
```

Run: `node --test tests/install-local.test.mjs`
Expected: FAIL — `--local` unimplemented

- [ ] **Step 2: Implement**

Add helpers near the hooks-path functions:

```js
function getRepoRoot() {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function setLocalHooksPath(value) {
  const result = spawnSync('git', ['config', 'core.hooksPath', value], { stdio: 'inherit' });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result.status === 0;
}
```

Add `runLocalInstall` (reuses the same conflict scan as Task 5 — extract that scan into `findConflicts(installDir)` returning the conflicts array so both installers share it):

```js
async function findConflicts(installDir) {
  const conflicts = [];
  for (const file of HOOK_FILES) {
    const verdict = await classifyTarget(
      path.join(installDir, file),
      path.join(SOURCE_HOOKS_DIR, file),
    );
    if (verdict === 'foreign') conflicts.push(file);
  }
  return conflicts;
}

async function runLocalInstall({ yolo, force }) {
  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    console.error('Error: not inside a Git repository; --local installs a repository.');
    process.exitCode = 1;
    return;
  }

  const githooksDir = path.join(repoRoot, '.githooks');
  const conflicts = await findConflicts(githooksDir);

  if (conflicts.length > 0 && !force) {
    console.error(`Error: refusing to overwrite foreign files in "${githooksDir}":`);
    for (const file of conflicts) console.error(`  ${file}`);
    console.error('Re-run with --force to back them up and overwrite.');
    process.exitCode = 1;
    return;
  }

  const ok = await askConfirm(`Install Git hooks into "${githooksDir}"? [Y/n] `, { yolo, defaultYes: true });
  if (!ok) {
    console.log('Installation cancelled.');
    return;
  }

  await mkdir(githooksDir, { recursive: true });

  for (const file of HOOK_FILES) {
    if (conflicts.includes(file)) {
      const bak = await backupFile(path.join(githooksDir, file));
      if (bak) console.log(`Backed up ${file} -> ${bak}`);
    }
    // No log baking for local installs: installed files stay identical to source.
    await copyFile(path.join(SOURCE_HOOKS_DIR, file), path.join(githooksDir, file));
    await chmod(path.join(githooksDir, file), 0o755);
  }

  const configFile = path.join(githooksDir, 'config.yaml');
  if (await fileExists(configFile)) {
    console.log(`Config already present, keeping "${configFile}".`);
  } else {
    await copyFile(SOURCE_CONFIG, configFile);
  }

  if (setLocalHooksPath('.githooks')) {
    console.log(`Local hooks enabled: core.hooksPath = ".githooks" (${repoRoot}).`);
  }
}
```

Refactor Task 5's global `runInstall` to use `findConflicts()` (behavior unchanged).

In `main()`:

```js
if (opts.install) {
  if (opts.local && !opts.global) {
    await runLocalInstall({ yolo: opts.yolo, force: opts.force });
  } else {
    await runInstall(opts.installDir, { yolo: opts.yolo, force: opts.force });
  }
}
```

Run: `node --test tests/install-local.test.mjs && npm test`
Expected: all PASS

- [ ] **Step 3: Commit**

```bash
git add gitblock.mjs tests/install-local.test.mjs
git commit -m "feat: per-project --local install into .githooks with guardrails"
```

---

### Task 7: Uninstall scopes

**Files:**
- Modify: `gitblock.mjs` (new `runUninstall`; dispatch in `main()`)
- Test: `tests/uninstall.test.mjs`

**Interfaces:**
- Produces: `runUninstall({ scope })`.
  - `'global'`: unset global core.hooksPath only (reuse `unsetGlobalHooksPath`); never touches any config.yaml.
  - `'local'`: unset local core.hooksPath; remove hook files classified 'ours'; leave foreign files and `.githooks/config.yaml`; `rm` `.githooks/` only when empty.

- [ ] **Step 1: Write the failing tests**

```js
// tests/uninstall.test.mjs
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
```

Run: `node --test tests/uninstall.test.mjs`
Expected: FAIL — `--uninstall` unimplemented

- [ ] **Step 2: Implement**

```js
function unsetLocalHooksPath() {
  const result = spawnSync('git', ['config', '--unset', 'core.hooksPath'], { encoding: 'utf8' });
  // Exit code 5 means the key was not set; fine.
  return result.status === 0 || result.status === 5;
}

async function runUninstall({ scope, yolo }) {
  if (scope === 'local') {
    const repoRoot = getRepoRoot();
    if (!repoRoot) {
      console.error('Error: not inside a Git repository.');
      process.exitCode = 1;
      return;
    }
    const ok = await askConfirm(`Remove local gitblock hooks in "${repoRoot}"? [y/N] `, { yolo, defaultYes: false });
    if (!ok) {
      console.log('Uninstall cancelled.');
      return;
    }
    unsetLocalHooksPath();

    const githooksDir = path.join(repoRoot, '.githooks');
    let leftovers = [];
    try {
      for (const entry of await readdir(githooksDir)) {
        const full = path.join(githooksDir, entry);
        if (entry === 'config.yaml') { leftovers.push(entry); continue; }
        const src = SOURCE_HOOKS_DIR && HOOK_FILES.includes(entry)
          ? path.join(SOURCE_HOOKS_DIR, entry)
          : null;
        if (src && (await classifyTarget(full, src)) === 'ours') {
          await rm(full);
        } else {
          leftovers.push(entry);
        }
      }
    } catch {
      // .githooks missing entirely; nothing to clean.
    }
    if (leftovers.length > 0) {
      console.log(`Kept non-gitblock files in .githooks: ${leftovers.join(', ')}`);
    }
    // Remove the dir itself only when empty.
    try {
      await rm(githooksDir, { recursive: false });
      console.log('Removed empty .githooks directory.');
    } catch {
      // Not empty or gone; leave as reported above.
    }
    console.log('Local hooks removed: core.hooksPath cleared.');
    return;
  }

  if (unsetGlobalHooksPath()) {
    console.log('Global hooks disabled: core.hooksPath removed.');
  }
}
```

In `main()`:

```js
if (opts.uninstall) {
  const scope = opts.local && !opts.global ? 'local' : 'global';
  await runUninstall({ scope, yolo: opts.yolo });
  return;
}
```

Run: `node --test tests/uninstall.test.mjs && npm test`
Expected: all PASS

- [ ] **Step 3: Commit**

```bash
git add gitblock.mjs tests/uninstall.test.mjs
git commit -m "feat: scoped uninstall (global config-only, local ownership-aware)"
```

---

### Task 8: Hook config lookup inversion (validate-commit.mjs)

Local layout must win over an unrelated repo-root `config.yaml`.

**Files:**
- Modify: `hooks/validate-commit.mjs:130-135` (`configPath`)
- Test: `tests/hook-config-lookup.test.mjs`

**Interfaces:**
- Produces: lookup order `hookDir/config.yaml` → `hookDir/../config.yaml` → defaults.

- [ ] **Step 1: Write the failing test**

```js
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
  if (localConfig) await writeFile(path.join(hookDir, 'config.yaml'), localConfig);
  if (parentConfig) await writeFile(path.join(dir, 'config.yaml'), parentConfig);
  const msg = path.join(dir, 'msg');
  await writeFile(msg, 'subject\n\nCo-authored-by: B <b@x.y>\n');
  return { dir, hookDir, msg };
}

function runHook(hookDir, msg) {
  return spawnSync(process.execPath, [HOOK, msg], {
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
  assert.equal(await readFile(msg, 'utf8'), 'subject\n\nCo-authored-by: B <b@x.y>\n');
});

test('parent config still used for the global layout', async (t) => {
  const { hookDir, msg } = await setupLayout(t, {
    localConfig: null,
    parentConfig: 'trailer: true\n',
  });
  runHook(hookDir, msg);
  assert.equal(await readFile(msg, 'utf8'), 'subject\n\nCo-authored-by: B <b@x.y>\n');
});
```

Run: `node --test tests/hook-config-lookup.test.mjs`
Expected: FAIL on the first test (root config currently shadows)

- [ ] **Step 2: Implement**

Replace `configPath()` in `hooks/validate-commit.mjs`:

```js
// The config file lives one level above the hooks directory (global install:
// "$HOME/.git/config.yaml") or sits beside the hooks (local: ".githooks").
// The sibling check comes first so an unrelated <repo-root>/config.yaml can
// never shadow a local install.
function configPaths() {
  const hookDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.join(hookDir, 'config.yaml'),
    path.join(hookDir, '..', 'config.yaml'),
  ];
}
```

And in `loadConfig()`, iterate:

```js
for (const candidate of configPaths()) {
  try {
    const raw = await readFile(candidate, 'utf8');
    // ... existing parse loop over `raw` ...
    return config;
  } catch {
    continue;
  }
}
return defaults;
```

(Keep the existing parse body verbatim inside the loop.)

Run: `node --test tests/hook-config-lookup.test.mjs && npm test`
Expected: all PASS

- [ ] **Step 3: Commit**

```bash
git add hooks/validate-commit.mjs tests/hook-config-lookup.test.mjs
git commit -m "fix: local .githooks/config.yaml takes precedence over repo-root config"
```

---

### Task 9: Scoped `config` and `--verify` (auto-detect)

**Files:**
- Modify: `gitblock.mjs` (`findConfigPath` lines 358–364; `runVerify` lines 313–356; `handleConfigCommand` signature)
- Test: `tests/scope-detect.test.mjs`

**Interfaces:**
- Produces: `detectScope(): 'local'|'global'` — returns 'local' when repo-local `core.hooksPath` points at an existing dir containing at least one of HOOK_FILES; else 'global'. `findConfigPath(scope)` resolves the matching config; explicit `--local/--global` flags override detection.

- [ ] **Step 1: Write the failing test**

```js
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
```

Run: `node --test tests/scope-detect.test.mjs`
Expected: FAIL

- [ ] **Step 2: Implement**

```js
// Auto-detect which install governs this repository. Explicit flags win.
function detectScope(explicit) {
  if (explicit === 'local') return 'local';
  if (explicit === 'global') return 'global';
  const parsed = parseEffectiveHooksPath(); // origin includes "file:" prefix
  if (parsed?.origin.includes('file:.') || /file:\.githooks/.test(parsed?.origin ?? '')) {
    return 'local';
  }
  return 'global';
}

function localConfigPath() {
  const repoRoot = getRepoRoot();
  return repoRoot ? path.join(repoRoot, '.githooks', 'config.yaml') : null;
}

async function findConfigPath(scope) {
  if (scope === 'local') {
    const p = localConfigPath();
    if (p && (await fileExists(p))) return p;
  }
  const hooksPath = getGlobalHooksPath();
  if (hooksPath) return path.join(hooksPath, '..', 'config.yaml');
  return path.join(DEFAULT_INSTALL_BASE, 'config.yaml');
}
```

Wire-up:
- `handleConfigCommand(args, scope)` uses `findConfigPath(scope)`.
- In `main()`: pass `detectScope(opts.local ? 'local' : opts.global ? 'global' : undefined)` to both `handleConfigCommand` and a scope-aware `runVerify(scope)`; in `runVerify`, when scope is 'local', print the local section: effective hooksPath from `parseEffectiveHooksPath()`, config status from `loadConfigFile(localConfigPath())`, and report OK when applied here and `enabled !== false`.

Run: `node --test tests/scope-detect.test.mjs && npm test`
Expected: all PASS

- [ ] **Step 3: Commit**

```bash
git add gitblock.mjs tests/scope-detect.test.mjs
git commit -m "feat: config and verify auto-detect local vs global install scope"
```

---

### Task 10: Compiled-binary-safe entry guard

**Files:**
- Modify: `gitblock.mjs:726-731`
- Test: extend `tests/cli-flags.test.mjs`

**Interfaces:**
- Produces: exported helper `isEntryPoint(argv1): boolean` used by the bottom guard; tolerant of a nonexistent script path (compiled binary).

- [ ] **Step 1: Write the failing test**

```js
// append to tests/cli-flags.test.mjs
import { isEntryPoint } from '../gitblock.mjs';

test('entry guard tolerates nonexistent paths', () => {
  assert.equal(isEntryPoint(undefined), false);
});

test('entry guard matches real argv[1]', async () => {
  const self = new URL('../gitblock.mjs', import.meta.url).pathname;
  assert.equal(isEntryPoint(self), true);
});
```

Run: `node --test tests/cli-flags.test.mjs`
Expected: FAIL — `isEntryPoint` not exported

- [ ] **Step 2: Implement**

Replace the bottom guard of `gitblock.mjs`:

```js
// Only run as a CLI entry point. Importing this module must not trigger
// main(). In compiled binaries there is no source file on disk: treat any
// direct execution (argv[1] === execPath) as the entry point.
export function isEntryPoint(argv1) {
  if (!argv1) return false;
  const resolve = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const self = resolve(SCRIPT_PATH);
  if (self === null) {
    return argv1 === process.execPath;
  }
  return resolve(argv1) === self;
}

if (isEntryPoint(process.argv[1])) {
  await main();
}
```

Run: `node --test tests/cli-flags.test.mjs && npm test`
Expected: all PASS

- [ ] **Step 3: Commit**

```bash
git add gitblock.mjs tests/cli-flags.test.mjs
git commit -m "fix: entry-point guard works without a source file (compiled binaries)"
```

---

### Task 11: awk msg-filter for --wipe (no Node dependency)

**Files:**
- Modify: `gitblock.mjs` (`runWipe` lines 610–686)
- Test: `tests/wipe-filter.test.mjs`

**Interfaces:**
- Produces: exported `AWK_STRIP_TRAILERS` (string, POSIX awk program) with output parity to `stripTrailers`; `runWipe` uses `awk -f <tmpfile>` as the msg-filter.

- [ ] **Step 1: Write the failing parity test**

```js
// tests/wipe-filter.test.mjs
import { test } from 'node:test';
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
];

test('awk filter matches stripTrailers on all fixtures', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gb-awk-'));
  t.after(() => spawnSync('rm', ['-rf', dir]));
  const filterFile = path.join(dir, 'strip.awk');
  await writeFile(filterFile, AWK_STRIP_TRAILERS);
  for (const [input, expected] of FIXTURES) {
    const r = spawnSync('awk', ['-f', filterFile], { input, encoding: 'utf8' });
    assert.equal(r.stdout, expected, JSON.stringify(input));
  }
});

test('awk filter agrees with stripTrailers on every fixture', () => {
  for (const [input] of FIXTURES) {
    assert.equal(
      spawnSyncSync(input),
      stripTrailers(input),
      JSON.stringify(input),
    );
  }
});

function spawnSyncSync(input) {
  // Helper kept separate so both tests share one awk invocation path.
  const dir = path.join(tmpdir(), 'gb-awk-inline');
  const r = spawnSync('awk', ['-f', AWK_FILTER_PATH], { input, encoding: 'utf8' });
  return r.stdout;
}
```

Note: write `AWK_FILTER_PATH` as a module-level fixture set up in a `before()` hook instead of the inline helper — see Step 2's test-friendly shape:

```js
// preferred structure for the second test:
let filterFile;
test.before(async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gb-awk2-'));
  t.after(() => spawnSync('rm', ['-rf', dir]));
  filterFile = path.join(dir, 'strip.awk');
  await writeFile(filterFile, AWK_STRIP_TRAILERS);
});
function runAwk(input) {
  return spawnSync('awk', ['-f', filterFile], { input, encoding: 'utf8' }).stdout;
}
test('awk filter agrees with stripTrailers on every fixture', () => {
  for (const [input] of FIXTURES) {
    assert.equal(runAwk(input), stripTrailers(input), JSON.stringify(input));
  }
});
```

Run: `node --test tests/wipe-filter.test.mjs`
Expected: FAIL — `AWK_STRIP_TRAILERS` not exported

- [ ] **Step 2: Implement**

Export in `gitblock.mjs`:

```js
export const AWK_STRIP_TRAILERS = `{
  { lines[NR] = $0 }
  END {
    n = NR
    while (n > 0 && lines[n] ~ /^[ \\t]*$/) n--
    if (n == 0) { for (i = 1; i <= NR; i++) print lines[i]; exit }
    cur = n; cnt = 0
    while (cur > 0) {
      while (cur > 0 && lines[cur] ~ /^[ \\t]/) cur--
      if (cur == 0) break
      if (lines[cur] !~ /^[^ \\t:]+[ \\t]*:/) break
      cnt++; cur--
    }
    if (cnt == 0 || cur == 0) { for (i = 1; i <= NR; i++) print lines[i]; exit }
    if (lines[cur] !~ /^[ \\t]*$/) { for (i = 1; i <= NR; i++) print lines[i]; exit }
    end = cur - 1
    while (end > 0 && lines[end] ~ /^[ \\t]*$/) end--
    for (i = 1; i <= end; i++) print lines[i]
  }
}`;
```

In `runWipe`, replace the generated `.mjs` filter (lines 640–647) and the msg-filter arg:

```js
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gitblock-'));
  const filterFile = path.join(tmpDir, 'strip-trailers.awk');
  await writeFile(filterFile, AWK_STRIP_TRAILERS);
```

and change `'--msg-filter'` value from `` `node ${JSON.stringify(filterFile)}` `` to `awk -f ${JSON.stringify(filterFile)}`.

Run: `node --test tests/wipe-filter.test.mjs && npm test`
Expected: all PASS

- [ ] **Step 3: Commit**

```bash
git add gitblock.mjs tests/wipe-filter.test.mjs
git commit -m "feat: wipe msg-filter runs via awk so it needs no Node"
```

---

### Task 12: Channel detection, semver compare, latest-version fetch

**Files:**
- Modify: `gitblock.mjs` (new exports near the update section)
- Test: `tests/update-core.test.mjs`

**Interfaces:**
- Produces:
  - `detectChannel(argv1, execPath, installBase): 'binary'|'npm'|'manual'|'source'`
  - `isNewerVersion(candidate, current): boolean`
  - `fetchLatestVersion(fetchImpl?): Promise<string|null>`

- [ ] **Step 1: Write the failing tests**

```js
// tests/update-core.test.mjs
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
```

Run: `node --test tests/update-core.test.mjs`
Expected: FAIL — exports missing

- [ ] **Step 2: Implement**

```js
export function detectChannel(argv1, execPath, installBase) {
  if (!argv1 || argv1 === execPath) return 'binary';
  const p = path.resolve(argv1);
  if (p.split(path.sep).includes('node_modules')) return 'npm';
  if (installBase && p.startsWith(installBase)) return 'manual';
  return 'source';
}

export function isNewerVersion(candidate, current) {
  const parse = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parse(candidate), parse(current)];
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

// Returns the newest published version, or null when unreachable.
export async function fetchLatestVersion(fetchImpl = fetch) {
  try {
    const res = await fetchImpl('https://registry.npmjs.org/gitblock/latest', {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    return null;
  }
}
```

Run: `node --test tests/update-core.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 3: Commit**

```bash
git add gitblock.mjs tests/update-core.test.mjs
git commit -m "feat: update-channel detection, semver compare, latest-version fetch"
```

---

### Task 13: --check-update and --update commands

**Files:**
- Modify: `gitblock.mjs` (new `runCheckUpdate`, `runUpdate`, asset-name helper; dispatch in `main()`)
- Test: `tests/update-cmd.test.mjs`

**Interfaces:**
- Consumes: Task 12 exports.
- Produces:
  - `assetName(version, platform, arch)` → `gitblock-v<VERSION>-<os>-<arch>[.exe]` (win32 gets `.exe`; os map: darwin→darwin, linux→linux, win32→win).
  - `swapBinary(execPath, newFile, platform)` — POSIX atomic rename; win32 rename-aside.
  - `runCheckUpdate({ fetchImpl })` — exit 0 always; prints up-to-date or available.
  - `runUpdate({ fetchImpl })` — npm: spawn `npm install -g gitblock@latest`; binary: download+verify+swap; manual/source: guidance only.

- [ ] **Step 1: Write the failing tests**

```js
// tests/update-cmd.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetName, swapBinary, VERSION } from '../gitblock.mjs';

test('asset naming includes version, os, arch, .exe on win32', () => {
  assert.equal(assetName('1.2.3', 'linux', 'x64'), 'gitblock-v1.2.3-linux-x64');
  assert.equal(assetName('1.2.3', 'darwin', 'arm64'), 'gitblock-v1.2.3-darwin-arm64');
  assert.equal(assetName('1.2.3', 'win32', 'x64'), 'gitblock-v1.2.3-win-x64.exe');
});

test('assetName maps current VERSION correctly', () => {
  assert.match(assetName(VERSION, process.platform, process.arch), new RegExp(`^gitblock-v${VERSION}`));
});
```

(`swapBinary` is exercised through integration only — its failure mode is filesystem-level; cover POSIX rename success in a tmp-dir test:)

```js
test('swapBinary replaces target on posix', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gb-swap-'));
  t.after(() => spawnSync('rm', ['-rf', dir]));
  const target = path.join(dir, 'gitblock');
  const fs = await import('node:fs/promises');
  await fs.writeFile(target, 'old', { mode: 0o755 });
  const fresh = path.join(dir, 'fresh');
  await fs.writeFile(fresh, 'new', { mode: 0o755 });
  swapBinary(target, fresh, 'linux');
  assert.equal(await fs.readFile(target, 'utf8'), 'new');
});
```

Run: `node --test tests/update-cmd.test.mjs`
Expected: FAIL — not exported

- [ ] **Step 2: Implement**

```js
export function assetName(version, platform, arch) {
  const osName = platform === 'win32' ? 'win' : platform;
  const ext = platform === 'win32' ? '.exe' : '';
  return `gitblock-v${version}-${osName}-${arch}${ext}`;
}

export function swapBinary(execPath, newFile, platform) {
  if (platform === 'win32') {
    renameSync(execPath, `${execPath}.old`);
    renameSync(newFile, execPath);
  } else {
    renameSync(newFile, execPath);
  }
}
```

(Import `renameSync` from `node:fs`.)

Commands (network paths injected for testability):

```js
async function runCheckUpdate({ fetchImpl }) {
  const latest = await fetchLatestVersion(fetchImpl);
  if (latest === null) {
    console.warn('Warning: could not reach the registry to check for updates.');
    return;
  }
  if (isNewerVersion(latest, VERSION)) {
    console.log(`New version available: ${VERSION} -> ${latest}`);
    console.log('Run "gitblock --update" to install it.');
  } else {
    console.log(`gitblock is up to date (${VERSION}).`);
  }
}

async function runUpdate({ fetchImpl }) {
  const channel = detectChannel(process.argv[1], process.execPath, DEFAULT_INSTALL_BASE);

  if (channel === 'manual') {
    console.log('This copy lives in ~/.local/opt/gitblock. Reinstall via npm or a Release binary:');
    console.log('  npm install -g gitblock');
    return;
  }
  if (channel === 'source') {
    console.log(`Running from a source checkout (${path.dirname(SCRIPT_PATH)}).`);
    console.log('Update with git pull in that directory.');
    return;
  }

  const latest = await fetchLatestVersion(fetchImpl);
  if (latest === null) {
    console.error('Error: could not reach the registry.');
    process.exitCode = 1;
    return;
  }
  if (!isNewerVersion(latest, VERSION)) {
    console.log(`gitblock is up to date (${VERSION}).`);
    return;
  }

  if (channel === 'npm') {
    const r = spawnSync('npm', ['install', '-g', 'gitblock@latest'], { stdio: 'inherit' });
    if (r.status !== 0) process.exitCode = r.status ?? 1;
    else console.log(`Updated gitblock to ${latest}.`);
    return;
  }

  // Binary channel.
  const url =
    `https://github.com/yonasuriv/gitblock/releases/download/v${latest}/` +
    assetName(latest, process.platform, process.arch);
  let body;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error(`Error downloading update: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const dir = path.dirname(process.execPath);
  const tmpBin = path.join(dir, `.gitblock-update-${process.pid}`);
  await writeFile(tmpBin, body, { mode: 0o755 });
  const probe = spawnSync(tmpBin, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    await rm(tmpBin, { force: true });
    console.error('Error: downloaded binary failed to execute; aborting update.');
    process.exitCode = 1;
    return;
  }
  swapBinary(process.execPath, tmpBin, process.platform);
  console.log(`Updated gitblock to ${latest}.`);
}
```

Wire into `main()`:

```js
if (opts.checkUpdate) { await runCheckUpdate({}); return; }
if (opts.update)     { await runUpdate({}); return; }
```

Also delete stale `.old` files next to execPath at startup (Windows cleanup): at the top of `main()`, best-effort:

```js
if (process.platform === 'win32') {
  rm(`${process.execPath}.old`, { force: true }).catch(() => {});
}
```

Run: `node --test tests/update-cmd.test.mjs && npm test`
Expected: all PASS

- [ ] **Step 3: Manual smoke of manual/source channels**

Run: `node gitblock.mjs --check-update` (expect an up-to-date message or a warning — exit 0 either way), then `node gitblock.mjs --update` (expect source-channel guidance).

- [ ] **Step 4: Commit**

```bash
git add gitblock.mjs tests/update-cmd.test.mjs
git commit -m "feat: --check-update and --update with per-channel strategies"
```

---

### Task 14: Packaging defaults, README overhaul, CI + release workflows

**Files:**
- Modify: `config/default.yaml` (`logging: false`)
- Modify: `README.md`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Produces: shippable repo state — CI gate, tag-driven release pipeline.

- [ ] **Step 1: Ship logging off by default**

Set `logging: false` in `config/default.yaml`. Confirm the README config table already says default `false` (it does).

- [ ] **Step 2: Update README**

Add/refresh sections covering: `--version`, `--check-update`, `--update`, `--install --local` (+ guardrails/`--force`/backups), `--uninstall --global|--local`, scoped `config`/`--verify`, installation via `npm i -g gitblock` and GitHub Release binaries (download the matching `gitblock-v<VERSION>-<os>-<arch>` asset, `chmod +x`, put on PATH). Update "How it works" for the local layout.

- [ ] **Step 3: CI workflow**

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    strategy:
      matrix:
        node: [18, 20, 22]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: git config --global user.name ci && git config --global user.email ci@example.com
      - run: npm test
```

- [ ] **Step 4: Release workflow**

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ["v*"]

jobs:
  build:
    strategy:
      matrix:
        include:
          - { os: ubuntu-latest,  target: bun-linux-x64,    asset: linux-x64 }
          - { os: ubuntu-latest,  target: bun-linux-arm64,  asset: linux-arm64 }
          - { os: macos-latest,   target: bun-darwin-x64,   asset: darwin-x64 }
          - { os: macos-latest,   target: bun-darwin-arm64, asset: darwin-arm64 }
          - { os: windows-latest, target: bun-windows-x64,  asset: win-x64.exe }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun build --compile --target ${{ matrix.target }} ./gitblock.mjs --outfile gitblock-${{ github.ref_name }}-${{ matrix.asset }}
      - name: Smoke test
        run: |
          ./gitblock-${{ github.ref_name }}-${{ matrix.asset }} --version
          ./gitblock-${{ github.ref_name }}-${{ matrix.asset }} --help
      - uses: actions/upload-artifact@v4
        with:
          name: gitblock-${{ matrix.asset }}
          path: gitblock-*

  publish:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org/
      - name: Assert tag matches VERSION constant
        run: |
          V=$(grep -oP "VERSION = '\K[^']+" gitblock.mjs)
          [ "v$V" = "${GITHUB_REF_NAME}" ] || { echo "tag ${GITHUB_REF_NAME} != v$V"; exit 1; }
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - uses: softprops/action-gh-release@v2
        with:
          files: gitblock-*
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Note: artifacts land in the publish job via `actions/upload-artifact` + a `actions/download-artifact@v4` step (with `merge-multiple: true`) before the release step — add that download step as the first step of the `publish` job.

- [ ] **Step 5: Full suite green, then commit**

Run: `npm test`
Expected: PASS

```bash
git add config/default.yaml README.md .github/
git commit -m "chore: packaging defaults, docs overhaul, CI and release pipelines"
```

---

## Self-review notes

- Spec coverage: CLI flags (T2), scopes+guardrails (T5/T6), uninstall (T7), config lookup (T8), scoped verify/config (T9), binary-safe entry (T10), awk wipe (T11), channels/version/fetch (T12), check/update cmds (T13), packaging/CI/README/logging default (T14).
- Type consistency: `classifyTarget(dest, src)` used identically in T5/T6/T7; `detectChannel(argv1, execPath, installBase)` signature consistent between T12/T13; `findConflicts(installDir)` shared by T5/T6.
- Windows caveat: T13's `swapBinary` win32 branch cannot be covered by linux CI tests — verified by review only, flagged here deliberately.
