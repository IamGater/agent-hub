// @ts-check
import crypto from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { decodeClientDataJSON } from '@simplewebauthn/server/helpers';
import { z } from 'zod';
import { getSetting, setSetting } from '../db.js';
import { getPasskey, listPasskeys, usePasskey } from './store.js';

const b64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(16384);

export const registrationResponse = z.object({
  id: b64url,
  rawId: b64url,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: b64url,
    attestationObject: b64url,
    transports: z.array(z.string().max(32)).max(10).optional(),
    publicKeyAlgorithm: z.number().optional(),
    publicKey: b64url.optional(),
    authenticatorData: b64url.optional(),
  }),
  authenticatorAttachment: z.string().max(32).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
});

export const authenticationResponse = z.object({
  id: b64url,
  rawId: b64url,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: b64url,
    authenticatorData: b64url,
    signature: b64url,
    userHandle: b64url.optional(),
  }),
  authenticatorAttachment: z.string().max(32).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Pulls the challenge out of clientDataJSON so we can look it up in the server-side store.
 * The signature check later proves the authenticator actually signed this value.
 * @param {{ response: { clientDataJSON: string } }} res
 * @returns {string | null}
 */
export function challengeOf(res) {
  try {
    const c = decodeClientDataJSON(res.response.clientDataJSON).challenge;
    return typeof c === 'string' && c.length > 0 && c.length <= 128 ? c : null;
  } catch {
    return null;
  }
}

/** @param {import('better-sqlite3').Database} db */
function userId(db) {
  let id = getSetting(db, 'user_id');
  if (!id) {
    id = crypto.randomBytes(32).toString('base64url');
    setSetting(db, 'user_id', id);
  }
  return Buffer.from(id, 'base64url');
}

/**
 * @param {string} rpName
 * @param {import('../config/load.js').Scope} scope
 * @param {import('better-sqlite3').Database} db
 */
export function registrationOptions(rpName, scope, db) {
  return generateRegistrationOptions({
    rpName,
    rpID: scope.rpID,
    userName: 'owner',
    userDisplayName: 'Owner',
    userID: new Uint8Array(userId(db)),
    attestationType: 'none',
    timeout: 120000,
    excludeCredentials: listPasskeys(db, scope.rpID).map((p) => ({
      id: p.id,
      transports: JSON.parse(p.transports),
    })),
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    supportedAlgorithmIDs: [-7, -8, -257],
  });
}

/**
 * @param {import('../config/load.js').Scope} scope
 * @param {z.infer<typeof registrationResponse>} response
 * @param {string} challenge already taken from the challenge store
 */
export async function verifyRegistration(scope, response, challenge) {
  const result = await verifyRegistrationResponse({
    // @ts-expect-error transports are validated as strings; the library narrows them further
    response,
    expectedChallenge: challenge,
    expectedOrigin: scope.origin,
    expectedRPID: scope.rpID,
    requireUserVerification: true,
  });
  if (!result.verified) return null;
  return result.registrationInfo.credential;
}

/**
 * @param {import('../config/load.js').Scope} scope
 * @param {import('better-sqlite3').Database} db
 * @param {boolean} discoverable login uses discoverable credentials; step-up lists ours explicitly
 */
export function authenticationOptions(scope, db, discoverable) {
  return generateAuthenticationOptions({
    rpID: scope.rpID,
    userVerification: 'required',
    timeout: 120000,
    allowCredentials: discoverable
      ? []
      : listPasskeys(db, scope.rpID).map((p) => ({ id: p.id, transports: JSON.parse(p.transports) })),
  });
}

/**
 * Verifies an assertion against a stored passkey of this scope and advances its signature counter.
 * @param {import('../config/load.js').Scope} scope
 * @param {import('better-sqlite3').Database} db
 * @param {z.infer<typeof authenticationResponse>} response
 * @param {string} challenge already taken from the challenge store
 * @param {number} now
 * @returns {Promise<string | null>} passkey id
 */
export async function verifyAssertion(scope, db, response, challenge, now) {
  const pk = getPasskey(db, response.id, scope.rpID);
  if (!pk) return null;
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: scope.origin,
    expectedRPID: scope.rpID,
    requireUserVerification: true,
    credential: {
      id: pk.id,
      publicKey: new Uint8Array(pk.public_key),
      counter: pk.counter,
      transports: JSON.parse(pk.transports),
    },
  });
  if (!result.verified) return null;
  usePasskey(db, pk.id, result.authenticationInfo.newCounter, now);
  return pk.id;
}
