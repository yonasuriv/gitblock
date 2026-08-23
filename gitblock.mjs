#!/usr/bin/env node

/**
 * gitblock — installer and manager for the Git commit hooks.
 *
 * All install/uninstall behavior only triggers when the `--install` flag is
 * passed (optionally with a target directory: `--install <path>`). Running
 * the script without any flags prints help.
 *
 * Installing copies the hooks, the CLI itself, and the config into the target
 * directory (hooks into `path`, the CLI into `path/bin`, and `config.yaml`
 * alongside).
 *
 * Usage:
 *   node gitblock.mjs --install [path]      Install hooks (sets core.hooksPath)
 *   node gitblock.mjs --install=<path>      Same, directory inline
 *   node gitblock.mjs --verify              Check whether the global hooks path is applied
 *   node gitblock.mjs --wipe                Strip trailers and reset commit authorship in history
 *   node gitblock.mjs --yolo                Non-interactive: auto-accept prompts
 *   node gitblock.mjs config <what> <value> Manage the installed configuration
 *
 * Config management:
 *   node gitblock.mjs config <logging|trailers|verbose|enabled> <true|false|enable|disable>
 *   node gitblock.mjs config enable|disable <logging|trailers|verbose|enabled>
 *   node gitblock.mjs config global enable|disable
 */

import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync, renameSync } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rmdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);

// Sources live beside the script in a repo checkout or npm install, and one
// level up when running from the manual layout's bin/ directory. Prefer the
// nearer location; null when neither exists (compiled binaries).
function resolveSourceDir(...segments) {
  for (const base of [SCRIPT_DIR, path.join(SCRIPT_DIR, '..')]) {
    const candidate = path.join(base, ...segments);
    if (existsSync(candidate)) return candidate;
  }
  return path.join(SCRIPT_DIR, ...segments);
}

export const SOURCE_HOOKS_DIR = resolveSourceDir('hooks');
export const SOURCE_CONFIG = resolveSourceDir('config', 'default.yaml');
const DEFAULT_INSTALL_BASE = path.join(os.homedir(), '.local', 'opt', 'gitblock');
const DEFAULT_INSTALL_DIR = path.join(DEFAULT_INSTALL_BASE, 'hooks');
const HOOK_FILES = ['validate-commit.mjs', 'prepare-commit-msg', 'commit-msg'];
const CONFIG_KEYS = ['enabled', 'logging', 'trailer', 'verbose'];

export const VERSION = '1.0.0';

const BOOL_WORDS = {
  true: true,
  false: false,
  enable: true,
  disable: false,
  on: true,
  off: false,
  yes: true,
  no: false,
  y: true,
  n: false,
};

function parseBool(value) {
  const s = String(value).trim().toLowerCase();
  return s in BOOL_WORDS ? BOOL_WORDS[s] : undefined;
}

export function parseArgs(argv) {
  const opts = {
    install: false,
    installDir: undefined,
    wipe: false,
    verify: false,
    yolo: false,
    help: false,
    global: false,
    local: false,
    force: false,
    uninstall: false,
    versionFlag: false,
    checkUpdate: false,
    update: false,
    config: [],
    configCommand: false,
    unknown: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--install') {
      opts.install = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        opts.installDir = next;
        i += 1;
      }
    } else if (arg.startsWith('--install=')) {
      opts.install = true;
      opts.installDir = arg.slice('--install='.length);
    } else if (arg === '--wipe') {
      opts.wipe = true;
    } else if (arg === '--verify') {
      opts.verify = true;
    } else if (arg === '--yolo') {
      opts.yolo = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
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
    } else if (arg === 'config') {
      opts.configCommand = true;
      opts.config = argv.slice(i + 1);
      break;
    } else if (!arg.startsWith('-')) {
      opts.installDir = arg;
    } else if (arg.startsWith('--')) {
      opts.unknown.push(arg);
    }
  }

  return opts;
}

function printUsage() {
  console.log(`gitblock — Git commit-hook installer and manager

Usage:
  node gitblock.mjs --install [path]      Install hooks into "path" (default: ${DEFAULT_INSTALL_DIR}) and set core.hooksPath
  node gitblock.mjs --install=<path>      Same, directory inline
  node gitblock.mjs --verify              Check whether the global hooks path is applied
  node gitblock.mjs --wipe                Wipe trailers and reset commit authorship in history (destructive)
  node gitblock.mjs --yolo                Non-interactive mode: auto-accept every prompt
  node gitblock.mjs config <what> <value> Manage the installed configuration

Config management:
  node gitblock.mjs config <logging|trailers|verbose|enabled> <true|false|enable|disable>
  node gitblock.mjs config enable|disable <logging|trailers|verbose|enabled>
  node gitblock.mjs config global enable|disable

Flags:
  --install [path]   Install the hooks. All install behavior only runs with this flag.
  --install=<path>   Same, with the target directory inline.
  --verify           Report whether the global core.hooksPath is set and applied here.
  --wipe             Rewrite the whole commit history: strip every Git trailer and
                     reset each commit's author/committer to your git identity.
  --yolo             Accept install and wipe confirmations automatically (no prompts).
  --uninstall        Remove the gitblock hooks (global, or local with --local).
  --local            Operate on this repository's .githooks install instead of the global one.
  --global           Force the global scope regardless of any local install.
  --force            Overwrite foreign files during install (backing them up first).
  --version          Print the gitblock version and exit.
  --check-update     Check the registry for a newer gitblock release.
  --update           Download and install a newer gitblock release.
  -h, --help         Show this help.`);
}

async function askConfirm(promptText, { yolo = false, defaultYes = false } = {}) {
  if (yolo) {
    return true;
  }
  if (!process.stdin.isTTY) {
    return defaultYes;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(promptText);
    const choice = answer.trim().toLowerCase();
    if (defaultYes) {
      return choice === '' || choice === 'y' || choice === 'yes';
    }
    return choice === 'y' || choice === 'yes';
  } finally {
    rl.close();
  }
}

// Compiled binaries carry no hooks/ or config/ directory on disk, so any
// install attempt would crash with raw ENOENT stack traces. Detect that up
// front and point users at the npm channel instead.
export function findMissingSources() {
  const missing = [];
  if (!existsSync(SOURCE_HOOKS_DIR)) missing.push(SOURCE_HOOKS_DIR);
  if (!existsSync(SOURCE_CONFIG)) missing.push(SOURCE_CONFIG);
  return missing;
}

function reportMissingSources() {
  console.error('Error: this gitblock installation has no hook sources on disk.');
  console.error('Compiled binaries cannot install hooks directly; install via npm instead:');
  console.error('  npm install -g gitblock');
  console.error('then run:');
  console.error('  gitblock --install');
  process.exitCode = 1;
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function loadConfigFile(configFile) {
  const defaults = { enabled: true, logging: false, trailer: false, verbose: false };

  try {
    const raw = await readFile(configFile, 'utf8');
    const config = { ...defaults };

    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/u);
      if (!match) {
        continue;
      }

      const [, key, value] = match;
      if (value === '') {
        continue;
      }

      config[key] = value === 'true' ? true : value === 'false' ? false : value;
    }

    return config;
  } catch {
    return defaults;
  }
}

async function setConfigValue(configFile, key, value) {
  const raw = await readFile(configFile, 'utf8');
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const boolStr = value ? 'true' : 'false';
  let found = false;

  const updated = lines.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:\s*)(.*?)(\s*)$/u);
    if (match && match[2] === key) {
      found = true;
      return `${match[1]}${key}${match[3]}${boolStr}${match[5] ?? ''}`;
    }
    return line;
  });

  if (!found) {
    updated.push(`${key}: ${boolStr}`);
  }

  while (updated.length > 0 && updated[updated.length - 1] === '') {
    updated.pop();
  }

  await writeFile(configFile, `${updated.join(newline)}\n`, 'utf8');
}

async function ensureConfig(configFile) {
  if (await fileExists(configFile)) {
    return;
  }
  await mkdir(path.dirname(configFile), { recursive: true });
  await copyFile(SOURCE_CONFIG, configFile);
  console.log(`Created default config at "${configFile}".`);
}

export function normalizeContent(content) {
  return content.replace(/\r\n/gu, '\n').replace(/\s+$/u, '');
}

// 'ours' | 'foreign'. Normalized compare keeps reinstalls idempotent.
export function classifyContent(current, source) {
  return normalizeContent(current) === normalizeContent(source) ? 'ours' : 'foreign';
}

// 'ours' | 'foreign' | 'absent'. Normalized compare keeps reinstalls idempotent.
// Only a genuinely missing target yields 'absent'; any other read failure
// propagates. An unreadable source always rejects with an actionable message.
export async function classifyTarget(destPath, srcPath) {
  let current;
  try {
    current = await readFile(destPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return 'absent';
    }
    throw err;
  }

  let source;
  try {
    source = await readFile(srcPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Failed to classify ${destPath}: cannot read source ${srcPath}: ${err.message}`,
      { cause: err },
    );
  }

  return classifyContent(current, source);
}

// Copy an existing target aside before overwriting. Millisecond timestamps,
// monotonically bumped so rapid successive calls never collide.
let lastBackupMs = 0;

export async function backupFile(destPath) {
  try {
    await readFile(destPath);
  } catch {
    return null;
  }
  const stamp = Math.max(Date.now(), lastBackupMs + 1);
  lastBackupMs = stamp;
  const backup = `${destPath}.bak-${stamp}`;
  await copyFile(destPath, backup);
  return backup;
}

function getGlobalHooksPath() {
  const result = spawnSync('git', ['config', '--global', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value === '' ? null : value;
}

function setGlobalHooksPath(installDir) {
  const result = spawnSync('git', ['config', '--global', 'core.hooksPath', installDir], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
  return result.status === 0;
}

function unsetGlobalHooksPath() {
  const result = spawnSync('git', ['config', '--global', '--unset', 'core.hooksPath'], {
    stdio: 'inherit',
  });
  // Exit code 5 means the key was not set; nothing to remove.
  if (result.status !== 0 && result.status !== 5) {
    process.exitCode = result.status ?? 1;
  }
  return result.status === 0 || result.status === 5;
}

export function getRepoRoot() {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

// The config file governing this repository, resolved through Git itself so
// linked worktrees (whose origin lives in the main repo's .git/config) are
// handled correctly.
function getGitConfigFile() {
  const result = spawnSync('git', ['rev-parse', '--git-path', 'config'], { encoding: 'utf8' });
  if (result.status !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value === '' ? null : path.resolve(process.cwd(), value);
}

function setLocalHooksPath(value) {
  const result = spawnSync('git', ['config', 'core.hooksPath', value], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
  return result.status === 0;
}

function getEffectiveHooksPath() {
  const result = spawnSync('git', ['config', '--show-origin', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return null;
  }
  const trimmed = result.stdout.trim();
  return trimmed === '' ? null : trimmed;
}

function parseEffectiveHooksPath() {
  const effective = getEffectiveHooksPath();
  if (!effective) {
    return null;
  }
  const tabIdx = effective.indexOf('\t');
  return {
    origin: (tabIdx >= 0 ? effective.slice(0, tabIdx) : effective).trim(),
    value: (tabIdx >= 0 ? effective.slice(tabIdx + 1) : '').trim(),
  };
}

// Auto-detect which install governs this repository. Explicit flags win.
// 'local' when repo-local core.hooksPath points at an existing directory
// containing at least one of HOOK_FILES; otherwise 'global'.
export async function detectScope(explicit) {
  if (explicit === 'local') return 'local';
  if (explicit === 'global') return 'global';

  const parsed = parseEffectiveHooksPath();
  const repoRoot = getRepoRoot();
  const gitConfigFile = getGitConfigFile();
  if (!parsed || !gitConfigFile) {
    return 'global';
  }

  // A repo-local origin reads like "file:<repoRoot>/.git/config" (sometimes
  // printed relative to the repository root).
  const originFile = parsed.origin.startsWith('file:') ? parsed.origin.slice('file:'.length) : null;
  if (!originFile) {
    return 'global';
  }
  const resolvedOrigin = path.isAbsolute(originFile)
    ? originFile
    : path.resolve(repoRoot ?? process.cwd(), originFile);
  if (resolvedOrigin !== gitConfigFile) {
    return 'global';
  }

  const hooksDir = path.isAbsolute(parsed.value)
    ? parsed.value
    : path.resolve(repoRoot, parsed.value);
  for (const file of HOOK_FILES) {
    if (await fileExists(path.join(hooksDir, file))) {
      return 'local';
    }
  }
  return 'global';
}

function localConfigPath() {
  const repoRoot = getRepoRoot();
  return repoRoot ? path.join(repoRoot, '.githooks', 'config.yaml') : null;
}

function reportHooksPathStatus(installDir) {
  const parsed = parseEffectiveHooksPath();
  if (!parsed) {
    console.log(`Hooks enabled: core.hooksPath = "${installDir}".`);
    return;
  }

  if (path.resolve(parsed.value) === installDir) {
    console.log(`Hooks enabled: core.hooksPath = "${installDir}" (${parsed.origin}).`);
  } else {
    console.warn(`Hooks enabled globally, but "${parsed.origin}" overrides core.hooksPath here with "${parsed.value}".`);
    console.warn('gitblock will not run in this repository until that setting is removed.');
  }
}

async function runVerify(scope) {
  if (scope === 'local') {
    console.log('gitblock verification (scope: local)');

    const parsed = parseEffectiveHooksPath();
    console.log(`  hooksPath (here): ${parsed ? `${parsed.value} (${parsed.origin})` : 'not set'}`);

    const cfgPath = localConfigPath();
    const cfgExists = cfgPath !== null && (await fileExists(cfgPath));
    console.log(`  config file:      ${cfgPath ?? '(not inside a Git repository)'} (${cfgExists ? 'exists' : 'MISSING'})`);

    if (!parsed || !cfgExists) {
      console.log('  status: NOT active here.');
      console.log('  Fix: run "node gitblock.mjs --install --local".');
      return;
    }

    const config = await loadConfigFile(cfgPath);
    if (config.enabled === false) {
      console.log('  status: installed but DISABLED (config "enabled" is false).');
      console.log('  Fix: run "node gitblock.mjs config enable".');
      return;
    }

    console.log(`  effective (here): ${parsed.origin} -> ${parsed.value}`);
    console.log('  status: OK - local hooks are applied.');
    return;
  }

  const globalHooks = getGlobalHooksPath();
  const globalConfigPath = path.join(os.homedir(), '.gitconfig');

  console.log('gitblock verification');
  console.log(`  global config:    ${globalConfigPath} (${(await fileExists(globalConfigPath)) ? 'exists' : 'missing'})`);

  if (!globalHooks) {
    console.log('  global hooksPath: not set');
    console.log('  status: hooks are NOT enabled globally.');
    console.log('  Fix: run "node gitblock.mjs --install".');
    return;
  }

  const configTarget = path.join(path.dirname(globalHooks), 'config.yaml');
  const hooksExist = await fileExists(globalHooks);
  const configExists = await fileExists(configTarget);
  const config = configExists ? await loadConfigFile(configTarget) : null;

  console.log(`  global hooksPath: ${globalHooks} (${hooksExist ? 'exists' : 'MISSING'})`);
  console.log(`  config file:      ${configTarget} (${configExists ? 'exists' : 'MISSING'})`);

  if (!hooksExist || !configExists) {
    console.log('  status: global hooksPath does not point to a gitblock install.');
    console.log('  Fix: run "node gitblock.mjs --install".');
    return;
  }

  if (config?.enabled === false) {
    console.log('  status: installed but DISABLED (config "enabled" is false).');
    console.log('  Fix: run "node gitblock.mjs config global enable".');
    return;
  }

  const parsed = parseEffectiveHooksPath();
  if (parsed && path.resolve(parsed.value) === globalHooks) {
    console.log(`  effective (here): ${parsed.origin} -> ${parsed.value}`);
    console.log('  status: OK - global hooks path is applied.');
  } else {
    console.log(`  effective (here): ${parsed ? `${parsed.origin} -> ${parsed.value}` : 'not set'}`);
    console.log(`  status: overridden in this repository (${parsed?.origin}); gitblock is not active here.`);
    console.log('  Other repositories still use the global hooks path unless they override it too.');
  }
}

// The global install's config file, derived from core.hooksPath when set,
// otherwise at the default install base.
async function globalConfigPath() {
  const hooksPath = getGlobalHooksPath();
  if (hooksPath) {
    return path.join(hooksPath, '..', 'config.yaml');
  }
  return path.join(DEFAULT_INSTALL_BASE, 'config.yaml');
}

async function findConfigPath(scope) {
  if (scope === 'local') {
    const local = localConfigPath();
    if (local && (await fileExists(local))) {
      return local;
    }
  }
  return globalConfigPath();
}

function normalizeSetting(setting) {
  if (setting === 'trailers' || setting === 'trailer') {
    return 'trailer';
  }
  if (setting === 'enabled' || setting === 'logging' || setting === 'verbose') {
    return setting;
  }
  return undefined;
}

async function handleConfigCommand(args, scope) {
  // `config global ...` always targets the global install config, never the
  // repository-local YAML — even when auto-detect resolved a local install.
  const targetScope = args[0] === 'global' ? 'global' : scope;

  let configFile;
  if (targetScope === 'local' && args.length > 0) {
    // Local-scope mutations own the local config: ensureConfig creates it
    // rather than silently falling back to the global YAML while the
    // enabled-toggle mutates the LOCAL hooksPath.
    const local = localConfigPath();
    if (!local) {
      console.error('Error: not inside a Git repository; no local config to manage.');
      process.exitCode = 1;
      return;
    }
    configFile = local;
  } else {
    configFile = await findConfigPath(targetScope);
  }

  if (args.length === 0) {
    if (await fileExists(configFile)) {
      const config = await loadConfigFile(configFile);
      for (const key of CONFIG_KEYS) {
        console.log(`${key}: ${config[key] ?? 'true'}`);
      }
    } else {
      console.log(`No configuration found at "${configFile}".`);
    }
    return;
  }

  const [first, ...rest] = args;

  if (first === 'global') {
    const value = parseBool(rest[0] ?? '');
    if (value === undefined) {
      console.error('Usage: gitblock.mjs config global enable|disable');
      process.exitCode = 1;
      return;
    }

    await ensureConfig(configFile);
    await setConfigValue(configFile, 'enabled', value);

    if (value) {
      const installDir = path.join(path.dirname(configFile), 'hooks');
      if (setGlobalHooksPath(installDir)) {
        reportHooksPathStatus(installDir);
      }
    } else if (unsetGlobalHooksPath()) {
      console.log('Global hooks disabled: core.hooksPath removed.');
    } else {
      console.error('Error: failed to remove global core.hooksPath.');
      process.exitCode = 1;
    }
    return;
  }

  let setting;
  let value;

  if (first === 'enable' || first === 'disable') {
    setting = normalizeSetting(rest[0] ?? '');
    value = first === 'enable';
    if (rest[1] !== undefined && parseBool(rest[1]) !== undefined) {
      value = parseBool(rest[1]);
    }
  } else {
    setting = normalizeSetting(first);
    value = parseBool(rest[0] ?? '');
  }

  if (!setting || value === undefined) {
    console.error('Usage: gitblock.mjs config <logging|trailers|verbose|enabled> <true|false|enable|disable>');
    console.error('       gitblock.mjs config enable|disable <logging|trailers|verbose|enabled>');
    console.error('       gitblock.mjs config global enable|disable');
    process.exitCode = 1;
    return;
  }

  await ensureConfig(configFile);
  await setConfigValue(configFile, setting, value);

  if (setting === 'enabled') {
    if (value) {
      if (scope === 'local') {
        if (setLocalHooksPath('.githooks')) {
          console.log('Local hooks enabled: core.hooksPath = ".githooks".');
        } else {
          console.error('Error: failed to set local core.hooksPath.');
          process.exitCode = 1;
        }
      } else {
        const installDir = path.join(path.dirname(configFile), 'hooks');
        if (setGlobalHooksPath(installDir)) {
          reportHooksPathStatus(installDir);
        }
      }
    } else if (scope === 'local') {
      if (unsetLocalHooksPath()) {
        console.log('"enabled" set to false; local core.hooksPath removed.');
      } else {
        console.error('Error: failed to remove local core.hooksPath.');
        process.exitCode = 1;
      }
    } else if (unsetGlobalHooksPath()) {
      console.log('"enabled" set to false; core.hooksPath removed.');
    } else {
      console.error('Error: failed to remove global core.hooksPath.');
      process.exitCode = 1;
    }
  } else {
    console.log(`"${setting}" set to ${value}.`);
  }
}

// The exact content installHookFile would write, so the conflict scan can
// recognize our own previously-baked copies as "ours".
async function renderHookFile(file, customGitDir) {
  const src = path.join(SOURCE_HOOKS_DIR, file);
  const template = await readFile(src, 'utf8');
  if (!(customGitDir && file === 'validate-commit.mjs')) {
    return template;
  }
  const logFile = path.join(customGitDir, 'logs');
  return template.replace(
    /const GITBLOCK_LOG_FILE = .+;\n/u,
    `const GITBLOCK_LOG_FILE = ${JSON.stringify(logFile)};\n`,
  );
}

async function installHookFile(file, installDir, customGitDir) {
  const src = path.join(SOURCE_HOOKS_DIR, file);
  const dest = path.join(installDir, file);

  // Bake the custom path into the generated hook instead of "$HOME/.git".
  if (customGitDir && file === 'validate-commit.mjs') {
    await writeFile(dest, await renderHookFile(file, customGitDir), 'utf8');
  } else {
    await copyFile(src, dest);
  }
}

// Classify first: a foreign conflict aborts before any prompt or write.
// Shared by the global and local installers; local installs pass no
// customGitDir, so plain rendered-source comparison applies.
async function findConflicts(installDir, customGitDir) {
  const conflicts = [];
  for (const file of HOOK_FILES) {
    let current;
    try {
      current = await readFile(path.join(installDir, file), 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      continue;
    }
    let rendered;
    try {
      rendered = await renderHookFile(file, customGitDir);
    } catch (err) {
      throw new Error(
        `Failed to classify ${path.join(installDir, file)}: cannot read hook source: ${err.message}`,
        { cause: err },
      );
    }
    if (classifyContent(current, rendered) === 'foreign') {
      conflicts.push(file);
    }
  }
  return conflicts;
}

async function runInstall(requestedDir, { yolo, force = false }) {
  if (findMissingSources().length > 0) {
    reportMissingSources();
    return;
  }

  const installDir = path.resolve(requestedDir ?? DEFAULT_INSTALL_DIR);
  const customGitDir = requestedDir ? path.dirname(installDir) : undefined;
  const configTarget = path.join(path.dirname(installDir), 'config.yaml');

  const conflicts = await findConflicts(installDir, customGitDir);

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

  const binDir = path.join(path.dirname(installDir), 'bin');
  const binTarget = path.join(binDir, 'gitblock.mjs');
  await mkdir(binDir, { recursive: true });
  await copyFile(SCRIPT_PATH, binTarget);
  await chmod(binTarget, 0o755);

  const binLink = path.join(os.homedir(), '.local', 'bin', 'gitblock');
  await mkdir(path.dirname(binLink), { recursive: true });
  try {
    await symlink(binTarget, binLink, 'file');
    console.log(`Linked "gitblock" into PATH as "${binLink}".`);
  } catch (err) {
    if (err.code !== 'EEXIST') {
      console.warn(`Could not link "gitblock" into PATH: ${err.message}`);
    } else {
      let pointsAt = null;
      try {
        pointsAt = realpathSync(binLink);
      } catch {
        // Broken symlink; leave it for the user to inspect.
      }
      if (pointsAt !== binTarget) {
        console.warn(`"${binLink}" already exists but does not point to "${binTarget}".`);
      }
    }
  }

  if (await fileExists(configTarget)) {
    console.log(`Config already present, keeping "${configTarget}".`);
  } else {
    await copyFile(SOURCE_CONFIG, configTarget);
  }

  for (const file of HOOK_FILES) {
    await chmod(path.join(installDir, file), 0o755);
  }

  const config = await loadConfigFile(configTarget);
  if (config.enabled === false) {
    unsetGlobalHooksPath();
    console.log(`Hooks installed to "${installDir}" but left disabled: config "enabled" is false.`);
  } else if (setGlobalHooksPath(installDir)) {
    reportHooksPathStatus(installDir);
  }

  console.log(`CLI copied to "${binTarget}"`);
  console.log(`Config file at "${configTarget}"`);
}

async function runLocalInstall({ yolo, force = false }) {
  if (findMissingSources().length > 0) {
    reportMissingSources();
    return;
  }

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

function unsetLocalHooksPath() {
  const result = spawnSync('git', ['config', '--unset', 'core.hooksPath'], { encoding: 'utf8' });
  // Exit code 5 means the key was not set; fine.
  const ok = result.status === 0 || result.status === 5;
  if (!ok && result.stderr) {
    console.error(result.stderr.trim());
  }
  return ok;
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
    const hooksCleared = unsetLocalHooksPath();
    if (!hooksCleared) {
      console.error('Error: failed to remove local core.hooksPath.');
      process.exitCode = 1;
    }

    const githooksDir = path.join(repoRoot, '.githooks');
    let leftovers = [];
    let entries = null;
    try {
      entries = await readdir(githooksDir);
    } catch {
      // .githooks missing entirely; nothing to clean.
    }

    if (entries !== null) {
      let foreignLeft = false;
      for (const entry of entries) {
        const full = path.join(githooksDir, entry);
        if (entry === 'config.yaml') continue;
        const src = SOURCE_HOOKS_DIR && HOOK_FILES.includes(entry)
          ? path.join(SOURCE_HOOKS_DIR, entry)
          : null;
        if (src && (await classifyTarget(full, src)) === 'ours') {
          await rm(full);
        } else {
          leftovers.push(entry);
          foreignLeft = true;
        }
      }

      // When gitblock owns everything else, an untouched default config goes
      // too so the directory can be removed. Any foreign file (or a
      // user-modified config) keeps the whole directory, config included.
      const configFile = path.join(githooksDir, 'config.yaml');
      if (entries.includes('config.yaml')) {
        if (!foreignLeft && (await classifyTarget(configFile, SOURCE_CONFIG)) === 'ours') {
          await rm(configFile);
        } else {
          leftovers.unshift('config.yaml');
        }
      }

      if (leftovers.length > 0) {
        console.log(`Kept non-gitblock files in .githooks: ${leftovers.join(', ')}`);
      }
      // Remove the dir itself only when empty.
      try {
        await rmdir(githooksDir);
        console.log('Removed empty .githooks directory.');
      } catch {
        // Not empty or gone; leave as reported above.
      }
    }
    if (hooksCleared) {
      console.log('Local hooks removed: core.hooksPath cleared.');
    }
    return;
  }

  if (unsetGlobalHooksPath()) {
    console.log('Global hooks disabled: core.hooksPath removed.');
  }
}

// POSIX awk port of stripTrailers, used as the --wipe msg-filter so history
// rewriting needs no Node runtime. Must stay behaviorally identical to
// stripTrailers; tests/wipe-filter.test.mjs asserts output parity.
// Classification uses a \r-normalized copy of each line so CRLF messages are
// handled like stripTrailers, while the original lines are printed unchanged.
// Known divergence: input lacking a final newline gets one added by awk's
// print (stripTrailers would return it as-is). Not portable to fix in POSIX
// awk; git msg-filter input always ends with a newline.
export const AWK_STRIP_TRAILERS = `function norm(s) { sub(/\\r$/, "", s); return s }
{
  lines[NR] = $0
}
END {
    n = NR
    while (n > 0 && norm(lines[n]) ~ /^[ \\t]*$/) n--
    if (n == 0) { for (i = 1; i <= NR; i++) print lines[i]; exit }
    cur = n; cnt = 0
    while (cur > 0) {
      while (cur > 0 && norm(lines[cur]) ~ /^[ \\t]/) cur--
      if (cur == 0) break
      if (norm(lines[cur]) !~ /^[^ \\t:]+[ \\t]*:/) break
      cnt++; cur--
    }
    if (cnt == 0 || cur == 0) { for (i = 1; i <= NR; i++) print lines[i]; exit }
    if (norm(lines[cur]) !~ /^[ \\t]*$/) { for (i = 1; i <= NR; i++) print lines[i]; exit }
    end = cur - 1
    while (end > 0 && norm(lines[end]) ~ /^[ \\t]*$/) end--
    for (i = 1; i <= end; i++) print lines[i]
}`;

/**
 * Removes the final Git trailer block from a commit message. Returns the
 * message unchanged when no trailer block is present.
 */
export function stripTrailers(message) {
  if (!message) {
    return message;
  }

  const newline = message.includes('\r\n') ? '\r\n' : '\n';
  const hasFinalNewline = message.endsWith('\n');
  const lines = message.split(/\r?\n/);

  if (hasFinalNewline) {
    lines.pop();
  }

  let contentEnd = lines.length;

  // Ignore trailing blank lines while locating the trailer block.
  while (contentEnd > 0 && lines[contentEnd - 1].trim() === '') {
    contentEnd -= 1;
  }

  let cursor = contentEnd;
  let trailerCount = 0;

  while (cursor > 0) {
    // Include folded continuation lines belonging to a trailer value.
    while (cursor > 0 && /^[ \t]/u.test(lines[cursor - 1])) {
      cursor -= 1;
    }

    if (cursor === 0) {
      break;
    }

    const line = lines[cursor - 1];

    // Git trailer keys cannot contain whitespace or the ":" separator.
    if (!/^[^\s:]+[ \t]*:[ \t]*.*$/u.test(line)) {
      break;
    }

    trailerCount += 1;
    cursor -= 1;
  }

  if (trailerCount === 0) {
    return message;
  }

  // The first line is always the subject, never a trailer. A trailer block
  // reaching back to the start means the subject was misread — keep it.
  if (cursor === 0) {
    return message;
  }

  // A valid trailer block must be separated from the body by a blank line.
  if (cursor > 0 && lines[cursor - 1].trim() !== '') {
    return message;
  }

  const cleaned = lines.slice(0, cursor);

  // Remove the blank separator left behind by the trailer block.
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') {
    cleaned.pop();
  }

  return cleaned.join(newline) + (hasFinalNewline && cleaned.length > 0 ? newline : '');
}

async function runWipe({ yolo }) {
  const name = gitConfig('user.name');
  const email = gitConfig('user.email');

  if (!name || !email) {
    console.error(
      'Error: user.name and user.email must be set in git config before wiping;',
      'they are used as the identity for every rewritten commit.',
    );
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const ok = await askConfirm(
    `\nThis will wipe all trailers from the commit history in "${cwd}" and reset every commit's authorship to "${name} <${email}>".\n
     This action is destructive for contributors, do you want to proceed? [y/N]: `,
    { yolo, defaultYes: false },
  );
  if (!ok) {
    console.log('Wipe cancelled.');
    return;
  }

  const check = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (check.status !== 0) {
    console.error('Error: not inside a Git repository.');
    process.exitCode = 1;
    return;
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gitblock-'));
  const filterFile = path.join(tmpDir, 'strip-trailers.awk');
  await writeFile(filterFile, AWK_STRIP_TRAILERS, 'utf8');

  // The env-filter forces every rewritten commit to carry only the pushing
  // persona's identity; git config resolves repo-local values over global ones.
  const envFilter =
    'export ' +
    [
      `GIT_AUTHOR_NAME=${shellQuote(name)}`,
      `GIT_AUTHOR_EMAIL=${shellQuote(email)}`,
      `GIT_COMMITTER_NAME=${shellQuote(name)}`,
      `GIT_COMMITTER_EMAIL=${shellQuote(email)}`,
    ].join(' ');

  const result = spawnSync(
    'git',
    [
      'filter-branch',
      '--force',
      '--msg-filter',
      `awk -f ${JSON.stringify(filterFile)}`,
      '--env-filter',
      envFilter,
      '--',
      '--all',
    ],
    { stdio: 'inherit', env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: '1' } },
  );

  await rm(tmpDir, { recursive: true, force: true });

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }

  console.log(
    'Done. All trailers have been wiped and every commit is now authored by ' +
      `"${name} <${email}>".`,
  );
}

// Read a value from git config, repo-local first, then global.
function gitConfig(key) {
  const result = spawnSync('git', ['config', '--get', key], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

// Quote a value for safe use inside the env-filter shell snippet.
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

// --- Self-update: channel detection, semver compare, registry lookup ---

// Which install channel governs this copy: 'binary' (compiled executable),
// 'npm' (global package), 'manual' (opt-layout install), or 'source'
// (development checkout).
export function detectChannel(argv1, execPath, installBase) {
  if (!argv1 || argv1 === execPath) return 'binary';
  const p = path.resolve(argv1);
  if (p.split(path.sep).includes('node_modules')) return 'npm';
  if (installBase && (p === installBase || p.startsWith(installBase + path.sep))) return 'manual';
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
// Primary source is the npm registry; the GitHub Releases API is the
// fallback (tag_name with a leading "v" stripped).
export async function fetchLatestVersion(fetchImpl = fetch) {
  try {
    const res = await fetchImpl('https://registry.npmjs.org/gitblock/latest', {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.version === 'string') return data.version;
    }
  } catch {
    // Fall through to the GitHub Releases fallback.
  }
  try {
    const res = await fetchImpl('https://api.github.com/repos/yonasuriv/gitblock/releases/latest', {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.tag_name !== 'string') return null;
    return data.tag_name.replace(/^v/, '');
  } catch {
    return null;
  }
}

// Release asset name for a version/platform/arch, matching the release
// pipeline: gitblock-v<VERSION>-<os>-<arch>[.exe] (win32 -> "win" + ".exe").
export function assetName(version, platform, arch) {
  const osName = platform === 'win32' ? 'win' : platform;
  const ext = platform === 'win32' ? '.exe' : '';
  return `gitblock-v${version}-${osName}-${arch}${ext}`;
}

// Swap the running binary for a freshly downloaded one. POSIX allows renaming
// over the executing file (atomic); Windows does not, so move the old binary
// aside first (cleaned up on next startup).
export function swapBinary(execPath, newFile, platform) {
  if (platform === 'win32') {
    const backup = `${execPath}.old`;
    renameSync(execPath, backup);
    try {
      renameSync(newFile, execPath);
    } catch (err) {
      // The running executable is gone; restore it before giving up so the
      // install never ends up without a working binary.
      renameSync(backup, execPath);
      throw err;
    }
  } else {
    renameSync(newFile, execPath);
  }
}

async function runCheckUpdate() {
  const latest = await fetchLatestVersion();
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

async function runUpdate() {
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

  const latest = await fetchLatestVersion();
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

  // Binary channel: download, verify it executes, then atomically swap.
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
  const versionLine = probe.stdout?.trim() ?? '';
  if (probe.status !== 0 || !/^gitblock \d+\.\d+\.\d+$/.test(versionLine)) {
    await rm(tmpBin, { force: true });
    console.error('Error: downloaded binary failed to execute; aborting update.');
    process.exitCode = 1;
    return;
  }
  swapBinary(process.execPath, tmpBin, process.platform);
  console.log(`Updated gitblock to ${latest}.`);
}

async function main() {
  // Best-effort cleanup of the previous binary moved aside by a Windows
  // self-update (renameSync cannot replace a running executable there).
  // Only safe once the current binary is back in place; otherwise the .old
  // file may be the last good copy (see swapBinary's rollback).
  if (process.platform === 'win32' && existsSync(process.execPath)) {
    rm(`${process.execPath}.old`, { force: true }).catch(() => {});
  }

  const opts = parseArgs(process.argv.slice(2));

  if (opts.help
    || (!opts.install && !opts.wipe && !opts.verify && !opts.configCommand
      && !opts.uninstall && !opts.versionFlag && !opts.checkUpdate && !opts.update)) {
    printUsage();
    // Bare `gitblock` (no argv at all) is a help request; unrecognized flags
    // reaching the usage path are usage errors and must exit 1.
    if (!opts.help) {
      for (const flag of opts.unknown) {
        console.error(`Error: unrecognized option "${flag}".`);
      }
      if (opts.unknown.length > 0) process.exitCode = 1;
    }
    return;
  }

  if (opts.versionFlag) {
    console.log(`gitblock ${VERSION}`);
    return;
  }

  if (opts.checkUpdate) { await runCheckUpdate(); return; }
  if (opts.update)     { await runUpdate(); return; }

  const scope = await detectScope(opts.local ? 'local' : opts.global ? 'global' : undefined);

  if (opts.verify) {
    await runVerify(scope);
    return;
  }

  if (opts.configCommand) {
    await handleConfigCommand(opts.config, scope);
    return;
  }

  if (opts.uninstall) {
    const scope = opts.local && !opts.global ? 'local' : 'global';
    await runUninstall({ scope, yolo: opts.yolo });
    return;
  }

  if (opts.install) {
    if (opts.local && !opts.global) {
      await runLocalInstall({ yolo: opts.yolo, force: opts.force });
    } else {
      await runInstall(opts.installDir, { yolo: opts.yolo, force: opts.force });
    }
  }

  if (opts.wipe) {
    await runWipe({ yolo: opts.yolo });
  }
}

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
