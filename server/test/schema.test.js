'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { ROOT, createChecker, createWorkspace, removeWorkspace } = require('./helpers');

const UPDATE_SCHEMA = path.join(ROOT, 'server', 'scripts', 'update-schema.js');
const serverPackage = require('../package.json');

function runUpdateSchema(dbPath) {
  try {
    const output = execFileSync(process.execPath, [UPDATE_SCHEMA], {
      env: {
        ...process.env,
        CHAGOURTEE_DB_PATH: dbPath,
        DEBUG_MODE: 'false',
      },
      encoding: 'utf8',
    });
    return { status: 0, output };
  } catch (error) {
    return {
      status: error.status ?? 1,
      output: `${error.stdout || ''}${error.stderr || ''}`,
    };
  }
}

function createOutdatedSchema(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      verified INTEGER NOT NULL DEFAULT 0,
      codeword_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE room_unlocks (
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (room_id, user_id)
    );
  `);
  db.close();
}

function inspect(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    const columns = (table) =>
      db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);

    return {
      tables,
      indexes,
      messageColumns: columns('messages'),
      roomColumns: columns('rooms'),
      unlockColumns: tables.includes('room_unlocks') ? columns('room_unlocks') : [],
      userColumns: columns('users'),
      verificationColumns: columns('verification_settings'),
      mediaColumns: tables.includes('media_files') ? columns('media_files') : [],
      storageColumns: tables.includes('media_storage_settings')
        ? columns('media_storage_settings')
        : [],
      violations: db.prepare('PRAGMA foreign_key_check').all(),
    };
  } finally {
    db.close();
  }
}

test('update-schema migrates an outdated database in place', () => {
  const workspace = createWorkspace('schema');
  const { check, verify } = createChecker();

  try {
    createOutdatedSchema(workspace.dbPath);

    // The npm aliases must keep pointing at the working migration script.
    check(
      'db:update-schema runs the migration script',
      serverPackage.scripts['db:update-schema'] === 'node scripts/update-schema.js',
      serverPackage.scripts['db:update-schema']
    );
    check(
      'db:add-media-table runs the migration script',
      serverPackage.scripts['db:add-media-table'] === 'node scripts/update-schema.js',
      serverPackage.scripts['db:add-media-table']
    );

    const first = runUpdateSchema(workspace.dbPath);
    check('update-schema exits successfully', first.status === 0, first.output);
    check('update-schema reports success', /up to date/.test(first.output), first.output);
    check('update-schema uses CHAGOURTEE_DB_PATH', first.output.includes(workspace.dbPath), first.output);

    const state = inspect(workspace.dbPath);
    for (const table of [
      'sessions',
      'invites',
      'verification_settings',
      'verification_codes',
      'server_settings',
      'message_reads',
      'media_files',
      'media_storage_settings',
      'room_members',
      'room_unlocks',
    ]) {
      check(`creates the ${table} table`, state.tables.includes(table));
    }

    check('adds messages.updated_at', state.messageColumns.includes('updated_at'));
    check('adds messages.media_position', state.messageColumns.includes('media_position'));
    check(
      'adds room access columns',
      state.roomColumns.includes('access_level') && state.roomColumns.includes('password_hash')
    );
    check(
      'adds room unlock expiry columns',
      state.unlockColumns.includes('expires_at') && state.unlockColumns.includes('ephemeral')
    );
    check(
      'adds users.registration_comment',
      state.userColumns.includes('registration_comment')
    );
    check(
      'adds verification_settings.delete_comment_on_approve',
      state.verificationColumns.includes('delete_comment_on_approve')
    );
    check(
      'adds the media transcode columns',
      ['transcoded_filename', 'transcoded_mime_type', 'transcoded_created_at'].every((column) =>
        state.mediaColumns.includes(column)
      )
    );
    check(
      'adds the media storage columns',
      [
        'max_file_size',
        'max_storage_size',
        'cleanup_strategy',
        'orphan_cleanup_enabled',
      ].every((column) => state.storageColumns.includes(column))
    );
    check('creates the updated_at index', state.indexes.includes('idx_messages_updated_at'));
    check('creates the message_reads index', state.indexes.includes('idx_message_reads_user_id'));
    check(
      'creates the room access indexes',
      state.indexes.includes('idx_room_members_user_id') &&
        state.indexes.includes('idx_room_unlocks_user_id')
    );
    check(
      'creates the verification code lookup index',
      state.indexes.includes('idx_verification_codes_hash')
    );
    check(
      'creates the media indexes',
      state.indexes.includes('idx_media_files_message_id') &&
        state.indexes.includes('idx_media_files_uploaded_by')
    );
    check('leaves no foreign key violations', state.violations.length === 0, JSON.stringify(state.violations));

    const second = runUpdateSchema(workspace.dbPath);
    check('update-schema is idempotent', second.status === 0, second.output);

    // Sanity check: the migration actually writes to the workspace file.
    assert.ok(fs.statSync(workspace.dbPath).size > 0);
  } finally {
    removeWorkspace(workspace);
  }

  verify();
});
