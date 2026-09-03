// ============================================
// AgentBridge - Authentication
// ============================================
//
// The Phase 0 audit's most fundamental finding was that an agent's identity was
// a plain string in a JSON body, and that the optional signing path could be
// skipped entirely by omitting a header. Both are corrected here:
//
//   * Identity is proved by an Ed25519 signature over a canonical request
//     string. The server stores only public keys, so nothing in the database
//     can impersonate an agent.
//   * The check is a route-level preHandler. It cannot be skipped by omitting
//     anything — a missing header is a failure, not a bypass. Every mutating
//     agent route declares `preHandler: [authenticateAgent]`.
//
// Authentication ("who are you?") is here. Authorization ("may you do this?")
// is the policy engine's and the services' job, and is kept deliberately
// separate.

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ActorType,
  AgentStatus,
  AuditAction,
  SecurityViolation,
} from '@agentbridge/shared-types';
import { prisma } from '../db.js';
import { getConfig } from '../config.js';
import { SecurityError, UnauthenticatedError } from '../lib/errors.js';
import {
  buildCanonicalRequest,
  digestBody,
  hashToken,
  verifyAgentSignature,
} from '../lib/crypto.js';
import { recordAuditEvent } from '../services/audit-service.js';
import { recordSecurityIncident } from '../services/security-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set only after a successful Ed25519 verification. */
    agent?: { id: string; merchantId: string; keyId: string };
    /** Set only after a successful session lookup. */
    merchantUser?: { id: string; merchantId: string; role: string; email: string };
    /** Raw body bytes, captured for signature verification. */
    rawBody?: string;
  }
}

const AGENT_HEADERS = {
  keyId: 'x-agent-key-id',
  requestId: 'x-request-id',
  timestamp: 'x-timestamp',
  signature: 'x-agent-signature',
} as const;

/**
 * Verifies an agent request.
 *
 * Order matters: cheap, non-database checks first, so an unauthenticated
 * flood cannot force database work. All failures return the same generic
 * message so a caller cannot distinguish "unknown key" from "bad signature".
 */
export async function authenticateAgent(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const config = getConfig();
  const headers = request.headers as Record<string, string | undefined>;

  const keyId = headers[AGENT_HEADERS.keyId];
  const requestId = headers[AGENT_HEADERS.requestId];
  const timestamp = headers[AGENT_HEADERS.timestamp];
  const signature = headers[AGENT_HEADERS.signature];

  // 1. All four credentials are MANDATORY. Omitting one is a failure.
  if (!keyId || !requestId || !timestamp || !signature) {
    throw new SecurityError(
      SecurityViolation.MISSING_CREDENTIALS,
      401,
      'Request must be signed: X-Agent-Key-Id, X-Request-Id, X-Timestamp and X-Agent-Signature are all required'
    );
  }

  // 2. Freshness. Bounds a replay window even before the nonce check.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > config.REQUEST_SKEW_MS) {
    throw new SecurityError(
      SecurityViolation.EXPIRED_REQUEST,
      401,
      'Request timestamp is outside the acceptable window'
    );
  }

  // 3. Resolve the key.
  const agent = await prisma.agent.findUnique({
    where: { keyId },
    select: { id: true, merchantId: true, status: true, publicKey: true, keyId: true },
  });
  if (!agent) {
    // Same message and status as a bad signature: no key-enumeration oracle.
    throw new SecurityError(SecurityViolation.UNKNOWN_AGENT, 401, 'Request could not be authenticated');
  }

  // 4. Signature over method + path + nonce + timestamp + body digest.
  const canonical = buildCanonicalRequest({
    keyId,
    requestId,
    timestamp,
    method: request.method,
    path: request.url.split('?')[0],
    bodyDigest: digestBody(request.rawBody ?? ''),
  });

  const valid = verifyAgentSignature({
    publicKeyBase64: agent.publicKey,
    message: canonical,
    signatureBase64: signature,
  });

  if (!valid) {
    await recordSecurityIncident({
      agentId: agent.id,
      type: SecurityViolation.INVALID_REQUEST_SIGNATURE,
      description: 'Ed25519 signature verification failed',
      metadata: { path: request.url.split('?')[0], method: request.method },
    });
    await recordAuditEvent({
      action: AuditAction.AGENT_AUTH_FAILED,
      actorType: ActorType.SYSTEM,
      actorId: 'auth',
      entityId: agent.id,
      metadata: { reason: 'signature_mismatch' },
    });
    throw new SecurityError(
      SecurityViolation.INVALID_REQUEST_SIGNATURE,
      401,
      'Request could not be authenticated'
    );
  }

  // 5. Replay protection. The unique (agentId, requestId) index makes
  //    single-use a database guarantee rather than a checked-then-used race.
  const consumed = await prisma.consumedRequest
    .create({
      data: {
        agentId: agent.id,
        requestId,
        expiresAt: new Date(Date.now() + config.REQUEST_ID_TTL_MS),
      },
    })
    .then(() => true)
    .catch(() => false);

  if (!consumed) {
    await recordSecurityIncident({
      agentId: agent.id,
      type: SecurityViolation.REPLAY_ATTACK,
      description: 'A signed request nonce was presented more than once',
      metadata: { path: request.url.split('?')[0] },
    });
    await recordAuditEvent({
      action: AuditAction.REPLAY_ATTACK_DETECTED,
      actorType: ActorType.SYSTEM,
      actorId: 'auth',
      entityId: agent.id,
      metadata: { method: request.method },
    });
    throw new SecurityError(
      SecurityViolation.REPLAY_ATTACK,
      401,
      'This request has already been processed'
    );
  }

  // 6. Status gate. Checked AFTER authentication so a quarantined agent's
  //    status is never revealed to an unauthenticated caller.
  if (agent.status !== AgentStatus.ACTIVE) {
    throw new SecurityError(
      SecurityViolation.INACTIVE_AGENT,
      403,
      'Agent access is suspended pending security review'
    );
  }

  request.agent = { id: agent.id, merchantId: agent.merchantId, keyId: agent.keyId };
}

/** Verifies a merchant-user session cookie or bearer token. */
export async function authenticateMerchantUser(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) throw new UnauthenticatedError('A merchant session is required');

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
    throw new UnauthenticatedError('Session is invalid or has expired');
  }
  if (session.user.status !== 'ACTIVE') {
    throw new UnauthenticatedError('This account is not active');
  }

  request.merchantUser = {
    id: session.user.id,
    merchantId: session.user.merchantId,
    role: session.user.role,
    email: session.user.email,
  };
}

/** Requires an authenticated merchant user holding one of `roles`. */
export function requireRole(...roles: string[]) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.merchantUser) await authenticateMerchantUser(request, reply);
    const user = request.merchantUser!;
    if (!roles.includes(user.role)) {
      throw new SecurityError('INSUFFICIENT_ROLE', 403, 'This action requires a higher privilege level');
    }
  };
}
