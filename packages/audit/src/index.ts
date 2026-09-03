export {
  GENESIS_HASH,
  serializeMetadata,
  canonicalizeEvent,
  computeAuditEventHash,
  verifyChainIntegrity,
} from './audit.js';
export type {
  AuditEventCore,
  ChainEvent,
  ChainBreakReason,
  ChainVerificationResult,
} from './audit.js';
