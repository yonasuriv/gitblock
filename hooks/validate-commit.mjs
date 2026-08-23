#!/usr/bin/env node

/**
 * Cleans up the final Git trailer block and AI-agent attribution lines from
 * a commit message. Behavior is controlled by the sibling `config.yaml`:
 *   - `enabled` when false the hook does nothing and exits successfully
 *   - `logging` enables the log file entry
 *   - `trailer` keeps the trailer block when true, strips it when false
 *     (attribution lines are always stripped, in both modes)
 *   - `verbose` prints errors to the terminal, otherwise everything is silent
 * The hook exits successfully so the commit continues normally.
 */

import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';

// Log destination. gitblock rewrites this line at install time when a
// custom --path is supplied. Default: "$HOME/.git/logs".
const GITBLOCK_LOG_FILE = path.join(os.homedir(), '.git', 'logs');

// Lines that identify AI-agent attribution. Removed wherever they appear,
// regardless of trailer-block positioning rules.
const ATTRIBUTION_LINE_PATTERNS = [
  /^\s*co-authored-by\s*:/iu,
  /^\s*(?:[\p{Extended_Pictographic}]\u{FE0F}?\s*)?generated\s+with\s+\S/iu,
  /^\s*claude[a-z-]*\s*:/iu,
  /^\s*https?:\/\/\S*(?:claude\.ai|anthropic\.com|claude\.com)\S*\s*$/iu,
];

function isAttributionLine(line) {
  return ATTRIBUTION_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

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
  const originalLineCount = source.split(/\r?\n/).length;

  // Attribution lines go first so their removal can expose a trailer block
  // that the positioning rules below will then also strip.
  const lines = source.split(/\r?\n/).filter((line) => !isAttributionLine(line));
  const attributionCount = originalLineCount - lines.length;
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  if (lines.length === 0) {
    await writeFile(filePath, '', 'utf8');
    return;
  }

  let contentEnd = lines.length;

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

  // The first line of a commit message is always the subject, never a
  // trailer. If the trailer block reaches all the way back to the start of
  // the message, the subject itself is being misread as a trailer (e.g. a
  // conventional-commit subject like "chore: update") — keep it.
  const subjectGuard = cursor === 0;

  // A valid trailer block must be separated from the body by a blank line.
  const separated = cursor > 0 && lines[cursor - 1].trim() === '';

  const stripBlock = !config.trailer && !subjectGuard && separated && trailerCount > 0;

  let output;
  if (stripBlock) {
    const cleaned = lines.slice(0, cursor);

    // Remove the blank separator left behind by the trailer block.
    while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') {
      cleaned.pop();
    }

    output =
      cleaned.join(newline) +
      (hasFinalNewline && cleaned.length > 0 ? newline : '');
  } else {
    output = lines.join(newline) + (hasFinalNewline && lines.length > 0 ? newline : '');
  }

  if (output !== source) {
    await writeFile(filePath, output, 'utf8');
  }

  if (config.logging && (attributionCount > 0 || (stripBlock && trailerCount > 0))) {
    const parts = [];
    if (attributionCount > 0) {
      parts.push(
        `${attributionCount} attribution line${attributionCount === 1 ? '' : 's'}`,
      );
    }
    if (stripBlock && trailerCount > 0) {
      parts.push(`${trailerCount} commit trailer${trailerCount === 1 ? '' : 's'}`);
    }
    const entry = `Removed ${parts.join(' and ')} on ${filePath}.`;
    await appendLog(entry, config.verbose);
  }
}

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

async function loadConfig() {
  const defaults = { enabled: true, logging: false, trailer: false, verbose: false };

  for (const candidate of configPaths()) {
    try {
      const raw = await readFile(candidate, 'utf8');
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
      continue;
    }
  }

  return defaults;
}

// Echo one entry per line into the configured log file.
async function appendLog(entry, verbose) {
  const logFile = GITBLOCK_LOG_FILE;

  try {
    await mkdir(path.dirname(logFile), { recursive: true });
    await appendFile(logFile, `${entry}\n`, 'utf8');
  } catch {
    if (verbose) {
      console.error(`Trailer logging failed: unable to write "${logFile}".`);
    }
  }
}
