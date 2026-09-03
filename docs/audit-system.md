# Audit System

Every security-relevant event is appended to a hash chain that makes modification and
deletion detectable.

## The digest

```
H(n) = SHA256( sequence | action | actorType | actorId | entityId
               | timestamp | canonical(metadata) | H(n-1) )
```

Two design points, both learned from defects in the previous build:

**All identity fields are inside the digest.** The old chain hashed only
`action | timestamp | metadata | previousHash`. `actorId` and `entityId` were outside
it, so an attacker could rewrite *who did what to whom* and the chain still verified.

**The timestamp is application-authored.** The old code hashed a JS `new Date()` while
the row's `createdAt` was written independently by the database. The two clock reads
differed — measured at 2 ms — so the recomputed digest never matched and verification
failed 100% of the time, on every event, since the project began. One authoritative
value is now both hashed and persisted, so the verifier reads exactly what was signed.

## Canonical metadata

Keys are sorted recursively at every depth, so logically equal objects always produce
the same digest:

```ts
serializeMetadata({ b: 1, a: { z: 2, y: 3 } })
  === serializeMetadata({ a: { y: 3, z: 2 }, b: 1 })   // true
```

The old implementation passed a key array to `JSON.stringify`, which is a *replacer
allow-list applied at every nesting level* — it did not sort, and it silently stripped
nested keys.

## Concurrency: the chain head

Appending naively (read the tip, then insert) forks under load: two writers read the
same predecessor and both link to it. That was measurably happening — 3 forks in 89
events.

The chain head is a single row advanced by compare-and-swap:

```ts
const moved = await db.auditChainHead.updateMany({
  where: { id: 'singleton', sequence: head.sequence },   // pins what we read
  data:  { sequence: head.sequence + 1, hash },
});
if (moved.count !== 1) throw new Error('CAS_CONFLICT');  // retry against the new tip
```

Exactly one writer can move the tip from N to N+1. Losers retry with jittered backoff.

## Transactional appends

`recordAuditEvent` accepts a transaction handle:

```ts
await prisma.$transaction(async (tx) => {
  await transitionIntent(tx, id, FROM, TO);
  await recordAuditEvent({ /* ... */ }, tx);   // commits or rolls back together
});
```

So there can be no state change without a corresponding audit record.

## Verification

```
POST /api/audit/verify
```

Streams the chain in pages of 500 (bounded memory) and checks three things per event:

1. **Linkage** — `previousHash` matches the predecessor's `hash`.
2. **No deletion** — `sequence` advances by exactly one. A gap is proof of removal.
3. **Content** — the recomputed digest matches the stored one.

```jsonc
{ "valid": true, "totalEvents": 220, "verifiedThroughSequence": 219 }

{ "valid": false, "brokenAt": 42, "brokenEventId": "evt_x",
  "breakReason": "CONTENT_HASH_MISMATCH",
  "reason": "Content hash mismatch at index 42 (sequence 42): this event's payload has been modified since it was recorded." }
```

`GET /api/transactions/:id/timeline` additionally verifies just that transaction's
events and shows the result inline.

## Why it cannot be quietly repaired

An attacker who edits event *n* and recomputes its hash has not fixed anything: event
*n+1* still stores the old `previousHash`, so verification breaks at *n+1* instead.
Repairing the whole chain means recomputing every subsequent event — which the demo's
audit-tamper scenario and the test `cannot be repaired by re-hashing a single tampered
event` both demonstrate.

## What this is not

It is **not** a blockchain, and the project does not claim to be one. There is no
distributed consensus and no external anchor. A cryptographically chained log is the
right tool for the actual requirement — tamper *evidence* for a single operator — and
adding consensus would be complexity without a corresponding threat.

The honest residual risk: audit rows are deletable by the application's own database
user. The chain makes deletion **detectable**, not **impossible**. Append-only storage,
or periodically anchoring the head hash somewhere external, would close that gap.
