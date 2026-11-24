import { peerAddress } from '../services/officeNetworks.js';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively strip prototype-pollution keys from parsed JSON payloads and query objects.
 */
export function stripDangerousKeys(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = stripDangerousKeys(value[i], depth + 1);
    }
    return value;
  }
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      delete value[key];
    } else {
      value[key] = stripDangerousKeys(value[key], depth + 1);
    }
  }
  return value;
}

export function sanitizeRequestMiddleware(req, res, next) {
  if (req.body && typeof req.body === 'object') stripDangerousKeys(req.body);
  if (req.query && typeof req.query === 'object') stripDangerousKeys(req.query);
  if (req.params && typeof req.params === 'object') stripDangerousKeys(req.params);
  next();
}

/**
 * OWASP HTTP Security Headers middleware.
 */
export function securityHeadersMiddleware(isProd = process.env.NODE_ENV === 'production') {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com",
    "font-src 'self' data:",
    "connect-src 'self' https://api.ipify.org https://api64.ipify.org",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
    res.setHeader('Content-Security-Policy', csp);
    if (isProd) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    if (req.path?.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
    }
    next();
  };
}

/**
 * Bounded in-memory sliding-window rate limiter keyed by direct socket peer IP (never spoofable X-Forwarded-For).
 */
export function createRateLimiter({ windowMs = 60_000, max = 600, maxBuckets = 10_000, message = 'Too many requests. Please slow down and try again.' } = {}) {
  const buckets = new Map();

  const prune = (now) => {
    for (const [key, entry] of buckets.entries()) {
      if (now - entry.windowStart >= windowMs) buckets.delete(key);
    }
    while (buckets.size > maxBuckets) {
      const oldestKey = buckets.keys().next().value;
      buckets.delete(oldestKey);
    }
  };

  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size > maxBuckets * 0.9) prune(now);

    const ip = peerAddress(req) || '127.0.0.1';
    let entry = buckets.get(ip);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 0, windowStart: now };
      buckets.set(ip, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - entry.windowStart)) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        success: false,
        error: message,
      });
    }
    next();
  };
}
