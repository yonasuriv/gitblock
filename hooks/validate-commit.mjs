#!/usr/bin/env node

/**
 * Cleans up the final Git trailer block from a commit message.
 * Behavior is controlled by the sibling `config.yaml` file:
 *   - `enabled` when false the hook does nothing and exits successfully
 *   - `logging` enables the log file entry
 *   - `trailer` keeps the trailer block when true, strips it when false
 *   - `verbose` prints errors to the terminal, otherwise everything is silent
 * The hook exits successfully so the commit continues normally.
 */

import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';

// Log destination. githooker rewrites this line at install time when a
// custom --path is supplied. Default: "$HOME/.git/logs".
const GITHOOKER_LOG_FILE = path.join(os.homedir(), '.git', 'logs');

const messagePath = process.argv[2];
const config = await loadConfig();

if (!config.enabled) {
  process.exitCode = 0;
} else if (!messagePath) {
  if (config.verbose) {
    console.error('Trailer cleanup failed: missing commit-message path.');
  }
  process.exitCode = 2;
} else {
  await removeTrailers(messagePath, config);
}

async function removeTrailers(filePath, config) {
  const source = await readFile(filePath, 'utf8');

  if (!source) {
    return;
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hasFinalNewline = source.endsWith('\n');

  const lines = source.split(/\r?\n/);

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
    return;
  }

  // The first line of a commit message is always the subject, never a
  // trailer. If the trailer block reaches all the way back to the start of
  // the message, the subject itself is being misread as a trailer (e.g. a
  // conventional-commit subject like "chore: update") — keep it.
  if (cursor === 0) {
    return;
  }

  // A valid trailer block must be separated from the body by a blank line.
  if (lines[cursor - 1].trim() !== '') {
    return;
  }

  const trailerBlock = lines.slice(cursor, contentEnd);

  // Keep the trailer block when trailers are enabled, otherwise strip it.
  if (!config.trailer) {
    const cleaned = lines.slice(0, cursor);

    // Remove the blank separator left behind by the trailer block.
    while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') {
      cleaned.pop();
    }

    const output =
      cleaned.join(newline) +
      (hasFinalNewline && cleaned.length > 0 ? newline : '');

    await writeFile(filePath, output, 'utf8');
  }

  if (config.logging) {
    const verb = config.trailer ? 'made' : 'removed';
    const trailerMessage = trailerBlock.join(', ').trim();
    const entry =
      `${trailerCount} commit trailer${trailerCount === 1 ? '' : 's'}. ` +
      `${verb} on ${filePath}: ${trailerMessage}`;

    await appendLog(entry, config.verbose);
  }
}

// The config file lives one level above the hooks directory:
// "$HOME/.git/config.yaml" when installed via githooker.mjs.
function configPath() {
  const hookDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(hookDir, '..', 'config.yaml');
}

async function loadConfig() {
  const defaults = { enabled: true, logging: false, trailer: false, verbose: false };

  try {
    const raw = await readFile(configPath(), 'utf8');
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

// Echo one entry per line into the configured log file.
async function appendLog(entry, verbose) {
  const logFile = GITHOOKER_LOG_FILE;

  try {
    await mkdir(path.dirname(logFile), { recursive: true });
    await appendFile(logFile, `${entry}\n`, 'utf8');
  } catch {
    if (verbose) {
      console.error(`Trailer logging failed: unable to write "${logFile}".`);
    }
  }
}
