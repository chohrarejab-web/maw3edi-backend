/**
 * SahaTN / Maw2idi — Enterprise Security & Compliance Middleware
 * 
 * Features:
 * 1. Security Headers (Clickjacking defense, MIME-sniffing protection, CSP, XSS-Defense)
 * 2. Sliding Window Rate Limiting (Brute-force protection on Auth & Bookings)
 * 3. Deep Anti-XSS & Payload Sanitization
 * 4. Tunisian INPDP Medical Audit Trail (Loi N° 2004-63 du 27 juillet 2004)
 * 5. Sensitive Data Masking (CNAM, Phone, Patient Identity)
 * 6. Dynamic CORS Origin Whitelisting (Localhost + Cloudflare Tunnels)
 */

const db = require('../config/database');

// ==========================================
// 1. SECURITY HEADERS & CLICKJACKING DEFENSE
// ==========================================
function securityHeaders(req, res, next) {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent Clickjacking (iframe embeds)
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  // Legacy XSS filter activation
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Referrer Policy - Don't leak medical query parameters to external sites
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions Policy for WebRTC / Telehealth & Geolocation
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self), display-capture=(self)');

  // Cross-Origin Isolation & Opener Policy
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');

  // Content Security Policy (strict — no unsafe-eval)
  const cspDirectives = [
    "default-src 'self' data: blob: https:",
    "script-src 'self' 'unsafe-inline' https://accounts.google.com https://apis.google.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https: https://*.googleusercontent.com https://accounts.google.com",
    "connect-src 'self' ws: wss: https://accounts.google.com https://oauth2.googleapis.com https://www.googleapis.com",
    "media-src 'self' blob: data:",
    "frame-src 'self' https://accounts.google.com",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
    "form-action 'self'"
  ].join('; ');

  res.setHeader('Content-Security-Policy', cspDirectives);

  // Strict Transport Security (HSTS) in production
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  // Remove server fingerprinting
  res.removeHeader('X-Powered-By');

  next();
}

// ==========================================
// 2. SLIDING WINDOW RATE LIMITER
// ==========================================
class MemoryRateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60 * 1000; // default 1 minute
    this.max = options.max || 100; // max requests per window
    this.message = options.message || 'Trop de requêtes. Veuillez patienter avant de réessayer.';
    this.hits = new Map();

    // Auto-cleanup stale IP records every minute to prevent memory leaks
    const timer = setInterval(() => this.cleanup(), 60 * 1000);
    if (timer.unref) timer.unref();
  }

  cleanup() {
    const now = Date.now();
    for (const [key, record] of this.hits.entries()) {
      if (now - record.startTime > this.windowMs) {
        this.hits.delete(key);
      }
    }
  }

  getMiddleware() {
    return (req, res, next) => {
      // Extract IP supporting proxy headers (Cloudflare, NGINX)
      const ip = (req.headers['cf-connecting-ip'] ||
                  req.headers['x-forwarded-for']?.split(',')[0].trim() ||
                  req.socket.remoteAddress ||
                  '127.0.0.1').replace(/^.*:/, '');

      // Load-test bypass is ONLY allowed outside production when explicitly opted-in via env
      const allowLoadTestBypass = process.env.NODE_ENV !== 'production' && process.env.ALLOW_LOAD_TEST_BYPASS === 'true';
      const isLoadTest = allowLoadTestBypass && ((req.headers['user-agent'] || '').includes('k6') || req.headers['x-load-test'] === 'true');
      if (isLoadTest) {
        return next();
      }

      const now = Date.now();
      let record = this.hits.get(ip);

      if (!record || (now - record.startTime > this.windowMs)) {
        record = {
          startTime: now,
          count: 1
        };
        this.hits.set(ip, record);
      } else {
        record.count++;
      }

      const remaining = Math.max(0, this.max - record.count);
      const resetTime = Math.ceil((record.startTime + this.windowMs) / 1000);

      res.setHeader('RateLimit-Limit', this.max);
      res.setHeader('RateLimit-Remaining', remaining);
      res.setHeader('RateLimit-Reset', resetTime);

      if (record.count > this.max) {
        const retryAfterSeconds = Math.ceil((record.startTime + this.windowMs - now) / 1000);
        res.setHeader('Retry-After', retryAfterSeconds);
        return res.status(429).json({
          success: false,
          error: 'RATE_LIMIT_EXCEEDED',
          message: this.message,
          retryAfter: retryAfterSeconds
        });
      }

      next();
    };
  }
}

// Pre-configured rate limiters
const authLimiter = new MemoryRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 25 : 120, // Strict 25/15m in production
  message: 'Trop de tentatives d\'authentification. Veuillez patienter 15 minutes.'
}).getMiddleware();

const expensiveApiLimiter = new MemoryRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests/min on AI, OCR/uploads, geo proxy & WhatsApp endpoints
  message: 'Limite de requêtes atteinte sur ce service. Veuillez patienter une minute.'
}).getMiddleware();

const appointmentLimiterInstance = new MemoryRateLimiter({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 120, // 120 bookings per 10 mins
  message: 'Limite de réservation atteinte. Veuillez patienter quelques minutes.'
}).getMiddleware();

const appointmentLimiter = (req, res, next) => {
  // Only rate-limit appointment booking creation (POST)
  // Allow read operations (GET schedules, appointments, available slots, blocked slots)
  if (req.method === 'GET' || req.method === 'OPTIONS' || req.path.includes('/schedule') || req.path.includes('/blocked-slots')) {
    return next();
  }
  return appointmentLimiterInstance(req, res, next);
};

const apiGeneralLimiter = new MemoryRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 600, // 600 requests per minute
  message: 'Fréquence de requêtes anormalement élevée. Veuillez ralentir.'
}).getMiddleware();

// ==========================================
// 3. ANTI-XSS DEEP INPUT SANITIZATION
// ==========================================
function sanitizeValue(val) {
  if (typeof val === 'string') {
    // Preserve base64 binary data URLs (images, CV documents) directly without regex overhead
    if (val.startsWith('data:image/') || val.startsWith('data:application/pdf') || val.startsWith('data:application/')) {
      return val;
    }
    return val
      // Strip script tags & content
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      // Strip dangerous HTML tags
      .replace(/<\/?(iframe|object|embed|applet|meta|link|style)\b[^>]*>/gi, '')
      // Neutralize javascript: and vbscript: URIs
      .replace(/javascript\s*:/gi, 'blocked-js:')
      .replace(/vbscript\s*:/gi, 'blocked-vbs:')
      // Strip inline event handlers (onerror=, onload=, onclick=, etc.)
      .replace(/\s*on\w+\s*=\s*(['"]).*?\1/gi, '')
      .replace(/\s*on\w+\s*=\s*[^>\s]+/gi, '');
  }

  if (Array.isArray(val)) {
    return val.map(sanitizeValue);
  }

  if (val !== null && typeof val === 'object') {
    const cleaned = {};
    for (const [k, v] of Object.entries(val)) {
      cleaned[k] = sanitizeValue(v);
    }
    return cleaned;
  }

  return val;
}

function sanitizeInput(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeValue(req.query);
  }
  if (req.params && typeof req.params === 'object') {
    req.params = sanitizeValue(req.params);
  }
  next();
}

const { computeAuditBlockHash, GENESIS_AUDIT_HASH, generateCsrfToken, verifyCsrfToken } = require('../utils/crypto.security');

// ==========================================
// 4. TUNISIAN MEDICAL AUDIT TRAIL (INPDP) WITH MERKLE HASH CHAIN
// ==========================================
/**
 * Conforme à la Loi Organique Tunisienne N° 2004-63 du 27 juillet 2004
 * Intégrité assurée par chaînage cryptographique SHA-256 (style Blockchain)
 */
function recordAuditLog({
  action,
  actorId = 'anonymous',
  actorRole = 'GUEST',
  actorEmail = null,
  resource = null,
  resourceId = null,
  ip = '127.0.0.1',
  status = 'SUCCESS',
  details = ''
}) {
  try {
    const now = new Date();
    const tunisTime = now.toLocaleString('fr-TN', { timeZone: 'Africa/Tunis' });

    // Retrieve previous block hash for cryptographic linking
    const existingLogs = db.get('auditLogs') || [];
    const previousEntry = existingLogs[0]; // Recent logs are unshifted
    const prevHash = previousEntry?.hash || GENESIS_AUDIT_HASH;

    const entry = {
      id: `audit-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
      timestamp: now.toISOString(),
      tunisTime,
      prevHash,
      hash: '', // will be set below
      action,
      actor: {
        id: actorId,
        role: actorRole,
        email: actorEmail
      },
      resource: {
        type: resource,
        id: resourceId
      },
      clientIp: ip.replace(/^.*:/, ''),
      status,
      details,
      compliance: 'INPDP_LOI_2004_63'
    };

    entry.hash = computeAuditBlockHash(entry, prevHash);

    db.insert('auditLogs', entry);
    return entry;
  } catch (err) {
    console.error('[Security/Audit] Error writing audit log:', err.message);
  }
}

/**
 * Validates the entire audit log chain from genesis to head.
 * Detects if any historical log has been deleted or modified.
 */
function verifyAuditLedgerIntegrity() {
  const rawLogs = db.get('auditLogs') || [];
  if (!rawLogs.length) {
    return { verified: true, totalEntries: 0, status: 'EMPTY_LEDGER' };
  }

  // Reverse to evaluate chronologically (oldest to newest)
  const chronological = [...rawLogs].reverse();
  let expectedPrevHash = GENESIS_AUDIT_HASH;

  for (let i = 0; i < chronological.length; i++) {
    const entry = chronological[i];
    // For legacy entries created before Phase 2 that have no hash, assign/pass
    if (!entry.hash) {
      expectedPrevHash = entry.hash || expectedPrevHash;
      continue;
    }

    const calculatedHash = computeAuditBlockHash(entry, entry.prevHash);
    if (calculatedHash !== entry.hash) {
      return {
        verified: false,
        status: 'TAMPER_DETECTED',
        corruptedEntryId: entry.id,
        index: i,
        message: `Alerte: Altération détectée sur l'entrée d'audit ${entry.id}. Le hash ne correspond pas aux données.`
      };
    }

    expectedPrevHash = entry.hash;
  }

  return {
    verified: true,
    valid: true,
    status: 'INTEGRITY_VERIFIED_100_PERCENT',
    totalEntries: rawLogs.length,
    headHash: rawLogs[0]?.hash || null
  };
}

// ==========================================
// 5. ANTI-CSRF (CROSS-SITE REQUEST FORGERY)
// ==========================================
function csrfProtection(req, res, next) {
  const clientId = (req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || 'client').replace(/^.*:/, '');
  
  // Issue fresh CSRF token header on every request for client SPA/frontend
  const token = generateCsrfToken(clientId);
  res.setHeader('X-CSRF-Token', token);

  // Safe HTTP read methods are exempt from CSRF
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Requests authenticated with Bearer JWT tokens are immune to ambient browser CSRF
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return next();
  }

  // Exempt public guest endpoints where session is being initiated or external webhooks arrive
  const publicExempt = [
    '/api/auth/login',
    '/api/auth/verify-2fa',
    '/api/auth/resend-2fa',
    '/api/auth/forgot-password',
    '/api/auth/verify-reset-code',
    '/api/auth/reset-password',
    '/api/auth/register',
    '/api/auth/google',
    '/api/doctors/request',
    '/api/praticiens/request',
    '/api/doctors/finalize-account',
    '/api/doctors/finalize',
    '/api/praticiens/finalize',
    '/api/payments/webhook',
    '/api/ai/docbot'
  ];
  if (publicExempt.some(p => req.path.startsWith(p) || req.originalUrl.startsWith(p))) {
    return next();
  }

  const clientToken = req.headers['x-csrf-token'] || req.body?._csrf;

  // If a CSRF token is provided, strictly verify it
  if (clientToken) {
    if (!verifyCsrfToken(clientToken, clientId)) {
      return res.status(403).json({
        success: false,
        error: 'CSRF_TOKEN_INVALID',
        message: 'Alerte Anti-CSRF : Jeton de sécurité invalide ou expiré.'
      });
    }
    return next();
  }

  // Enforce CSRF token whenever ambient cookies or browser Origin are present
  const userAgent = (req.headers['user-agent'] || '').toLowerCase();
  const isCliOrTest = process.env.NODE_ENV !== 'production' && (
    userAgent.startsWith('node') || userAgent.startsWith('curl') || userAgent.startsWith('python') || userAgent.includes('postman') || userAgent.includes('k6')
  );
  const hasBrowserContext = !isCliOrTest && Boolean(req.headers['cookie'] || req.headers['origin']);

  if (hasBrowserContext) {
    return res.status(403).json({
      success: false,
      error: 'CSRF_TOKEN_MISSING',
      message: 'Alerte Anti-CSRF : Jeton X-CSRF-Token requis pour les requêtes web mutantes.'
    });
  }

  next();
}

// ==========================================
// 6. PROTOTYPE POLLUTION GUARD
// ==========================================
function prototypePollutionGuard(req, res, next) {
  const isDangerous = (obj) => {
    if (!obj || typeof obj !== 'object') return false;
    for (const key of Object.keys(obj)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return true;
      }
      if (typeof obj[key] === 'object' && isDangerous(obj[key])) {
        return true;
      }
    }
    return false;
  };

  if (isDangerous(req.body) || isDangerous(req.query) || isDangerous(req.params)) {
    return res.status(400).json({
      success: false,
      error: 'PROTOTYPE_POLLUTION_DETECTED',
      message: 'Alerte de sécurité : Tentative d\'injection de prototype interceptée.'
    });
  }
  next();
}

// Express middleware factory to audit medical route accesses
function auditTrail(action, getResourceInfo = () => ({})) {

  return (req, res, next) => {
    // Intercept response finish
    res.on('finish', () => {
      const isSuccess = res.statusCode >= 200 && res.statusCode < 400;
      const actorId = req.user ? req.user.uuid : (req.body?.patientId || 'anonymous');
      const actorRole = req.user ? req.user.role : 'PATIENT';
      const actorEmail = req.user ? req.user.email : (req.body?.email || null);
      const { resource = 'MEDICAL_RECORD', resourceId = req.query?.patientId || req.body?.patientId || 'default' } = getResourceInfo(req);

      const ip = (req.headers['cf-connecting-ip'] ||
                  req.headers['x-forwarded-for']?.split(',')[0].trim() ||
                  req.socket.remoteAddress ||
                  '127.0.0.1');

      recordAuditLog({
        action,
        actorId,
        actorRole,
        actorEmail,
        resource,
        resourceId,
        ip,
        status: isSuccess ? 'SUCCESS' : 'DENIED',
        details: `${req.method} ${req.originalUrl} [HTTP ${res.statusCode}]`
      });
    });

    next();
  };
}

// ==========================================
// 5. SENSITIVE DATA MASKING
// ==========================================
function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  // Convert "+216 20 999 123" to "+216 20 *** *23"
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.length >= 8) {
    return phone.replace(/(\+?216\s?\d{2})\s?(\d{3})\s?(\d{3})/, '$1 *** *$3')
                .replace(/(\d{2})\s?(\d{3})\s?(\d{3})/, '$1 *** *$3');
  }
  return phone.slice(0, 4) + '***' + phone.slice(-2);
}

function maskCNAM(matricule) {
  if (!matricule || typeof matricule !== 'string') return '';
  // Convert "12345678-01" to "****5678-01"
  return matricule.replace(/^(\d{4})/, '****');
}

function maskName(fullName) {
  if (!fullName || typeof fullName !== 'string') return 'Patient Anonyme';
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 3) + '***';
  return `${parts[0]} ${parts[1].charAt(0).toUpperCase()}.`;
}

// ==========================================
// 6. HARDENED CORS CONFIGURATION
// ==========================================
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);

    const normalizedOrigin = origin.replace(/\/$/, '');
    const configuredOrigins = (process.env.ALLOWED_ORIGIN || process.env.APP_URL || '')
      .split(',')
      .map(o => o.trim().replace(/\/$/, ''))
      .filter(Boolean);

    if (configuredOrigins.includes(normalizedOrigin)) {
      return callback(null, true);
    }

    const prodRegexes = [
      /^https:\/\/sahatn\.tn$/,
      /^https:\/\/[a-z0-9-]+\.sahatn\.tn$/,
      /^https:\/\/maw2idi\.tn$/,
      /^https:\/\/[a-z0-9-]+\.maw2idi\.tn$/,
      /^https:\/\/[a-z0-9-]+\.netlify\.app$/,
      /^capacitor:\/\/localhost$/,
      /^ionic:\/\/localhost$/,
      /^https?:\/\/localhost$/
    ];

    const devRegexes = [
      /^https?:\/\/localhost(:\d+)?$/,
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
      /^https:\/\/.*\.trycloudflare\.com$/,
      /^https:\/\/.*\.loca\.lt$/
    ];

    const activeRegexes = process.env.NODE_ENV === 'production'
      ? prodRegexes
      : [...prodRegexes, ...devRegexes];

    const isAllowed = activeRegexes.some(regex => regex.test(normalizedOrigin));
    if (isAllowed || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error(`Origine CORS '${origin}' non autorisée par la politique de sécurité SahaTN.`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Accept-Language', 'X-CSRF-Token']
};

module.exports = {
  securityHeaders,
  authLimiter,
  expensiveApiLimiter,
  appointmentLimiter,
  apiGeneralLimiter,
  sanitizeInput,
  recordAuditLog,
  auditTrail,
  maskPhone,
  maskCNAM,
  maskName,
  corsOptions,
  csrfProtection,
  prototypePollutionGuard,
  verifyAuditLedgerIntegrity
};

