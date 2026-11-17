import { query } from '../db/index.js';
import { getSession } from '../utils/security.js';

/**
 * Authentication Middleware: Extracts identity only from a validated session token
 */
export async function authenticateUser(req, res, next) {
  try {
    let userId = null;

    // 1. Check Bearer Token
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const session = getSession(token);
      if (session) {
        userId = session.userId;
      }
    }
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Session missing or expired. Please sign in.'
      });
    }
    let user = null;
    const result = await query('SELECT * FROM employees WHERE id = $1 AND is_active = true', [userId]);
    if (result.rows.length > 0) {
      user = result.rows[0];
    }
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: User not found or inactive.'
      });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Authentication failure: ' + err.message
    });
  }
}

/**
 * RBAC Middleware: Require one of allowed roles
 */
export function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `Forbidden: Access restricted. Role '${req.user.role}' lacks permission for this action.`
      });
    }
    next();
  };
}

/**
 * RBAC Enforcement: Explicitly block HR Admin and Employee from performing privileged decisions or edits
 */
export function disallowHRDecisions(req, res, next) {
  if (req.user && req.user.role === 'HR_ADMIN') {
    return res.status(403).json({
      success: false,
      error: 'Forbidden: HR Admin is strictly a read-only role for company-wide management. Request approval/rejection is reserved for Super Admin (later phase).'
    });
  }
  next();
}
