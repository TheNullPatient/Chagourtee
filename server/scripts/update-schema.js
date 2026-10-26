const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// Keep the historical default independent of the current working directory.
// An explicit CHAGOURTEE_DB_PATH always wins.
if (!process.env.CHAGOURTEE_DB_PATH) {
  process.env.CHAGOURTEE_DB_PATH = path.join(__dirname, '../data/chagourtee.db');
}

const { getDb, getDbPath } = require('../src/db');

function main() {
  const dbPath = getDbPath();
  console.log(`Updating database schema at ${dbPath}...`);

  // createDb() runs all CREATE TABLE IF NOT EXISTS / ALTER TABLE migrations,
  // so opening the database is enough to bring an old schema up to date.
  const db = getDb();

  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => row.name);

  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => row.name);

  console.log(`Database schema is up to date (${tables.length} tables, ${indexes.length} indexes).`);

  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    console.warn(
      `Warning: ${violations.length} foreign key violation(s) remain in the database.`
    );
  }

  db.close();
}

try {
  main();
} catch (error) {
  console.error('Failed to update database schema:', error);
  process.exitCode = 1;
}
