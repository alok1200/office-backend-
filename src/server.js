import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { runMigrationsAndSeed } from './db/seed.js';
import { query, pool } from './db/index.js';




import authRoutes from './routes/authRoutes.js';
import officeLocationRoutes from './routes/officeLocationRoutes.js';
import superAdminRoutes from './routes/superAdminRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import requestRoutes from './routes/requestRoutes.js';
import employeeRoutes from './routes/employeeRoutes.js';
import holidayRoutes from './routes/holidayRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';


dotenv.config();

const app = express();
const PORT = process.env.PORT || 8086;
const isProd = process.env.NODE_ENV === 'production';

// Production security headers & body limit
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const corsOrigin = process.env.CORS_ORIGIN?.trim()
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()).filter(Boolean)
  : '*';

// Middlewares
app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id']
}));
app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/api/health', async (req,res) => {
  try { await query('SELECT 1'); res.json({status:'ok',service:'KNOOVIQ Attendance Backend',database:'postgresql',timestamp:new Date().toISOString()}); }
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
app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'API endpoint not found.' }));

// Serve built frontend
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const frontendDist = fileURLToPath(new URL('../../frontend/dist/',import.meta.url));
app.use(express.static(frontendDist));
app.use(['/assets', '/branding'], (req, res) => res.status(404).end());
// For SPA routes, fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
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
  await runMigrationsAndSeed();
  const currentPort = Number(port);
  const server = app.listen(currentPort, () => {
    console.log(`=========================================`);
    console.log(`  KNOOVIQ Attendance Server Running`);
    console.log(`  Port: http://localhost:${currentPort}`);
    console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`=========================================`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Server] Port ${currentPort} is already in use. Stop the existing backend or set PORT explicitly; the frontend must use the same port.`);
      process.exitCode = 1;
    } else {
      console.error('Server error:', err);
    }
  });

  const shutdown = (signal) => {
    console.log(`[Server] Received ${signal}. Shutting down gracefully...`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => {
  console.error('Failed to start server:', err.message);
  process.exitCode = 1;
  pool.end();
});
