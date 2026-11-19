import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { has, t } from './i18n.js';

export class ApiError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// Translated when shown, not when thrown, so a language switch applies to errors already on screen.
export function messageOf(err) {
  const code = err instanceof ApiError ? err.code : err?.name;
  if (code && has(`err.${code}`)) return t(`err.${code}`);
  return t(err instanceof ApiError ? 'err.request' : 'err.generic');
}

export async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? 'error', res.status);
  return data;
}

export async function enroll(token, name) {
  const options = await api('/api/enroll/options', { token });
  const response = await startRegistration({ optionsJSON: options });
  return api('/api/enroll/verify', { response, name: name || undefined });
}

export async function login() {
  const options = await api('/api/login/options', {});
  const response = await startAuthentication({ optionsJSON: options });
  return api('/api/login/verify', { response });
}

export async function stepup() {
  const options = await api('/api/stepup/options', {});
  const response = await startAuthentication({ optionsJSON: options });
  return api('/api/stepup/verify', { response });
}

let scope = 'local';

export function setScope(s) {
  scope = s;
}

// At the computer an action runs directly. From the phone every dangerous action gets its own
// passkey check; the server binds the challenge to the action.
export async function dangerous(action) {
  if (scope === 'local') return api('/api/action/run', { action });
  const options = await api('/api/action/options', { action });
  const response = await startAuthentication({ optionsJSON: options });
  const result = await api('/api/action/verify', { response });
  if (result.registration) {
    const reg = await startRegistration({ optionsJSON: result.registration });
    return api('/api/passkeys/verify', { response: reg });
  }
  return result;
}
