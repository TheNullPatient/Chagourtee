'use strict';

/**
 * Shared helpers for the server integration tests.
 *
 * Every test works in its own temporary directory: a fresh SQLite database and
 * an isolated media directory. The real server/data files are never touched.
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER_ROOT = path.join(ROOT, 'server');

function createWorkspace(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `chagourtee-${prefix}-`));
  const dbPath = path.join(dir, 'test.db');
  const mediaDir = path.join(dir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  return { dir, dbPath, mediaDir };
}

/**
 * Point the server modules at the workspace. Must run before src/db,
 * src/media or src/dataCleanup are required, because they read the paths when
 * they are loaded.
 */
function useWorkspace(workspace, { encryptionKey = 'aa'.repeat(32) } = {}) {
  process.env.CHAGOURTEE_DB_PATH = workspace.dbPath;
  process.env.CHAGOURTEE_MEDIA_DIR = workspace.mediaDir;
  process.env.CHAGOURTEE_MEDIA_ENCRYPTION_KEY = encryptionKey;
}

function removeWorkspace(workspace) {
  fs.rmSync(workspace.dir, { recursive: true, force: true });
}

/**
 * Collects check results so a failed assertion does not hide the remaining
 * checks. Call verify() at the end of the test to fail with the full list.
 */
function createChecker() {
  const failures = [];

  function check(name, condition, extra = '') {
    if (!condition) {
      failures.push(extra ? `${name} — ${extra}` : name);
    }
    return Boolean(condition);
  }

  function verify() {
    assert.deepEqual(failures, [], `${failures.length} check(s) failed`);
  }

  return { check, verify, failures };
}

function seedUser(db, login, { role = 'member', verified = 1, passwordHash = 'x' } = {}) {
  const result = db
    .prepare(
      'INSERT INTO users (login, password_hash, role, verified) VALUES (?, ?, ?, ?)'
    )
    .run(login, passwordHash, role, verified ? 1 : 0);
  return Number(result.lastInsertRowid);
}

function unique(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Starts the real server entry point against the workspace database.
 */
async function startServer(workspace, { extraEnv = {} } = {}) {
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.join(SERVER_ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHAGOURTEE_DB_PATH: workspace.dbPath,
      CHAGOURTEE_MEDIA_DIR: workspace.mediaDir,
      CHAGOURTEE_MEDIA_ENCRYPTION_KEY: 'aa'.repeat(32),
      CHAGOURTEE_LOG_TO_FILE: 'false',
      DEBUG_MODE: 'false',
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before becoming ready:\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/version`);
      if (response.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`Server did not start within 20s:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timeout);
    }
    return output;
  }

  return { child, baseUrl, port, stop, getOutput: () => output };
}

/**
 * startServer() that also removes the workspace when startup fails.
 */
async function startServerOrCleanup(workspace, options) {
  try {
    return await startServer(workspace, options);
  } catch (error) {
    removeWorkspace(workspace);
    throw error;
  }
}

module.exports = {
  ROOT,
  SERVER_ROOT,
  createChecker,
  createWorkspace,
  getFreePort,
  removeWorkspace,
  seedUser,
  startServer,
  startServerOrCleanup,
  unique,
  useWorkspace,
};
