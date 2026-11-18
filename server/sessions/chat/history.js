// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A past conversation the owner can resume.
 * @typedef {{ id: string, title: string, updatedAt: number }} SessionInfo
 */

export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const LIST_MAX = 30;
const HEAD_BYTES = 256 * 1024;
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
      const first = readLines(path.join(dir, n), HEAD_BYTES).find(isOwnerMessage);
      if (!first) return [];
      return [{ id: n.slice(0, -6), title: userText(first.message.content).slice(0, 120), updatedAt: mtime }];
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
