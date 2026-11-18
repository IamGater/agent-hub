// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './workdir.js';

// SVG is left out on purpose: it is a document that can carry script, not just pixels.
const TYPES = /** @type {Record<string, { mime: string, magic: (b: Buffer) => boolean }>} */ ({
  '.png': {
    mime: 'image/png',
    magic: (b) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  },
  '.jpg': { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  '.jpeg': { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  '.gif': { mime: 'image/gif', magic: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  '.webp': {
    mime: 'image/webp',
    magic: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  '.bmp': { mime: 'image/bmp', magic: (b) => b.subarray(0, 2).toString('latin1') === 'BM' },
});

export const IMAGE_MAX_BYTES = 15 * 1024 * 1024;

/** @param {string} file */
export function isImagePath(file) {
  return Object.hasOwn(TYPES, path.extname(file).toLowerCase());
}

/**
 * Reads an image an agent touched, for showing it in the chat. Only real image files (extension and
 * magic bytes agree). With `roots`, only inside them, checked on the real path so a link cannot
 * point out; null means the place was already vetted (the agent's own tool call read it).
 * @param {string} file
 * @param {string[] | null} roots
 * @returns {{ mime: string, data: Buffer } | null}
 */
export function readImage(file, roots) {
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type || !path.isAbsolute(file) || file.startsWith('\\\\') || file.startsWith('//')) return null;
  let real;
  try {
    real = fs.realpathSync.native(file);
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > IMAGE_MAX_BYTES) return null;
  } catch {
    return null;
  }
  const inside =
    !roots ||
    roots.some((root) => {
      try {
        return isInside(real, fs.realpathSync.native(root));
      } catch {
        return false;
      }
    });
  if (!inside) return null;
  const data = fs.readFileSync(real);
  return type.magic(data) ? { mime: type.mime, data } : null;
}
