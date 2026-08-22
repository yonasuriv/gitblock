# gitblock

gitblock is a zero-dependency Node.js tool that installs and manages Git
commit hooks for trailer cleanup, plus a one-shot history rewriter that strips
trailers out of an entire repository.

It is built around a small `config.yaml` that lives next to the installed
hooks, so logging, trailer handling, verbosity, and the global enabled state
can be toggled without touching the hook scripts.

## Features

- **Single-command install** — copies the hooks, the CLI itself, and a
  `config.yaml` into one directory and points Git at it with
  `core.hooksPath`.
- **Trailer cleanup** — strips Git trailer blocks from commit messages on
  every commit, or keeps them, depending on the configuration.
- **Enabled switch** — set `enabled: false` and gitblock removes the global
  `core.hooksPath`, so no hook runs at all.
- **Verification** — `--verify` reports whether the global hooks path is set
  and actually applied in the current repository.
- **History rewrite** — `--wipe` rewrites the whole commit history (pushed and
  unpushed): every trailer block is removed and each commit's author and
  committer are reset to your git identity, so only the persona pushing
  remains in the history.
- **Non-interactive mode** — `--yolo` accepts every confirmation automatically
  for scripting and CI.
- **Config CLI** — manage `logging`, `trailers`, `verbose`, and the global
  on/off state from the command line.

## Requirements

- Node.js 18 or newer
- Git
- No third-party dependencies — only Node.js built-ins.

## Repository layout

```
config/default.yaml   # source config; copied as config.yaml at install time
hooks/                # the hook scripts that get installed
gitblock.mjs         # the installer / manager CLI
```

## Installation

All installation behavior is gated behind the `--install` flag. Running the
script without any flags only prints the help screen.

### Default location

```sh
node gitblock.mjs --install
```

Copies the hooks into `$HOME/.local/opt/gitblock/hooks`, the CLI itself into
`$HOME/.local/opt/gitblock/bin/gitblock.mjs`, places `config.yaml` in the
same directory that contains the hooks directory
(`$HOME/.local/opt/gitblock/config.yaml`), and sets the global Git hooks path.

A `gitblock` command is symlinked into `$HOME/.local/bin`, so the CLI is
available as `gitblock` from anywhere (make sure `$HOME/.local/bin` is on
your `PATH`).

### Verifying the install

```sh
node gitblock.mjs --verify
```

Prints where `core.hooksPath` is set globally, whether the hooks directory and
`config.yaml` are in place, and whether the path is actually applied in the
current repository. It flags the two ways an install can be inactive: the
config has `enabled: false`, or a repository-local `core.hooksPath` (such as
`.githooks`) overrides the global one.

You can also check directly with git:

```sh
git config --show-origin --get core.hooksPath
```

A global `core.hooksPath` applies to **every** repository for your user. The
only exception is a repository that sets its own local `core.hooksPath` in
`.git/config` — that value takes precedence and disables gitblock for that
repository alone.

### Custom location

```sh
node gitblock.mjs --install /path/to/hooks
```

### Non-interactive

```sh
node gitblock.mjs --install --yolo
```

## Configuration

The installed `config.yaml` is named `config.yaml` and lives in the same
directory that contains the installed `hooks/` directory.

| Key       | Default | Meaning                                                                 |
|-----------|---------|-------------------------------------------------------------------------|
| `enabled` | `true`  | When `false`, gitblock removes the global hooks path so nothing runs.  |
| `logging` | `false` | Log each trailer action to the log file when enabled.                   |
| `trailer` | `false` | When `true` trailers are kept; when `false` they are stripped.          |
| `verbose` | `false` | Print errors to the terminal instead of failing silently.               |

### Managing the configuration

```sh
# Set a single option (true/false and enable/disable are interchangeable)
node gitblock.mjs config logging true
node gitblock.mjs config trailers false
node gitblock.mjs config verbose enable

# enable / disable shorthand
node gitblock.mjs config enable logging
node gitblock.mjs config disable trailers

# Turn the global hooks on/off entirely
node gitblock.mjs config global disable   # removes core.hooksPath
node gitblock.mjs config global enable    # re-points core.hooksPath

# Print the current configuration
node gitblock.mjs config
```

`config global disable` sets `enabled: false` and removes the global
`core.hooksPath`; `config global enable` sets `enabled: true` and restores it.

## Wiping trailers and authorship from history

Trailer blocks that gitblock normally strips during commits may already exist
in historical commits. `--wipe` rewrites every commit in the repository
(pushed and unpushed): it removes the trailers and resets each commit's
author and committer to your `user.name` / `user.email` from git config
(repo-local values take precedence over global ones), so only the persona
pushing remains in the history. Commit dates are preserved. The confirmation
prompt shows the current working directory it is about to rewrite.

```sh
node gitblock.mjs --wipe
node gitblock.mjs --wipe --yolo   # skip the confirmation
```

`--wipe` refuses to run when `user.name` or `user.email` is not configured,
since those values become the identity of every rewritten commit.

> **Warning** — this rewrites commit SHAs and is destructive for everyone who
> has cloned or pulled the repository. Coordinate with contributors and
> force-push afterwards.

## How it works

1. `gitblock.mjs --install` copies `hooks/*` into the target directory, the
   CLI into `<target>/bin/gitblock.mjs`, and `config/default.yaml` next to
   them as `config.yaml`.
2. It sets `git config --global core.hooksPath` to the hooks directory.
3. On every commit, the `prepare-commit-msg` and `commit-msg` hooks run
   `validate-commit.mjs`, which reads the sibling `config.yaml` and either
   strips the trailer block, logs the action, or does nothing.
4. When `enabled` is `false`, gitblock removes `core.hooksPath`, so no hook
   runs at all; the hook itself also exits immediately as a safeguard.

## Uninstalling

```sh
node gitblock.mjs config global disable
```

Or, to also remove the hooks and config entirely:

```sh
rm -rf "$HOME/.local/opt/gitblock"
rm -f "$HOME/.local/bin/gitblock"
git config --global --unset core.hooksPath
```
