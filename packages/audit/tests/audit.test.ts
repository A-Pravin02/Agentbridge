// ============================================
// Audit chain — hashing, canonicalisation, tamper detection
// ============================================

import { describe, it, expect } from 'vitest';
import {
  GENESIS_HASH,
  canonicalizeEvent,
  computeAuditEventHash,
  serializeMetadata,
  verifyChainIntegrity,
  type AuditEventCore,
  type ChainEvent,
} from '../src/index.js';

function core(overrides: Partial<AuditEventCore> = {}): AuditEventCore {
  return {
    sequence: 0,
    action: 'PURCHASE_INTENT_CREATED',
    actorType: 'AGENT',
    actorId: 'agent_1',
    entityId: 'intent_1',
    timestamp: '2026-09-03T12:00:00.000Z',
    metadata: JSON.stringify({ amountMinor: 29900 }),
    previousHash: GENESIS_HASH,
    ...overrides,
  };
}

/** Builds a correctly linked chain of n events. */
function buildChain(n: number): ChainEvent[] {
  const events: ChainEvent[] = [];
  let previousHash = GENESIS_HASH;
  for (let i = 0; i < n; i++) {
    const c = core({
      sequence: i,
      previousHash,
      entityId: `intent_${i}`,
      timestamp: new Date(Date.UTC(2026, 8, 3, 12, 0, i)).toISOString(),
    });
    const hash = computeAuditEventHash(c);
    events.push({ ...c, id: `evt_${i}`, hash });
    previousHash = hash;
  }
  return events;
}

describe('serializeMetadata', () => {
  it('sorts keys so logically equal objects hash identically', () => {
    expect(serializeMetadata({ b: 1, a: 2 })).toBe(serializeMetadata({ a: 2, b: 1 }));
  });

  it('sorts nested keys at every depth', () => {
    // The previous implementation used a replacer array, which sorted nothing
    // and silently stripped nested keys. This is the regression guard.
    const x = serializeMetadata({ outer: { z: 1, a: { y: 2, b: 3 } } });
    const y = serializeMetadata({ outer: { a: { b: 3, y: 2 }, z: 1 } });
    expect(x).toBe(y);
    expect(x).toContain('"b":3');
    expect(x).toContain('"y":2');
  });

  it('preserves nested values rather than dropping them', () => {
    const s = serializeMetadata({ a: 1, nested: { deep: { value: 'kept' } } });
    expect(s).toContain('kept');
  });

  it('handles arrays, null and undefined', () => {
    expect(serializeMetadata({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
    expect(serializeMetadata(null)).toBe('{}');
    expect(serializeMetadata(undefined)).toBe('{}');
  });

  it('passes through a non-JSON string unchanged', () => {
    expect(serializeMetadata('not json')).toBe('not json');
  });
});

describe('computeAuditEventHash', () => {
  it('is deterministic', () => {
    expect(computeAuditEventHash(core())).toBe(computeAuditEventHash(core()));
  });

  it('produces a 64-character hex digest', () => {
    expect(computeAuditEventHash(core())).toMatch(/^[0-9a-f]{64}$/);
  });

  // Every field must be covered. The old digest omitted the identity fields,
  // so an attacker could rewrite who did what and the chain still verified.
  const fields: Array<[string, Partial<AuditEventCore>]> = [
    ['sequence', { sequence: 99 }],
    ['action', { action: 'PURCHASE_BLOCKED' }],
    ['actorType', { actorType: 'SYSTEM' }],
    ['actorId', { actorId: 'someone_else' }],
    ['entityId', { entityId: 'another_intent' }],
    ['timestamp', { timestamp: '2026-09-03T12:00:01.000Z' }],
    ['metadata', { metadata: JSON.stringify({ amountMinor: 1 }) }],
    ['previousHash', { previousHash: 'a'.repeat(64) }],
  ];

  for (const [name, override] of fields) {
    it(`changes when ${name} changes`, () => {
      expect(computeAuditEventHash(core(override))).not.toBe(computeAuditEventHash(core()));
    });
  }

  it('cannot be spoofed by shifting content across field boundaries', () => {
    const a = canonicalizeEvent(core({ actorId: 'ab', entityId: 'cd' }));
    const b = canonicalizeEvent(core({ actorId: 'a', entityId: 'bcd' }));
    expect(a).not.toBe(b);
  });
});

describe('verifyChainIntegrity', () => {
  it('accepts an empty chain', () => {
    expect(verifyChainIntegrity([])).toMatchObject({ valid: true, totalEvents: 0 });
  });

  it('accepts a well-formed chain', () => {
    const result = verifyChainIntegrity(buildChain(25));
    expect(result.valid).toBe(true);
    expect(result.totalEvents).toBe(25);
  });

  it('detects a modified payload', () => {
    const chain = buildChain(10);
    chain[4] = { ...chain[4], metadata: JSON.stringify({ amountMinor: 1 }) };
    const result = verifyChainIntegrity(chain);
    expect(result.valid).toBe(false);
    expect(result.breakReason).toBe('CONTENT_HASH_MISMATCH');
    expect(result.brokenAt).toBe(4);
    expect(result.brokenEventId).toBe('evt_4');
  });

  it('detects a rewritten actor', () => {
    const chain = buildChain(6);
    chain[2] = { ...chain[2], actorId: 'attacker' };
    expect(verifyChainIntegrity(chain).valid).toBe(false);
  });

  it('detects a broken link', () => {
    const chain = buildChain(6);
    chain[3] = { ...chain[3], previousHash: 'f'.repeat(64) };
    const result = verifyChainIntegrity(chain);
    expect(result.valid).toBe(false);
    expect(result.breakReason).toBe('PREVIOUS_HASH_MISMATCH');
  });

  it('detects a deleted event via the sequence gap', () => {
    // Deleting a middle event and re-linking would still leave a gap.
    const chain = buildChain(8);
    const spliced = [...chain.slice(0, 4), ...chain.slice(5)];
    spliced[4] = { ...spliced[4], previousHash: spliced[3].hash };
    const result = verifyChainIntegrity(spliced);
    expect(result.valid).toBe(false);
    expect(result.breakReason).toBe('SEQUENCE_GAP');
  });

  it('detects a forged genesis', () => {
    const chain = buildChain(3);
    chain[0] = { ...chain[0], previousHash: 'not-genesis' };
    expect(verifyChainIntegrity(chain).breakReason).toBe('GENESIS_MISMATCH');
  });

  it('verifies a window against a supplied predecessor hash', () => {
    const chain = buildChain(10);
    const window = chain.slice(5);
    expect(verifyChainIntegrity(window, chain[4].hash).valid).toBe(true);
    expect(verifyChainIntegrity(window, 'wrong').valid).toBe(false);
  });

  it('cannot be repaired by re-hashing a single tampered event', () => {
    // An attacker who edits an event and recomputes ITS hash still breaks the
    // link for every subsequent event.
    const chain = buildChain(8);
    const tampered = { ...chain[3], metadata: JSON.stringify({ amountMinor: 1 }) };
    chain[3] = { ...tampered, hash: computeAuditEventHash(tampered) };
    const result = verifyChainIntegrity(chain);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(4); // the NEXT event's link no longer matches
  });
});
