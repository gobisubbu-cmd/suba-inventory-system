// Daily full-data safety-backup.
//
// Once a day — triggered by whoever opens the app first that day — this
// writes a full snapshot of every real business-data collection in this app
// (items, transactions, customers, users, putawayLines, locations,
// locationAuditLog, spareSearchAudit, searchLogs, settings, auditAccessLog,
// brands, engineerIssues, engineerReturns, sparePartsUsed, unmatchedImports,
// importHistory, deletedTransactionsLog — see COLLECTIONS_TO_BACKUP below)
// into its own Firestore collection ("dailyBackups"), completely separate
// from all the live collections, and optionally emails a short summary to
// subabake@gmail.com via EmailJS.
//
// This function only ever READS the live collections above. The only writes
// it makes anywhere are to dailyBackups/{date}/... and systemMeta/backupStatus
// — it never writes back to items, transactions, or any other live collection.
//
// Why a separate collection: a bug in the app (like the field-wiping import
// bug found and fixed earlier) can only ever touch documents through the
// app's own import/update code paths. Nothing in the app ever writes to
// "dailyBackups" except this one function, so it's a true "outside the
// blast radius" copy. If the live data is ever damaged, the most recent
// dailyBackups/YYYY-MM-DD snapshot can be read to see exactly what every
// document in every collection looked like on that date and manually
// restore what's needed.
//
// Why Firestore and not Firebase Storage: Storage now requires upgrading
// this project to the paid "Blaze" plan (a billing account), even to stay
// within the free usage limits. This project is on the free "Spark" plan,
// and the whole point of this backup is not to add cost or need anyone to
// hand over a credit card — so everything here uses plain Firestore, which
// is already free and already in use throughout this app. A day's backup is
// a modest number of extra writes and one read per document per collection
// (same as any full-listing screen already does), nowhere close to the free
// daily quota.
//
// Structure: each collection gets its own chunked sub-path under the same
// dailyBackups/{date} summary doc, so nothing collides:
//   - items keeps the original path, dailyBackups/{date}/chunks/{n}, for
//     backward compatibility with any existing snapshots/tooling.
//   - every other collection gets dailyBackups/{date}/chunks_{collectionName}/{n}
//     (e.g. dailyBackups/{date}/chunks_transactions/{n}).
// The dailyBackups/{date} summary doc itself keeps its original top-level
// fields (itemCount, chunkCount, totalStockValue, brandCounts) so anything
// that already reads those still works, and adds a new `collections` map
// with a {count, chunkCount} entry per collection backed up that day.
//
// Only one backup runs per day, total — not once per collection. The
// localStorage flag and the systemMeta/backupStatus.lastBackupDate doc both
// gate the whole multi-collection run as a single unit, exactly as before.
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

// Every real business-data collection this app writes to during normal use.
// Deliberately excludes "dailyBackups" (the backup's own output) and
// "systemMeta" (backup bookkeeping only) — backing those up would be
// pointless and would grow the snapshot for no reason.
const COLLECTIONS_TO_BACKUP = [
  'items',
  'transactions',
  'customers',
  'users',
  'putawayLines',
  'locations',
  'locationAuditLog',
  'spareSearchAudit',
  'searchLogs',
  'settings',
  'auditAccessLog',
  'brands',
  'engineerIssues',
  'engineerReturns',
  'sparePartsUsed',
  'unmatchedImports',
  'importHistory',
  'deletedTransactionsLog',
];

const EMAILJS_SERVICE_ID = '';
const EMAILJS_TEMPLATE_ID = '';
const EMAILJS_PUBLIC_KEY = '';
const BACKUP_NOTIFY_EMAIL = 'subabake@gmail.com';

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Sub-collection name (under dailyBackups/{date}) that a given live
// collection's chunk docs are written to. "items" keeps the original
// "chunks" name for backward compatibility; everything else is namespaced
// by collection name so nothing collides.
function chunkSubcollectionFor(collectionName) {
  return collectionName === 'items' ? 'chunks' : `chunks_${collectionName}`;
}

// Reads one live collection in full and writes it into its own chunked
// sub-path under dailyBackups/{date}, using the exact same chunk-size /
// batch-size / commit-timeout safety pattern for every collection. Read-only
// against the live collection — the only writes here are under dailyBackups.
async function backupOneCollection(today, collectionName, debugRef) {
  // The read itself is now timeout-protected too — previously only the
  // write (batch.commit()) below had a race against a timeout, so a hang
  // on the READ side (e.g. offline-persistence cache contention, a stalled
  // network request that never errors) could block this function forever
  // with no way for the outer try/catch to ever catch anything. That
  // asymmetry is the leading suspect for the "batch.commit() never
  // resolved or rejected" hang seen in earlier testing — the hang may
  // actually have started here, one step before the part that got blamed.
  const readPromise = getDocs(collection(db, collectionName));
  const readTimeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`read timed out after 20s (${collectionName})`)),
      20000
    )
  );
  const snap = await Promise.race([readPromise, readTimeoutPromise]);
  const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const chunks = [];
  for (let i = 0; i < docs.length; i += ITEMS_PER_CHUNK) {
    chunks.push(docs.slice(i, i + ITEMS_PER_CHUNK));
  }

  const subcollection = chunkSubcollectionFor(collectionName);
  for (let i = 0; i < chunks.length; i += CHUNK_DOCS_PER_BATCH) {
    if (debugRef) debugRef.status = `writing-${collectionName}-batch-starting-at-${i}`;
    const batch = writeBatch(db);
    chunks.slice(i, i + CHUNK_DOCS_PER_BATCH).forEach((chunkDocs, offset) => {
      const chunkRef = doc(db, 'dailyBackups', today, subcollection, String(i + offset));
      batch.set(chunkRef, { items: chunkDocs });
    });
    const commitPromise = batch.commit();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`commit timed out after 15s (${collectionName}, batch starting ${i})`)),
        15000
      )
    );
    await Promise.race([commitPromise, timeoutPromise]);
  }

  return { docs, count: docs.length, chunkCount: chunks.length };
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
  window.__backupDebug = { status: 'starting', today };
  if (window.localStorage.getItem(LOCAL_KEY) === today) {
    window.__backupDebug.status = 'skipped-localstorage';
    return;
  }

  try {
    window.__backupDebug.status = 'checking-status-doc';
    const statusRef = doc(db, 'systemMeta', 'backupStatus');
    const statusSnap = await getDoc(statusRef);
    if (statusSnap.exists() && statusSnap.data().lastBackupDate === today) {
      window.localStorage.setItem(LOCAL_KEY, today);
      window.__backupDebug.status = 'skipped-already-done-today';
      return;
    }

    // One backup run covers every collection in COLLECTIONS_TO_BACKUP; the
    // localStorage flag and statusRef.lastBackupDate above gate this whole
    // run as a single unit, so this still only happens once per day total —
    // never once per collection.
    const collectionCounts = {};
    let itemCount = 0;
    let totalStockValue = 0;
    let brandCounts = {};

    for (const collectionName of COLLECTIONS_TO_BACKUP) {
      window.__backupDebug.status = `fetching-${collectionName}`;
      const { docs, count, chunkCount } = await backupOneCollection(today, collectionName, window.__backupDebug);
      collectionCounts[collectionName] = { count, chunkCount };

      if (collectionName === 'items') {
        itemCount = count;
        docs.forEach((it) => {
          const stock = Number(it.currentStock) || 0;
          const cost = Number(it.avgCost || it.purchaseCost) || 0;
          totalStockValue += stock * cost;
          const brand = it.brand || 'Unassigned';
          brandCounts[brand] = (brandCounts[brand] || 0) + 1;
        });
      }
    }

    window.__backupDebug.status = 'writing-summary';
    window.__backupDebug.collectionCounts = collectionCounts;

    await setDoc(doc(db, 'dailyBackups', today), {
      date: today,
      // Top-level fields kept for backward compatibility with anything that
      // already reads dailyBackups/{date} expecting the old items-only shape.
      itemCount,
      chunkCount: collectionCounts.items ? collectionCounts.items.chunkCount : 0,
      totalStockValue,
      brandCounts,
      // Full per-collection breakdown for every collection backed up today.
      collections: collectionCounts,
      createdAt: serverTimestamp(),
    });

    await setDoc(
      statusRef,
      {
        lastBackupDate: today,
        itemCount,
        totalStockValue,
        collections: collectionCounts,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    window.localStorage.setItem(LOCAL_KEY, today);
    window.__backupDebug.status = 'success';

    await sendBackupEmail({ date: today, itemCount, totalStockValue, brandCounts });
  } catch (err) {
    // A failed backup must never block the app from loading for everyday use.
    window.__backupDebug.status = 'error';
    window.__backupDebug.errorMessage = err && err.message;
    window.__backupDebug.errorCode = err && err.code;
    window.__backupDebug.errorStack = err && err.stack;
    console.error('Daily full-data backup failed:', err);
  }
}
