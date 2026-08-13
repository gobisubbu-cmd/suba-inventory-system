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
//
// RESUMABLE ACROSS SESSIONS (added 13 Aug 2026, live-verified need): backing
// up 18 collections with generous timeouts/retries can genuinely take longer
// than most people leave a browser tab open doing nothing. So this no longer
// requires one unbroken session to finish. systemMeta/backupStatus tracks
// completedCollections: { [collectionName]: true } and is updated the moment
// EACH collection finishes — not just at the very end. Every time this runs,
// it skips whatever's already marked done for today and only works on what's
// left. Progress accumulates across however many times the app gets opened,
// instead of restarting from zero and racing the clock every time. The
// localStorage "don't bother checking today" shortcut is only set once every
// single collection is confirmed done for today. If one collection keeps
// failing after all its retries, it's logged and skipped for THIS run so the
// rest of the list still gets a chance — next run tries the failed one again.
import { collection, doc, getDoc, getDocs, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { db } from './firebase';

const LOCAL_KEY = 'subaLastBackupDate';
const ITEMS_PER_CHUNK = 300; // keeps each backup doc well under Firestore's 1MB-per-doc limit
const CHUNK_DOCS_PER_BATCH = 20; // well under writeBatch's 400-operation limit

// Live-verified (13 Aug 2026): a 15s timeout was too impatient — the first
// batch of 20 chunk-writes genuinely completed, just slower than 15s, and a
// later batch then failed the same way. The write path itself works; it just
// sometimes needs more time. So: longer timeouts, plus automatic retries
// (each chunk doc has a fixed, deterministic path, so re-running batch.set on
// the same ids is safe to retry — it just overwrites with identical data).
const READ_TIMEOUT_MS = 30000;
const WRITE_TIMEOUT_MS = 45000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2000;

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

// Races any promise-returning function against a timeout, labelled for
// error messages / debug status.
function withTimeout(promiseFactory, timeoutMs, label) {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs)
  );
  return Promise.race([promiseFactory(), timeoutPromise]);
}

// Retries a timeout-wrapped step up to MAX_ATTEMPTS times with a short fixed
// backoff between attempts. Safe to retry here specifically because every
// write below targets a fixed, deterministic document path (chunk index) —
// re-running it just overwrites with identical data, never duplicates.
async function withRetries(fn, label, debugRef) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (debugRef) debugRef.status = `${label}-attempt-${attempt}-failed: ${err.message}`;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
      }
    }
  }
  throw lastErr;
}

// Reads one live collection in full and writes it into its own chunked
// sub-path under dailyBackups/{date}, using the exact same chunk-size /
// batch-size / commit-timeout safety pattern for every collection. Read-only
// against the live collection — the only writes here are under dailyBackups.
// Both the read and every write batch are timeout-protected AND retried
// (see withTimeout/withRetries above) — live testing on 13 Aug 2026 showed
// the underlying reads/writes genuinely work, they just occasionally need
// more than a few seconds, so failing fast once isn't enough; this gives
// each step several chances with real breathing room before giving up.
async function backupOneCollection(today, collectionName, debugRef) {
  const snap = await withRetries(
    () => withTimeout(() => getDocs(collection(db, collectionName)), READ_TIMEOUT_MS, `read (${collectionName})`),
    `read-${collectionName}`,
    debugRef
  );
  const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const chunks = [];
  for (let i = 0; i < docs.length; i += ITEMS_PER_CHUNK) {
    chunks.push(docs.slice(i, i + ITEMS_PER_CHUNK));
  }

  const subcollection = chunkSubcollectionFor(collectionName);
  for (let i = 0; i < chunks.length; i += CHUNK_DOCS_PER_BATCH) {
    if (debugRef) debugRef.status = `writing-${collectionName}-batch-starting-at-${i}`;
    const batchChunks = chunks.slice(i, i + CHUNK_DOCS_PER_BATCH);
    await withRetries(
      () =>
        withTimeout(
          () => {
            const batch = writeBatch(db);
            batchChunks.forEach((chunkDocs, offset) => {
              const chunkRef = doc(db, 'dailyBackups', today, subcollection, String(i + offset));
              batch.set(chunkRef, { items: chunkDocs });
            });
            return batch.commit();
          },
          WRITE_TIMEOUT_MS,
          `commit (${collectionName}, batch starting ${i})`
        ),
      `write-${collectionName}-batch-${i}`,
      debugRef
    );
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
    window.__backupDebug.status = 'skipped-localstorage-fully-done';
    return;
  }

  const statusRef = doc(db, 'systemMeta', 'backupStatus');

  try {
    window.__backupDebug.status = 'checking-status-doc';
    const statusSnap = await withTimeout(() => getDoc(statusRef), READ_TIMEOUT_MS, 'read backupStatus');
    const statusData = statusSnap.exists() ? statusSnap.data() : {};

    // What's already done TODAY specifically — a completedCollections map
    // from a previous, different day is irrelevant and must not carry over.
    const alreadyDoneToday =
      statusData.lastBackupDate === today && statusData.completedCollections
        ? statusData.completedCollections
        : {};

    if (COLLECTIONS_TO_BACKUP.every((name) => alreadyDoneToday[name])) {
      window.localStorage.setItem(LOCAL_KEY, today);
      window.__backupDebug.status = 'skipped-already-fully-done-today';
      return;
    }

    const remaining = COLLECTIONS_TO_BACKUP.filter((name) => !alreadyDoneToday[name]);
    window.__backupDebug.status = `resuming-${remaining.length}-of-${COLLECTIONS_TO_BACKUP.length}-collections-left`;

    // Carry forward stats from collections already backed up in an earlier
    // session today (needed for the items-derived stock-value/brand stats
    // and for the final summary doc to stay accurate even when 'items' was
    // done in a previous session, not this one).
    const collectionCounts = { ...(statusData.collections || {}) };
    let itemCount = statusData.itemCount || 0;
    let totalStockValue = statusData.totalStockValue || 0;
    let brandCounts = statusData.brandCounts || {};

    for (const collectionName of remaining) {
      window.__backupDebug.status = `fetching-${collectionName}`;
      try {
        const { docs, count, chunkCount } = await backupOneCollection(today, collectionName, window.__backupDebug);
        collectionCounts[collectionName] = { count, chunkCount };

        if (collectionName === 'items') {
          itemCount = count;
          totalStockValue = 0;
          brandCounts = {};
          docs.forEach((it) => {
            const stock = Number(it.currentStock) || 0;
            const cost = Number(it.avgCost || it.purchaseCost) || 0;
            totalStockValue += stock * cost;
            const brand = it.brand || 'Unassigned';
            brandCounts[brand] = (brandCounts[brand] || 0) + 1;
          });
        }

        // Persist progress the moment THIS collection finishes, not just at
        // the very end — so if the tab closes before the loop is done, this
        // collection is never re-fetched/re-written next time; only what's
        // still missing gets attempted.
        window.__backupDebug.status = `saving-progress-after-${collectionName}`;
        await withTimeout(
          () =>
            setDoc(
              statusRef,
              {
                lastBackupDate: today,
                itemCount,
                totalStockValue,
                brandCounts,
                collections: collectionCounts,
                [`completedCollections.${collectionName}`]: true,
                updatedAt: serverTimestamp(),
              },
              { merge: true }
            ),
          WRITE_TIMEOUT_MS,
          `save progress (${collectionName})`
        );
      } catch (err) {
        // This collection failed even after all its internal retries. Log it
        // and move on to the next collection instead of aborting the whole
        // run — partial progress across 17 collections is far better than
        // none, and the next session will retry just this one.
        window.__backupDebug.status = `failed-${collectionName}: ${err.message}`;
        console.error(`Daily backup: ${collectionName} failed after all retries, will retry next session:`, err);
      }
    }

    // Re-check completion status fresh (covers collections finished in
    // earlier sessions today plus whatever just succeeded above).
    const nowDoneSnap = await withTimeout(() => getDoc(statusRef), READ_TIMEOUT_MS, 'read backupStatus (final check)');
    const nowDone = nowDoneSnap.exists() ? nowDoneSnap.data().completedCollections || {} : {};
    const fullyComplete = COLLECTIONS_TO_BACKUP.every((name) => nowDone[name]);

    if (!fullyComplete) {
      window.__backupDebug.status = 'partial-progress-saved-will-resume-next-session';
      return;
    }

    window.__backupDebug.status = 'writing-summary';
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

    await setDoc(statusRef, { status: 'complete', updatedAt: serverTimestamp() }, { merge: true });

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
