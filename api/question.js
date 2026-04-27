import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
import { getDb } from '../lib/firestoreClient.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 8;

if (!globalThis.__vitanaturoRateLimitStore) {
  globalThis.__vitanaturoRateLimitStore = new Map();
}

const SYSTEM_PROMPT = `Tu es Dr. VitaNaturo, naturopathe et expert en phytothérapie. Un visiteur vient de poser une question via le site vitanaturo.vercel.app.
Rédige une réponse complète et personnalisée (500-700 mots) structurée ainsi :

🌿 **1. Plantes recommandées**
Cite 2 à 3 plantes avec nom commun + latin, mécanisme d'action et pourquoi elles correspondent au profil du patient.

💊 **2. Posologie et formes galéniques**
Pour chaque plante : tisane, gélule, teinture-mère ou EPS — dosage précis, durée de cure.

🥗 **3. Conseils nutritionnels**
Aliments à favoriser et à éviter en lien avec la problématique. Micronutriments utiles (zinc, magnésium, oméga-3…).

🏃 **4. Hygiène de vie & activité physique**
Recommandations adaptées (sport, sommeil, stress, hydratation) en tenant compte de l'IMC et de l'âge du patient.

⚠️ **5. Précautions et contre-indications**
Interactions médicamenteuses, contre-indications absolues, populations à risque.

📚 **6. Sources**
ANSM, ESCOP, Commission E allemande, études cliniques PubMed si disponibles.

🩺 **7. Quand consulter**
Signes d'alerte nécessitant une consultation médicale urgente.

Réponds en français. Sois précis, sourcé et bienveillant. Personalise la réponse avec le prénom du patient. Termine en invitant à continuer sur le bot Telegram VitaNaturo pour un suivi personnalisé.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const {
    question,
    email,
    prenom,
    nom,
    age,
    poids,
    taille,
    ville,
    telegram,
    allergies,
    traitements,
  } = body;

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Email invalide' });
  }
  if (!isNonEmptyString(question, 5, 2000)) {
    return res.status(400).json({ error: 'Question invalide' });
  }

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ error: 'Trop de requêtes. Réessaie dans une minute.' });
  }

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  const isDryRun = parseBooleanEnv(process.env.DRY_RUN);

  if (!anthropicApiKey || (!isDryRun && (!gmailUser || !gmailAppPassword))) {
    return res.status(500).json({ error: 'Configuration serveur incomplète' });
  }

  try {
    const client = new Anthropic({ apiKey: anthropicApiKey });
    const trimmedQuestion = question.trim();
    const plantContext = await getPlantContext(trimmedQuestion);
    const normalizedAge = toBoundedNumber(age, 0, 120);
    const normalizedPoids = toBoundedNumber(poids, 20, 400);
    const normalizedTaille = toBoundedNumber(taille, 50, 250);
    const imc = (normalizedPoids && normalizedTaille)
      ? (normalizedPoids / Math.pow(normalizedTaille / 100, 2)).toFixed(1)
      : null;
    const imcLabel = imc ? (imc < 18.5 ? 'insuffisance pondérale' : imc < 25 ? 'poids normal' : imc < 30 ? 'surpoids' : 'obésité') : null;
    const profile = [
      `Prénom : ${cleanOptionalString(prenom, 80) || '—'}, Nom : ${cleanOptionalString(nom, 80) || '—'}`,
      `Âge : ${normalizedAge ?? '—'} ans, Poids : ${normalizedPoids ?? '—'} kg, Taille : ${normalizedTaille ?? '—'} cm${imc ? `, IMC : ${imc} (${imcLabel})` : ''}`,
      `Ville : ${cleanOptionalString(ville, 120) || '—'}${cleanOptionalString(telegram, 120) ? `, Telegram : ${cleanOptionalString(telegram, 120)}` : ''}`,
      `Allergies : ${cleanOptionalString(allergies, 600) || 'aucune connue'}`,
      `Traitements actuels : ${cleanOptionalString(traitements, 600) || 'aucun'}`,
    ].join('\n');

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `PROFIL DU PATIENT :\n${profile}\n\nCONTEXTE PLANTES (FIRESTORE) :\n${plantContext}\n\nQUESTION :\n${trimmedQuestion}`,
      }],
    });
    const answer = message.content[0].text;

    if (!isDryRun) {
      await Promise.allSettled([
        sendEmail(email, trimmedQuestion, answer),
        process.env.HUBSPOT_TOKEN ? hubspotUpsert(email, trimmedQuestion, answer) : Promise.resolve(),
        process.env.TELEGRAM_ADMIN_ID ? notifyAdmin(email, trimmedQuestion, answer, body) : Promise.resolve(),
      ]);
    }

    res.json({ ok: true, dryRun: isDryRun });
  } catch (err) {
    console.error('Question API error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
}

async function sendEmail(to, question, answer) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  const safeQuestion = escapeHtml(String(question || ''));
  const htmlAnswer = answer
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  await transporter.sendMail({
    from: `"VitaNaturo" <${process.env.GMAIL_USER}>`,
    to,
    subject: 'Votre conseil phytothérapie — VitaNaturo',
    html: `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f4f7f4;font-family:Georgia,serif">
<div style="max-width:600px;margin:0 auto">
  <div style="background:#090f0b;padding:2rem;text-align:center">
    <span style="font-family:Georgia,serif;font-size:1.4rem;font-weight:300;font-style:italic;color:#f0ead8">
      Vita<span style="color:#5d9e72">Naturo</span>
    </span>
  </div>
  <div style="background:#ffffff;padding:2.5rem">
    <p style="color:#5d9e72;font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;font-family:sans-serif;margin:0 0 .75rem">Votre question</p>
    <p style="font-style:italic;color:#555;border-left:3px solid #5d9e72;padding-left:1rem;margin:0 0 2rem;line-height:1.6">${safeQuestion}</p>
    <p style="color:#5d9e72;font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;font-family:sans-serif;margin:0 0 .75rem">Notre conseil</p>
    <div style="color:#2a3a2a;line-height:1.85;font-size:.95rem">${htmlAnswer}</div>
    <hr style="border:none;border-top:1px solid #d4e4d4;margin:2rem 0">
    <p style="font-size:.78rem;color:#888;line-height:1.6;font-family:sans-serif">
      ⚠️ Ce conseil est fourni à titre d'information uniquement et ne constitue pas un diagnostic médical. Consultez toujours un professionnel de santé pour tout problème médical.
    </p>
    <div style="margin-top:1.5rem;text-align:center">
      <a href="https://t.me/VitaNaturoBot" style="display:inline-block;background:#5d9e72;color:#fff;padding:.85rem 2rem;text-decoration:none;font-size:.75rem;letter-spacing:.12em;text-transform:uppercase;font-family:sans-serif;font-weight:600">
        Continuer sur Telegram →
      </a>
    </div>
  </div>
  <div style="background:#090f0b;padding:1rem;text-align:center">
    <p style="color:#7a9484;font-size:.7rem;margin:0;font-family:sans-serif">© 2026 VitaNaturo · Information non médicale · <a href="mailto:sllteam1970@gmail.com" style="color:#5d9e72">sllteam1970@gmail.com</a></p>
  </div>
</div>
</body></html>`,
  });
}

async function hubspotUpsert(email, question, answer) {
  const headers = {
    'Authorization': `Bearer ${process.env.HUBSPOT_TOKEN}`,
    'Content-Type': 'application/json',
  };

  let contactId;
  const createRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
    method: 'POST',
    headers,
    body: JSON.stringify({ properties: { email, lifecyclestage: 'lead', hs_lead_status: 'NEW' } }),
  });

  if (createRes.ok) {
    contactId = (await createRes.json()).id;
  } else if (createRes.status === 409) {
    const getRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email`,
      { headers },
    );
    if (getRes.ok) contactId = (await getRes.json()).id;
  }

  if (!contactId) return;

  await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      properties: {
        hs_note_body: `❓ Question site VitaNaturo :\n${question}\n\n💬 Réponse IA :\n${answer}`,
        hs_timestamp: String(Date.now()),
      },
      associations: [{
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
      }],
    }),
  });
}

async function notifyAdmin(email, question, answer, body) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_ADMIN_ID) return;
  const { prenom, nom, age, poids, taille, ville, telegram } = body || {};
  const normalizedPoids = toBoundedNumber(poids, 20, 400);
  const normalizedTaille = toBoundedNumber(taille, 50, 250);
  const imc = (normalizedPoids && normalizedTaille) ? (normalizedPoids / Math.pow(normalizedTaille / 100, 2)).toFixed(1) : null;

  const header = [
    `🌿 *Nouveau lead VitaNaturo*`,
    ``,
    `👤 ${escapeTelegramMarkdown(cleanOptionalString(prenom, 80) || '')} ${escapeTelegramMarkdown(cleanOptionalString(nom, 80) || '')}, ${escapeTelegramMarkdown(String(toBoundedNumber(age, 0, 120) ?? '?'))} ans — ${escapeTelegramMarkdown(cleanOptionalString(ville, 120) || '?')}`,
    imc ? `📊 IMC : ${escapeTelegramMarkdown(imc)} | ${escapeTelegramMarkdown(String(normalizedPoids))}kg / ${escapeTelegramMarkdown(String(normalizedTaille))}cm` : '',
    `📧 ${escapeTelegramMarkdown(email)}`,
    cleanOptionalString(telegram, 120) ? `✈️ Telegram : ${escapeTelegramMarkdown(cleanOptionalString(telegram, 120))}` : '',
    ``,
    `❓ *Question :*`,
    escapeTelegramMarkdown(question),
  ].filter(Boolean).join('\n');

  const sendMsg = (text) => fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_ADMIN_ID, text, parse_mode: 'Markdown' }),
  });

  await sendMsg(header);

  // Send full answer split into 4000-char chunks (Telegram limit is 4096)
  const chunks = escapeTelegramMarkdown(answer).match(/[\s\S]{1,4000}/g) || [escapeTelegramMarkdown(answer)];
  for (const chunk of chunks) {
    await sendMsg(chunk);
  }
}

function getClientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(key) {
  const store = globalThis.__vitanaturoRateLimitStore;
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

function isNonEmptyString(value, min, max) {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
}

function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  const email = value.trim();
  if (email.length < 5 || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function toBoundedNumber(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function cleanOptionalString(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeTelegramMarkdown(value) {
  return String(value || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function parseBooleanEnv(value) {
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

async function getPlantContext(keywords) {
  if (!isNonEmptyString(keywords, 2, 2000)) {
    return 'Aucun mot-clé pertinent.';
  }

  const normalizedKeywords = keywords
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3)
    .slice(0, 8);

  if (!normalizedKeywords.length) {
    return 'Aucun mot-clé pertinent extrait.';
  }

  try {
    const db = getDb();
    const snapshot = await db.collection('plants').get();

    const matches = [];
    snapshot.forEach((doc) => {
      const p = doc.data();
      const searchable = [p.name, p.latin_name, p.properties, p.usage, p.full_text]
        .filter(Boolean).join(' ').toLowerCase();
      const score = normalizedKeywords.filter((kw) => searchable.includes(kw)).length;
      if (score > 0) matches.push({ ...p, score });
    });

    matches.sort((a, b) => b.score - a.score);
    const top = matches.slice(0, 5);

    if (!top.length) return 'Aucune plante correspondante trouvée en base.';

    return top.map((p) => [
      `- ${p.name || 'Plante inconnue'} (${p.latin_name || 'latin non renseigné'})`,
      `  Propriétés: ${p.properties || 'non renseignées'}`,
      `  Usage: ${p.usage || 'non renseigné'}`,
      `  Posologie: ${p.dosage || 'non renseignée'}`,
      `  Contre-indications: ${p.contraindications || 'non renseignées'}`,
    ].join('\n')).join('\n');
  } catch (err) {
    console.error('Firestore getPlantContext error:', err.message);
    return 'Contexte plantes indisponible.';
  }
}
