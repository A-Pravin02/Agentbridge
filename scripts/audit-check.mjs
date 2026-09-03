#!/usr/bin/env node
// ============================================
// Dependency audit gate
// ============================================
// `npm audit --omit=dev` does not reliably exclude a WORKSPACE package's
// devDependencies, so it reports the Prisma CLI's transitive advisory and fails
// the build on a package that never ships.
//
// Silencing the whole gate would be the wrong fix — it would also silence a
// real advisory in something we actually deploy. Instead this fails on any
// high or critical advisory that is not explicitly accepted below, with a
// documented reason and a review date. A new advisory breaks the build; a known
// one does not.

import { execFileSync } from 'child_process';

/**
 * Advisories accepted with reasons. Each is also recorded in SECURITY_AUDIT.md.
 * Removing a package from here re-arms the gate for it.
 */
const ACCEPTED = {
  'deepmerge-ts': {
    reason:
      'Stack exhaustion on recursive object graphs. Reached only through the Prisma ' +
      'CLI (a devDependency used for migrations and codegen), never at runtime. ' +
      'Fixed only in a Prisma 8 release candidate; shipping an ORM RC to resolve a ' +
      'dev-only advisory is the worse trade.',
    tracked: 'SECURITY_AUDIT.md A-5',
    review: 'when Prisma 8 is stable',
  },
  '@prisma/config': { reason: 'Transitive via prisma CLI. See deepmerge-ts.', tracked: 'A-5' },
  prisma: { reason: 'Dev-only CLI. See deepmerge-ts.', tracked: 'A-5' },
};

const BLOCKING = new Set(['high', 'critical']);

let report;
try {
  // npm audit exits non-zero when it finds anything, so the throw carries the
  // payload we actually want.
  report = execFileSync('npm', ['audit', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  });
} catch (error) {
  report = error.stdout;
}

if (!report) {
  console.error('audit-check: npm audit produced no output');
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(report);
} catch {
  console.error('audit-check: could not parse npm audit output');
  process.exit(1);
}

const vulnerabilities = parsed.vulnerabilities ?? {};
const blocking = [];
const accepted = [];

for (const [name, detail] of Object.entries(vulnerabilities)) {
  if (!BLOCKING.has(detail.severity)) continue;
  (ACCEPTED[name] ? accepted : blocking).push({ name, severity: detail.severity, detail });
}

if (accepted.length > 0) {
  console.log('Accepted advisories (documented, not shipped at runtime):');
  for (const { name, severity } of accepted) {
    console.log(`  - ${name} [${severity}] — ${ACCEPTED[name].tracked}`);
  }
  console.log('');
}

if (blocking.length > 0) {
  console.error('BLOCKING advisories — these are not on the accepted list:');
  for (const { name, severity, detail } of blocking) {
    const via = Array.isArray(detail.via)
      ? detail.via.map((v) => (typeof v === 'string' ? v : v.title)).join(', ')
      : '';
    console.error(`  - ${name} [${severity}] ${via}`);
  }
  console.error('');
  console.error('Fix them, or add them to ACCEPTED in scripts/audit-check.mjs with a');
  console.error('reason and a corresponding entry in SECURITY_AUDIT.md.');
  process.exit(1);
}

console.log(`No unaccepted high or critical advisories (${accepted.length} accepted).`);
