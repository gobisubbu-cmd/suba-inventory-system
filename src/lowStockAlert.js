import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import { SCAN_BACKEND_URL } from './scanConfig';

const DEFAULT_ALERT_EMAIL = 'subabake@gmail.com';
const APP_URL = 'https://suba-inventory-system.onrender.com';

async function getAlertEmail() {
  try {
    const snap = await getDoc(doc(db, 'settings', 'general'));
    if (snap.exists() && snap.data().lowStockAlertEmail) {
      return snap.data().lowStockAlertEmail;
    }
  } catch (e) {
    // fall through to default
  }
  return DEFAULT_ALERT_EMAIL;
}

// Call this after any transaction that changes an item's currentStock.
// Sends one email the moment stock crosses at/below reorder level, and
// silently resets so a fresh email fires next time it dips again (rather
// than emailing on every single movement while stock stays low).
export async function checkAndSendLowStockAlert(itemId) {
  if (!itemId) return;
  try {
    const itemRef = doc(db, 'items', itemId);
    const snap = await getDoc(itemRef);
    if (!snap.exists()) return;
    const item = snap.data();
    const stock = Number(item.currentStock || 0);
    const reorder = Number(item.reorderLevel || 0);
    const alreadyAlerted = Boolean(item.lowStockAlerted);

    if (stock <= reorder) {
      if (!alreadyAlerted) {
        const to = await getAlertEmail();
        const subject = `Low stock alert: ${item.particulars}`;
        const text =
          `${item.particulars} has dropped to ${stock} ${item.unit || ''} ` +
          `(reorder level: ${reorder}).\n\nOpen SUBA Stock Management to review: ${APP_URL}`;
        try {
          await fetch(`${SCAN_BACKEND_URL}/api/send-email`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ to, subject, text }),
          });
        } catch (e) {
          console.error('Low stock email failed to send:', e);
        }
        await updateDoc(itemRef, { lowStockAlerted: true });
      }
    } else if (alreadyAlerted) {
      await updateDoc(itemRef, { lowStockAlerted: false });
    }
  } catch (e) {
    console.error('Low stock alert check failed:', e);
  }
}
