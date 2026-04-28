import crypto from 'crypto';

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { password } = req.body || {};
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected) return res.status(500).json({ error: 'ADMIN_PASSWORD non configuré' });
  if (!password || password !== expected) return res.status(401).json({ error: 'Mot de passe incorrect' });

  // Token signé valable 8h (simple HMAC)
  const payload = `${Date.now() + 8 * 3600 * 1000}`;
  const sig = crypto.createHmac('sha256', expected).update(payload).digest('hex');
  res.json({ token: `${payload}.${sig}` });
}
