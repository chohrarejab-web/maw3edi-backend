/**
 * SahaTN / Maw2idi — Secure File Storage Utility
 * Validates MIME types & sizes, prevents path traversal, and stores uploaded
 * doctor documents / avatars / signatures on disk instead of bloating the DB.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'uploads');
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB max per file

const ALLOWED_MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf'
};

const ALLOWED_CATEGORIES = new Set(['avatars', 'signatures', 'cv', 'documents', 'receipts']);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Persists a base64 Data URI safely to disk and returns its serving URL.
 * If the input is already a URL/path (not a data URI), returns it untouched.
 */
function persistDataUri(dataUri, category = 'documents') {
  if (!dataUri || typeof dataUri !== 'string') return null;
  if (!dataUri.startsWith('data:')) return dataUri;

  if (!ALLOWED_CATEGORIES.has(category)) {
    throw new Error('Catégorie de fichier non autorisée.');
  }

  const match = dataUri.match(/^data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) {
    throw new Error('Format de fichier encodé invalide.');
  }

  const mimeType = match[1].toLowerCase();
  const ext = ALLOWED_MIME_TO_EXT[mimeType];
  if (!ext) {
    throw new Error(`Type de fichier non autorisé (${mimeType}). Formats acceptés : JPG, PNG, WEBP, PDF.`);
  }

  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (buffer.length === 0 || buffer.length > MAX_FILE_BYTES) {
    throw new Error(`Taille de fichier invalide (maximum ${MAX_FILE_BYTES / (1024 * 1024)} Mo).`);
  }

  const targetDir = path.join(UPLOADS_ROOT, category);
  ensureDir(targetDir);

  const safeName = `${Date.now()}_${crypto.randomBytes(12).toString('hex')}.${ext}`;
  const fullPath = path.join(targetDir, safeName);
  fs.writeFileSync(fullPath, buffer);

  return `/api/uploads/${category}/${safeName}`;
}

function resolveUploadPath(category, filename) {
  if (!ALLOWED_CATEGORIES.has(category)) return null;
  if (!/^[a-zA-Z0-9_-]+\.(jpg|png|webp|pdf)$/.test(filename)) return null;
  const resolved = path.resolve(UPLOADS_ROOT, category, filename);
  if (!resolved.startsWith(path.resolve(UPLOADS_ROOT))) return null;
  return resolved;
}

module.exports = {
  persistDataUri,
  resolveUploadPath,
  MAX_FILE_BYTES,
  ALLOWED_CATEGORIES
};
