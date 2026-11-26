import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { runMigrationsAndSeed } from './db/seed.js';
import { query, pool } from './db/index.js';
import {
  sanitizeRequestMiddleware,
  securityHeadersMiddleware,
  createRateLimiter,
  redirectLanToHttps,
} from './middleware/securityHardening.js';




import authRoutes from './routes/authRoutes.js';
import officeLocationRoutes from './routes/officeLocationRoutes.js';
import superAdminRoutes from './routes/superAdminRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import requestRoutes from './routes/requestRoutes.js';
import employeeRoutes from './routes/employeeRoutes.js';
import holidayRoutes from './routes/holidayRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import payrollRoutes from './routes/payrollRoutes.js';


dotenv.config();

const app = express();
const PORT = process.env.PORT || 8086;
const isProd = process.env.NODE_ENV === 'production';

// Production security headers, sanitization, CORS & rate limiting
app.disable('x-powered-by');
app.use(securityHeadersMiddleware(isProd));
const lanHttpsUrl = process.env.LAN_HTTPS_URL?.trim();
if (lanHttpsUrl) app.use(redirectLanToHttps(lanHttpsUrl));

const corsOrigin = process.env.CORS_ORIGIN?.trim()
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()).filter(Boolean)
  : (isProd ? false : '*');

// Middlewares
app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({
  limit: '256kb',
  verify: (req, res, buf) => {
    if (/^\/api\/payroll\/webhooks\//i.test(req.path)) {
      req.rawBody = buf;
    }
  }
}));
app.use(sanitizeRequestMiddleware);
app.use('/api', createRateLimiter({ windowMs: 60_000, max: 600 }));

// Health check
app.get('/api/health', async (req,res) => {
  try { await query('SELECT 1'); res.json({status:'ok',service:'KNOOVIQ Attendance Backend',database:'postgresql',release:process.env.RENDER_GIT_COMMIT,timestamp:new Date().toISOString()}); }
  catch { res.status(503).json({status:'unavailable',database:'postgresql'}); }
});

// Mount Routes


app.use('/api/auth', authRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/office-location', officeLocationRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/holidays', holidayRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'API endpoint not found.' }));

// Serve built frontend
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const frontendDist = fileURLToPath(new URL('../../frontend/dist/',import.meta.url));
app.use(express.static(frontendDist, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));
app.use(['/assets', '/branding'], (req, res) => res.status(404).end());
// Serve SPA routes when a frontend build is available.
app.get('*', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(frontendDist, 'index.html'), error => {
    if (!error) return;
    if (res.headersSent || error.code !== 'ENOENT') return next(error);
    if (req.path === '/') return res.redirect('/api/health');
    res.status(404).end();
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Request body must contain valid JSON.' });
  }
  console.error('Unhandled Server Error:', err);
  res.status(err.status || 500).json({
    success: false,
    error: isProd && !err.status ? 'Internal Server Error' : (err.message || 'Internal Server Error')
  });
});

// Start Server
async function start(port = Number(PORT)) {
  const keyPath = process.env.TLS_KEY_FILE?.trim();
  const certPath = process.env.TLS_CERT_FILE?.trim();
  const tlsPort = process.env.TLS_PORT?.trim();
  if ((keyPath || certPath || tlsPort) && (!keyPath || !certPath)) {
    throw new Error('Set both TLS_KEY_FILE and TLS_CERT_FILE to enable HTTPS.');
  }
  if (tlsPort && Number(tlsPort) === port) {
    throw new Error('TLS_PORT and PORT must be different when both listeners are enabled.');
  }

  const listeners = [];
  if (keyPath) {
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    listeners.push({ server: createHttpsServer({ key, cert }, app), port: Number(tlsPort || port), protocol: 'HTTPS' });
  }
  if (!keyPath || tlsPort) {
    listeners.push({ server: createHttpServer(app), port, protocol: 'HTTP' });
  }

  await runMigrationsAndSeed();
  try {
    for (const { server, port, protocol } of listeners) {
      await once(server.listen(port), 'listening');
      console.log(`[Server] KNOOVIQ Attendance listening on port ${server.address().port} (${protocol}).`);
    }
  } catch (error) {
    for (const { server } of listeners) if (server.listening) server.close();
    throw error;
  }

  const shutdown = (signal) => {
    console.log(`[Server] Received ${signal}. Shutting down gracefully...`);
    Promise.all(listeners.map(({ server }) => new Promise(resolve => server.close(resolve))))
      .then(() => pool.end()).finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => {
  console.error('Failed to start server:', err.message);
  process.exitCode = 1;
  pool.end();
});
