// ============================================
// AgentBridge - Cryptographic Helpers
// ============================================

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scrypt as scryptCb,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
} from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;

// ---- Passwords (merchant users) ----

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/**
 * Verifies a password in constant time.
 * Returns false (never throws) on a malformed stored hash, so a corrupt row
 * cannot be distinguished from a wrong password by timing or error type.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    if (expected.length !== SCRYPT_KEYLEN) return false;
    const actual = await scrypt(password, salt, SCRYPT_KEYLEN);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ---- Opaque tokens (sessions, approval links) ----

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Tokens are stored only as digests, so a database leak cannot be replayed. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// ---- Agent identity: Ed25519 ----
//
// The server stores ONLY the public key. Nothing in the database can forge an
// agent request. This is the property that makes "the agent is untrusted"
// structurally true rather than aspirational.

export interface AgentKeyPair {
  keyId: string;
  /** base64, raw 32-byte Ed25519 public key. Safe to store and to publish. */
  publicKey: string;
  /** base64 PKCS#8 private key. Returned once, at creation. Never stored. */
  privateKey: string;
}

export function generateAgentKeyPair(): AgentKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  // The raw key is the trailing 32 bytes of the SPKI DER encoding.
  const raw = spki.subarray(spki.length - 32);
  return {
    keyId: `ak_${randomBytes(12).toString('hex')}`,
    publicKey: raw.toString('base64'),
    privateKey: (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64'),
  };
}

/** Ed25519 SPKI prefix for a raw 32-byte public key. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function publicKeyFromRaw(rawBase64: string) {
  const raw = Buffer.from(rawBase64, 'base64');
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Verifies an Ed25519 signature over a canonical request string.
 * Returns false rather than throwing on any malformed input.
 */
export function verifyAgentSignature(params: {
  publicKeyBase64: string;
  message: string;
  signatureBase64: string;
}): boolean {
  try {
    const key = publicKeyFromRaw(params.publicKeyBase64);
    const sig = Buffer.from(params.signatureBase64, 'base64');
    if (sig.length !== 64) return false;
    return edVerify(null, Buffer.from(params.message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

/** Client-side counterpart. Used by the demo agent, the MCP server and tests. */
export function signAsAgent(privateKeyBase64: string, message: string): string {
  const { createPrivateKey } = require('crypto') as typeof import('crypto');
  const key = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return edSign(null, Buffer.from(message, 'utf8'), key).toString('base64');
}

// ---- Canonical request ----

/**
 * The exact string an agent signs.
 *
 * Binding all of method, path, nonce, timestamp and a digest of the body means
 * a signature cannot be lifted onto a different route, replayed later, or
 * reused after tampering with any field — including the amount.
 *
 * Fields are newline-separated and none may contain a newline, so the encoding
 * is unambiguous.
 */
export function buildCanonicalRequest(params: {
  keyId: string;
  requestId: string;
  timestamp: string;
  method: string;
  path: string;
  bodyDigest: string;
}): string {
  return [
    'AGENTBRIDGE-ED25519-V1',
    params.keyId,
    params.requestId,
    params.timestamp,
    params.method.toUpperCase(),
    params.path,
    params.bodyDigest,
  ].join('\n');
}

/** SHA-256 of the raw request bytes exactly as transmitted. */
export function digestBody(rawBody: string): string {
  return createHash('sha256').update(rawBody ?? '', 'utf8').digest('hex');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
