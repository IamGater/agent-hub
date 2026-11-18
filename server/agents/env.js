// @ts-check

/**
 * Builds the agent environment from scratch: only allow-listed variables from the server
 * environment, plus explicit values from agents.json. Nothing else leaks into the PTY.
 * @param {string[]} allow
 * @param {Record<string, string>} extra
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {Record<string, string>}
 */
export function buildEnv(allow, extra, source = process.env) {
  // Windows env names are case-insensitive; match them that way so "Path" counts as "PATH".
  const byUpper = new Map(Object.keys(source).map((k) => [k.toUpperCase(), k]));
  /** @type {Record<string, string>} */
  const env = {};
  for (const name of allow) {
    const key = byUpper.get(name.toUpperCase());
    const value = key && source[key];
    if (value !== undefined && value !== '') env[name] = value;
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...extra };
}
