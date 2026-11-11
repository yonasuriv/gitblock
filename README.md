<div align="center">
  <div style="display: inline-flex; align-items: center; gap: 12px;">
    <img src=".github/assets/logo-icon.svg" alt="" height="70">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset=".github/assets/logo-dark.png">
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-light.png">
      <img src=".github/assets/logo-dark.png" alt="Gitblock Logo"  height="64">
    </picture>
  </div>
</div>

---

<div align="center">
  <p>
    <b>Gitblock</b> is a zero-dependency Node.js tool that installs and manages Git commit hooks for trailer cleanup, <br>preventing the injection of vendor data in your commits.
  </p>
</div>

---

It is built around a small `config.yaml` that lives next to the installed
hooks, so logging, trailer handling, verbosity, and the global enabled state
can be toggled without touching the hook scripts.

## Features

- **Single-command install** — copies the hooks, the CLI itself, and a
  `config.yaml` into one directory and points Git at it with
  `core.hooksPath`. Installs **globally** (every repository for your user)
  or **locally** (a single repository, via a committable `.githooks/`
  directory).
- **Trailer cleanup** — strips Git trailer blocks from commit messages on
  every commit, or keeps them, depending on the configuration.
- **AI-attribution scrubbing** — always removes agent traces from commit
  messages wherever they appear: `Co-authored-by:` trailers (even without a
  blank-line separator), `Generated with ...` lines, `Claude-*:` key/value
  trailers (e.g. `Claude-Session:`), and lines that consist solely of a
  Claude/Anthropic URL. This applies in both trailer modes.
- **Guardrails** — installs refuse to clobber hook files they don't own;
  `--force` overwrites them with timestamped `.bak-*` backups.
- **Enabled switch** — set `enabled: false` and gitblock removes the global
  `core.hooksPath`, so no hook runs at all.
- **Verification** — `--verify` reports whether the hooks path is set
  and actually applied in the current repository.
- **History rewrite** — `--wipe` rewrites the whole commit history (pushed and
  unpushed): every trailer block and AI-attribution line is removed and each
  commit's author and committer are reset to your git identity, so only the
  persona pushing remains in the history.
- **Non-interactive mode** — `--yolo` accepts every confirmation automatically
  for scripting and CI.
- **Config CLI** — manage `logging`, `trailers`, `verbose`, and the global
  on/off state from the command line.
- **Versioning and updates** — `--version`, `--check-update`, and
  `--update`, aware of how gitblock was installed (npm package, standalone
  binary, manual copy, or source checkout).

## Requirements

- Node.js 18 or newer (not required when using a standalone binary —
  `--wipe` uses awk, which ships with every Git distribution)
- Git
- No third-party dependencies — only Node.js built-ins.

## Installation

### npm (pending — not yet published)

> **Pending** — `gitblock` is not published to the npm registry yet, so
> `npm i -g gitblock` currently fails with `E404`. Use
> [From source](#from-source) until the package is live.

```sh
npm i -g gitblock
```

This puts the `gitblock` command on your `PATH`. Then run:

```sh
gitblock --install
```

### GitHub Release binaries

Standalone compiled binaries are attached to every
[GitHub Release](https://github.com/yonasuriv/gitblock/releases) as
`gitblock-v<VERSION>-<os>-<arch>` assets (`linux-x64`, `linux-arm64`,
`darwin-x64`, `darwin-arm64`, `win-x64.exe`). Download the one matching your
platform, make it executable, and put it on your `PATH`:

```sh
curl -LO https://github.com/yonasuriv/gitblock/releases/download/v<VERSION>/gitblock-v<VERSION>-linux-x64
chmod +x gitblock-v<VERSION>-linux-x64
mv gitblock-v<VERSION>-linux-x64 ~/.local/bin/gitblock
gitblock --version   # smoke test
```

> **Note** — compiled binaries carry no hook sources on disk, so `--install`
> is unavailable in that channel: run `gitblock --verify`, `config`,
> `--wipe`, and `--update` from the binary, but install hooks from a source
> checkout via `node gitblock.mjs --install` (or, once published,
> `npm i -g gitblock && gitblock --install`).

### From source

Clone this repository and run `node gitblock.mjs` directly, or use it to
install itself (see below).

All installation behavior is gated behind the `--install` flag. Running the
CLI without any flags only prints the help screen.

## Installing hooks

### Global scope (default)

```sh
gitblock --install            # or: node gitblock.mjs --install
gitblock --install /path/to/hooks
gitblock --install=<path>
```

Copies the hooks into `$HOME/.local/opt/gitblock/hooks`, the CLI itself into
`$HOME/.local/opt/gitblock/bin/gitblock.mjs`, places `config.yaml` in the
same directory that contains the hooks directory
(`$HOME/.local/opt/gitblock/config.yaml`), and sets the **global** Git hooks
path.

A `gitblock` command is symlinked into `$HOME/.local/bin`, so the CLI is
available as `gitblock` from anywhere (make sure `$HOME/.local/bin` is on
your `PATH`).

A global `core.hooksPath` applies to **every** repository for your user. The
only exception is a repository that sets its own local `core.hooksPath` in
`.git/config` — that value takes precedence and disables gitblock for that
repository alone.

### Local scope (per repository)

```sh
cd /path/to/repo
gitblock --install --local
```

Requires the current directory to be inside a git work tree (otherwise it
exits with an error). Creates a `.githooks/` directory at the repository root
containing exactly the three hook files (`commit-msg`,
`prepare-commit-msg`, `validate-commit.mjs`) and a `.githooks/config.yaml`,
and sets the **repo-local** `core.hooksPath` to `.githooks`.

The local `config.yaml` is committable, so teams can share the same trailer
policy through the repository itself. A `[path]` argument is ignored in local
scope — the target always comes from `git rev-parse --show-toplevel`.

### Guardrails and `--force`

Before writing anything, gitblock scans the target hooks directory for its own
hook file names and classifies what it finds:

- **Ours** — content matches the bundled sources. These are upgraded
  silently, so reinstalling is idempotent (`--install` is also the fix
  suggested by `--verify`).
- **Foreign** — anything else occupying one of those names. On a conflict,
  the install **aborts** (exit 1) and lists every conflicting file.

```sh
gitblock --install --force
```

`--force` copies each conflicting file to `<name>.bak-<unix-timestamp>`
before overwriting it and prints the backup names. Backup files themselves
are ignored by future scans.

`config.yaml` is only created when absent — an existing configuration is
never overwritten by an install.

## Verifying the install

```sh
gitblock --verify              # auto-detects local vs global
gitblock --verify --global     # force the global check
gitblock --verify --local      # force the local check
```

Prints where `core.hooksPath` is set, whether the hooks directory and
`config.yaml` are in place, and whether the path is actually applied in the
current repository. It flags the two ways an install can be inactive: the
config has `enabled: false`, or a repository-local `core.hooksPath` (such as
`.githooks`) overrides the global one.

You can also check directly with git:

```sh
git config --show-origin --get core.hooksPath
```

`--verify` and the `config` command auto-detect which install applies here:
if the repository's local `core.hooksPath` points at a `.githooks` directory
with gitblock's marker files, they operate on the local install; otherwise on
the global one. Explicit `--local` / `--global` flags override the detection,
and outside any repository they fall back to global.

## Configuration

The installed `config.yaml` lives next to the installed hooks directory
(`$HOME/.local/opt/gitblock/config.yaml` for the global scope,
`.githooks/config.yaml` for the local scope).

| Key       | Default | Meaning                                                                 |
|-----------|---------|-------------------------------------------------------------------------|
| `enabled` | `true`  | When `false`, gitblock removes the global hooks path so nothing runs.  |
| `logging` | `false` | Log each trailer action to the log file when enabled.                   |
| `trailer` | `false` | When `true` trailers are kept; when `false` they are stripped. AI-attribution lines are always stripped regardless of this setting. |
| `verbose` | `false` | Print errors to the terminal instead of failing silently.               |

### Managing the configuration

```sh
# Set a single option (true/false and enable/disable are interchangeable)
gitblock config logging true
gitblock config trailers false
gitblock config verbose enable

# enable / disable shorthand
gitblock config enable logging
gitblock config disable trailers

# Turn the global hooks on/off entirely
gitblock config global disable   # removes core.hooksPath
gitblock config global enable    # re-points core.hooksPath

# Print the current configuration
gitblock config
```

Like `--verify`, `config <key> <value>` operates on the detected (or flag-
forced) scope: `--local` edits `.githooks/config.yaml` of the current
repository, `--global` (or running outside a repository) edits the global
one. Note that `config global disable` remains available even after an
uninstall-style `core.hooksPath` removal — it is the stronger action that
also records `enabled: false` in the config.

## Uninstalling

```sh
gitblock --uninstall             # global scope
gitblock --uninstall --local     # this repository's .githooks install
```

- **Global**: unsets the global `core.hooksPath` only. It does not touch the
  `enabled` flag in any `config.yaml`.
- **Local**: removes the repo-local `core.hooksPath`, then cleans `.githooks/`
  ownership-aware: any file that is identical to what gitblock installs
  (hook files, and an untouched default `config.yaml`) is deleted; any file
  you changed or added — including a customized `config.yaml` — is kept and
  reported. `.githooks/` itself is removed only when nothing remains in it.

To fully remove a global install, also delete the files:

```sh
rm -rf "$HOME/.local/opt/gitblock"
rm -f "$HOME/.local/bin/gitblock"
```

Or, to just deactivate the hooks while keeping them installed:

```sh
gitblock config global disable
```

## Version and updates

```sh
gitblock --version        # prints "gitblock <VERSION>"
gitblock --check-update   # report only, changes nothing
gitblock --update         # check, then perform the update
```

gitblock detects how it is being run and picks a matching update strategy:

- **npm** (running from a `node_modules` path): `npm install -g gitblock@latest`.
- **binary** (the running file is a compiled executable): downloads the
  release asset matching your platform/architecture, verifies it executes,
  and swaps it in place (atomic rename on POSIX; rename-aside on Windows).
- **manual** (running from the old `~/.local/opt/gitblock` layout): prints
  migration guidance and exits — reinstall via npm or a Release binary.
- **source** (a checkout of this repository): points you at `git pull` in
  the repository directory.

`--check-update` queries the npm registry (falling back to the GitHub
Releases API) with a short timeout and compares versions semver-wise. Network
errors are non-fatal: a warning is printed and the command exits 0. gitblock
never phones home on its own — update checks happen only when you run an
update command.

## Wiping trailers and authorship from history

Trailer blocks that gitblock normally strips during commits may already exist
in historical commits. `--wipe` rewrites every commit in the repository
(pushed and unpushed): it removes the trailers and resets each commit's
author and committer to your `user.name` / `user.email` from git config
(repo-local values take precedence over global ones), so only the persona
pushing remains in the history. Commit dates are preserved. The confirmation
prompt shows the current working directory it is about to rewrite.

```sh
gitblock --wipe
gitblock --wipe --yolo   # skip the confirmation
```

`--wipe` refuses to run when `user.name` or `user.email` is not configured,
since those values become the identity of every rewritten commit.

Because the rewrite filter is generated awk rather than Node code, `--wipe`
works even when run from a standalone binary on machines without Node.js
installed.

> **Warning** — this rewrites commit SHAs and is destructive for everyone who
> has cloned or pulled the repository. Coordinate with contributors and
> force-push afterwards.

## How it works

1. `gitblock --install` (or `--install --local`) copies the bundled hook
   files into the target directory — `~/.local/opt/gitblock/hooks/` for the
   global scope, `<repo-root>/.githooks/` for the local scope — along with a
   `config.yaml` created from `config/default.yaml` (only if none exists).
2. For the global scope it sets `git config --global core.hooksPath`; for
   the local scope it sets the repo-local `core.hooksPath = .githooks`.
3. On every commit, the `prepare-commit-msg` and `commit-msg` hooks run
   `validate-commit.mjs`, which reads its sibling `config.yaml` and either
   strips the trailer block, logs the action, or does nothing.
4. When `enabled` is `false`, gitblock removes `core.hooksPath`, so no hook
   runs at all; the hook itself also exits immediately as a safeguard.

## Development

```sh
npm test    # runs the test suite with the built-in node:test runner
```

No dependencies to install — tests use only Node.js built-ins and temporary
git repositories.
