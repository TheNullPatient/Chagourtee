'use strict';

/**
 * HTTPS/WSS support.
 *
 * When SECURE_CONNECTION=true the main Fastify server is created with the
 * provided certificate, so both HTTP and WebSocket traffic are served over
 * TLS (WSS is transparent for the `ws` library). A small plain HTTP server is
 * started on a separate port and permanently redirects visitors to HTTPS.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

// Works both from server/src and from the bundled server/dist/index.js.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function envValue(env, name) {
  return env[`CHAGOURTEE_${name}`] ?? env[name];
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535 (got "${value}")`);
  }
  return port;
}

function resolveCertificatePath(value, baseDir) {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function readCertificate(label, value, baseDir) {
  const resolved = resolveCertificatePath(value, baseDir);
  if (!fs.existsSync(resolved)) {
    throw new Error(`${label} not found: ${resolved}`);
  }
  return { path: resolved, content: fs.readFileSync(resolved) };
}

/**
 * Reads and validates the HTTPS configuration. Returns `{ enabled: false }`
 * when SECURE_CONNECTION is off. Throws a descriptive error for incomplete or
 * unreadable certificate configuration.
 */
function getSecureConnectionConfig(env = process.env, baseDir = PROJECT_ROOT) {
  if (!isEnabled(envValue(env, 'SECURE_CONNECTION'))) {
    return { enabled: false };
  }

  const keyPath = envValue(env, 'SSL_KEY_PATH');
  const certPath = envValue(env, 'SSL_CERT_PATH');
  const caPath = envValue(env, 'SSL_CA_PATH');

  if (!keyPath || !certPath) {
    throw new Error(
      'SECURE_CONNECTION is enabled, but SSL_KEY_PATH and SSL_CERT_PATH are not set'
    );
  }

  const key = readCertificate('SSL_KEY_PATH', keyPath, baseDir);
  const cert = readCertificate('SSL_CERT_PATH', certPath, baseDir);
  const tls = { key: key.content, cert: cert.content };
  if (caPath) {
    tls.ca = readCertificate('SSL_CA_PATH', caPath, baseDir).content;
  }

  const redirectPortValue = envValue(env, 'HTTP_REDIRECT_PORT');

  return {
    enabled: true,
    tls,
    certificates: { key: key.path, cert: cert.path },
    // Empty when the redirect port should default to the HTTPS port + 1.
    redirectPort:
      redirectPortValue === undefined || redirectPortValue === ''
        ? null
        : parsePort(redirectPortValue, 'HTTP_REDIRECT_PORT'),
    redirectHost:
      envValue(env, 'HTTP_REDIRECT_HOST') || env.HOST || '0.0.0.0',
  };
}

function getHostname(hostHeader) {
  const host = String(hostHeader || '').trim();
  if (!host) return 'localhost';

  // Keep IPv6 literals in brackets, e.g. [::1]:3000 -> [::1].
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }

  return host.split(':')[0] || 'localhost';
}

/**
 * Builds the HTTPS URL used in the redirect Location header. The incoming
 * port is intentionally dropped: the redirect must point at the HTTPS port,
 * not at the plain HTTP one.
 */
function buildHttpsRedirectLocation(hostHeader, url, httpsPort) {
  const port = Number(httpsPort) || 443;
  const portSuffix = port === 443 ? '' : `:${port}`;
  const requestPath = url && url.startsWith('/') ? url : `/${url || ''}`;
  return `https://${getHostname(hostHeader)}${portSuffix}${requestPath}`;
}

/**
 * Plain HTTP server that answers every request with a permanent redirect to
 * the HTTPS address of the same host.
 */
function createHttpRedirectServer({ httpsPort = 443 } = {}) {
  return http.createServer((req, res) => {
    const location = buildHttpsRedirectLocation(req.headers.host, req.url, httpsPort);
    res.writeHead(308, {
      Location: location,
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end(`Redirecting to ${location}\n`);
  });
}

module.exports = {
  buildHttpsRedirectLocation,
  createHttpRedirectServer,
  getSecureConnectionConfig,
};
