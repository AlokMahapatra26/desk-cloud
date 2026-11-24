'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'storage_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Create an auth manager using HMAC-SHA256 signed HTTP-only cookies and
 * IP-based login rate limiting.
 */
function createAuthManager({ authEnabled, password, sessionSecret }) {
  const passwordHash = authEnabled
    ? crypto.createHash('sha256').update(String(password)).digest()
    : null;

  // Map<ip, { count: number, resetAt: number }>
  const attempts = new Map();
  const MAX_ATTEMPTS = 12;
  const WINDOW_MS = 60 * 1000;

  function verifyPassword(candidate) {
    if (!authEnabled) return true;
    if (typeof candidate !== 'string') return false;
    const candidateHash = crypto.createHash('sha256').update(candidate).digest();
    return crypto.timingSafeEqual(candidateHash, passwordHash);
  }

  function signToken(payloadObj) {
    const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
    const sig = crypto
      .createHmac('sha256', sessionSecret)
      .update(payload)
      .digest('base64url');
    return `${payload}.${sig}`;
  }

  function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expectedSig = crypto
      .createHmac('sha256', sessionSecret)
      .update(payload)
      .digest('base64url');

    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!data.exp || Date.now() > data.exp) return null;
      return data;
    } catch {
      return null;
    }
  }

  function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (key) out[key] = decodeURIComponent(val);
    }
    return out;
  }

  function isAuthenticated(req) {
    if (!authEnabled) return true;
    const cookies = parseCookies(req);
    return verifyToken(cookies[COOKIE_NAME]) !== null;
  }

  function createSessionCookie(req) {
    const token = signToken({
      iat: Date.now(),
      exp: Date.now() + SESSION_TTL_MS,
    });
    const isHttps =
      req.socket.encrypted ||
      req.headers['x-forwarded-proto'] === 'https';
    const parts = [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (isHttps) parts.push('Secure');
    return parts.join('; ');
  }

  function clearSessionCookie() {
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }

  function getClientIp(req) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim();
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
  }

  function checkRateLimit(req) {
    const ip = getClientIp(req);
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || now > entry.resetAt) {
      return { allowed: true, ip };
    }
    if (entry.count >= MAX_ATTEMPTS) {
      return {
        allowed: false,
        retryAfterSec: Math.ceil((entry.resetAt - now) / 1000),
      };
    }
    return { allowed: true, ip };
  }

  function recordFailedAttempt(ip) {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || now > entry.resetAt) {
      attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      entry.count += 1;
    }
  }

  function clearAttempts(ip) {
    attempts.delete(ip);
  }

  return {
    verifyPassword,
    isAuthenticated,
    createSessionCookie,
    clearSessionCookie,
    checkRateLimit,
    recordFailedAttempt,
    clearAttempts,
  };
}

module.exports = { createAuthManager, COOKIE_NAME };

