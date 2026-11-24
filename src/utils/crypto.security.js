/**
 * SahaTN / Maw2idi — Cryptographic Security Utilities
 * 
 * Features:
 * 1. AES-256-GCM Authenticated Encryption for Sensitive Health Records (EHR at Rest)
 * 2. HMAC-SHA256 Anti-CSRF Token Generation & Timing-Safe Verification
 * 3. Password Complexity Enforcement
 * 4. Blockchain-Style Cryptographic Audit Hash Chaining (Merkle Ledger)
 */

const crypto = require('crypto');

// Master Encryption Key (32 bytes / 256 bits)
const MASTER_SECRET = process.env.ENCRYPTION_MASTER_KEY || (
  process.env.NODE_ENV === 'production'
    ? (() => { throw new Error('[FATAL SECURITY] ENCRYPTION_MASTER_KEY must be set in production.'); })()
    : 'sahatn_aes256_medical_confidentiality_master_key_2026_tunisia'
);
const MASTER_KEY = crypto.createHash('sha256').update(MASTER_SECRET).digest();

// Previous keys accepted for DECRYPTION only (rotation). Comma-separated list in ENCRYPTION_MASTER_KEY_PREVIOUS.
const LEGACY_DEFAULT_SECRET = 'sahatn_aes256_medical_confidentiality_master_key_2026_tunisia';
const PREVIOUS_KEYS = [LEGACY_DEFAULT_SECRET, ...String(process.env.ENCRYPTION_MASTER_KEY_PREVIOUS || '').split(',')]
  .map(s => s.trim())
  .filter(s => s && s !== MASTER_SECRET)
  .map(s => crypto.createHash('sha256').update(s).digest());

// ========================================================
// 1. AES-256-GCM FIELD-LEVEL ENCRYPTION (EHR & CONFIDENTIAL DATA)
// ========================================================

/**
 * Encrypts arbitrary data (string, array, or object) with AES-256-GCM
 * Output format: $AES256GCM$<iv_hex>$<authTag_hex>$<ciphertext_hex>
 */
function encryptMedicalField(data) {
  if (data === null || data === undefined) return data;

  try {
    const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
    const iv = crypto.randomBytes(12); // Standard 96-bit IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);

    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `$AES256GCM$${iv.toString('hex')}$${authTag}$${ciphertext}`;
  } catch (err) {
    console.error('[Crypto] Encryption error:', err.message);
    throw new Error('Erreur de chiffrement sécurisé des données médicales.');
  }
}

/**
 * Decrypts an AES-256-GCM encrypted medical string with integrity verification.
 * Automatically detects and returns legacy unencrypted data as-is (backward compatible).
 */
function decryptMedicalField(encryptedValue) {
  if (typeof encryptedValue !== 'string' || !encryptedValue.startsWith('$AES256GCM$')) {
    return encryptedValue; // Unencrypted / legacy data
  }

  try {
    const parts = encryptedValue.split('$');
    if (parts.length !== 5) {
      throw new Error('Format de bloc chiffré invalide.');
    }

    const iv = Buffer.from(parts[2], 'hex');
    const authTag = Buffer.from(parts[3], 'hex');
    const ciphertext = parts[4];

    // Key rotation support: try the current key first, then any previous keys.
    // (The old default key shipped in the source code is kept ONLY to read legacy records;
    //  every new write is encrypted with the current ENCRYPTION_MASTER_KEY.)
    let decrypted = null;
    let lastErr = null;
    for (const key of [MASTER_KEY, ...PREVIOUS_KEYS]) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        decrypted = decipher.update(ciphertext, 'hex', 'utf8') + decipher.final('utf8');
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (decrypted === null) throw lastErr || new Error('Decryption failed');

    try {
      return JSON.parse(decrypted);
    } catch (e) {
      return decrypted;
    }
  } catch (err) {
    console.error('[Crypto] Decryption / Integrity authentication failure:', err.message);
    throw new Error('Alerte de sécurité : Donnée médicale corrompue ou tentative d\'altération.');
  }
}

// ========================================================
// 2. HMAC-SHA256 ANTI-CSRF PROTECTION
// ========================================================

/**
 * Generates an unpredictable cryptographic CSRF token bound to a session/device ID
 */
function generateCsrfToken(identifier = 'anonymous-client') {
  const nonce = crypto.randomBytes(16).toString('hex');
  const timestamp = Date.now();
  const payload = `${identifier}:${nonce}:${timestamp}`;
  const hmac = crypto.createHmac('sha256', MASTER_KEY).update(payload).digest('hex');
  return `${nonce}.${timestamp}.${hmac}`;
}

/**
 * Validates a CSRF token using timing-safe comparison
 */
function verifyCsrfToken(token, identifier = 'anonymous-client', maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!token || typeof token !== 'string') return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [nonce, timestampStr, providedHmac] = parts;
  const timestamp = parseInt(timestampStr, 10);

  // Check token age (default 24h)
  if (isNaN(timestamp) || Date.now() - timestamp > maxAgeMs) {
    return false;
  }

  const payload = `${identifier}:${nonce}:${timestamp}`;
  const expectedHmac = crypto.createHmac('sha256', MASTER_KEY).update(payload).digest('hex');

  try {
    const expectedBuf = Buffer.from(expectedHmac, 'hex');
    const providedBuf = Buffer.from(providedHmac, 'hex');
    if (expectedBuf.length !== providedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  } catch (e) {
    return false;
  }
}

// ========================================================
// 3. PASSWORD COMPLEXITY & ANTI-STUFFING POLICY
// ========================================================

/**
 * Enforces strong password policy for healthcare personnel and patients:
 * - Minimum 8 characters
 * - At least one lowercase letter
 * - At least one uppercase letter
 * - At least one number
 * - At least one special symbol
 */
function validatePasswordStrength(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, message: 'Mot de passe manquant.' };
  }

  if (password.length < 8) {
    return { valid: false, message: 'Le mot de passe doit comporter au moins 8 caractères.' };
  }

  if (!/[a-z]/.test(password)) {
    return { valid: false, message: 'Le mot de passe doit contenir au moins une lettre minuscule.' };
  }

  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'Le mot de passe doit contenir au moins une lettre majuscule.' };
  }

  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Le mot de passe doit contenir au moins un chiffre.' };
  }

  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(password)) {
    return { valid: false, message: 'Le mot de passe doit contenir au moins un caractère spécial (!@#$%...).' };
  }

  return { valid: true };
}

// ========================================================
// 4. CRYPTOGRAPHIC MERKLE / AUDIT HASH CHAINING
// ========================================================

const GENESIS_AUDIT_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Computes SHA-256 block hash for an audit log entry chained to previous hash
 */
function computeAuditBlockHash(entry, previousHash = GENESIS_AUDIT_HASH) {
  const content = [
    previousHash,
    entry.timestamp || '',
    entry.action || '',
    entry.actor?.id || '',
    entry.actor?.role || '',
    entry.resource?.id || '',
    entry.status || '',
    entry.clientIp || ''
  ].join('|');

  return crypto.createHash('sha256').update(content).digest('hex');
}

module.exports = {
  encryptMedicalField,
  decryptMedicalField,
  generateCsrfToken,
  verifyCsrfToken,
  validatePasswordStrength,
  computeAuditBlockHash,
  GENESIS_AUDIT_HASH
};
