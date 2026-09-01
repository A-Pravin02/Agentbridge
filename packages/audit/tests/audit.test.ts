import { describe, it, expect } from 'vitest';
import {
  computeAuditEventHash,
  serializeMetadata,
  verifyChainIntegrity,
  GENESIS_HASH,
  ChainEvent,
} from '../src/index.js';

describe('Audit Package (@agentbridge/audit)', () => {
  describe('serializeMetadata', () => {
    it('should sort object keys deterministically', () => {
      const obj1 = { z: 1, a: 2, m: 3 };
      const obj2 = { a: 2, m: 3, z: 1 };
      expect(serializeMetadata(obj1)).toBe(serializeMetadata(obj2));
      expect(serializeMetadata(obj1)).toBe('{"a":2,"m":3,"z":1}');
    });

    it('should handle JSON string input and sort keys', () => {
      const jsonStr = '{"b":2,"a":1}';
      expect(serializeMetadata(jsonStr)).toBe('{"a":1,"b":2}');
    });

    it('should handle empty or null metadata safely', () => {
      expect(serializeMetadata(null as any)).toBe('{}');
      expect(serializeMetadata(undefined as any)).toBe('{}');
    });
  });

  describe('computeAuditEventHash', () => {
    it('should produce identical SHA-256 hashes for identical inputs', () => {
      const input = {
        action: 'PURCHASE_INTENT_CREATED',
        timestamp: '2026-08-30T12:00:00.000Z',
        metadata: { amount: 500, productId: 'prod_1' },
        previousHash: GENESIS_HASH,
      };

      const hash1 = computeAuditEventHash(input);
      const hash2 = computeAuditEventHash({
        ...input,
        metadata: { productId: 'prod_1', amount: 500 }, // different key order
      });

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex string length
    });

    it('should produce different hashes if any field changes', () => {
      const base = {
        action: 'PURCHASE_INTENT_CREATED',
        timestamp: '2026-08-30T12:00:00.000Z',
        metadata: { amount: 500 },
        previousHash: GENESIS_HASH,
      };

      const hash1 = computeAuditEventHash(base);
      const hash2 = computeAuditEventHash({ ...base, action: 'PURCHASE_ALLOWED' });
      const hash3 = computeAuditEventHash({ ...base, previousHash: 'prev_hash_123' });

      expect(hash1).not.toBe(hash2);
      expect(hash1).not.toBe(hash3);
    });
  });

  describe('verifyChainIntegrity', () => {
    it('should return valid for empty chain', () => {
      const result = verifyChainIntegrity([]);
      expect(result.valid).toBe(true);
      expect(result.totalEvents).toBe(0);
    });

    it('should verify a valid cryptographic hash chain', () => {
      const ts1 = '2026-08-30T10:00:00.000Z';
      const meta1 = { productId: 'item-1' };
      const hash1 = computeAuditEventHash({
        action: 'PRODUCT_SEARCHED',
        timestamp: ts1,
        metadata: meta1,
        previousHash: GENESIS_HASH,
      });

      const ts2 = '2026-08-30T10:01:00.000Z';
      const meta2 = { productId: 'item-1', amount: 299 };
      const hash2 = computeAuditEventHash({
        action: 'PURCHASE_INTENT_CREATED',
        timestamp: ts2,
        metadata: meta2,
        previousHash: hash1,
      });

      const ts3 = '2026-08-30T10:02:00.000Z';
      const meta3 = { decision: 'ALLOW' };
      const hash3 = computeAuditEventHash({
        action: 'POLICY_EVALUATED',
        timestamp: ts3,
        metadata: meta3,
        previousHash: hash2,
      });

      const chain: ChainEvent[] = [
        { action: 'PRODUCT_SEARCHED', createdAt: ts1, metadata: meta1, previousHash: GENESIS_HASH, hash: hash1 },
        { action: 'PURCHASE_INTENT_CREATED', createdAt: ts2, metadata: meta2, previousHash: hash1, hash: hash2 },
        { action: 'POLICY_EVALUATED', createdAt: ts3, metadata: meta3, previousHash: hash2, hash: hash3 },
      ];

      const result = verifyChainIntegrity(chain);
      expect(result.valid).toBe(true);
      expect(result.totalEvents).toBe(3);
    });

    it('should detect when an event payload is tampered', () => {
      const ts1 = '2026-08-30T10:00:00.000Z';
      const meta1 = { productId: 'item-1' };
      const hash1 = computeAuditEventHash({
        action: 'PRODUCT_SEARCHED',
        timestamp: ts1,
        metadata: meta1,
        previousHash: GENESIS_HASH,
      });

      const ts2 = '2026-08-30T10:01:00.000Z';
      const meta2 = { amount: 299 };
      const hash2 = computeAuditEventHash({
        action: 'PURCHASE_INTENT_CREATED',
        timestamp: ts2,
        metadata: meta2,
        previousHash: hash1,
      });

      const chain: ChainEvent[] = [
        { action: 'PRODUCT_SEARCHED', createdAt: ts1, metadata: meta1, previousHash: GENESIS_HASH, hash: hash1 },
        // Tampered metadata amount from 299 to 9999 without updating hash
        { action: 'PURCHASE_INTENT_CREATED', createdAt: ts2, metadata: { amount: 9999 }, previousHash: hash1, hash: hash2 },
      ];

      const result = verifyChainIntegrity(chain);
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(1);
      expect(result.reason).toContain('tampered');
    });

    it('should detect when previousHash linkage is broken', () => {
      const ts1 = '2026-08-30T10:00:00.000Z';
      const meta1 = { productId: 'item-1' };
      const hash1 = computeAuditEventHash({
        action: 'PRODUCT_SEARCHED',
        timestamp: ts1,
        metadata: meta1,
        previousHash: GENESIS_HASH,
      });

      const ts2 = '2026-08-30T10:01:00.000Z';
      const meta2 = { amount: 299 };
      const hash2 = computeAuditEventHash({
        action: 'PURCHASE_INTENT_CREATED',
        timestamp: ts2,
        metadata: meta2,
        previousHash: 'CORRUPTED_PREV_HASH',
      });

      const chain: ChainEvent[] = [
        { action: 'PRODUCT_SEARCHED', createdAt: ts1, metadata: meta1, previousHash: GENESIS_HASH, hash: hash1 },
        { action: 'PURCHASE_INTENT_CREATED', createdAt: ts2, metadata: meta2, previousHash: 'CORRUPTED_PREV_HASH', hash: hash2 },
      ];

      const result = verifyChainIntegrity(chain);
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(1);
      expect(result.reason).toContain('Previous hash mismatch');
    });
  });
});
