const express = require('express');
const db = require('../config/database');
const { verifyToken, optionalToken, requireRole } = require('../middleware/auth');
const { maskName } = require('../middleware/security.middleware');
const { validateBody } = require('../middleware/validate.middleware');
const { broadcastNotification } = require('./notifications.routes');

const router = express.Router();

function getTodayIso() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getItemDate(item) {
  if (item.dateIso) return item.dateIso;
  if (item.createdAt) return item.createdAt.slice(0, 10);
  if (item.uuid) {
    const ts = parseInt(String(item.uuid).replace(/\D/g, ''), 10);
    if (ts > 1000000000000) return new Date(ts).toISOString().slice(0, 10);
  }
  return null;
}

function autoArchivePastQueue() {
  const todayIso = getTodayIso();
  const rawQueue = db.get('queue') || [];
  let modified = false;

  rawQueue.forEach(item => {
    const itemDate = getItemDate(item);
    if (!item.dateIso && itemDate) {
      item.dateIso = itemDate;
      modified = true;
    }
    // If the queue item is from a past day and still active in waiting room or consultation,
    // automatically archive it as completed (TERMINE) so it never bleeds into today's queue
    if (itemDate && itemDate < todayIso && (item.stage === 'SALLE_D_ATTENTE' || item.stage === 'ARRIVE' || item.stage === 'EN_CONSULTATION')) {
      item.stage = 'TERMINE';
      modified = true;
    }
  });

  if (modified) {
    db.set('queue', rawQueue);
  }
  return rawQueue;
}

// GET /api/queue (masks patient PII for unauthenticated visitors; full details for authenticated staff)
router.get('/', optionalToken, (req, res) => {
  autoArchivePastQueue();
  const doctorId = req.query.doctorId;
  const todayOnly = req.query.todayOnly === 'true';
  const todayIso = getTodayIso();
  const rawQueue = db.get('queue') || [];
  const dbApts = db.get('appointments') || [];

  // Reconcile: ensure queue items whose appointments are COMPLETED or CANCELLED are never stuck EN_CONSULTATION
  let modified = false;
  rawQueue.forEach(item => {
    if (item.stage === 'EN_CONSULTATION') {
      const matchApt = dbApts.find(a => 
        (a.id === item.uuid || a.id === item.id || a.id === item.appointmentId || a.patientName === item.patient || a.patient === item.patient) &&
        (a.status === 'COMPLETED' || a.stage === 'TERMINE' || a.status === 'CANCELLED')
      );
      if (matchApt) {
        item.stage = matchApt.status === 'CANCELLED' ? 'ANNULE' : 'TERMINE';
        item.status = matchApt.status;
        modified = true;
      }
    }
  });
  if (modified) {
    db.set('queue', rawQueue);
    db.save();
  }

  let queue = doctorId ? rawQueue.filter(item => item.doctorId === doctorId) : rawQueue;
  if (todayOnly) {
    queue = queue.filter(item => {
      const itemDate = getItemDate(item);
      return !itemDate || itemDate === todayIso;
    });
  }

  // Count strictly today's active waiting room patients for this doctor
  const waitingTodayQueue = (doctorId ? rawQueue.filter(item => item.doctorId === doctorId) : rawQueue).filter(item => {
    const itemDate = getItemDate(item);
    const isToday = !itemDate || itemDate === todayIso;
    return isToday && (item.stage === 'SALLE_D_ATTENTE' || item.stage === 'ARRIVE');
  });

  // Sort FIFO: strictly arrival order (lowest rank or earliest creation first)
  queue = [...queue].sort((a, b) => {
    if (a.rank && b.rank && a.rank !== b.rank) return a.rank - b.rank;
    const tA = a.createdAt ? new Date(a.createdAt).getTime() : (parseInt(String(a.uuid || '').replace(/\D/g, ''), 10) || 0);
    const tB = b.createdAt ? new Date(b.createdAt).getTime() : (parseInt(String(b.uuid || '').replace(/\D/g, ''), 10) || 0);
    if (tA && tB && tA !== tB) return tA - tB;
    return 0;
  });
  const doctorDelays = db.get('doctorDelays') || {};
  let delayMinutes = 0;
  let delayUpdatedAt = new Date().toISOString();

  if (doctorId) {
    if (doctorDelays[doctorId] && typeof doctorDelays[doctorId].minutes === 'number') {
      delayMinutes = doctorDelays[doctorId].minutes;
      delayUpdatedAt = doctorDelays[doctorId].updatedAt || delayUpdatedAt;
    } else {
      const doc = db.findOne('doctors', d => d.id === doctorId || d.uuid === doctorId);
      if (doc && typeof doc.delayMinutes === 'number') {
        delayMinutes = doc.delayMinutes;
        delayUpdatedAt = doc.delayUpdatedAt || delayUpdatedAt;
      } else {
        // Strict isolation: if this doctor has not explicitly set a delay, default to 0 (à l'heure)
        delayMinutes = 0;
      }
    }
  } else {
    delayMinutes = doctorDelays['doc-1']?.minutes ?? db.get('delayMinutes') ?? 0;
    delayUpdatedAt = doctorDelays['doc-1']?.updatedAt ?? db.get('delayUpdatedAt') ?? delayUpdatedAt;
  }

  const callerRole = (req.user?.role || '').toUpperCase();
  const isStaff = ['DOCTOR', 'PRATICIEN', 'SECRETAIRE', 'SECRETARY', 'ADMIN', 'SUPER_ADMIN'].includes(callerRole);
  const safeQueue = isStaff ? queue : queue.map(item => ({
    ...item,
    patient: maskName(item.patient || item.patientName),
    patientName: maskName(item.patientName || item.patient),
    patientPhone: undefined,
    phone: undefined
  }));

  res.json({
    success: true,
    doctorId: doctorId || 'doc-1',
    delayMinutes,
    delayUpdatedAt,
    count: waitingTodayQueue.length,
    waitingCount: waitingTodayQueue.length,
    totalHistoryCount: safeQueue.length,
    data: safeQueue,
    queue: safeQueue
  });
});

// POST /api/queue/delay - Doctor or Secretary signals a delay (Staff only)
router.post('/delay', verifyToken, requireRole('DOCTOR', 'PRATICIEN', 'SECRETAIRE', 'SECRETARY', 'ADMIN', 'SUPER_ADMIN'), validateBody({ minutes: { type: 'number', min: 0, max: 300 } }), (req, res) => {
  const minutes = (req.body.minutes !== undefined) ? req.body.minutes : ((req.body.delayMinutes !== undefined) ? req.body.delayMinutes : 0);
  const val = parseInt(minutes, 10) || 0;
  const doctorId = req.body.doctorId || 'doc-1';
  const nowIso = new Date().toISOString();

  if (!db.data.doctorDelays) db.data.doctorDelays = {};
  db.data.doctorDelays[doctorId] = { minutes: val, updatedAt: nowIso };

  // Sync to doctor object in database
  const doc = db.findOne('doctors', d => d.id === doctorId || d.uuid === doctorId);
  let docDisplayName = 'Le cabinet médical';
  if (doc) {
    doc.delayMinutes = val;
    doc.delayUpdatedAt = nowIso;
    if (doc.name) {
      docDisplayName = doc.name.startsWith('Dr') ? doc.name : `Dr. ${doc.name}`;
    }
  }

  // Only sync platform-level delay if this is the primary doctor (doc-1)
  if (doctorId === 'doc-1') {
    db.data.delayMinutes = val;
    db.data.delayUpdatedAt = nowIso;
  }

  db.save();

  const io = req.app.get('io');
  if (io) {
    const payload = { 
      doctorId, 
      delayMinutes: val, 
      minutes: val, 
      updatedAt: nowIso,
      doctorName: docDisplayName
    };
    
    // Targeted socket emits to doctor's dedicated rooms
    io.to(`doctor:${doctorId}`).emit('queue:delay', payload);
    io.to(`cabinet:${doctorId}`).emit('queue:delay', payload);

    // Broadcast with doctorId attached so subscribers can filter per doctor
    io.emit('queue:delay', payload);
    io.emit('queue:update', { doctorId, delayMinutes: val, minutes: val, updatedAt: nowIso });
    io.emit('queue:updated', { doctorId, delayMinutes: val, minutes: val, updatedAt: nowIso });
  }

  broadcastNotification(io, {
    space: 'patient',
    doctorId,
    doctorName: docDisplayName,
    icon: val > 0 ? '⏱️' : '🟢',
    title: val > 0 ? `Avis de Retard - ${docDisplayName}` : `${docDisplayName} à l'heure`,
    message: val > 0 
      ? `${docDisplayName} a signalé un retard temporaire estimé à +${val} min.` 
      : `${docDisplayName} fonctionne à l'heure exacte. Aucun retard.`,
    category: 'cabinet',
    actionUrl: '../Patients_pages/patient-dashboard.html'
  });

  broadcastNotification(io, {
    space: 'secretary',
    doctorId,
    doctorName: docDisplayName,
    icon: val > 0 ? '⏱️' : '🟢',
    title: val > 0 ? `Retard Praticien Signalé (${docDisplayName})` : `${docDisplayName} à l'heure`,
    message: val > 0 
      ? `${docDisplayName} a accusé un retard de +${val} min sur son planning de consultations.` 
      : `${docDisplayName} est à l'heure exacte.`,
    category: 'queue'
  });

  res.json({
    success: true,
    doctorId,
    message: val > 0 ? `Retard de +${val} min enregistré pour ${docDisplayName}.` : `Cabinet de ${docDisplayName} recalibré à l'heure exacte.`,
    delayMinutes: val,
    delayUpdatedAt: nowIso
  });
});

// POST /api/queue/call-next - Call next patient ticket (Staff only)
router.post('/call-next', verifyToken, requireRole('DOCTOR', 'PRATICIEN', 'SECRETAIRE', 'SECRETARY', 'ADMIN', 'SUPER_ADMIN'), (req, res) => {
  const doctorId = req.body?.doctorId || req.query?.doctorId;
  let queue = db.get('queue') || [];
  let doctorQueue = doctorId ? queue.filter(item => item.doctorId === doctorId) : queue;
  if (!doctorQueue.length) {
    return res.status(400).json({ success: false, message: 'La file d\'attente est vide.' });
  }

  // Any currently in consultation becomes COMPLETED for this doctor
  queue.forEach(item => {
    if ((!doctorId || item.doctorId === doctorId) && item.stage === 'EN_CONSULTATION') {
      item.stage = 'TERMINE';
    }
  });

  // Find first patient waiting for this doctor TODAY (FIFO: earliest arrival / lowest rank first)
  const todayIso = getTodayIso();
  const waitingCandidates = doctorQueue
    .filter(item => {
      const itemDate = getItemDate(item);
      const isToday = !itemDate || itemDate === todayIso;
      return isToday && (item.stage === 'SALLE_D_ATTENTE' || item.stage === 'ARRIVE');
    })
    .sort((a, b) => {
      if (a.rank && b.rank && a.rank !== b.rank) return a.rank - b.rank;
      const tA = a.createdAt ? new Date(a.createdAt).getTime() : (parseInt(String(a.uuid || '').replace(/\D/g, ''), 10) || 0);
      const tB = b.createdAt ? new Date(b.createdAt).getTime() : (parseInt(String(b.uuid || '').replace(/\D/g, ''), 10) || 0);
      if (tA && tB && tA !== tB) return tA - tB;
      return 0;
    });
  const nextPatient = waitingCandidates[0];
  if (!nextPatient) {
    return res.json({ success: true, message: 'Tous les patients ont été consultés !', queue: doctorQueue });
  }

  nextPatient.stage = 'EN_CONSULTATION';
  db.set('queue', queue);

  const io = req.app.get('io');
  if (io) {
    const docDelays = db.data.doctorDelays || {};
    const currentDocDelay = doctorId ? (docDelays[doctorId]?.minutes ?? 0) : (db.data?.delayMinutes || 0);
    io.emit('queue:called', { patient: nextPatient, doctorId });
    io.emit('queue:updated', { queue, delayMinutes: currentDocDelay, doctorId });
    if (doctorId) {
      io.to(`doctor:${doctorId}`).emit('queue:init', {
        queue: queue.filter(item => item.doctorId === doctorId),
        delayMinutes: currentDocDelay,
        doctorId
      });
    }
  }

  broadcastNotification(io, {
    space: 'patient',
    icon: '📢',
    title: 'Votre Tour en Consultation',
    message: `Patient ${nextPatient.patient} (${nextPatient.ticket}), veuillez vous présenter en salle de consultation.`,
    category: 'cabinet',
    actionUrl: '../Patients_pages/patient-dashboard.html'
  });

  res.json({
    success: true,
    message: `Patient ${nextPatient.patient} (${nextPatient.ticket}) appelé en consultation !`,
    calledPatient: nextPatient,
    queue: doctorId ? queue.filter(item => item.doctorId === doctorId) : queue
  });
});

// POST /api/queue/notify - Doctor notifies patient directly (Staff only)
router.post('/notify', verifyToken, requireRole('DOCTOR', 'PRATICIEN', 'SECRETAIRE', 'SECRETARY', 'ADMIN', 'SUPER_ADMIN'), (req, res) => {
  try {
    const { patientName, phone, message, title = 'Notification Cabinet', category = 'cabinet' } = req.body;
    const io = req.app.get('io');

    broadcastNotification(io, {
      space: 'patient',
      icon: '💬',
      title,
      message: message || `Message du Dr. Selim Ben Ali pour ${patientName || 'le patient'}.`,
      category,
      actionUrl: '../Patients_pages/patient-dashboard.html'
    });

    res.json({
      success: true,
      message: 'Notification envoyée au patient avec succès.',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/queue/:uuid - Update queue item stage (Staff only)
router.patch('/:uuid', verifyToken, requireRole('DOCTOR', 'PRATICIEN', 'SECRETAIRE', 'SECRETARY', 'ADMIN', 'SUPER_ADMIN'), (req, res) => {
  try {
    const { stage, rank, status } = req.body;
    const queue = db.get('queue') || [];
    const item = queue.find(q => q.uuid === req.params.uuid || q.id === req.params.uuid || q.appointmentId === req.params.uuid);

    if (!item) {
      return res.status(404).json({ success: false, message: 'Entrée de file introuvable.' });
    }

    if (stage) item.stage = stage;
    if (status) item.status = status;
    if (stage === 'TERMINE' || status === 'COMPLETED') {
      item.stage = 'TERMINE';
      item.status = 'COMPLETED';
      item.completedAt = new Date().toISOString();
    }
    if (rank !== undefined) item.rank = rank;

    db.set('queue', queue);

    const io = req.app.get('io');
    if (io) {
      const docDelays = db.data.doctorDelays || {};
      const itemDocDelay = item.doctorId ? (docDelays[item.doctorId]?.minutes ?? 0) : (db.data?.delayMinutes || 0);
      io.emit('queue:updated', { queue, delayMinutes: itemDocDelay, doctorId: item.doctorId });
      if (stage === 'EN_CONSULTATION') {
        io.emit('queue:called', { patient: item, doctorId: item.doctorId });
      }
    }

    res.json({
      success: true,
      message: 'Statut de file mis à jour.',
      data: item
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
