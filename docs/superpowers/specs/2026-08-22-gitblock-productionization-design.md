# gitblock productionization — design

Date: 2026-08-22
Status: approved in chat; revised after QA review (same day)

## Goal

Turn gitblock from a personal script into a shippable tool:

1. Distributable as an npm package (`npm i -g gitblock`) **and** standalone
   compiled binaries on GitHub Releases.
2. Installable globally or per-project (`--local`), with guardrails when the
   target already contains foreign hook files.
3. Version reporting, update checking, and self-update.

## CLI surface

```
gitblock --install [--global|--local] [path]   # scope flag; no flag = --global (backward compatible)
gitblock --uninstall [--global|--local]
gitblock --verify [--global|--local]
gitblock --wipe [--yolo]
gitblock --version
gitblock --check-update      # report only, changes nothing
gitblock --update            # check, then perform the update
gitblock config <key> <value> [--global|--local]
```

### Install scopes

**Global** (`--global`, default): current behavior — copy hooks into the
target directory (default `~/.local/opt/gitblock/hooks`), set global
`core.hooksPath`.

**Local** (`--local`, operates on cwd):

- Requires cwd to be inside a git work tree; otherwise exit 1 with a clear
  error.
- Creates `.githooks/` at the repository root, copies exactly the three hook
  files (`commit-msg`, `prepare-commit-msg`, `validate-commit.mjs`), writes
  `.githooks/config.yaml` (committable, team-shareable).
- Sets repo-local `core.hooksPath = .githooks`.
- `[path]` is ignored in local scope (the repo root comes from
  `git rev-parse --show-toplevel`).
- Local installs do **not** bake the log-file path into the copied
  `validate-commit.mjs` (the global installer's line-rewrite step is skipped),
  so installed files stay identical to bundled sources.

### File copying rule (both scopes)

The hook copy copies **only** `HOOK_FILES` by name — the current `readdir`
loop (which sweeps stray files from `hooks/`) is replaced. Stray working-tree
files never reach an install or a guardrail scan.

`config.yaml` is created only if absent; an existing config is never
overwritten by install or update.

### Guardrails (both scopes)

Before writing anything, scan the target hooks directory for each file in
`HOOK_FILES`.

Classification:

- **Ours** — content matches the bundled source (normalized: trimmed
  trailing whitespace, LF normalized). Ours are upgraded silently;
  reinstalling stays idempotent (`--install` remains valid as the fix
  suggested by `--verify`).
- **Foreign** — anything else occupying a `HOOK_FILES` name (including
  previous `.bak-*` backups is *not* a conflict; backups are ignored).

Behavior on foreign conflicts:

- Abort (exit 1), list every conflicting file, suggest `--force`.
- `--force` → each conflicting file is copied to `<name>.bak-<unix-ts>`
  before being overwritten; backup names are printed.
- No foreign conflicts → proceed silently.

### Uninstall

- `--uninstall --global`: unset the global `core.hooksPath` only. It does
  **not** touch the `enabled` flag in any config.yaml (`config global
  disable` remains the separate, stronger action).
- `--uninstall --local`: remove the repo-local `core.hooksPath`. Then, inside
  `.githooks/`: remove hook files classified as **ours** (see guardrails);
  leave everything else (including `.githooks/config.yaml`, which is
  user-owned) in place and report what was left. Remove `.githooks/` itself
  only when empty afterwards.

## Versioning & updates

- Single source of truth: a `VERSION` constant in `gitblock.mjs`.
  The release workflow stamps `package.json`'s version from it, so npm and
  binaries always agree. The tag must equal `v<VERSION>` (workflow asserts).
- `--version`: prints `gitblock <VERSION>`.
- Channel detection (in order):
  1. Resolve `realpath(process.argv[1])` (fall back to `argv[1]` if it
     cannot be resolved).
  2. If `argv[1]` resolves to `process.execPath` (the running file **is**
     the executable) → **binary channel**.
  3. Else if the resolved path contains `node_modules` → **npm channel**.
  4. Else if the resolved path is under `~/.local/opt/gitblock/` → **manual
     channel**: print migration guidance ("reinstall via npm or a Release
     binary"); exit 0 without changing anything.
  5. Otherwise (source checkout) → **source channel**: print guidance
     ("update with git pull in <repo dir>"); exit 0.
- `--check-update`: fetches the latest version (npm registry endpoint
  `https://registry.npmjs.org/gitblock/latest`, fallback: GitHub Releases
  API) using `fetch` with a 10s timeout; compares semver-wise; prints
  "up to date" or "new version available: X → Y" plus the matching command.
  Network errors are non-fatal (exit 0, warning printed).
- `--update`: runs the same check (aborting with nothing done when already
  up to date), then:
  - npm channel → spawn `npm install -g gitblock@latest`.
  - binary channel → download the release asset matching the running
    platform/arch (`gitblock-v<VERSION>-<os>-<arch>[.exe]`), write it next to
    the running binary, verify it executes (`<newfile> --version` prints the
    new version), then swap:
    - POSIX: `rename(new, execPath)` (atomic replace).
    - Windows: `rename(execPath, execPath + ".old")` then
      `rename(new, execPath)`; the `.old` file is deleted best-effort at the
      start of the next successful run.
- No automatic phone-home: gitblock never checks for updates unless an
  update flag is used.

## Standalone-binary constraints (applies to every subcommand)

Compiled binaries have no source file on disk, which breaks two current
mechanisms. The implementation must:

1. Replace the `--wipe` msg-filter's generated script (currently
   `import { stripTrailers } from SCRIPT_PATH` executed via `node`) with a
   self-contained **awk** filter written to the temp dir and run directly.
   Git distributions ship awk everywhere, including Git-for-Windows, so
   `--wipe` keeps working on machines with no Node.
2. Make the CLI entry-point guard tolerant of a nonexistent
   `SCRIPT_PATH`: if `import.meta.url` does not resolve to a real file
   (compiled binary), treat the module as the entry point instead of
   throwing ENOENT from `realpathSync`.

## Packaging & release pipeline

- `package.json`: name `gitblock`, `"bin": {"gitblock": "./gitblock.mjs"}`,
  `"type": "module"`, files whitelist (`gitblock.mjs`, `hooks/`,
  `config/default.yaml`, `README.md`), engines `>=18`, repository/license
  fields. No dependencies.
- `config/default.yaml` ships `logging: false` (packaged products do not log
  silently out of the box); README table already documents false.
- `.github/workflows/ci.yml`: on push/PR — `node --test` across Node
  18/20/22 on ubuntu.
- `.github/workflows/release.yml`: on tag push `v*`:
  1. Assert tag equals `VERSION`.
  2. Run test suite (gate).
  3. Build assets with Bun (`bun build --compile`) named
     `gitblock-v<VERSION>-<os>-<arch>` plus `.exe` for win-x64:
     linux-x64, linux-arm64, darwin-x64, darwin-arm64, win-x64.
  4. Smoke-test each asset **on a matching OS runner** (`--version`,
     `--help`; ubuntu runs the linux assets, macos the darwin ones, windows
     the exe).
  5. Attach assets to a GitHub Release; publish to npm (`NPM_TOKEN` secret).

## Code organization

`gitblock.mjs` stays the single entry point but is split internally into
focused units so the size stays manageable:

- arg parsing / usage (exists)
- install/uninstall per scope (refactor of `runInstall`)
- guardrail classification + backup helpers (new)
- wipe (exists, incl. identity reset; gains awk filter)
- version/update commands (new)
- shared spawn/config helpers (exist)

`stripTrailers` is **unified**: the subject-line guard that currently lives
only in the hook (`validate-commit.mjs`) moves into the shared
implementation used by both the hook and `--wipe`, eliminating the divergence
where wipe could eat a message consisting solely of a conventional-commit
subject.

## Config lookup change (hooks)

`validate-commit.mjs` currently resolves config as `hookDir/../config.yaml`.
New lookup order:

1. `hookDir/config.yaml` (`.githooks/config.yaml` — local layout)
2. `hookDir/../config.yaml` (global layout)

First existing wins; defaults otherwise. Order matters: for a local install,
step 1 hits `.githooks/config.yaml` before step 2 could ever see an unrelated
`<repo-root>/config.yaml`, so unrelated root configs can no longer shadow the
local install. For the global layout, `hookDir/config.yaml` does not exist,
preserving today's behavior exactly.

### Scope resolution for `config` and `--verify`

Both auto-detect the effective layout in the current repository: if
repo-local `core.hooksPath` points at a `.githooks` dir containing our
marker files, they operate on the local layout; otherwise on the global one.
Explicit `--local` / `--global` flags override detection. Outside a repo,
they fall back to global.

## Error handling & exit codes

| Situation | Exit |
|---|---|
| Success | 0 |
| Usage error / unknown flag | 1 (+usage) |
| Not inside a git repo where required | 1 |
| Foreign conflict without `--force` | 1 |
| Missing git identity on wipe | 1 |
| filter-branch failure | child status |
| Update check network failure | 0 with warning (explicitly non-fatal) |

Errors always go to stderr; `verbose` config continues to govern hook-side
silence.

## Testing

- Unit (`node:test`, no new deps): `parseArgs`, unified `stripTrailers`
  (incl. subject-only messages), guardrail classifier, backup naming, semver
  compare, channel detection (path-based cases), awk filter output parity
  against `stripTrailers` on fixture messages.
- Integration: spawn the CLI against temp repos with isolated `HOME` /
  `GIT_CONFIG_GLOBAL`:
  - local install writes `.githooks/`, sets local hooksPath, hooks fire on
    commit and strip trailers
  - idempotent reinstall succeeds silently; foreign conflict aborts listing
    files; `--force` produces `.bak-*` copies
  - uninstall removes ours, leaves foreign files and config.yaml
  - `--wipe` resets authorship and preserves subject-only messages
  - `--version` output format
  - update check against a stubbed registry response (network paths mocked)

## Out of scope

- Auto-update background checks or telemetry.
- Windows binary self-update beyond the rename-aside strategy above.
- Migrating existing `~/.local/opt/gitblock` installs automatically.
