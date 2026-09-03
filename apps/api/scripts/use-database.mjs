#!/usr/bin/env node
// ============================================
// Select the database target
// ============================================
// Prisma requires `datasource.provider` to be a string literal — it cannot be
// read from the environment. So the two targets live in two schema files that
// differ ONLY in that block, and this script copies the chosen one into place.
//
//   npm run db:use:sqlite     local development, zero setup
//   npm run db:use:postgres   deployment
//
// It also verifies the two files are otherwise identical, so the variants can
// never silently drift apart — a real risk when a model is added to one and not
// the other.

import { readFileSync, writeFileSync, existsSync, cpSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const prisma = join(here, '..', 'prisma');

const target = process.argv[2];
if (target !== 'sqlite' && target !== 'postgres') {
  console.error('Usage: node scripts/use-database.mjs <sqlite|postgres>');
  process.exit(1);
}

const variants = {
  sqlite: join(prisma, 'schema.sqlite.prisma'),
  postgres: join(prisma, 'schema.postgres.prisma'),
};
const active = join(prisma, 'schema.prisma');

for (const [name, path] of Object.entries(variants)) {
  if (!existsSync(path)) {
    console.error(`Missing schema variant: ${name} (${path})`);
    process.exit(1);
  }
}

/** Strips the datasource block and comments so the models can be compared. */
function models(text) {
  return text
    .replace(/datasource\s+db\s*\{[^}]*\}/s, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

const sqliteModels = models(readFileSync(variants.sqlite, 'utf8'));
const postgresModels = models(readFileSync(variants.postgres, 'utf8'));

if (sqliteModels !== postgresModels) {
  console.error(
    'The SQLite and PostgreSQL schema variants have drifted apart.\n' +
      'They must differ ONLY in the datasource block. Reconcile them before switching.'
  );
  process.exit(1);
}

writeFileSync(active, readFileSync(variants[target], 'utf8'));

// Migrations are provider-specific DDL, so each target keeps its own committed
// directory and this copies the chosen one into the path Prisma actually reads
// (prisma/migrations, which is git-ignored as a generated working copy).
const migrationSources = {
  sqlite: join(prisma, 'migrations-sqlite'),
  postgres: join(prisma, 'migrations-postgres'),
};
const activeMigrations = join(prisma, 'migrations');

if (!existsSync(migrationSources[target])) {
  console.error(`Missing migrations for ${target}: ${migrationSources[target]}`);
  process.exit(1);
}

rmSync(activeMigrations, { recursive: true, force: true });
cpSync(migrationSources[target], activeMigrations, { recursive: true });

console.log(`prisma/schema.prisma now targets ${target}`);
console.log(`prisma/migrations populated from migrations-${target}`);
console.log(
  target === 'postgres'
    ? 'Next: set DATABASE_URL to your Postgres URL, then `npm run db:migrate`.'
    : 'Next: `npm run db:migrate` (uses file:./dev.db).'
);
