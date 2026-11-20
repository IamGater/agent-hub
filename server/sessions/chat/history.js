// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A past conversation the owner can resume. `tokens`: how big its context was at the end, when the
 * agent's files tell (what resuming it sends again).
 * @typedef {{ id: string, title: string, updatedAt: number, tokens?: number }} SessionInfo
 */

export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const LIST_MAX = 30;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 512 * 1024;
const HISTORY_MAX_BYTES = 32 * 1024 * 1024;

/** @param {Record<string, string>} env */
export function claudeConfigDir(env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Claude Code keeps each folder's sessions under projects/<path with every other character as "-">. */
function projectDir(configDir, cwd) {
  return path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

/** @param {any} content */
function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('\n');
}

/** @param {any} line */
function isOwnerMessage(line) {
  if (line?.type !== 'user' || line.isMeta || line.isSidechain) return false;
  const text = userText(line.message?.content);
  // Slash command bookkeeping and injected reminders are not something the owner typed.
  return Boolean(text) && !text.startsWith('<') && !text.startsWith('Caveat:');
}

/** @param {string} file @param {number} max */
function readLines(file, max) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = Math.min(fs.fstatSync(fd).size, max);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    const lines = buf.toString('utf8').split('\n');
    if (size === max) lines.pop();
    return lines.flatMap((l) => {
      try {
        return l ? [JSON.parse(l)] : [];
      } catch {
        return [];
      }
    });
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The context size at the end of a session: the usage of its last answer covers everything that was
 * sent with it, plus what it wrote. Read from the end of the file only.
 * @param {string} file @returns {number | null}
 */
export function claudeContextTokens(file) {
  let text;
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    let l;
    try {
      l = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const u = l?.type === 'assistant' && !l.isSidechain ? l.message?.usage : null;
    if (!u || l.message?.model === '<synthetic>') continue;
    const n = (/** @type {unknown} */ v) => (typeof v === 'number' && v > 0 ? v : 0);
    const total =
      n(u.input_tokens) +
      n(u.cache_creation_input_tokens) +
      n(u.cache_read_input_tokens) +
      n(u.output_tokens);
    if (total > 0) return total;
  }
  return null;
}

/**
 * Claude Code has no listing request in its stream protocol, so its own session files are read.
 * @param {string} configDir @param {string} cwd
 * @returns {SessionInfo[]}
 */
export function claudeSessions(configDir, cwd) {
  const dir = projectDir(configDir, cwd);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && SESSION_ID.test(n.slice(0, -6)));
  } catch {
    return [];
  }
  return names
    .map((n) => ({ n, mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, LIST_MAX)
    .flatMap(({ n, mtime }) => {
      const file = path.join(dir, n);
      const first = readLines(file, HEAD_BYTES).find(isOwnerMessage);
      if (!first) return [];
      const tokens = claudeContextTokens(file);
      return [
        {
          id: n.slice(0, -6),
          title: userText(first.message.content).slice(0, 120),
          updatedAt: mtime,
          ...(tokens ? { tokens } : {}),
        },
      ];
    });
}

/**
 * The messages of a past Claude session, in the stream-json shape the driver already understands.
 * @param {string} configDir @param {string} cwd @param {string} id
 * @returns {any[]}
 */
export function claudeHistory(configDir, cwd, id) {
  if (!SESSION_ID.test(id)) return [];
  const file = path.join(projectDir(configDir, cwd), `${id}.jsonl`);
  try {
    return readLines(file, HISTORY_MAX_BYTES).filter(
      (l) => (l.type === 'assistant' || l.type === 'user') && !l.isSidechain && !l.isMeta,
    );
  } catch {
    return [];
  }
}
