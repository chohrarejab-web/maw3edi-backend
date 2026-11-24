/**
 * SahaTN / Maw2idi — Strict Server-Side Input Validation Middleware
 * Declarative schema validation for all API forms & mutations.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}[:hH]\d{2}$/;

function validateField(name, value, rule) {
  const isMissing = value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

  if (isMissing) {
    if (rule.required) {
      return rule.message || `Le champ '${name}' est requis.`;
    }
    return null;
  }

  if (rule.type === 'string') {
    if (typeof value !== 'string') return `Le champ '${name}' doit être une chaîne de caractères.`;
    const trimmed = value.trim();
    if (rule.minLen !== undefined && trimmed.length < rule.minLen) {
      return `Le champ '${name}' doit contenir au moins ${rule.minLen} caractère(s).`;
    }
    if (rule.maxLen !== undefined && trimmed.length > rule.maxLen) {
      return `Le champ '${name}' ne doit pas dépasser ${rule.maxLen} caractères.`;
    }
    if (rule.email && !EMAIL_RE.test(trimmed)) {
      return `Le champ '${name}' doit être une adresse email valide.`;
    }
    if (rule.isoDate && !ISO_DATE_RE.test(trimmed)) {
      return `Le champ '${name}' doit être au format YYYY-MM-DD.`;
    }
    if (rule.time && !TIME_RE.test(trimmed)) {
      return `Le champ '${name}' doit être une heure valide (ex: 09:30).`;
    }
    if (rule.pattern && !rule.pattern.test(trimmed)) {
      return rule.message || `Format invalide pour le champ '${name}'.`;
    }
  } else if (rule.type === 'number') {
    const num = Number(value);
    if (Number.isNaN(num) || !Number.isFinite(num)) {
      return `Le champ '${name}' doit être un nombre valide.`;
    }
    if (rule.min !== undefined && num < rule.min) {
      return `Le champ '${name}' doit être supérieur ou égal à ${rule.min}.`;
    }
    if (rule.max !== undefined && num > rule.max) {
      return `Le champ '${name}' doit être inférieur ou égal à ${rule.max}.`;
    }
  } else if (rule.type === 'array') {
    if (!Array.isArray(value)) return `Le champ '${name}' doit être une liste.`;
    if (rule.minLen !== undefined && value.length < rule.minLen) {
      return `Le champ '${name}' doit contenir au moins ${rule.minLen} élément(s).`;
    }
    if (rule.maxLen !== undefined && value.length > rule.maxLen) {
      return `Le champ '${name}' ne doit pas dépasser ${rule.maxLen} éléments.`;
    }
  } else if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') return `Le champ '${name}' doit être un booléen.`;
  }

  if (Array.isArray(rule.enum) && !rule.enum.includes(value)) {
    return `Valeur non autorisée pour '${name}'. Valeurs acceptées : ${rule.enum.join(', ')}.`;
  }

  return null;
}

/**
 * Express middleware factory for strict request body validation
 * @param {Record<string, object>} schema
 */
function validateBody(schema) {
  return (req, res, next) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Corps de requête JSON invalide.'
      });
    }

    const errors = [];
    for (const [field, rule] of Object.entries(schema)) {
      const err = validateField(field, req.body[field], rule);
      if (err) errors.push({ field, message: err });
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: errors[0].message,
        details: errors
      });
    }

    next();
  };
}

module.exports = {
  validateBody
};
