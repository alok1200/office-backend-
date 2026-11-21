import crypto from 'crypto';

// Rate limiter store in memory: ip/identifier -> { count, firstAttempt }
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes window

/**
 * Hash password with PBKDF2 using Node.js crypto
 */
export function hashPassword(password, salt = null) {
  const generatedSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, generatedSalt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt: generatedSalt };
}

/**
 * Verify password with constant-time comparison
 */
export function verifyPassword(password, storedHash, storedSalt) {
  if (!password || !storedHash || !storedSalt) return false;
  try {
    const computedHash = crypto.pbkdf2Sync(password, storedSalt, 100000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch (err) {
    return false;
  }
}

/**
 * Check and record login rate limiting
 */
export function checkRateLimit(key) {
  const now = Date.now();
  const record = loginAttempts.get(key);

  if (!record) {
    return { allowed: true, remaining: MAX_ATTEMPTS - 1 };
  }

  // Reset window if expired
  if (now - record.firstAttempt > WINDOW_MS) {
    loginAttempts.delete(key);
    return { allowed: true, remaining: MAX_ATTEMPTS - 1 };
  }

  if (record.count >= MAX_ATTEMPTS) {
    const minutesLeft = Math.ceil((WINDOW_MS - (now - record.firstAttempt)) / 60000);
    return { allowed: false, minutesLeft };
  }

  return { allowed: true, remaining: MAX_ATTEMPTS - record.count };
}

export function recordFailedAttempt(key) {
  const now = Date.now();
  const record = loginAttempts.get(key) || { count: 0, firstAttempt: now };
  record.count += 1;
  loginAttempts.set(key, record);
}

export function resetRateLimit(key) {
  loginAttempts.delete(key);
}

export function clearRateLimitForIdentifiers(identifiers = []) {
  const suffixes = identifiers.filter(Boolean).map(v => `:${String(v).trim().toLowerCase()}`);
  if (!suffixes.length) return;
  for (const key of loginAttempts.keys()) {
    if (suffixes.some(suffix => key.endsWith(suffix))) loginAttempts.delete(key);
  }
}

// ============================================================================
// JSON Web Token (JWT - RFC 7519 HS256) Authentication & Revocation
// ============================================================================
const JWT_ISSUER = 'knooviq-attendance';
const DEFAULT_JWT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

function getJwtSecret() {
  const secret = process.env.JWT_SECRET || process.env.DATABASE_URL || 'knooviq-jwt-dev-secret-change-in-production';
  return crypto.createHash('sha256').update(secret).digest();
}

function getJwtTtlSeconds() {
  const raw = Number(process.env.JWT_EXPIRES_IN_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_JWT_TTL_SECONDS;
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecodeJson(segment) {
  const json = Buffer.from(segment, 'base64url').toString('utf8');
  return JSON.parse(json);
}

// Revocation stores (for instant logout, password reset, and deactivation invalidation)
const revokedTokenJtis = new Map(); // jti -> expMs
const issuedUserJtis = new Map(); // userId -> Set<jti>
const userRevokedBefore = new Map(); // userId -> timestampMs

function pruneRevokedTokens(nowMs = Date.now()) {
  for (const [jti, expMs] of revokedTokenJtis.entries()) {
    if (expMs <= nowMs) revokedTokenJtis.delete(jti);
  }
}

export function signJwt(payload, options = {}) {
  const nowMs = Date.now();
  const iat = Math.floor(nowMs / 1000);
  const ttlSeconds = Number.isFinite(options.expiresInSeconds) && options.expiresInSeconds > 0
    ? Math.floor(options.expiresInSeconds)
    : getJwtTtlSeconds();
  const exp = iat + ttlSeconds;
  const jti = options.jti || crypto.randomUUID();

  const header = { alg: 'HS256', typ: 'JWT' };
  const fullPayload = {
    ...payload,
    iss: JWT_ISSUER,
    jti,
    iat,
    iat_ms: nowMs,
    exp,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac('sha256', getJwtSecret())
    .update(signingInput)
    .digest('base64url');

  return { token: `${signingInput}.${signature}`, payload: fullPayload, expiresAt: exp * 1000 };
}

export function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

  try {
    const header = base64UrlDecodeJson(encodedHeader);
    if (header?.alg !== 'HS256' || header?.typ !== 'JWT') return null;

    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const expectedSig = crypto
      .createHmac('sha256', getJwtSecret())
      .update(signingInput)
      .digest();
    const providedSig = Buffer.from(encodedSignature, 'base64url');
    if (providedSig.length !== expectedSig.length || !crypto.timingSafeEqual(providedSig, expectedSig)) {
      return null;
    }

    const payload = base64UrlDecodeJson(encodedPayload);
    if (!payload || typeof payload !== 'object') return null;
    if (payload.iss !== JWT_ISSUER) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || nowSec >= payload.exp) return null;

    if (payload.jti && revokedTokenJtis.has(payload.jti)) return null;

    const userId = Number(payload.sub);
    if (!Number.isInteger(userId) || userId <= 0) return null;

    const revokedBeforeMs = userRevokedBefore.get(userId);
    const issuedAtMs = typeof payload.iat_ms === 'number' ? payload.iat_ms : (typeof payload.iat === 'number' ? payload.iat * 1000 : 0);
    if (revokedBeforeMs && issuedAtMs < revokedBeforeMs) {
      return null;
    }

    return {
      userId,
      role: payload.role || null,
      employeeId: payload.employee_id || null,
      jti: payload.jti || null,
      iat: payload.iat,
      exp: payload.exp,
      expiresAt: payload.exp * 1000,
    };
  } catch {
    return null;
  }
}

export function createSession(userId, claims = {}) {
  pruneRevokedTokens();
  const numericId = Number(userId);
  const { token, payload } = signJwt({
    sub: numericId,
    ...(claims.role ? { role: claims.role } : {}),
    ...(claims.employee_id ? { employee_id: claims.employee_id } : {}),
  });
  let set = issuedUserJtis.get(numericId);
  if (!set) {
    set = new Set();
    issuedUserJtis.set(numericId, set);
  }
  set.add(payload.jti);
  return token;
}

export function getSession(token) {
  return verifyJwt(token);
}

export function revokeSession(token) {
  const session = verifyJwt(token);
  if (session?.jti) {
    revokedTokenJtis.set(session.jti, session.expiresAt);
    const set = issuedUserJtis.get(session.userId);
    if (set) set.delete(session.jti);
  }
}

export function revokeUserSessions(userId) {
  const numericId = Number(userId);
  const nowMs = Date.now();
  const maxExp = nowMs + getJwtTtlSeconds() * 1000;
  const set = issuedUserJtis.get(numericId);
  if (set) {
    for (const jti of set) {
      revokedTokenJtis.set(jti, maxExp);
    }
    set.clear();
  }
  userRevokedBefore.set(numericId, nowMs);
}
