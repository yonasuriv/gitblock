# gitblock productionization — design

Date: 2026-08-22
Status: approved in chat, pending implementation

## Goal

Turn gitblock from a personal script into a shippable tool:

1. Distributable as an npm package (`npm i -g gitblock`) **and** standalone
   compiled binaries on GitHub Releases.
2. Installable globally or per-project (`--local`), with guardrails when the
   target already contains hook files.
3. Version reporting, update checking, and self-update.

## CLI surface

```
gitblock --install [--global|--local] [path]   # scope flag; no flag = --global (backward compatible)
gitblock --uninstall [--global|--local]
gitblock --verify
gitblock --wipe [--yolo]
gitblock --version
gitblock --check-update      # report only, changes nothing
gitblock --update            # check, then perform the update
gitblock config ...          # existing keys unchanged
```

### Install scopes

**Global** (`--global`, default): current behavior — copy hooks into the
target directory (default `~/.local/opt/gitblock/hooks`), set global
`core.hooksPath`.

**Local** (`--local`, operates on cwd):

- Requires cwd to be inside a git work tree; otherwise exit 1 with a clear
  error.
- Creates `.githooks/` at the repository root, copies the three hook files,
  writes `.githooks/config.yaml` (committable, team-shareable).
- Sets repo-local `core.hooksPath = .githooks`.
- `[path]` is ignored in local scope (the repo root is derived via
  `git rev-parse --show-toplevel`).

### Guardrails (both scopes)

Before writing anything, scan the target hooks directory for conflicts:
any of `commit-msg`, `prepare-commit-msg`, `validate-commit.mjs`.

- Conflicts found → abort (exit 1), list every conflicting file, suggest
  `--force`.
- `--force` → each conflicting file is copied to `<name>.bak-<unix-ts>`
  before being overwritten; backup names are printed.
- No conflicts → proceed silently (as today).

Note: a *fresh* global install into an empty dir has no conflicts. Re-running
`gitblock --install --force` is the supported upgrade path for the manual
install layout.

### Uninstall

- `--uninstall --global`: remove the global `core.hooksPath` config (current
  `config global disable` behavior); does not delete files on disk.
- `--uninstall --local`: remove the repo-local `core.hooksPath`. Then remove
  `.githooks/` contents that match exactly what we installed (byte-for-byte
  compare against bundled sources). Files that differ are left in place and
  reported; `.githooks/` itself is removed only when empty afterwards.

## Versioning & updates

- Single source of truth: a `VERSION` constant in `gitblock.mjs`.
  The release workflow stamps `package.json`'s version from it, so npm and
  binaries always agree. `git tag` must equal `v<VERSION>` (workflow asserts).
- `--version`: prints `gitblock <VERSION>`.
- Channel detection for updates:
  - Running from a `node_modules` path (npm global install) → npm channel.
  - Running as a Bun-compiled binary (`process.execPath` is the binary
    itself, not a node interpreter) → binary channel.
  - Running from the manual `~/.local/opt/gitblock` layout → print migration
    guidance ("reinstall via npm or a Release binary"); do not attempt
    in-place mutation of a symlinked layout.
- `--check-update`: fetches the latest version
  (npm registry endpoint `https://registry.npmjs.org/gitblock/latest`,
  fallback: GitHub Releases API) using `fetch` with a 10s timeout; compares
  semver-wise; prints "up to date" or "new version available: X → Y" plus
  the matching command. Network errors are non-fatal (exit 0, warning
  printed).
- `--update`: runs the same check, then:
  - npm channel → `npm install -g gitblock@latest`
  - binary channel → download the release asset for the running
    platform/arch, verify it executes (`--version`), atomically replace
    `process.execPath` (write temp file in same dir, rename over old),
    preserving permissions.
- No automatic phone-home: githooker never checks for updates unless an
  update flag is used.

## Packaging & release pipeline

- `package.json`: name `gitblock`, `"bin": {"gitblock": "./gitblock.mjs"}`,
  `"type": "module"`, files whitelist (`gitblock.mjs`, `hooks/`,
  `config/default.yaml`, `README.md`), engines `>=18`, repository/license
  fields. No dependencies.
- `.github/workflows/ci.yml`: on push/PR — `node --test` across Node 18/20/22
  on ubuntu.
- `.github/workflows/release.yml`: on tag push `v*`:
  1. Assert tag equals `VERSION`.
  2. Run test suite (gate).
  3. `bun build --compile --target` matrix: linux-x64, linux-arm64,
     darwin-x64, darwin-arm64, win-x64 → `gitblock-<os>-<arch>` assets.
  4. Smoke-test each asset (`--version`, `--help`).
  5. Attach assets to a GitHub Release; publish to npm (`NPM_TOKEN` secret).

## Code organization

`gitblock.mjs` stays the single entry point but is split internally into
focused units so the size stays manageable:

- arg parsing / usage (exists)
- install/uninstall per scope (refactor of `runInstall`)
- guardrail scan + backup helpers (new)
- wipe (exists, incl. identity reset)
- version/update commands (new)
- shared spawn/config helpers (exist)

Hooks and `stripTrailers` remain untouched except for the config lookup
change below.

## Config lookup change (hooks)

`validate-commit.mjs` currently resolves config as `hookDir/../config.yaml`.
For local installs this would point at the repo root. New lookup order:

1. `hookDir/../config.yaml` (global layout — unchanged behavior)
2. `hookDir/config.yaml` (`.githooks/config.yaml` — local layout)

First existing wins; defaults otherwise.

## Error handling & exit codes

| Situation | Exit |
|---|---|
| Success | 0 |
| Usage error / unknown flag | 1 (+usage) |
| Not inside a git repo where required | 1 |
| Install conflict without `--force` | 1 |
| Missing git identity on wipe | 1 |
| filter-branch failure | child status |
| Update check network failure | 0 with warning (explicitly non-fatal) |

Errors always go to stderr; `verbose` config continues to govern hook-side
silence.

## Testing

- Unit (`node:test`, no new deps): `parseArgs`, `stripTrailers`, guardrail
  scanner, backup naming, semver compare, channel detection (path/env based).
- Integration: spawn the CLI against temp repos with isolated `HOME` /
  `GIT_CONFIG_GLOBAL`:
  - local install writes `.githooks/`, sets local hooksPath, hooks fire on
    commit and strip trailers
  - conflict abort lists files; `--force` produces `.bak-*` copies
  - uninstall leaves foreign files, removes ours
  - `--wipe` resets authorship (existing behavior, now pinned by test)
  - `--version` output format
  - update check against a stubbed registry response (unit-level; network
    paths mocked)

## Out of scope

- Auto-update background checks or telemetry.
- Windows `core.hooksPath` quirks beyond what git handles natively.
- Migrating existing `~/.local/opt/githooker` installs automatically.
