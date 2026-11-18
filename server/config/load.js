// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { configSchema, agentsSchema } from './schema.js';
import { resolveWorkdir } from '../agents/workdir.js';

/**
 * Where a request came from. "local" is the browser on this computer, "remote" is tailscale serve.
 * Each has its own origin, so passkeys (bound to rpID) and session cookies never cross over.
 * @typedef {{ name: 'local' | 'remote', origin: string, rpID: string, hosts: string[] }} Scope
 */

/**
 * @typedef {import('./schema.js').Config & {
 *   scopes: { local: Scope, remote: Scope | null },
 *   baseDir: string,
 * }} RuntimeConfig
 */

/**
 * Validates raw config and derives values that must never come from request headers.
 * @param {unknown} raw
 * @param {{ baseDir: string }} opts
 * @returns {RuntimeConfig}
 */
export function parseConfig(raw, { baseDir }) {
  const cfg = configSchema.parse(raw);
  if (cfg.remotePort === cfg.port) throw new Error('remotePort must differ from port');
  /** @type {Scope | null} */
  let remote = null;
  if (cfg.origin) {
    const url = new URL(cfg.origin);
    if (url.origin !== cfg.origin.toLowerCase().replace(/\/$/, '')) {
      throw new Error('origin must be scheme://host[:port] without path');
    }
    if (url.protocol !== 'https:') throw new Error('origin must be https');
    // The loopback Host covers a proxy that forwards the backend address; it is not a DNS
    // rebinding target, since an attacker's page would carry its own domain.
    remote = {
      name: 'remote',
      origin: url.origin,
      rpID: url.hostname,
      hosts: [url.host, `127.0.0.1:${cfg.remotePort}`],
    };
  }
  return {
    ...cfg,
    scopes: {
      // localhost is a secure context, so WebAuthn and Secure cookies work over plain http here.
      // 127.0.0.1 is accepted as Host for health checks; passkeys only work on "localhost".
      local: {
        name: 'local',
        origin: `http://localhost:${cfg.port}`,
        rpID: 'localhost',
        hosts: [`localhost:${cfg.port}`, `127.0.0.1:${cfg.port}`],
      },
      remote,
    },
    baseDir,
    dataDir: path.resolve(baseDir, cfg.dataDir),
    agentsFile: path.resolve(baseDir, cfg.agentsFile),
    allowedRoots: cfg.allowedRoots.map((r) => path.resolve(baseDir, r)),
  };
}

/** @param {string} file */
export function loadConfig(file) {
  const abs = path.resolve(file);
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  return parseConfig(raw, { baseDir: path.dirname(abs) });
}

/**
 * @param {unknown} raw
 * @param {string[]} roots
 * @returns {import('./schema.js').Agent[]}
 */
export function parseAgents(raw, roots) {
  const agents = agentsSchema.parse(raw);
  const ids = new Set();
  for (const a of agents) {
    if (ids.has(a.id)) throw new Error(`duplicate agent id: ${a.id}`);
    ids.add(a.id);
    a.cwd = resolveWorkdir(a.cwd, roots);
  }
  return agents;
}

/** @param {RuntimeConfig} cfg */
export function loadAgents(cfg) {
  const raw = JSON.parse(fs.readFileSync(cfg.agentsFile, 'utf8'));
  return parseAgents(raw, cfg.allowedRoots);
}
