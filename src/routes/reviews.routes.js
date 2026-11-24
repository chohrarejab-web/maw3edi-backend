const express = require('express');
const db = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate.middleware');
const { broadcastNotification } = require('./notifications.routes');

const router = express.Router();

// GET /api/reviews
router.get('/', (req, res) => {
  const { doctorId, includeModerated } = req.query;
  let reviews = db.get('reviews');

  if (doctorId) {
    reviews = reviews.filter(r => r.doctorId === doctorId);
  }

  // Masquer les avis modérés sur les pages publiques sauf si explicitement demandé
  if (includeModerated !== 'true') {
    reviews = reviews.filter(r => {
      const s = (r.status || 'PUBLIÉ').toUpperCase();
      return s !== 'MODÉRÉ' && s !== 'MASQUÉ';
    });
  }

  res.json({
    success: true,
    count: reviews.length,
    data: reviews
  });
});

// POST /api/reviews - Certified patient review (Authenticated users only)
router.post(
  '/',
  verifyToken,
  validateBody({
    doctorId: { type: 'string', required: true, maxLen: 120 },
    rating: { type: 'number', min: 1, max: 5 },
    comment: { type: 'string', maxLen: 2000 }
  }),
  (req, res) => {
  try {
    const {
      doctorId,
      patientName = 'Patient Vérifié',
      patientId = null,
      userId = null,
      displayInitial = null,
      rating = 5.0,
      criteria = { punctuality: 5.0, bedsideManner: 5.0, hygiene: 5.0, careQuality: 5.0 },
      tags = [],
      comment = ''
    } = req.body;

    if (!doctorId) {
      return res.status(400).json({ success: false, message: 'L\'identifiant du médecin est requis.' });
    }

    if (!patientName || patientName.trim() === '') {
      return res.status(400).json({ success: false, message: 'Le nom du patient connecté est requis pour soumettre un avis.' });
    }

    const trimmedName = patientName.trim();
    const parts = trimmedName.split(/\s+/);
    const initial = displayInitial || (parts.length >= 2 ? `${parts[0]} ${parts[1][0]}.` : trimmedName);

    const newReview = {
      id: `rev-${Date.now()}`,
      doctorId,
      patientName: trimmedName,
      patientId: patientId || userId || null,
      userId: userId || patientId || null,
      displayInitial: initial,
      date: new Date().toLocaleDateString('fr-TN', { day: 'numeric', month: 'long', year: 'numeric' }),
      rating: parseFloat(rating) || 5.0,
      criteria,
      tags: Array.isArray(tags) ? tags : [tags],
      comment,
      status: 'PUBLIÉ',
      verified: true,
      createdAt: new Date().toISOString(),
      reply: null
    };

    const doctor = db.findOne('doctors', d => d.id === doctorId || d.uuid === doctorId);
    newReview.uuid = newReview.id;
    newReview.doctor = doctor ? doctor.name : (doctorId === 'doc-1' ? 'Dr. Selim Ben Ali' : 'Médecin Traitant');
    newReview.patient = patientName;

    db.insert('reviews', newReview);

    // Update doctor's aggregate rating
    const docReviews = db.filter('reviews', r => r.doctorId === doctorId);
    if (docReviews.length && doctor) {
      const avg = (docReviews.reduce((acc, r) => acc + (parseFloat(r.rating) || 5.0), 0) / docReviews.length).toFixed(2);
      db.update('doctors', d => d.id === doctorId || d.uuid === doctorId, {
        rating: parseFloat(avg),
        reviewCount: docReviews.length,
        reviewsCount: docReviews.length
      });
    }

    try {
      const io = req.app.get('io');
      if (io) {
        io.emit('review:new', { doctorId, review: newReview });
      }
      if (io && typeof broadcastNotification === 'function') {
        broadcastNotification(io, {
          space: 'doctor',
          doctorId: doctorId,
          doctorName: doctor ? doctor.name : null,
          icon: '⭐',
          title: 'Nouvel Avis Patient Certifié',
          message: `${newReview.displayInitial}: « ${(newReview.comment || 'Avis positif').slice(0, 60)} » (${newReview.rating}★)`,
          category: 'avis',
          actionUrl: '../Doctors_pages/doctor-dashboard.html'
        });
      }
    } catch (notifErr) {
      console.warn('[Reviews] Notification warning:', notifErr.message);
    }

    res.status(201).json({
      success: true,
      message: 'Avis certifié publié avec succès !',
      data: newReview
    });
  } catch (err) {
    console.error('[Reviews] Error submitting review:', err);
    res.status(500).json({ success: false, message: 'Erreur lors de la publication de l\'avis: ' + err.message });
  }
});

// POST /api/reviews/reply - Doctor responds to patient review (Doctors & Admins only)
router.post('/reply', verifyToken, requireRole('DOCTOR', 'PRATICIEN', 'ADMIN', 'SUPER_ADMIN'), validateBody({ reviewId: { type: 'string', required: true }, text: { type: 'string', required: true, minLen: 2, maxLen: 2000 } }), (req, res) => {
  const { reviewId, doctorName = 'Dr. Selim Ben Ali', text } = req.body;

  if (!reviewId || !text) {
    return res.status(400).json({ success: false, message: 'reviewId et texte de réponse requis.' });
  }

  const review = db.findOne('reviews', r => r.id === reviewId);
  if (!review) {
    return res.status(404).json({ success: false, message: 'Avis introuvable.' });
  }

  const replyData = {
    author: `Votre Réponse Publique (${doctorName})`,
    doctorName,
    date: new Date().toLocaleDateString('fr-TN', { day: 'numeric', month: 'long', year: 'numeric' }),
    text
  };

  db.update('reviews', r => r.id === reviewId, { reply: replyData });

  try {
    const io = req.app.get('io');
    if (io) {
      io.emit('review:reply', { doctorId: review.doctorId, reviewId, reply: replyData });
      io.emit('review:updated', { doctorId: review.doctorId, reviewId, reply: replyData });
    }
  } catch (socketErr) {
    console.warn('[Reviews] Socket warning:', socketErr);
  }

  res.json({
    success: true,
    message: 'Réponse du praticien publiée avec succès !',
    data: replyData
  });
});

module.exports = router;
