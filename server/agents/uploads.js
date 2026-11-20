// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { detectImage } from './images.js';

/** Pictures the owner pasted into the message box, kept until they are sent and a while after. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const KEEP_MS = 7 * 24 * 3600_000;
const MAX_HELD = 200;
export const UPLOAD_ID = /^[0-9a-f]{24}$/;

/**
 * @typedef {{ id: string, file: string, mime: string }} Upload
 * @param {string} dir
 * @param {() => number} [now]
 */
export function createUploads(dir, now = Date.now) {
  /** @type {Map<string, Upload>} */
  const held = new Map();
  let pruned = false;

  /** Old files from earlier runs go; sent pictures are only shown in the chat for a while. */
  function prune() {
    pruned = true;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        if (now() - fs.statSync(file).mtimeMs > KEEP_MS) fs.rmSync(file, { force: true });
      } catch {
        // Gone or locked: tried again next start.
      }
    }
  }

  return {
    /**
     * Stores the picture when it really is one (magic bytes decide, not what the client says).
     * @param {Buffer} data @returns {Upload | null}
     */
    save(data) {
      const type = detectImage(data);
      if (!type || data.length > UPLOAD_MAX_BYTES) return null;
      if (!pruned) prune();
      fs.mkdirSync(dir, { recursive: true });
      const id = randomBytes(12).toString('hex');
      const file = path.join(dir, `${id}${type.ext}`);
      fs.writeFileSync(file, data, { mode: 0o600 });
      if (held.size >= MAX_HELD) held.delete(/** @type {string} */ (held.keys().next().value));
      const upload = { id, file, mime: type.mime };
      held.set(id, upload);
      return upload;
    },
    /** @param {string} id @returns {Upload | null} */
    get(id) {
      return (UPLOAD_ID.test(id) && held.get(id)) || null;
    },
  };
}

/** @typedef {ReturnType<typeof createUploads>} Uploads */
