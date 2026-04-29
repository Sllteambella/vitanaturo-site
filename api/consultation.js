import { saveConsultation } from '../lib/firestoreClient.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { formData } = body;

  if (!formData || !formData.email || !formData.nom) {
    return res.status(400).json({ error: 'Données manquantes' });
  }

  try {
    await saveConsultation({
      prenom: String(formData.prenom || '').trim() || null,
      nom: String(formData.nom || '').trim(),
      email: String(formData.email || '').trim(),
      age: formData.age ? Number(formData.age) : null,
      poids: formData.poids ? Number(formData.poids) : null,
      taille: formData.taille ? Number(formData.taille) : null,
      ville: String(formData.ville || '').trim() || null,
      telegram: String(formData.telegram || '').trim() || null,
      question: String(formData.question || '').trim() || null,
      source: 'consultation_form',
    });
  } catch (err) {
    console.error('saveConsultation error:', err);
    return res.status(500).json({ error: 'Erreur enregistrement' });
  }

  try {
    await notifyAdmin(formData);
  } catch (err) {
    console.error('Telegram notify error:', err);
  }

  return res.json({ ok: true });
}

async function notifyAdmin(formData) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_ADMIN_ID) return;

  const { prenom, nom, age, email, ville, question } = formData || {};

  const text = [
    `🌿 *Nouveau lead VitaNaturo – Divinus Tactus*`,
    ``,
    `👤 ${escape(nom)}, ${escape(String(age ?? '?'))} ans — ${escape(ville || '?')}`,
    `📧 ${escape(email)}`,
    `❓ ${escape(question || '')}`,
    ``,
    `💬 🌿 Dr\\. VitaNaturo — Attente de réponse\\.\\.\\.`,
  ].join('\n');

  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_ADMIN_ID,
      text,
      parse_mode: 'MarkdownV2',
    }),
  });
}

function escape(str) {
  return String(str || '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
