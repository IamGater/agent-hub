// @ts-check
import fs from 'node:fs';
import path from 'node:path';

const MAX = 300;

/**
 * Folders an agent can be started in: each allowed root and its direct subfolders.
 * Only names are read; whether a folder is really inside a root is decided again at spawn time.
 * @param {string[]} roots
 * @returns {{ name: string, path: string }[]}
 */
export function listProjects(roots) {
  /** @type {{ name: string, path: string }[]} */
  const out = [];
  for (const root of roots) {
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    out.push({ name: root, path: root });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of dirs) {
      if (out.length >= MAX) return out;
      out.push({ name, path: path.join(root, name) });
    }
  }
  return out;
}
