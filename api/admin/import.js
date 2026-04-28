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

function sanitizeRow(row) {
  return {
    name:             String(row.name || '').trim(),
    latin_name:       String(row.latin_name || '').trim() || null,
    categories:       row.categories ? row.categories.split('|').map(s => s.trim()).filter(Boolean) : [],
    properties:       String(row.properties || '').trim() || null,
    usage:            String(row.usage || '').trim() || null,
    dosage:           String(row.dosage || '').trim() || null,
    contraindications: String(row.contraindications || '').trim() || null,
    sources:          String(row.sources || '').trim() || null,
    full_text:        String(row.full_text || '').trim() || null,
    created_at:       new Date().toISOString(),
    source_import:    'csv_admin',
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const token = req.headers['x-admin-token'];
  if (!verifyToken(token, process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const { rows } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Aucune ligne reçue' });
  }

  const db = getDb();
  const results = [];
  let imported = 0, errors = 0;

  // Traitement par batch de 490 (limite Firestore : 500)
  const BATCH = 490;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const batch = db.batch();
    const chunkMeta = [];

    for (const row of chunk) {
      if (!row.name || !row.name.trim()) continue;
      try {
        const data = sanitizeRow(row);
        const ref = db.collection('plants').doc();
        batch.set(ref, data);
        chunkMeta.push({ name: data.name, id: ref.id, ok: true });
      } catch (err) {
        chunkMeta.push({ name: row.name, ok: false, error: err.message });
        errors++;
      }
    }

    try {
      await batch.commit();
      chunkMeta.forEach(m => { if (m.ok) imported++; results.push(m); });
    } catch (err) {
      chunkMeta.forEach(m => results.push({ ...m, ok: false, error: err.message }));
      errors += chunkMeta.length;
    }
  }

  // Invalider le cache plantes du site
  if (globalThis.__firestorePlantsCache) globalThis.__firestorePlantsCache = null;

  res.json({ imported, errors, results });
}
