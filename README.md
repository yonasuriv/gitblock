# githooker

githooker is a zero-dependency Node.js tool that installs and manages Git
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
- **Enabled switch** — set `enabled: false` and githooker removes the global
  `core.hooksPath`, so no hook runs at all.
- **History rewrite** — `--wipe` rewrites the whole commit history (pushed and
  unpushed) and removes every trailer block.
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
githooker.mjs         # the installer / manager CLI
```

## Installation

All installation behavior is gated behind the `--install` flag. Running the
script without any flags only prints the help screen.

### Default location

```sh
node githooker.mjs --install
```

Copies the hooks into `$HOME/.local/opt/githooker/hooks`, the CLI itself into
`$HOME/.local/opt/githooker/bin/githooker.mjs`, places `config.yaml` in the
same directory that contains the hooks directory
(`$HOME/.local/opt/githooker/config.yaml`), and sets the global Git hooks path.

### Verifying the install

```sh
git config --show-origin --get core.hooksPath
```

After installing, this shows where the hooks path is enabled and its origin
(e.g. `file:/home/you/.gitconfig /home/you/.local/opt/githooker/hooks`). If a
repository-local `core.hooksPath` (such as `.githooks`) is set, it takes
precedence over the global one; githooker prints a warning when that happens.

### Custom location

```sh
node githooker.mjs --install /path/to/hooks
```

### Non-interactive

```sh
node githooker.mjs --install --yolo
```

## Configuration

The installed `config.yaml` is named `config.yaml` and lives in the same
directory that contains the installed `hooks/` directory.

| Key       | Default | Meaning                                                                 |
|-----------|---------|-------------------------------------------------------------------------|
| `enabled` | `true`  | When `false`, githooker removes the global hooks path so nothing runs.  |
| `logging` | `false` | Log each trailer action to the log file when enabled.                   |
| `trailer` | `false` | When `true` trailers are kept; when `false` they are stripped.          |
| `verbose` | `false` | Print errors to the terminal instead of failing silently.               |

### Managing the configuration

```sh
# Set a single option (true/false and enable/disable are interchangeable)
node githooker.mjs config logging true
node githooker.mjs config trailers false
node githooker.mjs config verbose enable

# enable / disable shorthand
node githooker.mjs config enable logging
node githooker.mjs config disable trailers

# Turn the global hooks on/off entirely
node githooker.mjs config global disable   # removes core.hooksPath
node githooker.mjs config global enable    # re-points core.hooksPath

# Print the current configuration
node githooker.mjs config
```

`config global disable` sets `enabled: false` and removes the global
`core.hooksPath`; `config global enable` sets `enabled: true` and restores it.

## Wiping trailers from history

Trailer blocks that githooker normally strips during commits may already exist
in historical commits. `--wipe` rewrites every commit in the repository
(pushed and unpushed) and removes the trailers. The confirmation prompt shows
the current working directory it is about to rewrite.

```sh
node githooker.mjs --wipe
node githooker.mjs --wipe --yolo   # skip the confirmation
```

> **Warning** — this rewrites commit SHAs and is destructive for everyone who
> has cloned or pulled the repository. Coordinate with contributors and
> force-push afterwards.

## How it works

1. `githooker.mjs --install` copies `hooks/*` into the target directory, the
   CLI into `<target>/bin/githooker.mjs`, and `config/default.yaml` next to
   them as `config.yaml`.
2. It sets `git config --global core.hooksPath` to the hooks directory.
3. On every commit, the `prepare-commit-msg` and `commit-msg` hooks run
   `validate-commit.mjs`, which reads the sibling `config.yaml` and either
   strips the trailer block, logs the action, or does nothing.
4. When `enabled` is `false`, githooker removes `core.hooksPath`, so no hook
   runs at all; the hook itself also exits immediately as a safeguard.

## Uninstalling

```sh
node githooker.mjs config global disable
```

Or, to also remove the hooks and config entirely:

```sh
rm -rf "$HOME/.local/opt/githooker"
git config --global --unset core.hooksPath
```
