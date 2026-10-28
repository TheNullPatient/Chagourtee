#!/usr/bin/env node
/**
 * Daemon manager for background process control (production builds only)
 * Supports: start, stop, restart, status
 * Stores PID file in server/data/chagourtee.pid
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER_ROOT = path.join(ROOT, 'server');
const CLIENT_ROOT = path.join(ROOT, 'client');
const DATA_DIR = path.join(SERVER_ROOT, 'data');
const PID_FILE_SERVER = path.join(DATA_DIR, 'chagourtee-server.pid');
const PID_FILE_CLIENT = path.join(DATA_DIR, 'chagourtee-client.pid');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'chagourtee.log');

const SERVER_DIST = path.join(SERVER_ROOT, 'dist', 'index.js');
const CLIENT_DIST = path.join(CLIENT_ROOT, 'dist', 'index.html');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Load .env files (simple parser, no dotenv dependency)
function loadEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();
    // Remove quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const rootEnv = loadEnv(path.join(ROOT, '.env'));
const serverEnv = loadEnv(path.join(SERVER_ROOT, '.env'));
// server/.env overrides root/.env
const loadedEnv = { ...rootEnv, ...serverEnv };

// Build clean environment for child processes
// Start with process.env, then override with loaded .env values
const daemonEnv = { ...process.env, ...loadedEnv };

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Read PID file and return process ID or null
 */
function readPidFile(pidFile) {
  if (!fs.existsSync(pidFile)) {
    return null;
  }
  
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (isNaN(pid)) {
      return null;
    }
    return pid;
  } catch (err) {
    return null;
  }
}

/**
 * Check if a process is running by PID
 */
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Check if a port is in use
 */
function isPortInUse(port) {
  try {
    const result = execSync(`lsof -i :${port} -t 2>/dev/null`, { encoding: 'utf8' }).trim();
    return result.length > 0;
  } catch (err) {
    return false;
  }
}

/**
 * Get process status
 */
function getProcessStatus(pidFile, name, checkPort) {
  if (checkPort) {
    // Port-based detection (for client preview)
    if (isPortInUse(checkPort)) {
      // Ensure sentinel file exists
      if (!fs.existsSync(pidFile)) {
        fs.writeFileSync(pidFile, 'running-by-port');
      }
      return { running: true, pid: null, message: `✅ ${name} is running (port ${checkPort})` };
    }
    // Port not in use, clean up sentinel
    if (fs.existsSync(pidFile)) {
      try { fs.unlinkSync(pidFile); } catch (err) {}
    }
    return { running: false, pid: null, message: `⚠️  ${name} is not running` };
  }
  
  // PID-based detection (for server)
  const pid = readPidFile(pidFile);
  
  if (!pid) {
    return { running: false, pid: null, message: `⚠️  ${name} is not running` };
  }
  
  if (isProcessRunning(pid)) {
    return { running: true, pid, message: `✅ ${name} is running (PID: ${pid})` };
  } else {
    try { fs.unlinkSync(pidFile); } catch (err) {}
    return { running: false, pid: null, message: `⚠️  ${name} is not running (stale PID removed)` };
  }
}

/**
 * Check if builds exist
 */
function hasBuilds() {
  const hasServer = fs.existsSync(SERVER_DIST);
  const hasClient = fs.existsSync(CLIENT_DIST);
  return { hasServer, hasClient, ok: hasServer && hasClient };
}

/**
 * Start server in background
 */
function startServer() {
  const status = getProcessStatus(PID_FILE_SERVER, 'Server');
  
  if (status.running) {
    console.log(status.message);
    return;
  }
  
  console.log('🚀 Starting server in background...');
  
  // Redirect to /dev/null — the server's own logger handles file output
  // when CHAGOURTEE_LOG_TO_FILE=true. 'inherit' leaks to terminal.
  const devNull = fs.openSync('/dev/null', 'a');
  
  const child = spawn(process.execPath, [SERVER_DIST], {
    cwd: SERVER_ROOT,
    stdio: ['ignore', devNull, devNull],
    detached: true,
    env: { ...daemonEnv, NODE_ENV: 'production' },
  });
  
  child.unref();
  
  fs.writeFileSync(PID_FILE_SERVER, String(child.pid));
  console.log(`✅ Server started in background (PID: ${child.pid})`);
}

/**
 * Start client in background
 */
function startClient() {
  // Check if client is already running by port
  if (isPortInUse(4173)) {
    console.log('✅ Client is already running (port 4173 in use)');
    fs.writeFileSync(PID_FILE_CLIENT, 'running-by-port');
    return;
  }
  
  console.log('🌐 Starting client preview in background...');
  
  // Spawn a shell that runs npm run preview in the background with nohup
  // Redirect to client.log since we can't intercept its console from a separate process
  const CLIENT_LOG = path.join(LOG_DIR, 'client.log');
  const clientLogOut = fs.openSync(CLIENT_LOG, 'a');
  const clientLogErr = fs.openSync(CLIENT_LOG, 'a');

  const child = spawn('bash', ['-c',
    `cd "${CLIENT_ROOT}" && nohup npm run preview >> "${CLIENT_LOG}" 2>&1 &`
  ], {
    stdio: ['ignore', clientLogOut, clientLogErr],
    detached: true,
  });
  
  child.unref();
  
  // Store a marker file since we can't reliably track the npm PID
  fs.writeFileSync(PID_FILE_CLIENT, 'running-by-port');
  console.log('✅ Client started in background');
}

/**
 * Stop a process by PID file (server) or by port (client)
 */
async function stopProcess(pidFile, name, killPort) {
  if (killPort) {
    // Port-based stop for client — kill only the npm process group, NOT all processes on the port
    if (!isPortInUse(killPort)) {
      if (fs.existsSync(pidFile)) {
        try { fs.unlinkSync(pidFile); } catch (err) {}
      }
      console.log(`✅ ${name} was not running (port ${killPort} is free)`);
      return;
    }
    
    // Read the npm PID from the file
    const content = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : null;
    
    if (!content || content === 'running-by-port') {
      // Fallback: find npm process on this port
      console.log(`🛑 Stopping ${name} (port ${killPort})...`);
      try {
        const pids = execSync(`lsof -ti :${killPort} 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (pids) {
          // Only kill npm/node processes, not browser connections
          // Filter to only node/npm processes
          pids.split('\n').forEach(pid => {
            try {
              const cmd = execSync(`ps -o comm= -p ${pid} 2>/dev/null`, { encoding: 'utf8' }).trim();
              if (cmd.includes('node') || cmd.includes('npm')) {
                process.kill(parseInt(pid), 'SIGTERM');
              }
            } catch (err) {}
          });
        }
        
        let attempts = 0;
        while (attempts < 30) {
          if (!isPortInUse(killPort)) break;
          await sleep(500);
          attempts++;
        }
        
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
        if (isPortInUse(killPort)) {
          console.log(`⚠️  ${name} is still shutting down...`);
        } else {
          console.log(`✅ ${name} stopped`);
        }
      } catch (err) {
        console.error(`❌ Failed to stop ${name}: ${err.message}`);
      }
      return;
    }
    
    // We have a specific npm PID — kill it and its process group
    const npmPid = parseInt(content.replace('pgid:', ''), 10);
    console.log(`🛑 Stopping ${name} (npm PID: ${npmPid})...`);
    
    try {
      // Send SIGTERM to the npm process (it will propagate to children)
      process.kill(npmPid, 'SIGTERM');
      
      let attempts = 0;
      while (attempts < 30) {
        if (!isPortInUse(killPort) || !isProcessRunning(npmPid)) break;
        await sleep(500);
        attempts++;
      }
      
      if (isProcessRunning(npmPid) || isPortInUse(killPort)) {
        // Still running, send SIGTERM to process group
        try { process.kill(-npmPid, 'SIGTERM'); } catch (err) {}
        
        attempts = 0;
        while (attempts < 10) {
          if (!isPortInUse(killPort)) break;
          await sleep(500);
          attempts++;
        }
      }
      
      // Don't SIGKILL — let Vite shut down gracefully for browsers
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      if (isPortInUse(killPort)) {
        console.log(`⚠️  ${name} is still shutting down...`);
      } else {
        console.log(`✅ ${name} stopped`);
      }
    } catch (err) {
      if (err.code === 'ESRCH') {
        // Process already gone
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      } else {
        console.error(`❌ Failed to stop ${name}: ${err.message}`);
      }
    }
    return;
  }
  
  // PID-based stop (for server)
  const status = getProcessStatus(pidFile, name);
  
  if (!status.running) {
    return;
  }
  
  console.log(`🛑 Stopping ${name} (PID: ${status.pid})...`);
  
  try {
    process.kill(status.pid, 'SIGTERM');
    
    let attempts = 0;
    while (attempts < 10) {
      if (!isProcessRunning(status.pid)) break;
      await sleep(500);
      attempts++;
    }
    
    if (isProcessRunning(status.pid)) {
      console.log(`⚠️  ${name} did not exit gracefully, force killing...`);
      process.kill(status.pid, 'SIGKILL');
    }
    
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    console.log(`✅ ${name} stopped`);
  } catch (err) {
    if (err.code === 'ESRCH') {
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    } else {
      console.error(`❌ Failed to stop ${name}: ${err.message}`);
    }
  }
}

/**
 * Show full status
 */
function showStatus() {
  const builds = hasBuilds();
  
  console.log('📋 Chagourtee Status');
  console.log('━'.repeat(40));
  
  if (!builds.hasServer) {
    console.log('⚠️  Server build not found. Run: npm run build:server');
  }
  if (!builds.hasClient) {
    console.log('⚠️  Client build not found. Run: npm run build:client');
  }
  console.log('');
  
  const serverStatus = getProcessStatus(PID_FILE_SERVER, 'Server');
  const clientStatus = getProcessStatus(PID_FILE_CLIENT, 'Client', 4173);
  
  console.log(serverStatus.message);
  if (serverStatus.running && serverStatus.pid) {
    try {
      const psOutput = execSync(`ps -o etime= -p ${serverStatus.pid}`).toString().trim();
      console.log(`   ⏱️  Uptime: ${psOutput}`);
    } catch (err) {}
  }
  console.log('');
  
  console.log(clientStatus.message);
  if (clientStatus.running && clientStatus.pid) {
    try {
      const psOutput = execSync(`ps -o etime= -p ${clientStatus.pid}`).toString().trim();
      console.log(`   ⏱️  Uptime: ${psOutput}`);
    } catch (err) {}
  }
  console.log('');
  
  if (fs.existsSync(LOG_FILE)) {
    const stats = fs.statSync(LOG_FILE);
    console.log(`📄 Log file: ${LOG_FILE} (${(stats.size / 1024).toFixed(1)} KB)`);
  }
}

/**
 * Main
 */
async function main() {
  const command = process.argv[2];
  
  switch (command) {
    case 'start':
      {
        const builds = hasBuilds();
        if (!builds.ok) {
          console.log('⚠️  Production builds not found!');
          console.log('   Run: npm run build');
          process.exit(1);
        }
        startServer();
        startClient();
        // Exit — child processes are detached and unref'd
        process.exit(0);
      }
      break;
    case 'stop':
      // Stop client first, then server
      await stopProcess(PID_FILE_CLIENT, 'Client', 4173);
      await stopProcess(PID_FILE_SERVER, 'Server');
      process.exit(0);
      break;
    case 'restart':
      await stopProcess(PID_FILE_CLIENT, 'Client', 4173);
      await stopProcess(PID_FILE_SERVER, 'Server');
      // Give ports time to free
      setTimeout(() => {
        const builds = hasBuilds();
        if (!builds.ok) {
          console.log('⚠️  Production builds not found!');
          console.log('   Run: npm run build');
          process.exit(1);
        }
        startServer();
        startClient();
        process.exit(0);
      }, 1500);
      break;
    case 'status':
      showStatus();
      process.exit(0);
      break;
    default:
      console.log('📋 Chagourtee Daemon Manager (production builds only)');
      console.log('');
      console.log('Usage:');
      console.log('  npm run daemon:start   - Start server + client in background');
      console.log('  npm run daemon:stop    - Stop running processes');
      console.log('  npm run daemon:restart - Restart both');
      console.log('  npm run daemon:status  - Check status');
      console.log('');
      console.log('Requirements:');
      console.log('  Run "npm run build" first to create production builds');
      console.log('');
      console.log('Examples:');
      console.log('  npm run daemon:start');
      console.log('  tail -f logs/chagourtee.log');
      console.log('  npm run daemon:stop');
      process.exit(0);
      break;
  }
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
