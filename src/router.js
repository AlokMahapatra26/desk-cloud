'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { URL } = require('url');
const { createAuthManager } = require('./auth');
const { executePowerAction } = require('./power');
const {
  listDirectory,
  streamFile,
  createUploadManager,
  createFolder,
  renameItem,
  deleteItem,
  getMimeType,
} = require('./files');
const {
  browseSystemDirs,
  addRoot,
  removeRoot,
  serializeRoots,
} = require('./roots');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function sendJson(res, statusCode, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error('Request body too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        const err = new Error('Invalid JSON body');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, reqPath) {
  const clean = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const safePath = path.resolve(PUBLIC_DIR, clean);
  if (!safePath.startsWith(PUBLIC_DIR + path.sep) && safePath !== PUBLIC_DIR) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const stat = await fsp.stat(safePath);
    if (!stat.isFile()) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    const content = await fsp.readFile(safePath);
    res.writeHead(200, {
      'Content-Type': getMimeType(safePath),
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

function createRequestHandler(config, { tunnelManager, powerRunner } = {}) {
  const auth = createAuthManager(config);
  const uploads = createUploadManager(config.roots);
  const runPower = powerRunner || executePowerAction;

  function requireWritable() {
    if (config.readonly) {
      const err = new Error('Server is running in read-only mode');
      err.statusCode = 403;
      throw err;
    }
  }

  return async function handleRequest(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const query = Object.fromEntries(url.searchParams.entries());

      // Public static assets & UI shell
      if (
        req.method === 'GET' &&
        (pathname === '/' || pathname === '/app.js' || pathname === '/styles.css')
      ) {
        await serveStatic(res, pathname);
        return;
      }

      // Auth status & login/logout endpoints
      if (pathname === '/api/auth/status' && req.method === 'GET') {
        sendJson(res, 200, {
          authEnabled: config.authEnabled,
          authenticated: auth.isAuthenticated(req),
          readonly: config.readonly,
          powerEnabled: Boolean(config.allowPower && !config.readonly && config.authEnabled),
          chunkSizeBytes: config.chunkSizeBytes,
        });
        return;
      }

      if (pathname === '/api/auth/login' && req.method === 'POST') {
        const rate = auth.checkRateLimit(req);
        if (!rate.allowed) {
          sendJson(
            res,
            429,
            { error: `Too many attempts. Try again in ${rate.retryAfterSec}s.` },
            { 'Retry-After': String(rate.retryAfterSec) }
          );
          return;
        }
        const body = await readJsonBody(req);
        if (!auth.verifyPassword(body.password)) {
          auth.recordFailedAttempt(rate.ip);
          sendJson(res, 401, { error: 'Invalid password' });
          return;
        }
        auth.clearAttempts(rate.ip);
        sendJson(
          res,
          200,
          { ok: true },
          { 'Set-Cookie': auth.createSessionCookie(req) }
        );
        return;
      }

      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        sendJson(
          res,
          200,
          { ok: true },
          { 'Set-Cookie': auth.clearSessionCookie() }
        );
        return;
      }

      // All remaining /api/* routes require authentication
      if (pathname.startsWith('/api/')) {
        if (!auth.isAuthenticated(req)) {
          sendJson(res, 401, { error: 'Authentication required' });
          return;
        }

        if (pathname === '/api/roots' && req.method === 'GET') {
          sendJson(res, 200, { roots: serializeRoots(config.roots) });
          return;
        }

        if (pathname === '/api/system/browse' && req.method === 'GET') {
          requireWritable();
          const data = await browseSystemDirs(query.path || '');
          sendJson(res, 200, data);
          return;
        }

        if (pathname === '/api/roots/add' && req.method === 'POST') {
          requireWritable();
          const body = await readJsonBody(req);
          const result = await addRoot(config, body.path, body.name);
          sendJson(res, 200, result);
          return;
        }

        if (pathname === '/api/roots/remove' && req.method === 'POST') {
          requireWritable();
          const body = await readJsonBody(req);
          const result = await removeRoot(config, body.id);
          sendJson(res, 200, result);
          return;
        }

        if (pathname === '/api/tunnel/status' && req.method === 'GET') {
          sendJson(res, 200, tunnelManager ? tunnelManager.getStatus() : { status: 'stopped', url: null, error: null });
          return;
        }

        if (pathname === '/api/tunnel/start' && req.method === 'POST') {
          requireWritable();
          if (!tunnelManager) {
            sendJson(res, 500, { error: 'Tunnel manager unavailable' });
            return;
          }
          const status = await tunnelManager.start();
          sendJson(res, 200, status);
          return;
        }

        if (pathname === '/api/tunnel/stop' && req.method === 'POST') {
          requireWritable();
          if (!tunnelManager) {
            sendJson(res, 500, { error: 'Tunnel manager unavailable' });
            return;
          }
          const status = await tunnelManager.stop();
          sendJson(res, 200, status);
          return;
        }

        if (pathname === '/api/power' && req.method === 'POST') {
          requireWritable();
          if (!config.allowPower) {
            sendJson(res, 403, { error: 'Remote power control is disabled. Start with --allow-power to enable.' });
            return;
          }
          if (!config.authEnabled) {
            sendJson(res, 403, { error: 'Remote power control requires authentication.' });
            return;
          }
          const body = await readJsonBody(req);
          if (!auth.verifyPassword(body.password)) {
            sendJson(res, 401, { error: 'Invalid password confirmation' });
            return;
          }
          const result = await runPower(body.action);
          sendJson(res, 200, result);
          return;
        }

        if (pathname === '/api/list' && req.method === 'GET') {
          if (config.roots.length === 0) {
            sendJson(res, 200, {
              root: null,
              roots: [],
              path: '',
              breadcrumbs: [],
              items: [],
              total: 0,
              page: 1,
              limit: 100,
              totalPages: 1,
            });
            return;
          }
          const data = await listDirectory(config.roots, query);
          sendJson(res, 200, data);
          return;
        }

        if (pathname === '/api/stream' && (req.method === 'GET' || req.method === 'HEAD')) {
          await streamFile(req, res, config.roots, query, { download: false });
          return;
        }

        if (pathname === '/api/download' && (req.method === 'GET' || req.method === 'HEAD')) {
          await streamFile(req, res, config.roots, query, { download: true });
          return;
        }

        if (pathname === '/api/mkdir' && req.method === 'POST') {
          requireWritable();
          const body = await readJsonBody(req);
          const result = await createFolder(config.roots, body);
          sendJson(res, 200, result);
          return;
        }

        if (pathname === '/api/rename' && req.method === 'POST') {
          requireWritable();
          const body = await readJsonBody(req);
          const result = await renameItem(config.roots, body);
          sendJson(res, 200, result);
          return;
        }

        if (pathname === '/api/delete' && req.method === 'POST') {
          requireWritable();
          const body = await readJsonBody(req);
          const result = await deleteItem(config.roots, body);
          sendJson(res, 200, result);
          return;
        }

        if (pathname === '/api/upload/init' && req.method === 'POST') {
          requireWritable();
          const body = await readJsonBody(req);
          const result = await uploads.initUpload(body);
          sendJson(res, 200, result);
          return;
        }

        if (pathname === '/api/upload/chunk' && req.method === 'POST') {
          requireWritable();
          const result = await uploads.receiveChunk(req, query);
          sendJson(res, 200, result);
          return;
        }

        if (pathname === '/api/upload/complete' && req.method === 'POST') {
          requireWritable();
          const body = await readJsonBody(req);
          const result = await uploads.completeUpload(body);
          sendJson(res, 200, result);
          return;
        }

        if (pathname === '/api/upload/cancel' && req.method === 'POST') {
          requireWritable();
          const body = await readJsonBody(req);
          const result = await uploads.cancelUpload(body);
          sendJson(res, 200, result);
          return;
        }

        sendJson(res, 404, { error: 'API endpoint not found' });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const status = err.statusCode || (err.code === 'EEXIST' ? 409 : err.code === 'EACCES' ? 403 : 500);
      if (!res.headersSent) {
        sendJson(res, status, { error: err.message || 'Internal server error' });
      } else {
        res.destroy();
      }
    }
  };
}

module.exports = { createRequestHandler };

