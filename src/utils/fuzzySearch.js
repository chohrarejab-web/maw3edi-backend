/**
 * High-performance, accent-insensitive, typo-tolerant (fuzzy) search utilities for Node.js (CommonJS).
 * Handles:
 * - French accent normalization (é, è, ê, ë -> e, à, â -> a, etc.)
 * - Arabic diacritic & letter normalization (أ/إ/آ -> ا, ة -> ه, ى -> ي, etc.)
 * - Typo tolerance (Levenshtein distance & subsequence matching, e.g. "maldi" -> "maladies", "cadrio" -> "cardio")
 * - Medical synonyms & variants (e.g. "pediatre" -> "pédiatrie", "dentiste" -> "dentaire")
 */

function normalizeText(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ة]/g, 'ه')
    .replace(/[يى]/g, 'ي')
    .replace(/[ؤ]/g, 'و')
    .replace(/[ئ]/g, 'ي')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[-_.,'"`/\\()[\]{}|:;!?+*&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const row = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) row[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      let val;
      if (a[i - 1] === b[j - 1]) {
        val = row[j - 1];
      } else {
        val = Math.min(row[j - 1] + 1, prev + 1, row[j] + 1);
      }
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

function isSubsequence(sub, target, maxGap = 3) {
  if (!sub || !target) return false;
  if (sub.length > target.length) return false;
  if (sub[0] !== target[0]) return false;
  if ((target.length - sub.length) > maxGap) return false;

  let si = 0;
  let ti = 0;
  while (si < sub.length && ti < target.length) {
    if (sub[si] === target[ti]) si++;
    ti++;
  }
  return si === sub.length;
}

const MEDICAL_SYNONYMS = {
  'maldi': ['maladie', 'maladies', 'maladies vasculaires'],
  'maldie': ['maladie', 'maladies', 'maladies vasculaires'],
  'maldies': ['maladies', 'maladie', 'maladies vasculaires'],
  'maladi': ['maladie', 'maladies', 'maladies vasculaires'],
  'maladie': ['maladies', 'maladies vasculaires'],
  'maladies': ['maladie', 'maladies vasculaires'],
  'pediatre': ['pediatrie', 'pediatrie & neonatologie'],
  'pediatrie': ['pediatre', 'pediatrie & neonatologie'],
  'pidiatre': ['pediatrie', 'pediatre'],
  'cadrio': ['cardio', 'cardiologie', 'cardiologie & maladies vasculaires'],
  'cadriologie': ['cardiologie', 'cardio'],
  'cardio': ['cardiologie', 'cardiologie & maladies vasculaires'],
  'cardiologue': ['cardiologie', 'cardiologie & maladies vasculaires'],
  'dentiste': ['chirurgie dentaire & implantologie', 'dentaire'],
  'dentist': ['chirurgie dentaire & implantologie', 'dentaire'],
  'dentaire': ['chirurgie dentaire & implantologie', 'dentiste'],
  'generaliste': ['medecine generale & urgences', 'medecine generale'],
  'generalist': ['medecine generale & urgences', 'medecine generale'],
  'medecin': ['medecine generale', 'medecine'],
  'gyneco': ['gynecologie obstetrique & pma', 'gynecologie'],
  'gynecologue': ['gynecologie obstetrique & pma', 'gynecologie'],
  'gineco': ['gynecologie obstetrique & pma', 'gynecologie'],
  'ophtalmo': ['ophtalmologie & chirurgie refractive', 'ophtalmologie'],
  'ophtalmologue': ['ophtalmologie & chirurgie refractive', 'ophtalmologie'],
  'optalmo': ['ophtalmologie & chirurgie refractive', 'ophtalmologie'],
  'dermato': ['dermatologie & venerologie', 'dermatologie'],
  'dermatologue': ['dermatologie & venerologie', 'dermatologie'],
  'orl': ['oto rhino laryngologie (orl)', 'oto rhino laryngologie'],
  'ortho': ['chirurgie orthopedique & traumatologie', 'orthopedie'],
  'psy': ['psychiatrie & sante mentale', 'psychiatrie'],
  'radio': ['radiologie & imagerie medicale', 'radiologie'],
  'gastro': ['gastro enterologie & hepatologie', 'gastro enterologie']
};

function isWordFuzzyMatch(qWord, tWord) {
  if (!qWord || !tWord) return false;
  if (qWord === tWord) return true;

  if (qWord.length < 3 || tWord.length < 3) {
    return qWord === tWord;
  }

  if (tWord.includes(qWord)) return true;

  if (qWord.includes(tWord) && tWord.length >= 4 && tWord.length >= qWord.length * 0.75) {
    return true;
  }

  if (qWord.length >= 4 && tWord.length >= 4 && qWord.slice(0, 4) === tWord.slice(0, 4)) {
    if (Math.abs(tWord.length - qWord.length) <= 3) return true;
  }

  if (qWord.length >= 4 && isSubsequence(qWord, tWord, 3)) {
    return true;
  }

  const qLen = qWord.length;
  const tLen = tWord.length;
  const sameStart = qWord[0] === tWord[0];

  const dist = levenshteinDistance(qWord, tWord);

  if (sameStart) {
    if (qLen <= 5 && dist <= 1) return true;
    if (qLen >= 6 && dist <= 2 && Math.abs(qLen - tLen) <= 2) return true;
  } else {
    if (dist === 1 && Math.abs(qLen - tLen) <= 1) return true;
  }

  return false;
}

function fuzzyMatch(query, targetText) {
  if (!query) return true;
  if (!targetText) return false;

  const qNorm = normalizeText(query);
  const tNorm = normalizeText(targetText);

  if (!qNorm) return true;
  if (!tNorm) return false;

  if (tNorm.includes(qNorm)) return true;

  const stopWords = new Set(['dr', 'dr.', 'docteur', 'doctor', 'medecin', 'د', 'دكتور', 'طبيب', 'de', 'la', 'et', 'en', '&', 'le', 'les', 'des', 'du', 'au', 'aux']);
  const qTokens = qNorm.split(' ').filter(t => t.length >= 2 && !stopWords.has(t));
  const tTokens = tNorm.split(' ').filter(t => t.length >= 2 && !stopWords.has(t));

  if (qTokens.length === 0) {
    return tNorm.includes(qNorm);
  }

  const checkSynonymMatch = (token) => {
    const syns = MEDICAL_SYNONYMS[token];
    if (!syns) return false;
    for (const syn of syns) {
      const synNorm = normalizeText(syn);
      if (tNorm.includes(synNorm)) return true;
      const synTokens = synNorm.split(' ').filter(st => st.length >= 3);
      if (synTokens.length > 0 && synTokens.every(st => tTokens.some(tt => isWordFuzzyMatch(st, tt)))) {
        return true;
      }
    }
    return false;
  };

  if (checkSynonymMatch(qNorm)) {
    return true;
  }

  const allTokensMatch = qTokens.every(qTok => {
    if (tNorm.includes(qTok)) return true;
    if (tTokens.some(tTok => qTok.length >= 4 && isSubsequence(qTok, tTok, 3))) return true;
    if (checkSynonymMatch(qTok)) return true;
    return tTokens.some(tTok => isWordFuzzyMatch(qTok, tTok));
  });

  if (allTokensMatch) return true;

  const qCompact = qNorm.replace(/\s+/g, '');
  const tCompact = tNorm.replace(/\s+/g, '');
  if (tCompact.includes(qCompact)) return true;
  if (qCompact.length >= 5 && isSubsequence(qCompact, tCompact, 2)) return true;

  return false;
}

function matchDoctor(doc, keyword) {
  if (!keyword || !keyword.trim()) return true;
  if (!doc) return false;

  const targetFields = [
    doc.name,
    doc.nameAr,
    doc.specialty,
    doc.specialtyFr,
    doc.specialtyAr,
    doc.specialtyId,
    doc.specialtyCode,
    doc.city,
    doc.delegation,
    doc.address,
    doc.addressAr
  ].filter(Boolean).join(' ');

  return fuzzyMatch(keyword, targetFields);
}

module.exports = {
  normalizeText,
  levenshteinDistance,
  isSubsequence,
  isWordFuzzyMatch,
  fuzzyMatch,
  matchDoctor,
  MEDICAL_SYNONYMS
};
