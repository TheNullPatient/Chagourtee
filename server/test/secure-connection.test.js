'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const WebSocket = require('ws');

const {
  buildHttpsRedirectLocation,
  createHttpRedirectServer,
  getSecureConnectionConfig,
} = require('../src/secureConnection');
const {
  createWorkspace,
  getFreePort,
  removeWorkspace,
  startServerOrCleanup,
  useWorkspace,
} = require('./helpers');

const workspace = createWorkspace('secure-connection');
useWorkspace(workspace);

test.after(() => removeWorkspace(workspace));

const opensslAvailable = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;

function request(url, { secure = false } = {}) {
  const transport = secure ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.get(
      url,
      secure ? { rejectUnauthorized: false } : {},
      (res) => {
        res.resume();
        res.on('end', () => resolve(res));
      }
    );
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('request timeout')));
  });
}

test('secure connection is disabled by default', () => {
  assert.deepEqual(getSecureConnectionConfig({}, workspace.dir), { enabled: false });
});

test('secure connection requires certificate paths', () => {
  assert.throws(
    () => getSecureConnectionConfig({ SECURE_CONNECTION: 'true' }, workspace.dir),
    /SSL_KEY_PATH and SSL_CERT_PATH/
  );
});

test('secure connection reports missing certificate files', () => {
  assert.throws(
    () =>
      getSecureConnectionConfig(
        {
          SECURE_CONNECTION: 'true',
          SSL_KEY_PATH: 'nope/key.pem',
          SSL_CERT_PATH: 'nope/cert.pem',
        },
        workspace.dir
      ),
    /SSL_KEY_PATH not found/
  );
});

test('secure connection reads certificates and options', () => {
  const certDir = path.join(workspace.dir, 'certs');
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(path.join(certDir, 'key.pem'), 'KEY-CONTENT');
  fs.writeFileSync(path.join(certDir, 'cert.pem'), 'CERT-CONTENT');
  fs.writeFileSync(path.join(certDir, 'ca.pem'), 'CA-CONTENT');

  const config = getSecureConnectionConfig(
    {
      SECURE_CONNECTION: 'true',
      SSL_KEY_PATH: 'certs/key.pem',
      SSL_CERT_PATH: 'certs/cert.pem',
      SSL_CA_PATH: 'certs/ca.pem',
      HTTP_REDIRECT_PORT: '3080',
      HOST: '0.0.0.0',
    },
    workspace.dir
  );

  assert.equal(config.enabled, true);
  assert.equal(config.tls.key.toString(), 'KEY-CONTENT');
  assert.equal(config.tls.cert.toString(), 'CERT-CONTENT');
  assert.equal(config.tls.ca.toString(), 'CA-CONTENT');
  assert.equal(config.certificates.key, path.join(certDir, 'key.pem'));
  assert.equal(config.redirectPort, 3080);
  assert.equal(config.redirectHost, '0.0.0.0');
});

test('secure connection validates the redirect port', () => {
  const certDir = path.join(workspace.dir, 'certs');
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(path.join(certDir, 'key.pem'), 'KEY');
  fs.writeFileSync(path.join(certDir, 'cert.pem'), 'CERT');

  assert.throws(
    () =>
      getSecureConnectionConfig(
        {
          SECURE_CONNECTION: 'true',
          SSL_KEY_PATH: 'certs/key.pem',
          SSL_CERT_PATH: 'certs/cert.pem',
          HTTP_REDIRECT_PORT: 'not-a-port',
        },
        workspace.dir
      ),
    /HTTP_REDIRECT_PORT/
  );
});

test('redirect locations point at the HTTPS port', () => {
  assert.equal(
    buildHttpsRedirectLocation('chat.example:3000', '/chat?room=1', 3443),
    'https://chat.example:3443/chat?room=1'
  );
  assert.equal(
    buildHttpsRedirectLocation('chat.example:3000', '/api/version', 443),
    'https://chat.example/api/version'
  );
  assert.equal(
    buildHttpsRedirectLocation('[::1]:3000', '/ws', 3443),
    'https://[::1]:3443/ws'
  );
  assert.equal(buildHttpsRedirectLocation('', '/login', 443), 'https://localhost/login');
  assert.equal(buildHttpsRedirectLocation('chat.example', 'login', 443), 'https://chat.example/login');
});

test('plain HTTP server redirects every request permanently', async () => {
  const redirectServer = createHttpRedirectServer({ httpsPort: 3443 });
  await new Promise((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));
  const { port } = redirectServer.address();

  try {
    const response = await request(`http://127.0.0.1:${port}/api/version?check=1`);
    assert.equal(response.statusCode, 308);
    assert.equal(
      response.headers.location,
      `https://127.0.0.1:3443/api/version?check=1`
    );
  } finally {
    await new Promise((resolve) => redirectServer.close(resolve));
  }
});

test(
  'HTTPS serves the API, redirects HTTP and accepts WSS upgrades',
  { skip: opensslAvailable ? false : 'openssl is not available' },
  async () => {
    const certDir = path.join(workspace.dir, 'tls');
    fs.mkdirSync(certDir, { recursive: true });
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');

    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' }
    );

    const redirectPort = await getFreePort();
    const server = await startServerOrCleanup(workspace, {
      secure: true,
      extraEnv: {
        SECURE_CONNECTION: 'true',
        SSL_KEY_PATH: keyPath,
        SSL_CERT_PATH: certPath,
        HTTP_REDIRECT_PORT: String(redirectPort),
      },
    });

    try {
      const versionResponse = await request(`${server.baseUrl}/api/version`, {
        secure: true,
      });
      assert.equal(versionResponse.statusCode, 200);

      const redirectResponse = await request(
        `http://127.0.0.1:${redirectPort}/api/version`
      );
      assert.equal(redirectResponse.statusCode, 308);
      assert.equal(
        redirectResponse.headers.location,
        `https://127.0.0.1:${server.port}/api/version`
      );

      const socketOpened = await new Promise((resolve, reject) => {
        const socket = new WebSocket(`wss://127.0.0.1:${server.port}/ws`, {
          rejectUnauthorized: false,
        });
        const timeout = setTimeout(() => {
          socket.terminate();
          reject(new Error('WSS connection did not open'));
        }, 5000);
        socket.once('open', () => {
          clearTimeout(timeout);
          socket.terminate();
          resolve(true);
        });
        socket.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      assert.equal(socketOpened, true);

      assert.match(server.getOutput(), /Server listening on https port/);
      assert.match(server.getOutput(), /HTTP redirect listening on port/);
    } finally {
      await server.stop();
    }
  }
);
