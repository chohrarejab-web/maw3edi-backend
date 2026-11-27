/**
 * SahaTN / Maw2idi — Firebase Cloud Messaging (FCM) Push Notification Service
 * Sends native Android/iOS background push notifications when users or doctors are logged in.
 * Automatically removes invalid/expired tokens and uses multicast batching (zero N+1).
 */

const postgres = require('../config/postgres');
const db = require('../config/database');

let messaging = null;
let lastInitError = null;

function initFirebaseAdmin() {
  if (messaging) return messaging;

  const rawCred = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!rawCred || !rawCred.trim()) {
    lastInitError = 'FIREBASE_SERVICE_ACCOUNT_JSON not set';
    return null;
  }

  try {
    const { initializeApp, getApps, getApp, cert } = require('firebase-admin/app');
    const { getMessaging } = require('firebase-admin/messaging');

    let serviceAccount;
    let trimmed = rawCred.trim();
    // Strip accidental outer quotes from env var UI
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      trimmed = trimmed.slice(1, -1).trim();
    }
    if (trimmed.startsWith('{')) {
      try {
        serviceAccount = JSON.parse(trimmed);
      } catch {
        // Handle literal newlines pasted inside private_key in Railway Variables UI
        serviceAccount = JSON.parse(trimmed.replace(/\r?\n/g, '\\n'));
      }
    } else {
      serviceAccount = JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8'));
    }

    if (serviceAccount && typeof serviceAccount.private_key === 'string') {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    const app = getApps().length
      ? getApp()
      : initializeApp({ credential: cert(serviceAccount) });

    messaging = getMessaging(app);
    lastInitError = null;
    console.log('✅ [FCM] Firebase Admin Messaging initialized.');
  } catch (err) {
    lastInitError = err.message;
    console.error('[FCM] Failed to initialize Firebase Admin:', err.message);
    messaging = null;
  }

  return messaging;
}

function getMemoryTokens() {
  if (!Array.isArray(db.data.deviceTokens)) {
    db.data.deviceTokens = [];
  }
  return db.data.deviceTokens;
}

async function registerDeviceToken({ fcmToken, userId, role = 'PATIENT', doctorId = null, lang = 'fr', platform = 'android' }) {
  if (!fcmToken || !userId) return false;
  const nowIso = new Date().toISOString();

  // 1. Update in-memory list
  const list = getMemoryTokens();
  const idx = list.findIndex(t => t.fcmToken === fcmToken);
  const record = { fcmToken, userId, role, doctorId: doctorId || null, lang: lang || 'fr', platform: platform || 'android', updatedAt: nowIso };
  if (idx !== -1) list[idx] = record;
  else list.unshift(record);
  db.save();

  // 2. Persist in PostgreSQL
  if (postgres.isPostgresConnected()) {
    await postgres.query(
      `INSERT INTO device_tokens (fcm_token, user_id, role, doctor_id, lang, platform, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (fcm_token) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         role = EXCLUDED.role,
         doctor_id = EXCLUDED.doctor_id,
         lang = EXCLUDED.lang,
         platform = EXCLUDED.platform,
         updated_at = EXCLUDED.updated_at;`,
      [fcmToken, userId, role, doctorId || null, lang || 'fr', platform || 'android', nowIso]
    ).catch(err => console.warn('[FCM] DB register error:', err.message));
  }

  return true;
}

async function unregisterDeviceToken({ fcmToken, userId }) {
  if (!fcmToken && !userId) return false;

  const list = getMemoryTokens();
  db.data.deviceTokens = list.filter(t => {
    if (fcmToken && t.fcmToken === fcmToken) return false;
    if (!fcmToken && userId && t.userId === userId) return false;
    return true;
  });
  db.save();

  if (postgres.isPostgresConnected()) {
    if (fcmToken) {
      await postgres.query('DELETE FROM device_tokens WHERE fcm_token = $1;', [fcmToken])
        .catch(err => console.warn('[FCM] DB unregister error:', err.message));
    } else if (userId) {
      await postgres.query('DELETE FROM device_tokens WHERE user_id = $1;', [userId])
        .catch(err => console.warn('[FCM] DB unregister by user error:', err.message));
    }
  }

  return true;
}

async function getTargetTokensForNotification(notif) {
  const { space, doctorId, patientId, userId } = notif || {};
  const pid = patientId || userId || null;

  if (postgres.isPostgresConnected()) {
    try {
      if ((space === 'doctor' || space === 'secretaire') && doctorId) {
        const res = await postgres.query(
          'SELECT fcm_token FROM device_tokens WHERE doctor_id = $1 OR user_id = $1;',
          [doctorId]
        );
        return res.rows.map(r => r.fcm_token);
      }
      if (space === 'patient' && pid) {
        const res = await postgres.query('SELECT fcm_token FROM device_tokens WHERE user_id = $1;', [pid]);
        return res.rows.map(r => r.fcm_token);
      }
      return [];
    } catch (err) {
      console.warn('[FCM] DB lookup failed, falling back to memory:', err.message);
    }
  }

  const list = getMemoryTokens();
  if ((space === 'doctor' || space === 'secretaire') && doctorId) {
    return list.filter(t => t.doctorId === doctorId || t.userId === doctorId).map(t => t.fcmToken);
  }
  if (space === 'patient' && pid) {
    return list.filter(t => t.userId === pid).map(t => t.fcmToken);
  }
  return [];
}

async function getPushStatus({ userId = null, doctorId = null } = {}) {
  const fcm = initFirebaseAdmin();
  let totalDevices = getMemoryTokens().length;
  let userDevices = 0;

  if (postgres.isPostgresConnected()) {
    try {
      const totalRes = await postgres.query('SELECT COUNT(*)::int AS cnt FROM device_tokens;');
      totalDevices = totalRes.rows[0]?.cnt ?? 0;
      if (userId || doctorId) {
        const uRes = await postgres.query(
          'SELECT COUNT(*)::int AS cnt FROM device_tokens WHERE user_id = $1 OR ($2::text IS NOT NULL AND doctor_id = $2);',
          [userId || '', doctorId || null]
        );
        userDevices = uRes.rows[0]?.cnt ?? 0;
      }
    } catch (err) {
      console.warn('[FCM] Status query error:', err.message);
    }
  } else if (userId || doctorId) {
    userDevices = getMemoryTokens().filter(t => t.userId === userId || (doctorId && t.doctorId === doctorId)).length;
  }

  return {
    firebaseConfigured: Boolean(fcm),
    initError: fcm ? null : lastInitError,
    totalDevices,
    userDevices
  };
}

async function sendPushForNotification(notif) {
  const fcm = initFirebaseAdmin();
  if (!fcm || !notif) return;

  const tokens = Array.from(new Set(await getTargetTokensForNotification(notif))).filter(Boolean);
  if (tokens.length === 0) return;

  const targetRoute = notif.actionUrl || (notif.space === 'doctor' ? '/doctor/dashboard' : '/patient/dashboard');

  // Batch multicast (up to 500 tokens per FCM call — zero N+1)
  const chunkSize = 500;
  const invalidTokens = [];

  for (let i = 0; i < tokens.length; i += chunkSize) {
    const chunk = tokens.slice(i, i + chunkSize);
    try {
      const response = await fcm.sendEachForMulticast({
        tokens: chunk,
        notification: {
          title: String(notif.title || 'Maw2idi').slice(0, 120),
          body: String(notif.message || '').slice(0, 240)
        },
        data: {
          notificationId: String(notif.id || ''),
          category: String(notif.category || 'system'),
          space: String(notif.space || 'patient'),
          route: String(targetRoute)
        },
        android: {
          priority: 'high',
          ttl: 3600 * 1000,
          notification: {
            channelId: notif.category === 'queue' || notif.category === 'rdv' ? 'maw2idi_urgent' : 'maw2idi_general',
            sound: 'default',
            defaultSound: true,
            defaultVibrateTimings: true,
            visibility: 'public'
          }
        }
      });

      response.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error?.code || '';
          if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
            invalidTokens.push(chunk[idx]);
          }
        }
      });
    } catch (err) {
      console.warn('[FCM] Multicast send failed:', err.message);
    }
  }

  // Clean up expired/uninstalled device tokens in 1 single batch query
  if (invalidTokens.length > 0) {
    const invalidSet = new Set(invalidTokens);
    db.data.deviceTokens = getMemoryTokens().filter(t => !invalidSet.has(t.fcmToken));
    db.save();
    if (postgres.isPostgresConnected()) {
      postgres.query('DELETE FROM device_tokens WHERE fcm_token = ANY($1::text[]);', [invalidTokens])
        .catch(() => {});
    }
  }
}

module.exports = {
  registerDeviceToken,
  unregisterDeviceToken,
  sendPushForNotification,
  initFirebaseAdmin,
  getPushStatus
};
