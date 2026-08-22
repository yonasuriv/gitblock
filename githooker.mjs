#!/usr/bin/env node

/**
 * githooker — installer and manager for the Git commit hooks.
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
 *   node githooker.mjs --install [path]      Install hooks (sets core.hooksPath)
 *   node githooker.mjs --install=<path>      Same, directory inline
 *   node githooker.mjs --verify              Check whether the global hooks path is applied
 *   node githooker.mjs --wipe                Strip trailers and reset commit authorship in history
 *   node githooker.mjs --yolo                Non-interactive: auto-accept prompts
 *   node githooker.mjs config <what> <value> Manage the installed configuration
 *
 * Config management:
 *   node githooker.mjs config <logging|trailers|verbose|enabled> <true|false|enable|disable>
 *   node githooker.mjs config enable|disable <logging|trailers|verbose|enabled>
 *   node githooker.mjs config global enable|disable
 */

import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const SOURCE_HOOKS_DIR = path.join(SCRIPT_DIR, 'hooks');
const SOURCE_CONFIG = path.join(SCRIPT_DIR, 'config', 'default.yaml');
const DEFAULT_INSTALL_BASE = path.join(os.homedir(), '.local', 'opt', 'githooker');
const DEFAULT_INSTALL_DIR = path.join(DEFAULT_INSTALL_BASE, 'hooks');
const HOOK_FILES = ['validate-commit.mjs', 'prepare-commit-msg', 'commit-msg'];
const CONFIG_KEYS = ['enabled', 'logging', 'trailer', 'verbose'];

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

function parseArgs(argv) {
  const opts = {
    install: false,
    installDir: undefined,
    wipe: false,
    verify: false,
    yolo: false,
    help: false,
    config: [],
    configCommand: false,
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
    } else if (arg === 'config') {
      opts.configCommand = true;
      opts.config = argv.slice(i + 1);
      break;
    } else if (!arg.startsWith('-')) {
      opts.installDir = arg;
    }
  }

  return opts;
}

function printUsage() {
  console.log(`githooker — Git commit-hook installer and manager

Usage:
  node githooker.mjs --install [path]      Install hooks into "path" (default: ${DEFAULT_INSTALL_DIR}) and set core.hooksPath
  node githooker.mjs --install=<path>      Same, directory inline
  node githooker.mjs --verify              Check whether the global hooks path is applied
  node githooker.mjs --wipe                Wipe trailers and reset commit authorship in history (destructive)
  node githooker.mjs --yolo                Non-interactive mode: auto-accept every prompt
  node githooker.mjs config <what> <value> Manage the installed configuration

Config management:
  node githooker.mjs config <logging|trailers|verbose|enabled> <true|false|enable|disable>
  node githooker.mjs config enable|disable <logging|trailers|verbose|enabled>
  node githooker.mjs config global enable|disable

Flags:
  --install [path]   Install the hooks. All install behavior only runs with this flag.
  --install=<path>   Same, with the target directory inline.
  --verify           Report whether the global core.hooksPath is set and applied here.
  --wipe             Rewrite the whole commit history: strip every Git trailer and
                     reset each commit's author/committer to your git identity.
  --yolo             Accept install and wipe confirmations automatically (no prompts).
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
    console.warn('githooker will not run in this repository until that setting is removed.');
  }
}

async function runVerify() {
  const globalHooks = getGlobalHooksPath();
  const globalConfigPath = path.join(os.homedir(), '.gitconfig');

  console.log('githooker verification');
  console.log(`  global config:    ${globalConfigPath} (${(await fileExists(globalConfigPath)) ? 'exists' : 'missing'})`);

  if (!globalHooks) {
    console.log('  global hooksPath: not set');
    console.log('  status: hooks are NOT enabled globally.');
    console.log('  Fix: run "node githooker.mjs --install".');
    return;
  }

  const configTarget = path.join(path.dirname(globalHooks), 'config.yaml');
  const hooksExist = await fileExists(globalHooks);
  const configExists = await fileExists(configTarget);
  const config = configExists ? await loadConfigFile(configTarget) : null;

  console.log(`  global hooksPath: ${globalHooks} (${hooksExist ? 'exists' : 'MISSING'})`);
  console.log(`  config file:      ${configTarget} (${configExists ? 'exists' : 'MISSING'})`);

  if (!hooksExist || !configExists) {
    console.log('  status: global hooksPath does not point to a githooker install.');
    console.log('  Fix: run "node githooker.mjs --install".');
    return;
  }

  if (config?.enabled === false) {
    console.log('  status: installed but DISABLED (config "enabled" is false).');
    console.log('  Fix: run "node githooker.mjs config global enable".');
    return;
  }

  const parsed = parseEffectiveHooksPath();
  if (parsed && path.resolve(parsed.value) === globalHooks) {
    console.log(`  effective (here): ${parsed.origin} -> ${parsed.value}`);
    console.log('  status: OK - global hooks path is applied.');
  } else {
    console.log(`  effective (here): ${parsed ? `${parsed.origin} -> ${parsed.value}` : 'not set'}`);
    console.log(`  status: overridden in this repository (${parsed?.origin}); githooker is not active here.`);
    console.log('  Other repositories still use the global hooks path unless they override it too.');
  }
}

async function findConfigPath() {
  const hooksPath = getGlobalHooksPath();
  if (hooksPath) {
    return path.join(hooksPath, '..', 'config.yaml');
  }
  return path.join(DEFAULT_INSTALL_BASE, 'config.yaml');
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

async function handleConfigCommand(args) {
  const configFile = await findConfigPath();

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
      console.error('Usage: githooker.mjs config global enable|disable');
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
    } else {
      unsetGlobalHooksPath();
      console.log('Global hooks disabled: core.hooksPath removed.');
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
    console.error('Usage: githooker.mjs config <logging|trailers|verbose|enabled> <true|false|enable|disable>');
    console.error('       githooker.mjs config enable|disable <logging|trailers|verbose|enabled>');
    console.error('       githooker.mjs config global enable|disable');
    process.exitCode = 1;
    return;
  }

  await ensureConfig(configFile);
  await setConfigValue(configFile, setting, value);

  if (setting === 'enabled') {
    if (value) {
      const installDir = path.join(path.dirname(configFile), 'hooks');
      if (setGlobalHooksPath(installDir)) {
        reportHooksPathStatus(installDir);
      }
    } else {
      unsetGlobalHooksPath();
      console.log('"enabled" set to false; core.hooksPath removed.');
    }
  } else {
    console.log(`"${setting}" set to ${value}.`);
  }
}

async function installHookFile(file, installDir, customGitDir) {
  const src = path.join(SOURCE_HOOKS_DIR, file);
  const dest = path.join(installDir, file);

  // Bake the custom path into the generated hook instead of "$HOME/.git".
  if (customGitDir && file === 'validate-commit.mjs') {
    const template = await readFile(src, 'utf8');
    const logFile = path.join(customGitDir, 'logs');
    const generated = template.replace(
      /const GITHOOKER_LOG_FILE = .+;\n/u,
      `const GITHOOKER_LOG_FILE = ${JSON.stringify(logFile)};\n`,
    );
    await writeFile(dest, generated, 'utf8');
  } else {
    await copyFile(src, dest);
  }
}

async function runInstall(requestedDir, { yolo }) {
  const installDir = path.resolve(requestedDir ?? DEFAULT_INSTALL_DIR);
  const customGitDir = requestedDir ? path.dirname(installDir) : undefined;
  const configTarget = path.join(path.dirname(installDir), 'config.yaml');

  const ok = await askConfirm(`Install Git hooks into "${installDir}"? [Y/n] `, {
    yolo,
    defaultYes: true,
  });
  if (!ok) {
    console.log('Installation cancelled.');
    return;
  }

  await mkdir(installDir, { recursive: true });

  for (const entry of await readdir(SOURCE_HOOKS_DIR)) {
    await installHookFile(entry, installDir, customGitDir);
  }

  const binDir = path.join(path.dirname(installDir), 'bin');
  const binTarget = path.join(binDir, 'githooker.mjs');
  await mkdir(binDir, { recursive: true });
  await copyFile(SCRIPT_PATH, binTarget);
  await chmod(binTarget, 0o755);

  const binLink = path.join(os.homedir(), '.local', 'bin', 'githooker');
  await mkdir(path.dirname(binLink), { recursive: true });
  try {
    await symlink(binTarget, binLink, 'file');
    console.log(`Linked "githooker" into PATH as "${binLink}".`);
  } catch (err) {
    if (err.code !== 'EEXIST') {
      console.warn(`Could not link "githooker" into PATH: ${err.message}`);
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
    `This will wipe all trailers from the commit history in "${cwd}" and reset every commit's authorship to "${name} <${email}>", this action is destructive for contributors, do you want to proceed? [y/N]: `,
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

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'githooker-'));
  const filterFile = path.join(tmpDir, 'strip-trailers.mjs');
  const filterSource =
    `import { stripTrailers } from ${JSON.stringify(SCRIPT_PATH)};\n` +
    `let input = '';\n` +
    `for await (const chunk of process.stdin) input += chunk;\n` +
    `process.stdout.write(stripTrailers(input));\n`;
  await writeFile(filterFile, filterSource, 'utf8');

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
      `node ${JSON.stringify(filterFile)}`,
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || (!opts.install && !opts.wipe && !opts.verify && !opts.configCommand)) {
    printUsage();
    return;
  }

  if (opts.verify) {
    await runVerify();
    return;
  }

  if (opts.configCommand) {
    await handleConfigCommand(opts.config);
    return;
  }

  if (opts.install) {
    await runInstall(opts.installDir, { yolo: opts.yolo });
  }

  if (opts.wipe) {
    await runWipe({ yolo: opts.yolo });
  }
}

// Only run as a CLI entry point. Importing this module (e.g. from the wipe
// filter script) must not trigger main(). Compare resolved paths so the
// installed "githooker" symlink also counts as the entry point.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SCRIPT_PATH)) {
  await main();
}
