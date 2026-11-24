/**
 * SahaTN / Maw2idi — Security Monitoring & Suspicious Activity Alerting Service
 * Tracks repeated auth failures (401/403 bursts), account lockouts, 5xx errors,
 * and dispatches structured JSON logs + throttled email/webhook alerts.
 */

const EmailService = require('./email.service');

const WINDOW_MS = 5 * 60 * 1000;       // 5-minute sliding window
const COOLDOWN_MS = 15 * 60 * 1000;    // 15-minute cooldown per alert key
const AUTH_BURST_THRESHOLD = 10;       // 10+ 401/403 responses from one IP in 5 mins
const ERROR_5XX_THRESHOLD = 10;        // 10+ 5xx responses in 5 mins

const ipAuthFailures = new Map();      // ip -> number[] timestamps
const server5xxTimestamps = [];        // number[] timestamps
const lastAlertSentAt = new Map();     // alertKey -> timestamp

function pruneOld(arr, now) {
  while (arr.length > 0 && now - arr[0] > WINDOW_MS) {
    arr.shift();
  }
}

function logStructuredSecurityEvent(severity, type, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: severity,
    channel: 'SECURITY_MONITOR',
    type,
    ...details
  };
  if (severity === 'CRITICAL' || severity === 'HIGH') {
    console.error('[SECURITY_ALERT]', JSON.stringify(entry));
  } else {
    console.warn('[SECURITY_EVENT]', JSON.stringify(entry));
  }
  return entry;
}

async function dispatchAlert(alertKey, severity, title, details = {}) {
  const now = Date.now();
  const prev = lastAlertSentAt.get(alertKey) || 0;
  if (now - prev < COOLDOWN_MS) return false;
  lastAlertSentAt.set(alertKey, now);

  const event = logStructuredSecurityEvent(severity, alertKey, { title, ...details });

  // 1. Optional Webhook (Slack / Discord / SIEM)
  const webhookUrl = process.env.SECURITY_WEBHOOK_URL;
  if (webhookUrl && /^https:\/\//.test(webhookUrl)) {
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `[${severity}] SahaTN Security Alert: ${title}\n${JSON.stringify(details)}`,
        event
      }),
      signal: AbortSignal.timeout(5000)
    }).catch(err => console.warn('[SecurityAlert] Webhook failed:', err.message));
  }

  // 2. Email alert to security admin in production (or when SECURITY_ALERT_EMAIL is set)
  const alertEmail = process.env.SECURITY_ALERT_EMAIL || (process.env.NODE_ENV === 'production' ? process.env.GMAIL_USER : null);
  if (alertEmail) {
    const alertSubject = `🚨 [${severity}] Alerte Sécurité SahaTN : ${title}`;
    EmailService.deliverEmail({
      to: alertEmail,
      subject: alertSubject,
      html: EmailService.renderEmailLayout({
        title: alertSubject,
        badge: `🚨 Alerte Sécurité · ${severity}`,
        badgeTone: 'danger',
        heading: EmailService.escapeHtml(title),
        subtitle: 'Notification automatique du moniteur de sécurité Maw2idi / SahaTN',
        bodyHtml: `
          ${EmailService.renderCallout({
            tone: 'rose',
            title: `Événement détecté (${EmailService.escapeHtml(severity)})`,
            bodyHtml: `<pre style="margin: 0; font-family: 'Courier New', Courier, monospace; font-size: 11.5px; white-space: pre-wrap; word-break: break-word;">${EmailService.escapeHtml(JSON.stringify(event, null, 2))}</pre>`
          })}`
      }),
      text: `[${severity}] ${title} - ${JSON.stringify(event)}`
    }).catch(() => {});
  }

  return true;
}

function recordSecurityAlert(type, severity, title, details = {}) {
  return dispatchAlert(type, severity, title, details);
}

/**
 * Express middleware that observes 401/403 spikes per IP and 5xx bursts
 */
function securityMonitorMiddleware(req, res, next) {
  res.on('finish', () => {
    const now = Date.now();
    const ip = (req.headers['cf-connecting-ip'] ||
                req.headers['x-forwarded-for']?.split(',')[0].trim() ||
                req.socket?.remoteAddress ||
                '127.0.0.1').replace(/^.*:/, '');

    if (res.statusCode === 401 || res.statusCode === 403) {
      let arr = ipAuthFailures.get(ip);
      if (!arr) {
        arr = [];
        ipAuthFailures.set(ip, arr);
      }
      arr.push(now);
      pruneOld(arr, now);

      if (arr.length >= AUTH_BURST_THRESHOLD) {
        dispatchAlert(
          `AUTH_BURST:${ip}`,
          'HIGH',
          `Pic d'erreurs 401/403 détecté depuis ${ip}`,
          { ip, countIn5Min: arr.length, lastPath: req.originalUrl, method: req.method }
        );
      }
    } else if (res.statusCode >= 500) {
      server5xxTimestamps.push(now);
      pruneOld(server5xxTimestamps, now);
      if (server5xxTimestamps.length >= ERROR_5XX_THRESHOLD) {
        dispatchAlert(
          'SERVER_5XX_BURST',
          'HIGH',
          'Pic d\'erreurs serveur 5xx détecté',
          { countIn5Min: server5xxTimestamps.length, lastPath: req.originalUrl, status: res.statusCode }
        );
      }
    }
  });

  next();
}

// Periodic cleanup to avoid unbounded map growth
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of ipAuthFailures.entries()) {
    pruneOld(arr, now);
    if (arr.length === 0) ipAuthFailures.delete(ip);
  }
}, WINDOW_MS);
if (cleanupTimer.unref) cleanupTimer.unref();

module.exports = {
  securityMonitorMiddleware,
  recordSecurityAlert,
  logStructuredSecurityEvent
};
