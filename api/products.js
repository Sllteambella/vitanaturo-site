import { getCachedPlants } from '../lib/firestoreClient.js';

// Fallback catalog — used when no products collection exists in Firestore yet
const STATIC_PRODUCTS = [
  { id: 1, name: 'Huile de Tamanu Bio', sub: 'Pression à froid · Madagascar', price: '24.90', rating: 4.9, reviews: 128, badge: 'Exclusif', color: '#c8dfc8' },
  { id: 2, name: 'Zinc Bisglycinate', sub: 'Haute absorption · 15mg', price: '18.50', rating: 4.8, reviews: 94, badge: 'Nouveau', color: '#dce4f0' },
  { id: 3, name: 'Huile de Nigelle', sub: 'Pression à froid · Egypte', price: '19.90', rating: 4.7, reviews: 76, badge: 'Bio', color: '#f0e8d0' },
  { id: 4, name: 'Sélénium + Vitamine E', sub: 'Antioxydant · 200µg', price: '15.90', rating: 4.6, reviews: 52, badge: 'Essentiel', color: '#e0f0e0' },
  { id: 5, name: 'Huile de Chanvre', sub: 'CBD 500mg · France', price: '34.90', rating: 4.9, reviews: 203, badge: 'Premium', color: '#dff0e8' },
  { id: 6, name: 'Iode Organique', sub: 'Fucus vésiculeux · Bretagne', price: '12.90', rating: 4.5, reviews: 41, badge: 'Mer', color: '#d0e8f0' },
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { getDb } = await import('../lib/firestoreClient.js');
    const snapshot = await getDb().collection('products').get();

    if (!snapshot.empty) {
      const products = [];
      snapshot.forEach(doc => products.push({ id: doc.id, ...doc.data() }));
      return res.json({ products });
    }
  } catch (_) {
    // Firestore unavailable or collection missing — fall through to static
  }

  res.json({ products: STATIC_PRODUCTS });
}
