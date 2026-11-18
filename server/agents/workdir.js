// @ts-check
import fs from 'node:fs';
import path from 'node:path';

const caseless = process.platform === 'win32';

/** @param {string} child @param {string} parent */
export function isInside(child, parent) {
  const a = caseless ? child.toLowerCase() : child;
  const b = caseless ? parent.toLowerCase() : parent;
  const rel = path.relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolves an agent working directory and checks that it stays inside one of the allowed roots.
 * The check runs on real paths so junctions and symlinks cannot point outside a root.
 * @param {string} dir
 * @param {string[]} roots
 * @returns {string} real path of the directory
 */
export function resolveWorkdir(dir, roots) {
  if (!path.isAbsolute(dir)) throw new Error(`workdir must be absolute: ${dir}`);
  if (dir.startsWith('\\\\') || dir.startsWith('//')) throw new Error(`UNC workdir not allowed: ${dir}`);
  const real = fs.realpathSync.native(dir);
  if (!fs.statSync(real).isDirectory()) throw new Error(`workdir is not a directory: ${dir}`);
  for (const root of roots) {
    let realRoot;
    try {
      realRoot = fs.realpathSync.native(root);
    } catch {
      continue;
    }
    if (isInside(real, realRoot)) return real;
  }
  throw new Error(`workdir outside allowed roots: ${dir}`);
}
