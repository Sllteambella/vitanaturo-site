import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';

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
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { question, email } = req.body || {};
  if (!question || !email) return res.status(400).json({ error: 'Missing fields' });

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { prenom, nom, age, poids, taille, ville, telegram, allergies, traitements } = req.body || {};
    const imc = (poids && taille) ? (parseFloat(poids) / Math.pow(parseFloat(taille) / 100, 2)).toFixed(1) : null;
    const imcLabel = imc ? (imc < 18.5 ? 'insuffisance pondérale' : imc < 25 ? 'poids normal' : imc < 30 ? 'surpoids' : 'obésité') : null;
    const profile = [
      `Prénom : ${prenom || '—'}, Nom : ${nom || '—'}`,
      `Âge : ${age || '—'} ans, Poids : ${poids || '—'} kg, Taille : ${taille || '—'} cm${imc ? `, IMC : ${imc} (${imcLabel})` : ''}`,
      `Ville : ${ville || '—'}${telegram ? `, Telegram : ${telegram}` : ''}`,
      `Allergies : ${allergies || 'aucune connue'}`,
      `Traitements actuels : ${traitements || 'aucun'}`,
    ].join('\n');

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `PROFIL DU PATIENT :\n${profile}\n\nQUESTION :\n${question}` }],
    });
    const answer = message.content[0].text;

    await Promise.allSettled([
      sendEmail(email, question, answer),
      process.env.HUBSPOT_TOKEN ? hubspotUpsert(email, question, answer) : Promise.resolve(),
      process.env.TELEGRAM_ADMIN_ID ? notifyAdmin(email, question, answer, req.body) : Promise.resolve(),
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Question API error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
}

async function sendEmail(to, question, answer) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

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
    <p style="font-style:italic;color:#555;border-left:3px solid #5d9e72;padding-left:1rem;margin:0 0 2rem;line-height:1.6">${question}</p>
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
  const { prenom, nom, age, poids, taille, ville, telegram } = body || {};
  const imc = (poids && taille) ? (parseFloat(poids) / Math.pow(parseFloat(taille) / 100, 2)).toFixed(1) : null;

  const header = [
    `🌿 *Nouveau lead VitaNaturo*`,
    ``,
    `👤 ${prenom || ''} ${nom || ''}, ${age || '?'} ans — ${ville || '?'}`,
    imc ? `📊 IMC : ${imc} | ${poids}kg / ${taille}cm` : '',
    `📧 ${email}`,
    telegram ? `✈️ Telegram : ${telegram}` : '',
    ``,
    `❓ *Question :*`,
    question,
  ].filter(Boolean).join('\n');

  const sendMsg = (text) => fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_ADMIN_ID, text, parse_mode: 'Markdown' }),
  });

  await sendMsg(header);

  // Send full answer split into 4000-char chunks (Telegram limit is 4096)
  const chunks = answer.match(/[\s\S]{1,4000}/g) || [answer];
  for (const chunk of chunks) {
    await sendMsg(chunk);
  }
}
