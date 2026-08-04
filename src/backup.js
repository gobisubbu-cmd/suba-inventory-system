// Daily stock safety-backup.
//
// Once a day — triggered by whoever opens the app first that day — this
// writes a full snapshot of the "items" collection into its own Firestore
// collection ("dailyBackups"), completely separate from the live "items"
// collection, and optionally emails a short summary to subabake@gmail.com
// via EmailJS.
//
// Why a separate collection: a bug in the app (like the field-wiping import
// bug found and fixed earlier) can only ever touch documents through the
// app's own import/update code paths. Nothing in the app ever writes to
// "dailyBackups" except this one function, so it's a true "outside the
// blast radius" copy. If the live data is ever damaged, the most recent
// dailyBackups/YYYY-MM-DD snapshot can be read to see exactly what every
// item looked like on that date and manually restore what's needed.
//
// Why Firestore and not Firebase Storage: Storage now requires upgrading
// this project to the paid "Blaze" plan (a billing account), even to stay
// within the free usage limits. This project is on the free "Spark" plan,
// and the whole point of this backup is not to add cost or need anyone to
// hand over a credit card — so everything here uses plain Firestore, which
// is already free and already in use throughout this app. A day's backup is
// ~25-30 extra writes and one read per item (same as any full-catalogue
// screen already does), nowhere close to the free daily quota.
//
// EmailJS is a client-side email service — no backend server or SMTP
// password required. The three IDs below are meant to be public (EmailJS
// scopes/rate-limits by them, similar to how a Firebase apiKey is public),
// so it's safe to commit them here once the free EmailJS account is set up.
// Leave them blank and the Firestore backup still runs every day — only the
// email step is skipped.
import { collection, doc, getDoc, getDocs, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { db } from './firebase';

const LOCAL_KEY = 'subaLastBackupDate';
const ITEMS_PER_CHUNK = 300; // keeps each backup doc well under Firestore's 1MB-per-doc limit
const CHUNK_DOCS_PER_BATCH = 20; // well under writeBatch's 400-operation limit

const EMAILJS_SERVICE_ID = '';
const EMAILJS_TEMPLATE_ID = '';
const EMAILJS_PUBLIC_KEY = '';
const BACKUP_NOTIFY_EMAIL = 'subabake@gmail.com';

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function sendBackupEmail({ date, itemCount, totalStockValue, brandCounts }) {
  if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY) return;
  try {
    await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        template_params: {
          to_email: BACKUP_NOTIFY_EMAIL,
          backup_date: date,
          item_count: String(itemCount),
          total_stock_value: totalStockValue.toLocaleString('en-IN'),
          brand_summary: Object.entries(brandCounts)
            .map(([b, c]) => `${b}: ${c}`)
            .join(', '),
        },
      }),
    });
  } catch (err) {
    // The backup itself already succeeded by the time this runs — a failed
    // notification email is not worth surfacing to the person using the app.
    console.error('Backup summary email failed (the backup itself was still saved):', err);
  }
}

export async function runDailyBackupIfNeeded() {
  const today = todayStr();
  if (typeof window === 'undefined') return;
  if (window.localStorage.getItem(LOCAL_KEY) === today) return;

  try {
    const statusRef = doc(db, 'systemMeta', 'backupStatus');
    const statusSnap = await getDoc(statusRef);
    if (statusSnap.exists() && statusSnap.data().lastBackupDate === today) {
      window.localStorage.setItem(LOCAL_KEY, today);
      return;
    }

    const itemsSnap = await getDocs(collection(db, 'items'));
    const items = itemsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    let totalStockValue = 0;
    const brandCounts = {};
    items.forEach((it) => {
      const stock = Number(it.currentStock) || 0;
      const cost = Number(it.avgCost || it.purchaseCost) || 0;
      totalStockValue += stock * cost;
      const brand = it.brand || 'Unassigned';
      brandCounts[brand] = (brandCounts[brand] || 0) + 1;
    });

    // Split the full catalogue into ~300-item chunk docs under
    // dailyBackups/{date}/chunks/{n}, written in batches of 20 chunk-docs
    // at a time (20 writes per batch, comfortably under the 400 limit).
    const chunks = [];
    for (let i = 0; i < items.length; i += ITEMS_PER_CHUNK) {
      chunks.push(items.slice(i, i + ITEMS_PER_CHUNK));
    }
    for (let i = 0; i < chunks.length; i += CHUNK_DOCS_PER_BATCH) {
      const batch = writeBatch(db);
      chunks.slice(i, i + CHUNK_DOCS_PER_BATCH).forEach((chunkItems, offset) => {
        const chunkRef = doc(db, 'dailyBackups', today, 'chunks', String(i + offset));
        batch.set(chunkRef, { items: chunkItems });
      });
      await batch.commit();
    }

    await setDoc(doc(db, 'dailyBackups', today), {
      date: today,
      itemCount: items.length,
      chunkCount: chunks.length,
      totalStockValue,
      brandCounts,
      createdAt: serverTimestamp(),
    });

    await setDoc(
      statusRef,
      {
        lastBackupDate: today,
        itemCount: items.length,
        totalStockValue,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    window.localStorage.setItem(LOCAL_KEY, today);

    await sendBackupEmail({ date: today, itemCount: items.length, totalStockValue, brandCounts });
  } catch (err) {
    // A failed backup must never block the app from loading for everyday use.
    console.error('Daily stock backup failed:', err);
  }
}
