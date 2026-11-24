import express from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { query } from '../db/index.js';
import { peerAddress } from '../services/officeNetworks.js';
import { verifyPassword, checkRateLimit, recordFailedAttempt, resetRateLimit, createSession, revokeSession, dummyPasswordVerify } from '../utils/security.js';
const router = express.Router();

/**
 * POST /api/auth/login
 * Role-based authentication accepting Email or Employee ID and Password
 */
router.post('/login', async (req, res) => {
  try {
    const rawIdentifier = req.body.identifier || req.body.email || req.body.employee_id || '';
    const rawPassword = req.body.password || '';

    // 1. Validate required fields & trim identifier (never trim password)
    const identifier = String(rawIdentifier).trim();
    const password = String(rawPassword);
    if (!identifier) {
      return res.status(400).json({
        success: false,
        error: 'Please enter your email address or Employee ID.'
      });
    }
    if (!password) {
      return res.status(400).json({
        success: false,
        error: 'Please enter your password.'
      });
    }

    // 2. Rate limiting check using direct socket peer IP (never spoofable X-Forwarded-For)
    const clientIp = peerAddress(req) || '127.0.0.1';
    const rateLimitKey = `${clientIp}:${identifier.toLowerCase()}`;
    const rateCheck = checkRateLimit(rateLimitKey);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        success: false,
        error: `Too many unsuccessful login attempts. Please wait ${rateCheck.minutesLeft} minute(s) before trying again.`
      });
    }

    // 3. Lookup employee by Email or Employee ID (case-insensitive)
    let user = null;
    const result = await query(`SELECT * FROM employees 
         WHERE LOWER(email) = LOWER($1) OR LOWER(employee_id) = LOWER($1) 
         LIMIT 1`, [identifier]);
    if (result.rows.length > 0) {
      user = result.rows[0];
    }

    // 4. Verify user exists and check password
    // Always run dummy PBKDF2 verify when user is not found to prevent timing-based account enumeration
    if (!user) {
      dummyPasswordVerify(password);
      recordFailedAttempt(rateLimitKey);
      return res.status(401).json({
        success: false,
        error: 'Invalid login credentials. Please try again.'
      });
    }

    // Check account status
    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        error: 'Your account is currently inactive. Please contact the system administrator.'
      });
    }

    // Verify Password
    const isPasswordValid = verifyPassword(password, user.password_hash, user.password_salt);
    if (!isPasswordValid) {
      recordFailedAttempt(rateLimitKey);
      return res.status(401).json({
        success: false,
        error: 'Invalid login credentials. Please try again.'
      });
    }

    // 5. Success: reset rate limiter, issue signed JWT token
    resetRateLimit(rateLimitKey);
    const sessionToken = createSession(user.id, {
      role: user.role,
      employee_id: user.employee_id,
    });

    // Return safe user representation (no passwords or salts)
    const safeUser = {
      id: user.id,
      employee_id: user.employee_id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role,
      // Determined by backend: 'EMPLOYEE', 'HR_ADMIN', 'SUPER_ADMIN'
      department_name: user.department_name,
      designation: user.designation,
      avatar_url: user.avatar_url,
      can_record_attendance: user.can_record_attendance
    };
    return res.json({
      success: true,
      message: 'Sign in successful.',
      token: sessionToken,
      user: safeUser
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'An unexpected server error occurred during sign in. Please try again.'
    });
  }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    revokeSession(token);
  }
  return res.json({
    success: true,
    message: 'Successfully signed out.'
  });
});

/**
 * GET /api/auth/me
 */
router.get('/me', authenticateUser, (req, res) => {
  const {
    password_hash,
    password_salt,
    ...safeUser
  } = req.user;
  return res.json({
    success: true,
    user: safeUser
  });
});

// Compatibility endpoint: account identity is private to the signed-in user.
router.get('/users', authenticateUser, (req, res) => {
  const {
    password_hash,
    password_salt,
    ...user
  } = req.user;
  res.json({
    success: true,
    data: [user]
  });
});
export default router;
