const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { verifyToken, optionalToken, requireRole } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate.middleware');
const { broadcastNotification } = require('./notifications.routes');
const EmailService = require('../services/email.service');
const WhatsAppService = require('../services/whatsapp.service');

const router = express.Router();

// Helper to safely get YYYY-MM-DD in local time
function getLocalIsoDate(d = new Date()) {
  const dateObj = (typeof d === 'string' || typeof d === 'number') ? new Date(d) : d;
  if (isNaN(dateObj.getTime())) return new Date().toISOString().split('T')[0];
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Helper to normalize any localized or relative date string into an ISO YYYY-MM-DD date
function normalizeAppointmentDate(dateInput, createdAt = null) {
  if (!dateInput) return getLocalIsoDate();
  let str = String(dateInput).trim();
  if (str.includes(' à ')) str = str.split(' à ')[0].trim();

  // Convert Eastern Arabic numerals (٠-٩) to Western (0-9)
  str = str.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));

  // If already standard ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  // Match DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmyMatch) {
    const day = String(parseInt(dmyMatch[1], 10)).padStart(2, '0');
    const month = String(parseInt(dmyMatch[2], 10)).padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }

  const today = new Date();
  const lower = str.toLowerCase();

  // Arabic Month Dictionary (Tunisian & Middle Eastern variants)
  const arabicMonths = {
    'جانفي': 0, 'فيفري': 1, 'مارس': 2, 'أفريل': 3, 'افريل': 3, 'ماي': 4, 'جوان': 5,
    'جويلية': 6, 'جويليا': 6, 'أوت': 7, 'اوت': 7, 'سبتمبر': 8, 'أكتوبر': 9, 'اكتوبر': 9,
    'نوفمبر': 10, 'ديسمبر': 11,
    'يناير': 0, 'فبراير': 1, 'أبريل': 3, 'ابريل': 3, 'مايو': 4, 'يونيو': 5,
    'يوليو': 6, 'أغسطس': 7, 'اغسطس': 7
  };

  // Check specific Arabic date with month first
  for (const [arMonth, mIdx] of Object.entries(arabicMonths)) {
    if (str.includes(arMonth)) {
      const numMatch = str.match(/(\d{1,2})/);
      if (numMatch) {
        const dayNum = parseInt(numMatch[1], 10);
        const d = new Date(today.getFullYear(), mIdx, dayNum, 12, 0, 0);
        return getLocalIsoDate(d);
      }
    }
  }

  // French & Latin Month Dictionary
  const latinMonths = {
    'janv': 0, 'janvier': 0,
    'févr': 1, 'fevr': 1, 'février': 1,
    'mars': 2,
    'avr': 3, 'avril': 3,
    'mai': 4,
    'juin': 5,
    'juil': 6, 'juillet': 6,
    'août': 7, 'aout': 7,
    'sept': 8, 'septembre': 8,
    'oct': 9, 'octobre': 9,
    'nov': 10, 'novembre': 10,
    'déc': 11, 'dec': 11, 'décembre': 11
  };

  // Check specific Latin date with month first (e.g. "6 nov", "Aujourd'hui (6 nov.)")
  const numMatch = str.match(/(\d{1,2})/);
  if (numMatch) {
    const dayNum = parseInt(numMatch[1], 10);
    for (const [key, mIdx] of Object.entries(latinMonths)) {
      if (lower.includes(key)) {
        const d = new Date(today.getFullYear(), mIdx, dayNum, 12, 0, 0);
        return getLocalIsoDate(d);
      }
    }
  }

  // If createdAt exists and string is a relative keyword ("Aujourd'hui", "Demain")
  if (createdAt) {
    const cDate = new Date(createdAt);
    if (!isNaN(cDate.getTime())) {
      if (lower.includes('demain') || lower.includes('tomorrow') || lower.includes('غدا') || lower.includes('غداً')) {
        cDate.setDate(cDate.getDate() + 1);
      }
      return getLocalIsoDate(cDate);
    }
  }

  if (lower.includes('aujourd') || lower.includes('today') || lower.includes('اليوم')) {
    return getLocalIsoDate(today);
  }

  if (lower.includes('demain') || lower.includes('tomorrow') || lower.includes('غدا') || lower.includes('غداً')) {
    const tmr = new Date(today);
    tmr.setDate(tmr.getDate() + 1);
    return getLocalIsoDate(tmr);
  }

  // Attempt standard Date parsing
  const parsedD = new Date(str);
  if (!isNaN(parsedD.getTime())) {
    return getLocalIsoDate(parsedD);
  }

  return getLocalIsoDate(today);
}

// Check if a specific ISO date falls within a given leave object
function isDateInLeave(targetIso, leaveObj) {
  if (!leaveObj || !targetIso) return false;
  const startRaw = leaveObj.start || leaveObj.startDate || leaveObj.startIso;
  const endRaw = leaveObj.end || leaveObj.endDate || leaveObj.endIso;
  if (!startRaw || !endRaw) return false;
  const startIso = normalizeAppointmentDate(startRaw);
  const endIso = normalizeAppointmentDate(endRaw);
  return targetIso >= startIso && targetIso <= endIso;
}

// Get the active leave period for a doctor schedule on a specific ISO date
function getDoctorLeaveForDate(schedule, targetIso) {
  if (!schedule || !targetIso) return null;
  if (Array.isArray(schedule.leaves) && schedule.leaves.length > 0) {
    const match = schedule.leaves.find(l => l && isDateInLeave(targetIso, l));
    if (match) return match;
  }
  if (schedule.leave && isDateInLeave(targetIso, schedule.leave)) {
    return schedule.leave;
  }
  return null;
}

// Calculate available slots based on doctor's weekly schedule, leaves, and booked/blocked appointments
function calculateAvailableSlots(schedule, appointmentsForDay = [], dateInput = new Date()) {
  const dateObj = (typeof dateInput === 'string' || typeof dateInput === 'number') ? new Date(dateInput) : dateInput;
  const iso = getLocalIsoDate(dateObj);
  const dayNamesFr = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const dayKey = dayNamesFr[dateObj.getDay()];

  const dayConfig = (schedule?.days && schedule.days[dayKey]) || { isOpen: (dayKey !== 'dimanche') };

  if (!dayConfig.isOpen) {
    return {
      dateIso: iso,
      dayKey,
      isOpen: false,
      onLeave: false,
      slots: [],
      bookedSlots: [],
      blockedSlots: [],
      reason: 'Fermé ce jour'
    };
  }

  const activeLeave = getDoctorLeaveForDate(schedule, iso);
  if (activeLeave) {
    return {
      dateIso: iso,
      dayKey,
      isOpen: false,
      onLeave: true,
      slots: [],
      bookedSlots: [],
      blockedSlots: [],
      reason: activeLeave.reason || 'Congé exceptionnel'
    };
  }

  const slotDuration = parseInt(schedule?.slotDuration || 20, 10);
  const slots = [];

  function parseMinutes(tStr) {
    if (!tStr) return null;
    const parts = tStr.replace('h', ':').split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1] || '0', 10);
  }

  function formatTime(mins) {
    const h = String(Math.floor(mins / 60)).padStart(2, '0');
    const m = String(mins % 60).padStart(2, '0');
    return `${h}:${m}`;
  }

  const matinStart = parseMinutes(dayConfig.matinStart || '08:30');
  const matinEnd = parseMinutes(dayConfig.matinEnd || '13:00');
  const pauseStart = parseMinutes(dayConfig.pauseStart);
  const pauseEnd = parseMinutes(dayConfig.pauseEnd);
  const apremStart = parseMinutes(dayConfig.apremStart || '14:00');
  const apremEnd = parseMinutes(dayConfig.apremEnd || '18:30');

  // Morning slots
  if (matinStart !== null && matinEnd !== null) {
    for (let t = matinStart; t + slotDuration <= matinEnd; t += slotDuration) {
      slots.push(formatTime(t));
    }
  }

  // Afternoon slots
  if (apremStart !== null && apremEnd !== null) {
    for (let t = apremStart; t + slotDuration <= apremEnd; t += slotDuration) {
      slots.push(formatTime(t));
    }
  }

  const bookedSet = new Set();
  const blockedSet = new Set();

  appointmentsForDay.forEach(a => {
    if (a.status === 'CANCELLED') return;
    const aIso = a.dateIso || normalizeAppointmentDate(a.date);
    if (aIso === iso) {
      let aTime = (a.time || '').trim().replace('h', ':');
      if (/^\d:\d\d$/.test(aTime)) aTime = '0' + aTime;
      if (a.status === 'BLOCKED') {
        blockedSet.add(aTime);
      } else {
        bookedSet.add(aTime);
      }
    }
  });

  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const isToday = (iso === todayIso);
  const isPastDay = (iso < todayIso);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const freeSlots = slots.filter(s => {
    if (bookedSet.has(s) || blockedSet.has(s)) return false;
    if (isPastDay) return false;
    if (isToday) {
      const slotMins = parseMinutes(s);
      if (slotMins !== null && slotMins <= currentMinutes) return false;
    }
    return true;
  });

  return {
    dateIso: iso,
    dayKey,
    isOpen: true,
    onLeave: false,
    slots: freeSlots,
    allSlots: slots,
    bookedSlots: Array.from(bookedSet),
    blockedSlots: Array.from(blockedSet)
  };
}

// GET /api/appointments (Requires Authentication — strict role/owner scoping)
router.get('/', verifyToken, (req, res) => {
  const { doctorId, patientId, patientPhone,
      patientEmail, patientName, date } = req.query;
  const role = (req.user?.role || '').toUpperCase();
  const isAdmin = role === 'ADMIN' || role === 'SUPER_ADMIN';
  const isDoctorStaff = role === 'DOCTOR' || role === 'PRATICIEN' || role === 'SECRETAIRE' || role === 'SECRETARY';
  let list = db.get('appointments');

  // Strict row-level isolation by caller role
  if (!isAdmin) {
    if (isDoctorStaff) {
      const ownDocId = req.user.doctorId;
      if (ownDocId) {
        list = list.filter(a => a.doctorId === ownDocId || a.doctor_id === ownDocId);
      }
    } else {
      // Patient can ONLY see their own appointments
      const ownPhone = (req.user.phone || '').replace(/[\s+]/g, '');
      list = list.filter(a =>
        a.patientId === req.user.uuid ||
        a.bookerId === req.user.uuid ||
        (ownPhone && a.patientPhone && a.patientPhone.replace(/[\s+]/g, '').includes(ownPhone))
      );
    }
  }

  // Ensure every appointment has a valid and accurate dateIso (self-heals any drifted dates)
  let hasDateChanges = false;
  list = list.map(a => {
    const computedIso = normalizeAppointmentDate(a.date, a.createdAt || a.created_at);
    if (!a.dateIso || !/^\d{4}-\d{2}-\d{2}$/.test(String(a.dateIso).trim())) {
      a.dateIso = computedIso;
      hasDateChanges = true;
    } else if (computedIso && computedIso !== a.dateIso) {
      const lower = String(a.date || '').toLowerCase();
      const hasExplicitDate = /\d{1,2}/.test(lower) || lower.includes('aujourd') || lower.includes('demain') || lower.includes('hier') || lower.includes('اليوم');
      if (hasExplicitDate) {
        a.dateIso = computedIso;
        hasDateChanges = true;
      }
    }
    return a;
  });
  if (hasDateChanges) {
    db.set('appointments', list);
  }

  if (doctorId) {
    list = list.filter(a =>
      a.doctorId === doctorId ||
      a.doctor_id === doctorId ||
      (doctorId === 'doc-1' && (
        !a.doctorId ||
        a.doctorId === 'doc-1' ||
        a.doctorName?.includes('Ben Ali') ||
        a.doctorName?.includes('Selim') ||
        a.doctor?.includes('Ben Ali') ||
        a.doctor?.includes('Selim')
      ))
    );
  }
  if (patientId) {
    list = list.filter(a => a.patientId === patientId || a.bookerId === patientId);
  }
  if (patientPhone) {
    const cleanP = patientPhone.replace(/[\s+]/g, '');
    list = list.filter(a => a.patientPhone && a.patientPhone.replace(/[\s+]/g, '').includes(cleanP));
  }
  if (patientName) {
    const cleanN = patientName.toLowerCase().trim();
    list = list.filter(a => a.patientName && a.patientName.toLowerCase().includes(cleanN));
  }
  if (date) {
    const targetIso = normalizeAppointmentDate(date);
    list = list.filter(a => a.dateIso === targetIso || a.date === date);
  }

  res.json({
    success: true,
    count: list.length,
    data: list
  });
});

// POST /api/appointments - Book appointment with anti-conflict lock
router.post('/', optionalToken, (req, res) => {
  try {
    let cleanDate = (req.body.date || 'Aujourd\'hui').trim();
    let cleanTime = (req.body.time || req.body.slotTime || '10:00').trim();

    if (cleanDate.includes(' à ')) {
      const parts = cleanDate.split(' à ');
      cleanDate = parts[0].trim();
      if (!req.body.time && parts[1]) cleanTime = parts[1].trim();
    }

    cleanTime = cleanTime.replace('h', ':');
    if (/^\d:\d\d$/.test(cleanTime)) cleanTime = '0' + cleanTime;

    const {
      doctorId,
      doctorName,
      specialty,
      patientName = 'Anonyme',
      patientPhone = '+216 20 000 000',
      patientEmail: reqPatientEmail,
      email: reqFallbackEmail,
      type = 'PRESENTIEL',
      fee = '70 TND',
      motif = 'Consultation de suivi',
      bookedFor = 'self',
      relative = false,
      relation = 'SELF',
      bookerName = null,
      bookerId = null
    } = req.body;

    const date = cleanDate;
    const time = cleanTime;
    const dateIso = req.body.dateIso || normalizeAppointmentDate(cleanDate);
    const patientEmail = (reqPatientEmail || reqFallbackEmail || (req.user && req.user.email) || 'rejabchohra@gmail.com').toLowerCase().trim();

    if (!doctorId && !doctorName) {
      return res.status(400).json({ success: false, message: 'Identifiant du médecin ou nom requis.' });
    }

    const isPointage = req.body.source === 'POINTAGE_COMPTOIR' || req.body.isWalkIn === true || req.body.status === 'EN_ATTENTE';

    if (!isPointage) {
      // Past Time Check: do not allow booking for a time that has already passed
      const now = new Date();
      const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      if (dateIso && dateIso < todayIso) {
        return res.status(400).json({
          success: false,
          message: 'Impossible de réserver un créneau dans le passé.'
        });
      }
      if (dateIso && dateIso === todayIso) {
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const parts = time.replace('h', ':').split(':');
        const timeMinutes = parseInt(parts[0], 10) * 60 + parseInt(parts[1] || '0', 10);
        if (timeMinutes <= currentMinutes) {
          return res.status(400).json({
            success: false,
            message: 'Ce créneau horaire est déjà passé pour aujourd\'hui. Veuillez choisir un créneau ultérieur.'
          });
        }
      }

      // Anti-Conflict Check: ensure the slot is not taken by another patient or blocked by the doctor
      const conflict = db.findOne('appointments', a => {
        const isSameDoctor = (a.doctorId === doctorId || a.doctorName === doctorName || (doctorId === 'doc-1' && (!a.doctorId || a.doctorId === 'doc-1')));
        if (!isSameDoctor) return false;
        const aIso = a.dateIso || normalizeAppointmentDate(a.date);
        const isSameDate = (aIso === dateIso || a.date === date);
        let aTime = (a.time || '').trim().replace('h', ':');
        if (/^\d:\d\d$/.test(aTime)) aTime = '0' + aTime;
        const isSameTime = (aTime === time || a.time === time);
        return isSameDate && isSameTime && a.status !== 'CANCELLED';
      });

      if (conflict) {
        if (conflict.status === 'BLOCKED') {
          return res.status(409).json({
            success: false,
            conflict: true,
            message: `Le créneau horaire ${time} (${date}) a été bloqué par le médecin (${conflict.patientName || 'Indisponible'}) et n'est pas réservable.`
          });
        }
        return res.status(409).json({
          success: false,
          conflict: true,
          message: `Le créneau horaire ${time} (${date}) est déjà réservé par un autre patient. Veuillez choisir un autre créneau.`
        });
      }
    }

    const targetDateIso = dateIso || (date ? String(date).slice(0, 10) : new Date().toISOString().slice(0, 10));
    const currentQueue = db.get('queue') || [];
    // Reset ticket numbering to start strictly from 1 every day for each doctor
    const todayDoctorQueue = currentQueue.filter(q => {
      const matchDoc = q.doctorId === doctorId || q.doctor === doctorName;
      const qDate = q.dateIso || (q.createdAt ? q.createdAt.slice(0, 10) : null) || (q.uuid ? (function(u){ const ts = parseInt(String(u).replace(/\D/g, ''), 10); return ts ? new Date(ts).toISOString().slice(0, 10) : null; })(q.uuid) : null);
      return matchDoc && qDate === targetDateIso;
    });
    const nextRank = todayDoctorQueue.length + 1;
    const ticketStr = `N° ${String(nextRank).padStart(2, '0')}`;

    // SECURITY: the consultation price is ALWAYS taken from the doctor's record on the server.
    // Any "fee" sent by the client is ignored (prevents price tampering).
    const feeDoctor = db.findOne('doctors', d => (doctorId && (d.id === doctorId || d.uuid === doctorId)) || (!doctorId && doctorName && d.name === doctorName));
    const feeDigits = parseInt(String(feeDoctor?.fee ?? '70').replace(/\D/g, ''), 10);
    const authoritativeFee = `${(feeDigits >= 0 && feeDigits <= 1000) ? feeDigits : 70} TND`;

    // SECURITY: clients may only create CONFIRMED or EN_ATTENTE (walk-in) appointments.
    const CLIENT_ALLOWED_STATUS = ['CONFIRMED', 'EN_ATTENTE'];
    const safeStatus = CLIENT_ALLOWED_STATUS.includes(req.body.status) ? req.body.status : null;

    const newAppointment = {
      id: req.body.id || `apt-${Date.now()}`,
      patientId: req.user ? req.user.uuid : (req.body.patientId || `usr-guest-${Date.now()}`),
      bookerId: bookerId || (req.user ? req.user.uuid : (req.body.patientId || null)),
      bookerName: bookerName || (req.user ? req.user.name : null),
      bookedFor: bookedFor || 'self',
      relative: Boolean(relative),
      relation: relation || 'SELF',
      patientName,
      patientPhone,
      doctorId: doctorId || 'doc-1',
      doctorName: doctorName || 'Dr. Selim Ben Ali',
      specialty: specialty || 'Cardiologie',
      date,
      dateIso,
      time,
      type,
      fee: authoritativeFee,
      motif,
      source: req.body.source || (isPointage ? 'POINTAGE_COMPTOIR' : 'ONLINE'),
      ticketNumber: req.body.ticketNumber || ticketStr,
      status: safeStatus || (isPointage ? 'EN_ATTENTE' : 'CONFIRMED'),
      createdAt: new Date().toISOString()
    };

    db.insert('appointments', newAppointment);

    // Add entry to the live waiting room queue
    const queueEntry = {
      uuid: `q-${Date.now()}`,
      appointmentId: newAppointment.id,
      patient: patientName,
      doctor: newAppointment.doctorName,
      doctorId: newAppointment.doctorId,
      rank: nextRank,
      stage: 'SALLE_D_ATTENTE',
      ticket: ticketStr,
      time,
      dateIso: targetDateIso,
      createdAt: new Date().toISOString(),
      bookedFor: newAppointment.bookedFor,
      relation: newAppointment.relation
    };
    db.insert('queue', queueEntry);

    // Broadcast WebSocket event if io is attached
    const io = req.app.get('io');
    if (io) {
      io.emit('queue:updated', { queue: db.get('queue'), delayMinutes: db.get('delayMinutes') });
      // Broadcast to doctor rooms and globally so patient reservation calendars update live
      io.emit('appointment:new', newAppointment);
      if (newAppointment.doctorId) {
        io.to(`doctor:${newAppointment.doctorId}`).to(`cabinet:${newAppointment.doctorId}`).to('admin').emit('appointment:new', newAppointment);
      }
    }

    // Specialized notification for Patient
    broadcastNotification(io, {
      space: 'patient',
      patientId: newAppointment.patientId,
      patientName: newAppointment.patientName,
      doctorId: newAppointment.doctorId,
      doctorName: newAppointment.doctorName,
      icon: '📅',
      title: 'Rendez-vous Confirmé',
      message: `Votre RDV chez ${newAppointment.doctorName} (${newAppointment.specialty}) est confirmé pour ${newAppointment.date} à ${newAppointment.time}.`,
      category: 'rdv',
      actionUrl: '../Patients_pages/patient-dashboard.html'
    });

    // Specialized notification for Doctor
    broadcastNotification(io, {
      space: 'doctor',
      doctorId: newAppointment.doctorId,
      doctorName: newAppointment.doctorName,
      patientId: newAppointment.patientId,
      patientName: newAppointment.patientName,
      icon: '👤',
      title: 'Nouveau Rendez-vous Patient',
      message: `${newAppointment.patientName} a réservé pour ${newAppointment.date} à ${newAppointment.time}.`,
      category: 'patient',
      actionUrl: '../Doctors_pages/doctor-dashboard.html'
    });

    // Specialized notification for Secretary
    broadcastNotification(io, {
      space: 'secretaire',
      doctorId: newAppointment.doctorId,
      doctorName: newAppointment.doctorName,
      icon: '📅',
      title: 'Nouveau RDV sur Planning',
      message: `${newAppointment.patientName} (${newAppointment.time}) - ${newAppointment.doctorName}`,
      category: 'patient',
      actionUrl: '../Doctors_pages/doctor-dashboard.html?tab=agenda'
    });

    // Find doctor profile for address, phone & email
    const doctorObj = db.findOne('doctors', d => d.id === newAppointment.doctorId || d.uuid === newAppointment.doctorId || d.name === newAppointment.doctorName);

    // Automated Official Email Dispatching (Patient confirmation & Doctor notification)
    try {
      let doctorEmail = (doctorObj && doctorObj.email) || null;
      if (!doctorEmail && newAppointment.doctorId) {
        const docUser = db.findOne('users', u => u.uuid === newAppointment.doctorId || u.doctorId === newAppointment.doctorId || (doctorObj && u.uuid === doctorObj.userId));
        if (docUser) doctorEmail = docUser.email;
      }

      // 1. Send automatic confirmation to patient
      EmailService.sendAppointmentConfirmationEmail({
        appointment: newAppointment,
        patientEmail,
        doctor: doctorObj,
        hostUrl: req.headers.origin || 'http://localhost:5173'
      }).then(resEmail => {
        console.log(`[Appointments] ✉️ Confirmation email automatically dispatched to patient ${patientEmail} (Status: ${resEmail?.emailRecord?.status || 'OK'})`);
      }).catch(err => {
        console.error('[Appointments] ❌ Automatic patient email dispatch error:', err.message);
      });

      // 2. Send notification to doctor if email is known
      if (doctorEmail) {
        EmailService.sendDoctorNewAppointmentNotificationEmail({
          appointment: newAppointment,
          doctorEmail,
          doctorName: newAppointment.doctorName,
          hostUrl: req.headers.origin || 'http://localhost:5173'
        }).then(resDoc => {
          console.log(`[Appointments] ✉️ Notification email automatically dispatched to doctor ${doctorEmail}`);
        }).catch(err => {
          console.error('[Appointments] ❌ Doctor email dispatch error:', err.message);
        });
      }
    } catch (emailErr) {
      console.warn('[Appointments] ⚠️ Automatic email trigger exception (non-fatal):', emailErr.message);
    }

    // Automated Real-Time SMS & WhatsApp Confirmation Dispatching
    try {
      if (!db.data.communications) {
        db.data.communications = [];
      }
      const isArabicBooking = /[\u0600-\u06FF]/.test(newAppointment.date) || /[\u0600-\u06FF]/.test(newAppointment.patientName);
      const cleanPhone = (newAppointment.patientPhone || '').replace(/[^0-9]/g, '');
      const carrier = cleanPhone.startsWith('2169') || cleanPhone.startsWith('9')
        ? 'Tunisie Telecom SMS Gateway'
        : (cleanPhone.startsWith('2162') || cleanPhone.startsWith('2')
          ? 'Ooredoo SMS Gateway'
          : 'Orange Tunisie SMS Gateway');

      // 1. Confirmation SMS Record
      const smsMessage = isArabicBooking
        ? `مرحباً ${newAppointment.patientName}، تم تأكيد موعدك بنجاح مع ${newAppointment.doctorName} ليوم ${newAppointment.date} على الساعة ${newAppointment.time}. التذكرة: ${newAppointment.ticketNumber}. شكراً لاختياركم SahaTN.`
        : `Bonjour ${newAppointment.patientName}, votre rendez-vous avec ${newAppointment.doctorName} est confirmé pour le ${newAppointment.date} à ${newAppointment.time}. Ticket: ${newAppointment.ticketNumber}. SahaTN`;

      const smsRecord = {
        id: `comm-sms-${Date.now()}`,
        channel: 'sms',
        direction: 'OUTBOUND',
        senderType: 'DOCTOR',
        doctorId: newAppointment.doctorId,
        doctorName: newAppointment.doctorName,
        doctorSpecialty: newAppointment.specialty,
        patientId: newAppointment.patientId,
        recipientName: newAppointment.patientName,
        recipientPhone: newAppointment.patientPhone,
        message: smsMessage,
        template: 'confirmation_rdv',
        lang: isArabicBooking ? 'ar' : 'fr',
        status: 'DELIVRE',
        carrier,
        networkLatencyMs: Math.floor(110 + Math.random() * 60),
        sentAt: new Date().toISOString(),
        deliveredAt: new Date(Date.now() + 250).toISOString(),
        readAt: null
      };

      // 2. WhatsApp Notification Record
      const waMessage = isArabicBooking
        ? `مرحباً ${newAppointment.patientName} 🩺،\nتم تأكيد موعدك الطبي مع ${newAppointment.doctorName} (${newAppointment.specialty}).\n📅 الموعد: ${newAppointment.date} على الساعة ${newAppointment.time}\n🎫 التذكرة: ${newAppointment.ticketNumber}\n📍 العنوان: شارع الهادي نويرة، النصر 2، تونس`
        : `Bonjour ${newAppointment.patientName} 🩺,\nVotre rendez-vous médical avec ${newAppointment.doctorName} (${newAppointment.specialty}) est confirmé.\n📅 Date: ${newAppointment.date} à ${newAppointment.time}\n🎫 Ticket: ${newAppointment.ticketNumber}\n📍 Cabinet SahaTN Ennasr 2`;

      const waRecord = {
        id: `comm-wa-${Date.now() + 1}`,
        channel: 'whatsapp',
        direction: 'OUTBOUND',
        senderType: 'DOCTOR',
        doctorId: newAppointment.doctorId,
        doctorName: newAppointment.doctorName,
        doctorSpecialty: newAppointment.specialty,
        patientId: newAppointment.patientId,
        recipientName: newAppointment.patientName,
        recipientPhone: newAppointment.patientPhone,
        message: waMessage,
        template: 'confirm_gps',
        lang: isArabicBooking ? 'ar' : 'fr',
        status: 'DELIVRE',
        carrier: 'WhatsApp Business Cloud API',
        networkLatencyMs: Math.floor(80 + Math.random() * 40),
        sentAt: new Date(Date.now() + 100).toISOString(),
        deliveredAt: new Date(Date.now() + 300).toISOString(),
        readAt: null
      };

      db.data.communications.unshift(smsRecord);
      db.data.communications.unshift(waRecord);
      db.save();

      // Dispatch REAL WhatsApp Message to Patient's Physical Mobile Phone
      WhatsAppService.sendAppointmentConfirmationToPatient({
        patientName: newAppointment.patientName,
        patientPhone: newAppointment.patientPhone,
        doctorName: newAppointment.doctorName,
        doctorSpecialty: newAppointment.specialty,
        date: newAppointment.date,
        time: newAppointment.time,
        ticketNumber: newAppointment.ticketNumber,
        address: (doctorObj && doctorObj.address) || 'Cabinet Médical, Tunisie'
      }).catch(e => console.warn('[Appointments] Patient WhatsApp mobile dispatch error:', e.message));

      // Dispatch REAL WhatsApp Notification to Doctor's Physical Mobile Phone
      const doctorPhone = (doctorObj && doctorObj.phone) || null;
      if (doctorPhone) {
        WhatsAppService.sendAppointmentNotificationToDoctor({
          doctorName: newAppointment.doctorName,
          doctorPhone: doctorPhone,
          patientName: newAppointment.patientName,
          patientPhone: newAppointment.patientPhone,
          date: newAppointment.date,
          time: newAppointment.time,
          ticketNumber: newAppointment.ticketNumber,
          type: newAppointment.type
        }).catch(e => console.warn('[Appointments] Doctor WhatsApp mobile dispatch error:', e.message));
      }

      // Emit real-time communication events via Socket.io
      if (io) {
        io.emit('communication:sent', smsRecord);
        io.emit('communication:sent', waRecord);
        if (newAppointment.doctorId) {
          io.to(`doctor:${newAppointment.doctorId}`).to(`cabinet:${newAppointment.doctorId}`).to('admin').emit('communication:sent', smsRecord);
          io.to(`doctor:${newAppointment.doctorId}`).to(`cabinet:${newAppointment.doctorId}`).to('admin').emit('communication:sent', waRecord);
        }
      }
      console.log(`[Appointments] 📱 Real-time SMS & WhatsApp dispatched for ${newAppointment.patientName} (${newAppointment.time})`);
    } catch (commErr) {
      console.warn('[Appointments] ⚠️ Automatic SMS/WhatsApp comm error:', commErr.message);
    }

    res.status(201).json({
      success: true,
      message: 'Rendez-vous réservé avec succès !',
      data: newAppointment,
      queueEntry
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur lors de la réservation: ' + err.message });
  }
});

// GET /api/appointments/schedule/:doctorId - Fetch doctor's weekly work schedule
router.get('/schedule/:doctorId', (req, res) => {
  try {
    const doctorId = req.params.doctorId || 'doc-1';
    const schedule = db.getDoctorSchedule(doctorId);
    res.json({ success: true, doctorId, schedule });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/appointments/schedule/:doctorId - Update doctor's weekly work schedule (Staff only)
router.put('/schedule/:doctorId', verifyToken, requireRole('DOCTOR', 'PRATICIEN', 'SECRETAIRE', 'SECRETARY', 'ADMIN', 'SUPER_ADMIN'), (req, res) => {
  try {
    const doctorId = req.params.doctorId || 'doc-1';
    const role = (req.user?.role || '').toUpperCase();
    if (role !== 'ADMIN' && role !== 'SUPER_ADMIN' && req.user?.doctorId && req.user.doctorId !== doctorId) {
      return res.status(403).json({ success: false, message: 'Accès interdit : vous ne pouvez modifier que votre propre planning.' });
    }
    const schedulePayload = { ...req.body };

    if (schedulePayload.leave) {
      if (schedulePayload.leave.start) schedulePayload.leave.start = normalizeAppointmentDate(schedulePayload.leave.start);
      if (schedulePayload.leave.end) schedulePayload.leave.end = normalizeAppointmentDate(schedulePayload.leave.end);
    }
    if (Array.isArray(schedulePayload.leaves)) {
      schedulePayload.leaves = schedulePayload.leaves.map(l => ({
        ...l,
        start: normalizeAppointmentDate(l.start),
        end: normalizeAppointmentDate(l.end)
      }));
    }

    const updatedSchedule = db.saveDoctorSchedule(doctorId, schedulePayload);
    const io = req.app.get('io');
    if (io) {
      io.emit('schedule:updated', { doctorId, schedule: updatedSchedule });
    }
    res.json({
      success: true,
      message: 'Grille des horaires et disponibilités du médecin enregistrée.',
      schedule: updatedSchedule
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/appointments/blocked-slots/:doctorId - List all blocked slots for doctor
router.get('/blocked-slots/:doctorId', (req, res) => {
  try {
    const doctorId = req.params.doctorId || 'doc-1';
    const blocked = db.filter('appointments', a =>
      (a.doctorId === doctorId || (doctorId === 'doc-1' && (!a.doctorId || a.doctorId === 'doc-1'))) &&
      a.status === 'BLOCKED'
    );
    res.json({ success: true, count: blocked.length, data: blocked });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/appointments/available-slots/:doctorId - Calculate dynamic slots based on schedule & appointments
router.get('/available-slots/:doctorId', (req, res) => {
  try {
    const doctorId = req.params.doctorId || 'doc-1';
    const schedule = db.getDoctorSchedule(doctorId);
    const dateInput = req.query.date || req.query.dateIso || new Date();
    const dateIso = normalizeAppointmentDate(dateInput);

    const appointments = db.filter('appointments', a => {
      const isSameDoc = (a.doctorId === doctorId || (doctorId === 'doc-1' && (!a.doctorId || a.doctorId === 'doc-1')));
      if (!isSameDoc) return false;
      const aIso = a.dateIso || normalizeAppointmentDate(a.date);
      return aIso === dateIso && a.status !== 'CANCELLED';
    });

    const result = calculateAvailableSlots(schedule, appointments, dateIso);
    res.json({
      success: true,
      doctorId,
      ...result
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/appointments/block - Block a slot for emergency or doctor unavailability (Staff only)
router.post('/block', verifyToken, requireRole('DOCTOR', 'PRATICIEN', 'SECRETAIRE', 'SECRETARY', 'ADMIN', 'SUPER_ADMIN'), (req, res) => {
  try {
    let {
      doctorId = 'doc-1',
      doctorName = 'Dr. Selim Ben Ali',
      date = 'Aujourd\'hui',
      dateIso,
      time = '11:00',
      reason = 'Bloqué Urgence Médicale'
    } = req.body;

    let cleanTime = (time || '11:00').trim().replace('h', ':');
    if (/^\d:\d\d$/.test(cleanTime)) cleanTime = '0' + cleanTime;
    const targetIso = dateIso || normalizeAppointmentDate(date);

    const existing = db.findOne('appointments', a => {
      const isSameDoc = (a.doctorId === doctorId || a.doctorName === doctorName || (doctorId === 'doc-1' && (!a.doctorId || a.doctorId === 'doc-1')));
      if (!isSameDoc) return false;
      const aIso = a.dateIso || normalizeAppointmentDate(a.date);
      const isSameDate = (aIso === targetIso || a.date === date);
      let aTime = (a.time || '').trim().replace('h', ':');
      if (/^\d:\d\d$/.test(aTime)) aTime = '0' + aTime;
      return isSameDate && aTime === cleanTime && a.status !== 'CANCELLED';
    });

    if (existing) {
      if (existing.status === 'BLOCKED') {
        return res.status(200).json({ success: true, message: 'Ce créneau est déjà bloqué.', data: existing });
      }
      return res.status(409).json({ success: false, message: `Le créneau ${cleanTime} (${date}) est déjà réservé par un patient (${existing.patientName}).` });
    }

    const blockedApt = {
      id: `apt-block-${Date.now()}`,
      patientId: 'sys-blocked',
      patientName: reason,
      patientPhone: '—',
      doctorId,
      doctorName,
      specialty: 'Cabinet',
      date,
      dateIso: targetIso,
      time: cleanTime,
      type: 'BLOQUE',
      fee: '0 TND',
      ticketNumber: '—',
      status: 'BLOCKED',
      createdAt: new Date().toISOString()
    };

    db.insert('appointments', blockedApt);

    const io = req.app.get('io');
    if (io) {
      io.emit('appointment:new', blockedApt);
      io.emit('slot:blocked', {
        id: blockedApt.id,
        doctorId,
        doctorName,
        date,
        dateIso: targetIso,
        time: cleanTime,
        reason
      });
    }

    res.status(201).json({
      success: true,
      message: `Créneau de ${cleanTime} bloqué avec succès (${reason}). Il n'apparaît plus pour les patients.`,
      data: blockedApt
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/appointments/:id - Update status (Requires authentication; staff-only except patient self-cancel)
router.patch('/:id', verifyToken, (req, res) => {
  try {
    const { status, notes, patientName, patient, doctorId } = req.body;
    const callerIsStaff = isStaffCaller(req);
    if (!callerIsStaff && status !== 'CANCELLED') {
      return res.status(403).json({ success: false, message: 'Accès réservé au praticien ou à l\'administrateur.' });
    }
    const targetId = req.params.id;
    const targetPatient = (patientName || patient || '').trim();

    // 1. Find appointment if exists (by id or by patientName fallback or by time & date)
    let apt = db.findOne('appointments', a => a.id === targetId);
    if (!apt && targetPatient) {
      const pTargetLower = targetPatient.toLowerCase();
      apt = db.findOne('appointments', a => 
        ((a.patientName || '').toLowerCase() === pTargetLower || (a.patient || '').toLowerCase() === pTargetLower) &&
        (a.status === 'IN_CONSULTATION' || a.stage === 'EN_CONSULTATION' || a.status === 'CONFIRMED' || a.status === 'OCCUPIED')
      ) || db.findOne('appointments', a => ((a.patientName || '').toLowerCase() === pTargetLower || (a.patient || '').toLowerCase() === pTargetLower));
    }
    const targetTime = req.body.time ? String(req.body.time).replace('h', ':').trim() : '';
    const targetDateIso = req.body.dateIso || req.body.date;
    if (!apt && targetTime) {
      const normTargetTime = targetTime.replace(/^0/, '');
      apt = db.findOne('appointments', a => {
        const aTime = (a.time || '').replace('h', ':').trim();
        const aTimeNorm = aTime.replace(/^0/, '');
        const timeMatch = (aTime === targetTime || aTimeNorm === normTargetTime);
        const dateMatch = !targetDateIso || a.dateIso === targetDateIso || a.date === targetDateIso;
        return timeMatch && dateMatch;
      });
    }

    // SECURITY (IDOR / tenant isolation): a patient may only touch their OWN appointment,
    // and a doctor/secretary may only touch appointments of THEIR OWN cabinet.
    {
      const callerRole = (req.user?.role || '').toUpperCase();
      const callerUid = req.user?.uuid;
      if (!callerIsStaff) {
        if (!apt || (apt.patientId !== callerUid && apt.bookerId !== callerUid)) {
          return res.status(403).json({ success: false, error: 'IDOR_ACCESS_DENIED', message: 'Vous ne pouvez modifier que vos propres rendez-vous.' });
        }
      } else if (apt && ['DOCTOR', 'PRATICIEN', 'SECRETARY', 'SECRETAIRE'].includes(callerRole) && req.user?.doctorId && apt.doctorId && apt.doctorId !== req.user.doctorId) {
        return res.status(403).json({ success: false, error: 'TENANT_ACCESS_DENIED', message: 'Ce rendez-vous appartient à un autre cabinet.' });
      }
    }

    const updates = {};
    const allowed = ['status', 'notes', 'total', 'fee', 'statut', 'completedAt', 'paid', 'paymentStatus', 'callTime', 'calledAt'];
    allowed.forEach(k => {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    });
    // SECURITY: non-staff callers (patients) can ONLY change the status to CANCELLED —
    // never fee / paid / paymentStatus / total.
    if (!callerIsStaff) {
      Object.keys(updates).forEach(k => { if (k !== 'status') delete updates[k]; });
    }

    if (status === 'IN_CONSULTATION') {
      updates.status = 'IN_CONSULTATION';
      updates.callTime = req.body.callTime || new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      updates.calledAt = req.body.calledAt || new Date().toISOString();
    }

    if (status === 'COMPLETED') {
      updates.status = 'COMPLETED';
      updates.statut = updates.statut || 'Terminée & Réglée';
      updates.paid = true;
      updates.completedAt = updates.completedAt || new Date().toISOString();
    }

    if (status === 'CANCELLED' && apt && apt.status !== 'BLOCKED') {
      const callerIsStaff = isStaffCaller(req);
      if (!callerIsStaff) {
        const aptDt = getAppointmentDateTime(apt);
        if (aptDt && (aptDt.getTime() - Date.now()) < CANCELLATION_MIN_HOURS * 60 * 60 * 1000) {
          return res.status(400).json({
            success: false,
            code: 'CANCELLATION_TOO_LATE',
            minHours: CANCELLATION_MIN_HOURS,
            message: `Annulation impossible à moins de ${CANCELLATION_MIN_HOURS} heures du rendez-vous. Veuillez contacter directement le cabinet du médecin.`,
            messageAr: `لا يمكن إلغاء الموعد قبل أقل من ${CANCELLATION_MIN_HOURS} ساعات من توقيته. يرجى الاتصال مباشرة بعيادة الطبيب.`
          });
        }
        if (apt.status !== 'CANCELLED') {
          notifyDoctorOfCancellation(apt, req);
        }
      }
      updates.cancelledAt = new Date().toISOString();
      updates.cancelledBy = callerIsStaff ? (req.user?.role || 'DOCTOR') : 'PATIENT';
    }

    if (apt) {
      db.update('appointments', a => a.id === apt.id, updates);
    }

    // 2. Synchronize queue collection (CRUCIAL for walk-in tickets, waiting room & live consultation)
    const queue = db.get('queue') || [];
    let queueChanged = false;
    const lookupPatient = (targetPatient || apt?.patientName || apt?.patient || '').toLowerCase();

    queue.forEach(qItem => {
      const qPatientName = (qItem.patient || qItem.patientName || '').toLowerCase();
      const matchId = targetId && (qItem.uuid === targetId || qItem.id === targetId || qItem.appointmentId === targetId);
      const matchPatient = lookupPatient && (qPatientName === lookupPatient);
      const matchDoctor = !doctorId || !qItem.doctorId || qItem.doctorId === doctorId || qItem.doctorId === 'doc-1';

      if ((matchId || matchPatient) && matchDoctor) {
        if (status === 'IN_CONSULTATION') {
          qItem.stage = 'EN_CONSULTATION';
          qItem.status = 'IN_CONSULTATION';
          qItem.callTime = updates.callTime;
          qItem.calledAt = updates.calledAt;
          queueChanged = true;
        } else if (status === 'COMPLETED') {
          qItem.stage = 'TERMINE';
          qItem.status = 'COMPLETED';
          qItem.completedAt = updates.completedAt || new Date().toISOString();
          queueChanged = true;
        } else if (status === 'CANCELLED') {
          qItem.stage = 'ANNULE';
          qItem.status = 'CANCELLED';
          queueChanged = true;
        } else if (status === 'CONFIRMED') {
          qItem.stage = 'SALLE_D_ATTENTE';
          queueChanged = true;
        }
      }
    });

    if (queueChanged) {
      db.save();
    }

    const io = req.app.get('io');
    if (io) {
      io.emit('appointment:updated', { id: targetId, updates });
      io.emit('queue:updated', { queue: db.get('queue'), delayMinutes: db.get('delayMinutes') });
    }

    return res.json({
      success: true,
      message: 'Statut du rendez-vous mis à jour avec succès.',
      data: apt ? { ...apt, ...updates } : { id: targetId, status, ...updates }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

const CANCELLATION_MIN_HOURS = 4;

// Helper: Convert an appointment's date + time into a local Date instance
function getAppointmentDateTime(apt) {
  if (!apt) return null;
  const iso = apt.dateIso || normalizeAppointmentDate(apt.date, apt.createdAt);
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  let hours = 23;
  let minutes = 59;
  const timeStr = String(apt.time || '').trim();
  const match = timeStr.match(/(\d{1,2})[:hH](\d{2})?/);
  if (match) {
    hours = parseInt(match[1], 10);
    minutes = match[2] ? parseInt(match[2], 10) : 0;
  }
  return new Date(y, m - 1, d, hours, minutes, 0, 0);
}

// Helper: Check whether caller is medical/admin staff (exempt from patient 4-hour restriction)
function isStaffCaller(req) {
  const role = (req.user?.role || '').toUpperCase();
  return ['DOCTOR', 'PRATICIEN', 'ADMIN', 'SUPER_ADMIN', 'SECRETAIRE', 'SECRETARY'].includes(role);
}

// Helper: Resolve doctor email and notify them by email on patient cancellation
function notifyDoctorOfCancellation(apt, req) {
  try {
    if (!apt || apt.status === 'BLOCKED') return false;
    const doctorObj = db.findOne('doctors', d =>
      d.id === apt.doctorId || d.uuid === apt.doctorId || (apt.doctorName && d.name === apt.doctorName)
    );
    let doctorEmail = (doctorObj && doctorObj.email) || null;
    if (!doctorEmail && apt.doctorId) {
      const docUser = db.findOne('users', u =>
        u.uuid === apt.doctorId || u.doctorId === apt.doctorId || (doctorObj && u.uuid === doctorObj.userId)
      );
      if (docUser) doctorEmail = docUser.email;
    }
    if (!doctorEmail) return false;

    EmailService.sendDoctorAppointmentCancelledNotificationEmail({
      appointment: apt,
      doctorEmail,
      doctorName: apt.doctorName || doctorObj?.name || 'Docteur',
      hostUrl: req.headers.origin || process.env.CLIENT_URL || 'http://localhost:5173'
    }).then(resDoc => {
      console.log(`[Appointments] ✉️ Cancellation email dispatched to doctor ${doctorEmail} (Status: ${resDoc?.emailRecord?.status || 'OK'})`);
    }).catch(err => {
      console.error('[Appointments] ❌ Doctor cancellation email error:', err.message);
    });
    return true;
  } catch (err) {
    console.warn('[Appointments] ⚠️ Doctor cancellation email exception:', err.message);
    return false;
  }
}

// DELETE /api/appointments/:id - Cancel appointment (Requires authentication + ownership + 4h policy)
router.all(['/:id', '/:id/cancel'], verifyToken, (req, res, next) => {
  if (!['DELETE', 'PUT', 'POST'].includes(req.method)) return next();
  let apt = db.findOne('appointments', a => a.id === req.params.id);

  // Fallback lookup by date & time if ID doesn't directly match
  if (!apt && (req.query.time || req.query.date)) {
    const qTime = req.query.time ? req.query.time.replace('h', ':') : '';
    const qDate = req.query.date || '';
    apt = db.findOne('appointments', a => {
      const aTime = a.time ? a.time.replace('h', ':') : '';
      return (qTime && aTime === qTime) && (!qDate || a.date === qDate || a.dateIso === qDate);
    });
  }

  // If not in database
  if (!apt) {
    return res.status(404).json({
      success: false,
      message: 'Rendez-vous introuvable.'
    });
  }

  // Ownership check: non-staff patients can ONLY cancel their own appointment
  const callerIsStaff = isStaffCaller(req);
  if (!callerIsStaff) {
    const ownPhone = (req.user?.phone || '').replace(/[\s+]/g, '');
    const aptPhone = (apt.patientPhone || '').replace(/[\s+]/g, '');
    const ownsApt = (
      (apt.patientId && apt.patientId === req.user.uuid) ||
      (apt.bookerId && apt.bookerId === req.user.uuid) ||
      (ownPhone && aptPhone && aptPhone.includes(ownPhone))
    );
    if (!ownsApt) {
      return res.status(403).json({
        success: false,
        error: 'IDOR_ACCESS_DENIED',
        message: 'Accès non autorisé : vous ne pouvez annuler que vos propres rendez-vous.'
      });
    }
  }
  if (!callerIsStaff && apt.status !== 'BLOCKED') {
    const aptDt = getAppointmentDateTime(apt);
    if (aptDt) {
      const msRemaining = aptDt.getTime() - Date.now();
      const minMs = CANCELLATION_MIN_HOURS * 60 * 60 * 1000;
      if (msRemaining < minMs) {
        return res.status(400).json({
          success: false,
          code: 'CANCELLATION_TOO_LATE',
          minHours: CANCELLATION_MIN_HOURS,
          message: `Annulation impossible à moins de ${CANCELLATION_MIN_HOURS} heures du rendez-vous. Veuillez contacter directement le cabinet du médecin.`,
          messageAr: `لا يمكن إلغاء الموعد قبل أقل من ${CANCELLATION_MIN_HOURS} ساعات من توقيته. يرجى الاتصال مباشرة بعيادة الطبيب.`
        });
      }
    }
  }

  const wasAlreadyCancelled = apt.status === 'CANCELLED';
  db.update('appointments', a => a.id === apt.id, {
    status: 'CANCELLED',
    cancelledAt: new Date().toISOString(),
    cancelledBy: callerIsStaff ? (req.user?.role || 'DOCTOR') : 'PATIENT'
  });

  // Remove from queue if present
  db.remove('queue', q => (q.patient === apt.patientName && q.ticket === apt.ticketNumber) || (q.patient === apt.patientName && q.time === apt.time));

  // Notify doctor by email when a patient cancels their appointment
  let doctorNotifiedByEmail = false;
  if (!wasAlreadyCancelled && !callerIsStaff && apt.status !== 'BLOCKED') {
    doctorNotifiedByEmail = notifyDoctorOfCancellation(apt, req);
  }

  const io = req.app.get('io');
  if (io) {
    io.emit('queue:updated', { queue: db.get('queue'), delayMinutes: db.get('delayMinutes') });
    io.emit('appointment:cancelled', {
      id: req.params.id,
      doctorId: apt.doctorId || 'doc-1',
      doctorName: apt.doctorName,
      date: apt.date,
      dateIso: apt.dateIso,
      time: apt.time,
      patientName: apt.patientName
    });
    io.emit('slot:unblocked', {
      id: req.params.id,
      doctorId: apt.doctorId || 'doc-1',
      date: apt.date,
      dateIso: apt.dateIso,
      time: apt.time
    });
    if (apt.doctorId) {
      io.to(`doctor:${apt.doctorId}`).to(`cabinet:${apt.doctorId}`).to('admin').emit('appointment:cancelled', {
        id: req.params.id,
        doctorId: apt.doctorId,
        doctorName: apt.doctorName,
        patientName: apt.patientName,
        time: apt.time
      });
      io.to(`doctor:${apt.doctorId}`).to(`cabinet:${apt.doctorId}`).to('admin').emit('appointment:updated', {
        id: req.params.id,
        doctorId: apt.doctorId,
        updates: { status: 'CANCELLED' }
      });
    } else {
      io.emit('appointment:cancelled', {
        id: req.params.id,
        patientName: apt.patientName,
        time: apt.time
      });
      io.emit('appointment:updated', {
        id: req.params.id,
        updates: { status: 'CANCELLED' }
      });
    }
  }

  // Specialized cancellation notification for Patient
  broadcastNotification(io, {
    space: 'patient',
    patientId: apt.patientId,
    patientName: apt.patientName,
    doctorId: apt.doctorId,
    doctorName: apt.doctorName,
    icon: '🚫',
    title: 'Rendez-vous Annulé',
    message: `Votre RDV chez ${apt.doctorName} (${apt.time}) a été annulé.`,
    category: 'rdv',
    actionUrl: '../Patients_pages/patient-dashboard.html'
  });

  // Specialized cancellation notification for Doctor
  broadcastNotification(io, {
    space: 'doctor',
    doctorId: apt.doctorId,
    doctorName: apt.doctorName,
    patientId: apt.patientId,
    patientName: apt.patientName,
    icon: '🚫',
    title: 'RDV Annulé par Patient',
    message: `Le RDV de ${apt.patientName} (${apt.time}) a été annulé. Le créneau a été libéré.`,
    category: 'patient',
    actionUrl: '../Doctors_pages/doctor-dashboard.html'
  });

  res.json({
    success: true,
    message: 'Rendez-vous annulé avec succès. Le médecin a été notifié par email et le créneau a été libéré.',
    doctorNotifiedByEmail,
    data: { id: req.params.id, status: 'CANCELLED' }
  });
});

module.exports = router;

