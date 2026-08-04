// Daily stock safety-backup.
//
// Once a day — triggered by whoever opens the app first that day — this
// writes a full JSON snapshot of the "items" collection into Firebase
// Storage (completely separate from the live database), and optionally
// emails a short summary to subabake@gmail.com via EmailJS.
//
// Why Storage and not another Firestore collection: a bug in the app (like
// the field-wiping import bug found and fixed earlier) can only ever touch
// Firestore documents through the app's own code. A file sitting in Storage
// is untouched by any of that — it's a true "outside the blast radius" copy.
// If the live data is ever damaged, the most recent backups/stock-backup-
// YYYY-MM-DD.json file can be used to see exactly what every item looked
// like on that date and manually restore what's needed.
//
// EmailJS is a client-side email service — no backend server or SMTP
// password required. The three IDs below are meant to be public (EmailJS
// scopes/rate-limits by them, similar to how a Firebase apiKey is public),
// so it's safe to commit them here once the free EmailJS account is set up.
// Leave them blank and the Storage backup still runs every day — only the
// email step is skipped.
import { collection, getDocs, doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { ref, uploadString } from 'firebase/storage';
import { db, storage } from './firebase';

const LOCAL_KEY = 'subaLastBackupDate';

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
    console.error('Backup summary email failed (the backup file itself was still saved):', err);
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

    const backupPayload = JSON.stringify({
      generatedAt: new Date().toISOString(),
      itemCount: items.length,
      items,
    });
    const fileRef = ref(storage, `backups/stock-backup-${today}.json`);
    await uploadString(fileRef, backupPayload, 'raw', { contentType: 'application/json' });

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
