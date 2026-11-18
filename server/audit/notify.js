// @ts-check
import { redact } from './redact.js';

/**
 * Sends a short notification through ntfy. Never pass agent output here: only event names and ids.
 * Failures are logged and swallowed so a dead ntfy server cannot block the app.
 * @param {{ url: string, topic: string } | undefined} cfg
 * @param {{ warn: (msg: string) => void }} log
 */
export function createNotifier(cfg, log) {
  /** @param {string} title @param {string} message */
  return async function notify(title, message) {
    if (!cfg) return;
    /** @type {Record<string, string>} */
    const headers = { Title: redact(title), 'Content-Type': 'text/plain; charset=utf-8' };
    if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
    try {
      const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/${cfg.topic}`, {
        method: 'POST',
        headers,
        body: redact(message),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!res.ok) log.warn(`ntfy responded ${res.status}`);
    } catch (err) {
      log.warn(`ntfy failed: ${/** @type {Error} */ (err).message}`);
    }
  };
}
