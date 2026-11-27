const express = require('express');
const db = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const pushService = require('../services/push.service');

const router = express.Router();

// Helper to push a notification from any backend route and broadcast live via Socket.io
function broadcastNotification(io, {
  space = 'all',
  icon = '🔔',
  title = '',
  message = '',
  category = 'system',
  actionUrl = null,
  doctorId = null,
  doctorName = null,
  patientId = null,
  patientName = null,
  userId = null
}) {
  const now = new Date();
  const timeMs = Date.now();
  const timeStr = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const dateStr = now.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeWithSec = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const newNotif = {
    id: 'notif-' + timeMs + '-' + Math.floor(Math.random() * 1000),
    space: space || 'all',
    category: category || 'system',
    icon: icon || '🔔',
    title: title || 'Nouvelle notification',
    message: message || '',
    timestamp: "Aujourd'hui " + timeStr,
    exactTime: timeStr,
    fullTimestamp: dateStr + ' à ' + timeWithSec,
    timeMs: timeMs,
    createdAt: now.toISOString(),
    read: false,
    actionUrl: actionUrl || null,
    doctorId: doctorId || null,
    doctorName: doctorName || null,
    patientId: patientId || null,
    patientName: patientName || null,
    userId: userId || null
  };

  if (!db.data.notifications) {
    db.data.notifications = [];
  }
  db.data.notifications.unshift(newNotif);
  db.save();

  if (io) {
    // Targeted room emission strictly per actor/space (avoids 1000-user broadcast storms)
    if (space === 'doctor' && doctorId) {
      io.to(`doctor:${doctorId}`).to(`cabinet:${doctorId}`).to('admin').emit('notif:new', newNotif);
      io.to(`doctor:${doctorId}`).to(`cabinet:${doctorId}`).to('admin').emit('notif:broadcast', newNotif);
    } else if (space === 'patient' && (patientId || userId)) {
      const pid = patientId || userId;
      io.to(`patient:${pid}`).to('admin').emit('notif:new', newNotif);
      io.to(`patient:${pid}`).to('admin').emit('notif:broadcast', newNotif);
    } else if (space === 'secretaire' && doctorId) {
      io.to(`doctor:${doctorId}`).to(`secretaire:${doctorId}`).to('admin').emit('notif:new', newNotif);
      io.to(`doctor:${doctorId}`).to(`secretaire:${doctorId}`).to('admin').emit('notif:broadcast', newNotif);
    } else {
      io.to('admin').emit('notif:new', newNotif);
    }
  }

  // Trigger background Firebase Cloud Messaging (FCM) push to logged-in mobile devices
  pushService.sendPushForNotification(newNotif).catch(() => {});

  return newNotif;
}

// POST /api/notifications/register-device - Register phone FCM token for logged-in user/doctor
router.post('/register-device', verifyToken, async (req, res) => {
  try {
    const fcmToken = String(req.body?.fcmToken || '').trim();
    if (!fcmToken || fcmToken.length < 20) {
      return res.status(400).json({ success: false, message: 'Jeton FCM invalide.' });
    }
    const userId = req.user?.uuid || req.user?.id;
    const role = (req.user?.role || 'PATIENT').toUpperCase();
    const doctorId = req.user?.doctorId || req.body?.doctorId || null;
    const lang = req.body?.lang === 'ar' ? 'ar' : 'fr';
    const platform = String(req.body?.platform || 'android').slice(0, 32);

    await pushService.registerDeviceToken({ fcmToken, userId, role, doctorId, lang, platform });
    return res.json({ success: true, message: 'Appareil enregistré pour les notifications push.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/notifications/register-device - Unregister phone FCM token on logout
router.delete('/register-device', verifyToken, async (req, res) => {
  try {
    const fcmToken = req.body?.fcmToken ? String(req.body.fcmToken).trim() : null;
    const userId = req.user?.uuid || req.user?.id;
    await pushService.unregisterDeviceToken({ fcmToken, userId });
    return res.json({ success: true, message: 'Notifications push désactivées sur cet appareil.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/notifications - Fetch synchronized notifications (Requires authentication)
router.get('/', verifyToken, (req, res) => {
  try {
    const { space, category, unread, doctorId, doctorName, patientId, userId } = req.query;
    const role = (req.user?.role || '').toUpperCase();
    const isAdmin = role === 'ADMIN' || role === 'SUPER_ADMIN';
    if (space === 'admin' && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs.' });
    }
    let list = db.data.notifications || [];

    if (space && space !== 'all') {
      list = list.filter(n => n.space === space || n.space === 'public' || n.space === 'all');
    }
    if (category && category !== 'all') {
      list = list.filter(n => n.category === category);
    }
    if (unread === 'true') {
      list = list.filter(n => !n.read);
    }

    // Specific doctor actor filtering: Never leak notifications belonging to other doctors!
    if (space === 'doctor' || doctorId || doctorName) {
      const activeDocId = doctorId || null;
      const activeDocName = (doctorName || '').toLowerCase().replace(/^(dr\.?|docteur)\s*/i, '').trim();

      if (activeDocId || activeDocName) {
        list = list.filter(n => {
          // If notification explicitly has another doctor's ID, reject immediately
          if (n.doctorId && activeDocId && n.doctorId !== activeDocId) {
            return false;
          }
          // If notification explicitly has another doctor's name, reject immediately
          if (n.doctorName && activeDocName) {
            const nDoc = n.doctorName.toLowerCase().replace(/^(dr\.?|docteur)\s*/i, '').trim();
            if (nDoc && !nDoc.includes(activeDocName) && !activeDocName.includes(nDoc)) {
              return false;
            }
          }
          // In doctor space, doctor-specific items (patient RDV, avis, queue, liaison) MUST belong to this doctor
          const isDoctorSpecificCategory = n.category === 'patient' || n.category === 'rdv' || n.category === 'avis' || n.category === 'queue' || n.category === 'liaison';
          const hasRdvTitle = n.title && (n.title.includes('Rendez-vous') || n.title.includes('RDV') || n.title.includes('Avis') || n.title.includes('Salle d\'Attente'));
          if ((isDoctorSpecificCategory || hasRdvTitle) && n.space === 'doctor') {
            if (n.doctorId && activeDocId && n.doctorId !== activeDocId) {
              return false;
            }
            if (!n.doctorId && !n.doctorName && activeDocId && activeDocId !== 'doc-1') {
              return false;
            }
          }
          // Exclude welcome/activation messages intended for other doctors
          if (n.title === 'Compte Praticien Activé' || (n.message && n.message.includes('Bienvenue Dr.'))) {
            const msg = (n.message || '').toLowerCase();
            if (activeDocName && !msg.includes(activeDocName)) {
              return false;
            }
            if (activeDocId && n.doctorId && n.doctorId !== activeDocId) {
              return false;
            }
          }
          return true;
        });
      } else {
        // If doctor identity is unspecified, do not leak private doctor activations or doctor-specific RDVs
        list = list.filter(n => {
          if (n.doctorId) return false;
          if (n.category === 'patient' || n.category === 'rdv' || n.category === 'avis' || (n.title && (n.title.includes('Rendez-vous') || n.title.includes('RDV')))) {
            return false;
          }
          if (n.title === 'Compte Praticien Activé' || (n.message && n.message.includes('Bienvenue Dr.'))) {
            return false;
          }
          return true;
        });
      }
    }

    // Specific patient actor filtering:
    if (space === 'patient' && (patientId || userId)) {
      const pid = patientId || userId;
      const patientUser = (db.data.users || []).find(u => u.uuid === pid || u.id === pid);
      const clearedAtMs = patientUser?.notifsClearedAt ? new Date(patientUser.notifsClearedAt).getTime() : 0;

      list = list.filter(n => {
        if (n.patientId && n.patientId !== pid) return false;
        if (n.userId && n.userId !== pid) return false;
        // If broadcast notification and patient previously cleared history:
        if (!n.patientId && !n.userId && clearedAtMs > 0) {
          let nMs = n.timeMs;
          if (!nMs && n.createdAt) nMs = new Date(n.createdAt).getTime();
          if (nMs && nMs <= clearedAtMs) return false;
        }
        return true;
      });
    }

    const unreadCount = list.reduce((acc, n) => acc + (n.read ? 0 : 1), 0);

    // Cap returned notifications to prevent O(N) serialization/formatting spikes under 1000+ concurrent users
    const requestedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 500) : 100;
    const slicedList = list.slice(0, limit);

    // Hoist date comparisons & fast formatting outside loop (avoids 4x Intl.DateTimeFormat per item)
    const FR_SHORT_MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
    const now = new Date();
    const nowY = now.getFullYear();
    const nowM = now.getMonth();
    const nowD = now.getDate();
    const yesterday = new Date(nowY, nowM, nowD - 1);
    const yY = yesterday.getFullYear();
    const yM = yesterday.getMonth();
    const yD = yesterday.getDate();
    const pad2 = (v) => (v < 10 ? '0' + v : String(v));

    const enrichedList = slicedList.map(n => {
      let ms = n.timeMs;
      if (!ms && n.id) {
        const m = n.id.match(/notif-(\d+)/);
        if (m) ms = Number(m[1]);
      }
      if (!ms && n.createdAt) {
        const t = new Date(n.createdAt).getTime();
        if (!isNaN(t)) ms = t;
      }
      if (!ms) return n;

      const d = new Date(ms);
      if (isNaN(d.getTime())) return n;

      const dY = d.getFullYear();
      const dM = d.getMonth();
      const dD = d.getDate();
      const hh = pad2(d.getHours());
      const mm = pad2(d.getMinutes());
      const ss = pad2(d.getSeconds());
      const timeStr = `${hh}:${mm}`;
      const timeWithSec = `${hh}:${mm}:${ss}`;
      const fullDateStr = `${pad2(dD)}/${pad2(dM + 1)}/${dY}`;

      let computedTimestamp;
      if (dY === nowY && dM === nowM && dD === nowD) {
        computedTimestamp = `Aujourd'hui ${timeStr}`;
      } else if (dY === yY && dM === yM && dD === yD) {
        computedTimestamp = `Hier ${timeStr}`;
      } else {
        computedTimestamp = `${pad2(dD)} ${FR_SHORT_MONTHS[dM]} ${timeStr}`;
      }

      return {
        ...n,
        timeMs: ms,
        exactTime: timeStr,
        fullTimestamp: `${fullDateStr} à ${timeWithSec}`,
        timestamp: computedTimestamp
      };
    });

    res.json({
      success: true,
      count: enrichedList.length,
      totalCount: list.length,
      unreadCount,
      data: enrichedList,
      notifications: enrichedList
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur lors de la récupération des notifications: ' + err.message });
  }
});

// POST /api/notifications - Create and broadcast notification (Staff/Admin only)
router.post('/', verifyToken, requireRole('DOCTOR', 'PRATICIEN', 'SECRETAIRE', 'SECRETARY', 'ADMIN', 'SUPER_ADMIN'), (req, res) => {
  try {
    const { space, category, icon, title, message, actionUrl, doctorId, doctorName, patientId, patientName, userId } = req.body;
    if (!title) {
      return res.status(400).json({ success: false, message: 'Le titre de la notification est requis.' });
    }

    const io = req.app.get('io');
    const newNotif = broadcastNotification(io, { space, category, icon, title, message, actionUrl, doctorId, doctorName, patientId, patientName, userId });

    res.status(201).json({
      success: true,
      message: 'Notification créée et diffusée en temps réel.',
      notification: newNotif
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur lors de la création de la notification: ' + err.message });
  }
});

// PATCH /api/notifications/:id/read - Mark single notification as read or unread (Authenticated)
router.patch('/:id/read', verifyToken, (req, res) => {
  try {
    const { id } = req.params;
    const read = req.body?.read !== undefined ? Boolean(req.body.read) : true;
    const list = db.data.notifications || [];
    const target = list.find(n => n.id === id);

    if (target) {
      target.read = read;
      db.save();
      db.syncToPostgres('notifications', 'update', target);

      const io = req.app.get('io');
      if (io) {
        const payload = { action: 'read', id, read };
        if (target.doctorId) io.to(`doctor:${target.doctorId}`).emit('notif:update', payload);
        else if (target.patientId || target.userId) io.to(`patient:${target.patientId || target.userId}`).emit('notif:update', payload);
        else io.to('admin').emit('notif:update', payload);
      }
      return res.json({ success: true, message: read ? 'Notification marquée comme lue.' : 'Notification marquée comme non lue.' });
    }

    res.status(404).json({ success: false, message: 'Notification introuvable.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur: ' + err.message });
  }
});

// POST /api/notifications/mark-all-read - Mark all notifications as read or unread (Authenticated)
router.post(['/mark-all-read', '/mark-all-unread'], verifyToken, (req, res) => {
  try {
    const isUnreadRoute = req.path.includes('unread');
    const read = req.body?.read !== undefined ? Boolean(req.body.read) : !isUnreadRoute;
    const { space, doctorId, doctorName } = req.body || {};
    const patientId = req.body?.patientId || req.user?.uuid || req.user?.id;
    const list = db.data.notifications || [];

    const activeDocName = (doctorName || '').toLowerCase().replace(/^(dr\.?|docteur)\s*/i, '').trim();

    const updatedIds = [];
    list.forEach(n => {
      const spaceMatch = !space || space === 'all' || n.space === 'all' || n.space === 'public' || n.space === space;
      if (!spaceMatch) return;

      if (space === 'doctor' && (doctorId || activeDocName)) {
        if (n.doctorId && doctorId && n.doctorId !== doctorId) return;
        if (n.doctorName && activeDocName) {
          const nDoc = n.doctorName.toLowerCase().replace(/^(dr\.?|docteur)\s*/i, '').trim();
          if (nDoc && !nDoc.includes(activeDocName) && !activeDocName.includes(nDoc)) return;
        }
        if (n.title === 'Compte Praticien Activé' || (n.message && n.message.includes('Bienvenue Dr.'))) {
          const msg = (n.message || '').toLowerCase();
          if (activeDocName && !msg.includes(activeDocName)) return;
          if (doctorId && n.doctorId && n.doctorId !== doctorId) return;
        }
      }

      if (space === 'patient' && patientId) {
        if (n.patientId && n.patientId !== patientId) return;
        if (n.userId && n.userId !== patientId) return;
      }

      if (n.read !== read) {
        n.read = read;
        if (n.id) updatedIds.push(n.id);
      }
    });
    db.save();

    // Single batch SQL update instead of N queries
    if (updatedIds.length > 0 && db.isPostgresConnected && db.isPostgresConnected()) {
      db.query('UPDATE notifications SET read = $1 WHERE id = ANY($2::text[]);', [read, updatedIds])
        .catch(err => console.warn('[PostgreSQL Batch Sync] notifications markAllRead:', err.message));
    }

    const io = req.app.get('io');
    if (io) {
      const payload = { action: read ? 'markAllRead' : 'markAllUnread', space: space || 'all', doctorId, patientId, read };
      if (space === 'doctor' && doctorId) io.to(`doctor:${doctorId}`).emit('notif:update', payload);
      else if (space === 'patient' && patientId) io.to(`patient:${patientId}`).emit('notif:update', payload);
      else io.to('admin').emit('notif:update', payload);
    }

    res.json({ success: true, message: read ? 'Toutes les notifications ont été marquées comme lues.' : 'Toutes les notifications ont été marquées comme non lues.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur: ' + err.message });
  }
});

// DELETE /api/notifications/:id - Delete single notification (Authenticated)
router.delete('/:id', verifyToken, (req, res) => {
  try {
    const { id } = req.params;
    let list = db.data.notifications || [];
    const beforeCount = list.length;
    list = list.filter(n => n.id !== id);

    if (list.length !== beforeCount) {
      db.data.notifications = list;
      db.save();

      const io = req.app.get('io');
      if (io) {
        io.emit('notif:update', { action: 'delete', id });
        io.emit('notif:sync', { action: 'delete', id });
      }
      return res.json({ success: true, message: 'Notification supprimée avec succès.' });
    }

    res.status(404).json({ success: false, message: 'Notification introuvable.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur: ' + err.message });
  }
});

// DELETE /api/notifications - Clear notifications for space (Authenticated; space=all requires ADMIN)
router.delete('/', verifyToken, (req, res) => {
  try {
    const space = req.query.space || req.body?.space;
    const role = (req.user?.role || '').toUpperCase();
    if ((!space || space === 'all') && role !== 'ADMIN' && role !== 'SUPER_ADMIN') {
      return res.status(403).json({ success: false, message: 'Seul un administrateur peut effacer toutes les notifications.' });
    }
    const doctorId = req.query.doctorId || req.body?.doctorId;
    const doctorName = req.query.doctorName || req.body?.doctorName;
    const patientId = req.query.patientId || req.body?.patientId || req.user?.uuid || req.user?.id;
    const activeDocName = (doctorName || '').toLowerCase().replace(/^(dr\.?|docteur)\s*/i, '').trim();

    if (!space || space === 'all') {
      db.data.notifications = [];
    } else if (space === 'doctor' && (doctorId || activeDocName)) {
      // Clear ONLY this specific doctor's notifications, leaving other doctors completely untouched!
      db.data.notifications = (db.data.notifications || []).filter(n => {
        if (n.space !== 'doctor') return true; // Keep other spaces
        if (doctorId && n.doctorId === doctorId) return false; // Remove matching doctorId
        if (activeDocName && n.doctorName) {
          const nDoc = n.doctorName.toLowerCase().replace(/^(dr\.?|docteur)\s*/i, '').trim();
          if (nDoc.includes(activeDocName) || activeDocName.includes(nDoc)) return false; // Remove matching doctorName
        }
        if (!doctorId && !activeDocName) return false;
        return true; // Keep all other doctors' notifications intact!
      });
    } else if (space === 'patient' && patientId) {
      // Clear ONLY this specific patient's notifications:
      // 1. Delete personal notifications for this patient
      db.data.notifications = (db.data.notifications || []).filter(n => {
        if (n.patientId && n.patientId === patientId) return false;
        if (n.userId && n.userId === patientId) return false;
        return true;
      });
      // 2. Mark notifsClearedAt on the patient user record so prior broadcast alerts are filtered out
      const user = (db.data.users || []).find(u => u.uuid === patientId || u.id === patientId);
      if (user) {
        user.notifsClearedAt = new Date().toISOString();
      }
    } else {
      db.data.notifications = (db.data.notifications || []).filter(n => n.space !== space && n.space !== 'all');
    }
    db.save();

    const io = req.app.get('io');
    if (io) {
      io.emit('notif:update', { action: 'clear', space: space || 'all', doctorId, doctorName, patientId });
      io.emit('notif:sync', { action: 'clear', space: space || 'all', doctorId, doctorName, patientId });
    }

    res.json({ success: true, message: 'Notifications effacées avec succès.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur: ' + err.message });
  }
});

module.exports = {
  router,
  broadcastNotification
};
