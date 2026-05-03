import crypto from 'crypto';
import { getDb } from '../../lib/firestoreClient.js';

function verifyToken(token, secret) {
  if (!token || !secret) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (sig !== expected) return false;
  return Date.now() < parseInt(payload, 10);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers['x-admin-token'];
  if (!verifyToken(token, process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const db = getDb();

  // ── GET : liste toutes les plantes ──────────────────
  if (req.method === 'GET') {
    const snap = await db.collection('plants').orderBy('name').get();
    const plants = [];
    snap.forEach(doc => plants.push({ id: doc.id, ...doc.data() }));
    return res.json({ plants });
  }

  // ── POST : ajouter / mettre à jour une plante ───────
  if (req.method === 'POST') {
    const { plant, id } = req.body || {};
    if (!plant || !plant.name?.trim()) {
      return res.status(400).json({ error: 'Le champ "name" est requis' });
    }

    const data = {
      name:              String(plant.name || '').trim(),
      latin_name:        String(plant.latin_name || '').trim() || null,
      categories:        plant.categories
        ? String(plant.categories).split('|').map(s => s.trim()).filter(Boolean)
        : [],
      properties:        String(plant.properties || '').trim() || null,
      usage:             String(plant.usage || '').trim() || null,
      dosage:            String(plant.dosage || '').trim() || null,
      contraindications: String(plant.contraindications || '').trim() || null,
      sources:           String(plant.sources || '').trim() || null,
      full_text:         String(plant.full_text || '').trim() || null,
      updated_at:        new Date().toISOString(),
    };

    if (id) {
      // mise à jour
      await db.collection('plants').doc(id).set(data, { merge: true });
      if (globalThis.__firestorePlantsCache) globalThis.__firestorePlantsCache = null;
      return res.json({ ok: true, id, action: 'updated' });
    } else {
      // création
      data.created_at = new Date().toISOString();
      data.source_import = 'admin_form';
      const ref = await db.collection('plants').add(data);
      if (globalThis.__firestorePlantsCache) globalThis.__firestorePlantsCache = null;
      return res.json({ ok: true, id: ref.id, action: 'created' });
    }
  }

  // ── DELETE : supprimer une plante ───────────────────
  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID manquant' });
    await db.collection('plants').doc(id).delete();
    if (globalThis.__firestorePlantsCache) globalThis.__firestorePlantsCache = null;
    return res.json({ ok: true });
  }

  res.status(405).end();
}
