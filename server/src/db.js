const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'chagourtee.db');

function getDbPath() {
  return process.env.CHAGOURTEE_DB_PATH || DEFAULT_DB_PATH;
}

function ensureDataDir(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createDb(dbPath) {
  ensureDataDir(dbPath);
  const db = new Database(dbPath);

  // SQLite disables foreign key enforcement by default, which silently
  // disabled every ON DELETE CASCADE declared below.
  db.pragma('foreign_keys = ON');

  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true });
  if (foreignKeysEnabled !== 1) {
    console.error('Failed to enable SQLite foreign key enforcement');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      verified INTEGER NOT NULL DEFAULT 0,
      codeword_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      media_position TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS message_reads (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      created_by INTEGER NOT NULL REFERENCES users(id),
      max_uses INTEGER,
      uses_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS verification_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS server_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS media_storage_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      max_file_size INTEGER,
      max_storage_size INTEGER,
      cleanup_strategy TEXT NOT NULL DEFAULT 'block',
      orphan_cleanup_enabled INTEGER NOT NULL DEFAULT 1,
      orphan_cleanup_interval_minutes INTEGER NOT NULL DEFAULT 60,
      orphan_cleanup_grace_minutes INTEGER NOT NULL DEFAULT 10,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    
    CREATE TABLE IF NOT EXISTS media_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      encrypted_filename TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      uploaded_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      transcoded_filename TEXT,
      transcoded_mime_type TEXT,
      transcoded_created_at INTEGER
    );
    
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(room_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_message_reads_user_id ON message_reads(user_id);
    CREATE INDEX IF NOT EXISTS idx_media_files_message_id ON media_files(message_id);
    CREATE INDEX IF NOT EXISTS idx_media_files_uploaded_by ON media_files(uploaded_by);
  `);

  // Ensure new media_files columns exist on older databases
  try {
    const mediaColumns = db
      .prepare('PRAGMA table_info(media_files)')
      .all()
      .map((c) => c.name);

    const mediaRequiredColumns = [
      {
        name: 'transcoded_filename',
        ddl: 'ALTER TABLE media_files ADD COLUMN transcoded_filename TEXT',
      },
      {
        name: 'transcoded_mime_type',
        ddl: 'ALTER TABLE media_files ADD COLUMN transcoded_mime_type TEXT',
      },
      {
        name: 'transcoded_created_at',
        ddl: 'ALTER TABLE media_files ADD COLUMN transcoded_created_at INTEGER',
      },
    ];

    for (const col of mediaRequiredColumns) {
      if (!mediaColumns.includes(col.name)) {
        db.exec(col.ddl);
      }
    }
  } catch (e) {
    console.error('Failed to ensure media_files schema is up to date:', e);
  }

  // Ensure media_storage_settings schema is up to date on older databases
  try {
    const storageColumns = db
      .prepare('PRAGMA table_info(media_storage_settings)')
      .all()
      .map((c) => c.name);

    if (!storageColumns.includes('max_storage_size')) {
      db.exec('ALTER TABLE media_storage_settings ADD COLUMN max_storage_size INTEGER');
    }
    if (!storageColumns.includes('max_file_size')) {
      db.exec('ALTER TABLE media_storage_settings ADD COLUMN max_file_size INTEGER');
    }
    if (!storageColumns.includes('cleanup_strategy')) {
      db.exec(
        "ALTER TABLE media_storage_settings ADD COLUMN cleanup_strategy TEXT NOT NULL DEFAULT 'block'"
      );
    }
    if (!storageColumns.includes('orphan_cleanup_enabled')) {
      db.exec(
        "ALTER TABLE media_storage_settings ADD COLUMN orphan_cleanup_enabled INTEGER NOT NULL DEFAULT 1"
      );
    }
    if (!storageColumns.includes('orphan_cleanup_interval_minutes')) {
      db.exec(
        "ALTER TABLE media_storage_settings ADD COLUMN orphan_cleanup_interval_minutes INTEGER NOT NULL DEFAULT 60"
      );
    }
    if (!storageColumns.includes('orphan_cleanup_grace_minutes')) {
      db.exec(
        "ALTER TABLE media_storage_settings ADD COLUMN orphan_cleanup_grace_minutes INTEGER NOT NULL DEFAULT 10"
      );
    }
  } catch (e) {
    console.error('Failed to ensure media_storage_settings schema is up to date:', e);
  }

  // Ensure new messages columns exist on older databases
  try {
    const messageColumns = db
      .prepare('PRAGMA table_info(messages)')
      .all()
      .map((c) => c.name);

    if (!messageColumns.includes('media_position')) {
      db.exec('ALTER TABLE messages ADD COLUMN media_position TEXT');
    }
    if (!messageColumns.includes('updated_at')) {
      db.exec('ALTER TABLE messages ADD COLUMN updated_at DATETIME DEFAULT NULL');
    }

    // This index depends on updated_at, which old databases may not have yet.
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_updated_at ON messages(updated_at)');
  } catch (e) {
    console.error('Failed to ensure messages schema is up to date:', e);
  }

  // Foreign keys were not enforced before this version, so old databases may
  // contain orphan rows. Report them instead of deleting data automatically.
  try {
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      console.warn(
        `[db] Found ${violations.length} foreign key violation(s) left over from previous versions. ` +
          `Run the cleanup migration or remove the orphan rows manually.`
      );
    }
  } catch (e) {
    console.error('Failed to run foreign key check:', e);
  }

  return db;
}

let dbInstance = null;

function getDb() {
  if (!dbInstance) {
    dbInstance = createDb(getDbPath());
  }
  return dbInstance;
}

module.exports = { createDb, getDb, getDbPath, ensureDataDir };