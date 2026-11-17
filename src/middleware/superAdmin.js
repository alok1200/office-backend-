// src/middleware/superAdmin.js

/**
 * Middleware to ensure the request is made by a SUPER_ADMIN.
 */
export function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'SUPER_ADMIN privileges required.' });
  }
  next();
}

/**
 * Middleware that blocks any personal punch actions (check‑in, check‑out, break) for SUPER_ADMIN.
 */
export function blockSuperAdminPunch(req, res, next) {
  if (req.user?.role === 'SUPER_ADMIN') {
    return res.status(400).json({
      error: 'SUPER_ADMIN accounts do not track personal check‑in, check‑out, or breaks.'
    });
  }
  next();
}
