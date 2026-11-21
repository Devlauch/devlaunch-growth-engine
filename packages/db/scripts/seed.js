#!/usr/bin/env node
/**
 * Runs packages/db/seed.sql against DATABASE_URL.
 *
 * This is the thing "npm run db:seed" is supposed to invoke. It does not
 * duplicate seed.sql's contents here — it just reads that file at runtime
 * and executes it as-is, so seed.sql (idempotent via ON CONFLICT DO
 * NOTHING, see migration 014_seed_dev_tenant.sql for the equivalent
 * applied via migrations) stays the single source of truth for what gets
 * seeded.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node ./scripts/seed.js
 *   npm run db:seed   (from packages/db, with DATABASE_URL set)
 */

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Example: DATABASE_URL=postgres://user:pass@localhost:5432/devlaunch");
  }

  const seedFilePath = path.join(__dirname, "..", "seed.sql");
  const seedSql = fs.readFileSync(seedFilePath, "utf8");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(seedSql);
    console.log(`Seed data applied successfully from ${seedFilePath}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Failed to apply seed data:", err);
  process.exitCode = 1;
});
