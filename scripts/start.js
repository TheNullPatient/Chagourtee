#!/usr/bin/env node
/**
 * Root-level start script that checks if builds exist and prompts if needed
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const CLIENT_DIST = path.join(ROOT, 'client', 'dist');
const SERVER_DIST = path.join(ROOT, 'server', 'dist');
const SERVER_SRC = path.join(ROOT, 'server', 'src', 'index.js');

function hasClientBuild() {
  return fs.existsSync(CLIENT_DIST) && fs.existsSync(path.join(CLIENT_DIST, 'index.html'));
}

function hasServerBuild() {
  return fs.existsSync(path.join(SERVER_DIST, 'index.js'));
}

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans);
  }));
}

async function promptBuild() {
  console.log('⚠️  No production build found!');
  console.log('   Would you like to build now? (Y/n)');
  
  const answer = await askQuestion('> ');
  
  if (answer.toLowerCase() === 'n') {
    console.log('❌ Build cancelled. Exiting...');
    console.log('   To build later, run: npm run build');
    process.exit(0);
  }
  
  console.log('\n🔨 Building client and server...');
  const buildResult = spawnSync('npm', ['run', 'build'], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  
  if (buildResult.status !== 0) {
    console.error('❌ Build failed!');
    process.exit(1);
  }
  
  console.log('✅ Build completed!\n');
}

async function startServer() {
  console.log('🚀 Starting server...');
  
  const server = spawn('npm', ['run', 'start:prod'], {
    stdio: 'inherit',
    cwd: path.join(ROOT, 'server'),
    shell: process.platform === 'win32',
  });
  
  server.on('close', (code) => {
    console.log(`Server process exited with code ${code}`);
    process.exit(code);
  });
  
  return server;
}

async function startClient() {
  console.log('🌐 Starting client preview...');
  
  const client = spawn('npm', ['run', 'preview'], {
    stdio: 'inherit',
    cwd: path.join(ROOT, 'client'),
    shell: process.platform === 'win32',
  });
  
  client.on('close', (code) => {
    console.log(`Client process exited with code ${code}`);
  });
  
  return client;
}

async function main() {
  const hasClient = hasClientBuild();
  const hasServer = hasServerBuild();
  
  if (!hasClient || !hasServer) {
    await promptBuild();
  }
  
  // Start both server and client
  const processes = [];
  
  // Start server
  const server = await startServer();
  processes.push(server);
  
  // Start client preview if it has a build
  if (hasClientBuild()) {
    await new Promise(resolve => setTimeout(resolve, 1000)); // Give server time to start
    const client = await startClient();
    processes.push(client);
  }
  
  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');
    processes.forEach(p => {
      if (p.pid) {
        try {
          process.kill(-p.pid);
        } catch (e) {
          // Process already exited
        }
      }
    });
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
