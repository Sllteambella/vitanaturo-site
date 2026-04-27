import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PLANTS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let db;

export function getDb() {
  if (db) return db;
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  db = getFirestore();
  return db;
}

export async function getCachedPlants() {
  const cache = globalThis.__firestorePlantsCache;
  if (cache && Date.now() < cache.expiresAt) return cache.plants;

  const snapshot = await getDb().collection('plants').get();
  const plants = [];
  snapshot.forEach((doc) => plants.push({ id: doc.id, ...doc.data() }));

  globalThis.__firestorePlantsCache = { plants, expiresAt: Date.now() + PLANTS_CACHE_TTL_MS };
  return plants;
}

export async function saveConsultation(data) {
  await getDb().collection('consultations').add({
    ...data,
    created_at: new Date().toISOString(),
  });
}
