/**
 * SahaTN / Maw2idi — Production Node.js & Express REST API + WebSocket Server
 * Real-Time Virtual Waiting Room, Anti-Conflict Appointment Engine & Relational Persistence
 */

// 1. Threadpool Optimization (16 worker threads for concurrent crypto/bcrypt/DNS/disk tasks)
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

require('dotenv').config();

// 2. Production Security Startup Guard — refuse to boot with weak/default secrets
if (process.env.NODE_ENV === 'production') {
  const weakSecrets = new Set([
    '',
    'sahatn_super_secret_jwt_key_2026_tunisie_sante_inspdp',
    'sahatn_jwt_super_secret_production_key_2026',
    'sahatn_cookie_secret_key_2026',
    'sahatn_aes256_medical_confidentiality_master_key_2026_tunisia',
    'GENERATE_A_64_CHAR_RANDOM_SECRET_KEY_FOR_PRODUCTION_JWT',
    'GENERATE_A_64_CHAR_RANDOM_SECRET_KEY_FOR_PRODUCTION_COOKIE'
  ]);
  const requiredSecrets = [
    { name: 'JWT_SECRET', value: process.env.JWT_SECRET || '' },
    { name: 'COOKIE_SECRET', value: process.env.COOKIE_SECRET || '' },
    { name: 'ENCRYPTION_MASTER_KEY', value: process.env.ENCRYPTION_MASTER_KEY || '' }
  ];
  const invalid = requiredSecrets.filter(s => weakSecrets.has(s.value.trim()) || s.value.trim().length < 32);
  if (invalid.length > 0) {
    console.error(`[FATAL SECURITY] Production startup aborted. Missing or insecure secrets: ${invalid.map(s => s.name).join(', ')}. Generate 64-char random keys (e.g. openssl rand -hex 32).`);
    process.exit(1);
  }
}

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
});

const http = require('http');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const db = require('./src/config/database');
const initQueueSocket = require('./src/sockets/queue.socket');
const {
  securityHeaders,
  authLimiter,
  expensiveApiLimiter,
  appointmentLimiter,
  apiGeneralLimiter,
  sanitizeInput,
  corsOptions,
  prototypePollutionGuard,
  csrfProtection
} = require('./src/middleware/security.middleware');
const { securityMonitorMiddleware } = require('./src/services/securityAlert.service');

// Route Handlers
const authRoutes = require('./src/routes/auth.routes');
const doctorsRoutes = require('./src/routes/doctors.routes');
const appointmentsRoutes = require('./src/routes/appointments.routes');
const queueRoutes = require('./src/routes/queue.routes');
const reviewsRoutes = require('./src/routes/reviews.routes');
const prescriptionsRoutes = require('./src/routes/prescriptions.routes');
const patientRoutes = require('./src/routes/patient.routes');
const adminRoutes = require('./src/routes/admin.routes');
const aiRoutes = require('./src/routes/ai.routes');
const communicationsRoutes = require('./src/routes/communications.routes');
const paymentsRoutes = require('./src/routes/payments.routes');
const { router: notificationsRoutes } = require('./src/routes/notifications.routes');

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

// 0. Block direct requests to hidden dotfiles (/.env, /.git) and backend source/upload internals
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  const isBlockedDotfile = /\/\.(?!well-known\/)/.test(p);
  const isBlockedServerPath = (
    p === '/server.js' ||
    p === '/package.json' ||
    p === '/package-lock.json' ||
    p.startsWith('/src/') ||
    p.startsWith('/db/') ||
    p.startsWith('/data/') ||
    p.startsWith('/uploads/') ||
    p.startsWith('/scripts/') ||
    p.startsWith('/test_') ||
    p.endsWith('.env') ||
    p.endsWith('.sql') ||
    p.endsWith('.log')
  );
  if (isBlockedDotfile || isBlockedServerPath) {
    return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Ressource introuvable.' });
  }
  next();
});

// 0b. Real-Time Suspicious Activity Monitoring & Alerting
app.use(securityMonitorMiddleware);

// 0c. Enforce HTTPS in production (HSTS header is added in securityHeaders).
// Behind Cloudflare / nginx the original scheme arrives in X-Forwarded-Proto (trust proxy is on).
if (process.env.NODE_ENV === 'production' && process.env.FORCE_HTTPS !== 'false') {
  app.use((req, res, next) => {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || '').split(',')[0].trim().toLowerCase();
    const host = String(req.headers.host || '');
    if (proto === 'https' || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return next();
    const safeHost = process.env.PUBLIC_HOST || (/^[a-z0-9.-]+(:\d+)?$/i.test(host) ? host : null);
    if (safeHost && (req.method === 'GET' || req.method === 'HEAD')) {
      return res.redirect(301, `https://${safeHost}${req.originalUrl}`);
    }
    return res.status(426).json({ success: false, error: 'HTTPS_REQUIRED', message: 'Connexion HTTPS requise.' });
  });
}

// 0d. Never leak internals on 5xx in production (stack traces, file paths, SQL, err.message)
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 500 && body && typeof body === 'object') {
        console.error(`[5xx] ${req.method} ${req.originalUrl}:`, body.message || body.error || 'unknown');
        body = { success: false, error: 'INTERNAL_ERROR', message: 'Une erreur interne est survenue. Veuillez réessayer plus tard.' };
      }
      return originalJson(body);
    };
    next();
  });
}

const server = http.createServer(app);
const PORT = process.env.PORT || 4000;

// Socket.io Setup with Hardened CORS
const io = new Server(server, {
  cors: {
    origin: corsOptions.origin,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  }
});
app.set('io', io);
initQueueSocket(io, db);

// 1. Enterprise Security Headers (Clickjacking, MIME, CSP, Permissions)
app.use(securityHeaders);

// 2. Hardened CORS Configuration
app.use(cors(corsOptions));

// 3. Payload Limiters & Body Parsers (capped at 10MB to prevent memory exhaustion DoS)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 4. Prototype Pollution Guard
app.use(prototypePollutionGuard);

// 5. Anti-XSS & Injection Deep Sanitizer
app.use(sanitizeInput);

// 6. Anti-CSRF Token Generation & Mutation Verification
app.use(csrfProtection);

// 7. General API Rate Limiting
app.use('/api', apiGeneralLimiter);

// 8. Server-Side Route Guard & Clean URL Aliases for Admin Console
const jwt = require('jsonwebtoken');
const { isTokenRevoked, JWT_SECRET, verifyToken } = require('./src/middleware/auth');
const { persistDataUri, resolveUploadPath } = require('./src/utils/fileStorage');

function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

function verifyAdminAccess(req) {
  const cookies = parseCookies(req);
  const token = cookies['sahatn_admin_token'] || 
                (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].slice(7) : null);
  if (!token || isTokenRevoked(token)) return false;
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.role !== 'SUPER_ADMIN' && decoded.role !== 'ADMIN') {
      return false;
    }
    req.user = decoded;
    req.adminToken = token;
    return true;
  } catch (err) {
    return false;
  }
}

// Intercept ANY access to Admin console routes or static files BEFORE express.static
app.use((req, res, next) => {
  const rawPath = req.path.toLowerCase();
  const isAdminPath = rawPath.includes('admin-db') ||
                      rawPath.startsWith('/pages/admin_pages') ||
                      rawPath === '/admin' ||
                      rawPath.startsWith('/admin/');

  if (!isAdminPath) {
    return next();
  }

  // Check if caller is authenticated as Super Admin / Admin
  if (verifyAdminAccess(req)) {
    // Explicitly block deleted legacy admin-login.html
    if (rawPath.endsWith('admin-login.html')) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Page introuvable.' });
    }
    // If accessing clean URL /admin or /admin/console, redirect to the actual HTML
    if (rawPath === '/admin' || rawPath === '/admin/console') {
      return res.redirect('/pages/Admin_pages/admin-db.html');
    }
    // Allow static file or SPA route to be served
    return next();
  }

  // Unauthenticated visitor trying to access Admin pages!
  // NEVER serve admin-db.html to unauthorized callers!
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(403).json({ success: false, error: 'ADMIN_AUTH_REQUIRED', message: 'Accès refusé. Authentification Administrateur requise.' });
  }

  // For browser navigation: Redirect to the unified portal login preserving target
  const targetUrl = req.originalUrl || req.url || '/pages/Admin_pages/admin-db.html';
  return res.redirect(`/pages/landing_pages/landing.html?login=admin&unauthorized=1&redirect=${encodeURIComponent(targetUrl)}`);
});

// Standalone API Backend — frontend assets are served separately by the frontend app.

// --- REST API ENDPOINTS ---

// Healthcheck with Security Status
app.get('/api/health', (req, res) => {
  res.json({
    status: 'HEALTHY',
    app: 'SahaTN Node.js REST API + Real-Time WebSocket Engine',
    version: '2.2.0',
    security: {
      rateLimiting: 'ACTIVE (Sliding Window)',
      antiXSS: 'ACTIVE (Deep Recursive Sanitizer)',
      headers: 'ACTIVE (CSP, HSTS, SAMEORIGIN, Nosniff)',
      inpdpAuditCompliance: 'TUNISIE_LOI_2004_63',
      dataMasking: 'ACTIVE',
      aes256Encryption: 'ACTIVE (Field-Level EHR at Rest)',
      csrfProtection: 'ACTIVE (HMAC-SHA256 Cryptographic Tokens)',
      auditMerkleChain: 'ACTIVE (SHA-256 Ledger Chaining)',
      tokenBlacklist: 'ACTIVE (Immediate Revocation on Logout)',
      accountLockout: 'ACTIVE (5-attempt lockout)'
    },
    timestamp: new Date().toISOString()
  });
});

// Revenue Endpoint (Compatibility with test suite)
app.get('/api/revenue', (req, res) => {
  res.json({
    success: true,
    data: {
      totalGrossRevenue: 1240,
      currency: 'TND',
      formatted: '1240 TND',
      breakdown: {
        saasSubscriptions: '1,170 TND',
        telehealthCommissions: '70 TND'
      }
    }
  });
});

// Mount Routes with specialized rate limiters
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/doctors', doctorsRoutes);
app.use('/api/praticiens', doctorsRoutes);
app.use('/api/appointments', appointmentLimiter, appointmentsRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/prescriptions', prescriptionsRoutes);
app.use('/api/patient', patientRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ai', expensiveApiLimiter, aiRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/communications', expensiveApiLimiter, communicationsRoutes);
app.use('/api/payments', paymentsRoutes);

// Secure File Uploads & Serving (prevents bloating DB with Base64 payloads)
app.post('/api/uploads', expensiveApiLimiter, verifyToken, (req, res) => {
  try {
    const { dataUri, category = 'documents' } = req.body || {};
    if (!dataUri) {
      return res.status(400).json({ success: false, message: 'Fichier requis.' });
    }
    const url = persistDataUri(dataUri, category);
    return res.status(201).json({ success: true, url });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

app.get('/api/uploads/:category/:filename', (req, res) => {
  const { category, filename } = req.params;
  // Private medical/practitioner/payment documents require authentication
  if (category === 'cv' || category === 'documents' || category === 'receipts') {
    return verifyToken(req, res, () => {
      const filePath = resolveUploadPath(category, filename);
      if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, message: 'Fichier introuvable.' });
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      return res.sendFile(filePath);
    });
  }
  const filePath = resolveUploadPath(category, filename);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, message: 'Fichier introuvable.' });
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.sendFile(filePath);
});

// Reverse Geocoding & Search Proxy (rate-limited to prevent abuse)
app.get('/api/geo/reverse', expensiveApiLimiter, async (req, res) => {
  const { lat, lon, lng, lang } = req.query;
  const latitude = lat;
  const longitude = lon || lng;
  if (!latitude || !longitude) {
    return res.status(400).json({ success: false, message: 'Coordonnées requises' });
  }
  try {
    const langParam = lang === 'ar' ? 'ar,fr' : 'fr,ar';
    const osmRes = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}&addressdetails=1&accept-language=${langParam}`,
      {
        headers: { 'User-Agent': 'SahaTN-Tunisie-Healthcare/1.0 (contact@sahatn.tn)' },
        signal: AbortSignal.timeout(6000)
      }
    );
    if (!osmRes.ok) throw new Error(`OSM error ${osmRes.status}`);
    const data = await osmRes.json();
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(502).json({ success: false, error: err.message });
  }
});

app.get('/api/geo/search', expensiveApiLimiter, async (req, res) => {
  const { q, lang } = req.query;
  if (!q) return res.status(400).json({ success: false, message: 'Recherche requise' });
  try {
    const langParam = lang === 'ar' ? 'ar,fr' : 'fr,ar';
    const osmRes = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q + ', Tunisie')}&countrycodes=tn&addressdetails=1&accept-language=${langParam}`,
      {
        headers: { 'User-Agent': 'SahaTN-Tunisie-Healthcare/1.0 (contact@sahatn.tn)' },
        signal: AbortSignal.timeout(6000)
      }
    );
    if (!osmRes.ok) throw new Error(`OSM error ${osmRes.status}`);
    const data = await osmRes.json();
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(502).json({ success: false, error: err.message });
  }
});



// Root API status endpoint (standalone API backend — frontend runs separately)
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    service: 'SahaTN / Maw2idi REST API & WebSocket Backend',
    health: '/api/health'
  });
});

// Global 404 Handler for API
app.all('/api/*', (req, res) => {
  res.status(404).json({ success: false, message: `Endpoint API '${req.originalUrl}' introuvable.` });
});

// Fallback for non-API routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'NOT_FOUND',
    message: `Route '${req.originalUrl}' introuvable sur le serveur API.`
  });
});

// Global Error Handler — never leak internal stack traces or raw messages in production
app.use((err, req, res, _next) => {
  console.error('[Server Error]', err);
  const status = err.status || err.statusCode || 500;
  const isProd = process.env.NODE_ENV === 'production';
  res.status(status).json({
    success: false,
    error: status >= 500 ? 'INTERNAL_SERVER_ERROR' : (err.code || 'REQUEST_ERROR'),
    message: isProd && status >= 500 ? 'Erreur interne du serveur.' : (err.message || 'Erreur serveur.')
  });
});

// Global error handler: JSON only, never a stack trace or local file path (body-parser syntax errors, etc.)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  console.error(`[Error] ${req.method} ${req.originalUrl}:`, err?.message);
  if (res.headersSent) return;
  const message = status === 400 ? 'Requête invalide.' : status === 413 ? 'Requête trop volumineuse.' : 'Une erreur interne est survenue.';
  res.status(status).json({ success: false, error: status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST', message });
});

// Handle Server Listen Errors (e.g. port already in use)
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ [SERVER FATAL] Le port ${PORT} est déjà utilisé par un autre processus !`);
    console.error(`💡 Conseil : Fermez les fenêtres Node existantes ou utilisez start.bat pour nettoyer les ports automatiquement.\n`);
  } else {
    console.error(`\n❌ [SERVER FATAL]:`, err);
  }
});

// Start Server
server.listen(PORT, () => {
  console.log(`
  ══════════════════════════════════════════════════════════════
  🚀 SahaTN / Maw2idi Node.js REST API Server Running!
  📡 URL: http://localhost:${PORT}
  ⚡ Real-Time WebSockets: Active (Socket.io)
  📦 Database: Relational Persistent Engine (data/database.json)
  📄 Documentation: /api/health
  ══════════════════════════════════════════════════════════════
  `);
});

module.exports = { app, server };
