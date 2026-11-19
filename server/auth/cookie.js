// @ts-check

// __Host- forces Secure, Path=/ and no Domain in the browser, so the cookie cannot be set by
// a sibling host or read over plain http.
export const COOKIE = '__Host-rc';

/**
 * @param {string | undefined} header
 * @returns {string | null}
 */
export function readSessionCookie(header) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }
  return null;
}

/** @param {string} token @param {number} maxAgeSec */
export function sessionCookie(token, maxAgeSec) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${Math.floor(maxAgeSec)}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
