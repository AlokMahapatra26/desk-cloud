'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');
const { createAuthManager } = require('./auth');
const { executePowerAction } = require('./power');
const { serveThumbnail } = require('./thumb');
const { getSystemStats } = require('./sysinfo');
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

function sendCompressed(req, res, statusCode, contentType, rawBuf, extraHeaders = {}) {
  const acceptEnc = String(req?.headers?.['accept-encoding'] || '');
  if (rawBuf.length >= 512 && acceptEnc.includes('gzip')) {
    const gz = zlib.gzipSync(rawBuf, { level: 6 });
    res.writeHead(statusCode, {
      'Content-Type': contentType,
      'Content-Encoding': 'gzip',
      'Vary': 'Accept-Encoding',
      'Content-Length': gz.length,
      ...extraHeaders,
    });
    res.end(gz);
    return;
  }
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': rawBuf.length,
    ...extraHeaders,
  });
  res.end(rawBuf);
}

function sendJson(res, statusCode, data, extraHeaders = {}, req = null) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  sendCompressed(req, res, statusCode, 'application/json; charset=utf-8', body, extraHeaders);
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

async function serveStatic(res, reqPath, req) {
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
    sendCompressed(req, res, 200, getMimeType(safePath), content, {
      'Cache-Control': 'no-cache',
    });
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
        await serveStatic(res, pathname, req);
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

        if (pathname === '/api/system/stats' && req.method === 'GET') {
          const stats = await getSystemStats();
          sendJson(res, 200, stats, {}, req);
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
          sendJson(res, 200, data, {}, req);
          return;
        }

        if (pathname === '/api/stream' && (req.method === 'GET' || req.method === 'HEAD')) {
          await streamFile(req, res, config.roots, query, { download: false });
          return;
        }

        if (pathname === '/api/thumb' && req.method === 'GET') {
          await serveThumbnail(req, res, config.roots, query);
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

