/**
 * SahaTN / Maw2idi — AI Clinical Assistant API Route
 * Connects DocBot to Fine-Tuned Llama-3/Mistral Models (Ollama, vLLM, HF)
 * Features Clinical Fallback & INPDP Triage Audit Logging
 */

const express = require('express');
const { recordAuditLog, sanitizeInput } = require('../middleware/security.middleware');

const router = express.Router();

const OLLAMA_URL = process.env.DOCBOT_OLLAMA_URL || 'http://localhost:11434';
const MODEL_NAME = process.env.DOCBOT_MODEL_NAME || 'docbot-sahatn';

// Fallback Medical Rules Engine (when fine-tuned local LLM daemon is offline)
const CLINICAL_KNOWLEDGE = [
  {
    redFlag: true,
    triggers: ['infarctus', 'douleur poitrine', 'bras gauche', 'wji3a fel 9alb', 'sedri', 'dhabba 9wya', 'thabtet fi yedi', '9albi yo9ros'],
    fr: "⚠️ **ALERTE URGENCE VITALE (SUSPICION CARDIO-VASCULAIRE)**\nVos symptômes peuvent correspondre à une urgence cardiologique critique. Ne prenez pas le volant. Appelez immédiatement le **SAMU 190** ou la **Protection Civile 198**.",
    ar: "⚠️ **تنبيه استعجالي حيوي (اشتباه في أزمة قلبية حادة)**\nالأعراض التي ذكرتها تتطلب تدخلاً طبياً فورياً. يرجى الاتصال العاجل بالإسعاف الوطني **190** أو الحماية المدنية **198**.",
    action: { type: 'EMERGENCY', tel: '190' }
  },
  {
    redFlag: true,
    triggers: ['avc', 'fommha 3waj', 'paralysie', 'th9ila', '3waj', 'perte de force', 'faiblesse bras'],
    fr: "🚨 **ALERTE SUSPICION AVC (ACCIDENT VASCULAIRE CÉRÉBRAL)**\nSignes neurologiques d'asymétrie faciale ou perte de force motrice. Appelez immédiatement le **SAMU 190**. Notez l'heure précise des premiers symptômes.",
    ar: "🚨 **حالة طوارئ قصوى: اشتباه في جلطة دماغية**\nيرجى الاتصال فوراً بالإسعاف على الرقم 190.",
    action: { type: 'EMERGENCY', tel: '190' }
  },
  {
    redFlag: true,
    triggers: ['etouffement', 'dahka', 'ne respirer plus', 'dyspnee aigue', 's5ana 40'],
    fr: "⚠️ **ALERTE DÉTRESSE RESPIRATOIRE / HYPERTHERMIE**\nDifficulté respiratoire aiguë ou fièvre très élevée. Contactez le **190** sans attendre.",
    ar: "⚠️ **حالة طوارئ تنفسية أو حمى شديدة**\nيرجى الاتصال فوراً بالإسعاف على الرقم **190**.",
    action: { type: 'EMERGENCY', tel: '190' }
  },
  {
    specialty: 'cardio',
    specialtyFr: 'Cardiologie & Maladies Vasculaires',
    triggers: ['9alb', 'coeur', 'tension', 'palpitation', 'cardio', 'dhabba', 'hypertension', 'hta'],
    fr: "Vos symptômes suggèrent une consultation en **Cardiologie & Maladies Vasculaires**. Le Dr. Selim Ben Ali ou un spécialiste conventionné CNAM peut vous recevoir rapidement.",
    action: { type: 'FILTER', filterKey: 'cardio', label: 'Voir les Cardiologues 🩺' }
  },
  {
    specialty: 'pediatrie',
    specialtyFr: 'Pédiatrie & Soins Enfants',
    triggers: ['bebe', 'sghir', 'enfant', 'pediatre', 's5ana', 'vaccin bebe', 'tbib sghar'],
    fr: "Il s'agit d'un motif pédiatrique pour nourrisson ou enfant. Le Dr. Meriem Karray (Pédiatre) dispose de créneaux aujourd'hui.",
    action: { type: 'FILTER', filterKey: 'pediatrie', label: 'Voir les Pédiatres 👶' }
  },
  {
    specialty: 'dentiste',
    specialtyFr: 'Médecine Dentaire & Chirurgie Orale',
    triggers: ['dent', 'dents', 'dharsa', 'senik', 'fomm', 'gencive', 'rage de dent', 'dharsati'],
    fr: "Douleur dentaire ou gingivale identifiée. Nous vous orientons vers un **Chirurgien-Dentiste** disponible.",
    action: { type: 'FILTER', filterKey: 'dentiste', label: 'Trouver un Dentiste 🦷' }
  },
  {
    specialty: 'ophtalmo',
    specialtyFr: 'Ophtalmologie & Troubles de la Vue',
    triggers: ['yeux', 'oeil', '3iniya', 'chouf', 'lunettes', 'vision', '3inaya'],
    fr: "Trouble visuel ou gêne oculaire. Un bilan chez un **Ophtalmologue** est fortement recommandé.",
    action: { type: 'FILTER', filterKey: 'ophtalmo', label: 'Voir les Ophtalmologues 👁️' }
  },
  {
    specialty: 'gyneco',
    specialtyFr: 'Gynécologie & Obstétrique',
    triggers: ['grossesse', '7bela', 'bebe f kerch', 'regles', 'wleda', 'gyneco', 'echographie'],
    fr: "Suivi de grossesse ou motif gynécologique. Prenez rendez-vous avec un(e) **Gynécologue Obstétricien(ne)**.",
    action: { type: 'FILTER', filterKey: 'gyneco', label: 'Voir les Gynécologues 🤰' }
  },
  {
    specialty: 'ortho',
    specialtyFr: 'Chirurgie Orthopédique & Traumatologie',
    triggers: ['rkobti', 'rkoybi', 'genou', 'cheville', 'kasra', 'fracture', 'entorse'],
    fr: "Douleur articulaire ou traumatisme ostéo-articulaire. Un bilan auprès d'un **Chirurgien Orthopédiste** est indiqué.",
    action: { type: 'FILTER', filterKey: 'generaliste', label: 'Consulter un Orthopédiste 🦴' }
  },
  {
    specialty: 'generaliste',
    specialtyFr: 'Médecine Générale',
    triggers: ['grippe', 'rhume', 'rasyouja3', 'raski', 'fatigue', 'maux de tete', 'wji3a', 'frouda', 'guerjoumti'],
    fr: "Symptômes généraux (syndrome grippal, céphalées, maux de gorge). Un **Médecin Généraliste** peut établir votre diagnostic initial.",
    action: { type: 'FILTER', filterKey: 'generaliste', label: 'Médecins Généralistes 🩺' }
  }
];

// POST /api/ai/docbot - Query AI assistant
router.post('/docbot', async (req, res) => {
  try {
    const { query = '', history = [] } = req.body;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ success: false, message: 'Requête vide.' });
    }

    const clientIp = req.socket?.remoteAddress || '127.0.0.1';

    // 1. Try querying fine-tuned model on Ollama/vLLM if online
    let aiResponse = null;
    let engineUsed = 'FALLBACK_CLINICAL_NLP';

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000); // Fast 2s check

      const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL_NAME,
          prompt: query,
          stream: false
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (ollamaRes.ok) {
        const data = await ollamaRes.json();
        if (data.response) {
          aiResponse = data.response;
          engineUsed = `FINE_TUNED_MODEL (${MODEL_NAME})`;
        }
      }
    } catch (e) {
      // Ollama offline or model not loaded yet — fallback cleanly
    }

    // 2. Clinical Rules Fallback if LLM is not actively running
    let action = null;
    let redFlag = false;

    if (!aiResponse) {
      const qLower = query.toLowerCase();
      let match = null;

      for (const item of CLINICAL_KNOWLEDGE) {
        for (const t of item.triggers) {
          if (qLower.includes(t)) {
            match = item;
            break;
          }
        }
        if (match) break;
      }

      if (match) {
        aiResponse = match.fr;
        action = match.action;
        redFlag = !!match.redFlag;
      } else {
        aiResponse = "Merci pour votre description. Afin d'affiner votre orientation, pouvez-vous préciser si le symptôme s'accompagne de fièvre, de vertiges ou d'une douleur aiguë ?";
        action = { type: 'FILTER', filterKey: 'generaliste', label: 'Consulter un Généraliste 🩺' };
      }
    }

    // 3. INPDP Audit Trail Logging
    recordAuditLog({
      action: 'DOCBOT_TRIAGE',
      actorId: req.user?.uuid || 'anonymous-patient',
      actorRole: req.user?.role || 'PATIENT',
      resource: 'AI_CLINICAL_TRIAGE',
      resourceId: redFlag ? 'EMERGENCY_DETECTED' : (action?.filterKey || 'ROUTINE'),
      ip: clientIp,
      status: 'SUCCESS',
      details: `DocBot Triage query [${engineUsed}]: "${query.substring(0, 50)}..."`
    });

    res.json({
      success: true,
      engine: engineUsed,
      reply: aiResponse,
      action,
      redFlag,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur DocBot: ' + err.message });
  }
});

// POST /api/ai/translate - Real-Time Translation Endpoint (FR <-> AR)
router.post('/translate', async (req, res) => {
  try {
    const { text = '', targetLang = 'ar', sourceLang = 'auto' } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ success: false, message: 'Texte vide.' });
    }

    const trimmed = text.trim();
    const isAr = /[\u0600-\u06FF]/.test(trimmed);

    // Fast return if already in target language
    if ((targetLang === 'ar' && isAr) || (targetLang === 'fr' && !isAr)) {
      return res.json({ success: true, translatedText: text });
    }

    const pair = targetLang === 'ar' ? 'fr|ar' : 'ar|fr';
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(trimmed)}&langpair=${encodeURIComponent(pair)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const apiRes = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (apiRes.ok) {
      const data = await apiRes.json();
      if (data && data.responseData && typeof data.responseData.translatedText === 'string') {
        let translated = data.responseData.translatedText
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&apos;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>');
        return res.json({ success: true, translatedText: translated });
      }
    }

    return res.json({ success: true, translatedText: text });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Erreur traduction: ' + err.message, translatedText: req.body.text || '' });
  }
});

module.exports = router;
