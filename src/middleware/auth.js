const jwt = require('jsonwebtoken');
const db = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || (
  process.env.NODE_ENV === 'production'
    ? (() => { throw new Error('[FATAL SECURITY] JWT_SECRET must be set in production.'); })()
    : 'sahatn_jwt_super_secret_production_key_2026'
);

// In-memory set for fast token blacklist checks
const revokedTokensSet = new Set();

function isTokenRevoked(token) {
  if (!token) return true;
  if (revokedTokensSet.has(token)) return true;
  // Also check database for persistence across reboots
  const inDb = db.findOne('revokedTokens', r => r.token === token);
  if (inDb) {
    revokedTokensSet.add(token);
    return true;
  }
  return false;
}

function revokeToken(token, reason = 'LOGOUT') {
  if (!token) return;
  revokedTokensSet.add(token);
  try {
    db.insert('revokedTokens', {
      token,
      revokedAt: new Date().toISOString(),
      reason
    });
  } catch (e) {
    console.error('[Auth] Failed to persist revoked token:', e.message);
  }
}

function generateToken(user) {
  return jwt.sign(
    {
      uuid: user.uuid,
      email: user.email,
      name: user.name,
      role: user.role,
      doctorId: user.doctorId || null
    },
    JWT_SECRET,
    {
      expiresIn: '7d',
      algorithm: 'HS256'
    }
  );
}

function parseCookieHeader(cookieHeader) {
  const list = {};
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

function verifyToken(req, res, next) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
  } else if (req.headers['cookie']) {
    const cookies = parseCookieHeader(req.headers['cookie']);
    token = cookies['sahatn_admin_token'] || cookies['sahatn_auth_token'];
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Accès refusé. Aucun jeton fourni.' });
  }

  // 1. Check blacklist
  if (isTokenRevoked(token)) {
    return res.status(401).json({
      success: false,
      error: 'TOKEN_REVOKED',
      message: 'Ce jeton de session a été révoqué (déconnexion effectuée). Veuillez vous reconnecter.'
    });
  }

  // 2. Cryptographic signature and algorithm verification
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.user = decoded;
    req.token = token;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Jeton JWT invalide ou expiré.' });
  }
}

function optionalToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    if (!isTokenRevoked(token)) {
      try {
        req.user = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        req.token = token;
      } catch (e) {}
    }
  }
  next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentification requise.' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Accès interdit pour le rôle '${req.user.role}'. Rôles autorisés: ${allowedRoles.join(', ')}`
      });
    }
    next();
  };
}

module.exports = {
  generateToken,
  verifyToken,
  optionalToken,
  requireRole,
  revokeToken,
  isTokenRevoked,
  JWT_SECRET
};
